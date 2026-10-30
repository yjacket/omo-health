import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, senpiEvidence, unfinishedWork } from "../src/detect/crashes.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T0 = Date.parse("2026-09-29T11:50:00Z");
const SID = "01a0ecf7-4a3c-7adf-882e-1379e297f5ce";
const HOST = 32528;
const TERMINAL = { kind: "herdr", workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1" };
const OTHER = raw(1, 0, "System", "2026-09-29T00:00:00Z");
const hostRow = (pid = HOST) => raw(pid, 1, "bun.exe", "2026-09-29T11:40:00Z", 0, 0, "bun C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js");

function heartbeat(over = {}) {
	return { v: 1, pid: HOST, sessionId: SID, sessionFile: "C:/s/x.jsonl", cwd: "C:\\dev\\omo\\omo-health-refl", kind: "interactive", idle: true, pending: false, executingTools: 0, hasUI: true, terminal: TERMINAL, ts: T0, ...over };
}

function world({ now, hb = heartbeat({ idle: false, executingTools: 1 }), alive = false, session = { ...sessionState({ id: SID }), todoState: { open: 2, total: 5 } }, tasks = [], crashRecords = [], liveMarkers = new Map(), dagRuns, config, sensors = [], procsFresh } = {}) {
	return makeWorld({
		now,
		config,
		sessions: session ? [session] : [],
		tasks,
		sensors,
		procsFresh,
		procSnapshots: [{ takenAtMs: now, rows: alive ? [OTHER, hostRow()] : [OTHER] }],
		hostExits: { heartbeats: hb ? [{ hb, file: `C:/h/sensors/${SID}.json`, mtimeMs: hb.ts, dagRuns }] : [], crashRecords, liveMarkers },
	});
}

/** One tick with the host alive and its heartbeat fresh, then the tick that finds it dead. */
function observedCrash(memory, options = {}) {
	detect(world({ now: T0 + 5_000, alive: true, ...options }), memory);
	return detect(world({ now: T0 + 40_000, ...options }), memory);
}

const crashOf = (findings) => findings.find((f) => f.kind === "host-crash");

test("a host seen alive that dies with unfinished work is a crash to resume in a new tab", () => {
	const memory = {};
	const findings = observedCrash(memory);
	const crash = crashOf(findings);
	assert.equal(crash.detector, "D18");
	assert.equal(crash.severity, "info");
	assert.equal(crash.subject.sessionId, SID);
	assert.equal(crash.data.outcome, "resume");
	assert.deepEqual(crash.data.remedy, { kind: "crash-resume" });
	assert.deepEqual(crash.data.reasons, ["turn", "todos"]);
	assert.equal(crash.data.observed, true);
	assert.deepEqual(crash.data.terminal, TERMINAL);
	assert.equal(findings.some((f) => f.humanNeeded), false);
});

test("an idle crash is only recorded and cleaned up", () => {
	const findings = observedCrash({}, { session: sessionState({ id: SID }), hb: heartbeat() });
	assert.equal(crashOf(findings).data.outcome, "idle");
	assert.deepEqual(crashOf(findings).data.remedy, { kind: "crash-cleanup" });
	assert.equal(findings.some((f) => f.humanNeeded), false);
});

test("open todos without a turn or an active goal (a goal already achieved) are only recorded; an active goal alone is enough", () => {
	const achieved = { ...sessionState({ id: SID }), anchor: { source: "goal", status: "complete" }, todoState: { open: 3, total: 5 } };
	const done = crashOf(observedCrash({}, { hb: heartbeat(), session: achieved }));
	assert.equal(done.data.outcome, "idle");
	assert.deepEqual(done.data.reasons, ["todos"]);
	const active = { ...sessionState({ id: SID }), anchor: { source: "goal", status: "active" } };
	assert.equal(crashOf(observedCrash({}, { hb: heartbeat(), session: active })).data.outcome, "resume");
	const ulw = { ...sessionState({ id: SID }), anchor: { source: "ulw", status: "active" } };
	assert.equal(crashOf(observedCrash({}, { hb: heartbeat(), session: ulw })).data.outcome, "resume");
});

test("a session someone already carries on in the same cwd is not resumed", () => {
	const cwd = "C:\\dev\\omo\\omo-health-refl";
	const liveOther = { hb: { sessionId: "01a0ed3a-2cd8-78d6-a043-d995672e9771", pid: 6000, cwd: `${cwd}\\`, ts: T0 + 35_000 } };
	const withLive = (now, alive) => {
		const w = world({ now, alive });
		w.hostExits.heartbeats.push(liveOther);
		return w;
	};
	const memory = {};
	detect(withLive(T0 + 5_000, true), memory);
	const rows = makeWorld({ now: T0 + 40_000, sessions: [{ ...sessionState({ id: SID }), todoState: { open: 1 } }], procSnapshots: [{ takenAtMs: T0 + 40_000, rows: [OTHER, hostRow(6000)] }], hostExits: { heartbeats: [{ hb: heartbeat({ idle: false }) }, liveOther], crashRecords: [], liveMarkers: new Map() } });
	const live = crashOf(detect(rows, memory));
	assert.equal(live.data.outcome, "taken-over");
	assert.equal(live.data.takenOver, liveOther.hb.sessionId);
	assert.deepEqual(live.data.remedy, { kind: "crash-cleanup" });
	const newer = { ...sessionState({ id: "01a0ed3a-new", cwd: "c:/dev/omo/omo-health-refl", kind: "main" }), lastEntryMs: T0 + 30_000 };
	const older = { ...sessionState({ id: "01a0ed3a-old", cwd, kind: "main" }), lastEntryMs: T0 - 60_000 };
	const elsewhere = { ...sessionState({ id: "01a0ed3a-else", cwd: "C:\\dev\\other", kind: "main" }), lastEntryMs: T0 + 30_000 };
	const crashed = { ...sessionState({ id: SID }), todoState: { open: 1 } };
	const byFile = (sessions) => {
		const m = {};
		detect(world({ now: T0 + 5_000, alive: true }), m);
		return crashOf(detect(makeWorld({ now: T0 + 40_000, sessions: [crashed, ...sessions], procSnapshots: [{ takenAtMs: T0 + 40_000, rows: [OTHER] }], hostExits: { heartbeats: [{ hb: heartbeat({ idle: false }) }], crashRecords: [], liveMarkers: new Map() } }), m));
	};
	assert.equal(byFile([newer]).data.outcome, "taken-over", "a session file in the same cwd written after the crash");
	assert.equal(byFile([older, elsewhere]).data.outcome, "resume", "an older session there, or a newer one elsewhere, is no takeover");
});

test("a heartbeat without proof that it stopped with its host (switched-away session) is only recorded", () => {
	const findings = detect(world({ now: T0 + 40_000 }), {});
	assert.equal(crashOf(findings).data.outcome, "unconfirmed");
	assert.deepEqual(crashOf(findings).data.remedy, { kind: "crash-cleanup" });
});

test("senpi's live marker or crash record confirms a crash only when it was touched right before the heartbeat stopped", () => {
	const hb = heartbeat();
	assert.equal(senpiEvidence({ liveMarkers: new Map([[HOST, { mtimeMs: T0 - 30_000 }]]), crashRecords: [] }, hb), "live-marker");
	assert.equal(senpiEvidence({ liveMarkers: new Map([[HOST, { mtimeMs: T0 + 2 * 3600_000 }]]), crashRecords: [] }, hb), undefined, "the host lived on for hours after this heartbeat stopped");
	assert.equal(senpiEvidence({ liveMarkers: new Map(), crashRecords: [{ atMs: T0 - 21_000, kind: "interactive", detection: "unclean_exit" }] }, hb), "crash-record");
	assert.equal(senpiEvidence({ liveMarkers: new Map(), crashRecords: [{ atMs: T0 - 5 * 60_000, kind: "interactive", detection: "unclean_exit" }] }, hb), undefined);
	const confirmed = detect(world({ now: T0 + 40_000, liveMarkers: new Map([[HOST, { mtimeMs: T0 - 30_000 }]]) }), {});
	assert.equal(crashOf(confirmed).data.outcome, "resume");
	assert.equal(crashOf(confirmed).data.senpi, "live-marker");
});

test("unfinished work: turn, goal, ulw, todos, subagents and workflow runs; finished ones do not count", () => {
	const w = makeWorld({ now: T0, tasks: [taskRecord({ taskId: "st_a", parentSessionId: SID, rootSessionId: SID }), taskRecord({ taskId: "st_done", status: "completed", parentSessionId: SID })] });
	const all = unfinishedWork(
		w,
		heartbeat({ idle: false }),
		{ anchor: { source: "goal", status: "active" }, todoState: { open: 1 }, pending: new Map() },
		[{ runId: "r1", status: "paused", rootSessionId: SID }, { runId: "r2", status: "completed", rootSessionId: SID }],
	);
	assert.deepEqual(all, { reasons: ["turn", "goal", "todos", "subagents", "workflow"], lostTasks: ["st_a"] });
	assert.deepEqual(unfinishedWork(makeWorld({ now: T0 }), heartbeat(), { anchor: { source: "ulw", status: "active" } }).reasons, ["ulw"]);
	assert.deepEqual(unfinishedWork(makeWorld({ now: T0 }), heartbeat(), { activity: { lastTodo: { open: 3 } } }).reasons, ["todos"], "the last todo tool result when no todo-state entry was read");
	const none = unfinishedWork(makeWorld({ now: T0 }), heartbeat(), { anchor: { source: "goal", status: "complete" }, todoState: { open: 0 }, activity: { lastTodo: { open: 4 } } }, [{ status: "failed", rootSessionId: SID }]);
	assert.deepEqual(none, { reasons: [], lostTasks: [] }, "the todo-state entry outranks an older todo tool result");
});

test("a second crash of the same session within the loop window stops recovery with one human-needed finding", () => {
	const memory = {};
	assert.equal(crashOf(observedCrash(memory)).data.outcome, "resume");
	const later = T0 + 20 * 60_000;
	const hb = heartbeat({ pid: 4444, ts: later, idle: false });
	detect(world({ now: later + 5_000, hb, alive: false, config: {} }), memory);
	memory.alive[SID] = { pid: 4444, atMs: later + 5_000 };
	const findings = detect(world({ now: later + 40_000, hb }), memory);
	assert.equal(crashOf(findings).data.outcome, "crash-loop");
	assert.deepEqual(crashOf(findings).data.remedy, { kind: "crash-cleanup" });
	const stopped = findings.find((f) => f.kind === "host-crash-stopped");
	assert.equal(stopped.humanNeeded, true);
	assert.equal(stopped.data.reason, "crash-loop");
	assert.equal(stopped.data.toastTag, `crash-stop-${SID}`);
	assert.match(stopped.detailKo.split("\n")[0], /omo-health-refl .*omo --session 01a0ecf7/);
});

test("the resume rate limit, a disabled resume switch and a session outside herdr stop recovery", () => {
	const limited = { resumes: { [SID]: [T0 - 20 * 60_000, T0 - 10 * 60_000] } };
	assert.equal(crashOf(observedCrash(limited)).data.outcome, "rate-limit");
	const off = observedCrash({}, { config: { actions: { resume: false } } });
	assert.equal(crashOf(off).data.outcome, "resume-off");
	const outside = observedCrash({}, { hb: heartbeat({ terminal: undefined, idle: false }) });
	assert.equal(crashOf(outside).data.outcome, "no-terminal");
	assert.equal(outside.find((f) => f.kind === "host-crash-stopped").data.reason, "no-terminal");
	assert.equal(crashOf(observedCrash({}, { hb: heartbeat({ hasUI: false }) })).data.outcome, "not-interactive");
});

test("the decision is made once: later ticks keep the outcome", () => {
	const memory = {};
	const first = crashOf(observedCrash(memory));
	const again = crashOf(detect(world({ now: T0 + 5 * 60_000 }), memory));
	assert.equal(again.fp, first.fp);
	assert.equal(again.data.outcome, "resume");
	assert.deepEqual(memory.crashes[SID], [T0], "counted once");
});

test("nothing is judged dead from a stale process table, a live pid or a heartbeat only a few seconds old", () => {
	assert.deepEqual(detect(world({ now: T0 + 40_000, procsFresh: false }), {}), []);
	assert.deepEqual(detect(world({ now: T0 + 3600_000, alive: true }), {}), [], "a live host with an old heartbeat is not a crash");
	assert.deepEqual(detect(world({ now: T0 + 20_000 }), {}), [], "3 missed beats first");
});

test("leftover heartbeats first seen after maxAgeMs are never resumed, even with a senpi trace, and are cleaned in one quiet batch", () => {
	const install = world({ now: T0 + 11 * 60_000, liveMarkers: new Map([[HOST, { mtimeMs: T0 - 30_000 }]]) });
	for (let i = 1; i <= 38; i++) install.hostExits.heartbeats.push({ hb: heartbeat({ sessionId: `old-${i}`, pid: 70_000 + i, ts: T0 - i * 3600_000, idle: false }) });
	const batch = detect(install, {});
	assert.equal(crashOf(batch), undefined);
	assert.equal(batch.length, 1);
	assert.equal(batch[0].data.heartbeats.length, 39);
	const findings = detect(world({ now: T0 + 11 * 60_000 }), {});
	assert.equal(crashOf(findings), undefined);
	const stale = findings.find((f) => f.kind === "stale-heartbeats");
	assert.equal(stale.severity, "info");
	assert.equal(stale.subject.sessionId, undefined);
	assert.deepEqual(stale.data.heartbeats, [{ sessionId: SID, pid: HOST, ts: T0 }]);
	assert.deepEqual(stale.data.remedy, { kind: "crash-cleanup" });
});

test("a launched resume gets its notice once the new sensor is up, or stops when it never comes", () => {
	const pending = { crashPid: HOST, crashTs: T0, launchedMs: T0 + 60_000, cwd: "C:\\dev\\x", tabId: "wA:t9", lostTasks: ["st_a"] };
	const up = { pending: { [SID]: { ...pending } } };
	const resumed = detect(world({ now: T0 + 90_000, hb: null, sensors: [{ sessionId: SID, pid: 9001, ts: T0 + 85_000, idle: false }] }), up);
	const notice = resumed.find((f) => f.kind === "host-resumed");
	assert.deepEqual(notice.data.remedy, { kind: "crash-notice" });
	assert.equal(notice.data.idle, false);
	assert.deepEqual(notice.data.lostTasks, ["st_a"]);
	const oldSensor = detect(world({ now: T0 + 90_000, hb: null, sensors: [{ sessionId: SID, pid: HOST, ts: T0 + 85_000 }] }), { pending: { [SID]: { ...pending } } });
	assert.equal(oldSensor.some((f) => f.kind === "host-resumed"), false, "the crashed host's own heartbeat is not the new sensor");
	const never = { pending: { [SID]: { ...pending } } };
	const late = detect(world({ now: T0 + 60_000 + 3 * 60_000 + 1, hb: null }), never);
	assert.equal(never.pending[SID], undefined);
	assert.equal(late.find((f) => f.kind === "host-crash-stopped").data.reason, "no-new-sensor");
});

test("#109: a sensor that reports lastAgentStartAt counts as resumed only after a run started since the launch", () => {
	const pending = { crashPid: HOST, crashTs: T0, launchedMs: T0 + 60_000, cwd: "C:\\dev\\x", tabId: "wA:t9", lostTasks: [] };
	const sensor = (over) => [{ sessionId: SID, pid: 9001, ts: T0 + 85_000, idle: true, ...over }];
	const held = { pending: { [SID]: { ...pending } } };
	assert.deepEqual(detect(world({ now: T0 + 90_000, hb: null, sensors: sensor({ lastAgentStartAt: null }) }), held), [], "held: no notice yet");
	assert.ok(held.pending[SID], "still waiting for the run");
	const before = detect(world({ now: T0 + 90_000, hb: null, sensors: sensor({ lastAgentStartAt: T0 + 59_000 }) }), { pending: { [SID]: { ...pending } } });
	assert.equal(before.some((f) => f.kind === "host-resumed"), false, "a run from before the launch does not count");
	const ran = detect(world({ now: T0 + 90_000, hb: null, sensors: sensor({ lastAgentStartAt: T0 + 70_000 }) }), { pending: { [SID]: { ...pending } } });
	assert.equal(ran.find((f) => f.kind === "host-resumed").data.idle, true, "a run that already ended still counts");
	const late = detect(world({ now: T0 + 60_000 + 3 * 60_000 + 1, hb: null, sensors: sensor({ lastAgentStartAt: null, ts: T0 + 60_000 + 3 * 60_000 }) }), held);
	assert.equal(held.pending[SID], undefined);
	const stop = late.find((f) => f.kind === "host-crash-stopped");
	assert.equal(stop.data.reason, "no-turn");
	assert.equal(held.stopped[SID].pid, 9001, "the stop belongs to the new host, so its heartbeat does not clear it");
	assert.match(stop.detailKo, /wA:t9.*\/resume/);
	assert.doesNotMatch(stop.detailKo, /omo --session/, "a second omo on the open session would run it twice");
	const again = detect(world({ now: T0 + 5 * 60_000, hb: null, sensors: sensor({ lastAgentStartAt: null, ts: T0 + 5 * 60_000 }) }), held);
	assert.equal(again.some((f) => f.kind === "host-crash-stopped"), true, "still held: the stop stays");
	assert.deepEqual(detect(world({ now: T0 + 6 * 60_000, hb: null, sensors: sensor({ lastAgentStartAt: T0 + 6 * 60_000 - 1000, ts: T0 + 6 * 60_000 }) }), held), [], "a person continued it: the stop clears");
	assert.equal(held.stopped[SID], undefined);
});

test("a stop clears once the session runs again or after an hour", () => {
	const stopped = { atMs: T0, reason: "pane-busy", cwd: "C:\\dev\\x", pid: HOST };
	const back = { stopped: { [SID]: { ...stopped } } };
	assert.deepEqual(detect(world({ now: T0 + 60_000, hb: null, sensors: [{ sessionId: SID, pid: 9001, ts: T0 + 55_000 }] }), back), []);
	assert.equal(back.stopped[SID], undefined);
	const still = { stopped: { [SID]: { ...stopped } } };
	assert.equal(detect(world({ now: T0 + 30 * 60_000, hb: null }), still).length, 1);
	assert.deepEqual(detect(world({ now: T0 + 61 * 60_000, hb: null }), still), []);
});
