// C-office: the budget office. One tick = ingest the ledger, read the subscription windows, recompute calibration and
// treasury states, drain dashboard commands, evaluate every live project (C-projects), start and poll audits (todo 14),
// write the snapshot, and hand back composed budget messages for the engine to deliver. The treasury alone decides,
// by rules (Structure A): the auditor is a third party outside the request/approval relation, so no audit result ever
// enters a decision. Audits are independent triggers whose opinions go to the session and the snapshot.
// Shadow mode computes and writes the snapshot but sends nothing, starts no audit, consumes no command and keeps
// project state unchanged (would-actions become events). The office never imports the engine.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	composeAuditOpinion,
	composeBudgetOwnerCall,
	composeBudgetCheckpoint,
	composeBudgetCorrection,
	composeBudgetDecision,
	composeBudgetRequest,
} from "../act/messages.mjs";
import { readSubscriptionUsage } from "../collect/subscriptions.mjs";
import { atomicWriteJson, readJsonSafe, removeSafe } from "../util/fsx.mjs";
import { redact, truncate } from "../util/text.mjs";
import { laneModels } from "../judge/lane.mjs";
import { FIRST_USER_REQUESTS, MAX_HEALTH_NOTES, MAX_REVIEW_VERDICTS, MAX_USER_REQUESTS, auditModel, buildBundle, buildDigestInput } from "./audit.mjs";
import { pollAudit, pollDigest, startAudit, startDigest } from "./audit-job.mjs";
import { calibrate, epochs, externalPercent } from "./calibration.mjs";
import { readCommands } from "./commands.mjs";
import { referenceClass } from "./estimates.mjs";
import { createIngest } from "./ingest.mjs";
import { auditAllowed, indicators, ladder, triggers } from "./metrics.mjs";
import { evaluate } from "./projects.mjs";
import { createBudgetStore, redactDeep } from "./store.mjs";
import { capacityCheck, summarize, windowState } from "./treasury.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SUBSCRIPTION_EVERY_MS = 60_000;
const CALIBRATION_EVERY_MS = 10 * MIN;
const PRUNE_EVERY_MS = HOUR;

/** One ledger row for an audit or digest run's own usage (source `audit`, charged to the project it looked at). */
function auditUsageRow({ id, project, model, usage, now }) {
	return {
		id,
		ms: now,
		sessionId: id,
		rootSessionId: project.sessionId,
		projectId: project.id,
		taskId: null,
		source: "audit",
		provider: model?.split("/")[0] ?? null,
		model: model ?? null,
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usage.cost ?? null,
		costStatus: usage.cost == null ? "missing" : "reported",
	};
}
const RECENT_TAIL_BYTES = 512 * 1024;
// A budget message waits in the project's outbox this long for a delivery report (B3).
const OUTBOX_TTL_MS = 7 * DAY;
const LIVE = new Set(["tracking", "requested", "approved", "pending"]);
// Same active statuses as src/detect/align.mjs GOAL_ACTIVE; audits are for goals still being worked on.
const GOAL_ACTIVE = new Set(["active", "running", "in_progress", "pending"]);

// Goal statuses that close a project (C-projects rule 1); every other unseen status reads as missing.
const GOAL_TERMINAL = new Set(["complete", "completed", "replaced", "cleared", "cancelled"]);

/** An audit opinion copied from an in-memory poll has not passed through the store yet: redact every string in it. */
function redactedAudit(audit) {
	return audit?.opinion ? { ...audit, opinion: redactDeep(audit.opinion) } : audit;
}

/**
 * The goal as of this tick. Ingest reads the goal files of every session inside the backfill window, so a project
 * without `info` belongs to a session that left the window or was deleted: it is no longer in progress (no request,
 * checkpoint or audit), while a stored terminal status still lets rule 1 close it.
 */
function goalNowOf(info, project) {
	if (info?.goal) return info.goal;
	const stored = project.data?.goalStatus;
	const terminal = typeof stored === "string" && GOAL_TERMINAL.has(stored.trim().toLowerCase());
	return { status: terminal ? stored : "missing", completedMs: project.data?.goalCompletedMs ?? null };
}

function goalActive(status) {
	return typeof status === "string" && GOAL_ACTIVE.has(status.trim().toLowerCase());
}
function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function emptyData() {
	return {
		requestSentMs: null,
		correctionSentMs: null,
		estimates: [],
		approvals: [],
		originalApprovedUsd: null,
		autoIncreasesUsd: 0,
		pending: null,
		checkpoints: {},
		audits: [],
		workClass: null,
		outcome: null,
		outbox: [],
	};
}

/** Keys of auth.json only, never its values (src/judge/lane.mjs pattern). */
function authProviders(authFile) {
	try {
		return new Set(Object.keys(JSON.parse(fs.readFileSync(authFile, "utf8")) ?? {}));
	} catch {
		return new Set();
	}
}

function approvedOf(project) {
	const approvals = project.data?.approvals ?? [];
	return approvals.length ? approvals[approvals.length - 1].approvedUsd : 0;
}

/** Goal record for C-projects rule 1: complete/replaced close after grace from their end; cleared = cancelled. */
function goalForEvaluate(goal) {
	if (!goal) return null;
	if (goal.status === "complete" || goal.status === "completed") return { status: "completed", closedMs: goal.completedMs };
	if (goal.status === "replaced") return { status: "replaced", closedMs: goal.completedMs };
	if (goal.status === "cleared" || goal.status === "cancelled") return { status: "cancelled", closedMs: goal.completedMs };
	return { status: goal.status, closedMs: null };
}

/** The last assistant steps of a transcript tail, for the audit bundle (owner requests come from the evidence ledger). */
function recentOf(file) {
	const steps = [];
	if (!file) return { steps };
	let text = "";
	try {
		const stat = fs.statSync(file);
		const length = Math.min(stat.size, RECENT_TAIL_BYTES);
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, stat.size - length);
			text = buf.subarray(0, n).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { steps };
	}
	for (const line of text.split("\n")) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.type === "message" ? entry.message : null;
		if (!message || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (message.role !== "assistant") continue;
			if (item?.type === "text" && item.text) steps.push(String(item.text).replace(/\s+/g, " "));
			else if (item?.type === "toolCall") steps.push(`${item.name}: ${JSON.stringify(item.arguments ?? {})}`);
		}
	}
	return { steps: steps.slice(-60) };
}

/**
 * @param {{paths: object, db: object, clock: {now(): number}, config: object|function, runner: object,
 *   loggedInProviders?: () => Iterable<string>, readTaskStores?: Function}} options
 */
export function createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders, readTaskStores }) {
	const store = createBudgetStore(db);
	/** Reviewer runs and the first PR link of a project, from the evidence ledger (C-metrics inputs). */
	const deliveryOf = (projectId) => {
		const pr = store.evidence(projectId, "pr", { first: 1 }).items[0] ?? null;
		return { reviewSpawns: store.evidence(projectId, "review-spawn").total, deliveredMs: pr?.ms ?? null, deliveredUrl: pr?.url ?? null };
	};
	let current = typeof config === "function" ? config() : config;
	const ingest = createIngest({ paths, store, clock, config: () => current, readTaskStores });
	const latestModelStmt = db.prepare(
		"SELECT model FROM usage_events WHERE session_id = ? AND model IS NOT NULL ORDER BY ms DESC LIMIT 1",
	);
	let subs = { ok: false, accounts: [] };
	let subsReadMs = -Infinity;
	let calibrationMs = -Infinity;
	let pruneMs = -Infinity;
	const calibrations = new Map(); // `${account}|${windowId}` -> calibrate() result
	const wouldActions = new Set(); // shadow: would-action events already recorded this process
	const auditSkipped = new Set(); // project ids whose goal-not-active skip was already recorded this process
	let ingestProgress = null;
	let lastSnapshot = null;

	const providersNow = () => {
		const value = typeof loggedInProviders === "function" ? loggedInProviders() : authProviders(paths.authFile);
		return value instanceof Set ? value : new Set(value ?? []);
	};

	function windowSpend(budget, account, window) {
		return (fromMs, toMs) =>
			store.spend({ sinceMs: fromMs, untilMs: toMs, accounts: { aliases: budget.providerAliases, account, window: { id: window.id, scope: window.scope } } }).costUsd;
	}

	/** Spend with a byModel that never sums to zero while the session has a model (capacity must not read 0). */
	function spendOf(project) {
		const spend = store.spend({ projectId: project.id });
		const total = Object.values(spend.byModel).reduce((sum, usd) => sum + usd, 0);
		if (!(total > 0)) {
			const row = latestModelStmt.get(project.sessionId);
			if (row?.model) spend.byModel = { [row.model]: 1 };
		}
		return spend;
	}

	function tick({ world, shadow = false } = {}) {
		if (world?.config) current = world.config;
		else if (typeof config === "function") current = config();
		const budget = current?.budget;
		if (!budget?.enabled) return { snapshot: null, messages: [], events: [] };
		const now = clock.now();
		const events = [];
		const appendEvent = (event) => {
			store.appendEvent({ ms: now, ...event });
			events.push(event);
		};
		// One skip per project, not one per tick: the goal stays inactive while its closeGrace drains.
		const skipInactiveAudit = (projectId) => {
			if (auditSkipped.has(projectId)) return;
			auditSkipped.add(projectId);
			appendEvent({ projectId, kind: "audit-skipped", data: { reason: "goal-not-active" } });
		};

		// 1. Ledger.
		const ing = ingest.run();
		ingestProgress = ing.progress ?? null;

		// 2. Subscription windows; samples only from fresh, successful readings.
		if (now - subsReadMs >= SUBSCRIPTION_EVERY_MS) {
			subsReadMs = now;
			subs = readSubscriptionUsage(paths.subscriptionUsageFile, { now, staleMs: budget.staleMs });
			const samples = [];
			for (const account of subs.accounts) {
				if (account.stale !== false) continue;
				for (const w of account.windows) {
					samples.push({ account: account.account, windowId: w.id, updatedMs: account.updatedMs, usedPercent: w.usedPercent, resetsAtMs: w.resetsAtMs, windowMinutes: w.windowMinutes });
				}
			}
			if (samples.length) store.insertQuotaSamples(samples);
		}
		const sinceSamples = now - (budget.backfillDays ?? 8) * DAY;

		// 3. Calibration per window every 10 minutes.
		if (now - calibrationMs >= CALIBRATION_EVERY_MS) {
			calibrationMs = now;
			for (const account of subs.accounts) {
				for (const w of account.windows) {
					const samples = store.quotaSamples({ account: account.account, windowId: w.id, sinceMs: sinceSamples });
					calibrations.set(`${account.account}|${w.id}`, calibrate({ samples, spendBetween: windowSpend(budget, account.account, w), cfg: budget.calibration }));
				}
			}
		}

		// 4. Projects: register every goal seen inside the backfill window.
		const graceMs = budget.closeGraceMs ?? DAY;
		const goalById = new Map();
		const registered = new Set();
		for (const [sid, goals] of ing.goals) {
			for (const goal of goals) {
				const id = `${sid}:${goal.id}`;
				goalById.set(id, { sessionId: sid, goal });
				const existing = store.getProject(id);
				if (!existing) {
					if (goal.createdMs < sinceSamples) continue;
					registered.add(id);
					store.upsertProject({
						id,
						sessionId: sid,
						goalId: goal.id,
						cwd: ing.sessions.get(sid)?.cwd ?? null,
						objective: truncate(goal.objective, 2000),
						createdMs: goal.createdMs,
						status: "tracking",
						revision: 0,
						closedMs: null,
						updatedMs: now,
						data: { ...emptyData(), goalStatus: goal.status, goalCompletedMs: goal.completedMs },
					});
				} else if (existing.data.goalStatus !== goal.status || existing.data.goalCompletedMs !== goal.completedMs) {
					// The goal's end is remembered: a replaced goal disappears from the goal file.
					store.upsertProject({ ...existing, data: { ...existing.data, goalStatus: goal.status, goalCompletedMs: goal.completedMs }, updatedMs: now });
				}
			}
		}
		const live = store.listProjects({ statuses: [...LIVE] });
		const spends = new Map(live.map((project) => [project.id, spendOf(project)]));

		// 5. Treasury.
		const states = [];
		const meta = [];
		for (const account of subs.accounts) {
			for (const w of account.windows) {
				const calibration = calibrations.get(`${account.account}|${w.id}`) ?? null;
				const samples = store.quotaSamples({ account: account.account, windowId: w.id, sinceMs: sinceSamples });
				// A stale reading is shown (state unknown) but never stored as evidence.
				if (account.stale && !samples.some((s) => s.updatedMs >= account.updatedMs)) {
					samples.push({ updatedMs: account.updatedMs, usedPercent: w.usedPercent, resetsAtMs: w.resetsAtMs, windowMinutes: w.windowMinutes });
				}
				let committedUsd = 0;
				for (const project of live) {
					const approved = approvedOf(project);
					const spend = spends.get(project.id);
					const left = Math.max(0, approved - spend.costUsd);
					if (!(left > 0)) continue;
					const inWindow = store.spend({ projectId: project.id, accounts: { aliases: budget.providerAliases, account: account.account, window: { id: w.id, scope: w.scope } } }).costUsd;
					committedUsd += spend.costUsd > 0 ? left * (inWindow / spend.costUsd) : 0;
				}
				states.push(windowState({ account: account.account, window: w, samples, calibration, committedUsd, now, cfg: budget, stale: account.stale }));
				const coefficient = calibration?.calibrated ? calibration.percentPerUsd : null;
				const epochList = epochs(samples, { earlyDropPercent: budget.calibration?.earlyDropPercent });
				const epochStart = epochList.length ? epochList[epochList.length - 1].startMs : now;
				meta.push({
					updatedMs: account.updatedMs,
					error: account.error ?? null,
					calibrationIntervals: calibration?.intervals ?? 0,
					external: externalPercent({ samples, spendBetween: windowSpend(budget, account.account, w), coefficient, sinceMs: epochStart }),
				});
			}
		}
		const treasury = summarize(states);
		const accountState = (account) => summarize(states.filter((s) => s.account === account)).state;
		const capacity = (byModel) => (reserveUsd) => capacityCheck({ states, reserveUsd, byModel, cfg: budget });

		// 6. Coupons (the daemon is the only writer of the coupons file). There is no decide command: readCommands
		// already drops a leftover one without effect.
		const coupons = readJsonSafe(paths.health.budgetCouponsFile, {}) ?? {};
		const consumed = [];
		if (!shadow) {
			let couponsChanged = false;
			for (const { file, cmd } of readCommands(paths)) {
				if (cmd.kind === "coupons" && typeof cmd.account === "string" && Number.isInteger(cmd.count)) {
					coupons[cmd.account] = cmd.count;
					couponsChanged = true;
					appendEvent({ account: cmd.account, kind: "coupons", data: { count: cmd.count } });
				} else appendEvent({ kind: "command-ignored", data: { kind: cmd.kind ?? null } });
				consumed.push(file);
			}
			if (couponsChanged) atomicWriteJson(paths.health.budgetCouponsFile, coupons);
		}

		// 7. Every live project.
		const closed = store.listProjects({ statuses: ["closed"] });
		const auditHistory = () => store.listProjects().flatMap((p) => (p.data?.audits ?? []).map((a) => ({ projectId: p.id, ms: a.ms, status: a.status })));
		const auditCfg = budget.audit ?? {};
		for (const original of live) {
			let project = original;
			const created = []; // budget messages composed this tick; they enter the durable outbox below
			const spend = spends.get(project.id);
			const info = goalById.get(project.id);
			const goalNow = goalNowOf(info, project);
			const objective = project.objective ?? "";

			// Audit in flight: one poll per tick. Its opinion is delivered and recorded, never used to decide.
			if (!shadow) {
				const audits = project.data.audits ?? [];
				const running = audits.find((a) => a.status === "running");
				if (running) {
					const polled = pollAudit(runner, running.auditId);
					if (polled.status !== "running") {
						const audit = { ...running, status: polled.status, endedMs: now };
						const usage = polled.usage ?? null;
						if (usage) {
							audit.costUsd = usage.cost ?? null;
							audit.costStatus = usage.costStatus ?? (usage.cost == null ? "missing" : "reported");
							store.insertUsage([auditUsageRow({ id: `audit:${running.auditId}`, project, model: running.model, usage, now })]);
						} else audit.costStatus = "missing";
						if (polled.status === "done") {
							audit.opinion = polled.opinion;
							created.push(composeAuditOpinion({
								sessionId: project.sessionId,
								now,
								projectId: project.id,
								revision: project.revision,
								auditId: running.auditId,
								objective,
								opinion: polled.opinion,
								model: running.model,
								ladder: running.ladder ?? null,
							}));
						} else {
							// No verdict: the audit ends without an opinion; no decision was waiting for it.
							audit.reason = polled.reason ?? null;
						}
						appendEvent({ projectId: project.id, kind: `audit-${polled.status}`, data: { auditId: running.auditId, assessment: audit.opinion?.assessment ?? null } });
						project = { ...project, data: { ...project.data, audits: audits.map((a) => (a.auditId === running.auditId ? audit : a)) } };
						spends.set(project.id, spendOf(project));
					}
				}
			}

			const projectSpend = spends.get(project.id);
			const workClass = project.data.workClass ?? undefined;
			const ref = referenceClass(closed, { workClass });
			const blocks = ing.blocks.filter((b) => b.projectId === project.id).map((b) => ({ kind: b.kind, body: b.body }));
			const out = evaluate({
				project,
				goal: goalForEvaluate(goalNow),
				spend: projectSpend,
				blocks,
				treasury,
				capacity: (reserveUsd) => capacity(projectSpend.byModel)(reserveUsd),
				ref,
				now,
				cfg: budget,
			});
			let next = out.project;
			// Bookkeeping C-estimates reads later: the spend at estimate time and the work class.
			for (const entry of next.data.estimates ?? []) if (!finite(entry.spentAtEstimate)) entry.spentAtEstimate = projectSpend.costUsd;
			const lastEstimate = (next.data.estimates ?? []).at(-1);
			if (lastEstimate?.raw?.workClass) next.data.workClass = lastEstimate.raw.workClass;
			next.updatedMs = now;

			// Indicators and audit triggers.
			const rounds = store.rounds(project.id);
			const criteria = ing.criteria.get(project.id) ?? null;
			const delivery = deliveryOf(project.id);
			const ind = indicators({ project: next, rounds, spend: projectSpend, spendSince: (ms) => store.spend({ projectId: project.id, sinceMs: ms }).costUsd, criteria, reviewSpawns: delivery.reviewSpawns, deliveredMs: delivery.deliveredMs, now });
			const child24hUsd = store.spend({ projectId: project.id, sinceMs: now - DAY, sources: ["child"] }).childUsd;
			const trig = triggers(ind, budget, { child24hUsd });
			const marks = { ...(next.data.triggerMarks ?? {}) };
			for (const t of trig) {
				const key = `${t.kind}:${t.heavy ? "heavy" : "light"}`;
				if (marks[key]) continue;
				marks[key] = now;
				if (!shadow) appendEvent({ projectId: project.id, kind: "trigger", data: t });
			}
			next.data.triggerMarks = marks;
			// The review-opinion ladder decides when the auditor looks (each tier once); a rule audit (change review, estimate
			// outlier) still asks for one at the current tier. Triggers are recorded for the dashboard, they start nothing.
			const step = ladder(ind, auditCfg);
			const lastTier = (next.data.audits ?? []).reduce((max, a) => Math.max(max, a.tier ?? 0), 0);
			const ladderDue = step.tier >= 1 && step.tier <= 3 && step.tier > lastTier;
			const ruleReasons = out.actions.filter((a) => a.type === "audit").flatMap((a) => a.reasons);
			const reasons = [...(ladderDue ? [`ladder-${step.basis}`] : []), ...ruleReasons];
			const tier = Math.max(1, Math.min(step.tier, 3));

			if (shadow) {
				for (const action of out.actions) {
					const key = `${project.id}|${action.type}|${action.actionKind ?? action.kind ?? action.reasons?.join(",")}|${next.revision}`;
					if (wouldActions.has(key)) continue;
					wouldActions.add(key);
					appendEvent({ projectId: project.id, kind: "would-action", data: { type: action.type, actionKind: action.actionKind ?? null, reasons: action.reasons ?? null } });
				}
				if (reasons.length && auditCfg.enabled) {
					if (!goalActive(goalNow.status)) skipInactiveAudit(project.id);
					else if (!registered.has(project.id)) {
						const key = `${project.id}|would-audit|${reasons.join(",")}`;
						if (!wouldActions.has(key)) {
							wouldActions.add(key);
							appendEvent({ projectId: project.id, kind: "would-action", data: { type: "audit", reasons } });
						}
					}
				}
				live[live.indexOf(original)] = { ...next, _ind: ind, _trig: trig };
				continue;
			}

			// Start an audit when a heavy trigger or a rule asks for one, the goal is still active and the caps allow it.
			// A project first registered this tick only records its trigger: the audit gate runs from the next tick,
			// so a goal that disappears between ticks never opens one. A non-active goal records one skip even when
			// this same tick closed the project (cancelled, cleared, COMPLETED).
			const goalIsActive = goalActive(goalNow.status);
			const audits = next.data.audits ?? [];
			const digesting = audits.find((a) => a.status === "digesting");
			// Raw evidence the quick digest summarizes, and the auditor's bundle (with the digest once it exists).
			const verdicts = () => store.evidence(project.id, "review-verdict", { last: MAX_REVIEW_VERDICTS });
			const raw = () => {
				const v = verdicts();
				return {
					reviews: { spawns: delivery.reviewSpawns, verdictTotal: v.total, verdicts: v.items },
					healthNotes: store.evidence(project.id, "health-note", { last: MAX_HEALTH_NOTES }).items,
					recentSteps: recentOf(ing.sessions.get(project.sessionId)?.file).steps,
				};
			};
			const bundleOf = (audit, digest) => buildBundle({
				project: { id: project.id, auditId: audit.auditId, sessionId: project.sessionId, status: next.status, revision: next.revision, approvedUsd: approvedOf(next), pending: next.data.pending, estimates: next.data.estimates },
				goal: info?.goal ?? null,
				criteria,
				rounds: rounds.map((r, i) => ({ round: r.round, firstMs: r.firstMs, costUsd: store.spend({ projectId: project.id, sinceMs: r.firstMs, untilMs: rounds[i + 1]?.firstMs }).costUsd })),
				userRequests: store.evidence(project.id, "request", { first: FIRST_USER_REQUESTS, last: MAX_USER_REQUESTS }).items,
				...raw(),
				digest,
				ladder: audit.ladder,
				earlierAudits: audits.filter((a) => a.opinion).map((a) => ({ ms: a.ms, model: a.model, tier: a.tier ?? null, assessment: a.opinion.assessment, situation: a.opinion.situation ?? null, advice: truncate(String(a.opinion.advice ?? ""), 600) })),
				delivered: delivery.deliveredMs === null ? null : { prUrl: delivery.deliveredUrl, firstSeen: new Date(delivery.deliveredMs).toISOString(), spentAfterUsd: ind.afterDeliveryUsd },
				indicators: ind,
				triggers: trig,
				ref,
				treasury,
			});
			const launch = (audit, digest) => {
				try {
					startAudit({ runner, paths, model: audit.model, bundle: bundleOf(audit, digest), projectId: project.id, auditId: audit.auditId, timeoutMs: auditCfg.timeoutMs });
					appendEvent({ projectId: project.id, kind: "audit-started", data: { auditId: audit.auditId, model: audit.model, tier: audit.tier, reasons: audit.triggers } });
					return { ...audit, status: "running" };
				} catch (error) {
					appendEvent({ projectId: project.id, kind: "audit-deferred", data: { reason: "start-failed", detail: truncate(error.message, 200), reasons: audit.triggers } });
					return { ...audit, status: "failed", reason: "start-failed", endedMs: now };
				}
			};
			if (auditCfg.enabled && !goalIsActive) {
				// A completed, replaced, cancelled, cleared or missing goal is no work left to audit.
				if (reasons.length) skipInactiveAudit(project.id);
				if (digesting) next.data.audits = audits.map((a) => (a === digesting ? { ...a, status: "cancelled", reason: "goal-not-active", endedMs: now } : a));
			} else if (auditCfg.enabled && next.status !== "closed" && !registered.has(project.id)) {
				// Past the last tier the owner decides: the session is asked, once, to put the question to them.
				if (step.tier === 4 && !finite(next.data.ownerCalledMs)) {
					next.data.ownerCalledMs = now;
					next.data.ownerCall = { ms: now, basis: step.basis, ratio: step.ratio, rounds: step.rounds };
					created.push(composeBudgetOwnerCall({ sessionId: project.sessionId, now, projectId: project.id, revision: next.revision, objective, ladder: step, spentUsd: projectSpend.costUsd, approvedUsd: approvedOf(next) }));
					appendEvent({ projectId: project.id, kind: "owner-call", data: next.data.ownerCall });
				}
				if (digesting) {
					// The quick digest ran first; whatever it produced, the auditor starts now (without a digest it reads the raw evidence).
					const polled = pollDigest(runner, digesting.auditId);
					if (polled.status !== "running") {
						if (polled.usage) store.insertUsage([auditUsageRow({ id: `audit:${digesting.auditId}:digest`, project, model: digesting.digestModel, usage: polled.usage, now })]);
						const started = launch({ ...digesting, digest: polled.status === "done" ? "done" : polled.reason }, polled.status === "done" ? polled.text : null);
						next.data.audits = audits.map((a) => (a === digesting ? started : a));
					}
				} else if (reasons.length) {
					const last = audits.at(-1) ?? null;
					const newEvidence = !last || ladderDue || reasons.includes("change-review");
					const allowed = auditAllowed({ project: next, history: auditHistory(), now, cfg: budget, newEvidence });
					const mainModel = latestModelStmt.get(project.sessionId)?.model ?? null;
					const model = allowed.allowed ? auditModel({ topModels: auditCfg.topModels, efforts: auditCfg.efforts, mainModel, tier, loggedIn: providersNow(), accountState }) : null;
					if (allowed.allowed && model) {
						const audit = {
							auditId: `budget-${createHash("sha256").update(project.id).digest("hex").slice(0, 10)}-${now}`,
							ms: now, status: "digesting", model, tier, ladder: { ...step, tier }, triggers: reasons,
							costUsd: null, costStatus: null, spentUsd: projectSpend.costUsd, roundsCount: rounds.length,
						};
						const digestModel = laneModels(paths, auditCfg.digestLane)[0] ?? null;
						let record;
						if (digestModel) {
							try {
								startDigest({ runner, paths, model: digestModel, input: buildDigestInput(raw()), auditId: audit.auditId, timeoutMs: auditCfg.timeoutMs });
								record = { ...audit, digestModel };
								appendEvent({ projectId: project.id, kind: "audit-digest-started", data: { auditId: audit.auditId, model: digestModel, tier } });
							} catch (error) {
								record = launch({ ...audit, digest: "start-failed" }, null);
							}
						} else record = launch({ ...audit, digest: "no-model" }, null);
						next.data.audits = [...audits, record];
					} else if (!finite(next.data.auditDeferredMs) || now - next.data.auditDeferredMs >= (auditCfg.minGapMs ?? 6 * HOUR)) {
						// Visible deferral, never a weak-model fallback.
						const reason = allowed.allowed ? "no-model" : allowed.reason;
						next.data.auditDeferredMs = now;
						next.data.auditDeferredReason = reason;
						appendEvent({ projectId: project.id, kind: "audit-deferred", data: { reason, reasons } });
					}
				}
			}
			for (const action of out.actions) {
				if (action.type === "event") appendEvent({ projectId: project.id, kind: action.kind, data: action.data });
				else if (action.type === "message") created.push(composeMessage(action, next, projectSpend, now));
			}
			if (next.status === "closed" && project.status !== "closed") appendEvent({ projectId: project.id, kind: "closed", data: { outcome: next.data.outcome ?? null, actualUsd: next.data.actualUsd ?? null } });
			// Every composed message waits here until the engine reports it delivered (B3): the same object and id are
			// handed back on each tick, so a recipient without a fresh sensor is retried instead of losing the message.
			const priorOutbox = next.data.outbox ?? project.data?.outbox ?? [];
			next.data.outbox = [...priorOutbox, ...created.map((message) => ({ id: message.id, message, createdMs: message.createdMs ?? now }))];
			store.upsertProject(next);
			live[live.indexOf(original)] = { ...next, _ind: ind, _trig: trig };
		}
		for (const file of consumed) removeSafe(file);

		// 7b. Outbox: drop expired entries and every entry of a closed project (one event each), then hand back every
		// pending message. A message is never composed twice; the stored object is returned until acknowledge.
		let pendingMessages = [];
		if (!shadow) {
			for (const project of store.listProjects()) {
				const outbox = project.data?.outbox ?? [];
				if (!outbox.length) continue;
				const kept = [];
				for (const entry of outbox) {
					const reason = project.status === "closed" ? "closed" : now - entry.createdMs > OUTBOX_TTL_MS ? "expired" : null;
					if (!reason) {
						kept.push(entry);
						continue;
					}
					appendEvent({ projectId: project.id, kind: "message-expired", data: { messageId: entry.id, actionKind: entry.message?.details?.actionKind ?? null, reason } });
				}
				if (kept.length !== outbox.length) store.upsertProject({ ...project, data: { ...project.data, outbox: kept }, updatedMs: now });
				// Stamped with this tick's time: the inbox sweeps a file whose createdMs is 5 min old, so a notice retried after a
				// longer wait would be swept the moment it is written. The id stays the same; only an undelivered attempt is retried.
				pendingMessages.push(...kept.map((entry) => ({ ...entry.message, createdMs: now })));
			}
		}

		if (now - pruneMs >= PRUNE_EVERY_MS) {
			pruneMs = now;
			store.prune(now, budget.retentionDays ?? 120);
		}

		// 8. Snapshot.
		const recentClosed = store.listProjects({ statuses: ["closed"] }).filter((p) => (p.closedMs ?? 0) >= sinceSamples);
		const shown = [...live, ...recentClosed];
		const projectRows = shown.map((p) => {
			const spend = spends.get(p.id) ?? spendOf(p);
			const estimate = (p.data.estimates ?? []).at(-1) ?? null;
			const latestApproval = (p.data.approvals ?? []).at(-1) ?? null;
			// The latest approval's stage: a staged grant funds up to the checkpoint it names.
			const stage = latestApproval?.staged === true ? { nextCheckpoint: latestApproval.nextCheckpoint ?? null } : null;
			const rounds = store.rounds(p.id);
			const ind = p._ind ?? indicators({ project: p, rounds, spend, spendSince: (ms) => store.spend({ projectId: p.id, sinceMs: ms }).costUsd, criteria: null, ...deliveryOf(p.id), now });
			const marks = p.data.triggerMarks ?? {};
			const details = new Map((p._trig ?? []).map((t) => [`${t.kind}:${t.heavy ? "heavy" : "light"}`, t.detail]));
			const crossed = Object.entries(marks)
				.filter(([, ms]) => finite(ms))
				.map(([key, ms]) => {
					const heavy = key.endsWith(":heavy");
					const kind = key.slice(0, key.length - (heavy ? ":heavy" : ":light").length);
					return { kind, heavy, detail: details.get(key) ?? null, firstMs: ms };
				})
				.sort((a, b) => a.firstMs - b.firstMs);
			const deferredMs = finite(p.data.auditDeferredMs) ? p.data.auditDeferredMs : null;
			const lastAuditMs = (p.data.audits ?? []).at(-1)?.ms ?? null;
			const auditDeferred = deferredMs !== null && !(finite(lastAuditMs) && lastAuditMs >= deferredMs)
				? { ms: deferredMs, reason: p.data.auditDeferredReason ?? null }
				: null;
			return {
				id: p.id,
				sessionId: p.sessionId,
				objective: truncate(redact(p.objective ?? ""), 120),
				status: p.status,
				revision: p.revision,
				spentUsd: spend.costUsd,
				mainUsd: spend.mainUsd,
				childUsd: spend.childUsd,
				auditUsd: spend.auditUsd,
				missing: spend.missing,
				approvedUsd: approvedOf(p),
				estimate: estimate?.raw?.remainingUsd ? { p10: estimate.raw.remainingUsd.p10, p50: estimate.raw.remainingUsd.p50, p90: estimate.raw.remainingUsd.p90 } : null,
				reserveUsd: estimate?.adjusted?.reserveUsd ?? null,
				stage,
				pending: p.data.pending ?? null,
				indicators: ind,
				triggers: crossed,
				auditDeferred,
				lastAudit: redactedAudit((p.data.audits ?? []).at(-1) ?? null),
				ownerCall: p.data.ownerCall ?? null,
				rounds,
			};
		});
		const auditRows = shown
			.flatMap((p) => (p.data.audits ?? []).map((a) => {
				const audit = redactedAudit(a);
				return { auditId: a.auditId, projectId: p.id, ms: a.ms, status: a.status, model: a.model ?? null, assessment: audit?.opinion?.assessment ?? null, advice: audit?.opinion?.advice ?? null, costUsd: a.costUsd ?? null };
			}))
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 20);
		const external = {};
		const windows = states.map((state, i) => {
			external[state.windowId] = meta[i].external;
			return { ...state, coupons: coupons[state.account] ?? 0, updatedMs: meta[i].updatedMs, error: meta[i].error, calibrationIntervals: meta[i].calibrationIntervals };
		});
		const snapshot = {
			v: 1,
			updatedMs: now,
			enabled: true,
			ingest: ingestProgress ? { ...ingestProgress, updatedMs: now } : null,
			treasury: { state: treasury.state, windows, external },
			projects: projectRows,
			audits: auditRows,
			events: store.events({ limit: 50 }),
		};
		atomicWriteJson(paths.health.budgetSnapshotFile, snapshot);
		lastSnapshot = snapshot;
		return { snapshot, messages: shadow ? [] : pendingMessages, events };
	}

	return {
		tick,
		/** The engine's delivery report: delivered ids leave the outbox for good (B3). */
		delivered(results = []) {
			const ids = new Set(results.filter((result) => result?.delivered === true && result.messageId).map((result) => result.messageId));
			if (!ids.size) return;
			const now = clock.now();
			for (const project of store.listProjects()) {
				const outbox = project.data?.outbox ?? [];
				const kept = outbox.filter((entry) => !ids.has(entry.id));
				if (kept.length === outbox.length) continue;
				store.upsertProject({ ...project, data: { ...project.data, outbox: kept }, updatedMs: now });
			}
		},
		snapshot() {
			return lastSnapshot ?? readJsonSafe(paths.health.budgetSnapshotFile) ?? null;
		},
	};
}

/** Projects' message actions -> C-messages composers (root session only). */
function composeMessage(action, project, spend, now) {
	const d = action.data ?? {};
	const common = { sessionId: project.sessionId, now, projectId: project.id, objective: project.objective ?? "" };
	switch (action.actionKind) {
		case "budget-request":
			return composeBudgetRequest({ ...common, revision: d.revision ?? project.revision, spend, reference: d.ref ?? {}, treasury: d.treasury ?? null });
		case "budget-correction":
			return composeBudgetCorrection({ ...common, revision: d.revision ?? project.revision, errors: d.errors ?? [] });
		case "budget-checkpoint":
			return composeBudgetCheckpoint({ ...common, revision: d.revision ?? project.revision, checkpoint: d.percent, spentUsd: d.spentUsd, approvedUsd: d.approvedUsd, mainUsd: spend.mainUsd, childUsd: spend.childUsd });
		default: {
			const pending = project.data.pending;
			// A rule denial states its reason and, when a window binds, when the request may be tried again.
			return composeBudgetDecision({
				...common,
				revision: d.revision ?? project.revision,
				decision: d.status,
				approvedUsd: d.approvedUsd,
				increaseUsd: d.status === "approved" ? 0 : pending?.increaseUsd ?? 0,
				basis: d.basis ?? "",
				windows: d.perWindow ?? [],
				denied: d.status === "denied",
				reason: typeof d.reason === "string" && d.reason ? d.reason : null,
				resetAtMs: finite(d.resetAtMs) ? d.resetAtMs : null,
				staged: d.staged === true,
				nextCheckpoint: d.nextCheckpoint ?? null,
			});
		}
	}
}
