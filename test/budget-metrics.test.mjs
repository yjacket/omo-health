import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditAllowed, indicators, triggers } from "../src/budget/metrics.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CFG = {
	checkpointPercent: 80,
	audit: {
		perProjectDay: 2,
		perDay: 4,
		minGapMs: 6 * HOUR,
		roundsRecord: 3,
		roundsAudit: 4,
		roundsCostUsd: 10,
		roundsHard: 6,
		overForecastPercent: 20,
		afterAcceptUsd: 5,
		descendantUsd: 25,
		descendantFraction: 0.2,
	},
};

// KST (UTC+9) timestamp, as the measured findings table is written.
function kst(day, hour, minute) {
	return Date.UTC(2026, 10, day, hour - 9, minute);
}

// hwp-birsom measured table: first appearance of each numbered round (KST) and the
// cumulative main-session USD at that moment.
const HWP = [
	[2, kst(5, 13, 21), 65],
	[1, kst(5, 14, 36), 69],
	[4, kst(5, 21, 17), 87],
	[6, kst(5, 23, 43), 91],
	[7, kst(6, 3, 8), 94],
	[8, kst(6, 5, 29), 100],
	[9, kst(6, 7, 44), 104],
	[10, kst(6, 10, 11), 111],
	[11, kst(6, 12, 40), 115],
	[12, kst(6, 15, 10), 119],
	[19, kst(7, 6, 22), 147],
	[20, kst(10, 23, 9), 156],
	[30, kst(12, 7, 38), 201],
	[35, kst(12, 17, 44), 225],
];

function hwpRounds(count) {
	return HWP.slice(0, count).map(([round, firstMs]) => ({ round, firstMs }));
}

// Cumulative main-session USD at `ms`: the measured total of the latest round seen so far.
function hwpCumulative(ms) {
	let costUsd = 0;
	for (const [, firstMs, cumulative] of HWP) {
		if (firstMs <= ms) costUsd = cumulative;
	}
	return costUsd;
}

// spendSince(ms) means spend after `ms`; bound it to the moment being inspected.
function hwpSpendSinceAt(nowMs) {
	const total = hwpCumulative(nowMs);
	return (ms) => ({ costUsd: total - hwpCumulative(ms) });
}

function projectWith({ approvedUsd = 0, adjusted = null } = {}) {
	const data = { estimates: [], approvals: [] };
	if (adjusted) data.estimates.push({ requestId: "r1", kind: "estimate", adjusted });
	if (Number.isFinite(approvedUsd))
		data.approvals.push({ revision: 1, ms: 0, approvedUsd, by: "rule", basis: "test" });
	return { id: "p1", data };
}

test("hwp-birsom: first heavy rounds trigger at the 4th distinct round (round 6, $91)", () => {
	const spend = { costUsd: 87, childUsd: 0 };
	const three = indicators({
		project: projectWith(),
		rounds: hwpRounds(3),
		spend,
		spendSince: hwpSpendSinceAt(kst(5, 21, 17)),
		now: kst(5, 21, 17),
	});
	assert.equal(three.roundsCount, 3);
	assert.equal(three.firstRoundMs, kst(5, 13, 21));
	assert.equal(three.roundsCostUsd, 87 - 65);
	const light = triggers(three, CFG);
	assert.equal(light.length, 1);
	assert.equal(light[0].kind, "rounds");
	assert.equal(light[0].heavy, false);

	const four = indicators({
		project: projectWith(),
		rounds: hwpRounds(4),
		spend: { costUsd: 91, childUsd: 0 },
		spendSince: hwpSpendSinceAt(kst(5, 23, 43)),
		now: kst(5, 23, 43),
	});
	assert.equal(four.roundsCount, 4);
	assert.equal(four.firstRoundMs, kst(5, 13, 21));
	assert.equal(hwpCumulative(kst(5, 23, 43)), 91);
	assert.equal(four.roundsCostUsd, 91 - 65);
	assert.match(triggers(four, CFG)[0].detail, /\$26\.00 since round 1/);
	const heavy = triggers(four, CFG);
	assert.equal(heavy.length, 1);
	assert.equal(heavy[0].kind, "rounds");
	assert.equal(heavy[0].heavy, true);

	// 4 rounds before the cost threshold are still light.
	const cheap = indicators({
		project: projectWith(),
		rounds: hwpRounds(4),
		spend,
		spendSince: () => 9,
		now: kst(5, 23, 43),
	});
	assert.equal(triggers(cheap, CFG)[0].heavy, false);
});

test("normal long-run series with no numbered rounds has no trigger at all", () => {
	const ind = indicators({
		project: projectWith({ approvedUsd: 60 }),
		rounds: [],
		spend: { costUsd: 40, childUsd: 5 },
		spendSince: () => 0,
		now: kst(10, 12, 0),
	});
	assert.equal(ind.roundsCount, 0);
	assert.equal(ind.firstRoundMs, null);
	assert.equal(ind.roundsCostUsd, 0);
	assert.equal(ind.childShare, 5 / 40);
	assert.deepEqual(triggers(ind, CFG), []);
});

test("after-accept and descendant spend are heavy triggers on their thresholds", () => {
	const ind = indicators({
		project: projectWith({ approvedUsd: 100 }),
		rounds: [],
		spend: { costUsd: 50, childUsd: 10 },
		spendSince: (ms) => (ms === 1000 ? 6 : 0),
		criteria: { allEvidencedMs: 1000 },
		now: kst(10, 12, 0),
	});
	assert.equal(ind.afterAcceptUsd, 6);
	const out = triggers(ind, CFG, { child24hUsd: 25 });
	assert.deepEqual(
		out.map((entry) => [entry.kind, entry.heavy]),
		[["after-accept", true], ["descendants", true]],
	);
	// 20% of $100 approved = $20 is below the $25 floor.
	const quietDescendants = triggers({ ...ind, afterAcceptUsd: null }, CFG, { child24hUsd: 24 });
	assert.deepEqual(quietDescendants, []);
	const fractionDescendants = triggers({ ...ind, afterAcceptUsd: null, approvedUsd: 500 }, CFG, { child24hUsd: 100 });
	assert.equal(fractionDescendants[0].kind, "descendants");
	assert.equal(fractionDescendants[0].heavy, true);
});

test("auditAllowed: one in flight, 2 per project per day, 4 per day, 6 h gap", () => {
	const now = kst(10, 12, 0);
	const base = { project: { id: "p1" }, now, cfg: CFG };
	assert.deepEqual(auditAllowed(base), { allowed: true, reason: null });

	assert.deepEqual(
		auditAllowed({ ...base, history: [{ projectId: "p1", ms: now - HOUR, status: "started" }] }),
		{ allowed: false, reason: "in-flight" },
	);
	assert.deepEqual(
		auditAllowed({
			...base,
			history: [
				{ projectId: "p1", ms: now - 20 * HOUR, status: "done" },
				{ projectId: "p1", ms: now - 7 * HOUR, status: "done" },
			],
		}),
		{ allowed: false, reason: "project-day-cap" },
	);
	assert.deepEqual(
		auditAllowed({
			...base,
			history: ["p2", "p3", "p4", "p5"].map((id) => ({ projectId: id, ms: now - 7 * HOUR, status: "done" })),
		}),
		{ allowed: false, reason: "day-cap" },
	);
	assert.deepEqual(
		auditAllowed({ ...base, history: [{ projectId: "p1", ms: now - 2 * HOUR, status: "done" }] }),
		{ allowed: false, reason: "min-gap" },
	);
	assert.deepEqual(
		auditAllowed({ ...base, history: [{ projectId: "p1", ms: now - 2 * HOUR, status: "done" }], newEvidence: true }),
		{ allowed: true, reason: null },
	);
	assert.deepEqual(
		auditAllowed({ ...base, history: [{ projectId: "p1", ms: now - 7 * HOUR, status: "done" }] }),
		{ allowed: true, reason: null },
	);
	// A project-scoped history (C-store shape) has no projectId and is all this project's.
	assert.deepEqual(auditAllowed({ ...base, history: [{ ms: now - 2 * HOUR, status: "failed" }] }), {
		allowed: false,
		reason: "min-gap",
	});
});

test("forecast anchors on the adjusted p50 fixed at estimation time", () => {
	const project = projectWith({
		approvedUsd: 30,
		adjusted: { p50Usd: 30, reserveUsd: 34, ratio: 1, basis: "n=0 reference projects; ratio 1.00" },
	});
	const atEstimate = indicators({
		project,
		rounds: [],
		spend: { costUsd: 10, childUsd: 0 },
		spendSince: () => 0,
		now: 0,
	});
	assert.equal(atEstimate.forecastUsd, 30);
	assert.equal(atEstimate.forecastOverPercent, 0);

	const later = indicators({
		project,
		rounds: [],
		spend: { costUsd: 17, childUsd: 0 },
		spendSince: () => 0,
		now: 0,
	});
	assert.equal(later.forecastUsd, 30);
	assert.equal(later.forecastOverPercent, 0);
	assert.equal(
		triggers(later, CFG).some((entry) => entry.kind === "budget"),
		false,
	);

	const over = indicators({
		project,
		rounds: [],
		spend: { costUsd: 36, childUsd: 0 },
		spendSince: () => 0,
		now: 0,
	});
	assert.equal(over.forecastUsd, 36);
	assert.equal(over.forecastOverPercent, 20);
	const budget = triggers(over, CFG).find((entry) => entry.kind === "budget");
	assert.equal(budget.heavy, true);

	// No adjusted estimate => no forecast, so no budget trigger.
	const cold = indicators({ project: projectWith({ approvedUsd: 30 }), rounds: [], spend: { costUsd: 36 }, now: 0 });
	assert.equal(cold.forecastUsd, null);
	assert.equal(cold.forecastOverPercent, null);
	assert.equal(
		triggers(cold, CFG).some((entry) => entry.kind === "budget" && entry.heavy),
		false,
	);
});

test("QA failure: 2 rounds with $500 spend produce no rounds trigger", () => {
	const ind = indicators({
		project: projectWith(),
		rounds: [
			{ round: 1, firstMs: 0 },
			{ round: 2, firstMs: HOUR },
		],
		spend: { costUsd: 500, childUsd: 0 },
		spendSince: () => 500,
		now: 2 * HOUR,
	});
	assert.equal(ind.roundsCount, 2);
	assert.equal(ind.roundsCostUsd, 500);
	assert.deepEqual(triggers(ind, CFG), []);
});
