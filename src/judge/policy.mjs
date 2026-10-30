/**
 * Remediation policy (plan todo 8, D-3, D-5, review R1-N1/N3, #55 B).
 *
 * Pure: turns a finding + its lifecycle record into the next action request.
 * The engine executes requests, records the outcome in `record`, and calls
 * back next tick. Nothing here touches processes or files.
 *
 * A stall suspicion (an `analyze` class: R10x, R11, the quiet hang) is never released on the clock. At its due time the
 * engine opens an investigation and asks the analyst (src/judge/analyst.mjs); only the analyst's `stuck` verdict
 * releases the call, `unrecoverable` (or a repeated `stuck`) tells the parent once, `progressing` looks again later and an
 * analyst that cannot answer is only retried. The concrete-evidence rules (R5, R5b, R6, R7, R8, R9) keep their ladders.
 * Every process action on a child is `quiet`: recorded, never sent to the parent.
 *
 * A main session is the human's. Its stall suspicions (R10x, R11) open an investigation but ask the analyst only once an
 * anomaly signal annotates the finding; otherwise the R2-style status notify stays. The one release a main session's call
 * can get is `release-shell` on an analyst verdict that proves a wrong command (`provesWrongCommand`), followed by one
 * explanatory message; any other answer is one notice and nothing is released. Whether the human is at the keyboard is
 * never a criterion.
 *
 * record (engine-owned, per finding fp):
 *   { step, lastActionMs, lastActionKind, executed: Set<key>, looks, nextLookMs,
 *     analyst: {step, jobId, startedMs, candidates, pool, dayKey, verdict} | undefined, toasted, remedyDone }
 * `looks` counts the analyst looks started (a look's key is `look<n>`); `nextLookMs` is when the next one may start (a
 * `wait` verdict's recheck time, or the retry time after a failure); `analyst` is the latest look, `verdict` once it ended.
 */

import { ANOMALY_DETECTOR } from "../anomaly/signals.mjs";
import { classifyProviderError, retryWaitOf } from "../detect/provider.mjs";

export const LADDERS = {
	"kill-pids": ["kill-pids", "release-shell", "relay-cancel"],
	"detach-server": ["detach-server", "release-shell", "relay-cancel"],
	"release-shell": ["release-shell", "relay-cancel"],
	"relay-cancel": ["relay-cancel"],
	notify: ["notify"],
};

export const PROCESS_ACTIONS = new Set(["kill-pids", "release-shell", "detach-server", "kill-orphan-watchers", "kill-reflection-orphans"]);

/** Which config.actions switch gates each action kind. */
export const SWITCH_OF = {
	"kill-pids": "kill",
	"kill-orphan-watchers": "kill",
	"kill-reflection-orphans": "kill",
	"kill-respawner": "kill",
	"release-shell": "release",
	"detach-server": "detach",
	"relay-cancel": "relay",
	notify: "relay",
	"main-notice": "relay",
	"why-notice": "relay",
	"respawn-notice": "relay",
	"triage-notice": "relay",
	// D23: the downtime notice is a relay; it may reach a main session.
	"boot-notice": "relay",
	wake: "wake",
	"wake-parent": "wake",
	// C8: the goal-liveness detector's wake of the session itself; allowed on main sessions (not in MAIN_SESSION_BLOCKED).
	"goal-wake": "wake",
	nudge: "nudge",
	"abort-continue": "abortHungTurn",
	"revert-settings": "revert",
	"scope-check": "nudge",
	"crash-resume": "resume",
	"crash-notice": "resume",
	// D20: relaunch a session parked at a usage limit; allowed on main sessions (not in MAIN_SESSION_BLOCKED).
	"park-resume": "resume",
	toast: "toast",
};

export function newRecord(fp, now) {
	return { fp, firstSeenMs: now, step: 0, lastActionMs: undefined, lastActionKind: undefined, executed: new Set(), looks: 0, nextLookMs: 0, analyst: undefined, toasted: false, remedyDone: false, whyNoticed: false };
}

function targetsForRelease(finding) {
	const match = finding.data?.match ?? {};
	return [...(match.tree ?? []), ...(match.orphans ?? [])];
}

function request(finding, kind, step, extra = {}) {
	return { key: `${kind}:${finding.fp}:${step}`, kind, fp: finding.fp, step, ...extra };
}

/** The ladder an analyst verdict starts: a confident `stuck` releases the shell; `unrecoverable` (advice) tells the parent. */
export function ladderFromVerdict(verdict) {
	if (verdict?.verdict === "act" && verdict.actionId === "release-shell") return "release-shell";
	if (verdict?.verdict === "escalate" && verdict.advice && !verdict.reason) return "relay-cancel";
	return undefined;
}

/**
 * Candidates offered for a stall suspicion (the analyst may only pick one of these). A general anomaly signal (D19) is not
 * evidence that anything is stuck, so its look never offers the release: it can wait or escalate.
 */
export function analystCandidates(finding) {
	const candidates = [
		{ id: "wait", kind: "wait", effect: "do nothing now, look again later" },
		{ id: "release-shell", kind: "release-shell", effect: "terminate the shell process tree of this tool call; the call returns an error and the agent continues" },
		{ id: "escalate", kind: "escalate", effect: "take no action; tell the human" },
	];
	return finding?.detector === ANOMALY_DETECTOR ? candidates.filter((candidate) => candidate.id !== "release-shell") : candidates;
}

/**
 * A report's candidates (#60 item 5). Report text is written by an agent, so a report never starts a process action:
 * its look can only answer. Process actions stay with the detection's own schedule.
 */
export const REPORT_CANDIDATES = Object.freeze([
	Object.freeze({ id: "wait", kind: "wait", effect: "nothing needs doing: it progresses or will resolve by itself; the owning session is told so" }),
	Object.freeze({ id: "escalate", kind: "escalate", effect: "tell the owning session what is wrong and what the agent should do instead" }),
]);

/**
 * A why look's candidates (plan C3). A why look only explains: it never offers a process action, so widening the analyst
 * to every yellow footer problem cannot widen what may be released or killed (IS-1, IS-10).
 */
export const WHY_CANDIDATES = Object.freeze([
	Object.freeze({ id: "wait", kind: "wait", effect: "nothing to fix: it progresses or resolves by itself" }),
	Object.freeze({ id: "escalate", kind: "escalate", effect: "tell the supervising session what went wrong and what to do instead" }),
]);

/** The footer problems whose cause is not already known: each owes the supervising session one explanation (plan C9). */
const WHY_KINDS = new Set(["D8:dead-child", "D8:child-error-unhandled", "D8:hung-main-turn", "D5:hung-turn-child", "D5:tps-collapse", "D10:same-call-loop", "D10:error-storm", "D2:process-runaway"]);

/** A verdict that is not an answer: the analyst was off, held off, out of budget, failed or answered garbage. */
export function couldNotAnswer(verdict) {
	return Boolean(verdict?.failed || verdict?.notReached);
}

/** Does one of these error texts name a usage limit, quota, rate limit, blocked account or an unconfigured provider? */
function providerLimitText(...values) {
	const text = values.filter((value) => typeof value === "string" && value).join("\n");
	return Boolean(text) && (Boolean(retryWaitOf(text)) || classifyProviderError(text) !== "other");
}

/**
 * Why this finding's cause is already obvious, so an analyst look would only cost tokens (plan C5/C16, IS-5): usage
 * limits, quota and rate limits, blocked or revoked accounts, an unconfigured provider, provider-side slowness and D8's
 * stopped-on-errors (that detector fires only after the same provider answered again, so the provider was the cause).
 * @returns {string|undefined} a short reason, or undefined when the finding may be looked at.
 */
export function skipsAnalyst(finding) {
	if (!finding) return undefined;
	if (finding.severity === "info") return "info";
	const data = finding.data ?? {};
	const key = `${finding.detector}:${finding.kind}`;
	if (key === "D5:tps-collapse" && data.providerSide) return "provider-side";
	if (key === "D8:stopped-on-errors") return "provider-errors";
	if (key === "D10:error-storm" && providerLimitText(data.errorHead, data.errorClass, (finding.evidence ?? []).join("\n"))) return "provider-limit";
	if ((key === "D8:dead-child" || key === "D8:child-error-unhandled") && providerLimitText(data.errorText)) return "provider-limit";
	return undefined;
}

/**
 * Does this finding still owe the supervising session its one explanation (plan C9)? True for a why-kind finding, and for
 * any D1 finding (main or child) that was acted on or whose look started or answered - also once it disappeared.
 */
export function needsWhy(finding, record) {
	if (!finding || !record || record.whyNoticed) return false;
	if (skipsAnalyst(finding)) return false;
	if (WHY_KINDS.has(`${finding.detector}:${finding.kind}`)) return true;
	return finding.detector === "D1" && ((record.step ?? 0) >= 1 || Boolean(record.analyst) || (record.looks ?? 0) > 0);
}

/** An act is irreversible: it needs the analyst's own `abnormal` verdict at analyst.actConfidence or more, with cited evidence. */
export function mayActIrreversibly(verdict, config) {
	return verdict?.verdict === "act" && verdict.assessment === "abnormal" && verdict.confidence >= config.analyst.actConfidence && (verdict.evidence?.length ?? 0) > 0;
}

/**
 * What the analyst settled for the latest look: `analyze` (no look yet), `analyzing` (a job runs) or `decided` with the
 * verdict to follow. An act that mayActIrreversibly refuses becomes an escalation (`vetoed`): nothing is released.
 */
export function settle({ record, config }) {
	const job = record.analyst;
	if (!job) return { kind: "analyze" };
	if (!job.verdict) return { kind: "analyzing" };
	const verdict = job.verdict;
	if (verdict.verdict === "act" && !mayActIrreversibly(verdict, config)) return { kind: "decided", verdict: { ...verdict, verdict: "escalate", vetoed: verdict.actionId, actionId: null } };
	return { kind: "decided", verdict };
}

/**
 * The why look (plan C9/C13/C15): an explanation of a footer problem whose cause is not already known. It asks only for
 * WHY_CANDIDATES, so it can never release or kill anything. An answered, non-normal verdict owes the supervising session
 * one why-notice; a `wait` verdict looks again at `nextLookMs` (never for a finding that is gone); a look that could not
 * answer is retried. Returns the state it left the finding in; `requests` gets the requests it planned.
 */
export function planWhy({ finding, record, now, config, requests, gone = false }) {
	if (skipsAnalyst(finding) || !config.analyst?.enabled) return "skipped";
	const ask = () => requests.push(request(finding, "analyze", `look${record.looks ?? 0}`, { candidates: WHY_CANDIDATES, why: true }));
	const settled = settle({ record, config });
	if (settled.kind === "analyzing") return "analyzing";
	if (settled.kind === "decided") {
		const verdict = settled.verdict;
		if (couldNotAnswer(verdict)) {
			if (now >= (record.nextLookMs ?? 0)) {
				ask();
				return "analyzing";
			}
			return failureState(verdict);
		}
		if (!record.whyNoticed && verdict.assessment !== "normal") {
			requests.push(request(finding, "why-notice", 0, { verdict }));
			return "noticed";
		}
		if (!gone && verdict.verdict === "wait" && now >= (record.nextLookMs ?? 0)) {
			ask();
			return "analyzing";
		}
		return "observe";
	}
	if (now >= (record.nextLookMs ?? 0)) {
		ask();
		return "analyzing";
	}
	return "waiting-analyst";
}

/** D17's kill is the rule's own process action: it vouches for the kill at respawn.maxHoldMs. */
export function respawnCandidates(finding) {
	const target = finding.data?.remedy?.targets?.[0] ?? {};
	const name = finding.data?.storm?.name ?? "the program";
	return [
		{ id: "wait", kind: "wait", effect: `leave ${name} relaunching; look again later` },
		{ id: "kill-respawner", kind: "kill-respawner", effect: `terminate ${target.name ?? "?"}(${target.pid ?? "?"}), the process that keeps relaunching ${name}; the background job it belongs to ends and its owner is told` },
		{ id: "escalate", kind: "escalate", effect: "take no action; tell the owning session what was seen" },
	];
}

/** The state a look that could not answer leaves the finding in. */
function failureState(verdict) {
	if (verdict.reason === "would") return "would-analyze";
	return verdict.reason === "budget-exhausted" ? "analyst-budget-spent" : "analyst-failed";
}

/**
 * D17's kill of a background respawner. The analyst looks first (respawnCandidates): `stuck` kills, `progressing` holds
 * until the next look, an escalation tells the owner once. The hold is time-limited and clock-driven only for this
 * rule's own concrete evidence: whatever the analyst says, or when it cannot answer, the kill runs once the storm has been
 * seen for respawn.maxHoldMs (`max-hold`).
 */
function planRespawn({ finding, record, now, config, remedy }) {
	const requests = [];
	if (record.remedyDone) return { requests, state: "remedied" };
	const kill = (hold, verdict) => {
		requests.push(request(finding, "kill-respawner", 0, { remedy, ...(hold ? { hold } : {}), ...(verdict ? { triage: triageNote(verdict) } : {}) }));
		return { requests, state: "acting" };
	};
	if (now - record.firstSeenMs >= (config.respawn?.maxHoldMs ?? Number.POSITIVE_INFINITY)) return kill("max-hold");
	const look = () => {
		requests.push(request(finding, "analyze", `look${record.looks}`, { candidates: respawnCandidates(finding) }));
		return { requests, state: "analyzing" };
	};
	const settled = settle({ record, config });
	if (settled.kind === "analyze") return now >= record.nextLookMs ? look() : { requests, state: "waiting-analyst" };
	if (settled.kind === "analyzing") return { requests, state: "analyzing" };
	const verdict = settled.verdict;
	if (verdict.verdict === "act") return kill(undefined, verdict);
	if (couldNotAnswer(verdict)) return now >= record.nextLookMs ? look() : { requests, state: failureState(verdict) };
	if (verdict.verdict === "escalate") requests.push(request(finding, "respawn-notice", record.analyst.step, { verdict }));
	if (now >= record.nextLookMs) return look();
	return { requests, state: verdict.verdict === "wait" ? "waiting-analyst" : "escalated" };
}

/**
 * The one proof that lets a main session's call be released: the analyst's own `wrong-command` cause, at
 * analyst.actConfidence or more, with cited evidence. `triage` is the verdict as `triageNote` carries it.
 */
export function provesWrongCommand(triage, config) {
	return Boolean(config?.analyst?.enabled) && triage?.cause === "wrong-command" && triage.confidence >= config.analyst.actConfidence && (triage.evidence?.length ?? 0) > 0;
}

/** The analyst's diagnosis and advice travel with the action it started, for the notice and the investigation. */
function triageNote(verdict) {
	return { tier: verdict.tier ?? 2, assessment: verdict.assessment ?? null, confidence: verdict.confidence ?? null, cause: verdict.cause ?? null, diagnosis: verdict.diagnosis ?? verdict.rationale ?? null, advice: verdict.advice ?? null, mechanism: verdict.mechanism ?? null, avoid: verdict.avoid ?? null, evidence: verdict.evidence ?? [], model: verdict.model ?? null };
}

/**
 * The analyst's step of a D1 stall suspicion. Returns `{plan}` when this tick ends here (ask, wait, retry) or
 * `{ladder, verdict}` when the verdict starts a ladder.
 */
function planAnalysis({ finding, record, now, config, requests, why = false }) {
	const look = () => {
		requests.push(request(finding, "analyze", `look${record.looks}`, { candidates: analystCandidates(finding) }));
		return { plan: { requests, state: "analyzing" } };
	};
	const settled = settle({ record, config });
	if (settled.kind === "analyze") return now >= record.nextLookMs ? look() : { plan: { requests, state: "waiting-analyst" } };
	if (settled.kind === "analyzing") return { plan: { requests, state: "analyzing" } };
	const verdict = settled.verdict;
	const ladder = ladderFromVerdict(verdict);
	if (ladder) return { ladder, verdict };
	// C17: an answered, non-normal verdict that starts no ladder still owes the supervising session one explanation.
	if (why && !couldNotAnswer(verdict) && verdict.assessment !== "normal" && !record.whyNoticed) {
		requests.push(request(finding, "why-notice", 0, { verdict }));
		return { plan: { requests, state: "noticed" } };
	}
	// An analyst that could not answer, an answer that is not actionable (a `wait`, or a suspicion without evidence), a
	// vetoed act: nothing irreversible; the look is asked again at nextLookMs (the recheck time, or the retry time).
	if (now >= record.nextLookMs) return look();
	const state = couldNotAnswer(verdict) ? failureState(verdict) : verdict.verdict === "wait" ? "waiting-analyst" : "escalated";
	return { plan: { requests, state } };
}

/**
 * A main session's stall suspicion (R10x, R11). Without an anomaly signal it only gets the R2-style status notify (and an
 * open investigation). With one, the analyst looks once (a look that could not answer is retried); a `wrong-command` proof
 * releases the call's shell tree (the engine then sends the one explanation), any other answer is one notice.
 */
function planMainStall({ finding, record, now, config, requests }) {
	const look = () => {
		requests.push(request(finding, "analyze", `look${record.looks}`, { candidates: analystCandidates(finding) }));
		return { requests, state: "analyzing" };
	};
	// C15: without an anomaly signal the R2-style status notify stays, and the why look is this session's one explanation
	// - a self why-notice, never a release (no wrong command was proven). An analyst that cannot run leaves it exactly as
	// it was: the notify and nothing else.
	if (!finding.data?.signals?.length) {
		requests.push(request(finding, "notify", 0));
		const whyState = planWhy({ finding, record, now, config, requests });
		return { requests, state: whyState === "analyzing" || whyState === "waiting-analyst" ? "analyzing" : whyState === "noticed" ? "noticed" : "observe-main" };
	}
	const settled = settle({ record, config });
	if (settled.kind === "analyze") return now >= record.nextLookMs ? look() : { requests, state: "waiting-analyst" };
	if (settled.kind === "analyzing") return { requests, state: "analyzing" };
	const verdict = settled.verdict;
	if (couldNotAnswer(verdict)) return now >= record.nextLookMs ? look() : { requests, state: failureState(verdict) };
	const triage = triageNote(verdict);
	if (ladderFromVerdict(verdict) === "release-shell" && provesWrongCommand(triage, config)) {
		requests.push(request(finding, "release-shell", 0, { targets: targetsForRelease(finding), triage, wrongCommand: true }));
		return { requests, state: "acting" };
	}
	requests.push(request(finding, "main-notice", 0, { verdict }));
	return { requests, state: "noticed" };
}

/**
 * A general anomaly (D19): the analyst looks, nothing else. Only an escalation that carries advice goes further, as the one
 * relay of the stall ladder; no verdict of an anomaly can release a shell.
 */
function planAnomaly({ finding, record, now, config, requests }) {
	const analysis = planAnalysis({ finding, record, now, config, requests });
	if (analysis.plan) return analysis.plan;
	const next = analysis.ladder === "relay-cancel" ? LADDERS["relay-cancel"][record.step] : undefined;
	if (!next) return { requests, state: "exhausted" };
	requests.push(request(finding, next, record.step, { triage: triageNote(analysis.verdict) }));
	return { requests, state: "acting" };
}

/**
 * D21's idle goal wait: ask the analyst why before waking the session (IS-6). A normal answer defers the wake to
 * goalLiveness.livenessMs; an analyst that is off, cannot answer, or stays pending for idleWakeHoldMs never holds it
 * longer than that hold. The wake is the rule's own if a look could not answer; an answered non-normal verdict travels
 * with it. A wake delivered without the verdict (hold or failure) still owes one why-notice once a later look answers.
 */
function planGoalWaitIdle({ finding, record, now, config, remedy }) {
	const requests = [];
	const wake = (verdict) => {
		requests.push(request(finding, "goal-wake", 0, { remedy, ...(verdict ? { verdict } : {}) }));
		return { requests, state: "acting" };
	};
	const settled = settle({ record, config });
	if (record.remedyDone) {
		if (settled.kind === "decided" && !couldNotAnswer(settled.verdict) && settled.verdict.assessment !== "normal" && !record.whyNoticed) {
			requests.push(request(finding, "why-notice", 0, { verdict: settled.verdict }));
			return { requests, state: "noticed" };
		}
		return { requests, state: "remedied" };
	}
	if (!config.analyst?.enabled) return wake();
	const livenessMs = config.goalLiveness?.livenessMs ?? Number.POSITIVE_INFINITY;
	const holdMs = config.goalLiveness?.idleWakeHoldMs ?? Number.POSITIVE_INFINITY;
	if (settled.kind === "decided") {
		const verdict = settled.verdict;
		if (couldNotAnswer(verdict)) return wake();
		if (verdict.assessment !== "normal") return wake(verdict);
		// A normal answer is the rule's own deferral: no wake before livenessMs, with one recheck while looks remain.
		if (now - record.firstSeenMs >= livenessMs) return wake();
		if (now >= (record.nextLookMs ?? 0) && (record.looks ?? 0) < (config.analyst.perFinding ?? 0)) {
			requests.push(request(finding, "analyze", `look${record.looks ?? 0}`, { candidates: WHY_CANDIDATES, why: true }));
			return { requests, state: "analyzing" };
		}
		return { requests, state: "waiting-analyst" };
	}
	if (now - (record.analyst?.startedMs ?? record.firstSeenMs) >= holdMs || now - record.firstSeenMs >= livenessMs) return wake();
	if (settled.kind === "analyzing") return { requests, state: "analyzing" };
	if (now >= (record.nextLookMs ?? 0)) {
		requests.push(request(finding, "analyze", `look${record.looks ?? 0}`, { candidates: WHY_CANDIDATES, why: true }));
		return { requests, state: "analyzing" };
	}
	return { requests, state: "waiting-analyst" };
}

/**
 * D15's alignment nudge: with align.requireVerdict and an analyst on, only a look that could not answer or an answered
 * non-normal verdict nudges; a normal answer spends the gap slot without a message (`drift-normal`). Analyst off or
 * requireVerdict false keeps the rule's own nudge.
 */
function planDrift({ finding, record, now, config, remedy }) {
	const requests = [];
	const nudge = (verdict) => {
		requests.push(request(finding, "scope-check", 0, { remedy, ...(verdict ? { verdict } : {}) }));
		return { requests, state: "acting" };
	};
	if (record.remedyDone) return { requests, state: "remedied" };
	// A nudge that could not be delivered retries after nextNudgeMs, without spending the alignment gap slot.
	if (now < (record.nextNudgeMs ?? 0)) return { requests, state: "waiting-analyst" };
	if (!config.align?.requireVerdict || !config.analyst?.enabled) return nudge();
	const settled = settle({ record, config });
	if (settled.kind === "analyzing") return { requests, state: "analyzing" };
	if (settled.kind === "decided") {
		const verdict = settled.verdict;
		if (couldNotAnswer(verdict)) return nudge();
		if (verdict.assessment !== "normal") return nudge(verdict);
		return { requests, state: "drift-normal" };
	}
	if (now >= (record.nextLookMs ?? 0)) {
		requests.push(request(finding, "analyze", `look${record.looks ?? 0}`, { candidates: WHY_CANDIDATES, why: true }));
		return { requests, state: "analyzing" };
	}
	return { requests, state: "waiting-analyst" };
}

/**
 * Next action for one finding.
 * @returns {{requests: object[], state: string}}
 */
export function planFinding({ finding, record, now, config }) {
	const requests = [];

	// Remedies requested by non-stall detectors (wake, nudge, abort-continue, revert-settings).
	const remedy = finding.data?.remedy;
	// D17's kill of a respawner asks the analyst first.
	if (remedy?.kind === "kill-respawner") return planRespawn({ finding, record, now, config, remedy });
	// IS-6/IS-7: an idle goal wait and an alignment nudge ask the analyst why before they wake or nudge.
	if (finding.detector === "D21" && finding.kind === "goal-wait-idle") return planGoalWaitIdle({ finding, record, now, config, remedy });
	if (finding.detector === "D15" && finding.data?.remedy?.kind === "scope-check") return planDrift({ finding, record, now, config, remedy });
	if (remedy && !record.remedyDone) {
		const kind = remedy.kind;
		requests.push(request(finding, kind, 0, { remedy }));
	}

	// Human-needed findings get one toast per fp (tag cooldown is enforced by the notifier).
	if (finding.humanNeeded && !record.toasted) requests.push(request(finding, "toast", 0));

	if (finding.detector === ANOMALY_DETECTOR) return planAnomaly({ finding, record, now, config, requests });

	// IS-1: a footer problem whose cause is not already known gets one analyst look, whatever its kind (C9). The remedy
	// and the toast stay first: they are what the detector asked for.
	if (WHY_KINDS.has(`${finding.detector}:${finding.kind}`)) {
		planWhy({ finding, record, now, config, requests });
		return { requests, state: requests.length ? "remedy" : "observe" };
	}

	const classification = finding.data?.classification;
	if (finding.detector !== "D1" || finding.kind !== "stall" || !classification) return { requests, state: requests.length ? "remedy" : "observe" };
	// A class that only waits (bounded, progressing, ...) is left alone until a rule or the quiet hang gives it an action.
	if (!classification.action) return { requests, state: requests.length ? "remedy" : "observe" };
	if (classification.dueMs !== undefined && now < classification.dueMs) return { requests, state: "waiting-due" };

	// Verifying the previous process action: give the tool result time to arrive.
	if (record.lastActionMs !== undefined && PROCESS_ACTIONS.has(record.lastActionKind) && now < record.lastActionMs + config.stall.verifyResultMs) {
		return { requests, state: "verifying" };
	}

	// Every process action on a child is quiet: recorded in its investigation, never sent to the parent.
	const isChild = finding.data?.sessionKind === "child";
	const quiet = isChild ? { quiet: true } : {};
	let ladderKind = classification.action.kind;
	let triage;
	if (ladderKind === "analyze" && finding.data?.sessionKind === "main") return planMainStall({ finding, record, now, config, requests });
	if (ladderKind === "analyze") {
		const analysis = planAnalysis({ finding, record, now, config, requests, why: isChild });
		if (analysis.plan) return analysis.plan;
		ladderKind = analysis.ladder;
		triage = analysis.verdict;
	}
	const ladder = LADDERS[ladderKind] ?? [ladderKind];
	const next = ladder[record.step];
	// C13: a child that was acted on already owes its parent one explanation, but only the first why look holds the ladder:
	// while it is pending (no verdict yet) or while an answered, non-normal verdict's notice is unsent. A why look that
	// could not answer, or an answered `wait` (normal) verdict, never blocks a concrete-evidence rung - the ladder
	// continues in this same plan and its re-look is requested alongside it.
	if (isChild && (record.step ?? 0) >= 1 && !record.whyNoticed) {
		const whySettled = settle({ record, config });
		const firstLook = whySettled.kind === "analyzing" || (whySettled.kind === "analyze" && config.analyst?.enabled && !skipsAnalyst(finding));
		const unsentNotice = whySettled.kind === "decided" && !couldNotAnswer(whySettled.verdict) && whySettled.verdict.assessment !== "normal";
		if (firstLook || unsentNotice) {
			const whyState = planWhy({ finding, record, now, config, requests });
			return { requests, state: whyState === "noticed" ? "noticed" : "analyzing" };
		}
		planWhy({ finding, record, now, config, requests });
	}
	// C15/C18: a main session's why look runs before the ladder can end. The engine increments record.step when it sends
	// the notify rung (R2/R2b/R3b/R12 on a main subject), so an answered non-normal verdict's one why-notice is planned
	// here, on the tick after the notify - never lost to the `!next` exhausted return.
	if (!next && finding.data?.sessionKind === "main" && !record.whyNoticed) {
		const whyState = planWhy({ finding, record, now, config, requests });
		if (whyState === "noticed") return { requests, state: "noticed" };
		if (whyState === "analyzing" || whyState === "waiting-analyst") return { requests, state: "analyzing" };
	}
	if (!next) return { requests, state: "exhausted" };
	// C12/C15: the one message a parent gets about a child. A rule rung (R2 inproc, R3b exited-no-result, R12 dead batch)
	// asks the why look first, so the relay can carry the mechanism and avoid; once the message went out nothing more is
	// relayed. The analyst's own relay rung carries the verdict it decided.
	if (next === "relay-cancel" && isChild) {
		if (record.whyNoticed) return { requests, state: "noticed" };
		const settled = settle({ record, config });
		if (!triage && settled.kind === "analyzing") return { requests, state: "analyzing" };
		if (!triage && settled.kind === "decided" && !couldNotAnswer(settled.verdict)) triage = settled.verdict;
		if (!triage && settled.kind === "analyze" && config.analyst?.enabled && !skipsAnalyst(finding)) {
			if (now >= (record.nextLookMs ?? 0)) requests.push(request(finding, "analyze", `look${record.looks ?? 0}`, { candidates: WHY_CANDIDATES, why: true }));
			return { requests, state: "analyzing" };
		}
	}
	const note = triage ? { triage: triageNote(triage) } : {};
	if (next === "kill-pids") {
		requests.push(request(finding, next, record.step, { targets: classification.action?.targets, ...note, ...quiet }));
	} else if (next === "detach-server") {
		requests.push(request(finding, next, record.step, { targets: classification.action?.targets ?? [], serverPids: classification.action?.serverPids ?? [], ...note, ...quiet }));
	} else if (next === "release-shell") {
		requests.push(request(finding, next, record.step, { targets: targetsForRelease(finding), ...note, ...quiet }));
	} else {
		// relay-cancel: the one message a parent gets about a child (unrecoverable, a repeat stall, or the ladder's last rung).
		requests.push(request(finding, next, record.step, note));
	}
	// C18: a main session's concrete-rule rung is emitted unchanged (the gate still blocks its action) and the session gets
	// its one why look, so it learns the mechanism even though nothing may be released for it.
	if (finding.data?.sessionKind === "main" && !record.whyNoticed) planWhy({ finding, record, now, config, requests });
	return { requests, state: "acting" };
}

/**
 * A report's look (#60 item 5): one analyst look from analyst.reports on the common bundle, then one notice to the
 * owning session with what was found. Notice-only: a report never starts a process action. Without an analyst that can
 * answer, the notice carries the rule diagnosis of the report's evidence snapshot. `record.finding` is the report's own
 * finding (detector `report`).
 */
export function planReport({ record, config }) {
	const finding = record.finding;
	const requests = [];
	const reportId = finding.data?.report?.id;
	const step = "report";
	const settled = settle({ record, config });
	if (settled.kind === "analyze" && config.analyst.enabled) {
		requests.push(request(finding, "analyze", step, { candidates: [...REPORT_CANDIDATES], reportId, snapshotFile: record.snapshotFile }));
		return { requests, state: "analyzing" };
	}
	if (settled.kind === "analyzing") return { requests, state: "analyzing" };
	requests.push(request(finding, "triage-notice", step, { verdict: settled.kind === "decided" ? settled.verdict : undefined, reportId }));
	return { requests, state: "answered" };
}

/**
 * User rule (2026-09-25), relaxed by the care-removal plan (Q5): main sessions are watched by the human and are not
 * management targets. Findings about them are still reported; these actions never run when the finding's subject is a
 * main session, except a `release-shell` that carries an analyst proof of a wrong command (`provesWrongCommand`). The
 * analyst's look (`analyze`) only reads, so a main session may be looked at. Relays and wakes about a child (subject =
 * child) still reach its main parent. `abort-continue` stays blocked.
 */
export const MAIN_SESSION_BLOCKED = new Set(["kill-pids", "release-shell", "detach-server", "kill-respawner", "relay-cancel", "nudge", "abort-continue"]);

/**
 * Gate a request through mode, pause and per-kind switches.
 * @returns {"execute"|"would"|"skipped:paused"|"skipped:switch-off"|"skipped:done"|"skipped:out-of-scope"|"skipped:main-session"}
 */
export function gate(req, { mode, paused, config, executed, subject, subjectKind, disabledActions }) {
	if (disabledActions?.has(req.kind)) return "skipped:switch-off";
	if (executed?.has(req.key)) return "skipped:done";
	if (subjectKind === "main" && MAIN_SESSION_BLOCKED.has(req.kind) && !(req.kind === "release-shell" && provesWrongCommand(req.triage, config))) return "skipped:main-session";
	if (config.actionScope?.length && req.kind !== "toast" && req.kind !== "notify") {
		const ids = [subject?.sessionId, subject?.parentSessionId, subject?.rootSessionId].filter(Boolean);
		if (!ids.some((id) => config.actionScope.includes(id))) return "skipped:out-of-scope";
	}
	const switchName = SWITCH_OF[req.kind];
	if (req.kind === "analyze") {
		if (!config.analyst.enabled) return "skipped:switch-off";
		if (paused) return "skipped:paused";
		if (mode === "shadow") return "would";
		return "execute";
	}
	if (switchName && config.actions[switchName] === false) return "skipped:switch-off";
	// Toasts and informational notices still flow while paused/shadow (they change nothing).
	if (req.kind === "toast" || req.kind === "notify") return "execute";
	if (paused) return "skipped:paused";
	if (mode === "shadow") return "would";
	return "execute";
}
