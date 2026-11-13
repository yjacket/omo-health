import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { adjust, referenceClass } from "../src/budget/estimates.mjs";

function project(id, actualUsd, { status = "closed", workClass = "implementation", estimates = [], audits = [] } = {}) {
	return {
		id,
		status,
		data: { workClass, outcome: status === "closed" ? "complete" : "cancelled", estimates, audits },
		actualUsd,
	};
}

function estimate(p50, p90, spentAtEstimate) {
	const entry = { requestId: "r1", kind: "estimate", raw: { remainingUsd: { p10: p50, p50, p90 } } };
	if (spentAtEstimate !== undefined) entry.spentAtEstimate = spentAtEstimate;
	return entry;
}

function projects(actuals, options) {
	return actuals.map((actual, index) => project("p" + index, actual, options));
}

test("cold start below 5 closed projects keeps ratio 1 and says so in the basis", () => {
	const ref = referenceClass(projects([10, 20, 30]));
	assert.deepEqual(ref, { n: 3, p50: 20, p80: 26, p90: 28, errorRatio: null, calibrated: false });
	const out = adjust({ p50: 10, p90: 20 }, ref, 5);
	assert.equal(out.ratio, 1);
	assert.equal(out.p50Usd, 15);
	assert.equal(out.reserveUsd, 21);
	assert.match(out.basis, /n=3/);
	assert.match(out.basis, /ratio 1\.00/);
	assert.match(out.basis, /cold start/);
});

test("workClass filter switches on at 5 same-class projects, else uses all", () => {
	const implementation = projects([10, 20, 30, 40, 50], { workClass: "implementation" });
	const debugging = projects([100, 200, 300, 400], { workClass: "debugging" }).map((p, i) =>
		project("d" + i, p.actualUsd, { workClass: "debugging" }),
	);
	const all = [...implementation, ...debugging];
	const implRef = referenceClass(all, { workClass: "implementation" });
	assert.equal(implRef.n, 5);
	assert.equal(implRef.p50, 30);
	assert.equal(implRef.calibrated, true);
	const debugRef = referenceClass(all, { workClass: "debugging" });
	assert.equal(debugRef.n, 9);
	assert.equal(debugRef.p50, 50);
	assert.equal(debugRef.calibrated, true);
});

test("cancelled projects are part of the reference class and zero actuals are not", () => {
	const closed = projects([10, 20, 30]);
	const cancelled = [project("c1", 40, { status: "cancelled" }), project("c2", 50, { status: "cancelled" })];
	const ref = referenceClass([...closed, ...cancelled, project("z", 0)]);
	assert.equal(ref.n, 5);
	assert.equal(ref.calibrated, true);
	assert.equal(ref.p50, 30);
	assert.equal(ref.p80, 42);
	assert.equal(ref.p90, 46);
});

test("errorRatio is the median of actual over spentAtEstimate + first p50, null below 5 estimates", () => {
	const expected = (spent, p50) => [estimate(p50, p50 * 2, spent)];
	const withEstimates = [
		project("a", 5, { estimates: expected(0, 10) }),
		project("b", 10, { estimates: expected(0, 10) }),
		project("c", 20, { estimates: expected(0, 10) }),
		project("d", 30, { estimates: expected(0, 10) }),
		project("e", 40, { estimates: expected(0, 10) }),
		project("f", 100),
	];
	const ref = referenceClass(withEstimates);
	assert.equal(ref.n, 6);
	assert.equal(ref.errorRatio, 2);

	const sparse = referenceClass(withEstimates.slice(0, 4));
	assert.equal(sparse.n, 4);
	assert.equal(sparse.errorRatio, null);
});

test("errorRatio uses the first estimate and clamps median ratios into [0.5, 3]", () => {
	const cheap = [0.1, 0.1, 0.1, 0.1, 10].map((ratio, index) =>
		project("low" + index, 10 * ratio, { estimates: [estimate(0, 20, 10)] }),
	);
	assert.equal(referenceClass(cheap).errorRatio, 0.5);

	const expensive = [20, 30, 40, 50, 100].map((actual, index) =>
		project("high" + index, actual, { estimates: [estimate(0, 20, 10)] }),
	);
	assert.equal(referenceClass(expensive).errorRatio, 3);
});

test("p80 sits at p50 + 0.6 * (p90 - p50) and scales with the ratio", () => {
	const ref = { n: 5, p50: 10, p80: 16, p90: 20, errorRatio: 2, calibrated: true };
	const out = adjust({ p50: 10, p90: 20 }, ref, 5);
	assert.equal(out.ratio, 2);
	assert.equal(out.p50Usd, 25);
	assert.equal(out.reserveUsd, 37);
	assert.doesNotMatch(out.basis, /cold start/);
});

test("adjust of zeros returns the spent amount as both p50 and reserve", () => {
	const ref = referenceClass(projects([10, 20]));
	const out = adjust({ p50: 0, p90: 0 }, ref, 7);
	assert.equal(out.p50Usd, 7);
	assert.equal(out.reserveUsd, 7);
});

test("a project whose latest audit opinion is waste-likely leaves the reference class", () => {
	const audits = [{ auditId: "a1", status: "done", opinion: { assessment: "waste-likely" } }];
	const all = [...projects([10, 20, 30, 40, 50]), project("w", 1000, { audits })];
	const ref = referenceClass(all);
	assert.equal(ref.n, 5);
	assert.equal(ref.p50, 30);
	assert.equal(ref.p90, 46);
	assert.equal(referenceClass(all).errorRatio, referenceClass(projects([10, 20, 30, 40, 50])).errorRatio);
});

test("projects without audits and with justified or insufficient-evidence opinions stay in", () => {
	const noAudits = projects([10, 20]);
	const justified = [project("j", 30, { audits: [{ auditId: "a1", status: "done", opinion: { assessment: "justified" } }] })];
	const unsure = [project("u", 40, { audits: [{ auditId: "a1", status: "done", opinion: { assessment: "insufficient-evidence" } }] })];
	const ref = referenceClass([...noAudits, ...justified, ...unsure]);
	assert.equal(ref.n, 4);
	assert.equal(ref.p50, 25);
});

test("the last opinion wins and opinion-less audits after it do not resurrect a waste-likely verdict", () => {
	const wasWasteThenJustified = [
		project("a", 10, { audits: [
			{ auditId: "a1", status: "done", opinion: { assessment: "waste-likely" } },
			{ auditId: "a2", status: "done", opinion: { assessment: "justified" } },
		] }),
		project("b", 20, { audits: [
			{ auditId: "a1", status: "done", opinion: { assessment: "justified" } },
			{ auditId: "a2", status: "done", opinion: { assessment: "waste-likely" } },
			{ auditId: "a3", status: "running" },
		] }),
	];
	const ref = referenceClass(wasWasteThenJustified);
	assert.equal(ref.n, 1);
	assert.equal(ref.p50, 10);
});

test("errorRatio uses the same filtered set as the percentiles", () => {
	const rows = [20, 20, 40, 60, 80].map((actual, index) =>
		project("r" + index, actual, { estimates: [estimate(10, 20, 10)] }),
	);
	const waste = [{ auditId: "a1", status: "done", opinion: { assessment: "waste-likely" } }];
	const outlier = project("x", 200, { estimates: [estimate(10, 20, 10)], audits: waste });
	const ref = referenceClass([...rows, outlier]);
	assert.equal(ref.n, 5);
	assert.equal(ref.errorRatio, 2);

	const kept = referenceClass([...rows, { ...outlier, data: { ...outlier.data, audits: [] } }]);
	assert.equal(kept.n, 6);
	assert.equal(kept.errorRatio, 2.5);
});

test("an empty reference class is a cold start with no percentiles", () => {
	const ref = referenceClass([]);
	assert.deepEqual(ref, { n: 0, p50: null, p80: null, p90: null, errorRatio: null, calibrated: false });
	const out = adjust({ p50: 4, p90: 6 }, ref, 1);
	assert.equal(out.p50Usd, 5);
	assert.equal(out.reserveUsd, 6.2);
	assert.match(out.basis, /cold start/);
});
