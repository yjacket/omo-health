import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionRecord, loadSessionRecord, scanOmoHealthMessages } from "../src/session-record.mjs";
import { tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const T0 = Date.parse("2026-10-10T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

function setup() {
	const root = tmpDir("omoh-record-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { root, paths };
}

function writeLedger(paths, rows) {
	fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
	const byDay = new Map();
	for (const row of rows) {
		const day = iso(row.endedMs).slice(0, 10);
		byDay.set(day, [...(byDay.get(day) ?? []), { v: 1, outcome: "answered", reason: "done", source: "live", ...row }]);
	}
	for (const [day, list] of byDay) fs.appendFileSync(path.join(paths.health.sessionsDir, `ended-${day}.jsonl`), `${list.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function writeDecisions(paths, entries) {
	fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
	const byDay = new Map();
	for (const entry of entries) {
		const ts = entry.ts ?? iso(T0);
		const day = ts.slice(0, 10);
		byDay.set(day, [...(byDay.get(day) ?? []), { ...entry, ts }]);
	}
	for (const [day, list] of byDay) fs.appendFileSync(path.join(paths.health.decisionsDir, `${day}.jsonl`), `${list.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function writeInvestigation(paths, record) {
	fs.mkdirSync(paths.health.investigationsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.investigationsDir, `${record.id}.json`), JSON.stringify({ openedMs: T0, updatedMs: T0, status: "open", evidence: [], signals: [], ...record }));
}

function mainSessionFile(paths, id, entries = []) {
	const file = path.join(paths.sessionsDir, "slug", `2026-10-10T00-00-00-000Z_${id}.jsonl`);
	writeJsonl(file, entries.length ? entries : [{ type: "session", id }]);
	return file;
}

function childSessionFile(cwd, taskId, childId, entries = []) {
	return writeTask(cwd, { task_id: taskId, child_session_id: childId, status: "completed" }, entries.length ? entries : [{ type: "session", id: childId }]);
}

let messageSeq = 0;
const ohealth = (ms, text) => ({ type: "custom_message", customType: "omo-health", id: `oh-${++messageSeq}`, timestamp: iso(ms), content: text, details: { kind: "self-notice" } });
const mainRow = (extra = {}) => ({ sessionId: "s-main", kind: "main", parentSessionId: null, taskId: null, title: "main", cwd: "C:/work/a", terminal: { kind: "wt" }, omoVersion: "0.8.0", startedMs: T0, endedMs: T0 + 2 * HOUR, childCount: 2, ...extra });
const childRow = (sessionId, taskId, parentSessionId, extra = {}) => ({ sessionId, kind: "child", parentSessionId, taskId, title: sessionId, cwd: "C:/work/a", terminal: null, omoVersion: null, startedMs: T0 + 10 * MIN, endedMs: T0 + 70 * MIN, ...extra });

test("(plan 35) loadSessionRecord selects the exact ledger session ID and endedMs", () => {
	const { paths } = setup();
	const id = "st_shared";
	const a = childRow(id, id, "parent-a", { title: "older" });
	const b = childRow(id, id, "parent-b", { title: "newer", endedMs: a.endedMs + 1 });
	const c = childRow("child-c", "st_c", "parent-c");
	writeLedger(paths, [a, b, c]);
	const options = { paths, id, now: T0 + 2 * HOUR };
	const selected = (overrides) => loadSessionRecord({ ...options, ...overrides });
	assert.deepEqual([a, b].map(({ endedMs }) => {
		const { session, tokens } = selected({ endedMs });
		return [session.title, session.parentSessionId, session.endedMs, tokens, session.usageTaskIdAmbiguous];
	}), [
		[a.title, a.parentSessionId, a.endedMs, null, true],
		[b.title, b.parentSessionId, b.endedMs, null, true],
	]);
	assert.equal(selected().session.title, b.title);
	assert.deepEqual(selected({ endedMs: b.endedMs + 1 }), { found: false, id });
	assert.deepEqual(selected({ id: c.taskId, endedMs: c.endedMs }), { found: false, id: c.taskId });
});

function baseRows() {
	return [
		mainRow(),
		mainRow({ sessionId: "s-unrelated", title: "unrelated", startedMs: T0 + MIN, endedMs: T0 + 3 * HOUR }),
		childRow("s-child", "st_a", "s-main"),
		childRow("s-grand", "st_c", "s-child", { startedMs: T0 + 20 * MIN, endedMs: T0 + 80 * MIN }),
		childRow("s-u-child", "st_u", "s-unrelated"),
	];
}

/** The rich selection corpus: every acceptance join gets one decision family. */
function corpus() {
	return {
		rows: baseRows(),
		decisions: [
			{ fp: "fp-direct", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main", taskId: null }, evidence: ["direct"] },
			{ fp: "fp-direct", event: "resolved", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main", taskId: null }, afterMs: 1000 },
			{ fp: "fp-fp", action: { key: "nudge:fp-fp", kind: "nudge" }, result: "execute", outcome: { delivered: true, sessionId: "s-main", via: "fp-join" }, detector: "D8", kind: "dead-child" },
			{ fp: "fp-wake", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main" } },
			{ fp: "fp-wake", action: { key: "wake-parent:fp-wake", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-main", via: "wake" }, detector: "D1", kind: "stall" },
			{ fp: "fp-child", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-child", taskId: "st_a", parentSessionId: null } },
			{ fp: "fp-grand", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-grand", taskId: "st_c" } },
			{ fp: "fp-deliver", action: { key: "notify:fp-deliver", kind: "notify" }, result: "execute", outcome: { delivered: true, sessionId: "s-main" }, detector: "D2", kind: "machine-commit" },
			{ fp: "fp-grand-deliver", action: { key: "wake-parent:fp-grand", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-grand" }, detector: "D1", kind: "stall" },
			{ fp: "fp-unrelated", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-unrelated", taskId: null } },
			{ fp: "fp-unrelated", action: { key: "nudge:fp-unrelated", kind: "nudge" }, result: "execute", outcome: { delivered: true, sessionId: "s-unrelated" }, detector: "D8", kind: "dead-child" },
			{ fp: "fp-u-child", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-u-child", taskId: "st_u" } },
			{ fp: "fp-direct", event: "investigation", ts: iso(T0 + 30 * MIN), analyst: { verdict: "escalate", assessment: "abnormal", cause: "stuck", confidence: 0.8, diagnosis: "first" } },
			{ fp: "fp-direct", event: "investigation", ts: iso(T0 + 40 * MIN), analyst: { verdict: "wait", assessment: "normal", confidence: 0.6, diagnosis: "second" } },
			{ fp: "fp-child", event: "investigation", ts: iso(T0 + 4 * HOUR), analyst: { verdict: "act", assessment: "abnormal", confidence: 0.9, diagnosis: "after parent end" } },
			{ fp: "fp-unrelated", event: "investigation", ts: iso(T0 + 4 * HOUR), analyst: { verdict: "act", assessment: "abnormal", confidence: 0.9, diagnosis: "unrelated" } },
			{ event: "coverage", infoFindings: true, ts: iso(T0 - HOUR) },
		],
		investigations: [
			{ id: "fp-direct", subject: { sessionId: "s-main", taskId: null, toolCallId: null, parentSessionId: null }, detector: "D1", kind: "stall" },
			{ id: "fp-fp", subject: { sessionId: "s-main" }, detector: "D8", kind: "dead-child" },
			{ id: "fp-child", subject: { sessionId: "s-child", taskId: "st_a", parentSessionId: null }, detector: "D8", kind: "dead-child" },
			{ id: "fp-grand", subject: { sessionId: "s-grand", taskId: "st_c" }, detector: "D8", kind: "dead-child" },
			{ id: "fp-unrelated", subject: { sessionId: "s-unrelated", taskId: null }, detector: "D1", kind: "stall" },
			{ id: "fp-u-child", subject: { sessionId: "s-u-child", taskId: "st_u" }, detector: "D8", kind: "dead-child" },
		],
	};
}

function recordForMain(extra = {}) {
	const fixture = corpus();
	const row = fixture.rows[0];
	return buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations, messages: [], ...extra });
}

function fprs(record, list = "findings") {
	return record.health[list].map((item) => item.fp);
}

test("a direct-subject finding is listed with its investigation", () => {
	const record = recordForMain();
	assert.equal(record.found, true);
	assert.ok(fprs(record, "findings").includes("fp-direct"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-direct"));
});

test("an fp-joined action whose investigation exists is listed", () => {
	const record = recordForMain();
	assert.ok(record.health.actions.some((item) => item.facts.via === "fp-join" && item.facts.delivered === true));
});

test("a wake-parent action with no investigation joins through its finding's opened entry", () => {
	const record = recordForMain();
	assert.ok(record.health.actions.some((item) => item.facts.via === "wake" && item.facts.delivered === true));
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-wake"), false);
	assert.ok(record.health.findings.some((item) => item.fp === "fp-wake" && item.event === "opened"));
});

test("IS-7: the child record includes D8 findings and wake-parent decisions addressed to its parent", () => {
	const { paths } = setup();
	const parent = mainRow();
	const child = childRow("s-child", "st_shared", parent.sessionId);
	const otherParent = mainRow({ sessionId: "s-other-parent" });
	const otherChild = childRow("s-other-child", child.taskId, otherParent.sessionId);
	const sibling = childRow("s-sibling", "st_sibling", parent.sessionId);
	writeLedger(paths, [parent, child, otherParent, otherChild, sibling]);
	const subject = { sessionId: parent.sessionId, taskId: child.taskId, parentSessionId: parent.sessionId };
	const incident = { fp: "fp-dead", detector: "D8", kind: "dead-child", subject, ts: iso(T0 + 20 * MIN) };
	const wake = { ...incident, action: { key: "wake-parent:fp-dead", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: parent.sessionId } };
	// An action with no retained lifecycle or investigation entry must also join by subject.
	writeDecisions(paths, [
		{ ...incident, event: "opened", severity: "warn" },
		wake,
		{ ...wake, fp: "fp-action-only", action: { ...wake.action, key: "wake-parent:fp-action-only" }, result: "would-execute", outcome: undefined },
	]);
	writeInvestigation(paths, { id: "fp-investigation-only", detector: "D8", kind: "child-error-unhandled", subject });

	const joined = (row) => {
		const { health } = loadSessionRecord({ paths, id: row.sessionId, now: parent.endedMs });
		return [
			health.findings.map(({ fp, detector, kind }) => [fp, detector, kind]),
			health.actions.map(({ kind, recipient, result }) => [kind, recipient, result]),
			health.investigations.map(({ id }) => id),
		];
	};
	const expected = [
		[["fp-dead", "D8", "dead-child"]],
		[["wake-parent", parent.sessionId, "execute"], ["wake-parent", parent.sessionId, "would-execute"]],
		["fp-investigation-only"],
	];
	assert.deepEqual(joined(child), expected);
	assert.deepEqual(joined(parent), expected);
	assert.deepEqual(joined(otherChild), [[], [], []]);
	assert.deepEqual(joined(sibling), [[], [], []]);
});

test("an engine action decision is listed by its action kind, not the finding kind", () => {
	const { paths } = setup();
	writeLedger(paths, [{ sessionId: "s-kind", kind: "main", startedMs: T0, endedMs: T0 + HOUR }]);
	// The shape src/engine.mjs writes for an executed action: the finding's kind at top level, the action's under `action`.
	writeDecisions(paths, [
		{ ts: iso(T0 + MIN), fp: "fp-kind", detector: "D1", kind: "stall", cls: "pending-call", action: { key: "k", kind: "kill-pids", params: {} }, result: "execute", outcome: { killed: [{ pid: 1 }], survived: [] }, subject: { sessionId: "s-kind", taskId: null, parentSessionId: null, rootSessionId: null } },
	]);
	const record = loadSessionRecord({ paths, id: "s-kind", now: T0 + 2 * HOUR });
	assert.equal(record.health.actions.length, 1);
	assert.equal(record.health.actions[0].kind, "kill-pids");
	assert.equal(record.health.actions[0].findingKind, "stall");
});

test("a child finding with parentSessionId null is caught through the descendant set", () => {
	const record = recordForMain();
	assert.ok(fprs(record, "findings").includes("fp-child"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-child"));
});

test("a grandchild finding is listed", () => {
	const record = recordForMain();
	assert.ok(fprs(record, "findings").includes("fp-grand"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-grand"));
});

test("a delivery to the session is listed", () => {
	const record = recordForMain();
	const delivery = record.health.actions.find((item) => item.recipient === "s-main" && item.detail === "delivered true" && Object.keys(item.subject).length === 0);
	assert.ok(delivery, "the notify decision has no subject but its outcome names the session");
});

test("a message delivered only to the grandchild appears in the parent record with recipient C", () => {
	const { paths } = setup();
	const rows = baseRows().map((row) => ({ ...row, cwd: paths.repoRoot }));
	writeLedger(paths, rows);
	childSessionFile(paths.repoRoot, "st_a", "s-child", [{ type: "session", id: "s-child" }]);
	childSessionFile(paths.repoRoot, "st_c", "s-grand", [{ type: "session", id: "s-grand" }, ohealth(T0 + 50 * MIN, "only the grandchild")]);
	writeDecisions(paths, [{ action: { key: "wake-parent:g", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-grand" }, detector: "D1", kind: "stall", ts: iso(T0 + 50 * MIN) }]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.found, true);
	const message = record.health.messages.find((item) => item.text === "only the grandchild");
	assert.equal(message?.recipient, "s-grand");
	assert.ok(record.health.actions.some((item) => item.recipient === "s-grand" && item.facts.delivered === true));
});

test("an unrelated session is excluded even when it shares a cwd", () => {
	const record = recordForMain();
	assert.equal(record.health.findings.some((item) => item.fp === "fp-unrelated" || item.fp === "fp-u-child"), false);
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-unrelated" || inv.id === "fp-u-child"), false);
	assert.equal(record.health.actions.some((item) => item.recipient === "s-unrelated"), false);
});

test("an unindexed main session does not inherit another main's tokens through a null task id", () => {
	const fixture = corpus();
	const indexed = fixture.rows[0];
	const unindexed = fixture.rows[1];
	const usage = new Map([
		[
			indexed.sessionId,
			{
				id: indexed.sessionId,
				taskId: null,
				state: "ok",
				complete: true,
				published: { total: 157, input: 100, output: 20, cacheRead: 30, cacheWrite: 7, cost: 0, costUnknown: false, turns: 2, models: { "anthropic/claude-x": { tokens: 157, cost: 0 } }, usedModels: {} },
			},
		],
	]);
	const indexedRecord = buildSessionRecord({ id: indexed.sessionId, row: indexed, ledger: fixture.rows, decisions: [], investigations: [], usage });
	assert.equal(indexedRecord.tokens.total, 157);
	const unindexedRecord = buildSessionRecord({ id: unindexed.sessionId, row: unindexed, ledger: fixture.rows, decisions: [], investigations: [], usage });
	assert.equal(unindexedRecord.tokens, null, "a null task id is not an alias for another main session");
});

test("a non-finite per-model value stays non-finite instead of becoming 0", () => {
	const fixture = corpus();
	const row = fixture.rows[0];
	const models = { "a/finite": { tokens: 10, cost: 0.5 }, "b/huge": { tokens: Infinity, cost: Infinity }, "c/nan": { tokens: NaN, cost: 1 } };
	const published = { total: Infinity, input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0, cost: Infinity, costUnknown: false, turns: 2, models };
	const usage = new Map([[row.sessionId, { id: row.sessionId, taskId: null, state: "ok", complete: true, published }]]);
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: [], investigations: [], usage });
	const rows = record.tokens.models;
	assert.deepEqual(rows.map((m) => m.key), ["b/huge", "c/nan", "a/finite"], "non-finite rows sort first, then by key");
	assert.equal(rows[0].tokens, Infinity);
	assert.ok(Number.isNaN(rows[1].tokens));
	assert.equal(rows[2].tokens, 10);
	assert.deepEqual(JSON.parse(JSON.stringify(rows)).map((m) => m.tokens), [null, null, 10], "the dashboard receives null and shows -");
});

test("task-only record rows join one decision subject, not two subjects sharing a task id", () => {
	const row = childRow(null, "st_x", "s-main");
	const a = { fp: "a", event: "opened", subject: { sessionId: "child-a", taskId: row.taskId }, ts: iso(T0 + MIN) };
	const resolved = { ...a, event: "resolved", ts: iso(T0 + 2 * MIN) };
	const b = { ...a, fp: "b", subject: { sessionId: "child-b", taskId: row.taskId } };
	const record = (decisions) => buildSessionRecord({ id: row.taskId, row, decisions });
	assert.deepEqual(fprs(record([a, resolved]), "findings"), ["a", "a"]);
	assert.deepEqual(fprs(record([a, resolved, b]), "findings"), []);
});

test("two main sessions whose records all carry taskId null do not leak into each other", () => {
	const fixture = corpus();
	const main = fixture.rows[0];
	const other = fixture.rows[1];
	const mainRecord = buildSessionRecord({ id: main.sessionId, row: main, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const otherRecord = buildSessionRecord({ id: other.sessionId, row: other, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(fprs(mainRecord, "findings").some((fp) => fp === "fp-unrelated"), false);
	assert.equal(fprs(otherRecord, "findings").some((fp) => fp === "fp-direct"), false);
	assert.equal(otherRecord.health.investigations.some((inv) => inv.id === "fp-direct"), false);
	assert.equal(mainRecord.health.investigations.some((inv) => inv.id === "fp-unrelated"), false);
});

test("a child's verdict logged 2 h after the parent ended is in the parent's record; an unrelated one is not", () => {
	const record = recordForMain();
	const child = record.health.investigations.find((inv) => inv.id === "fp-child");
	assert.deepEqual(child.verdictHistory.map((v) => v.diagnosis), ["after parent end"]);
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-unrelated"), false);
});

test("a machine-wide finding inside the window is included with scope machine, one outside excluded", () => {
	const fixture = corpus();
	fixture.decisions.push(
		{ fp: "fp-machine-in", subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR) },
		{ fp: "fp-machine-in", subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + 1.5 * HOUR) },
		{ fp: "fp-machine-out", subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 - 10 * HOUR) },
		{ fp: "fp-machine-out", subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 - 9 * HOUR) },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine");
	assert.deepEqual(machine.map((item) => item.fp), ["fp-machine-in"]);
	assert.equal(machine[0].ts, iso(T0 + HOUR));
});

test("a machine outage opened before the session and resolved during it is included; one resolved before the start is not", () => {
	const fixture = corpus();
	fixture.decisions.push(
		{ fp: "fp-outage-open", subject: { key: "machine" }, event: "opened", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 5 * HOUR) },
		{ fp: "fp-outage-open", subject: { key: "machine" }, event: "resolved", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 + 30 * MIN) },
		{ fp: "fp-outage-old", subject: { key: "machine" }, event: "opened", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 12 * HOUR) },
		{ fp: "fp-outage-old", subject: { key: "machine" }, event: "resolved", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 2 * HOUR) },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine").map((item) => item.fp);
	assert.deepEqual(machine, ["fp-outage-open"]);
});

test("the loader includes overlapping machine incidents opened 31 days before the session", () => {
	const { paths } = setup();
	const openedMs = T0 - 31 * 24 * HOUR;
	const incident = { subject: { key: "machine" }, detector: "D6", kind: "provider-down", severity: "warn" };
	writeLedger(paths, [mainRow()]);
	writeDecisions(paths, [
		{ ...incident, fp: "fp-open", event: "opened", ts: iso(openedMs) },
		{ ...incident, fp: "fp-during", event: "opened", ts: iso(openedMs + MIN) },
		{ ...incident, fp: "fp-closed", event: "opened", ts: iso(openedMs + 2 * MIN) },
		{ ...incident, fp: "fp-closed", event: "resolved", ts: iso(T0 - MIN) },
		{ ...incident, fp: "fp-during", event: "resolved", ts: iso(T0 + MIN) },
	]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	const machine = record.health.findings.filter(({ scope }) => scope === "machine");
	assert.deepEqual(machine.map(({ fp, ts, event }) => [fp, ts, event]), [
		["fp-during", iso(openedMs + MIN), "opened"],
		["fp-open", iso(openedMs), "opened"],
	]);
});

test("the loader includes every overlapping interval of a repeated machine fingerprint", () => {
	const { paths } = setup();
	const row = mainRow();
	const incident = { fp: "fp-machine", subject: { key: "machine" }, detector: "D2", kind: "machine-commit" };
	writeLedger(paths, [row]);
	writeDecisions(paths, [
		{ ...incident, event: "opened", ts: iso(T0 - 2 * MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 - MIN) },
		{ ...incident, event: "opened", ts: iso(T0 + MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 + 2 * MIN) },
		{ ...incident, event: "reopened", ts: iso(T0 + 3 * MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 + 4 * MIN) },
		{ ...incident, event: "reopened", ts: iso(row.endedMs + MIN) },
	]);
	const record = loadSessionRecord({ paths, id: row.sessionId, now: row.endedMs + HOUR });
	const machine = record.health.findings.filter(({ scope }) => scope === "machine");
	assert.deepEqual(machine.map(({ fp, ts, event }) => [fp, ts, event]), [
		[incident.fp, iso(T0 + 3 * MIN), "reopened"],
		[incident.fp, iso(T0 + MIN), "opened"],
	]);
});

test("transcript omo-health entries are collected; other custom types and a tool result quoting the string are ignored", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [
		{ type: "session", id: "s-main" },
		ohealth(T0 + 10 * MIN, "first notice"),
		{ type: "custom_message", customType: "other-tool", id: "x1", timestamp: iso(T0 + 11 * MIN), content: "not ours" },
		{ type: "message", id: "x2", timestamp: iso(T0 + 12 * MIN), message: { role: "toolResult", content: [{ type: "text", text: 'grep "customType":"omo-health" src' }] } },
		{ type: "custom", customType: "omo-health", id: "x3", timestamp: iso(T0 + 13 * MIN), content: "second notice" },
	]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.health.counts.messages, 2);
	assert.deepEqual(record.health.messages.map((m) => m.text), ["second notice", "first notice"]);
	assert.ok(record.health.messages.every((m) => m.recipient === "s-main"));
});

test("60 messages are all in the record", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	const entries = [{ type: "session", id: "s-main" }];
	for (let i = 0; i < 60; i += 1) entries.push(ohealth(T0 + MIN + i, `notice ${i}`));
	mainSessionFile(paths, "s-main", entries);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.health.counts.messages, 60);
	assert.equal(record.health.messages[0].text, "notice 59");
});

test("two different verdicts for one fp keep their order", () => {
	const record = recordForMain();
	const direct = record.health.investigations.find((inv) => inv.id === "fp-direct");
	assert.deepEqual(direct.verdictHistory.map((v) => v.verdict), ["escalate", "wait"]);
});

test("with 51 descendants, a message in the 51st descendant file is in the record under the default scan", () => {
	const { paths } = setup();
	const rows = [mainRow({ cwd: paths.repoRoot })];
	const cwd = paths.repoRoot;
	for (let i = 0; i < 51; i += 1) {
		rows.push(childRow(`s-d${i}`, `st_d${i}`, "s-main", { cwd: paths.repoRoot, startedMs: T0 + MIN, endedMs: T0 + 10 * MIN + i * 1000 }));
		childSessionFile(cwd, `st_d${i}`, `s-d${i}`, [{ type: "session", id: `s-d${i}` }, ...(i === 50 ? [ohealth(T0 + 20 * MIN, "in the 51st")] : [])]);
	}
	writeLedger(paths, rows);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.children.length, 51);
	assert.ok(record.health.messages.some((m) => m.text === "in the 51st" && m.recipient === "s-d50"));
});

test("with 21 overlapping machine findings, the 21st is in the record and reachable by offset", () => {
	const fixture = corpus();
	for (let i = 0; i < 21; i += 1) {
		fixture.decisions.push(
			{ fp: `fp-m${i}`, subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR + i) },
			{ fp: `fp-m${i}`, subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR + i + 1) },
		);
	}
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine");
	assert.equal(machine.length, 21);
	assert.ok(machine.some((item) => item.fp === "fp-m20"));
	assert.equal(machine.at(-1).fp, "fp-m0", "the oldest machine finding is still in the record, reachable by offset");
});

test("a file larger than an injected messageScanMaxBytes yields its message through the dashboard default", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "large but readable")]);
	const bounded = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR, messageScanMaxBytes: 16 });
	assert.equal(bounded.health.counts.messages, 0);
	const unbounded = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(unbounded.health.messages[0].text, "large but readable");
});

test("a ghp_ token in stored text is redacted", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "use ghp_abcdefgh12345678 now")]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	const text = record.health.messages[0].text;
	assert.equal(text.includes("ghp_abcdefgh12345678"), false);
	assert.ok(text.includes("ghp_[REDACTED]"));
});

test("an unknown id returns {found:false}", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	assert.deepEqual(loadSessionRecord({ paths, id: "s-missing", now: T0 + 24 * HOUR }), { found: false, id: "s-missing" });
});

test("a session file larger than messageScanMaxBytes is never scanned and is listed as skipped", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	const file = mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "never read")]);
	const calls = [];
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR, messageScanMaxBytes: 16, scanMessages: (target) => (calls.push(target), []) });
	assert.equal(calls.length, 0);
	assert.deepEqual(record.truncated.messagesSkipped, [file]);
	assert.equal(record.health.counts.messages, 0);
});

test("the total message scan budget admits the own file and only the newest descendant", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const mib = 1024 * 1024;
	const budget = 64 * mib;
	const own = mainSessionFile(paths, "s-main", [ohealth(T0, "own")]);
	fs.truncateSync(own, 40 * mib);
	const children = [1, 2, 3].map((n) => childRow(`s-${n}`, `st_${n}`, "s-main", { cwd: root, endedMs: T0 + n * MIN }));
	const files = children.map(({ sessionId, taskId }) => {
		const file = childSessionFile(root, taskId, sessionId, [ohealth(T0, sessionId)]);
		fs.truncateSync(file, 20 * mib);
		return file;
	});
	writeLedger(paths, [mainRow({ cwd: root }), ...children]);

	const calls = [];
	let bytes = 0;
	const record = loadSessionRecord({
		paths, id: "s-main", now: T0 + 24 * HOUR, messageScanTotalBytes: budget,
		scanMessages(file) {
			calls.push(file);
			bytes += fs.statSync(file).size;
			return [];
		},
	});
	assert.deepEqual(calls, [own, files[2]]);
	assert.deepEqual(record.truncated.messagesSkipped, [files[1], files[0]]);
	assert.ok(bytes <= budget);
});

test("action facts carry the structured outcome and a reason code", () => {
	const fixture = corpus();
	fixture.decisions.push({
		fp: "fp-direct",
		action: { key: "nudge:fp-direct", kind: "nudge" },
		result: "skipped:main-session",
		outcome: { killed: [{ pid: 1 }, { pid: 2 }], survived: [{ pid: 3 }], delivered: false, via: "inbox", error: "boom" },
		subject: { sessionId: "s-main" },
		detector: "D1",
		kind: "stall",
	});
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const action = record.health.actions.find((item) => item.result === "skipped:main-session");
	assert.deepEqual(action.facts, { delivered: false, via: "inbox", killed: 2, survived: 1, error: true, reasonCode: "skipped" });
	assert.equal(action.recipient, "s-main");
});

test("coverage.infoFindings is true only for a coverage event that precedes the session start", () => {
	const fixture = corpus();
	const row = fixture.rows[0];
	const before = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(before.coverage.infoFindings, true);
	const late = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: [{ event: "coverage", infoFindings: true, ts: iso(T0 + HOUR) }], investigations: [] });
	assert.equal(late.coverage.infoFindings, false);
});

test("analystModels collects decision-only fps' analyzing models plus the investigation file's model", () => {
	const fixture = corpus();
	fixture.investigations.find((record) => record.id === "fp-fp").model = "openai/file-review";
	fixture.decisions.push(
		{ fp: "fp-decision-only", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-child", taskId: "st_a" } },
		{ fp: "fp-decision-only", event: "investigation", status: "analyzing", model: "openai/first-review" },
		{ fp: "fp-decision-only", event: "investigation", status: "analyzing", model: "openai/second-review" },
		{ fp: "fp-unrelated", event: "investigation", status: "analyzing", model: "openai/unrelated-review" },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(record.health.investigations.some((investigation) => investigation.id === "fp-decision-only"), false, "no investigation file exists for the fp");
	assert.deepEqual(record.analystModels, ["openai/file-review", "openai/first-review", "openai/second-review"], "the unrelated fp's model stays out");
});

const MIB = 1024 * 1024;
const FILLER_LINE = '{"type":"message","id":"f"}\n';
const FILLER_BLOCK = Buffer.from(FILLER_LINE.repeat(Math.floor(MIB / FILLER_LINE.length)));
const scanFile = (dir, name = "session.jsonl") => path.join(dir, name);

function jsonl(entries) {
	return entries.map((entry) => `${typeof entry === "string" ? entry : JSON.stringify(entry)}\n`).join("");
}

test("an omo-health message line that straddles the 4 MiB read boundary is found", (t) => {
	const dir = tmpDir("omoh-scan-edge-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const line = Buffer.from('{"t":1}\n');
	// 4 MiB - 24 is an exact multiple of the 8-byte filler, so the message starts 24 bytes before the first chunk ends.
	const prefix = Buffer.alloc(4 * MIB - 24, line);
	const message = ohealth(T0 + MIN, "across the boundary");
	fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from(jsonl([message, { type: "session", id: "s-edge" }]))]));
	assert.ok(Buffer.from(jsonl([message])).length > 24, "the message line crosses the boundary");
	assert.deepEqual(scanOmoHealthMessages(file), [{ ms: T0 + MIN, text: "across the boundary" }]);
});

test("a 70 MiB file with 3 omo-health messages scans under a 96 MiB heap in a child node process", (t) => {
	const dir = tmpDir("omoh-scan-big-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir, "big-session.jsonl");
	const messages = [ohealth(T0 + MIN, "first"), ohealth(T0 + 2 * MIN, "second"), ohealth(T0 + 3 * MIN, "third")];
	const expected = [
		{ ms: T0 + MIN, text: "first" },
		{ ms: T0 + 2 * MIN, text: "second" },
		{ ms: T0 + 3 * MIN, text: "third" },
	];
	const fd = fs.openSync(file, "w");
	try {
		fs.writeSync(fd, jsonl([{ type: "session", id: "s-big" }]));
		for (let i = 0; i < 70; i += 1) {
			if (i === 5) fs.writeSync(fd, jsonl([messages[0]]));
			if (i === 35) fs.writeSync(fd, jsonl([messages[1]]));
			if (i === 65) fs.writeSync(fd, jsonl([messages[2]]));
			fs.writeSync(fd, FILLER_BLOCK);
		}
	} finally {
		fs.closeSync(fd);
	}
	assert.ok(fs.statSync(file).size > 70 * MIB, "the fixture is larger than 70 MiB");
	const moduleUrl = new URL("../src/session-record.mjs", import.meta.url).href;
	const script = path.join(dir, "scan-child.mjs");
	fs.writeFileSync(script, `import { scanOmoHealthMessages } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(scanOmoHealthMessages(process.argv[2])));\n`);
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", script, file], { encoding: "utf8", maxBuffer: 8 * MIB });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), expected);
});

test("a 2 MiB tool-result line quoting the marker is dropped and the next message line is returned", (t) => {
	const dir = tmpDir("omoh-scan-overlong-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const toolResult = {
		type: "message",
		id: "big",
		timestamp: iso(T0),
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: `${"x".repeat(2 * MIB)} "customType":"omo-health"` }] },
	};
	const message = ohealth(T0 + MIN, "after the giant line");
	fs.writeFileSync(file, jsonl([{ type: "session", id: "s-big-line" }, toolResult, message]));
	assert.ok(fs.statSync(file).size > 2 * MIB);
	assert.deepEqual(scanOmoHealthMessages(file), [{ ms: T0 + MIN, text: "after the giant line" }]);
});

test("CRLF lines and a final line without a newline are both read", (t) => {
	const dir = tmpDir("omoh-scan-crlf-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const first = ohealth(T0 + MIN, "crlf line");
	const last = ohealth(T0 + 2 * MIN, "no trailing newline");
	fs.writeFileSync(file, `${JSON.stringify(first)}\r\n${JSON.stringify(last)}`);
	assert.deepEqual(scanOmoHealthMessages(file), [
		{ ms: T0 + MIN, text: "crlf line" },
		{ ms: T0 + 2 * MIN, text: "no trailing newline" },
	]);
});
