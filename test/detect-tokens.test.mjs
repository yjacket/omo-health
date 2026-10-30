import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/tokens.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const turn = (ms, usage = {}) => ({ ms, startMs: ms - 20_000, durMs: 20_000, provider: "anthropic", model: "claude-opus", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, stopReason: "toolUse", ...usage });
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

function assertCommon(finding) {
	assert.equal(finding.detector, "D4");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.ok(finding.titleKo.length > 0);
	assert.ok(finding.detailKo.length > 0);
}

// F5 incident shape: session 01a0ca81, 08:52-08:56.
const F5_BASE = Date.parse("2026-09-23T08:52:00Z");
function f5Turns(cacheReads = [322052, 28226, 28226, 28226]) {
	const writes = [319300, 329305, 339064, 325632];
	const costs = [2.2, 4.31, 4.44, 4.27];
	return writes.map((cacheWrite, i) => turn(F5_BASE + i * MIN, { input: 3, output: 900, cacheRead: cacheReads[i], cacheWrite, cost: costs[i] }));
}

test("cache-storm: F5 fires at the second storm turn", () => {
	const turns = f5Turns();
	const upTo = (n) => makeWorld({ now: turns[n - 1].ms, sessions: [sessionState({ id: "01a0ca81", turns: turns.slice(0, n) })] });

	assert.equal(ofKind(detect(upTo(2)), "cache-storm").length, 0, "one storm turn is not a storm");

	const [atSecond] = ofKind(detect(upTo(3)), "cache-storm");
	assertCommon(atSecond);
	assert.equal(atSecond.subject.sessionId, "01a0ca81");
	assert.equal(atSecond.data.atMs, turns[2].ms);
	assert.equal(atSecond.data.turns, 2);

	const [full] = ofKind(detect(upTo(4)), "cache-storm");
	assert.equal(full.fp, atSecond.fp, "same incident keeps its fingerprint");
	assert.equal(full.data.turns, 3);
	assert.equal(full.data.atMs, turns[2].ms);
	assert.ok(Math.abs(full.data.costPerTurn - 4.34) < 0.01);
	assert.equal(full.data.cacheWrite, 325632);
});

test("cache-storm: normal cache reads produce nothing", () => {
	const turns = f5Turns([322052, 322052, 331000, 340000]);
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "01a0ca81", turns })] });
	assert.equal(ofKind(detect(world), "cache-storm").length, 0);
});

test("cache-storm: cache write just under the threshold is not a storm", () => {
	const turns = [turn(NOW - 3 * MIN, { cacheRead: 300_000, cacheWrite: 1000 }), turn(NOW - 2 * MIN, { cacheRead: 1000, cacheWrite: 99_999 }), turn(NOW - MIN, { cacheRead: 1000, cacheWrite: 99_999 })];
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns })] });
	assert.equal(ofKind(detect(world), "cache-storm").length, 0);
});

function burnTurns(recentTokens, earlierHours = 3) {
	const turns = [];
	for (let h = earlierHours; h >= 1; h -= 1) turns.push(turn(NOW - h * HOUR - 30 * MIN, { input: 500_000 }));
	turns.push(turn(NOW - 10 * MIN, { input: recentTokens }));
	return turns;
}

test("burn-spike: last hour above the limit and 3x the session median", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", turns: burnTurns(2_100_000) })] });
	const [finding] = ofKind(detect(world), "burn-spike");
	assertCommon(finding);
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.data.tokensLastHour, 2_100_000);
	assert.equal(finding.data.medianPerHour, 500_000);
	assert.equal(finding.data.earlierHours, 3);
});

test("burn-spike: exactly at the hourly limit does not fire", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns: burnTurns(2_000_000) })] });
	assert.equal(ofKind(detect(world), "burn-spike").length, 0);
});

test("burn-spike: fewer than 3 earlier hours is not judged", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns: burnTurns(5_000_000, 2) })] });
	assert.equal(ofKind(detect(world), "burn-spike").length, 0);
});

function burnWorld(now, recentTokens, config) {
	const turns = [];
	for (let h = 3; h >= 1; h -= 1) turns.push(turn(now - h * HOUR - 30 * MIN, { input: 500_000 }));
	turns.push(turn(now - 10 * MIN, { input: recentTokens }));
	return makeWorld({ now, config, sessions: [sessionState({ id: "s1", turns })] });
}

test("a burn spike that dips under the threshold for one tick stays one finding with the same fp", () => {
	const memory = {};
	const [first] = ofKind(detect(burnWorld(NOW, 2_100_000), memory), "burn-spike");
	assertCommon(first);
	assert.equal(first.subject.key, "burn");

	const held = ofKind(detect(burnWorld(NOW + MIN, 1_900_000), memory), "burn-spike");
	assert.equal(held.length, 1);
	assert.equal(held[0].fp, first.fp);
	assert.equal(held[0].data.tokensLastHour, 2_100_000, "the held finding is emitted unchanged");

	const [again] = ofKind(detect(burnWorld(NOW + 2 * MIN, 2_200_000), memory), "burn-spike");
	assert.equal(again.fp, first.fp);
});

test("after burnHoldMs without the condition the spike resolves", () => {
	const memory = {};
	assert.equal(ofKind(detect(burnWorld(NOW, 2_100_000), memory), "burn-spike").length, 1);
	assert.equal(ofKind(detect(burnWorld(NOW + 10 * MIN, 1_900_000), memory), "burn-spike").length, 0);
	assert.equal(memory.burn.s1, undefined);
});

test("burnHoldMs 0 resolves on the first absent tick (old behavior)", () => {
	const memory = {};
	const config = { tokens: { burnHoldMs: 0 } };
	assert.equal(ofKind(detect(burnWorld(NOW, 2_100_000, config), memory), "burn-spike").length, 1);
	assert.equal(ofKind(detect(burnWorld(NOW + MIN, 1_900_000, config), memory), "burn-spike").length, 0);
});

const flatten = (ms, count, sessionId) => ({ type: "continuity", kind: "flatten", reason: "query_failed", count, ms, ...(sessionId ? { sessionId } : {}) });

test("full-resend: attributed to the event's own session; evidence turn is its biggest cache write within 30 s", () => {
	const eventMs = NOW - MIN;
	const big = sessionState({ id: "big", turns: [turn(eventMs + 10_000, { cacheWrite: 250_000 })] });
	const small = sessionState({ id: "small", turns: [turn(eventMs - 5000, { cacheWrite: 20_000 }), turn(eventMs - 120_000, { cacheWrite: 900_000 })] });
	const world = makeWorld({ now: NOW, sessions: [big, small], events: [flatten(eventMs, 60, "small")] });
	const findings = ofKind(detect(world), "full-resend");
	assert.equal(findings.length, 1);
	const [finding] = findings;
	assertCommon(finding);
	assert.equal(finding.subject.sessionId, "small");
	assert.equal(finding.data.count, 60);
	assert.equal(finding.data.cacheWrite, 20_000);
});

test("full-resend: an event without sessionId produces no finding", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns: [turn(NOW - MIN, { cacheWrite: 300_000 })] })], events: [flatten(NOW - MIN, 50)] });
	assert.equal(ofKind(detect(world), "full-resend").length, 0);
});

test("full-resend: count just under the threshold and non-flatten kinds are ignored", () => {
	const events = [flatten(NOW - MIN, 49), { type: "continuity", kind: "resume", count: 500, ms: NOW - MIN }];
	const world = makeWorld({ now: NOW, events });
	assert.equal(ofKind(detect(world), "full-resend").length, 0);
});

const contextTurns = (contexts) => contexts.map((input, i) => turn(NOW - (contexts.length - i) * MIN, { input }));

test("context-runaway: 3 turns above the max growing 50k each", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", turns: contextTurns([300_000, 360_000, 420_000, 480_000, 540_000]) })] });
	const [finding] = ofKind(detect(world), "context-runaway");
	assertCommon(finding);
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.data.context, 540_000);
	assert.equal(finding.data.growthPerTurn, 60_000);
	assert.equal(finding.data.turns, 3);
});

test("context-runaway: only 2 qualifying turns is not enough", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns: contextTurns([300_000, 360_000, 420_000, 480_000]) })] });
	assert.equal(ofKind(detect(world), "context-runaway").length, 0);
});

test("context-runaway: slow growth is not a runaway", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ turns: contextTurns([400_000, 449_999, 499_998, 549_997, 599_996]) })] });
	assert.equal(ofKind(detect(world), "context-runaway").length, 0);
});
