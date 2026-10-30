import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { composeGoalWake } from "../src/act/messages.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as goalLiveness from "../src/detect/goal-liveness.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { normalizeRows } from "../src/collect/procs.mjs";
import { projectStoreName, readGoalStore, senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const T0 = Date.parse("2026-10-10T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = T0 - 3600_000;
const COMMAND = "tail -n 0 -F probe.log | grep --line-buffered ZZZPROBE";
const GRACE = DEFAULT_CONFIG.goalLiveness.graceMs;
const LIVENESS = DEFAULT_CONFIG.goalLiveness.livenessMs;
const GAP = DEFAULT_CONFIG.goalLiveness.minWakeGapMs;

const row = (p, n, cl, ms = START, pp = 0) => ({ p, pp, n, cl, c: new Date(ms).toISOString() });
const hostRow = () => row(10, "bun.exe", "bun C:/senpi/dist/bundle/cli.js", START - 10_000);
const launcherRows = () => [hostRow(), row(20, "bash.exe", `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${COMMAND}"`, START, 10)];
const monitor = (monitorId, overrides = {}) => ({ monitorId, sessionId: "main1", description: monitorId, runtimeKind: "command", command: COMMAND, runtime: { pid: 20, startedAtMs: START }, ...overrides });

function setup() {
	const root = tmpDir("omoh-goal-liveness-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	const cwd = path.join(root, "proj");
	const sessionDir = path.join(paths.sessionsDir, "project");
	fs.mkdirSync(path.join(sessionDir, "extensions", "terminal"), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const writeManifestRaw = (manifest) => fs.writeFileSync(path.join(sessionDir, "extensions", "terminal", "main1.json"), JSON.stringify({ version: 1, sessionId: "main1", backgroundSessions: [], ...manifest }));
	const writeManifest = (monitors) => writeManifestRaw({ monitors, backgroundSessions: [] });
	// A fresh project's tasks and workflow runs live where senpi puts them: <agentDir>/projects/<name>-<hash>/senpi-task.
	const store = () => senpiTaskStoreDir(cwd, paths.agentDir);
	const writeTaskRaw = (taskId, text) => {
		fs.mkdirSync(path.join(store(), "tasks"), { recursive: true });
		fs.writeFileSync(path.join(store(), "tasks", `${taskId}.json`), text);
	};
	const writeTask = (task) => writeTaskRaw(task.task_id, JSON.stringify(task));
	const writeDagRun = (run) => {
		const dir = path.join(store(), "dag", "runs");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify({ updatedAt: new Date(T0).toISOString(), ...run }));
	};
	const goalSession = (anchor = { source: "goal", status: "active", objective: "ship it" }, extra = {}) => {
		const session = sessionState({ id: "main1", file: path.join(sessionDir, "2026-10-10T09-00-00-000Z_main1.jsonl"), cwd, ...extra });
		session.anchor = anchor;
		return session;
	};
	/** A world `offset` ms after T0 with a fresh idle sensor; sensor fields override the defaults. */
	const worldAt = (offset, { sensor = {}, rows = [hostRow()], tasks = [], sessions = [], session = goalSession(), work, config } = {}) => {
		const now = T0 + offset;
		return makeWorld({ now, paths, config, sessions: [session, ...sessions], tasks, procSnapshots: [{ takenAtMs: now, rows }],
			terminalManifest: (s) => goalLiveness.readSessionTerminalManifest(paths, s.id, s.file), goalStore: (dir) => readGoalStore(dir, paths.agentDir), workOf: () => work,
			sensors: [{ sessionId: "main1", pid: 10, ts: now, idle: true, lastEventAt: now - 60_000, wakeSources: {}, holds: [], goalLivenessSchema: 1, ...sensor }] });
	};
	return { root, paths, cwd, writeManifest, writeManifestRaw, writeTask, writeTaskRaw, writeDagRun, goalSession, worldAt };
}

const reasonsOf = (findings) => findings.map((f) => f.data.remedy.reason);

test("leaked-monitor: a dead command monitor fires only after the grace, with the goal-wake remedy", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1")]);
	const memory = {};
	const sensor = { wakeSources: { "terminal-monitors": 1 } };
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor }), memory), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(GRACE - 1, { sensor }), memory), []);
	const found = goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), memory);
	assert.equal(found.length, 1);
	assert.equal(found[0].detector, "D21");
	assert.equal(found[0].severity, "info");
	assert.equal(found[0].humanNeeded, false);
	assert.equal(found[0].subject.sessionId, "main1");
	assert.deepEqual(found[0].data.remedy, { kind: "goal-wake", reason: "leaked-monitor" });
	assert.equal(goalLiveness.detect(ctx.worldAt(GRACE + 10_000, { sensor }), memory)[0].fp, found[0].fp);
});

test("leaked-monitor: an alive command monitor yields no finding, however long", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1")]);
	const memory = {};
	const sensor = { wakeSources: { "terminal-monitors": 1 } };
	for (const offset of [0, GRACE, GRACE + 60_000, 10 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor, rows: launcherRows() }), memory), []);
});

test("leaked-monitor: a live native file monitor is never a leak (terminal-monitors 1, past graceMs + 1 tick)", () => {
	const ctx = setup();
	ctx.writeManifest([{ monitorId: "f1", sessionId: "main1", runtimeKind: "file", path: "probe.log" }]);
	const memory = {};
	const sensor = { wakeSources: { "terminal-monitors": 1 } };
	for (const offset of [0, GRACE, GRACE + 10_000, 5 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), memory), []);
	// Mixed with a dead command monitor the file monitor still keeps the wait legitimate.
	ctx.writeManifest([monitor("m1"), { monitorId: "f1", sessionId: "main1", runtimeKind: "file", path: "probe.log" }]);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(5 * GRACE + 10_000, { sensor }), memory), []);
});

test("leaked-monitor: an unreadable manifest or a stale process table proves nothing", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "terminal-monitors": 1 } };
	const memory = {};
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor }), memory), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(2 * GRACE, { sensor }), memory), []);
	ctx.writeManifest([monitor("m1")]);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(3 * GRACE, { sensor, rows: [] }), {}), []);
});

test("leaked-task: in the session's senpi-task store, no active task whose parent is the session fires after the grace; an active one does not", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "senpi-task": 1 } };
	ctx.writeTask({ task_id: "st_b", status: "completed", parent_session_id: "main1" });
	ctx.writeTask({ task_id: "st_c", status: "running", parent_session_id: "someone-else" });
	const memory = {};
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor }), memory), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(GRACE - 1, { sensor }), memory), []);
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), memory)), ["leaked-task"]);
	ctx.writeTask({ task_id: "st_a", status: "running", parent_session_id: "main1" });
	const other = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), other), []);
});

test("leaked wakes name what ended: the session's last task, its settled run, the dead monitor's id and process", () => {
	const ctx = setup();
	const memory = {};
	ctx.writeTask({ task_id: "st_b", name: "review lane", status: "completed", parent_session_id: "main1", terminal_at: new Date(T0 - 5 * MIN).toISOString() });
	const sensor = { wakeSources: { "senpi-task": 1 } };
	goalLiveness.detect(ctx.worldAt(0, { sensor }), memory);
	const [task] = goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), memory);
	assert.deepEqual(task.data.sources.map((s) => s.id), ["st_b"]);
	assert.match(task.data.sources[0].text, /^task st_b "review lane" completed at 2026-10-10T09:55:00\.000Z; no task of this session is still running\.$/);
	const other = setup();
	other.writeManifest([monitor("m1")]);
	const mem = {};
	const msensor = { wakeSources: { "terminal-monitors": 1 } };
	goalLiveness.detect(other.worldAt(0, { sensor: msensor }), mem);
	const [mon] = goalLiveness.detect(other.worldAt(GRACE, { sensor: msensor }), mem);
	assert.deepEqual([mon.data.remedy.reason, mon.data.sources[0].id], ["leaked-monitor", "m1"]);
	assert.match(mon.data.sources[0].text, /its process 20 is gone/);
	const third = setup();
	third.writeDagRun({ runId: "run_done", name: "wave 3", status: "completed", rootSessionId: "main1", parentSessionId: "main1", completedAt: new Date(T0 - 4 * MIN).toISOString(), nodes: [] });
	const rmem = {};
	const rsensor = { wakeSources: { "omo-dag": 1 } };
	third.detect = (offset) => goalLiveness.detect(third.worldAt(offset, { sensor: rsensor }), rmem);
	third.detect(0);
	const [run] = third.detect(GRACE);
	assert.deepEqual([run.data.remedy.reason, run.data.sources[0].id], ["leaked-workflow", "run_done"]);
	assert.match(run.data.sources[0].text, /^workflow run run_done "wave 3" completed at 2026-10-10T09:56:00\.000Z; no run of this session is still unsettled\.$/);
});

test("a long unfolded-workflow line keeps its waiting nodes: real-length ids are not cut at 240 characters", () => {
	const ctx = setup();
	const done = activeTask({ taskId: "st_01a1555e", name: "lane-12-engine", status: "completed", active: false, terminal: true, terminalAtMs: T0 - 3 * MIN, lastProgressMs: T0 - 3 * MIN });
	const run = waitingRun({ runId: "dag_10157df2-9ee2-4342-8609-baece4419eed", name: "omo-health 0.8.0 wave 2 (integration lanes)", lastEventAtMs: T0 - 3 * MIN, lastProgressMs: T0 - 3 * MIN, nodes: [{ id: "lane-12-engine", state: "running", taskId: "st_01a1555e" }, { id: "lane-13-actions", state: "pending" }, { id: "review-r2", state: "pending" }] });
	const [found] = goalLiveness.detect(ctx.worldAt(0, { sensor: quietSensor({ wakeSources: { "omo-dag": 1 } }), work: workView({ tasks: [done], runs: [run] }) }), {});
	const text = found.data.sources[0].text;
	assert.ok(text.length > 240, `the line is ${text.length} characters`);
	assert.match(text, /never folded into the run; waiting nodes: lane-13-actions, review-r2\.$/);
	assert.doesNotMatch(text, /\u2026/);
});

test("a malformed task record leaves silent firing at livenessMs: an unreadable store proves no progress", () => {
	const ctx = setup();
	const sensor = quietSensor({ lastEventAt: T0 - 2 * HOUR, wakeSources: { "senpi-task": 1 } });
	const fresh = activeTask({ lastProgressMs: T0 - MIN });
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, work: workView({ tasks: [fresh] }) }), {}), [], "a readable store with fresh progress defers silent");
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(0, { sensor, work: workView({ tasks: [fresh], storeReadable: false }) }), {})), ["silent"]);
});

test("leaked-task: a missing store or an unreadable record proves nothing, however long", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "senpi-task": 1 } };
	const memory = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), memory), []);
	ctx.writeTask({ task_id: "st_b", status: "completed", parent_session_id: "main1" });
	ctx.writeTaskRaw("st_half", '{"task_id":');
	for (const offset of [4 * GRACE, 6 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), memory), []);
});

test("leaked-task: a store holding no record of this session is not where its tasks went, so it proves nothing", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "senpi-task": 1 } };
	ctx.writeTask({ task_id: "st_x", status: "completed", parent_session_id: "someone-else" });
	const memory = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), memory), []);
});

test("leaked-task: the grace restarts when the leak clears in between", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "senpi-task": 1 } };
	const memory = {};
	ctx.writeTask({ task_id: "st_a", status: "completed", parent_session_id: "main1" });
	goalLiveness.detect(ctx.worldAt(0, { sensor }), memory);
	ctx.writeTask({ task_id: "st_a", status: "running", parent_session_id: "main1" });
	goalLiveness.detect(ctx.worldAt(GRACE - 10_000, { sensor }), memory);
	ctx.writeTask({ task_id: "st_a", status: "completed", parent_session_id: "main1" });
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), memory), []);
	assert.equal(goalLiveness.detect(ctx.worldAt(2 * GRACE, { sensor }), memory).length, 1);
});

test("leaked-workflow: no running dag run of the session fires after the grace; a running one, or no runs folder, does not", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "omo-dag": 1 } };
	const none = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), none), []);
	ctx.writeDagRun({ runId: "r-done", status: "completed", rootSessionId: "main1" });
	const memory = {};
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor }), memory), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(GRACE - 1, { sensor }), memory), []);
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), memory)), ["leaked-workflow"]);
	ctx.writeDagRun({ runId: "r-live", status: "running", parentSessionId: "main1" });
	const other = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), other), []);
});

test("leaked-workflow: any unsettled state is alive, and a live run is found among any number of newer runs", () => {
	const ctx = setup();
	const sensor = { wakeSources: { "omo-dag": 1 } };
	ctx.writeDagRun({ runId: "r-paused", status: "paused", rootSessionId: "main1" });
	const paused = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), paused), []);
	ctx.writeDagRun({ runId: "r-paused", status: "cancelled", rootSessionId: "main1" });
	for (let i = 0; i < 40; i++) ctx.writeDagRun({ runId: `r-other-${i}`, status: "completed", rootSessionId: "someone-else" });
	const settled = {};
	goalLiveness.detect(ctx.worldAt(0, { sensor }), settled);
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(GRACE, { sensor }), settled)), ["leaked-workflow"]);
	ctx.writeDagRun({ runId: "r-live", status: "running", parentSessionId: "main1" });
	for (let i = 40; i < 80; i++) ctx.writeDagRun({ runId: `r-other-${i}`, status: "completed", rootSessionId: "someone-else" });
	const live = {};
	for (const offset of [0, GRACE, 3 * GRACE]) assert.deepEqual(goalLiveness.detect(ctx.worldAt(offset, { sensor }), live), []);
});

test("senpiTaskStoreDir follows omo-task: <cwd>/.omo/senpi-task while it holds records, else <agentDir>/projects/<name>-<sha256 12>", () => {
	const ctx = setup();
	const projects = path.join(ctx.paths.agentDir, "projects", projectStoreName(ctx.cwd), "senpi-task");
	assert.equal(senpiTaskStoreDir(ctx.cwd, ctx.paths.agentDir), projects);
	const local = path.join(ctx.cwd, ".omo", "senpi-task");
	fs.mkdirSync(path.join(local, "tasks"), { recursive: true });
	assert.equal(senpiTaskStoreDir(ctx.cwd, ctx.paths.agentDir), projects, "empty folders are not records");
	fs.writeFileSync(path.join(local, "tasks", "st_x.json"), "{}");
	assert.equal(senpiTaskStoreDir(ctx.cwd, ctx.paths.agentDir), path.resolve(local));
	// Pinned with the formula that reproduced senpi's real store names (e.g. work-bb046d231122) on 2026-10-17.
	assert.equal(projectStoreName("C:\\omo-health-fixture\\work"), "work-a59ecae4d001");
});

test("silent: only with the omo-keepalive hold, a goalLivenessSchema 1 sensor and livenessMs without an event", () => {
	const ctx = setup();
	const quiet = (extra = {}) => ({ holds: ["omo-keepalive"], lastEventAt: T0 - LIVENESS + 1, ...extra });
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor: quiet() }), {}), []);
	const found = goalLiveness.detect(ctx.worldAt(1, { sensor: quiet() }), {});
	assert.deepEqual(reasonsOf(found), ["silent"]);
	assert.deepEqual(found[0].data.remedy, { kind: "goal-wake", reason: "silent" });
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(1, { sensor: quiet({ holds: [] }) }), {}), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(1, { sensor: quiet({ holds: ["other-hold"] }) }), {}), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(1, { sensor: quiet({ goalLivenessSchema: undefined }) }), {}), []);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(1, { sensor: quiet({ goalLivenessSchema: 2 }) }), {}), []);
});

test("minWakeGap: a recent goal-wake suppresses the finding until the gap has passed; a delivered wake starts a new incident", () => {
	const ctx = setup();
	const sensor = { holds: ["omo-keepalive"], lastEventAt: T0 - 2 * LIVENESS };
	const memory = {};
	const first = goalLiveness.detect(ctx.worldAt(0, { sensor }), memory);
	assert.equal(first.length, 1);
	memory.lastWake = { main1: T0 };
	memory.wakes = { main1: 1 };
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(GAP - 1, { sensor: { ...sensor, lastEventAt: T0 - 2 * LIVENESS } }), memory), []);
	const again = goalLiveness.detect(ctx.worldAt(GAP, { sensor }), memory);
	assert.equal(again.length, 1);
	assert.notEqual(again[0].fp, first[0].fp);
});

test("only an active goal on a main session with an idle fresh sensor is watched", () => {
	const ctx = setup();
	ctx.writeTask({ task_id: "st_done", status: "completed", parent_session_id: "main1" });
	const sensor = { wakeSources: { "senpi-task": 1 } };
	const late = 3 * GRACE;
	const check = (opts) => { const memory = {}; goalLiveness.detect(ctx.worldAt(0, opts), memory); return goalLiveness.detect(ctx.worldAt(late, opts), memory); };
	assert.equal(check({ sensor }).length, 1);
	assert.deepEqual(check({ sensor, session: ctx.goalSession({ source: "ulw", status: "active", objective: "x" }) }), []);
	assert.deepEqual(check({ sensor, session: ctx.goalSession({ source: "goal", status: "complete", objective: "x" }) }), []);
	assert.deepEqual(check({ sensor, session: ctx.goalSession(null) }), []);
	assert.deepEqual(check({ sensor, session: ctx.goalSession(undefined, { kind: "child" }) }), []);
	assert.deepEqual(check({ sensor: { ...sensor, idle: false } }), []);
	assert.deepEqual(check({ sensor: { ...sensor, wakeSources: {} } }), []);
	assert.deepEqual(check({ sensor, session: ctx.goalSession(undefined, { pendingCalls: [{ id: "t1", name: "bash", ms: T0 }] }) }), []);
	assert.deepEqual(check({ sensor, config: { goalLiveness: { enabled: false } } }), []);
});

test("composeGoalWake: a bilingual wake that starts a turn and expires in five minutes", () => {
	const message = composeGoalWake({ sessionId: "main1", reason: "leaked-task", now: T0 });
	assert.deepEqual([message.kind, message.deliverAs, message.triggerTurn, message.sessionId], ["wake", "followUp", true, "main1"]);
	assert.equal(message.details.expiresMs, T0 + 300_000);
	assert.match(message.content, /leaked-task/);
	assert.match(message.content, /[가-힣]/);
	assert.match(message.content, /continue/);
});

function engineHarness({ mode = "auto", sensorExtra = {} } = {}) {
	const ctx = setup();
	ctx.writeTask({ task_id: "st_done", status: "completed", parent_session_id: "main1" });
	const clock = createFakeClock(T0);
	const sent = [];
	const session = ctx.goalSession();
	const engine = createEngine({ paths: ctx.paths, config: DEFAULT_CONFIG, clock, mode,
		detectors: [{ name: "goal-liveness", ...goalLiveness }],
		sources: { procs: { snapshot: async () => ({ rows: normalizeRows([hostRow()]), takenAtMs: clock.now() }), async os() { return {}; } },
			registry: { refresh: () => ({ sessions: new Map([[session.id, session]]), tasks: [] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: { sensors: () => new Map([["main1", { sessionId: "main1", pid: 10, ts: clock.now(), idle: true, lastEventAt: clock.now() - 60_000, wakeSources: { "senpi-task": 1 }, holds: [], goalLivenessSchema: 1, ...sensorExtra }]]),
			send(message) { sent.push(message); return "inbox"; }, decide() {}, notifier: { toast: () => ({ ok: true }) } },
		options: { selfPid: 999999, noStatus: false } });
	return { engine, clock, sent };
}

test("engine: a leaked goal wait is woken once through the inbox with triggerTurn true", async () => {
	const h = engineHarness();
	await h.engine.tick();
	h.clock.advance(GRACE - 1);
	await h.engine.tick();
	assert.equal(h.sent.length, 0);
	h.clock.advance(1);
	const result = await h.engine.tick();
	assert.equal(result.results.filter((r) => r.kind === "goal-wake" && r.result === "execute").length, 1);
	assert.equal(h.sent.length, 1);
	const [message] = h.sent;
	assert.deepEqual([message.kind, message.deliverAs, message.triggerTurn, message.sessionId], ["wake", "followUp", true, "main1"]);
	assert.equal(message.details.expiresMs, h.clock.now() + 300_000);
	assert.equal(message.details.reason, "leaked-task");
	for (let i = 0; i < 3; i++) {
		h.clock.advance(60_000);
		await h.engine.tick();
	}
	assert.equal(h.sent.length, 1);
	// Past minWakeGapMs a wait that is still leaked is woken again.
	h.clock.advance(GAP);
	await h.engine.tick();
	assert.equal(h.sent.length, 2);
});

test("engine: shadow mode records would and sends nothing", async () => {
	const h = engineHarness({ mode: "shadow" });
	await h.engine.tick();
	h.clock.advance(GRACE);
	const result = await h.engine.tick();
	assert.ok(result.results.some((r) => r.kind === "goal-wake" && r.result === "would"));
	assert.deepEqual(h.sent, []);
});

const activeTask = (overrides = {}) => ({ taskId: "st_w", name: "worker", status: "running", active: true, terminal: false, lastProgressMs: T0 - MIN, ...overrides });
const waitingRun = (overrides = {}) => ({ runId: "r-w", name: "w", status: "running", settled: false, parentSessionId: "main1", rootSessionId: "main1", lastEventAtMs: T0 - 5 * MIN, lastProgressMs: T0 - 5 * MIN, counts: { total: 3, completed: 1 }, nodes: [{ id: "n1", state: "running", taskId: "st_unknown" }], ...overrides });
const workView = (overrides = {}) => ({ storeReadable: true, runsReadable: true, tasks: [], runs: [], evalLogs: { newestMtimeMs: undefined, count: 0 }, ...overrides });
const quietSensor = (overrides = {}) => ({ holds: ["omo-keepalive"], lastEventAt: T0 - HOUR, goalLivenessSchema: 1, ...overrides });
const backgroundManifest = () => ({ monitors: [], backgroundSessions: [{ id: "b1", command: COMMAND, description: "probe", runtime: { pid: 20, startedAtMs: START } }] });

// The six wakes from decisions 2026-10-17/18/19: no wake while every declared source moved within quietMs.
test("wake 1/2/3/5: fresh child or DAG activity 1-12 min old defers the hourly silent wake", () => {
	const ctx = setup();
	const cases = [
		{ sensor: quietSensor({ wakeSources: { "senpi-task": 1 } }), work: workView({ tasks: [activeTask({ lastProgressMs: T0 - 1 * MIN })] }) },
		{ sensor: quietSensor({ wakeSources: { "senpi-task": 1 } }), work: workView({ tasks: [activeTask({ lastProgressMs: T0 - 4 * MIN - 31_000 })] }) },
		{ sensor: quietSensor({ wakeSources: { "omo-dag": 1 } }), work: workView({ runs: [waitingRun({ lastEventAtMs: T0 - 10 * MIN - 29_000, lastProgressMs: T0 - 10 * MIN - 29_000 })] }) },
		{ sensor: quietSensor({ wakeSources: { "omo-dag": 1 } }), work: workView({ runs: [waitingRun({ lastEventAtMs: T0 - 1 * MIN - 37_000, lastProgressMs: T0 - 1 * MIN - 37_000 })] }) },
	];
	for (const { sensor, work } of cases) assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, work }), {}), []);
});

test("wake 4: an unfolded run wakes with the run, node and task in its evidence", () => {
	const ctx = setup();
	const done = activeTask({ taskId: "st_1", name: "node worker", status: "completed", active: false, terminal: true, terminalAtMs: T0 - 3 * MIN, lastProgressMs: T0 - 3 * MIN });
	const run = waitingRun({ runId: "r-w4", name: "w4", lastEventAtMs: T0 - 3 * MIN, lastProgressMs: T0 - 3 * MIN, nodes: [{ id: "n2", state: "running", taskId: "st_1" }] });
	const found = goalLiveness.detect(ctx.worldAt(0, { sensor: quietSensor({ wakeSources: { "omo-dag": 1 } }), work: workView({ tasks: [done], runs: [run] }) }), {});
	assert.equal(found.length, 1);
	assert.equal(found[0].kind, "goal-wait-stuck");
	assert.equal(found[0].severity, "info");
	assert.equal(found[0].data.reason, "unfolded-workflow");
	assert.equal(found[0].data.question, undefined);
	const evidence = found[0].evidence.join("\n");
	assert.match(evidence, /r-w4/);
	assert.match(evidence, /n2/);
	assert.match(evidence, /st_1/);
	assert.equal(found[0].titleKo, "goal 세션이 반영되지 않은 워크플로를 기다리고 있음");
});

test("wake 6: a live background tree idle 38 min is asked about first (goal-wait-idle warn)", () => {
	const ctx = setup();
	ctx.writeManifestRaw(backgroundManifest());
	const sensor = quietSensor({ wakeSources: { "terminal-background-sessions": 1 } });
	const memory = {};
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(-38 * MIN, { sensor, rows: launcherRows() }), memory), []);
	const found = goalLiveness.detect(ctx.worldAt(0, { sensor, rows: launcherRows() }), memory);
	assert.equal(found.length, 1);
	assert.equal(found[0].kind, "goal-wait-idle");
	assert.equal(found[0].severity, "warn");
	assert.equal(found[0].data.reason, "idle-background");
	assert.deepEqual(found[0].data.remedy, { kind: "goal-wake", reason: "idle-background" });
	assert.equal(found[0].data.sessionKind, "main");
	assert.match(found[0].data.question, /^Is this wait still legitimate/);
	assert.match(found[0].data.question, /Answer with verdict stuck or progressing and cause unknown unless one of the listed causes fits; mechanism and avoid must each be at least 20 characters\.$/);
	assert.equal(found[0].data.sources[0].id, "b1");
	assert.match(found[0].data.sources[0].text, /38 min/);
	assert.match(found[0].evidence.join("\n"), /reason:idle-background/);
	assert.equal(found[0].titleKo, "goal 세션이 멈춘 백그라운드 세션을 기다리고 있음");
});

test("a live command monitor idle 38 min wakes as idle-monitor, not silent", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1")]);
	const sensor = quietSensor({ wakeSources: { "terminal-monitors": 1 } });
	const memory = {};
	goalLiveness.detect(ctx.worldAt(-38 * MIN, { sensor, rows: launcherRows() }), memory);
	const found = goalLiveness.detect(ctx.worldAt(0, { sensor, rows: launcherRows() }), memory);
	assert.deepEqual(reasonsOf(found), ["idle-monitor"]);
	assert.equal(found[0].kind, "goal-wait-idle");
	assert.equal(found[0].severity, "warn");
	assert.equal(found[0].titleKo, "goal 세션이 멈춘 monitor를 기다리고 있음");
	assert.match(found[0].data.sources[0].text, /38 min/);
});

test("mixed sources: a child that progressed 1 min ago defers an idle background wake (38 min idle)", () => {
	const ctx = setup();
	ctx.writeManifestRaw(backgroundManifest());
	const sensor = quietSensor({ wakeSources: { "senpi-task": 1, "terminal-background-sessions": 1 } });
	const work = workView({ tasks: [activeTask({ lastProgressMs: T0 - MIN })] });
	const memory = {};
	goalLiveness.detect(ctx.worldAt(-38 * MIN, { sensor, work, rows: launcherRows() }), memory);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, work, rows: launcherRows() }), memory), []);
});

test("mixed sources: an unfolded run still wakes while another child progresses", () => {
	const ctx = setup();
	const done = activeTask({ taskId: "st_1", status: "completed", active: false, terminal: true, terminalAtMs: T0 - 5 * MIN, lastProgressMs: T0 - 5 * MIN });
	const progressing = activeTask({ taskId: "st_other", lastProgressMs: T0 - MIN });
	const run = waitingRun({ runId: "r-unfolded", lastEventAtMs: T0 - 5 * MIN, lastProgressMs: T0 - 5 * MIN, nodes: [{ id: "n2", state: "running", taskId: "st_1" }] });
	const found = goalLiveness.detect(ctx.worldAt(0, { sensor: quietSensor({ wakeSources: { "senpi-task": 1, "omo-dag": 1 } }), work: workView({ tasks: [done, progressing], runs: [run] }) }), {});
	assert.deepEqual(reasonsOf(found), ["unfolded-workflow"]);
});

test("a non-work-only wait (ask-user) with an old unsettled run gets no workflow wake, only the hourly silent", () => {
	const ctx = setup();
	const run = waitingRun({ lastEventAtMs: T0 - HOUR, lastProgressMs: T0 - HOUR, nodes: [{ id: "n1", state: "pending" }] });
	const sensor = quietSensor({ lastEventAt: T0 - 2 * HOUR, wakeSources: { "ask-user": 1 } });
	const found = goalLiveness.detect(ctx.worldAt(0, { sensor, work: workView({ runs: [run] }) }), {});
	assert.deepEqual(reasonsOf(found), ["silent"]);
});

test("silent still fires when workOf is undefined", () => {
	const ctx = setup();
	const sensor = quietSensor({ lastEventAt: T0 - 2 * HOUR });
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(0, { sensor }), {})), ["silent"]);
});

test("a D8-dead own task suppresses silent: D8's wake-parent owns that child", () => {
	const ctx = setup();
	const dead = activeTask({ taskId: "st_dead", childSessionId: "child1", hostPid: 10, updatedAtMs: undefined, lastProgressMs: T0 - 40 * MIN });
	const child = sessionState({ id: "child1", kind: "child", taskId: "st_dead", parentSessionId: "main1", lastEntryMs: T0 - 40 * MIN, lastMessage: { role: "assistant", stopReason: "length" } });
	const sensor = quietSensor({ lastEventAt: T0 - 2 * HOUR, wakeSources: { "senpi-task": 1 } });
	const work = workView({ tasks: [dead] });
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, work, tasks: [dead], sessions: [child] }), {}), []);
});

test("a wait on the human only keeps the hourly silent even when a stale own task looks D8-dead", () => {
	const ctx = setup();
	const dead = activeTask({ taskId: "st_dead", childSessionId: "child1", hostPid: 10, updatedAtMs: undefined, lastProgressMs: T0 - 40 * MIN });
	const child = sessionState({ id: "child1", kind: "child", taskId: "st_dead", parentSessionId: "main1", lastEntryMs: T0 - 40 * MIN, lastMessage: { role: "assistant", stopReason: "length" } });
	const sensor = quietSensor({ lastEventAt: T0 - 2 * HOUR, wakeSources: { "ask-user": 1 } });
	const work = workView({ tasks: [dead] });
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(0, { sensor, work, tasks: [dead], sessions: [child] }), {})), ["silent"]);
});

test("priority: a leaked monitor wakes before an unfolded workflow after the leak grace", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1")]);
	const done = activeTask({ taskId: "st_1", status: "completed", active: false, terminal: true, terminalAtMs: T0 - 10 * MIN, lastProgressMs: T0 - 10 * MIN });
	const run = waitingRun({ runId: "r-unfolded", lastEventAtMs: T0 - 10 * MIN, lastProgressMs: T0 - 10 * MIN, nodes: [{ id: "n2", state: "running", taskId: "st_1" }] });
	const sensor = quietSensor({ wakeSources: { "terminal-monitors": 1, "omo-dag": 1 } });
	const memory = {};
	const work = workView({ tasks: [done], runs: [run] });
	goalLiveness.detect(ctx.worldAt(0, { sensor, work }), memory);
	assert.deepEqual(reasonsOf(goalLiveness.detect(ctx.worldAt(GRACE, { sensor, work }), memory)), ["leaked-monitor"]);
});

test("persistent monitor never counts as an idle wait", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1", { persistent: true })]);
	const sensor = { lastEventAt: T0 - HOUR, wakeSources: { "terminal-monitors": 1 } };
	const memory = {};
	goalLiveness.detect(ctx.worldAt(-38 * MIN, { sensor, rows: launcherRows() }), memory);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, rows: launcherRows() }), memory), []);
});

test("a session busy for 2 h then idle 1 min with a tree idle for 2 h is not an idle wait", () => {
	const ctx = setup();
	ctx.writeManifest([monitor("m1")]);
	const sensor = quietSensor({ lastEventAt: T0 - MIN, wakeSources: { "terminal-monitors": 1 } });
	const memory = {};
	goalLiveness.detect(ctx.worldAt(-2 * HOUR, { sensor, rows: launcherRows() }), memory);
	assert.deepEqual(goalLiveness.detect(ctx.worldAt(0, { sensor, rows: launcherRows() }), memory), []);
});

test("engine: a daemon restart keeps the D21 wake memory, so a still-leaked wait is woken again after the gap and not before", async () => {
	const h1 = engineHarness();
	await h1.engine.tick();
	h1.clock.advance(GRACE);
	await h1.engine.tick();
	assert.equal(h1.sent.length, 1);
	h1.clock.advance(60_000);
	await h1.engine.tick();
	const snapshot = JSON.parse(JSON.stringify(h1.engine.snapshotState()));
	assert.deepEqual(snapshot.memories.goalLiveness.wakes, { main1: 1 });

	const h2 = engineHarness();
	h2.clock.advance(h1.clock.now() - T0);
	h2.engine.restoreState(snapshot, h2.clock.now());
	await h2.engine.tick();
	h2.clock.advance(GRACE);
	await h2.engine.tick();
	assert.equal(h2.sent.length, 0, "minWakeGapMs still counts from the wake before the restart");
	h2.clock.advance(GAP);
	await h2.engine.tick();
	assert.equal(h2.sent.length, 1);
	assert.equal(h2.sent[0].details.reason, "leaked-task");
});
