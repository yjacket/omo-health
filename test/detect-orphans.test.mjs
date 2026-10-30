import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/orphans.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HOST_PID = 4000;
const iso = (ms) => new Date(ms).toISOString();
const HOST = () => raw(HOST_PID, 1, "node.exe", iso(NOW - 5 * 3600_000), 0, 0, "node C:\\Users\\u\\senpi\\dist\\bundle\\cli.js");
const OTHER = () => raw(777, 1, "explorer.exe", iso(NOW - 5 * 3600_000));
const snaps = (rows) => [{ takenAtMs: NOW, rows }];
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

function child(partial = {}) {
	const task = taskRecord({ taskId: "st_d", parentSessionId: "p1", hostPid: HOST_PID, childSessionId: "c1", status: partial.status ?? "running" });
	const lastMs = NOW - (partial.idleMin ?? 31) * MIN;
	return sessionState({
		id: "c1",
		kind: "child",
		taskId: "st_d",
		parentSessionId: "p1",
		task,
		lastEntryMs: lastMs,
		lastMessage: { role: partial.role ?? "assistant", ms: lastMs, stopReason: partial.stopReason ?? "aborted" },
		pendingCalls: partial.pendingCalls,
	});
}

test("dead-child: silent live child without a clean stop wakes the parent", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 40 * MIN }), child()], procSnapshots: snaps([HOST()]) });
	const [finding] = ofKind(detect(world, {}), "dead-child");
	assert.equal(finding.detector, "D8");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.subject.sessionId, "p1");
	assert.equal(finding.subject.parentSessionId, "p1");
	assert.equal(finding.subject.taskId, "st_d");
	assert.deepEqual(finding.data.remedy, { kind: "wake-parent", reason: "dead-child" });
	assert.equal(finding.data.idleMs, 31 * MIN);
	assert.ok(finding.titleKo && finding.detailKo);
});

test("dead-child N3: resident worker after assistant stop and 59 min silence -> nothing", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 60 * MIN }), child({ stopReason: "stop", idleMin: 59 })], procSnapshots: snaps([HOST()]) });
	assert.deepEqual(detect(world, {}), []);
});

test("dead-child: pending call, D5 case, short idle or dead host do not fire", () => {
	const pending = makeWorld({ now: NOW, sessions: [child({ pendingCalls: [{ id: "call1", name: "bash", ms: NOW - 31 * MIN }] })], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(pending, {}), "dead-child").length, 0);
	const toolResult = makeWorld({ now: NOW, sessions: [child({ role: "toolResult" })], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(toolResult, {}), "dead-child").length, 0);
	const short = makeWorld({ now: NOW, sessions: [child({ idleMin: 29 })], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(short, {}), "dead-child").length, 0);
	const deadHost = makeWorld({ now: NOW, sessions: [child()], procSnapshots: snaps([OTHER()]) });
	assert.equal(ofKind(detect(deadHost, {}), "dead-child").length, 0);
});

function errorTask(terminalMin) {
	return taskRecord({ taskId: "st_e", status: "error", parentSessionId: "p1", hostPid: HOST_PID, terminalAtMs: NOW - terminalMin * MIN });
}

test("child-error-unhandled: errored child and silent parent past parentIdleMs", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN })], tasks: [errorTask(20)] });
	const [finding] = ofKind(detect(world, {}), "child-error-unhandled");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.subject.sessionId, "p1");
	assert.equal(finding.subject.taskId, "st_e");
	assert.deepEqual(finding.data.remedy, { kind: "wake-parent", reason: "child-error" });
	assert.equal(finding.data.idleMs, 20 * MIN);
});

test("child-error-unhandled: the child's final error text is carried, or the task record's, else absent", () => {
	const kid = sessionState({ id: "c1", kind: "child", taskId: "st_e", parentSessionId: "p1", lastEntryMs: NOW - 20 * MIN, lastMessage: { role: "assistant", ms: NOW - 20 * MIN, stopReason: "error", errorMessage: "401 Unauthorized: OAuth access token has been revoked" } });
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN }), kid], tasks: [errorTask(20)], procSnapshots: snaps([HOST()]) });
	const [finding] = ofKind(detect(world, {}), "child-error-unhandled");
	assert.match(finding.data.errorText, /401/);
	// No child session recorded: the task record's own error field is used.
	const tasked = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN })], tasks: [{ ...errorTask(20), errorMessage: "child process crashed" }], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(tasked, {}), "child-error-unhandled")[0].data.errorText, "child process crashed");
	// A plain errored task with no error text anywhere: the field is absent, not empty.
	const quiet = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN })], tasks: [errorTask(20)], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(quiet, {}), "child-error-unhandled")[0].data.errorText, undefined);
});

test("child-error-unhandled: an error that ended two days ago is not child-error-unhandled; one that ended 20 min ago with an idle parent is", () => {
	const stale = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 2 * DAY - 60 * MIN })], tasks: [errorTask(2 * 24 * 60)] });
	assert.equal(ofKind(detect(stale, {}), "child-error-unhandled").length, 0);
	const recent = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN })], tasks: [errorTask(20)] });
	const [finding] = ofKind(detect(recent, {}), "child-error-unhandled");
	assert.equal(finding.subject.taskId, "st_e");
});

test("child-error-unhandled: parent already reacted, too recent, or parent unknown -> nothing", () => {
	const reacted = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 10 * MIN })], tasks: [errorTask(20)] });
	assert.equal(ofKind(detect(reacted, {}), "child-error-unhandled").length, 0);
	const recent = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 25 * MIN })], tasks: [errorTask(10)] });
	assert.equal(ofKind(detect(recent, {}), "child-error-unhandled").length, 0);
	const noParent = makeWorld({ now: NOW, sessions: [], tasks: [errorTask(20)] });
	assert.equal(ofKind(detect(noParent, {}), "child-error-unhandled").length, 0);
});

test("task-host-gone: active task whose host pid is gone -> info without remedy", () => {
	const task = taskRecord({ taskId: "st_g", hostPid: 4999, status: "running", updatedAtMs: NOW - 5 * MIN });
	const world = makeWorld({ now: NOW, tasks: [task], procSnapshots: snaps([OTHER()]) });
	const [finding] = ofKind(detect(world, {}), "task-host-gone");
	assert.equal(finding.severity, "info");
	assert.equal(finding.subject.taskId, "st_g");
	assert.equal(finding.data.remedy, undefined);
	const alive = makeWorld({ now: NOW, tasks: [taskRecord({ taskId: "st_g", hostPid: HOST_PID })], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(alive, {}), "task-host-gone").length, 0);
	const noProcs = makeWorld({ now: NOW, tasks: [task] });
	assert.equal(ofKind(detect(noProcs, {}), "task-host-gone").length, 0);
	const done = makeWorld({ now: NOW, tasks: [taskRecord({ taskId: "st_g", hostPid: 4999, status: "completed" })], procSnapshots: snaps([OTHER()]) });
	assert.equal(ofKind(detect(done, {}), "task-host-gone").length, 0);
});

test("task-host-gone: a dead-host record untouched for two days is not reported; one updated 10 min ago is", () => {
	const stale = makeWorld({ now: NOW, tasks: [taskRecord({ taskId: "st_stale", hostPid: 4999, status: "running", updatedAtMs: NOW - 2 * DAY })], procSnapshots: snaps([OTHER()]) });
	assert.equal(ofKind(detect(stale, {}), "task-host-gone").length, 0);
	const staleCreated = makeWorld({ now: NOW, tasks: [taskRecord({ taskId: "st_stale", hostPid: 4999, status: "running", createdAtMs: NOW - 2 * DAY })], procSnapshots: snaps([OTHER()]) });
	assert.equal(ofKind(detect(staleCreated, {}), "task-host-gone").length, 0);
	const recent = makeWorld({ now: NOW, tasks: [taskRecord({ taskId: "st_recent", hostPid: 4999, status: "running", updatedAtMs: NOW - 10 * MIN })], procSnapshots: snaps([OTHER()]) });
	const [finding] = ofKind(detect(recent, {}), "task-host-gone");
	assert.equal(finding.subject.taskId, "st_recent");
});

test("task-host-gone-after-resume: only a parent resumed on another live host and active there past 5 min", () => {
	const task = taskRecord({ taskId: "st_g", hostPid: 4999, parentSessionId: "p1", status: "running", updatedAtMs: NOW - 5 * MIN });
	const hostStartMs = NOW - 5 * 3600_000;
	const at = (parent) => makeWorld({ now: NOW, sessions: parent ? [parent] : [], tasks: [task], procSnapshots: snaps([HOST(), OTHER()]) });
	const [resumed] = detect(at(sessionState({ id: "p1", hostPid: HOST_PID, lastEntryMs: hostStartMs + 6 * MIN })), {});
	assert.equal(resumed.kind, "task-host-gone-after-resume");
	assert.equal(resumed.severity, "info");
	assert.equal(resumed.data.parentPid, HOST_PID);
	assert.equal(resumed.data.onceKey, "st_g@4999");
	assert.equal(resumed.data.remedy, undefined);
	// The parent was just resumed: omo core may still reconcile.
	assert.equal(detect(at(sessionState({ id: "p1", hostPid: HOST_PID, lastEntryMs: hostStartMs + 4 * MIN })), {})[0].kind, "task-host-gone");
	// The parent is not open anywhere: omo waits for it to be resumed.
	const [waiting] = detect(at(sessionState({ id: "p1", hostPid: 4999, lastEntryMs: NOW - MIN })), {});
	assert.equal(waiting.kind, "task-host-gone");
	assert.match(waiting.detailKo, /부모 세션 p1을 다시 열면/);
	assert.equal(detect(at(null), {})[0].kind, "task-host-gone");
});

test("task-host-gone-after-resume: unknown host start (ctimeMs 0) -> no after-resume, plain task-host-gone", () => {
	const task = taskRecord({ taskId: "st_g", hostPid: 4999, parentSessionId: "p1", status: "running", updatedAtMs: NOW - 5 * MIN });
	// No creation time: normalizeRows records ctimeMs 0.
	const unknownStartHost = raw(HOST_PID, 1, "node.exe", undefined, 0, 0, "node C:\\Users\\u\\senpi\\dist\\bundle\\cli.js");
	const world = makeWorld({
		now: NOW,
		sessions: [sessionState({ id: "p1", hostPid: HOST_PID, lastEntryMs: NOW - 2 * MIN })],
		tasks: [task],
		procSnapshots: [{ takenAtMs: NOW, rows: [unknownStartHost, OTHER()] }],
	});
	const findings = detect(world, {});
	const hostGone = findings.filter((f) => f.kind === "task-host-gone" || f.kind === "task-host-gone-after-resume");
	assert.equal(hostGone.length, 1, "exactly one task-host-gone finding");
	assert.equal(hostGone[0].kind, "task-host-gone", "should be plain task-host-gone, not after-resume");
	assert.equal(hostGone[0].data.remedy, undefined);
});

const errText = "Provider is not configured: anthropic";

function erroredMain({ gapMs = 30_000, count = 3 } = {}) {
	const lastMs = NOW - 9 * MIN;
	const errors = [];
	for (let i = count - 1; i >= 0; i--) errors.push({ ms: lastMs - i * gapMs, text: errText, provider: "anthropic" });
	return sessionState({ id: "m1", kind: "main", hostPid: HOST_PID, errors, lastEntryMs: lastMs, lastMessage: { role: "assistant", ms: lastMs, stopReason: "error" } });
}

const okTurn = (ms) => ({ ms, provider: "anthropic", model: "claude", stopReason: "stop", durMs: 1000, output: 10 });
const recovered = () => sessionState({ id: "s2", turns: [okTurn(NOW - 5 * MIN)] });

test("stopped-on-errors: nudges once per incident after the provider recovered", () => {
	const memory = {};
	const world = makeWorld({ now: NOW, sessions: [erroredMain(), recovered()], procSnapshots: snaps([HOST()]) });
	const [finding] = ofKind(detect(world, memory), "stopped-on-errors");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.subject.sessionId, "m1");
	assert.deepEqual(finding.data.remedy, { kind: "nudge" });
	assert.equal(finding.data.errorClass, "not-configured");
	assert.equal(finding.data.recoveredAt, NOW - 5 * MIN);
	assert.equal(finding.data.lastErrorMs, NOW - 9 * MIN);
	assert.equal(ofKind(detect(world, memory), "stopped-on-errors").length, 0);
});

test("stopped-on-errors: no nudge before recovery; nudge once recovery appears", () => {
	const memory = {};
	const before = makeWorld({ now: NOW, sessions: [erroredMain()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(before, memory), "stopped-on-errors").length, 0);
	const after = makeWorld({ now: NOW, sessions: [erroredMain(), recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(after, memory), "stopped-on-errors").length, 1);
});

test("stopped-on-errors: too few errors, spread-out errors, newer entry or dead session -> nothing", () => {
	const few = makeWorld({ now: NOW, sessions: [erroredMain({ count: 2 }), recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(few, {}), "stopped-on-errors").length, 0);
	const spread = makeWorld({ now: NOW, sessions: [erroredMain({ gapMs: 90_000 }), recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(spread, {}), "stopped-on-errors").length, 0);
	const newer = erroredMain();
	newer.lastEntryMs = NOW - 2 * MIN;
	const newerWorld = makeWorld({ now: NOW, sessions: [newer, recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(newerWorld, {}), "stopped-on-errors").length, 0);
	const dead = makeWorld({ now: NOW, sessions: [erroredMain(), recovered()], procSnapshots: snaps([OTHER()]) });
	assert.equal(ofKind(detect(dead, {}), "stopped-on-errors").length, 0);
});

test("stopped-on-errors: a live child is never nudged (no sensor; dead or errored children wake their parent)", () => {
	const base = erroredMain();
	const task = taskRecord({ taskId: "st_k", status: "running", parentSessionId: "p1", hostPid: HOST_PID, childSessionId: "k1" });
	const kid = sessionState({ id: "k1", kind: "child", taskId: "st_k", parentSessionId: "p1", hostPid: HOST_PID, task, errors: base.errors, lastEntryMs: base.lastEntryMs, lastMessage: base.lastMessage });
	const world = makeWorld({ now: NOW, sessions: [kid, recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(world.isSessionLive(world.sessions.get("k1")), true, "only the child check can exclude it");
	assert.equal(ofKind(detect(world, {}), "stopped-on-errors").length, 0);
});

test("stopped-on-errors: extension state records after the error run are not activity (F1 01a0ca8d)", () => {
	const session = erroredMain();
	session.lastActivityMs = NOW - 9 * MIN; // the last error turn
	session.lastEntryMs = NOW - 4 * MIN; // senpi.hooks.stop-state, pi-rules.scan on reload
	const world = makeWorld({ now: NOW, sessions: [session, recovered()], procSnapshots: snaps([HOST()]) });
	assert.equal(ofKind(detect(world, {}), "stopped-on-errors").length, 1);
	session.lastActivityMs = NOW - 3 * MIN; // a real conversation entry after the errors
	assert.equal(ofKind(detect(world, {}), "stopped-on-errors").length, 0);
});

function hungWorld({ hb = {}, events, pendingCalls } = {}) {
	const heartbeat = { sessionId: "m1", pid: HOST_PID, ts: NOW, idle: false, pending: false, executingTools: 0, lastEventAt: NOW - 31 * MIN, ...hb };
	return makeWorld({ now: NOW, sessions: [sessionState({ id: "m1", kind: "main", hostPid: HOST_PID, pendingCalls })], sensors: [heartbeat], events, procSnapshots: snaps([HOST()]) });
}

test("hung-main-turn: busy main session without events past hungTurnMs -> abort-continue", () => {
	const [finding] = ofKind(detect(hungWorld(), {}), "hung-main-turn");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.subject.sessionId, "m1");
	assert.deepEqual(finding.data.remedy, { kind: "abort-continue" });
	assert.equal(finding.data.idleMs, 31 * MIN);
});

test("hung-main-turn: suppressed by a fallback 2 min ago, tools running, idle, pending, short gap or stale sensor", () => {
	const fallback = hungWorld({ events: [{ type: "fallback", from: "a", to: "b", ms: NOW - 2 * MIN }] });
	assert.equal(ofKind(detect(fallback, {}), "hung-main-turn").length, 0);
	assert.equal(ofKind(detect(hungWorld({ hb: { executingTools: 1 } }), {}), "hung-main-turn").length, 0);
	assert.equal(ofKind(detect(hungWorld({ hb: { idle: true } }), {}), "hung-main-turn").length, 0);
	assert.equal(ofKind(detect(hungWorld({ hb: { lastEventAt: NOW - 29 * MIN } }), {}), "hung-main-turn").length, 0);
	assert.equal(ofKind(detect(hungWorld({ hb: { ts: NOW - 10 * MIN } }), {}), "hung-main-turn").length, 0);
	assert.equal(ofKind(detect(hungWorld({ pendingCalls: [{ id: "c", name: "bash", ms: NOW - 31 * MIN }] }), {}), "hung-main-turn").length, 0);
});

test("hung-main-turn: an old fallback (6 min ago) does not suppress", () => {
	const world = hungWorld({ events: [{ type: "cooldown", selector: "x", ms: NOW - 6 * MIN }] });
	assert.equal(ofKind(detect(world, {}), "hung-main-turn").length, 1);
});
