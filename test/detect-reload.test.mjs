import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/reload.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const NAME = "Implement plan todo 12 (detec...";

// A live omo host for the task (hostPid 4000), so D8 treats its child session as live.
const procSnapshots = [{ takenAtMs: NOW, rows: [raw(4000, 1, "node.exe", new Date(NOW - 5 * 3600_000).toISOString(), 0, 0, "node C:\\Users\\u\\senpi\\dist\\bundle\\cli.js")] }];
const deferred =(ms, names = [NAME]) => ({ type: "reloadDeferred", reason: `${names.length} subagent(s) still running: ${names.join(", ")}`, names, ms });
const task = taskRecord({ taskId: "st_01a0d016", parentSessionId: "p-root", summary: "Implement plan todo 12 (detector bundle A) of the omo-health repo", status: "running" });

test("reload-starvation: same subagent blocks reload for 10+ min -> parent session", () => {
	const events = [deferred(NOW - 12 * MIN), deferred(NOW - 6 * MIN), deferred(NOW - 1 * MIN)];
	const [finding] = detect(makeWorld({ now: NOW, tasks: [task], events }));
	assert.equal(finding.detector, "D11");
	assert.equal(finding.kind, "reload-starvation");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.ok(finding.titleKo.length > 0 && finding.detailKo.length > 0);
	assert.equal(finding.subject.sessionId, "p-root");
	assert.equal(finding.subject.taskId, "st_01a0d016");
	assert.equal(finding.data.durMs, 11 * MIN);
	assert.equal(finding.data.resolved, true);
	assert.equal(finding.data.name, NAME);
});

test("reload-starvation: just under starvationMs does not fire", () => {
	const events = [deferred(NOW - 20 * MIN), deferred(NOW - 10 * MIN - 1)];
	assert.deepEqual(detect(makeWorld({ now: NOW, tasks: [task], events })), []);
});

test("reload-starvation: a gap without the name or a completed reload resets the streak", () => {
	const gap = [deferred(NOW - 30 * MIN), deferred(NOW - 20 * MIN, ["other task..."]), deferred(NOW - 15 * MIN), deferred(NOW - 8 * MIN)];
	assert.deepEqual(detect(makeWorld({ now: NOW, tasks: [task], events: gap })), []);
	const completed = [deferred(NOW - 30 * MIN), { type: "reloadCompleted", ms: NOW - 20 * MIN }, deferred(NOW - 15 * MIN), deferred(NOW - 8 * MIN)];
	assert.deepEqual(detect(makeWorld({ now: NOW, tasks: [task], events: completed })), []);
});

test("reload-starvation: unknown name stays unresolved with a key-only subject", () => {
	const events = [deferred(NOW - 20 * MIN, ["mystery..."]), deferred(NOW - 5 * MIN, ["mystery..."])];
	const [finding] = detect(makeWorld({ now: NOW, tasks: [task], events }));
	assert.equal(finding.subject.sessionId, undefined);
	assert.equal(finding.subject.key, "reload:mystery...");
	assert.equal(finding.data.resolved, false);
	assert.equal(finding.data.blockerStuck, true, "a name with no task in the store cannot be a live blocker");
	assert.equal(finding.data.blockerLive, false);
});

test("reload-starvation: a blocker whose own child session keeps advancing is live, not stuck", () => {
	const child = sessionState({ id: "c1", kind: "child", taskId: task.taskId, parentSessionId: "p-root", task, lastEntryMs: NOW - 2 * MIN, lastActivityMs: NOW - 2 * MIN });
	const events = [deferred(NOW - 12 * MIN), deferred(NOW - 1 * MIN)];
	const [finding] = detect(makeWorld({ now: NOW, tasks: [task], sessions: [child], events }));
	assert.equal(finding.data.blockerLive, true);
	assert.equal(finding.data.blockerStuck, false);
	assert.equal(finding.data.deferralsPerMin, 2 / 11);
	assert.ok(finding.evidence.includes("blocker:live"));
});

test("reload-starvation: a terminal or long-silent blocker is corroborated as stuck", () => {
	const events = [deferred(NOW - 12 * MIN), deferred(NOW - 1 * MIN)];
	const done = taskRecord({ ...task, status: "completed", active: false, terminal: true });
	const [terminal] = detect(makeWorld({ now: NOW, tasks: [done], events }));
	assert.equal(terminal.data.blockerStuck, true);
	assert.equal(terminal.data.blockerLive, false);
	// Past D8's dead-child threshold, without a clean stop, the "still running" subagent is not running.
	const silent = sessionState({ id: "c1", kind: "child", taskId: task.taskId, task, lastEntryMs: NOW - 40 * MIN, lastMessage: { role: "assistant", ms: NOW - 40 * MIN, stopReason: "aborted" } });
	const [stalled] = detect(makeWorld({ now: NOW, tasks: [task], sessions: [silent], events, procSnapshots }));
	assert.equal(stalled.data.blockerStuck, true);
	assert.equal(stalled.data.blockerLive, false);
	assert.ok(stalled.evidence.includes("blocker:stuck"));
});

test("reload-starvation N3: resident worker silent 59 min after an assistant stop is neither live nor stuck", () => {
	const events = [deferred(NOW - 12 * MIN), deferred(NOW - 1 * MIN)];
	const resident = sessionState({ id: "c1", kind: "child", taskId: task.taskId, task, lastEntryMs: NOW - 59 * MIN, lastMessage: { role: "assistant", ms: NOW - 59 * MIN, stopReason: "stop" } });
	const [finding] = detect(makeWorld({ now: NOW, tasks: [task], sessions: [resident], events, procSnapshots }));
	assert.equal(finding.data.blockerStuck, false);
	assert.equal(finding.data.blockerLive, false);
	assert.ok(finding.evidence.includes("blocker:unknown"));
});

test("reload-starvation: a resolved blocker with no child session yet corroborates neither way", () => {
	const events = [deferred(NOW - 12 * MIN), deferred(NOW - 1 * MIN)];
	const [finding] = detect(makeWorld({ now: NOW, tasks: [task], events }));
	assert.equal(finding.data.blockerLive, false);
	assert.equal(finding.data.blockerStuck, false);
});

test("reload-starvation: a streak that went quiet (host gone or reload done) is over", () => {
	const events = [deferred(NOW - 30 * MIN), deferred(NOW - 20 * MIN), deferred(NOW - 10 * MIN)];
	assert.deepEqual(detect(makeWorld({ now: NOW, tasks: [task], events })), []);
});

/** One deferral per minute naming `names`, from `fromMin` to `toMin` minutes relative to NOW. */
const everyMinute = (fromMin, toMin, names) => Array.from({ length: toMin - fromMin + 1 }, (_, i) => deferred(NOW + (fromMin + i) * MIN, names));

test("reload-starvation is keyed by task: a retried node starts its own streak and the cancelled one never reopens (#52)", () => {
	const node = "t11-qa";
	const cancelled = taskRecord({ taskId: "st_old", name: node, summary: "QA t11", parentSessionId: "p-root", status: "cancelled", createdAtMs: NOW - 90 * MIN, terminalAtMs: NOW - 12 * MIN });
	const retry = taskRecord({ taskId: "st_new", name: node, summary: "QA t11", parentSessionId: "p-root", status: "running", createdAtMs: NOW - 11 * MIN, childSessionId: "c2" });
	const [finding, ...rest] = detect(makeWorld({ now: NOW, tasks: [cancelled, retry], events: everyMinute(-80, 0, [node]) }));
	assert.deepEqual(rest, []);
	assert.equal(finding.subject.taskId, "st_new");
	assert.equal(finding.subject.key, "reload:st_new");
	assert.equal(finding.data.durMs, 11 * MIN, "from the retry's first deferral, not the cancelled task's");
	assert.equal(finding.data.events, 12);
	// The retry finishes too, and a deferral still names the node a minute later: it belongs to neither task.
	const finished = { ...retry, status: "completed", active: false, terminal: true, terminalAtMs: NOW + 1 * MIN };
	const later = detect(makeWorld({ now: NOW + 3 * MIN, tasks: [cancelled, finished], events: everyMinute(-80, 2, [node]) }));
	assert.deepEqual(later.filter((f) => f.subject.taskId === "st_old"), [], "the cancelled task's incident never reopens");
});

test("reload-starvation: a blocker stuck past the stall threshold wakes the parent; a dead child is left to D8's own wake (#52)", () => {
	const gone = taskRecord({ ...task, hostPid: 4999 });
	const memory = {};
	const at = (min) => detect(makeWorld({ now: NOW + min * MIN, tasks: [gone], events: everyMinute(-12, min, [NAME]), procSnapshots }), memory)[0];
	const first = at(0);
	assert.equal(first.data.blockerStuck, true, "its host is gone");
	assert.equal(first.data.remedy, undefined);
	assert.equal(at(14).data.remedy, undefined);
	const late = at(15);
	assert.deepEqual(late.data.remedy, { kind: "wake-parent", reason: "reload-starvation" });
	assert.equal(late.data.idleMs, 15 * MIN);
	assert.equal(late.subject.sessionId, "p-root");
	const silent = sessionState({ id: "c1", kind: "child", taskId: task.taskId, task, lastEntryMs: NOW - 40 * MIN, lastMessage: { role: "assistant", ms: NOW - 40 * MIN, stopReason: "aborted" } });
	const dead = {};
	const deadAt = (min) => detect(makeWorld({ now: NOW + min * MIN, tasks: [task], sessions: [silent], events: everyMinute(-12, min, [NAME]), procSnapshots }), dead)[0];
	assert.equal(deadAt(0).data.blockerStuck, true);
	assert.equal(deadAt(20).data.remedy, undefined, "D8 dead-child already wakes the parent for this");
});
