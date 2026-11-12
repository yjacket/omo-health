// C-office: the budget office. One tick = ingest the ledger, read the subscription windows, recompute calibration and
// treasury states, drain owner commands, evaluate every live project (C-projects), start and poll audits (todo 14),
// write the snapshot, and hand back composed budget messages for the engine to deliver. Shadow mode computes and
// writes the snapshot but sends nothing, starts no audit, consumes no command and keeps project state unchanged
// (would-actions become events). The office never imports the engine.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	composeAuditOpinion,
	composeBudgetCheckpoint,
	composeBudgetCorrection,
	composeBudgetDecision,
	composeBudgetRequest,
} from "../act/messages.mjs";
import { readSubscriptionUsage } from "../collect/subscriptions.mjs";
import { atomicWriteJson, readJsonSafe, removeSafe } from "../util/fsx.mjs";
import { redact, truncate } from "../util/text.mjs";
import { buildBundle, chooseModel } from "./audit.mjs";
import { pollAudit, startAudit } from "./audit-job.mjs";
import { calibrate, epochs, externalPercent } from "./calibration.mjs";
import { readCommands } from "./commands.mjs";
import { referenceClass } from "./estimates.mjs";
import { createIngest } from "./ingest.mjs";
import { auditAllowed, indicators, triggers } from "./metrics.mjs";
import { evaluate } from "./projects.mjs";
import { createBudgetStore, redactDeep } from "./store.mjs";
import { capacityCheck, summarize, windowState } from "./treasury.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SUBSCRIPTION_EVERY_MS = 60_000;
const CALIBRATION_EVERY_MS = 10 * MIN;
const PRUNE_EVERY_MS = HOUR;
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
const AUDIT_DONE = new Set(["done", "failed", "timeout", "unavailable"]);

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

/** The last assistant steps and user requests of a transcript tail, for the audit bundle. */
function recentOf(file) {
	const steps = [];
	const requests = [];
	if (!file) return { steps, requests };
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
		return { steps, requests };
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
			if (message.role === "user" && item?.type === "text") requests.push(String(item.text ?? ""));
			if (message.role !== "assistant") continue;
			if (item?.type === "text" && item.text) steps.push(String(item.text).replace(/\s+/g, " "));
			else if (item?.type === "toolCall") steps.push(`${item.name}: ${JSON.stringify(item.arguments ?? {})}`);
		}
	}
	return { steps: steps.slice(-60), requests: requests.slice(-3) };
}

/**
 * @param {{paths: object, db: object, clock: {now(): number}, config: object|function, runner: object,
 *   loggedInProviders?: () => Iterable<string>, readTaskStores?: Function}} options
 */
export function createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders, readTaskStores }) {
	const store = createBudgetStore(db);
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

		// 6. Coupons and owner commands (the daemon is the only writer of the coupons file).
		const coupons = readJsonSafe(paths.health.budgetCouponsFile, {}) ?? {};
		const ownerCommands = [];
		const consumed = [];
		if (!shadow) {
			let couponsChanged = false;
			for (const { file, cmd } of readCommands(paths)) {
				if (cmd.kind === "coupons" && typeof cmd.account === "string" && Number.isInteger(cmd.count)) {
					coupons[cmd.account] = cmd.count;
					couponsChanged = true;
					appendEvent({ account: cmd.account, kind: "coupons", data: { count: cmd.count } });
				} else if (cmd.kind === "decide") ownerCommands.push({ projectId: cmd.projectId, requestId: cmd.requestId, approve: cmd.approve === true });
				else appendEvent({ kind: "command-ignored", data: { kind: cmd.kind ?? null } });
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

			// Audit in flight: one poll per tick.
			let auditResult = null;
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
							store.insertUsage([{
								id: `audit:${running.auditId}`,
								ms: now,
								sessionId: `audit:${running.auditId}`,
								rootSessionId: project.sessionId,
								projectId: project.id,
								taskId: null,
								source: "audit",
								provider: running.model?.split("/")[0] ?? null,
								model: running.model ?? null,
								input: usage.input ?? 0,
								output: usage.output ?? 0,
								cacheRead: usage.cacheRead ?? 0,
								cacheWrite: usage.cacheWrite ?? 0,
								cost: usage.cost ?? null,
								costStatus: usage.cost == null ? "missing" : "reported",
							}]);
						} else audit.costStatus = "missing";
						if (polled.status === "done") {
							audit.opinion = polled.opinion;
							auditResult = polled.opinion;
							created.push(composeAuditOpinion({
								sessionId: project.sessionId,
								now,
								projectId: project.id,
								revision: project.revision,
								auditId: running.auditId,
								objective,
								assessment: polled.opinion.assessment,
								confidence: polled.opinion.confidence,
								advice: polled.opinion.advice,
								findings: polled.opinion.findings,
								model: running.model,
							}));
						} else {
							audit.reason = polled.reason ?? null;
							// No verdict: a change waiting for the auditor goes to the owner instead of waiting forever.
							auditResult = { assessment: "insufficient-evidence", allocationOpinion: { assessment: "insufficient-evidence", reason: `audit ${polled.status}` } };
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
				ownerCommands,
				auditResult,
				now,
				cfg: budget,
			});
			const next = out.project;
			// Bookkeeping C-estimates reads later: the spend at estimate time and the work class.
			for (const entry of next.data.estimates ?? []) if (!finite(entry.spentAtEstimate)) entry.spentAtEstimate = projectSpend.costUsd;
			const lastEstimate = (next.data.estimates ?? []).at(-1);
			if (lastEstimate?.raw?.workClass) next.data.workClass = lastEstimate.raw.workClass;
			next.updatedMs = now;

			// Indicators and audit triggers.
			const rounds = store.rounds(project.id);
			const criteria = ing.criteria.get(project.id) ?? null;
			const ind = indicators({ project: next, rounds, spend: projectSpend, spendSince: (ms) => store.spend({ projectId: project.id, sinceMs: ms }).costUsd, criteria, now });
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
			const reasons = [...trig.filter((t) => t.heavy).map((t) => t.kind), ...out.actions.filter((a) => a.type === "audit").flatMap((a) => a.reasons)];

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

			for (const action of out.actions) {
				if (action.type === "event") appendEvent({ projectId: project.id, kind: action.kind, data: action.data });
				else if (action.type === "message") created.push(composeMessage(action, next, projectSpend, now));
			}
			if (next.status === "closed" && project.status !== "closed") appendEvent({ projectId: project.id, kind: "closed", data: { outcome: next.data.outcome ?? null, actualUsd: next.data.actualUsd ?? null } });

			// Start an audit when a heavy trigger or a rule asks for one, the goal is still active and the caps allow it.
			// A project first registered this tick only records its trigger: the audit gate runs from the next tick,
			// so a goal that disappears between ticks never opens one. A non-active goal records one skip even when
			// this same tick closed the project (cancelled, cleared, COMPLETED).
			const goalIsActive = goalActive(goalNow.status);
			if (reasons.length && auditCfg.enabled && !goalIsActive) {
				// A completed, replaced, cancelled, cleared or missing goal is no work left to audit.
				skipInactiveAudit(project.id);
			} else if (reasons.length && auditCfg.enabled && next.status !== "closed" && !registered.has(project.id)) {
				const audits = next.data.audits ?? [];
				const last = audits.at(-1) ?? null;
				const newEvidence = !last
					|| rounds.length - (last.roundsCount ?? 0) >= 3
					|| reasons.includes("change-review")
					|| (finite(last.spentUsd) && projectSpend.costUsd >= last.spentUsd * 1.5);
				const allowed = auditAllowed({ project: next, history: auditHistory(), now, cfg: budget, newEvidence });
				const model = allowed.allowed ? chooseModel({ models: auditCfg.models, loggedIn: providersNow(), accountState }) : null;
				if (allowed.allowed && model) {
					const auditId = `budget-${createHash("sha256").update(project.id).digest("hex").slice(0, 10)}-${now}`;
					const recent = recentOf(ing.sessions.get(project.sessionId)?.file);
					const roundTable = rounds.map((r, i) => ({ round: r.round, firstMs: r.firstMs, costUsd: store.spend({ projectId: project.id, sinceMs: r.firstMs, untilMs: rounds[i + 1]?.firstMs }).costUsd }));
					const bundle = buildBundle({
						project: { id: project.id, auditId, sessionId: project.sessionId, status: next.status, revision: next.revision, approvedUsd: approvedOf(next), pending: next.data.pending, estimates: next.data.estimates },
						goal: info?.goal ?? null,
						criteria,
						rounds: roundTable,
						recentSteps: recent.steps,
						userRequests: recent.requests,
						indicators: ind,
						triggers: trig,
						ref,
						treasury,
					});
					try {
						startAudit({ runner, paths, model, bundle, projectId: project.id, auditId, timeoutMs: auditCfg.timeoutMs });
						next.data.audits = [...audits, { auditId, ms: now, status: "running", model, triggers: reasons, costUsd: null, costStatus: null, spentUsd: projectSpend.costUsd, roundsCount: rounds.length }];
						if (next.data.pending?.route === "auditor") next.data.pending = { ...next.data.pending, auditId };
						appendEvent({ projectId: project.id, kind: "audit-started", data: { auditId, model, reasons } });
					} catch (error) {
						appendEvent({ projectId: project.id, kind: "audit-deferred", data: { reason: "start-failed", detail: truncate(error.message, 200), reasons } });
					}
				} else if (!finite(next.data.auditDeferredMs) || now - next.data.auditDeferredMs >= (auditCfg.minGapMs ?? 6 * HOUR)) {
					// Visible deferral, never a weak-model fallback.
					const reason = allowed.allowed ? "no-model" : allowed.reason;
					next.data.auditDeferredMs = now;
					next.data.auditDeferredReason = reason;
					appendEvent({ projectId: project.id, kind: "audit-deferred", data: { reason, reasons } });
				}
			}
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
				pendingMessages.push(...kept.map((entry) => entry.message));
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
			const rounds = store.rounds(p.id);
			const ind = p._ind ?? indicators({ project: p, rounds, spend, spendSince: (ms) => store.spend({ projectId: p.id, sinceMs: ms }).costUsd, criteria: null, now });
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
				pending: p.data.pending ?? null,
				indicators: ind,
				triggers: crossed,
				auditDeferred,
				lastAudit: redactedAudit((p.data.audits ?? []).at(-1) ?? null),
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
		const owner = shown
			.filter((p) => p.data.pending?.route === "owner")
			.map((p) => {
				const request = (p.data.estimates ?? []).find((e) => e.requestId === p.data.pending.requestId);
				return { projectId: p.id, requestId: p.data.pending.requestId, kind: p.data.pending.kind, increaseUsd: p.data.pending.increaseUsd, reason: request?.raw?.reason ?? null, sinceMs: p.data.pending.sinceMs };
			});
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
			owner,
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
			return composeBudgetDecision({
				...common,
				revision: d.revision ?? project.revision,
				decision: d.status,
				approvedUsd: d.approvedUsd,
				increaseUsd: d.status === "approved" ? 0 : pending?.increaseUsd ?? 0,
				by: d.by,
				basis: d.basis ?? "",
				windows: d.perWindow ?? [],
				denied: d.status === "denied",
			});
		}
	}
}
