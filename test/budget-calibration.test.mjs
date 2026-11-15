import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOf, windowApplies } from "../src/budget/accounts.mjs";
import { calibrate, epochs, externalPercent } from "../src/budget/calibration.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 28, 0, 0, 0);

function sample(atMs, usedPercent, resetsAtMs = T0 + 7 * DAY) {
	return { updatedMs: atMs, usedPercent, resetsAtMs, windowMinutes: 7 * 24 * 60 };
}

test("epochs split on a scheduled reset and keep the scheduled end reason", () => {
	const list = epochs(
		[
			sample(T0, 10),
			sample(T0 + 10 * MIN, 20),
			sample(T0 + 20 * MIN, 0, T0 + 14 * DAY),
		],
		{ earlyDropPercent: 5 },
	);
	assert.equal(list.length, 2);
	assert.equal(list[0].endedBy, "scheduled");
	assert.equal(list[0].startMs, T0);
	assert.equal(list[0].endMs, T0 + 10 * MIN);
	assert.equal(list[0].samples.length, 2);
	assert.equal(list[0].resetsAtMs, T0 + 7 * DAY);
	assert.equal(list[1].endedBy, null);
	assert.equal(list[1].resetsAtMs, T0 + 14 * DAY);
});

test("epochs split on an early drop >= 5 pp and ignore a smaller drop", () => {
	const list = epochs(
		[
			sample(T0, 40),
			sample(T0 + 10 * MIN, 60),
			sample(T0 + 20 * MIN, 56),
			sample(T0 + 30 * MIN, 30),
		],
		{ earlyDropPercent: 5 },
	);
	assert.equal(list.length, 2);
	assert.equal(list[0].samples.length, 3); // the 4 pp wobble stays in the epoch
	assert.equal(list[0].endedBy, "early");
	assert.equal(list[1].startMs, T0 + 30 * MIN);
	assert.equal(list[1].endedBy, null);
});

test("weighted median and weighted 20th/80th percentiles use delta-percent weights", () => {
	const samples = [sample(T0, 0), sample(T0 + 10 * MIN, 10), sample(T0 + 20 * MIN, 30), sample(T0 + 30 * MIN, 40)];
	const spend = new Map([
		[T0, 5],
		[T0 + 10 * MIN, 4],
		[T0 + 20 * MIN, 1],
	]);
	const result = calibrate({
		samples,
		spendBetween: (fromMs) => spend.get(fromMs) ?? 0,
		cfg: { earlyDropPercent: 5, minIntervalPercent: 2, maxGapMs: 2 * HOUR, minIntervals: 10, minCoveragePercent: 20 },
	});
	// ratios 10/5 = 2 (weight 10), 20/4 = 5 (weight 20), 10/1 = 10 (weight 10)
	assert.equal(result.intervals, 3);
	assert.equal(result.percentPerUsd, 5);
	assert.equal(result.low, 2);
	assert.equal(result.high, 10);
	assert.equal(result.calibrated, false); // fewer than 10 intervals
});

test("calibration needs at least 10 intervals", () => {
	const nineIntervals = Array.from({ length: 10 }, (_, i) => sample(T0 + i * 10 * MIN, i * 2));
	const below = calibrate({ samples: nineIntervals, spendBetween: () => 1, cfg: { minIntervals: 10, minCoveragePercent: 20 } });
	assert.equal(below.intervals, 9);
	assert.equal(below.coveragePercent, 100);
	assert.equal(below.calibrated, false);

	const tenIntervals = Array.from({ length: 11 }, (_, i) => sample(T0 + i * 10 * MIN, i * 2));
	const above = calibrate({ samples: tenIntervals, spendBetween: () => 1, cfg: { minIntervals: 10, minCoveragePercent: 20 } });
	assert.equal(above.intervals, 10);
	assert.equal(above.percentPerUsd, 2);
	assert.equal(above.calibrated, true);
});

test("intervals with a gap > 2 h are skipped", () => {
	const samples = [
		sample(T0, 0),
		sample(T0 + 30 * MIN, 10),
		sample(T0 + 3.5 * HOUR, 20),
		sample(T0 + 3.75 * HOUR, 30),
	];
	const result = calibrate({ samples, spendBetween: () => 1, cfg: { maxGapMs: 2 * HOUR } });
	assert.equal(result.intervals, 2); // 0 -> 30 min counted, 30 min -> 3.5 h dropped, 3.5 h -> 3.75 h counted
	assert.equal(result.percentPerUsd, 10);
});

test("no intervals => all ratios null and uncalibrated", () => {
	const result = calibrate({ samples: [sample(T0, 40)], spendBetween: () => 5 });
	assert.deepEqual(result, {
		percentPerUsd: null,
		low: null,
		high: null,
		intervals: 0,
		coveragePercent: null,
		calibrated: false,
	});
});

test("a 30 pp early drop starts a new epoch and never yields a negative interval", () => {
	const samples = [
		sample(T0, 40),
		sample(T0 + 10 * MIN, 70),
		sample(T0 + 20 * MIN, 40),
		sample(T0 + 30 * MIN, 70),
	];
	const list = epochs(samples, { earlyDropPercent: 5 });
	assert.equal(list.length, 2);
	assert.equal(list[0].endedBy, "early");
	const result = calibrate({ samples, spendBetween: () => 10, cfg: { earlyDropPercent: 5 } });
	assert.equal(result.intervals, 2);
	assert.ok(result.percentPerUsd > 0, `expected positive percentPerUsd, got ${result.percentPerUsd}`);
	assert.equal(result.percentPerUsd, 3); // each remaining interval: 30 pp / $10
});

test("externalPercent subtracts calibrated spend and returns null when uncalibrated", () => {
	const samples = [sample(T0, 20), sample(T0 + DAY, 50)];
	const spendBetween = () => 5;
	assert.equal(externalPercent({ samples, spendBetween, coefficient: 2, sinceMs: T0 }), 30 - 2 * 5);
	assert.equal(externalPercent({ samples, spendBetween, coefficient: null, sinceMs: T0 }), null);
	assert.equal(externalPercent({ samples: [sample(T0, 20)], spendBetween, coefficient: 2 }), null);
});

test("claude-sdk-oauth aliases to the anthropic subscription account", () => {
	const aliases = ["claude-sdk-oauth=anthropic-subscription"];
	assert.equal(accountOf("claude-sdk-oauth", aliases), "anthropic-subscription/default");
	assert.equal(accountOf("anthropic-subscription", aliases), "anthropic-subscription/default");
	assert.equal(accountOf("chatgpt-subscription", aliases), "chatgpt-subscription/default");
	assert.equal(accountOf("github-copilot", aliases), null);
	assert.equal(accountOf("", aliases), null);
});

test("windowApplies restricts a scoped window to models carrying that scope", () => {
	const scoped = { id: "claude:7d_fable" };
	assert.equal(windowApplies(scoped, "claude-fable-5"), true);
	assert.equal(windowApplies(scoped, "CLAUDE-FABLE-5"), true);
	assert.equal(windowApplies(scoped, "claude-opus-5-5"), false);
	assert.equal(windowApplies(scoped, { id: "claude-fable-5" }), true);
	assert.equal(windowApplies(scoped, { id: "claude-opus-5-5" }), false);

	const unscoped = { id: "claude:7d" };
	assert.equal(windowApplies(unscoped, "claude-opus-5-5"), true);
	assert.equal(windowApplies(unscoped, "claude-fable-5"), true);

	const explicit = { id: "claude:7d_fable", scope: "fable" };
	assert.equal(windowApplies(explicit, "claude-opus-5-5"), false);
});
