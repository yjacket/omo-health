import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { usageTimeline } from "./collect/usage.mjs";
import { auditBundle, auditDocument, detectorFindingRefs, firedDetectors, hasDetectorCoverage, resolveAuditModel, validateAudit } from "./judge/audit.mjs";
import { ANALYST_POLL_MS, parseAnalystOutput, unavailableReason } from "./judge/analyst.mjs";
import { laneArgs } from "./judge/lane.mjs";
import { loadSessionRecord, usageEntryOf } from "./session-record.mjs";
import { auditReasonLabel } from "./ui/labels.mjs";
import { fresh, isSpillModelKey, readUsageIndex } from "./usage-index.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, readTextSafe, removeSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * The daemon's audit state machine (plan todo 12, GAP-11): owner-requested, display-only reviews of one session by a
 * third model, one at a time per PC. The dashboard only drops a request file (`audits/requests/<id>.json`); this module
 * is the only writer of `audits/<id>.json` and `audits/_budget.json`, and the only caller of the runner for audits.
 *
 * Every transition is persisted before the next side effect, so a daemon that dies anywhere is recovered from files:
 * a `launching` record is resolved through `jobs/<jobId>/meta.json` or `runner.adoptJob`, never started twice, and a
 * job's slot is released only on a confirmed exit or a confirmed absence.
 */

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
export const REQUEST_TTL_MS = 10 * MIN;
export const MESSAGE_SCAN_TOTAL_BYTES = 64 * 1024 * 1024;
const DESCENDANT_SCAN_MAX = 50;
const TIMELINE_MAX_BYTES = 256 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;
const ACTIVE = new Set(["queued", "launching", "running"]);

/** The audit job's two runner functions, module-level so the runner can be built before the auditor. */
export const AUDIT_CONTRACT = Object.freeze({ parse: (out) => parseAnalystOutput(out, "overall"), unavailableReason });

/** The id when it is safe as a file name (an id that matched a ledger row looks like this), else null. */
export function safeAuditId(id) {
	return typeof id === "string" && SAFE_ID.test(id) ? id : null;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function readBudget(paths, now) {
	const day = dayOf(now);
	const raw = readJsonSafe(paths.health.auditBudgetFile);
	if (raw?.day === day && Number.isFinite(raw.count) && Array.isArray(raw.jobs)) {
		return {
			day,
			count: raw.count,
			jobs: raw.jobs.filter((job) => typeof job === "string"),
			refunded: Array.isArray(raw.refunded) ? raw.refunded.filter((job) => typeof job === "string") : [],
		};
	}
	return { day, count: 0, jobs: [], refunded: [] };
}

/** Publish a complete request without replacing an existing claim for the id. */
export function requestAudit(paths, sessionId, nowMs) {
	const id = safeAuditId(sessionId);
	if (!id) throw new Error("invalid session id");
	const request = { v: 1, sessionId: id, requestedMs: nowMs, claimId: crypto.randomUUID() };
	const dir = ensureDir(paths.health.auditRequestsDir);
	const file = path.join(dir, `${id}.json`);
	const temp = path.join(dir, `.${request.claimId}.tmp`);
	try {
		fs.writeFileSync(temp, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
		try {
			fs.linkSync(temp, file);
		} catch (error) {
			if (error.code === "EEXIST") return { created: false };
			throw error;
		}
		return { created: true, request };
	} finally {
		removeSafe(temp);
	}
}

/** Withdraw a claim only if the pending request still belongs to that caller. */
export function withdrawAuditRequest(paths, sessionId, claimId) {
	const id = safeAuditId(sessionId);
	if (!id || typeof claimId !== "string") return;
	const file = path.join(paths.health.auditRequestsDir, `${id}.json`);
	const pending = readJsonSafe(file);
	if (pending?.v === 1 && pending.sessionId === id && pending.claimId === claimId) removeSafe(file);
}

/** The session's audit record; an active one wins, else a waiting request, else the last finished record, else null. */
export function readAuditState(paths, sessionId) {
	const id = safeAuditId(sessionId);
	if (!id) return null;
	const record = readJsonSafe(path.join(paths.health.auditsDir, `${id}.json`));
	const held = record?.holdUntilExit === true;
	if (!record || (!ACTIVE.has(record.status) && !held)) {
		const request = readJsonSafe(path.join(paths.health.auditRequestsDir, `${id}.json`));
		if (request?.v === 1 && request.sessionId === id) {
			const { requestedMs, claimId } = request;
			return { v: 1, sessionId: id, status: "requested", requestedMs, ...(typeof claimId === "string" ? { claimId } : {}) };
		}
	}
	if (record?.status === "failed" && record.reason) return { ...record, reasonKo: auditReasonLabel(record.reason) };
	return record ?? null;
}

/** Audits charged today (UTC) plus requests still waiting for the daemon. */
export function auditsToday(paths, nowMs) {
	const pending = listDirSafe(paths.health.auditRequestsDir).filter((name) => name.endsWith(".json")).length;
	return readBudget(paths, nowMs).count + pending;
}

const blankRecord = (sessionId, requestedMs) => ({
	v: 1,
	sessionId,
	status: "queued",
	requestedMs,
	startedMs: null,
	finishedMs: null,
	jobId: null,
	laneSessionId: null,
	model: null,
	lane: null,
	independence: null,
	prepMs: null,
	result: null,
	reason: null,
	detail: null,
});

const refsOf = (bundle) => {
	const record = bundle.omo_health_record ?? {};
	return ["T", ...["findings", "actions", "investigations", "messages"].flatMap((key) => (record[key] ?? []).map((row) => row.ref))].filter(Boolean);
};

/** Use a full timeline or fresh publication as proof of coverage. Either source
 * can veto the choice if it lost identities; even a stale publication supplies
 * identities to exclude, but cannot establish coverage on its own. */
export function auditModelFacts(entry, full) {
	const indexed = entry ? [entry.usage, entry.overlay, entry.published] : [];
	const totals = full?.totals;
	const indexComplete = Boolean(entry) && indexed.every((tree) => tree?.modelsIncomplete === false);
	const timelineComplete = totals?.modelsIncomplete === false;
	const sessionModels = new Set();
	for (const tree of [totals, ...indexed]) {
		for (const map of [tree?.usedModels, tree?.models]) {
			for (const key of Object.keys(map ?? {})) {
				if (!isSpillModelKey(key)) sessionModels.add(key);
			}
		}
	}
	return {
		sessionModels: [...sessionModels],
		sessionModelsKnown: (!entry || indexComplete) && (!full || timelineComplete) &&
			(timelineComplete || (indexComplete && fresh(entry))),
	};
}

export function readAuditTimeline(file, tokens, { maxFileBytes = TIMELINE_MAX_BYTES, timeline = usageTimeline, log } = {}) {
	const stat = file ? statSafe(file) : null;
	if (!stat?.isFile() || stat.size > maxFileBytes) return null;
	try {
		return timeline(file, { ...tokens, maxFileBytes });
	} catch (error) {
		log?.warn?.("audit_timeline_failed", { file: path.basename(file), error: error.message });
		return null;
	}
}

/**
 * @returns {{tick(now: number): void, busy(): boolean}}
 */
export function createAuditor({ paths, config, clock, log, runner, index, env = process.env, timelineMaxBytes = TIMELINE_MAX_BYTES, loadRecord = loadSessionRecord, timeline = usageTimeline, afterStart } = {}) {
	const auditsDir = paths.health.auditsDir;
	const jobsDir = paths.health.jobsDir;
	const locator = createSessionFileLocator({ paths, clock, ...(index ? { indexedFile: (id) => index.get(id)?.file } : {}) });
	const records = new Map();
	/** Memory only: a restarted daemon polls every running record at once. */
	const lastPollMs = new Map();
	let seq = 0;
	let lastPruneMs = clock.now();

	const recordFile = (sessionId) => path.join(auditsDir, `${sessionId}.json`);
	const save = (record) => atomicWriteJson(recordFile(record.sessionId), record);
	const bundleFileOf = (jobId) => path.join(jobsDir, jobId, "bundle.md");
	const held = (record) => record.holdUntilExit === true;

	for (const name of listDirSafe(auditsDir)) {
		if (!name.endsWith(".json") || name.startsWith("_")) continue;
		const record = readJsonSafe(path.join(auditsDir, name));
		if (record?.v === 1 && safeAuditId(record.sessionId) && typeof record.status === "string") records.set(record.sessionId, record);
	}

	const fail = (record, reason, detail, now) => {
		record.status = "failed";
		record.reason = reason;
		record.detail = detail ?? null;
		record.finishedMs = now;
		save(record);
	};

	function charge(jobId, now) {
		const budget = readBudget(paths, now);
		if (budget.jobs.includes(jobId) || budget.refunded.includes(jobId)) return;
		atomicWriteJson(paths.health.auditBudgetFile, {
			day: budget.day,
			count: budget.count + 1,
			jobs: [...budget.jobs, jobId],
			...(budget.refunded.length ? { refunded: budget.refunded } : {}),
		});
	}

	function refund(jobId, chargedMs) {
		const budget = readBudget(paths, chargedMs);
		if (!budget.jobs.includes(jobId) || budget.refunded.includes(jobId)) return;
		atomicWriteJson(paths.health.auditBudgetFile, {
			...budget,
			count: Math.max(0, budget.count - 1),
			jobs: budget.jobs.filter((job) => job !== jobId),
			refunded: [...budget.refunded, jobId],
		});
	}

	const commandOf = () => env.OMO_HEALTH_OMO ?? config.analyst?.command ?? "omo";
	const argsOf = (record) => laneArgs({ model: record.model, bundleFile: bundleFileOf(record.jobId), sessionId: record.laneSessionId });
	const adoptOptions = (record) => ({ command: commandOf(), args: argsOf(record), startedMs: record.startedMs ?? record.launchMs, timeoutMs: config.audit.timeoutMs, kind: "audit" });

	/** The record's job has a meta.json (it was spawned), or the process is found by its own argv; a lookup error keeps it launching. */
	function resolveLaunching(record) {
		try {
			if (readJsonSafe(path.join(jobsDir, record.jobId, "meta.json"))) {
				record.status = "running";
			} else if (runner.adoptJob(record.jobId, adoptOptions(record)) === "running") {
				record.status = "running";
			} else {
				fail(record, "launch-uncertain", null, clock.now());
				return;
			}
			record.startedMs = record.launchMs ?? clock.now();
			save(record);
		} catch (error) {
			log?.warn?.("audit_recover_pending", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
		}
	}

	for (const record of records.values()) if (record.status === "launching") resolveLaunching(record);

	function intake(now) {
		const dir = paths.health.auditRequestsDir;
		for (const name of listDirSafe(dir)) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			const request = readJsonSafe(file);
			const id = safeAuditId(request?.sessionId);
			if (request?.v !== 1 || !id || `${id}.json` !== name || !Number.isFinite(request.requestedMs)) {
				removeSafe(file);
				continue;
			}
			const existing = records.get(id);
			if (existing && (ACTIVE.has(existing.status) || held(existing))) {
				removeSafe(file);
				continue;
			}
			const record = blankRecord(id, request.requestedMs);
			if (typeof request.claimId === "string") record.claimId = request.claimId;
			if (now - request.requestedMs > REQUEST_TTL_MS) {
				record.status = "failed";
				record.reason = "expired";
				record.finishedMs = now;
			}
			// Publish the record before releasing the claim so dashboards can recheck it.
			save(record);
			records.set(id, record);
			removeSafe(file);
		}
	}

	/** The session's own usage entry, its file, and the models the audited session used. */
	function usageFacts(record, usage) {
		const session = record.session ?? {};
		const entry = usageEntryOf(usage, session);
		const file = entry?.file ?? (session.taskId ? null : locator.mainFile(session.sessionId)) ?? null;
		return { entry, file };
	}

	function prepare(record, now) {
		if (config.audit?.enabled !== true) return fail(record, "disabled", null, now);
		const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
		const loaded = loadRecord({ paths, id: record.sessionId, now, messageScanMaxBytes: timelineMaxBytes, messageScanTotalBytes: MESSAGE_SCAN_TOTAL_BYTES, descendantScanMax: DESCENDANT_SCAN_MAX, auditRetention: true, locator, index: usage });
		if (!loaded?.found) return fail(record, "not-found", null, now);
		if (readBudget(paths, now).count >= config.audit.perDay) return fail(record, "cap", null, now);

		const { entry, file } = usageFacts(loaded, usage);
		const full = readAuditTimeline(file, config.tokens, { maxFileBytes: timelineMaxBytes, timeline, log });
		// The record join already collected every analyst model for its selected fps, including decision-only fps.
		const analystModels = loaded.analystModels ?? [];
		const choice = resolveAuditModel(paths, config, { ...auditModelFacts(entry, full), analystModels });
		if (choice?.blocked === "models-unknown") return fail(record, "models-unknown", null, now);
		if (!choice) return fail(record, "no-model", null, now);

		let bundle;
		try {
			bundle = auditBundle(loaded, full, { config, now });
		} catch (error) {
			return fail(record, error.message === "evidence-too-large" ? "evidence-too-large" : "prepare-error", error.message === "evidence-too-large" ? null : truncate(redact(error.message), 300), now);
		}

		const safe8 = record.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "x";
		const jobId = `audit-${now.toString(36)}-${(seq++).toString(36)}-${safe8}`;
		const laneSessionId = crypto.randomUUID();
		const jobDir = path.join(jobsDir, jobId);
		ensureDir(jobDir);
		atomicWriteFile(bundleFileOf(jobId), auditDocument(bundle));
		atomicWriteJson(path.join(jobDir, "refs.json"), { refs: refsOf(bundle), findingRefs: detectorFindingRefs(bundle) });
		atomicWriteJson(path.join(jobDir, "analyst.json"), { jobId, sessionId: laneSessionId, kind: "audit", subject: { sessionId: loaded.session?.sessionId ?? record.sessionId, taskId: loaded.session?.taskId ?? null }, model: choice.model, lane: choice.lane, createdMs: now });

		Object.assign(record, { status: "launching", jobId, laneSessionId, model: choice.model, lane: choice.lane, independence: choice.independence, launchMs: now, prepMs: Number.isFinite(full?.prepMs) ? Math.round(full.prepMs) : null });
		record.firedDetectors = firedDetectors(bundle);
		save(record);
		charge(jobId, now);
		try {
			runner.start({ jobId, kind: "audit", command: commandOf(), args: argsOf(record), cwd: jobDir, timeoutMs: config.audit.timeoutMs, ...AUDIT_CONTRACT });
		} catch (error) {
			if (error?.spawned === false) {
				refund(jobId, now);
				return fail(record, "spawn-error", truncate(redact(String(error.message)), 300), now);
			}
			// A process may exist: keep the charge and the slot; recovery resolves it through meta.json or adoptJob.
			log?.warn?.("audit_start_uncertain", { sessionId: record.sessionId, jobId, error: error?.message });
			return;
		}
		afterStart?.({ jobId });
		record.status = "running";
		record.startedMs = now;
		save(record);
		lastPollMs.set(record.sessionId, now);
	}

	const slotHeld = () => [...records.values()].some((record) => record.status === "launching" || record.status === "running" || held(record));

	function startNext(now) {
		// A tick that had to recover a launching record starts nothing new: the next tick sees the settled slot.
		const recovering = [...records.values()].filter((record) => record.status === "launching");
		for (const record of recovering) resolveLaunching(record);
		if (recovering.length || slotHeld()) return;
		const next = [...records.values()].filter((record) => record.status === "queued").sort((a, b) => a.requestedMs - b.requestedMs)[0];
		if (next) prepare(next, now);
	}

	function finish(record, out, now) {
		if (out.status === "done") {
			const metadata = readJsonSafe(path.join(jobsDir, record.jobId, "refs.json"));
			const refs = Array.isArray(metadata) ? metadata : metadata?.refs;
			const verdict = validateAudit(out.result ?? null, { refs: Array.isArray(refs) ? refs : [] });
			if (verdict.ok) {
				// In-flight audits from before coverage tracking cannot prove complete review.
				if (!Array.isArray(record.firedDetectors) || !hasDetectorCoverage(verdict.result.checks, record.firedDetectors, metadata?.findingRefs ?? {})) {
					return fail(record, "incomplete-checks", null, now);
				}
				record.status = "done";
				record.result = verdict.result;
				record.reason = null;
				record.detail = null;
				record.finishedMs = now;
				save(record);
			} else {
				fail(record, "bad-output", truncate(redact(readTextSafe(path.join(jobsDir, record.jobId, "out.txt"), "")), 300), now);
			}
		} else if (out.status === "timeout") {
			record.holdUntilExit = true;
			fail(record, "timeout", null, now);
		} else if (out.status === "unavailable") {
			fail(record, `unavailable:${out.reason}`, out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		} else if (out.status === "failed" && out.spawned === false) {
			// Refund first: a restart before fail() saves the record can replay this outcome safely.
			refund(record.jobId, record.launchMs ?? now);
			fail(record, "spawn-error", out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		} else if (out.status === "failed" && out.reason === "no-job") {
			try {
				if (runner.adoptJob(record.jobId, adoptOptions(record)) === "absent") fail(record, "no-job", null, now);
			} catch (error) {
				log?.warn?.("audit_adopt_pending", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
			}
		} else if (out.status === "failed") {
			fail(record, String(out.reason ?? "failed"), out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		}
	}

	/** A timed-out job's tree stays the one-per-PC slot until it is confirmed gone; a failed kill is retried each poll. */
	function releaseHold(record) {
		try {
			if (runner.alive(record.jobId)) {
				runner.terminate(record.jobId);
				return;
			}
		} catch (error) {
			log?.warn?.("audit_hold_pending", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
			return;
		}
		delete record.holdUntilExit;
		save(record);
	}

	function poll(now) {
		for (const record of records.values()) {
			const running = record.status === "running";
			if (!running && !(record.status === "failed" && held(record))) continue;
			const last = lastPollMs.get(record.sessionId);
			if (last !== undefined && now - last < ANALYST_POLL_MS) continue;
			lastPollMs.set(record.sessionId, now);
			if (!running) {
				releaseHold(record);
				continue;
			}
			let out;
			try {
				out = runner.poll(record.jobId);
			} catch (error) {
				log?.warn?.("audit_poll_failed", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
				continue;
			}
			finish(record, out ?? {}, now);
		}
	}

	function prune(now) {
		if (now - lastPruneMs < DAY_MS) return;
		lastPruneMs = now;
		const cutoff = now - config.history.retentionDays * DAY_MS;
		for (const [id, record] of records) {
			if (ACTIVE.has(record.status) || held(record)) continue;
			if ((record.finishedMs ?? record.requestedMs ?? now) >= cutoff) continue;
			removeSafe(recordFile(id));
			records.delete(id);
			lastPollMs.delete(id);
		}
	}

	return {
		tick(now) {
			intake(now);
			startNext(now);
			poll(now);
			prune(now);
		},
		/** True while an audit is queued, launching or running, or a timed-out job's process may still live. */
		busy() {
			return [...records.values()].some((record) => ACTIVE.has(record.status) || held(record));
		},
	};
}
