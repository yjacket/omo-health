import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/budget/projects.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const CFG = DEFAULT_CONFIG.budget;
const REF = Object.freeze({ n: 0, p50: null, p80: null, p90: null, errorRatio: null, calibrated: false });
const ACTIVE_GOAL = Object.freeze({ status: "active" });

function project(over = {}) {
	return {
		id: "p1",
		sessionId: "sess-root",
		goalId: "g1",
		cwd: "/work",
		objective: "ship the parser",
		createdMs: NOW - 2 * HOUR,
		status: "tracking",
		revision: 0,
		closedMs: null,
		updatedMs: NOW,
		data: {},
		...over,
	};
}

function capacity(over = {}) {
	return () => ({
		fits: true,
		ownerLevel: false,
		perWindow: [{ windowId: "claude:7d", requiredPercent: 4, freePercent: 60, usablePercent: 88 }],
		...over,
	});
}

function estimateBlock({
	requestId = "req-1",
	baseRevision = 0,
	projectId = "p1",
	p10 = 5,
	p50 = 10,
	p90 = 20,
} = {}) {
	return {
		kind: "estimate",
		body: JSON.stringify({
			v: 1,
			requestId,
			projectId,
			baseRevision,
			remainingUsd: { p10, p50, p90 },
			workClass: "implementation",
			basis: { workUnits: [{ description: "api endpoints", count: 2 }], assumptions: ["no schema change"] },
			nextCheckpoint: "after the handler tests pass",
		}),
	};
}

function changeBlock({
	requestId = "chg-1",
	baseRevision = 1,
	projectId = "p1",
	p10 = 3,
	p50 = 4,
	p90 = 4,
} = {}) {
	return {
		kind: "change",
		body: JSON.stringify({
			v: 1,
			requestId,
			projectId,
			baseRevision,
			remainingUsd: { p10, p50, p90 },
			workClass: "implementation",
			basis: { workUnits: [{ description: "extra integration", count: 1 }], assumptions: [] },
			nextCheckpoint: "after integration",
			reason: "new-evidence",
			justification: "The vendor API needs a second adapter, discovered while wiring the first one.",
			alternatives: [
				{ description: "skip the second adapter", remainingUsd: { p10: 0, p50: 0, p90: 0 }, tradeoff: "one region unsafe" },
			],
		}),
	};
}

function approvedProject(approvedUsd = 30, over = {}) {
	const { data: overData, ...rest } = over;
	return project({
		status: "approved",
		revision: 1,
		...rest,
		data: {
			approvals: [{ revision: 1, ms: NOW - HOUR, approvedUsd, by: "rule", basis: "cold start" }],
			originalApprovedUsd: approvedUsd,
			estimates: [],
			...overData,
		},
	});
}

function messages(actions, actionKind) {
	return actions.filter((action) => action.type === "message" && (!actionKind || action.actionKind === actionKind));
}

test("rule 2: a tracking project is asked at $10 inclusive spend, never at $9.99", () => {
	const low = evaluate({ project: project(), goal: ACTIVE_GOAL, spend: 9.99, now: NOW, cfg: CFG });
	assert.deepEqual(low.actions, []);
	assert.equal(low.project.status, "tracking");

	const high = evaluate({ project: project(), goal: ACTIVE_GOAL, spend: 10, now: NOW, cfg: CFG });
	assert.equal(high.project.status, "requested");
	assert.equal(high.project.data.requestSentMs, NOW);
	const [request] = messages(high.actions, "budget-request");
	assert.ok(request, "one budget-request");
	assert.equal(request.data.projectId, "p1");
	assert.equal(request.data.sessionId, "sess-root");
	assert.equal(request.data.spentAtEstimateUsd, 10);

	const again = evaluate({ project: high.project, goal: ACTIVE_GOAL, spend: 11, now: NOW + MIN, cfg: CFG });
	assert.deepEqual(again.actions, [], "one request per project");
});

test("rule 3: an invalid block gets exactly one correction per project", () => {
	const bad = (requestId) => ({
		kind: "estimate",
		body: JSON.stringify({
			v: 1,
			requestId,
			projectId: "p1",
			baseRevision: 0,
			remainingUsd: { p10: 5, p50: 3, p90: 9 },
			workClass: "implementation",
			basis: { workUnits: [{ description: "api", count: 1 }], assumptions: [] },
			nextCheckpoint: "soon",
		}),
	});
	const first = evaluate({
		project: project({ status: "requested", data: { requestSentMs: NOW - MIN } }),
		blocks: [bad("bad-1"), bad("bad-2")],
		now: NOW,
		cfg: CFG,
	});
	const corrections = messages(first.actions, "budget-correction");
	assert.equal(corrections.length, 1);
	assert.ok(corrections[0].data.errors.some((error) => error.includes("remainingUsd")));
	assert.equal(first.project.data.correctionSentMs, NOW);

	const second = evaluate({
		project: first.project,
		blocks: [bad("bad-3")],
		now: NOW + MIN,
		cfg: CFG,
	});
	assert.deepEqual(second.actions, [], "no second correction");
});

test("rule 3: an approved $30 project sending a valid-looking estimate gets a change-kind correction and keeps 30", () => {
	const base = approvedProject(30);
	const result = evaluate({
		project: base,
		blocks: [estimateBlock({ requestId: "greedy-1", baseRevision: 1, p50: 190, p90: 200 })],
		now: NOW,
		cfg: CFG,
	});
	const [correction] = messages(result.actions, "budget-correction");
	assert.ok(correction, "a correction is sent");
	assert.ok(
		correction.data.errors.some(
			(error) =>
				error.includes('kind="change"') && error.includes("already has an approved budget"),
		),
		"correction names the change protocol",
	);
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.revision, 1);
	assert.equal(result.project.data.approvals.length, 1);
	assert.equal(result.project.data.approvals[0].approvedUsd, 30);
	assert.equal(result.project.data.approvals[0].by, "rule");
	assert.equal(result.project.data.originalApprovedUsd, 30);
});

test("rule 3: an owner-level estimate with free capacity goes to the auditor, not the owner", () => {
	const result = evaluate({
		project: project({ status: "requested", data: { requestSentMs: NOW - MIN } }),
		blocks: [estimateBlock()],
		capacity: capacity({ ownerLevel: true }),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "pending");
	assert.equal(result.project.data.pending.route, "auditor");
	assert.equal(result.project.data.pending.kind, "estimate");
	assert.equal(result.project.data.pending.increaseUsd, 6);
	assert.equal(result.project.data.approvals.length, 0);
	const audit = result.actions.find((action) => action.type === "audit");
	assert.deepEqual(audit.reasons, ["change-review"]);
	const [decision] = messages(result.actions, "budget-decision");
	assert.equal(decision.data.status, "pending-auditor");
	assert.equal(decision.data.approvedUsd, 10, "the implicit allowance stays in force while the auditor looks");
});

test("rule 3: an estimate that does not fit capacity is denied by rule and returns to requested", () => {
	const result = evaluate({
		project: project({ status: "requested", data: { requestSentMs: NOW - MIN } }),
		blocks: [estimateBlock()],
		capacity: capacity({
			fits: false,
			ownerLevel: true,
			perWindow: [{ windowId: "claude:7d", requiredPercent: 120, freePercent: 10, usablePercent: 88, resetsAtMs: NOW + DAY }],
		}),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "requested");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.data.approvals.length, 0);
	assert.equal(result.project.data.estimates.length, 1, "the estimate is still recorded");
	const decisions = messages(result.actions, "budget-decision");
	assert.equal(decisions.length, 1);
	assert.equal(decisions[0].data.status, "denied");
	assert.equal(decisions[0].data.by, "rule");
	assert.equal(decisions[0].data.reason, "insufficient-capacity");
	assert.equal(decisions[0].data.resetAtMs, NOW + DAY);
	assert.equal(decisions[0].data.approvedUsd, 10, "the implicit allowance stays in force");
});

test("rule 3: an estimate sent while the auditor decision is pending is corrected and leaves the pending request untouched", () => {
	const pending = project({
		status: "pending",
		revision: 0,
		data: {
			requestSentMs: NOW - HOUR,
			estimates: [{ requestId: "req-aud", ms: NOW - HOUR, kind: "estimate", raw: {}, adjusted: { reserveUsd: 112 } }],
			approvals: [],
			pending: { requestId: "req-aud", kind: "estimate", increaseUsd: 102, route: "auditor", sinceMs: NOW - HOUR },
		},
	});
	const result = evaluate({
		project: pending,
		blocks: [estimateBlock({ requestId: "req-sneak", baseRevision: 0, p50: 100, p90: 120 })],
		capacity: capacity(),
		now: NOW,
		cfg: CFG,
	});
	const corrections = messages(result.actions, "budget-correction");
	assert.equal(corrections.length, 1);
	assert.ok(corrections[0].data.errors.includes("project is pending a decision"));
	assert.equal(result.project.status, "pending");
	assert.deepEqual(result.project.data.pending, pending.data.pending);
	assert.equal(result.project.data.approvals.length, 0, "no approval is pushed");
	assert.deepEqual(result.project.data.estimates.map((entry) => entry.requestId), ["req-aud"]);
	assert.deepEqual(messages(result.actions, "budget-decision"), []);
});

test("rule 7: a pending project with an approved budget still gets its 80 and 100 checkpoints", () => {
	const pending = approvedProject(100, {
		status: "pending",
		revision: 2,
		data: {
			pending: { requestId: "chg-1", kind: "change", increaseUsd: 10, route: "auditor", sinceMs: NOW - HOUR },
		},
	});
	const at80 = evaluate({ project: pending, goal: ACTIVE_GOAL, spend: 85, now: NOW, cfg: CFG });
	const checkpoints80 = messages(at80.actions, "budget-checkpoint");
	assert.equal(checkpoints80.length, 1);
	assert.equal(checkpoints80[0].data.percent, 80);

	const at100 = evaluate({ project: pending, goal: ACTIVE_GOAL, spend: 100, now: NOW, cfg: CFG });
	const checkpoints100 = messages(at100.actions, "budget-checkpoint");
	assert.equal(checkpoints100.length, 1);
	assert.equal(checkpoints100[0].data.percent, 100);
	assert.deepEqual(at100.project.data.checkpoints["2"], [100]);
});

test("rule 4: two small changes whose cumulative increase passes 20% go to the auditor", () => {
	const first = evaluate({
		project: approvedProject(30),
		spend: 30,
		blocks: [changeBlock({ requestId: "chg-a", baseRevision: 1, p50: 4, p90: 4 })],
		capacity: capacity(),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(first.project.status, "approved");
	assert.equal(first.project.revision, 2);
	assert.equal(first.project.data.approvals.at(-1).approvedUsd, 34);
	assert.equal(first.project.data.autoIncreasesUsd, 4);

	const second = evaluate({
		project: first.project,
		spend: 34,
		blocks: [changeBlock({ requestId: "chg-b", baseRevision: 2, p50: 4, p90: 4 })],
		capacity: capacity(),
		now: NOW + MIN,
		cfg: CFG,
	});
	assert.equal(second.project.status, "pending");
	assert.deepEqual(second.project.data.pending, {
		requestId: "chg-b",
		kind: "change",
		increaseUsd: 4,
		route: "auditor",
		sinceMs: NOW + MIN,
	});
	assert.equal(second.project.data.approvals.length, 2, "the cumulative limit blocks auto approval");
	const audit = second.actions.find((action) => action.type === "audit");
	assert.deepEqual(audit.reasons, ["change-review"]);
});

test("rule 5: an auditor support verdict approves the pending change by auditor", () => {
	const base = approvedProject(30, {
		status: "pending",
		revision: 2,
		data: {
			pending: { requestId: "chg-aud", kind: "change", increaseUsd: 10, route: "auditor", sinceMs: NOW - MIN },
			estimates: [{ requestId: "chg-aud", ms: NOW - MIN, kind: "change", raw: {}, adjusted: { reserveUsd: 40 } }],
		},
	});
	const result = evaluate({
		project: base,
		auditResult: { assessment: "justified", allocationOpinion: { assessment: "support", reason: "new acceptance evidence" } },
		capacity: capacity(),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.revision, 3);
	assert.equal(result.project.data.approvals.at(-1).by, "auditor");
	assert.equal(result.project.data.approvals.at(-1).approvedUsd, 40);
	const [decision] = messages(result.actions, "budget-decision");
	assert.equal(decision.data.status, "approved");
	assert.equal(decision.data.approvedUsd, 40);
});

test("rule 5: the auditor approving an owner-level request approves it when capacity has room", () => {
	const base = approvedProject(30, {
		status: "pending",
		revision: 2,
		data: {
			pending: { requestId: "chg-aud", kind: "change", increaseUsd: 10, route: "auditor", sinceMs: NOW - MIN },
		},
	});
	const result = evaluate({
		project: base,
		auditResult: { assessment: "justified", allocationOpinion: { assessment: "support", reason: "new acceptance evidence" } },
		capacity: capacity({ ownerLevel: true }),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.data.approvals.length, 2);
	assert.equal(result.project.data.approvals.at(-1).by, "auditor");
	assert.equal(result.project.data.approvals.at(-1).approvedUsd, 40);
});

test("rule 5: an auditor revise denies the pending change by auditor with the opinion's reason", () => {
	const base = approvedProject(30, {
		status: "pending",
		revision: 2,
		data: {
			pending: { requestId: "chg-rev", kind: "change", increaseUsd: 10, route: "auditor", sinceMs: NOW - MIN },
		},
	});
	const result = evaluate({
		project: base,
		auditResult: { assessment: "justified", allocationOpinion: { assessment: "revise", reason: "the extra round repeats checks already covered" } },
		capacity: capacity(),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.data.approvals.length, 1);
	assert.equal(result.project.data.approvals[0].approvedUsd, 30);
	const [decision] = messages(result.actions, "budget-decision");
	assert.equal(messages(result.actions, "budget-decision").length, 1);
	assert.equal(decision.data.status, "denied");
	assert.equal(decision.data.by, "auditor");
	assert.equal(decision.data.basis, "the extra round repeats checks already covered");
	assert.equal(decision.data.approvedUsd, 30);
});

test("rule 5: an audit that could not run is a rule denial with audit-unavailable", () => {
	const base = approvedProject(30, {
		status: "pending",
		revision: 2,
		data: {
			pending: { requestId: "chg-unavail", kind: "change", increaseUsd: 10, route: "auditor", sinceMs: NOW - MIN },
		},
	});
	const result = evaluate({
		project: base,
		auditResult: { status: "unavailable", reason: "no capable model" },
		capacity: capacity(),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.data.approvals.length, 1);
	const [decision] = messages(result.actions, "budget-decision");
	assert.equal(decision.data.status, "denied");
	assert.equal(decision.data.by, "rule");
	assert.equal(decision.data.reason, "audit-unavailable");
	assert.equal(decision.data.approvedUsd, 30);
});

test("rule 4: a change that does not fit capacity is denied by rule with the earliest binding reset", () => {
	const earlyReset = NOW + 2 * DAY;
	const result = evaluate({
		project: approvedProject(30),
		spend: 30,
		blocks: [changeBlock({ requestId: "chg-cap", baseRevision: 1, p50: 10, p90: 10 })],
		capacity: capacity({
			fits: false,
			ownerLevel: true,
			perWindow: [
				{ windowId: "claude:7d", requiredPercent: 40, freePercent: 60, usablePercent: 88, resetsAtMs: NOW + 5 * DAY },
				{ windowId: "codex:primary", requiredPercent: 120, freePercent: 10, usablePercent: 88, resetsAtMs: earlyReset },
			],
		}),
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	assert.equal(result.project.data.pending, null);
	assert.equal(result.project.data.approvals.length, 1);
	assert.equal(result.project.data.approvals[0].approvedUsd, 30);
	assert.equal(result.project.data.estimates.at(-1).requestId, "chg-cap");
	const decisions = messages(result.actions, "budget-decision");
	assert.equal(decisions.length, 1);
	assert.equal(decisions[0].data.status, "denied");
	assert.equal(decisions[0].data.by, "rule");
	assert.equal(decisions[0].data.reason, "insufficient-capacity");
	assert.equal(decisions[0].data.resetAtMs, earlyReset);
	assert.equal(decisions[0].data.approvedUsd, 30);
});

test("rule 4: a short treasury window blocks without a per-window reset and falls back to the treasury", () => {
	const reset = NOW + 3 * DAY;
	const result = evaluate({
		project: approvedProject(30),
		spend: 30,
		blocks: [changeBlock({ requestId: "chg-short", baseRevision: 1 })],
		capacity: capacity({
			fits: false,
			ownerLevel: true,
			perWindow: [{ windowId: "claude:7d", requiredPercent: 30, freePercent: 60, usablePercent: 88 }],
		}),
		treasury: { state: "short", windows: [{ windowId: "claude:7d", state: "short", resetsAtMs: reset }] },
		now: NOW,
		cfg: CFG,
	});
	assert.equal(result.project.status, "approved");
	const [decision] = messages(result.actions, "budget-decision");
	assert.equal(decision.data.status, "denied");
	assert.equal(decision.data.reason, "insufficient-capacity");
	assert.equal(decision.data.resetAtMs, reset);
});

test("rule 7: 80 and 100 checkpoints are sent once per revision; both crossed at once means only 100", () => {
	const at80 = evaluate({ project: approvedProject(100), goal: ACTIVE_GOAL, spend: 85, now: NOW, cfg: CFG });
	const [checkpoint80] = messages(at80.actions, "budget-checkpoint");
	assert.equal(checkpoint80.data.percent, 80);
	assert.deepEqual(at80.project.data.checkpoints["1"], [80]);

	const repeat = evaluate({ project: at80.project, goal: ACTIVE_GOAL, spend: 85, now: NOW + MIN, cfg: CFG });
	assert.deepEqual(messages(repeat.actions, "budget-checkpoint"), []);

	const at100 = evaluate({ project: at80.project, goal: ACTIVE_GOAL, spend: 100, now: NOW + 2 * MIN, cfg: CFG });
	const [checkpoint100] = messages(at100.actions, "budget-checkpoint");
	assert.equal(checkpoint100.data.percent, 100);
	assert.deepEqual(at100.project.data.checkpoints["1"], [80, 100]);

	const coalesced = evaluate({ project: approvedProject(100), goal: ACTIVE_GOAL, spend: 100, now: NOW, cfg: CFG });
	const checkpoints = messages(coalesced.actions, "budget-checkpoint");
	assert.equal(checkpoints.length, 1);
	assert.equal(checkpoints[0].data.percent, 100);
	assert.deepEqual(coalesced.project.data.checkpoints["1"], [100]);
});

test("QA failure: a completed goal still inside its grace window is never asked for a budget", () => {
	const goal = { status: "completed", closedMs: NOW };
	const result = evaluate({ project: project(), goal, spend: 50, now: NOW + MIN, cfg: CFG });
	assert.deepEqual(messages(result.actions, "budget-request"), [], "no budget-request");
	assert.deepEqual(result.actions, [], "no action at all");
	assert.equal(result.project.status, "tracking", "status keeps tracking");
	assert.equal(result.project.data.requestSentMs, undefined, "the request is not used up");

	// The same project asked once the goal is active gets its request.
	const active = evaluate({ project: result.project, goal: ACTIVE_GOAL, spend: 50, now: NOW + 2 * MIN, cfg: CFG });
	assert.equal(messages(active.actions, "budget-request").length, 1);
	assert.equal(active.project.status, "requested");
});

test("QA failure: goal statuses outside the ACTIVE set send no request and no checkpoint, case-insensitively", () => {
	for (const status of ["paused", "blocked", "Completed", "CANCELLED", "cleared", "replaced"]) {
		const goal = { status, closedMs: NOW };
		const result = evaluate({
			project: approvedProject(100),
			goal,
			spend: 100,
			now: NOW + MIN,
			cfg: CFG,
		});
		assert.deepEqual(result.actions, [], `no action for a ${status} goal`);
		assert.deepEqual(
			result.project.data.checkpoints ?? {},
			{},
			`no checkpoint marked sent for a ${status} goal`,
		);
	}

	for (const status of ["active", "RUNNING", "in_progress", "Pending"]) {
		const goal = { status };
		const tracking = evaluate({ project: project(), goal, spend: 50, now: NOW, cfg: CFG });
		assert.equal(messages(tracking.actions, "budget-request").length, 1, `request for ${status}`);
		const approved = evaluate({ project: approvedProject(100), goal, spend: 100, now: NOW, cfg: CFG });
		assert.equal(messages(approved.actions, "budget-checkpoint").length, 1, `checkpoint for ${status}`);
	}
});

test("qa behavior: a paused goal keeps tracking spend and sends no checkpoint even at 100%", () => {
	const paused = { status: "paused" };
	const result = evaluate({ project: approvedProject(100), goal: paused, spend: 100, now: NOW, cfg: CFG });
	assert.deepEqual(result.actions, []);
	assert.equal(result.project.status, "approved");
	assert.deepEqual(result.project.data.checkpoints ?? {}, {});

	const resumed = evaluate({ project: result.project, goal: ACTIVE_GOAL, spend: 100, now: NOW + MIN, cfg: CFG });
	const [checkpoint] = messages(resumed.actions, "budget-checkpoint");
	assert.equal(checkpoint?.data.percent, 100, "the checkpoint was not used up while paused");
});

test("complete/replaced goal inside grace: no checkpoint, no request, still no close", () => {
	const goal = { status: "complete", closedMs: NOW };
	const result = evaluate({ project: approvedProject(100), goal, spend: 100, now: NOW + MIN, cfg: CFG });
	assert.deepEqual(result.actions, []);
	assert.equal(result.project.status, "approved");
});

test("rule 1: a completed goal closes after the grace window and records the actual", () => {
	const goal = { status: "completed", closedMs: NOW };
	const early = evaluate({ project: project(), goal, spend: 0, now: NOW + DAY - MIN, cfg: CFG });
	assert.equal(early.project.status, "tracking");

	const closed = evaluate({ project: project(), goal, spend: 12, now: NOW + DAY, cfg: CFG });
	assert.deepEqual(closed.actions, []);
	assert.equal(closed.project.status, "closed");
	assert.equal(closed.project.closedMs, NOW + DAY);
	assert.equal(closed.project.data.outcome, "complete");
	assert.equal(closed.project.data.actualUsd, 12);

	const cancelled = evaluate({
		project: project(),
		goal: { status: "cancelled", closedMs: NOW },
		spend: 3,
		now: NOW,
		cfg: CFG,
	});
	assert.equal(cancelled.project.status, "closed");
	assert.equal(cancelled.project.data.outcome, "cancelled");
});

test("QA failure: a replayed block with an already-seen requestId produces no action", () => {
	const block = estimateBlock({ requestId: "req-seen" });
	const first = evaluate({
		project: project({ status: "requested", data: { requestSentMs: NOW - MIN } }),
		blocks: [block],
		now: NOW,
		cfg: CFG,
	});
	assert.equal(first.project.status, "approved");
	assert.equal(first.project.data.estimates.length, 1);

	const replay = evaluate({ project: first.project, blocks: [block], now: NOW + MIN, cfg: CFG });
	assert.deepEqual(replay.actions, []);
	assert.equal(replay.project.revision, first.project.revision);
	assert.equal(replay.project.data.approvals.length, 1);
});
