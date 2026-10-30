import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/tps.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;

const turn = (i, durMs, output, lane = { provider: "anthropic", model: "claude-opus" }) => ({ ms: NOW - (10 - i) * MIN, startMs: NOW - (10 - i) * MIN - durMs, durMs, ...lane, input: 10, output, cacheRead: 0, cacheWrite: 0, cost: 0, tps: output / (durMs / 1000) });
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

// 3 slow turns at 10 tok/s over 70 s, 2 fast turns: median 10 tok/s.
const slowTurns = () => [turn(1, 70_000, 700), turn(2, 5000, 500), turn(3, 70_000, 700), turn(4, 5000, 500), turn(5, 70_000, 700)];

test("tps-collapse: slow lane in one session", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", turns: slowTurns() })] });
	const [finding] = ofKind(detect(world), "tps-collapse");
	assert.equal(finding.detector, "D5");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.ok(finding.titleKo.length > 0 && finding.detailKo.length > 0);
	assert.equal(finding.subject.key, "lane:anthropic/claude-opus");
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.data.medianTps, 10);
	assert.equal(finding.data.providerSide, false);
	assert.deepEqual(finding.data.sessionIds, ["s1"]);
});

test("tps-collapse: two sessions on the same lane -> providerSide", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", turns: slowTurns() }), sessionState({ id: "s2", turns: slowTurns() })] });
	const found = ofKind(detect(world), "tps-collapse");
	assert.equal(found.length, 1);
	assert.equal(found[0].data.providerSide, true);
	assert.deepEqual(found[0].data.sessionIds, ["s1", "s2"]);
	assert.equal(found[0].subject.sessionId, undefined);
});

test("tps-collapse: only 2 turns over 60 s is not a collapse", () => {
	const turns = [turn(1, 70_000, 700), turn(2, 50_000, 500), turn(3, 70_000, 700), turn(4, 50_000, 500), turn(5, 50_000, 500)];
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns })] });
	assert.equal(ofKind(detect(world), "tps-collapse").length, 0);
});

test("tps-collapse: fast lanes and tiny turns are ignored", () => {
	const turns = [turn(1, 70_000, 7000), turn(2, 70_000, 7000), turn(3, 70_000, 7000), turn(4, 70_000, 40), turn(5, 1500, 700)];
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns })] });
	assert.equal(ofKind(detect(world), "tps-collapse").length, 0);
});

const DAY = 24 * 60 * MIN;
const agedTurns = (ageMs) => slowTurns().map((t, i) => ({ ...t, ms: NOW - ageMs + i * MIN, startMs: NOW - ageMs + i * MIN - t.durMs }));

test("tps-collapse: a dead-host child with days-old slow turns yields no tps-collapse", () => {
	const task = taskRecord({ taskId: "st_old", status: "completed", hostPid: 4000, childSessionId: "c1" });
	const child = sessionState({ id: "c1", kind: "child", taskId: "st_old", parentSessionId: "p1", task, turns: agedTurns(3 * DAY) });
	const world = makeWorld({ now: NOW, sessions: [child] });
	assert.deepEqual(detect(world), []);
});

test("tps-collapse: slow turns older than an hour do not count for a main session either", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", turns: agedTurns(2 * 60 * MIN) })] });
	assert.equal(ofKind(detect(world), "tps-collapse").length, 0);
});

const HOST_ROWS = [{ takenAtMs: NOW, rows: [{ p: 4000, pp: 1, n: "node.exe", c: "2026-09-23T09:00:00Z", cpu: 0, pv: 1, cl: "node C:\\npm\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" }] }];

function hungChild(partial = {}) {
	const task = taskRecord({ taskId: "st_h", parentSessionId: "p1", hostPid: 4000, status: partial.status ?? "running" });
	return sessionState({
		id: "c1",
		kind: "child",
		taskId: "st_h",
		parentSessionId: "p1",
		task,
		lastEntryMs: NOW - (partial.idleMin ?? 31) * MIN,
		lastMessage: { role: partial.role ?? "toolResult", ms: NOW - (partial.idleMin ?? 31) * MIN },
		pendingCalls: partial.pendingCalls,
	});
}

test("hung-turn-child: child waiting on the model past hungTurnMs", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1" }), hungChild()], procSnapshots: HOST_ROWS });
	const [finding] = ofKind(detect(world), "hung-turn-child");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.equal(finding.subject.sessionId, "c1");
	assert.equal(finding.subject.taskId, "st_h");
	assert.equal(finding.subject.parentSessionId, "p1");
	assert.deepEqual(finding.data.remedy, { kind: "wake-parent", reason: "hung-turn" });
	assert.equal(finding.data.idleMs, 31 * MIN);
	assert.equal(finding.data.lastRole, "toolResult");
});

test("hung-turn-child: just under hungTurnMs does not fire", () => {
	const world = makeWorld({ now: NOW, sessions: [hungChild({ idleMin: 29 })] });
	assert.equal(ofKind(detect(world), "hung-turn-child").length, 0);
});

test("hung-turn-child: excluded by recent cooldown, pending calls, finished task, assistant last or main session", () => {
	const cooldown = makeWorld({ now: NOW, sessions: [hungChild()], events: [{ type: "cooldown", selector: "anthropic", error: "429", ms: NOW - 2 * MIN }] });
	assert.equal(ofKind(detect(cooldown), "hung-turn-child").length, 0);
	const pending = makeWorld({ now: NOW, sessions: [hungChild({ pendingCalls: [{ id: "call1", name: "bash", ms: NOW - 31 * MIN }] })] });
	assert.equal(ofKind(detect(pending), "hung-turn-child").length, 0);
	const done = makeWorld({ now: NOW, sessions: [hungChild({ status: "completed" })] });
	assert.equal(ofKind(detect(done), "hung-turn-child").length, 0);
	const assistant = makeWorld({ now: NOW, sessions: [hungChild({ role: "assistant" })] });
	assert.equal(ofKind(detect(assistant), "hung-turn-child").length, 0);
	const main = makeWorld({ now: NOW, sessions: [sessionState({ id: "m1", kind: "main", lastEntryMs: NOW - 40 * MIN, lastMessage: { role: "toolResult" } })] });
	assert.equal(ofKind(detect(main), "hung-turn-child").length, 0);
});

test("hung-turn-child: an old cooldown (over 5 min ago) does not exclude", () => {
	const world = makeWorld({ now: NOW, sessions: [hungChild()], events: [{ type: "fallback", from: "a", to: "b", ms: NOW - 6 * MIN }], procSnapshots: HOST_ROWS });
	assert.equal(ofKind(detect(world), "hung-turn-child").length, 1);
});

test("hung-turn-child: a child whose host process is gone is not woken (stale task record)", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "p1" }), hungChild({ idleMin: 12_978 })] });
	assert.equal(ofKind(detect(world), "hung-turn-child").length, 0);
});

test("tps-collapse: a child whose host is gone does not count even with recent slow turns", () => {
	const task = taskRecord({ taskId: "st_c", hostPid: 4000, childSessionId: "c1", status: "running" });
	const child = sessionState({ id: "c1", kind: "child", taskId: "st_c", parentSessionId: "p1", task, turns: slowTurns(), lastEntryMs: NOW - 5 * MIN, lastMessage: { role: "assistant", ms: NOW - 5 * MIN } });
	assert.deepEqual(ofKind(detect(makeWorld({ now: NOW, sessions: [child] })), "tps-collapse"), []);
});

test("tps-collapse: a live child with recent slow turns still collapses the lane", () => {
	const task = taskRecord({ taskId: "st_c", hostPid: 4000, childSessionId: "c1", status: "running" });
	const child = sessionState({
		id: "c1",
		kind: "child",
		taskId: "st_c",
		parentSessionId: "p1",
		task,
		turns: slowTurns(),
		lastEntryMs: NOW - 5 * MIN,
		lastMessage: { role: "assistant", ms: NOW - 5 * MIN },
	});
	const world = makeWorld({ now: NOW, sessions: [child], procSnapshots: HOST_ROWS });
	const [finding] = ofKind(detect(world), "tps-collapse");
	assert.equal(finding.subject.sessionId, "c1");
	assert.deepEqual(finding.data.sessionIds, ["c1"]);
});
