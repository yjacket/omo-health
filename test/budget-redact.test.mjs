import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AUDIT_CONTRACT, AUDIT_JOB_KIND } from "../src/budget/audit-job.mjs";
import { createBudgetOffice } from "../src/budget/office.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { readSubscriptionUsage } from "../src/collect/subscriptions.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { E, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";

// B1 (gate review 1): budget storage and snapshots must not keep credential-shaped free text.
const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SID = "main-0001";
const SECRET = "sk-ant-SYNTHETICgate123456";
const MASKED = "sk-ant-[REDACTED]";

const secs = (ms) => Math.trunc(ms / 1000);

function setup(t) {
	const root = tmpDir("omoh-redact-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	const cwd = path.join(root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const dir = path.join(paths.sessionsDir, "--proj--");
	const file = path.join(dir, `2026-11-10T00-00-00-000Z_${SID}.jsonl`);
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const clock = createFakeClock(T0);
	return {
		root,
		paths,
		cwd,
		dir,
		file,
		db,
		clock,
		store: createBudgetStore(db),
		writeGoal(goal) {
			const goalDir = path.join(dir, "extensions", "goal");
			fs.mkdirSync(goalDir, { recursive: true });
			fs.writeFileSync(path.join(goalDir, `${SID}.json`), JSON.stringify({ version: 1, goal: { status: "active", ...goal } }));
		},
		office: () => createBudgetOffice({ paths, db, clock, config: structuredClone(DEFAULT_CONFIG), runner: createFakeRunner(), loggedInProviders: () => new Set() }),
	};
}

test("objective, estimate assumptions and audit advice are redacted in the SQLite rows and the snapshot", (t) => {
	const c = setup(t);
	const pid = `${SID}:g1`;
	c.writeGoal({ id: "g1", objective: `deliver the export ${SECRET}`, createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [
		E.header(SID, c.cwd, T0 - HOUR),
		E.assistant({ ms: T0 - 30 * MIN, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }, text: "working" }),
	]);
	const office = c.office();
	office.tick({ shadow: false });
	const registered = c.store.getProject(pid);
	assert.equal(registered.objective.includes(SECRET), false, "the goal objective is redacted at registration");

	// Office-owned state carrying model/user text: an estimate basis and a finished audit opinion.
	c.store.upsertProject({
		...registered,
		data: {
			...registered.data,
			estimates: [{
				requestId: "est-1",
				ms: T0,
				kind: "estimate",
				raw: {
					remainingUsd: { p10: 1, p50: 2, p90: 3 },
					workClass: "implementation",
					basis: { workUnits: [{ description: `assumption ${SECRET}`, count: 2 }], assumptions: [`we assume ${SECRET}`] },
					nextCheckpoint: `checkpoint ${SECRET}`,
				},
				adjusted: { reserveUsd: 10, p50Usd: 5, ratio: 1, basis: "cold start" },
			}],
			audits: [{
				auditId: "a1",
				ms: T0,
				status: "done",
				model: "chatgpt-subscription/gpt-6-astra",
				opinion: {
					assessment: "waste-likely",
					confidence: 0.8,
					criteriaStatus: "unknown",
					advice: `stop rerunning the suite ${SECRET}`,
					findings: [{ pattern: "other", evidence: `log line ${SECRET}`, explanation: "repeats the same QA" }],
					allocationOpinion: { assessment: "revise", reason: "cheaper path" },
				},
			}],
		},
		updatedMs: T0 + MIN,
	});
	c.store.appendEvent({ ms: T0, projectId: pid, kind: "note", data: { detail: `event ${SECRET}`, tokens: 7 } });
	c.clock.advance(MIN);
	const out = office.tick({ shadow: false });
	assert.ok(out.snapshot, "the office wrote a snapshot");

	const rows = JSON.stringify(c.db.prepare("SELECT objective, data FROM budget_projects").all());
	assert.equal(rows.includes(SECRET), false, "no raw secret in the project rows");
	assert.ok(rows.includes(MASKED), "the redacted form is stored instead");
	const events = JSON.stringify(c.db.prepare("SELECT data FROM budget_events").all());
	assert.equal(events.includes(SECRET), false, "no raw secret in the event rows");
	assert.ok(events.includes(MASKED));

	const snapshotText = fs.readFileSync(c.paths.health.budgetSnapshotFile, "utf8");
	assert.equal(snapshotText.includes(SECRET), false, "no raw secret in budget/snapshot.json");
	assert.ok(snapshotText.includes(MASKED));
	const snapshot = JSON.parse(snapshotText);
	const row = snapshot.projects.find((p) => p.id === pid);
	assert.match(row.objective, /\[REDACTED\]/);
	assert.equal(row.lastAudit.opinion.advice.includes(SECRET), false);
	assert.equal(row.lastAudit.opinion.findings[0].evidence.includes(SECRET), false);
	assert.equal(snapshot.audits[0].advice.includes(SECRET), false);
	assert.equal(JSON.stringify(snapshot.events).includes(SECRET), false);
});

test("a subscription account error is redacted before it is displayed", (t) => {
	const dir = tmpDir("omoh-redact-subs-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "subscription-usage.json");
	fs.writeFileSync(file, JSON.stringify({
		accounts: {
			"chatgpt-subscription/default": { updatedAt: T0, nextAt: T0 + MIN, error: `auth failed for ${SECRET}`, windows: [] },
		},
	}));
	const [account] = readSubscriptionUsage(file, { now: T0, staleMs: 10 * MIN }).accounts;
	assert.equal(account.error.includes(SECRET), false);
	assert.equal(account.error, "auth failed for sk-ant-[REDACTED]");
	assert.equal(account.failed, true);
});

test("an audit opinion polled in memory is redacted in the snapshot, in every field", (t) => {
	const c = setup(t);
	const pid = `${SID}:g1`;
	c.writeGoal({ id: "g1", objective: "deliver the export", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [
		E.header(SID, c.cwd, T0 - HOUR),
		E.assistant({ ms: T0 - 30 * MIN, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }, text: "working" }),
	]);
	const opinion = {
		v: 1, auditId: "a2", projectId: pid, assessment: "justified", confidence: 0.7, criteriaStatus: "unknown", findings: [],
		advice: "Keep the current approach; the spending buys new acceptance evidence.",
		allocationOpinion: { assessment: "not-applicable", reason: `no request pending ${SECRET}` },
	};
	const stdout = [
		JSON.stringify({ type: "session", version: 3, id: "audit" }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(opinion) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } }),
	].join("\n");
	const runner = createFakeRunner({ outcomes: { a2: { status: "done", stdout } } });
	runner.start({ jobId: "a2", kind: AUDIT_JOB_KIND, ...AUDIT_CONTRACT });
	const office = createBudgetOffice({ paths: c.paths, db: c.db, clock: c.clock, config: structuredClone(DEFAULT_CONFIG), runner, loggedInProviders: () => new Set() });
	office.tick({ shadow: false });
	const registered = c.store.getProject(pid);
	c.store.upsertProject({ ...registered, data: { ...registered.data, audits: [{ auditId: "a2", ms: T0, status: "running", model: "chatgpt-subscription/gpt-6-astra:high", triggers: ["rounds"] }] }, updatedMs: T0 + MIN });
	c.clock.advance(MIN);
	office.tick({ shadow: false });
	const snapshotText = fs.readFileSync(c.paths.health.budgetSnapshotFile, "utf8");
	const row = JSON.parse(snapshotText).projects.find((p) => p.id === pid);
	assert.equal(row.lastAudit?.status, "done", "the audit was polled in this tick");
	assert.equal(snapshotText.includes(SECRET), false, "no raw secret anywhere in the snapshot");
	assert.match(row.lastAudit.opinion.allocationOpinion.reason, /sk-ant-\[REDACTED\]/);
});
