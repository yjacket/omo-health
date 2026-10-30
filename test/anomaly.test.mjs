import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { COLD_START_COMPLETIONS, signals } from "../src/anomaly/signals.mjs";
import { createAnomalyWatch } from "../src/anomaly/watch.mjs";
import { LogCollector } from "../src/collect/logs.mjs";
import { normalizeRows } from "../src/collect/procs.mjs";
import { SessionTracker } from "../src/collect/sessions.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { closeDb, openDb } from "../src/db/db.mjs";
import { completionCount, lineageOf, lineageSeen, recordCompletion, recordLineage, shapeKeyOf, shapeStats } from "../src/db/toolcalls.mjs";
import { createEngine } from "../src/engine.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { createAnalyst } from "../src/judge/analyst.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { redact, truncate } from "../src/util/text.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState, taskRecord } from "./helpers/world.mjs";
import { guardProcessListeners } from "./helpers/fake-proc.mjs";

guardProcessListeners();

const CALL_MS = Date.parse("2026-09-23T15:37:04.874Z");
const HOST = 25760;
const SEC = 1000;
const iso = (ms) => new Date(ms).toISOString();
const CMD = "node driver.mjs";
const OTHER_CMD = "node other.mjs";

// ---------------------------------------------------------------------------------------------------------------------
// signals (pure)

const COLD = { enabled: true, minShapeSamples: 20, outlierFactor: 3, windowSignal: true };
const stats = (n, median = 10 * SEC, p99 = 20 * SEC) => ({ n, median, p99 });
const ask = (overrides = {}) =>
	signals({
		pending: { ageMs: 2 * 60 * SEC, shapeKey: "node #", lineageFp: "fp-new", lineage: "bash.exe>node.exe" },
		procs: [{ name: "bash.exe" }, { name: "node.exe" }],
		shapeStats: () => stats(50, 100 * SEC, 200 * SEC),
		lineageSeen: () => true,
		completions: 250,
		config: COLD,
		...overrides,
	});
const kinds = (list) => list.map((s) => s.kind);

test("signals: silent on an empty history and below the 200-completion cold start, whatever the call shows", () => {
	const loud = { procs: [{ name: "notepad.exe", windowVisible: true, windowTitle: "Untitled" }], lineageSeen: () => false, shapeStats: () => stats(50) };
	assert.deepEqual(ask({ ...loud, completions: 0 }), []);
	assert.deepEqual(ask({ ...loud, completions: COLD_START_COMPLETIONS - 1 }), []);
	assert.deepEqual(kinds(ask({ ...loud, completions: COLD_START_COMPLETIONS })), ["unseen-lineage", "duration-outlier", "visible-window"]);
	assert.deepEqual(ask({ ...loud, config: { ...COLD, enabled: false } }), []);
	assert.deepEqual(ask({ ...loud, pending: { ageMs: 59 * SEC, shapeKey: "node #", lineageFp: "fp-new" } }), [], "a call younger than a minute raises nothing");
});

test("signals: an unseen lineage, a duration outlier with n >= 20 and a visible window each raise their own signal", () => {
	assert.deepEqual(ask(), [], "a known lineage, a normal duration, no window");
	assert.deepEqual(kinds(ask({ lineageSeen: (fp) => fp !== "fp-new" })), ["unseen-lineage"]);
	assert.deepEqual(ask({ pending: { ageMs: 2 * 60 * SEC, shapeKey: "node #" } }), [], "a call whose tree was never matched has no lineage to judge");

	// 20 samples is enough, 19 is not; the limit is the larger of factor x median and the p99.
	assert.deepEqual(kinds(ask({ shapeStats: () => stats(20) })), ["duration-outlier"]);
	assert.deepEqual(ask({ shapeStats: () => stats(19) }), []);
	assert.deepEqual(ask({ shapeStats: () => stats(50, 10 * SEC, 130 * SEC) }), [], "under the p99");
	assert.deepEqual(ask({ shapeStats: () => stats(50, 50 * SEC, 60 * SEC) }), [], "under 3 x the median (150 s)");
	assert.deepEqual(kinds(ask({ shapeStats: () => stats(50, 30 * SEC, 60 * SEC) })), ["duration-outlier"], "120 s > max(90 s, 60 s)");

	const window = ask({ procs: [{ name: "bash.exe", windowVisible: false }, { name: "notepad.exe", windowVisible: true, windowTitle: "Untitled - Notepad" }] });
	assert.deepEqual(window, [{ kind: "visible-window", detail: "notepad.exe: Untitled - Notepad" }]);
	assert.deepEqual(ask({ procs: [{ name: "notepad.exe", windowVisible: true }], config: { ...COLD, windowSignal: false } }), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// recording

test("a tool result that resolves a pending call becomes a completion record with the redacted command head", () => {
	const dir = tmpDir("omoh-anomaly-session-");
	const file = path.join(dir, "2026_c1.jsonl");
	const line = (entry) => JSON.stringify(entry);
	fs.writeFileSync(
		file,
		[
			line({ type: "session", id: "c1", timestamp: iso(CALL_MS), cwd: "C:/x" }),
			line({ type: "message", id: "e1", timestamp: iso(CALL_MS + SEC), message: { role: "assistant", stopReason: "toolUse", timestamp: CALL_MS + SEC, content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "node C:/qa/run7/driver.mjs --port 9222 && echo ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop" } }] } }),
			line({ type: "message", id: "e2", timestamp: iso(CALL_MS + 31 * SEC), message: { role: "toolResult", toolCallId: "tc1", isError: true, content: [{ type: "text", text: "boom" }] } }),
			line({ type: "message", id: "e3", timestamp: iso(CALL_MS + 32 * SEC), message: { role: "toolResult", toolCallId: "never-pending", content: [{ type: "text", text: "late" }] } }),
		].join("\n") + "\n",
	);
	const tracker = new SessionTracker({ file, kind: "child", meta: { sessionId: "c1", taskId: "st_1" } });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.completions.length, 1, "a result with no pending call is no completion");
	const [completion] = tracker.completions;
	assert.deepEqual({ ...completion, commandHead: undefined }, { id: "tc1", sessionId: "c1", taskId: "st_1", kind: "child", tool: "bash", startMs: CALL_MS + SEC, endMs: CALL_MS + 31 * SEC, isError: true, commandHead: undefined });
	assert.ok(!completion.commandHead.includes("sk-ant-api03-abcdefghijklmnop"));
	assert.match(completion.commandHead, /^node C:\/qa\/run7\/driver\.mjs --port 9222/);
});

test("the recorder stores a normalized shape and the redacted lineage, never the command; an omo-health release marks the row censored", () => {
	const db = openDb({ file: ":memory:" });
	try {
		const config = { ...DEFAULT_CONFIG };
		const watch = createAnomalyWatch({ db, config, clock: createFakeClock(CALL_MS) });
		watch.released("c-killed");
		const secretCommand = "node C:/qa/run7/driver.mjs --port 9222 ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop";
		const rows = [
			{ id: "c-ok", sessionId: "c1", taskId: "st_1", kind: "child", tool: "bash", startMs: CALL_MS, endMs: CALL_MS + 5000, isError: false, commandHead: secretCommand },
			{ id: "c-killed", sessionId: "c1", taskId: "st_1", kind: "child", tool: "bash", startMs: CALL_MS, endMs: CALL_MS + 900_000, isError: true, commandHead: secretCommand },
			{ id: "c-read", sessionId: "c1", tool: "read", startMs: CALL_MS, endMs: CALL_MS + 40, isError: false, commandHead: "" },
		];
		assert.equal(watch.record(rows), 3);
		const stored = db.prepare("SELECT * FROM tool_calls ORDER BY id").all();
		assert.deepEqual(stored.map((r) => [r.id, r.ended_by, r.dur_ms, r.is_error]), [["c-killed", "omo-health", 900_000, 1], ["c-ok", "result", 5000, 0], ["c-read", "result", 40, 0]]);
		assert.equal(stored[1].shape_key, shapeKeyOf(truncate(redact(secretCommand), 400)));
		assert.match(stored[1].shape_key, /^node # --port # /);
		assert.equal(stored[2].shape_key, "tool:read");
		assert.ok(!JSON.stringify(stored).includes("sk-ant-api03"), "no secret in any column");
		assert.ok(!JSON.stringify(stored).includes("run7"), "no raw path in any column");
		assert.equal(shapeStats(db, stored[1].shape_key, 0).n, 1, "the released call is censored out of the shape's durations");
	} finally {
		closeDb(db);
	}
});

test("analyst lane sessions are excluded from the history and from the log detectors", () => {
	const db = openDb({ file: ":memory:" });
	const logs = tmpDir("omoh-anomaly-logs-");
	try {
		const watch = createAnomalyWatch({ db, config: { ...DEFAULT_CONFIG }, clock: createFakeClock(CALL_MS), laneSessionIds: () => new Set(["lane-1"]) });
		const base = { tool: "bash", startMs: CALL_MS, endMs: CALL_MS + 1000, commandHead: "echo hi" };
		assert.equal(watch.record([{ ...base, id: "a", sessionId: "lane-1" }, { ...base, id: "b", sessionId: "c1" }]), 1);
		assert.deepEqual(db.prepare("SELECT id FROM tool_calls").all().map((r) => r.id), ["b"]);

		const record = (sessionId, extra = {}) => JSON.stringify({ ts: iso(CALL_MS), level: "warn", event: "provider_error", error: "429", ...(sessionId ? { sessionId } : {}), ...extra });
		fs.writeFileSync(path.join(logs, "session.log"), [record("lane-1"), record("c1"), record(undefined), record("lane-1", { event: "never_seen_before" })].join("\n") + "\n");
		const collector = new LogCollector({ logsDir: logs });
		collector.setExcludedSessions(new Set(["lane-1"]));
		collector.read();
		assert.deepEqual(collector.drain().map((e) => [e.type, e.sessionId]), [["providerError", "c1"], ["providerError", undefined]]);
		assert.deepEqual([collector.stats.get("session.log").lines, collector.stats.get("session.log").unknown], [2, 0], "a lane session's lines count for no parse-drift check either");
	} finally {
		closeDb(db);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// engine

const PROGRESSING = { verdict: "progressing", cause: "external-wait", evidence: ["a deliberate wait"], confidence: 0.8, diagnosis: "It waits for a timer.", recheck_after_s: 600 };
const STUCK = { verdict: "stuck", cause: "blocked-input", evidence: ["the shell tree has been idle for 10 minutes", "node.exe uses no CPU and writes nothing"], confidence: 0.95, diagnosis: "Nothing in the tree can finish by itself.", respawn_text: "Restart the step." };

/**
 * One child whose pending bash call(s) run under a host, with a real in-memory history DB. `seed` is a list of
 * `{shape, n, durMs, lineage?}`: finished calls of that shape ending in the last week.
 */
function harness({ seed = [{ shape: shapeKeyOf(CMD), n: 250, durMs: 20 * 60 * SEC }], seedLineage = ["bash.exe", "node.exe"], window = false, config: extra = {}, outcome = { status: "running" }, analyst, laneIds, secondCall = false } = {}) {
	const root = tmpDir("omoh-anomaly-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(CALL_MS + 2 * 60 * SEC);
	const db = openDb({ file: ":memory:" });
	let n = 0;
	for (const { shape, n: count, durMs } of seed) {
		for (let i = 0; i < count; i++) recordCompletion(db, { id: `seed-${n++}`, sessionId: "old", kind: "child", tool: "bash", shapeKey: shape, startMs: CALL_MS - 3_600_000 - i * 1000 - durMs, endMs: CALL_MS - 3_600_000 - i * 1000, endedBy: "result" });
	}
	if (seedLineage) {
		const { fp, lineage } = lineageOf(seedLineage.map((name) => ({ name })));
		recordLineage(db, fp, lineage, CALL_MS - 3_600_000);
	}
	const task = taskRecord({ taskId: "st_01a0ced9", status: "running", hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", backgroundMode: "background", childSessionId: "c1" });
	const calls = [{ id: "toolu_a", name: "bash", args: { command: CMD }, ms: CALL_MS, batchId: "b" }];
	if (secondCall) calls.push({ id: "toolu_b", name: "bash", args: { command: OTHER_CMD }, ms: CALL_MS + 1000, batchId: "b2" });
	const child = sessionState({ id: "c1", kind: "child", taskId: task.taskId, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", task, pendingCalls: calls });
	const parent = sessionState({ id: "p1", kind: "main", hostPid: HOST, lastMessage: { role: "assistant", stopReason: "stop" } });
	const sessions = new Map([["c1", child], ["p1", parent]]);
	const procRows = new Map([
		[HOST, { p: HOST, pp: 1, n: "node.exe", c: "2026-09-23T09:00:00Z", cpu: 0, pv: 1e8, cl: "node C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" }],
		[60168, { p: 60168, pp: HOST, n: "bash.exe", c: iso(CALL_MS + 5), cpu: 0, pv: 1e6, cl: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${CMD}"` }],
		[60180, { p: 60180, pp: 60168, n: "node.exe", c: iso(CALL_MS + 50), cpu: 0, pv: 1e6, cl: CMD }],
	]);
	if (window) procRows.set(60190, { p: 60190, pp: 60168, n: "notepad.exe", c: iso(CALL_MS + 60), cpu: 0, pv: 1e6, cl: "notepad.exe", wv: true, wt: "Untitled - Notepad" });
	const procs = {
		async snapshot() {
			return { takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) };
		},
		async os() {
			return { commitFrac: 0.5, commitUsedBytes: 1, commitLimitBytes: 2 };
		},
		async ports() {
			return [];
		},
		restarts: 0,
		close() {},
	};
	const config = { ...DEFAULT_CONFIG, procSnapshotMs: 20_000, ...extra };
	const runner = createFakeRunner({ outcomes: { analyst: outcome } });
	const killed = [];
	const sent = [];
	const decisions = [];
	const completions = [];
	const investigations = createInvestigations({ paths, clock });
	const engine = createEngine({
		paths,
		config,
		clock,
		detectors: [],
		sources: { procs, registry: { refresh: () => ({ sessions, tasks: [task], completions: completions.splice(0) }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: {
			kill: async (args) => (killed.push(args), { killed: [], survived: [], noop: [], errors: [] }),
			send: (message) => (sent.push(message), "inbox-file"),
			notifier: { toast: () => ({ ok: true }) },
			decide: (d) => decisions.push(d),
			sensors: () => new Map(),
			db,
			analyst: analyst ?? createAnalyst({ config, paths, clock, runner, env: {} }),
		},
		options: { selfPid: 1, investigations },
	});
	return { engine, clock, db, runner, killed, sent, decisions, completions, investigations, paths, child, procRows, sessions, laneIds };
}

async function ticks(h, count = 4) {
	for (let i = 0; i < count; i++) {
		await h.engine.tick();
		h.clock.advance(20_000);
	}
}
const stub = (laneIds) => {
	const starts = [];
	return { starts, analyst: { start: (finding) => (starts.push(finding.fp), { tier: 2, verdict: "escalate", reason: "analyst-off", notReached: true }), poll: () => undefined, health: () => ({}), laneSessionIds: () => laneIds ?? new Set() } };
};

test("cold start: an empty history, or one under 200 calls, opens nothing for a novel lineage with a visible window", async () => {
	for (const seed of [[], [{ shape: shapeKeyOf(CMD), n: 199, durMs: 600 * SEC }]]) {
		const h = harness({ seed, seedLineage: null, window: true });
		await ticks(h);
		assert.deepEqual(h.investigations.list(), [], `${completionCount(h.db)} calls in the history`);
		assert.equal(h.runner.starts.length, 0, "the analyst is never asked");
		assert.deepEqual([h.killed, h.sent], [[], []]);
		assert.deepEqual(h.decisions.filter((d) => d.detector === "D19"), []);
		closeDb(h.db);
	}
});

test("250 completions + a pending call with a visible window: one anomaly investigation, the analyst asked once, nothing acted on", async () => {
	const h = harness({ window: true });
	try {
		await ticks(h, 5);
		const list = h.investigations.list();
		assert.equal(list.length, 1, "one investigation per call");
		const [inv] = list;
		assert.deepEqual([inv.trigger, inv.detector, inv.status, inv.subject.toolCallId, inv.subject.taskId], ["anomaly", "D19", "analyzing", "toolu_a", "st_01a0ced9"]);
		assert.deepEqual(inv.signals.map((s) => s.kind).sort(), ["unseen-lineage", "visible-window"], "the lineage with the notepad is new; the normal bash>node one was seeded");
		assert.match(inv.signals.find((s) => s.kind === "visible-window").detail, /notepad\.exe: Untitled - Notepad/);
		assert.equal(h.runner.starts.length, 1, "one analyst job, however many ticks follow");
		const bundle = fs.readFileSync(path.join(h.paths.health.analystJobsDir, h.runner.starts[0].jobId, "bundle.md"), "utf8");
		for (const text of ["visible-window", "notepad.exe", "Untitled - Notepad", "\"root_shell_path\""]) assert.ok(bundle.includes(text), `the bundle shows ${text}`);
		assert.ok(!bundle.includes("release-shell"), "an anomaly look offers no release");
		assert.deepEqual([h.killed, h.sent], [[], []]);
		assert.deepEqual(h.decisions.filter((d) => d.event === "investigation").map((d) => [d.trigger, d.status]).slice(0, 2), [["anomaly", "open"], ["anomaly", "analyzing"]]);
	} finally {
		closeDb(h.db);
	}
});

test("a normal call (known lineage, usual duration, no window) opens nothing; a duration outlier needs 20 samples of its shape", async () => {
	const normal = harness();
	await ticks(normal);
	assert.deepEqual(normal.investigations.list(), []);
	closeDb(normal.db);

	const fast = (n) => [{ shape: shapeKeyOf(CMD), n, durMs: 10 * SEC }, { shape: "tool:read", n: 250, durMs: 50 }];
	const thin = harness({ seed: fast(19) });
	await ticks(thin);
	assert.deepEqual(thin.investigations.list(), [], "19 samples are too few");
	closeDb(thin.db);
	const enough = harness({ seed: fast(20) });
	await ticks(enough);
	const [inv] = enough.investigations.list();
	assert.deepEqual([inv.trigger, inv.signals.map((s) => s.kind)], ["anomaly", ["duration-outlier"]]);
	closeDb(enough.db);
});

test("anomaly.perHour caps the investigations opened in an hour; one call is never opened twice", async () => {
	const seed = [{ shape: shapeKeyOf(CMD), n: 120, durMs: 10 * SEC }, { shape: shapeKeyOf(OTHER_CMD), n: 120, durMs: 10 * SEC }];
	const capped = harness({ seed, secondCall: true, config: { anomaly: { ...DEFAULT_CONFIG.anomaly, perHour: 1 } } });
	await ticks(capped, 6);
	assert.equal(capped.investigations.list().length, 1);
	closeDb(capped.db);
	const open = harness({ seed, secondCall: true, config: { anomaly: { ...DEFAULT_CONFIG.anomaly, perHour: 2 } } });
	await ticks(open, 6);
	assert.deepEqual(open.investigations.list().map((i) => i.subject.toolCallId).sort(), ["toolu_a", "toolu_b"]);
	closeDb(open.db);
});

test("a signal never produces a process action without a verdict, and no verdict of an anomaly releases a shell", async () => {
	const waiting = harness({ window: true, config: { mode: "auto" } });
	await ticks(waiting, 6);
	assert.deepEqual([waiting.killed, waiting.sent], [[], []], "an analyst that has not answered kills and tells nobody");
	assert.ok(waiting.decisions.every((d) => !d.action || d.action.kind === "analyze"), "the only thing planned is the look");
	closeDb(waiting.db);

	const stuck = harness({ window: true, outcome: { status: "done", result: STUCK, costUsd: 0.01 } });
	await ticks(stuck, 8);
	assert.deepEqual(stuck.killed, [], "a `stuck` answer cannot release: the anomaly look never offered it");
	assert.deepEqual(stuck.sent, []);
	assert.ok(stuck.decisions.every((d) => !d.action || d.action.kind === "analyze"));
	assert.notEqual(stuck.investigations.list()[0].status, "released");
	closeDb(stuck.db);

	const patient = harness({ window: true, outcome: { status: "done", result: PROGRESSING, costUsd: 0.01 } });
	await ticks(patient, 8);
	assert.deepEqual([patient.killed, patient.sent], [[], []]);
	assert.equal(patient.investigations.list()[0].status, "verdict");
	closeDb(patient.db);
});

test("an analyst lane session is neither recorded nor raised on; a tick records the call it captured, lineage and window included", async () => {
	const lane = stub(new Set(["c1"]));
	const excluded = harness({ window: true, analyst: lane.analyst });
	await ticks(excluded);
	assert.deepEqual([excluded.investigations.list(), lane.starts], [[], []]);
	excluded.completions.push({ id: "toolu_a", sessionId: "c1", tool: "bash", startMs: CALL_MS, endMs: CALL_MS + 130 * SEC, isError: false, commandHead: CMD });
	await ticks(excluded, 1);
	assert.equal(completionCount(excluded.db), 250, "nothing of the lane was recorded");
	closeDb(excluded.db);

	const h = harness({ window: true, analyst: stub().analyst });
	try {
		await ticks(h, 2);
		const before = completionCount(h.db);
		h.child.pending.clear();
		h.completions.push({ id: "toolu_a", sessionId: "c1", taskId: "st_01a0ced9", kind: "child", tool: "bash", startMs: CALL_MS, endMs: CALL_MS + 130 * SEC, isError: false, commandHead: CMD });
		await ticks(h, 1);
		assert.equal(completionCount(h.db), before + 1);
		const row = h.db.prepare("SELECT * FROM tool_calls WHERE id = 'toolu_a'").get();
		assert.deepEqual([row.shape_key, row.window_seen, row.ended_by, row.dur_ms, row.lineage], [shapeKeyOf(CMD), 1, "result", 130 * SEC, "bash.exe>notepad.exe>node.exe"]);
		assert.equal(lineageSeen(h.db, row.lineage_fp), true, "the lineage is in the history for the next call");
	} finally {
		closeDb(h.db);
	}
});
