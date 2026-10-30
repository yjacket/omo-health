import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { runText, stuckRuns, taskText, trackTrees, treeText, workProgressMs } from "../src/detect/goal-wait.mjs";

const T0 = Date.parse("2026-10-10T10:00:00Z");
const START = T0 - 3600_000;
const MIN = 60_000;
const GRACE = 2 * MIN;
const COMMAND = "node watcher.mjs";

const task = (overrides = {}) => ({ taskId: "st_1", name: "worker", status: "running", active: true, terminal: false, lastProgressMs: T0 - MIN, ...overrides });
const node = (id, state, extra = {}) => ({ id, state, attempt: 0, ...extra });
const run = (overrides = {}) => ({ runId: "r1", name: "w4", status: "running", settled: false, parentSessionId: "main1", rootSessionId: "main1", counts: { total: 3, completed: 1, running: 1, pending: 1, ended: 0 }, lastEventAtMs: T0 - 3 * MIN, lastProgressMs: T0 - 3 * MIN, nodes: [node("n1", "completed"), node("n2", "running", { taskId: "st_1" })], ...overrides });
const work = (overrides = {}) => ({ storeReadable: true, runsReadable: true, tasks: [], runs: [], evalLogs: { newestMtimeMs: undefined, count: 0 }, ...overrides });

test("workProgressMs reads only the categories the sensor declares", () => {
	const data = work({
		tasks: [task({ taskId: "st_active", lastProgressMs: T0 - MIN }), task({ taskId: "st_done", active: false, lastProgressMs: T0 - 10_000 })],
		runs: [run({ lastEventAtMs: T0 - 30_000, lastProgressMs: T0 - 30_000 })],
		evalLogs: { newestMtimeMs: T0 - 5_000, count: 1 },
	});
	const trees = [{ kind: "monitor", activeAtMs: T0 - 20_000 }, { kind: "background", activeAtMs: T0 - 40_000 }];
	assert.equal(workProgressMs(data, { sources: { "senpi-task": 1 }, trees }), T0 - MIN);
	assert.equal(workProgressMs(data, { sources: { "omo-dag": 1 }, trees }), T0 - 30_000);
	assert.equal(workProgressMs(data, { sources: { "terminal-monitors": 1 }, trees }), T0 - 20_000);
	assert.equal(workProgressMs(data, { sources: { "terminal-background-sessions": 1 }, trees }), T0 - 40_000);
	assert.equal(workProgressMs(data, { sources: { "senpi-codemode": 1 }, trees }), T0 - 5_000);
	// Undeclared and unknown categories contribute nothing.
	assert.equal(workProgressMs(data, { sources: { "terminal-monitors": 0, "something-else": 9 }, trees }), undefined);
	assert.equal(workProgressMs(undefined, { sources: { "senpi-task": 1 } }), undefined);
});

test("workProgressMs counts a DAG run's own tasks and the tasks of its running nodes", () => {
	const data = work({
		tasks: [
			task({ taskId: "st_owned", owner: { runId: "r1", nodeId: "n2" }, lastProgressMs: T0 - 40_000 }),
			task({ taskId: "st_node", owner: null, lastProgressMs: T0 - 20_000 }),
			task({ taskId: "st_other", owner: { runId: "r2", nodeId: "x" }, lastProgressMs: T0 - 1_000 }),
		],
		runs: [
			run({ runId: "r1", lastEventAtMs: T0 - 5 * MIN, nodes: [node("n1", "running", { taskId: "st_node" })] }),
			run({ runId: "r2", status: "completed", settled: true, lastEventAtMs: T0, nodes: [] }),
		],
	});
	assert.equal(workProgressMs(data, { sources: { "omo-dag": 1 } }), T0 - 20_000);
});

test("wake 4: a running node whose task completed 3 min ago is unfolded, 1 min ago it is still within the fold grace", () => {
	const data = work({ tasks: [task({ taskId: "st_1", status: "completed", terminal: true, terminalAtMs: T0 - 3 * MIN })], runs: [run()] });
	const found = stuckRuns(data, "main1", T0, GRACE);
	assert.equal(found.length, 1);
	assert.equal(found[0].reason, "unfolded-workflow");
	assert.deepEqual(found[0].unfolded, [{ nodeId: "n2", state: "running", taskId: "st_1", taskStatus: "completed", taskTerminalAtMs: T0 - 3 * MIN }]);
	assert.deepEqual(found[0].waiting, []);
	assert.equal(found[0].runId, "r1");
	assert.equal(found[0].name, "w4");
	assert.deepEqual(found[0].counts, { total: 3, completed: 1, running: 1, pending: 1, ended: 0 });

	const fresh = work({ tasks: [task({ taskId: "st_1", status: "completed", terminal: true, terminalAtMs: T0 - MIN })], runs: [run({ lastEventAtMs: T0 })] });
	assert.deepEqual(stuckRuns(fresh, "main1", T0, GRACE), []);
	// A wider grace also keeps the 3-min-old completion inside the window.
	assert.deepEqual(stuckRuns(data, "main1", T0, 10 * MIN), []);
});

test("a drivable run with only waiting nodes and a stale last event is stalled", () => {
	const data = work({ runs: [run({ status: "running", nodes: [node("n1", "completed"), node("n2", "pending"), node("n3", "blocked")], lastEventAtMs: T0 - 3 * MIN })] });
	const found = stuckRuns(data, "main1", T0, GRACE);
	assert.equal(found.length, 1);
	assert.equal(found[0].reason, "stalled-workflow");
	assert.deepEqual(found[0].waiting, ["n2", "n3"]);
	assert.deepEqual(found[0].unfolded, []);
});

test("a run the user paused with Stop is not stalled; other pauses and older records still are", () => {
	const nodes = [node("n1", "completed"), node("n2", "paused", { taskId: "st_1" }), node("n3", "pending")];
	const paused = (overrides) => work({ runs: [run({ status: "paused", nodes, lastEventAtMs: T0 - 30 * MIN, ...overrides })] });
	assert.deepEqual(stuckRuns(paused({ pauseReason: "user_stop" }), "main1", T0, GRACE), []);
	assert.deepEqual(stuckRuns(paused({}), "main1", T0, GRACE).map((found) => found.reason), ["stalled-workflow"]);
	assert.deepEqual(stuckRuns(paused({ pauseReason: "lease_lost" }), "main1", T0, GRACE).map((found) => found.reason), ["stalled-workflow"]);
});

test("a scheduled node means the run is still being driven and is not stalled", () => {
	const data = work({ runs: [run({ status: "running", nodes: [node("n1", "scheduled")], lastEventAtMs: T0 - 3 * MIN })] });
	assert.deepEqual(stuckRuns(data, "main1", T0, GRACE), []);
});

test("stuckRuns ignores unreadable stores, settled runs and other sessions' runs", () => {
	const nodes = [node("n1", "pending")];
	assert.deepEqual(stuckRuns(work({ storeReadable: false, runs: [run({ nodes })] }), "main1", T0, GRACE), []);
	assert.deepEqual(stuckRuns(work({ runsReadable: false, runs: [run({ nodes })] }), "main1", T0, GRACE), []);
	assert.deepEqual(stuckRuns(work({ runs: [run({ nodes, lastEventAtMs: T0 - 10 * MIN })] }), "someone-else", T0, GRACE), []);
	assert.deepEqual(stuckRuns(work({ runs: [run({ status: "completed", settled: true, nodes, lastEventAtMs: T0 - 10 * MIN })] }), "main1", T0, GRACE), []);
});

const hostRow = (ms = START - 10_000) => ({ p: 10, pp: 0, n: "bun.exe", c: new Date(ms).toISOString(), cl: "bun cli.js" });
const launcherRow = ({ ms = START, cpu = 0, wb = 100, pp = 10 } = {}) => ({ p: 20, pp, n: "bash.exe", c: new Date(ms).toISOString(), cpu, wb, cl: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${COMMAND}"` });
const memberRow = ({ ms = START, cpu = 0, wb = 0 } = {}) => ({ p: 30, pp: 20, n: "node.exe", c: new Date(ms).toISOString(), cpu, wb, cl: COMMAND });
const manifest = (overrides = {}) => ({
	monitors: [{ monitorId: "m1", description: "probe", runtimeKind: "command", command: COMMAND, persistent: false, lastCheckpoint: null, fireWindow: { startMs: START, count: 0 }, runtime: { pid: 20, startedAtMs: START }, ...overrides }],
	backgroundSessions: [],
});

function tracker() {
	const processes = new ProcessTracker();
	return (ms, rows) => processes.update({ takenAtMs: ms, rows: normalizeRows(rows) });
}

test("trackTrees: an idle monitor accumulates idleMs; CPU, writes and a fire-count change each reset it", () => {
	const tableAt = tracker();
	const memory = {};
	let trees = trackTrees({ manifest: manifest(), procs: tableAt(T0, [hostRow(), launcherRow({ cpu: 0, wb: 100 }), memberRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].live, true);
	assert.equal(trees[0].activeAtMs, T0);
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [20, 30]);

	trees = trackTrees({ manifest: manifest(), procs: tableAt(T0 + MIN, [hostRow(), launcherRow({ cpu: 0, wb: 100 }), memberRow()]), procsFresh: true, now: T0 + MIN, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, T0);
	assert.equal(trees[0].idleMs, MIN);

	// A CPU tick.
	trees = trackTrees({ manifest: manifest(), procs: tableAt(T0 + 2 * MIN, [hostRow(), launcherRow({ cpu: 120_000, wb: 100 }), memberRow()]), procsFresh: true, now: T0 + 2 * MIN, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, T0 + 2 * MIN);
	assert.equal(trees[0].idleMs, 0);

	// Writes only.
	trees = trackTrees({ manifest: manifest(), procs: tableAt(T0 + 3 * MIN, [hostRow(), launcherRow({ cpu: 120_000, wb: 900 }), memberRow()]), procsFresh: true, now: T0 + 3 * MIN, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, T0 + 3 * MIN);

	// No process activity, but the monitor fired.
	trees = trackTrees({ manifest: manifest({ fireWindow: { startMs: T0 + 4 * MIN, count: 1 } }), procs: tableAt(T0 + 4 * MIN, [hostRow(), launcherRow({ cpu: 120_000, wb: 900 }), memberRow()]), procsFresh: true, now: T0 + 4 * MIN, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, T0 + 4 * MIN);
});

test("trackTrees: a stale process table never marks a tree active", () => {
	const tableAt = tracker();
	const memory = {};
	tableAt(T0, [hostRow(), launcherRow(), memberRow()]);
	const first = trackTrees({ manifest: manifest(), procs: tableAt(T0, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(first[0].activeAtMs, T0);
	tableAt(T0 + MIN, [hostRow(), launcherRow({ cpu: 120_000, wb: 100 }), memberRow()]);
	const stale = trackTrees({ manifest: manifest(), procs: tableAt(T0 + MIN, [hostRow(), launcherRow({ cpu: 120_000, wb: 100 }), memberRow()]), procsFresh: false, now: T0 + MIN, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(stale[0].live, true);
	assert.equal(stale[0].activeAtMs, T0);
	assert.equal(stale[0].idleMs, MIN);
});

test("trackTrees: a dead launcher is not live, and sessions own their memory keys", () => {
	const tableAt = tracker();
	const memory = {};
	tableAt(T0, [hostRow(), memberRow()]);
	const trees = trackTrees({ manifest: manifest(), procs: tableAt(T0, [hostRow(), memberRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees.length, 1);
	assert.equal(trees[0].live, false);
	// The orphaned member is still reported; only a launcher under its host makes the tree live.
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [30]);

	// A launcher that exists but whose parent is absent is not live either.
	const parentGone = trackTrees({ manifest: manifest(), procs: tableAt(T0, [hostRow(), launcherRow({ pp: 99 })]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(parentGone[0].live, false);
	assert.deepEqual(parentGone[0].members.map((proc) => proc.pid), [20]);

	memory["other:monitor:m9"] = { activeAtMs: T0, sig: "x" };
	trackTrees({ manifest: manifest(), procs: tableAt(T0, [hostRow(), memberRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.ok(memory["other:monitor:m9"]);
	trackTrees({ manifest: { monitors: [], backgroundSessions: [] }, procs: tableAt(T0, [hostRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.deepEqual(Object.keys(memory), ["other:monitor:m9"]);
});

test("a background session whose launcher runs under a live parent is live: true", () => {
	const tableAt = tracker();
	const memory = {};
	const background = { id: "b1", command: COMMAND, startedAtMs: START, runtime: { pid: 20, startedAtMs: START } };
	const trees = trackTrees({ manifest: { monitors: [], backgroundSessions: [background] }, procs: tableAt(T0, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: T0, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees.length, 1);
	assert.equal(trees[0].kind, "background");
	assert.equal(trees[0].id, "b1");
	assert.equal(trees[0].live, true);
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [20, 30]);
	assert.equal(memory["main1:background:b1"].activeAtMs, T0);
});

const workerRow = ({ ms = START + 60_000, cpu = 0, wb = 0 } = {}) => ({ p: 40, pp: 30, n: "node.exe", c: new Date(ms).toISOString(), cpu, wb, cl: "node worker.mjs" });

test("a worker spawned 60 s after launch that burns CPU keeps the tree active", () => {
	const tableAt = tracker();
	const memory = {};
	let trees = trackTrees({ manifest: manifest(), procs: tableAt(START + 30_000, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: START + 30_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [20, 30]);
	assert.equal(trees[0].activeAtMs, START + 30_000);

	// The worker is born outside watcherMembers' launch window, but it descends from a live member.
	trees = trackTrees({ manifest: manifest(), procs: tableAt(START + 60_000, [hostRow(), launcherRow(), memberRow(), workerRow({ cpu: 0 })]), procsFresh: true, now: START + 60_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [20, 30, 40]);
	assert.equal(trees[0].activeAtMs, START + 60_000);

	trees = trackTrees({ manifest: manifest(), procs: tableAt(START + 90_000, [hostRow(), launcherRow(), memberRow(), workerRow({ cpu: 120_000 })]), procsFresh: true, now: START + 90_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, START + 90_000);
	assert.equal(trees[0].idleMs, 0);
});

test("when that worker exits and nothing else moves, idleMs grows again", () => {
	const tableAt = tracker();
	const memory = {};
	trackTrees({ manifest: manifest(), procs: tableAt(START + 30_000, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: START + 30_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	trackTrees({ manifest: manifest(), procs: tableAt(START + 60_000, [hostRow(), launcherRow(), memberRow(), workerRow({ cpu: 0 })]), procsFresh: true, now: START + 60_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	trackTrees({ manifest: manifest(), procs: tableAt(START + 90_000, [hostRow(), launcherRow(), memberRow(), workerRow({ cpu: 120_000 })]), procsFresh: true, now: START + 90_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });

	// The exit changes the tree's pid set, which counts as activity for one tick.
	let trees = trackTrees({ manifest: manifest(), procs: tableAt(START + 120_000, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: START + 120_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.deepEqual(trees[0].members.map((proc) => proc.pid), [20, 30]);
	assert.equal(trees[0].activeAtMs, START + 120_000);

	trees = trackTrees({ manifest: manifest(), procs: tableAt(START + 150_000, [hostRow(), launcherRow(), memberRow()]), procsFresh: true, now: START + 150_000, memory, sessionId: "main1", cpuIdleFrac: 0.02 });
	assert.equal(trees[0].activeAtMs, START + 120_000);
	assert.equal(trees[0].idleMs, 30_000);
});

test("runText and treeText spell the evidence exactly", () => {
	const unfolded = { runId: "r1", name: "w4", status: "running", reason: "unfolded-workflow", counts: { total: 5, completed: 2 }, lastEventAtMs: T0 - 3 * MIN,
		unfolded: [{ nodeId: "n2", state: "running", taskId: "st_9", taskStatus: "completed", taskTerminalAtMs: T0 - 3 * MIN }], waiting: ["n3", "n4"] };
	assert.equal(runText(unfolded, T0),
		`workflow run r1 "w4" (running, 2/5 nodes done, last run event ${new Date(T0 - 3 * MIN).toISOString()} (3 min ago)): node n2 is running but its task st_9 completed at ${new Date(T0 - 3 * MIN).toISOString()} - the completion was never folded into the run; waiting nodes: n3, n4.`);

	const stalled = { runId: "r2", name: "w5", status: "running", reason: "stalled-workflow", counts: { total: 3, completed: 1 }, lastEventAtMs: T0 - 7 * MIN, unfolded: [], waiting: ["n2", "n3"] };
	assert.equal(runText(stalled, T0),
		`workflow run r2 "w5" (running, 1/3 nodes done, last run event ${new Date(T0 - 7 * MIN).toISOString()} (7 min ago)): nothing is running or scheduled while n2, n3 wait - the run's scheduler is not driving it.`);

	const slow = `node ${"x".repeat(200)}`;
	assert.equal(treeText({ kind: "monitor", id: "m1", command: slow, idleMs: 7 * MIN, members: [{ pid: 20 }, { pid: 30 }] }),
		`monitor m1 ${slow.slice(0, 120)}: process 20 (with 1 more) is alive but used no CPU, wrote nothing and fired nothing for 7 min; a command monitor reports only when its command exits.`);
	assert.equal(treeText({ kind: "background", id: "b1", command: COMMAND, idleMs: 3 * MIN, members: [{ pid: 20 }] }),
		"background session b1 node watcher.mjs: process 20 is alive but used no CPU and wrote nothing for 3 min.");
});

test("taskText names the task, its status and its last progress", () => {
	assert.equal(taskText({ taskId: "st_1", name: "worker", status: "running", lastProgressMs: T0 - 12 * MIN }, T0),
		`task st_1 "worker" running, last progress ${new Date(T0 - 12 * MIN).toISOString()} (12 min ago).`);
});

test("taskText prints unknown when last progress is missing", () => {
	assert.equal(taskText({ taskId: "st_1", name: "worker", status: "running", lastProgressMs: undefined }, T0),
		"task st_1 \"worker\" running, last progress unknown.");
});

test("runText on a live run names its running and waiting nodes and never calls it stalled", () => {
	const live = run({ nodes: [node("n1", "completed"), node("n2", "running", { taskId: "st_1" }), node("n3", "pending")] });
	const text = runText({ ...live, reason: "active" }, T0);
	assert.doesNotMatch(text, /nothing is running|not driving/);
	assert.equal(text, `workflow run r1 "w4" (running, 1/3 nodes done, last run event ${new Date(T0 - 3 * MIN).toISOString()} (3 min ago)): running nodes: n2; waiting nodes: n3.`);
});

test("runText prints unknown when the last run event is missing", () => {
	const stalled = { runId: "r2", name: "w5", status: "running", reason: "stalled-workflow", counts: { total: 2, completed: 1 }, lastEventAtMs: undefined, unfolded: [], waiting: ["n2"] };
	assert.equal(runText(stalled, T0),
		'workflow run r2 "w5" (running, 1/2 nodes done, last run event unknown): nothing is running or scheduled while n2 wait - the run\'s scheduler is not driving it.');
});
