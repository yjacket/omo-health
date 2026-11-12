import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { capacityCheck, summarize, windowState } from "../src/budget/treasury.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const CFG = DEFAULT_CONFIG.budget;
// DEFAULT_CONFIG.budget: reservePercent 10 + auditReservePercent 2 => 12.
const RESERVE = 12;
const CAL = Object.freeze({ calibrated: true, percentPerUsd: 0.3, low: 0.2, high: 0.4 });
const FLAT = Object.freeze({ calibrated: true, percentPerUsd: 1, low: 1, high: 1 });
const WINDOW = Object.freeze({ id: "claude:7d", label: "7d", windowMinutes: 10080 });

function reading(usedPercent, ms, resetsAtMs = NOW + 12 * HOUR) {
	return { updatedMs: ms, usedPercent, resetsAtMs, windowMinutes: 10080 };
}

function state(over = {}) {
	return windowState({
		account: "anthropic-subscription/default",
		window: WINDOW,
		samples: [reading(70, NOW - 3 * HOUR)],
		calibration: CAL,
		committedUsd: 0,
		now: NOW,
		cfg: CFG,
		stale: false,
		...over,
	});
}

test("illustrative case: used 70, reserve 12, committed 8 => free 10", () => {
	const s = state({ samples: [reading(70, NOW - 30 * MIN)], committedUsd: 20 });
	assert.equal(s.reservePercent, RESERVE);
	assert.equal(s.usedPercent, 70);
	assert.equal(s.committedPercent, 8);
	assert.equal(s.freePercent, 10);
	assert.equal(s.calibrated, true);
	assert.equal(s.state, "ok");
});

test("short when the projection at reset passes 100", () => {
	const s = state({ samples: [reading(80, NOW - 2 * HOUR), reading(90, NOW)] });
	assert.equal(s.burnPerHour, 5);
	assert.equal(s.hoursLeft, 12);
	assert.equal(s.projectedAtResetPercent, 150);
	assert.equal(s.state, "short");
});

test("tight between 88 and 100", () => {
	const s = state({ samples: [reading(69, NOW - 2 * HOUR), reading(72, NOW)] });
	assert.equal(s.burnPerHour, 1.5);
	assert.equal(s.projectedAtResetPercent, 90);
	assert.equal(s.state, "tight");
});

test("tight when free drops below 5% even with no projection", () => {
	const s = state({ samples: [reading(90, NOW - 30 * MIN)] });
	assert.equal(s.burnPerHour, null);
	assert.equal(s.projectedAtResetPercent, null);
	assert.equal(s.freePercent, 0);
	assert.equal(s.state, "tight");
});

test("unknown when stale, never ok; unknown when there is no reading", () => {
	const stale = state({ samples: [reading(20, NOW - 30 * MIN)], stale: true });
	assert.equal(stale.state, "unknown");
	const none = state({ samples: [] });
	assert.equal(none.state, "unknown");
	assert.equal(none.usedPercent, null);
	assert.equal(none.freePercent, null);
	assert.equal(none.safeDailyPercent, null);
	assert.equal(none.resetsAtMs, null);
});

test("safe daily percent spreads the unreserved headroom over the hours left", () => {
	const s = state({ samples: [reading(70, NOW - 30 * MIN)] });
	assert.equal(s.hoursLeft, 12);
	assert.equal(s.safeDailyPercent, 36); // (100 - 12 - 70) / (12 / 24)
});

test("uncalibrated windows have no committed percent", () => {
	const s = state({ calibration: { calibrated: false, percentPerUsd: null, low: null, high: null }, committedUsd: 20 });
	assert.equal(s.calibrated, false);
	assert.equal(s.committedPercent, null);
	assert.equal(s.percentPerUsd, null);
	assert.equal(s.freePercent, 18); // 100 - 70 - 12
});

test("capacityCheck fits inside both auto-approve bands", () => {
	const states = [state({ samples: [reading(70, NOW - 30 * MIN)], calibration: FLAT })];
	const check = capacityCheck({ states, reserveUsd: 2, byModel: { "claude-opus-5-5:high": 10 }, cfg: CFG });
	assert.equal(check.fits, true);
	assert.equal(check.ownerLevel, false);
	assert.equal(check.perWindow[0].requiredPercent, 2);
	assert.equal(check.perWindow[0].usablePercent, 88);
	assert.equal(check.perWindow[0].freePercent, 18);
});

test("capacityCheck: between the auto and owner bands is not a fit but not owner-level", () => {
	const states = [state({ samples: [reading(70, NOW - 30 * MIN)], calibration: FLAT })];
	const check = capacityCheck({ states, reserveUsd: 10, byModel: { "claude-opus-5-5:high": 10 }, cfg: CFG });
	assert.equal(check.perWindow[0].requiredPercent, 10);
	assert.equal(check.fits, false); // 10 > 10% of 88 usable
	assert.equal(check.ownerLevel, false); // 10 <= 25% of 88 and <= 18 free
});

test("capacityCheck: owner level above 25% of usable or above free, and on an applicable short window", () => {
	const states = [state({ samples: [reading(70, NOW - 30 * MIN)], calibration: FLAT })];
	const owner = capacityCheck({ states, reserveUsd: 30, byModel: { "claude-opus-5-5:high": 10 }, cfg: CFG });
	assert.equal(owner.perWindow[0].requiredPercent, 30);
	assert.equal(owner.ownerLevel, true);
	assert.equal(owner.fits, false);

	const short = state({ samples: [reading(80, NOW - 2 * HOUR), reading(90, NOW)] });
	assert.equal(short.state, "short");
	const byShort = capacityCheck({
		states: [short],
		reserveUsd: 0,
		byModel: { "claude-opus-5-5:high": 5 },
		cfg: CFG,
	});
	assert.equal(byShort.ownerLevel, true);
});

test("capacityCheck: a scoped window requires only the share of models it applies to", () => {
	const flat = FLAT;
	const scoped = windowState({
		account: "anthropic-subscription/default",
		window: { id: "claude:7d_fable", label: "7d", windowMinutes: 10080, scope: "fable" },
		samples: [reading(50, NOW - 30 * MIN)],
		calibration: flat,
		committedUsd: 0,
		now: NOW,
		cfg: CFG,
		stale: false,
	});
	const open = state({ samples: [reading(50, NOW - 30 * MIN)], calibration: flat });
	const check = capacityCheck({
		states: [open, scoped],
		reserveUsd: 10,
		byModel: { "claude-opus-5-5:high": 8, "claude-fable-5:high": 2 },
		cfg: CFG,
	});
	assert.deepEqual(check.perWindow.map((w) => w.windowId), ["claude:7d", "claude:7d_fable"]);
	assert.equal(check.perWindow[0].requiredPercent, 10); // applies to every model: share 1
	assert.equal(check.perWindow[1].requiredPercent, 2); // fable share 2 / 10
	assert.equal(scoped.scope, "fable");
});

test("summarize takes the worst state and is unknown only when every window is unknown", () => {
	const ok = state({ samples: [reading(50, NOW - 30 * MIN)] });
	const stale = state({ samples: [reading(50, NOW - 30 * MIN)], stale: true });
	const short = state({ samples: [reading(80, NOW - 2 * HOUR), reading(90, NOW)] });
	assert.equal(summarize([ok, stale]).state, "ok");
	assert.equal(summarize([short, ok]).state, "short");
	assert.equal(summarize([stale]).state, "unknown");
	assert.equal(summarize([]).state, "unknown");
	const summary = summarize([ok]);
	assert.equal(summary.windows.length, 1);
	assert.equal(summary.windows[0], ok);
});

test("QA failure: burn from fewer than 2 samples gives projected null and state is not short", () => {
	const s = state({ samples: [reading(95, NOW - 30 * MIN)] });
	assert.equal(s.burnPerHour, null);
	assert.equal(s.projectedAtResetPercent, null);
	assert.notEqual(s.state, "short");
	assert.equal(s.state, "tight");
});
