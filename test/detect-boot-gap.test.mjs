import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as bootGap from "../src/detect/boot-gap.mjs";
import { makeWorld, raw, sessionState } from "./helpers/world.mjs";

const MIN = 60_000;
const UP = Date.parse("2026-09-23T16:00:00Z");
const DOWN = UP - 40 * MIN;
const NOW = UP + 3 * MIN;
const HOST_PID = 5000;
const iso = (ms) => new Date(ms).toISOString();

const downtime = { kind: "reboot", downSinceMs: DOWN, upAtMs: UP, bootMs: UP - 20 * MIN };

function lostTask(partial = {}) {
	return {
		taskId: "st_new",
		name: "subagent",
		status: "running",
		active: true,
		createdAtMs: DOWN - 10 * MIN,
		lastProgressMs: DOWN - 5 * MIN,
		hostPid: 6000,
		...partial,
	};
}

function run(partial = {}) {
	return {
		runId: "r1",
		name: "dag-run",
		status: "running",
		settled: false,
		parentSessionId: "s1",
		createdAtMs: DOWN - 8 * MIN,
		lastProgressMs: DOWN - 4 * MIN,
		lastEventAtMs: DOWN - 4 * MIN,
		counts: { total: 3, completed: 1, running: 1, pending: 1, ended: 0 },
		nodes: [{ id: "n1", state: "running", attempt: 1, taskId: "st_new", startedAtMs: DOWN - 8 * MIN }],
		...partial,
	};
}

function work(partial = {}) {
	return { storeReadable: true, tasks: [lostTask()], runs: [run()], ...partial };
}

/** A session already observed live for longer than settleMs. */
function settledMemory(now = NOW) {
	return { firstLive: { [`s1@${DOWN}`]: now - 10 * MIN } };
}

function makeBootWorld(options = {}) {
	const now = options.now ?? NOW;
	const sessions = options.sessions ?? [sessionState({ id: "s1", kind: "main" })];
	return makeWorld({
		now,
		config: options.config,
		sessions,
		sensors: options.sensors ?? [{ sessionId: "s1", pid: HOST_PID, ts: now, idle: true }],
		procSnapshots: options.rows ? [{ takenAtMs: now, rows: options.rows }] : [{ takenAtMs: now, rows: [raw(HOST_PID, 1, "node.exe", iso(UP + 30_000))] }],
		procsFresh: options.procsFresh,
		self: options.self,
		downtime: options.downtime ?? downtime,
		workOf: options.workOf ?? (() => work()),
	});
}

test("D23: the wake-4 shape yields one finding with the lost subagent and workflow run", () => {
	const [finding, ...rest] = bootGap.detect(makeBootWorld(), settledMemory());
	assert.equal(rest.length, 0);
	assert.equal(finding.detector, "D23");
	assert.equal(finding.kind, "work-lost");
	assert.equal(finding.severity, "info");
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.subject.key, `gap:${DOWN}`);
	assert.deepEqual(finding.evidence, [`gap:reboot:${iso(DOWN)}..${iso(UP)}`, "task:st_new:running:host=6000", "run:r1:running:1/3"]);
	assert.equal(finding.titleKo, "중단 전 작업이 이어지지 않음: 서브에이전트 1개, 워크플로 1개");
	assert.match(finding.detailKo, /중단.*한 번만/);
	assert.equal(finding.data.goalActive, false);
	assert.equal(finding.data.idle, true);
	assert.deepEqual(finding.data.tasks, [{ taskId: "st_new", name: "subagent", status: "running", createdAtMs: DOWN - 10 * MIN, lastProgressMs: DOWN - 5 * MIN, hostPid: 6000 }]);
	assert.deepEqual(finding.data.runs[0].nodes, [{ id: "n1", state: "running", attempt: 1, taskId: "st_new" }]);
	assert.deepEqual(finding.data.remedy, { kind: "boot-notice" });
});

test("D23: a task that progressed after the gap is not listed as lost", () => {
	const world = makeBootWorld({ workOf: () => work({ tasks: [lostTask({ lastProgressMs: UP + MIN })], runs: [] }) });
	assert.deepEqual(bootGap.detect(world, {}), []);
});

test("D23: a task last updated a day before the gap is not listed", () => {
	const tasks = [lostTask({ lastProgressMs: DOWN - 24 * 60 * MIN })];
	assert.deepEqual(bootGap.detect(makeBootWorld({ workOf: () => work({ tasks, runs: [] }) }), settledMemory()), []);
});

test("D23: a workflow run last active a day before the gap is not listed; one without a progress time counts as stale", () => {
	const stale = [run({ lastProgressMs: DOWN - 24 * 60 * MIN, lastEventAtMs: DOWN - 24 * 60 * MIN })];
	assert.deepEqual(bootGap.detect(makeBootWorld({ workOf: () => work({ tasks: [], runs: stale }) }), settledMemory()), []);
	const unknown = [run({ lastProgressMs: undefined, lastEventAtMs: undefined })];
	assert.deepEqual(bootGap.detect(makeBootWorld({ workOf: () => work({ tasks: [], runs: unknown }) }), settledMemory()), []);
	assert.equal(bootGap.detect(makeBootWorld({ workOf: () => work({ tasks: [], runs: [run()] }) }), settledMemory()).length, 1, "the same run active just before the gap is listed");
});

test("D23: a task with no last progress time counts as stale", () => {
	const tasks = [lostTask({ lastProgressMs: undefined })];
	assert.deepEqual(bootGap.detect(makeBootWorld({ workOf: () => work({ tasks, runs: [] }) }), settledMemory()), []);
});

test("D23: a session whose host started before the gap never went down and yields nothing", () => {
	const rows = [raw(HOST_PID, 1, "node.exe", iso(DOWN - 60 * MIN))];
	assert.deepEqual(bootGap.detect(makeBootWorld({ rows }), {}), []);
});

test("D23: nothing is reported before settleMs and the same memory reports once settleMs passes", () => {
	const memory = {};
	const early = makeBootWorld({ now: UP + MIN, workOf: () => work({ tasks: [lostTask({ lastProgressMs: DOWN - 5 * MIN })], runs: [] }) });
	assert.deepEqual(bootGap.detect(early, memory), []);
	assert.equal(memory.firstLive[`s1@${DOWN}`], UP + MIN);
	const later = makeBootWorld({ now: UP + 3 * MIN });
	assert.equal(bootGap.detect(later, memory).length, 1);
});

test("D23: a noticed session is suppressed", () => {
	const memory = { firstLive: { [`s1@${DOWN}`]: NOW - 10 * MIN }, noticed: { [`s1@${DOWN}`]: true } };
	assert.deepEqual(bootGap.detect(makeBootWorld(), memory), []);
});

test("D23: no gap, a gap outside the window, or a stale process table yields nothing", () => {
	assert.deepEqual(bootGap.detect(makeBootWorld({ downtime: { kind: "none" } }), {}), []);
	assert.deepEqual(bootGap.detect(makeBootWorld({ downtime: { ...downtime, upAtMs: UP - 25 * 60 * MIN } }), {}), []);
	assert.deepEqual(bootGap.detect(makeBootWorld({ procsFresh: false }), {}), []);
});

test("D23: history mode yields nothing", () => {
	assert.deepEqual(bootGap.detect(makeBootWorld({ self: { pid: 1, mode: "history" } }), {}), []);
});

test("D23: an unreadable work store and a session without cwd yield nothing", () => {
	assert.deepEqual(bootGap.detect(makeBootWorld({ workOf: () => work({ storeReadable: false }) }), {}), []);
	const noCwd = makeBootWorld({ sessions: [{ ...sessionState({ id: "s1", kind: "main" }), cwd: "" }], workOf: () => work() });
	assert.deepEqual(bootGap.detect(noCwd, {}), []);
});

test("D23: only main sessions are considered", () => {
	const sessions = [sessionState({ id: "s1", kind: "child", parentSessionId: "p1" })];
	assert.deepEqual(bootGap.detect(makeBootWorld({ sessions }), {}), []);
});

test("D23: a lost task host that is still alive since before the gap is not a lost task", () => {
	const rows = [raw(HOST_PID, 1, "node.exe", iso(UP + 30_000)), raw(7001, 1, "node.exe", iso(DOWN - 5 * MIN))];
	const world = makeBootWorld({ rows, workOf: () => work({ tasks: [lostTask({ hostPid: 7001 })], runs: [] }) });
	assert.deepEqual(bootGap.detect(world, {}), []);
});

test("D23: a task host pid reused after the gap counts as gone", () => {
	const rows = [raw(HOST_PID, 1, "node.exe", iso(UP + 30_000)), raw(7002, 1, "node.exe", iso(UP + 45_000))];
	const [finding] = bootGap.detect(makeBootWorld({ rows, workOf: () => work({ tasks: [lostTask({ hostPid: 7002 })], runs: [] }) }), settledMemory());
	assert.equal(finding.data.tasks.length, 1);
	assert.match(finding.evidence.join(","), /task:st_new:running:host=7002/);
});

test("D23: evidence is capped at 20 lines while data keeps every lost task", () => {
	const tasks = Array.from({ length: 25 }, (_, i) => lostTask({ taskId: `st_${i}` }));
	const [finding] = bootGap.detect(makeBootWorld({ workOf: () => work({ tasks, runs: [] }) }), settledMemory());
	assert.equal(finding.evidence.length, 20);
	assert.equal(finding.data.tasks.length, 25);
});

test("D23: memory keys from an older gap are pruned", () => {
	const memory = { firstLive: { "s1@1": NOW }, noticed: { "s1@1": true } };
	bootGap.detect(makeBootWorld(), memory);
	assert.equal(memory.firstLive["s1@1"], undefined);
	assert.equal(memory.noticed["s1@1"], undefined);
	assert.equal(memory.firstLive[`s1@${DOWN}`], NOW, "the current gap is remembered");
});

test("D23: goalActive and idle describe the session state in data", () => {
	const sessions = [{ ...sessionState({ id: "s1", kind: "main" }), anchor: { source: "goal", status: "active" } }];
	const sensors = [{ sessionId: "s1", pid: HOST_PID, ts: NOW, idle: false }];
	const [finding] = bootGap.detect(makeBootWorld({ sessions, sensors }), settledMemory());
	assert.equal(finding.data.goalActive, true);
	assert.equal(finding.data.idle, false);
});
