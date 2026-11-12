import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBudgetStore } from "../src/budget/store.mjs";
import { closeDb, openDb, SCHEMA_VERSION } from "../src/db/db.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-11-12T00:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function sandbox() {
	const root = tmpDir("omoh-budget-store-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { root, paths };
}

function setup(t) {
	const box = sandbox();
	const db = openDb({ file: box.paths.health.dbFile });
	t.after(() => closeDb(db));
	return { ...box, db, store: createBudgetStore(db) };
}

function event(id, extra = {}) {
	return {
		id,
		ms: T,
		sessionId: "s1",
		rootSessionId: "r1",
		projectId: "p1",
		taskId: null,
		source: "main",
		provider: "anthropic-subscription",
		model: "claude-opus-5-5",
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cost: 1,
		costStatus: "reported",
		...extra,
	};
}

function project(id, extra = {}) {
	return {
		id,
		sessionId: "s1",
		goalId: `g-${id}`,
		cwd: "C:/work",
		objective: "goal",
		createdMs: T,
		status: "tracking",
		revision: 0,
		closedMs: null,
		updatedMs: T,
		data: {
			requestSentMs: null,
			correctionSentMs: null,
			estimates: [],
			approvals: [],
			originalApprovedUsd: null,
			autoIncreasesUsd: 0,
			pending: null,
			checkpoints: {},
			audits: [],
			workClass: null,
			outcome: null,
		},
		...extra,
	};
}

const tables = (db) =>
	db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => row.name);

test("a previous-version file migrates to the budget tables and keeps its own", (t) => {
	const { paths } = sandbox();
	fs.mkdirSync(path.dirname(paths.health.dbFile), { recursive: true });
	const old = new DatabaseSync(paths.health.dbFile);
	old.exec("CREATE TABLE tool_calls (id TEXT PRIMARY KEY);");
	old.exec("CREATE TABLE lineages (fp TEXT PRIMARY KEY);");
	old.exec("CREATE TABLE baseline_samples (metric TEXT NOT NULL, t INTEGER NOT NULL, value REAL NOT NULL);");
	old.exec("PRAGMA user_version = 1;");
	old.close();

	const db = openDb({ file: paths.health.dbFile });
	t.after(() => closeDb(db));
	assert.equal(SCHEMA_VERSION, 2);
	assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
	assert.deepEqual(tables(db), [
		"baseline_samples",
		"budget_events",
		"budget_projects",
		"budget_rounds",
		"ingest_offsets",
		"lineages",
		"quota_samples",
		"sqlite_sequence",
		"tool_calls",
		"usage_events",
	]);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 0, "the shipped table is untouched");
});

test("insertUsage is idempotent by id and ingest offsets round-trip", (t) => {
	const { db, store } = setup(t);
	assert.equal(store.insertUsage([event("a"), event("b")]), 2);
	assert.equal(store.insertUsage([event("a", { cost: 9 })]), 0, "the same id twice inserts one row");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 2);
	assert.equal(db.prepare("SELECT cost FROM usage_events WHERE id = 'a'").get().cost, 1, "a replayed id never rewrites the row");
	assert.equal(store.getOffset("transcript.jsonl"), null);
	store.setOffset("transcript.jsonl", "1:2", 4096, T);
	assert.deepEqual(store.getOffset("transcript.jsonl"), { identity: "1:2", offset: 4096 });
	store.setOffset("transcript.jsonl", "1:3", 8192, T + 1);
	assert.deepEqual(store.getOffset("transcript.jsonl"), { identity: "1:3", offset: 8192 });
});

test("spend aggregates by project, root, source and window filter", (t) => {
	const { store } = setup(t);
	store.insertUsage([
		event("main1", { projectId: "p1", source: "main", cost: 1 }),
		event("child1", { projectId: "p1", source: "child", cost: 2 }),
		event("audit1", { projectId: "p1", source: "audit", cost: 3 }),
		event("other", { projectId: "p2", source: "main", cost: 4 }),
		event("root2", { projectId: "p1", source: "main", cost: 5, rootSessionId: "r2", ms: T + HOUR }),
		event("fable", { projectId: "p1", model: "claude-fable-5", cost: 7 }),
		event("copilot", { projectId: "p2", provider: "github-copilot", model: "claude-fable-5", cost: 100 }),
	]);
	const all = store.spend({ projectId: "p1" });
	assert.equal(all.costUsd, 18);
	assert.equal(all.mainUsd, 13);
	assert.equal(all.childUsd, 2);
	assert.equal(all.auditUsd, 3);
	assert.equal(all.events, 5);
	assert.equal(all.missing, 0);
	assert.deepEqual(all.byModel, { "claude-opus-5-5": 11, "claude-fable-5": 7 });

	assert.equal(store.spend({ projectId: "p1", sources: ["child"] }).costUsd, 2);
	assert.equal(store.spend({ projectId: "p1", rootSessionId: "r2" }).costUsd, 5);
	assert.equal(store.spend({ projectId: "p1", sinceMs: T + 1 }).costUsd, 5);
	assert.equal(store.spend({ projectId: "p1", untilMs: T + 1 }).costUsd, 13);
	assert.equal(store.spend({ projectId: "p2" }).costUsd, 104, "another project's rows stay out");
	assert.equal(store.spend({ rootSessionId: "r1" }).costUsd, 117, "the root filter spans projects");

	const fableWindow = store.spend({
		projectId: "p1",
		accounts: { aliases: ["claude-sdk-oauth=anthropic-subscription"], account: "anthropic-subscription/default", window: { id: "claude:7d_fable" } },
	});
	assert.equal(fableWindow.costUsd, 7, "the scoped window only covers models naming the scope; the aliased copilot row is not this account");
	assert.equal(fableWindow.events, 1);
	const aliasWindow = store.spend({
		accounts: { aliases: ["claude-sdk-oauth=anthropic-subscription"], account: "anthropic-subscription/default", window: { id: "claude:7d" } },
	});
	assert.equal(aliasWindow.costUsd, 22, "an unscoped window covers every model of the account, across projects (copilot stays out)");
});

test("a missing cost is counted in missing, never in USD", (t) => {
	const { db, store } = setup(t);
	store.insertUsage([event("reported", { cost: 2 })]);
	const before = store.spend({ projectId: "p1" });
	assert.equal(before.costUsd, 2);
	assert.equal(before.missing, 0);

	assert.equal(store.insertUsage([event("no-cost", { cost: null, costStatus: "missing" })]), 1);
	const after = store.spend({ projectId: "p1" });
	assert.equal(after.costUsd, before.costUsd, "costUsd is unchanged by a missing cost");
	assert.equal(after.missing, before.missing + 1);
	assert.equal(after.events, before.events + 1);
	assert.deepEqual({ ...db.prepare("SELECT cost, cost_status FROM usage_events WHERE id = 'no-cost'").get() }, { cost: null, cost_status: "missing" });
	assert.deepEqual(after.byModel, { "claude-opus-5-5": 2 });
});

test("quota samples are idempotent by account, window and reading time, and read ascending", (t) => {
	const { store } = setup(t);
	const sample = (updatedMs, usedPercent) => ({ account: "anthropic-subscription/default", windowId: "claude:7d", updatedMs, usedPercent, resetsAtMs: T + 6 * DAY, windowMinutes: 10080 });
	assert.equal(store.insertQuotaSamples([sample(T, 40), sample(T + HOUR, 45)]), 2);
	assert.equal(store.insertQuotaSamples([sample(T, 40)]), 0);
	assert.deepEqual(store.quotaSamples({ account: "anthropic-subscription/default", windowId: "claude:7d", sinceMs: T }), [
		{ updatedMs: T, usedPercent: 40, resetsAtMs: T + 6 * DAY, windowMinutes: 10080 },
		{ updatedMs: T + HOUR, usedPercent: 45, resetsAtMs: T + 6 * DAY, windowMinutes: 10080 },
	]);
	assert.deepEqual(store.quotaSamples({ account: "anthropic-subscription/default", windowId: "claude:7d", sinceMs: T + 1 }), [
		{ updatedMs: T + HOUR, usedPercent: 45, resetsAtMs: T + 6 * DAY, windowMinutes: 10080 },
	]);
	assert.deepEqual(store.quotaSamples({ account: "none", windowId: "claude:7d", sinceMs: 0 }), []);
});

test("projects round-trip through the JSON data column and list by status and update time", (t) => {
	const { db, store } = setup(t);
	const first = project("p1");
	store.upsertProject(first);
	assert.deepEqual(store.getProject("p1"), first);
	first.status = "approved";
	first.revision = 1;
	first.data.approvals.push({ revision: 1, ms: T, approvedUsd: 30, by: "rule", basis: "cold start" });
	store.upsertProject(first);
	assert.deepEqual(store.getProject("p1"), first, "an upsert replaces every column and the JSON blob");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_projects").get().n, 1);

	const closed = project("p2", { status: "closed", closedMs: T + HOUR, updatedMs: T + HOUR });
	store.upsertProject(closed);
	assert.deepEqual(store.listProjects().map((row) => row.id), ["p1", "p2"]);
	assert.deepEqual(store.listProjects({ statuses: ["closed"] }).map((row) => row.id), ["p2"]);
	assert.deepEqual(store.listProjects({ sinceMs: T + 1 }).map((row) => row.id), ["p2"]);
	assert.equal(store.getProject("missing"), null);
});

test("rounds keep the first ms they were seen at and read ascending by it", (t) => {
	const { store } = setup(t);
	store.recordRound("p1", 3, T);
	store.recordRound("p1", 3, T + 5 * HOUR);
	store.recordRound("p1", 1, T - HOUR);
	assert.deepEqual(store.rounds("p1"), [
		{ round: 1, firstMs: T - HOUR },
		{ round: 3, firstMs: T },
	]);
	assert.deepEqual(store.rounds("other"), []);
});

test("budget events read newest first with parsed data", (t) => {
	const { store } = setup(t);
	assert.equal(store.appendEvent({ ms: T, projectId: "p1", account: null, kind: "request", data: { revision: 0 } }), 1);
	store.appendEvent({ ms: T + HOUR, projectId: "p1", account: "anthropic-subscription/default", kind: "decision", data: { approvedUsd: 30 } });
	store.appendEvent({ ms: T + 2 * HOUR, projectId: "p2", kind: "denied", data: {} });
	assert.deepEqual(store.events({ projectId: "p1" }).map((row) => row.kind), ["decision", "request"]);
	assert.deepEqual(store.events({ projectId: "p1", limit: 1 })[0], {
		seq: 2,
		ms: T + HOUR,
		projectId: "p1",
		account: "anthropic-subscription/default",
		kind: "decision",
		data: { approvedUsd: 30 },
	});
	assert.deepEqual(store.events({ sinceMs: T + 2 * HOUR }).map((row) => row.kind), ["denied"]);
});

test("prune expires usage rows and quota readings but keeps projects", (t) => {
	const { db, store } = setup(t);
	store.insertUsage([event("old", { ms: T - 100 * DAY }), event("new", { ms: T - DAY })]);
	store.insertQuotaSamples([
		{ account: "a", windowId: "w", updatedMs: T - 100 * DAY, usedPercent: 1, resetsAtMs: null, windowMinutes: null },
		{ account: "a", windowId: "w", updatedMs: T - DAY, usedPercent: 2, resetsAtMs: null, windowMinutes: null },
	]);
	store.upsertProject(project("p1", { updatedMs: T - 100 * DAY }));
	assert.deepEqual(store.prune(T, 90), { usageEvents: 1, quotaSamples: 1 });
	assert.deepEqual(db.prepare("SELECT id FROM usage_events").all().map((row) => row.id), ["new"]);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quota_samples").get().n, 1);
	assert.equal(store.getProject("p1").id, "p1", "retention keeps projects");
});
