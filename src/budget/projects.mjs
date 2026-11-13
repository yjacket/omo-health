// C-projects: the project lifecycle and approval rules. Pure: the caller supplies the project record,
// the goal, inclusive spend, new blocks, treasury state, a capacity function, the reference class and
// any audit result. Nothing here reads the clock, the config file, or the store. No human approves.

import { adjust } from "./estimates.mjs";
import { validateBlock } from "./protocol.mjs";

const STATUS_TRACKING = "tracking";
const STATUS_REQUESTED = "requested";
const STATUS_APPROVED = "approved";
const STATUS_PENDING = "pending";
const STATUS_CLOSED = "closed";

const DEFAULT_ESTIMATE_AFTER_USD = 10;
const DEFAULT_CHECKPOINT_PERCENT = 80;
const DEFAULT_AUTO_CHANGE_PERCENT = 20;
const DEFAULT_CLOSE_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTLIER_FACTOR = 1.5;

// The same set src/detect/align.mjs uses: only a goal still in flight may be asked for a budget or
// receive a spending checkpoint. A missing goal is not active.
const GOAL_ACTIVE = new Set(["active", "running", "in_progress", "pending"]);

const ESTIMATE_ALREADY_APPROVED_ERROR =
	'project already has an approved budget: send kind="change" with reason, justification and alternatives';
const ESTIMATE_PENDING_ERROR = "project is pending a decision";

function goalIsActive(goal) {
	if (!goal || typeof goal !== "object") return false;
	const status = typeof goal.status === "string" ? goal.status.trim().toLowerCase() : "";
	return GOAL_ACTIVE.has(status);
}

function budgetCfg(cfg) {
	if (cfg && typeof cfg === "object" && cfg.budget && typeof cfg.budget === "object") return cfg.budget;
	return cfg && typeof cfg === "object" ? cfg : {};
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function num(value, fallback) {
	return finite(value) ? value : fallback;
}

function spendUsdOf(spend) {
	if (finite(spend)) return spend;
	if (spend && finite(spend.costUsd)) return spend.costUsd;
	return 0;
}

function byModelOf(spend) {
	if (spend && typeof spend === "object" && spend.byModel && typeof spend.byModel === "object") return spend.byModel;
	return {};
}

function cloneProject(project) {
	const copy = { ...project };
	copy.data = structuredClone(project?.data ?? {});
	return copy;
}

function dataOf(project) {
	if (!project.data || typeof project.data !== "object") project.data = {};
	return project.data;
}

function listOf(data, key) {
	if (!Array.isArray(data[key])) data[key] = [];
	return data[key];
}

function objectOf(data, key) {
	if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
	return data[key];
}

function actionKindMessage(actionKind, sessionId, data) {
	return { type: "message", actionKind, data: { sessionId, ...data } };
}

function currentApprovedUsd(project, implicitUsd) {
	const approvals = Array.isArray(project.data?.approvals) ? project.data.approvals : [];
	const last = approvals.length > 0 ? approvals[approvals.length - 1] : null;
	return last && finite(last.approvedUsd) ? last.approvedUsd : implicitUsd;
}

function safeCapacity(capacity, reserveUsd, byModel) {
	if (typeof capacity !== "function") return { fits: true, ownerLevel: false, perWindow: [] };
	const result = capacity(reserveUsd, byModel);
	return {
		fits: result?.fits !== false,
		ownerLevel: result?.ownerLevel === true,
		perWindow: Array.isArray(result?.perWindow) ? result.perWindow : [],
	};
}

// No human approves anything: an increase may only go to the auditor while every applicable window
// still has room (no short window, required within that window's free capacity). The binding window's
// reset time comes from the capacity entry or the treasury reading, whichever carries it.
function capacityAffordability(check, treasury) {
	const windows = Array.isArray(treasury?.windows) ? treasury.windows : [];
	const windowOf = (windowId) =>
		windows.find((entry) => entry && typeof entry === "object" && entry.windowId === windowId) ?? null;
	const blocked = [];
	for (const entry of Array.isArray(check?.perWindow) ? check.perWindow : []) {
		if (!entry || typeof entry !== "object") continue;
		const running = windowOf(entry.windowId);
		const state = typeof entry.state === "string" ? entry.state : running?.state ?? null;
		const required = finite(entry.requiredPercent) ? entry.requiredPercent : null;
		const free = finite(entry.freePercent) ? entry.freePercent : null;
		// A zero requirement means the window applies to none of the spend (capacityCheck's share 0).
		const applicable = required === null || required > 0;
		const short = state === "short" && applicable;
		const overFree = required !== null && (free === null || required > free);
		if (!short && !overFree) continue;
		const resetsAtMs = finite(entry.resetsAtMs)
			? entry.resetsAtMs
			: finite(running?.resetsAtMs)
				? running.resetsAtMs
				: null;
		blocked.push({ windowId: entry.windowId ?? null, resetsAtMs });
	}
	if (blocked.length === 0) return { fits: true, binding: null };
	blocked.sort((a, b) => (a.resetsAtMs ?? Infinity) - (b.resetsAtMs ?? Infinity));
	return { fits: false, binding: blocked[0] };
}

// A denial keeps the previously approved amount and leaves the project working: status returns to
// approved, or requested when nothing was ever approved. One budget-decision message is sent.
function denyProject(project, ctx, { requestId, increaseUsd, by, basis, reason, resetAtMs }) {
	const data = dataOf(project);
	const approvedUsd = currentApprovedUsd(project, ctx.estimateAfterUsd);
	project.status = listOf(data, "approvals").length > 0 ? STATUS_APPROVED : STATUS_REQUESTED;
	data.pending = null;
	ctx.actions.push({
		type: "event",
		kind: "denied",
		data: { projectId: project.id, requestId: requestId ?? null, increaseUsd, reason },
	});
	ctx.actions.push(
		actionKindMessage(
			"budget-decision",
			project.sessionId,
			decisionData(project, requestId, "denied", approvedUsd, by, basis, [], { reason, resetAtMs }),
		),
	);
}

function decisionData(project, requestId, status, approvedUsd, by, basis, perWindow, extra = null) {
	return {
		projectId: project.id,
		revision: project.revision,
		requestId: requestId ?? null,
		status,
		approvedUsd,
		by: by ?? null,
		basis: basis ?? null,
		reason: extra?.reason ?? null,
		resetAtMs: extra?.resetAtMs ?? null,
		perWindow: perWindow ?? [],
		calibrated: (perWindow ?? []).some((entry) => entry && finite(entry.requiredPercent)),
	};
}

function approveProject(project, { requestId, approvedUsd, by, basis, now }) {
	const data = dataOf(project);
	const approvals = listOf(data, "approvals");
	const original = data.originalApprovedUsd;
	project.revision = num(project.revision, 0) + 1;
	project.status = STATUS_APPROVED;
	project.data.pending = null;
	approvals.push({
		revision: project.revision,
		ms: now,
		approvedUsd,
		by,
		basis: basis ?? "",
	});
	if (!finite(original)) data.originalApprovedUsd = approvedUsd;
}

// Rule 1: a finished goal closes the project once its grace window elapsed (late subagent charges
// are still attributed); a cancelled goal closes at once. Nothing is sent for a closed project.
function closeIfFinished(project, goal, spendUsd, now, graceMs) {
	if (!goal || typeof goal !== "object") return false;
	const status = typeof goal.status === "string" ? goal.status.toLowerCase() : "";
	if (status === "cancelled" || status === "canceled") {
		project.status = STATUS_CLOSED;
		project.closedMs = now;
		const data = dataOf(project);
		data.outcome = "cancelled";
		data.actualUsd = spendUsd;
		return true;
	}
	if (status !== "completed" && status !== "complete" && status !== "replaced") return false;
	const closedMs = finite(goal.closedMs) ? goal.closedMs : finite(project.closedMs) ? project.closedMs : null;
	// No closure time to measure grace from: there is nothing to wait for.
	if (closedMs !== null && now < closedMs + graceMs) return false;
	project.status = STATUS_CLOSED;
	project.closedMs = now;
	const data = dataOf(project);
	data.outcome = status === "replaced" ? "replaced" : "complete";
	data.actualUsd = spendUsd;
	return true;
}

// Rule 3: one new block. Returns the actions it produced and mutates the project through those rules.
function applyBlock(ctx) {
	const { project, block, now, cfg, ref, capacity, byModel, actions } = ctx;
	const data = dataOf(project);
	const parsed = parseBlock(block);
	const requestId = typeof parsed?.value?.requestId === "string" ? parsed.value.requestId : block?.requestId;
	const alreadySeen =
		requestId !== undefined &&
		listOf(data, "estimates").some((entry) => entry && entry.requestId === requestId);
	if (alreadySeen) return;

	const validation = validateBlock(block?.kind, parsed?.value, {
		projectId: project.id,
		revision: num(project.revision, 0),
	});
	let errors = validation.ok ? null : validation.errors;
	const hasApproval = listOf(data, "approvals").length > 0;
	// An estimate is only valid while the project is still waiting for its first decision.
	if (!errors && block?.kind === "estimate") {
		if (hasApproval) {
			errors = [ESTIMATE_ALREADY_APPROVED_ERROR];
		} else if (project.status !== STATUS_REQUESTED && project.status !== STATUS_TRACKING) {
			errors = [
				project.status === STATUS_PENDING
					? ESTIMATE_PENDING_ERROR
					: `project is ${project.status ?? "not accepting estimates"}: an estimate is only valid while requested or tracking`,
			];
		}
	}

	if (errors) {
		// One correction per project: later bad blocks are silent.
		if (finite(data.correctionSentMs)) return;
		data.correctionSentMs = now;
		actions.push(
			actionKindMessage("budget-correction", project.sessionId, {
				projectId: project.id,
				revision: project.revision,
				requestId: requestId ?? null,
				kind: block?.kind ?? null,
				errors,
			}),
		);
		return;
	}

	const value = validation.value;
	const adjusted = adjust(value, ref, ctx.spentUsd);

	if (block.kind === "estimate") {
		const estimates = listOf(data, "estimates");
		estimates.push({ requestId: value.requestId, ms: now, kind: "estimate", raw: value, adjusted });
		const requestedUsd = Math.max(currentApprovedUsd(project, ctx.estimateAfterUsd), adjusted.reserveUsd);
		const check = safeCapacity(capacity, adjusted.reserveUsd, byModel);
		const afford = capacityAffordability(check, ctx.treasury);
		const increaseUsd = Math.max(0, requestedUsd - currentApprovedUsd(project, ctx.estimateAfterUsd));
		if (!afford.fits) {
			denyProject(project, ctx, {
				requestId: value.requestId,
				increaseUsd,
				by: "rule",
				basis: adjusted.basis,
				reason: "insufficient-capacity",
				resetAtMs: afford.binding?.resetsAtMs ?? null,
			});
			return;
		}
		if (check.ownerLevel) {
			project.status = STATUS_PENDING;
			data.pending = {
				requestId: value.requestId,
				kind: "estimate",
				increaseUsd,
				route: "auditor",
				sinceMs: now,
			};
			actions.push({ type: "audit", reasons: ["change-review"] });
			actions.push(
				actionKindMessage(
					"budget-decision",
					project.sessionId,
					decisionData(project, value.requestId, "pending-auditor", currentApprovedUsd(project, ctx.estimateAfterUsd), null, adjusted.basis, check.perWindow),
				),
			);
			return;
		}
		const approvedUsd = requestedUsd;
		approveProject(project, {
			requestId: value.requestId,
			approvedUsd,
			by: "rule",
			basis: adjusted.basis,
			now,
		});
		actions.push(actionKindMessage("budget-decision", project.sessionId, decisionData(project, value.requestId, "approved", approvedUsd, "rule", adjusted.basis, check.perWindow)));
		if (ref?.calibrated === true && finite(ref.p90) && adjusted.p50Usd > ref.p90 * num(cfg?.audit?.outlierFactor, DEFAULT_OUTLIER_FACTOR)) {
			actions.push({ type: "audit", reasons: ["estimate-outlier"] });
		}
		return;
	}

	// Rule 4: a change raises the current budget by the difference to the adjusted reserve.
	const before = currentApprovedUsd(project, ctx.estimateAfterUsd);
	const increaseUsd = Math.max(0, adjusted.reserveUsd - before);
	listOf(data, "estimates").push({ requestId: value.requestId, ms: now, kind: "change", raw: value, adjusted });
	const check = safeCapacity(capacity, adjusted.reserveUsd, byModel);
	const afford = capacityAffordability(check, ctx.treasury);
	if (!afford.fits) {
		denyProject(project, ctx, {
			requestId: value.requestId,
			increaseUsd,
			by: "rule",
			basis: adjusted.basis,
			reason: "insufficient-capacity",
			resetAtMs: afford.binding?.resetsAtMs ?? null,
		});
		return;
	}
	const original = num(data.originalApprovedUsd, ctx.estimateAfterUsd);
	const cumulative = num(data.autoIncreasesUsd, 0) + increaseUsd;
	if (cumulative <= (num(cfg?.autoChangePercent, DEFAULT_AUTO_CHANGE_PERCENT) / 100) * original && check.fits && !check.ownerLevel) {
		const approvedUsd = before + increaseUsd;
		approveProject(project, {
			requestId: value.requestId,
			approvedUsd,
			by: "rule",
			basis: adjusted.basis,
			now,
		});
		data.autoIncreasesUsd = cumulative;
		actions.push(actionKindMessage("budget-decision", project.sessionId, decisionData(project, value.requestId, "approved", approvedUsd, "rule", adjusted.basis, check.perWindow)));
		return;
	}
	project.status = STATUS_PENDING;
	data.pending = { requestId: value.requestId, kind: "change", increaseUsd, route: "auditor", sinceMs: now };
	actions.push({ type: "audit", reasons: ["change-review"] });
	actions.push(actionKindMessage("budget-decision", project.sessionId, decisionData(project, value.requestId, "pending-auditor", before, null, adjusted.basis, check.perWindow)));
}

function parseBlock(block) {
	if (block && typeof block === "object" && block.value && typeof block.value === "object") {
		return { value: block.value };
	}
	const body = block?.body;
	if (typeof body !== "string") return null;
	try {
		const value = JSON.parse(body);
		return value && typeof value === "object" && !Array.isArray(value) ? { value } : null;
	} catch {
		return null;
	}
}

// Rule 5: there is no owner. An auditor support verdict approves the pending request; any other
// assessment denies it with the auditor's reason. No capable model means a rule denial.
function applyAuditResult(ctx) {
	const { project, auditResult, now, capacity, byModel, actions } = ctx;
	const data = dataOf(project);
	const pending = data.pending;
	if (!pending || pending.route !== "auditor" || !auditResult || typeof auditResult !== "object") return;
	const increaseUsd = num(pending.increaseUsd, 0);
	if (auditResult.status === "unavailable") {
		denyProject(project, ctx, {
			requestId: pending.requestId,
			increaseUsd,
			by: "rule",
			basis: null,
			reason: "audit-unavailable",
			resetAtMs: null,
		});
		return;
	}
	const opinionReason = typeof auditResult.allocationOpinion?.reason === "string" ? auditResult.allocationOpinion.reason : "";
	const support =
		auditResult.assessment === "justified" && auditResult.allocationOpinion?.assessment === "support";
	if (!support) {
		denyProject(project, ctx, {
			requestId: pending.requestId,
			increaseUsd,
			by: "auditor",
			basis: opinionReason,
			reason: null,
			resetAtMs: null,
		});
		return;
	}
	const before = currentApprovedUsd(project, ctx.estimateAfterUsd);
	const check = safeCapacity(capacity, before + increaseUsd, byModel);
	const afford = capacityAffordability(check, ctx.treasury);
	if (!afford.fits) {
		denyProject(project, ctx, {
			requestId: pending.requestId,
			increaseUsd,
			by: "rule",
			basis: opinionReason,
			reason: "insufficient-capacity",
			resetAtMs: afford.binding?.resetsAtMs ?? null,
		});
		return;
	}
	const approvedUsd = before + increaseUsd;
	approveProject(project, {
		requestId: pending.requestId,
		approvedUsd,
		by: "auditor",
		basis: opinionReason,
		now,
	});
	actions.push(actionKindMessage("budget-decision", project.sessionId, decisionData(project, pending.requestId, "approved", approvedUsd, "auditor", opinionReason, check.perWindow)));
}

// Rule 7: one checkpoint per revision at the configured percent and at 100%; both crossed in one
// evaluation means only 100 is sent. Only an ACTIVE goal gets checkpoints; otherwise nothing is sent
// and nothing is marked sent, so the checkpoint is not used up.
function applyCheckpoint(ctx) {
	const { project, now, cfg, actions } = ctx;
	const data = dataOf(project);
	const approvals = Array.isArray(data.approvals) ? data.approvals : [];
	// Rule 7 is per revision and applies to any live project with an approved budget, whatever its status.
	if (!ctx.goalActive || project.status === STATUS_CLOSED || approvals.length === 0) return;
	const approvedUsd = currentApprovedUsd(project, ctx.estimateAfterUsd);
	if (!(approvedUsd > 0)) return;
	const checkpoints = objectOf(data, "checkpoints");
	const key = String(project.revision);
	const sent = Array.isArray(checkpoints[key]) ? checkpoints[key] : [];
	const percent = num(cfg?.checkpointPercent, DEFAULT_CHECKPOINT_PERCENT);
	let mark = null;
	if (ctx.spentUsd >= approvedUsd) mark = 100;
	else if (ctx.spentUsd >= (percent / 100) * approvedUsd) mark = percent;
	if (mark === null || sent.includes(100)) return;
	if (mark !== 100 && sent.includes(mark)) return;
	sent.push(mark);
	checkpoints[key] = sent;
	actions.push(actionKindMessage("budget-checkpoint", project.sessionId, {
		projectId: project.id,
		revision: project.revision,
		percent: mark,
		spentUsd: ctx.spentUsd,
		approvedUsd,
		ms: now,
	}));
}

/**
 * Evaluate one project for one tick.
 * @param {object} input
 * @param {object} input.project persisted project record (C-store shape)
 * @param {object|null} input.goal goal record ({status, closedMs})
 * @param {number|{costUsd:number, byModel?:object}} input.spend inclusive spend
 * @param {Array<{kind:string, body:string, requestId?:string}>} input.blocks new blocks routed to the project
 * @param {object|null} input.treasury treasury reading forwarded to the request message
 * @param {(reserveUsd:number, byModel:object)=>{fits:boolean, ownerLevel:boolean, perWindow:Array}} input.capacity
 * @param {{n:number, p50:number, p80:number, p90:number, errorRatio:number|null, calibrated:boolean}} input.ref
 * @param {object|null} input.auditResult parsed audit opinion; `{status:"unavailable"}` means no capable model
 * @param {number} input.now
 * @param {object} input.cfg budget config (or the whole config)
 * @returns {{project: object, actions: Array<object>}}
 */
export function evaluate({
	project,
	goal = null,
	spend = 0,
	blocks = [],
	treasury = null,
	capacity = null,
	ref = { n: 0, p50: null, p80: null, p90: null, errorRatio: null, calibrated: false },
	auditResult = null,
	now,
	cfg = {},
} = {}) {
	const budget = budgetCfg(cfg);
	const next = cloneProject(project);
	const actions = [];
	const data = dataOf(next);
	const spentUsd = spendUsdOf(spend);
	const byModel = byModelOf(spend);
	const graceMs = num(budget.closeGraceMs, DEFAULT_CLOSE_GRACE_MS);
	const goalActive = goalIsActive(goal);

	// Rule 1.
	if (closeIfFinished(next, goal, spentUsd, now, graceMs)) return { project: next, actions };

	const estimateAfterUsd = num(budget.estimateAfterUsd, DEFAULT_ESTIMATE_AFTER_USD);

	// Rule 2: only an ACTIVE goal is asked; an inactive goal keeps tracking spend and status.
	if (goalActive && next.status === STATUS_TRACKING && !finite(data.requestSentMs) && spentUsd >= estimateAfterUsd) {
		data.requestSentMs = now;
		next.status = STATUS_REQUESTED;
		actions.push(actionKindMessage("budget-request", next.sessionId, {
			projectId: next.id,
			revision: next.revision,
			spentUsd,
			spentAtEstimateUsd: spentUsd,
			estimateAfterUsd,
			ref,
			treasury,
		}));
	}

	// Rule 3 (per new block, in arrival order).
	for (const block of Array.isArray(blocks) ? blocks : []) {
		applyBlock({
			project: next,
			block,
			now,
			cfg: budget,
			ref,
			capacity,
			byModel,
			spentUsd,
			estimateAfterUsd,
			treasury,
			actions,
		});
	}

	// Rule 5.
	applyAuditResult({ project: next, auditResult, now, capacity, byModel, actions, treasury, estimateAfterUsd });

	// Rule 7.
	applyCheckpoint({ project: next, now, cfg: budget, spentUsd, estimateAfterUsd, actions, goalActive });

	return { project: next, actions };
}
