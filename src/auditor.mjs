import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { usageTimeline } from "./collect/usage.mjs";
import { createInvestigations } from "./investigations.mjs";
import { auditBundle, auditDocument, detectorFindingRefs, firedDetectors, hasDetectorCoverage, resolveAuditModel, validateAudit } from "./judge/audit.mjs";
import { ANALYST_POLL_MS, parseAnalystOutput, unavailableReason } from "./judge/analyst.mjs";
import { laneArgs } from "./judge/lane.mjs";
import { collectAnalystDecisionModels, configDecisionFact, recoverPendingAnalystModels, usageEntryOf } from "./session-record.mjs";
import { auditReasonLabel } from "./ui/labels.mjs";
import { fresh, isSpillModelKey, readUsageIndex, relatedUsageEntries } from "./usage-index.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, readTextSafe, removeSafe, statSafe } from "./util/fsx.mjs";
import { JsonlTail } from "./util/tail.mjs";
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
const MAX_CHANGED_TIMELINES = 3;
const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;
const ACTIVE = new Set(["queued", "launching", "running"]);
const LOOKUP_PENDING = Symbol("lookup pending");

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

export function auditFileVersion(file) {
	const stat = file ? statSafe(file) : null;
	if (!stat?.isFile()) return null;
	const { size, mtimeMs, ino, birthtimeMs } = stat;
	return { size, mtimeMs, ino, birthtimeMs };
}

export function sameAuditVersion(a, b) {
	return a && b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function auditFileVersions(dir, suffix) {
	const files = new Map();
	for (const name of listDirSafe(dir)) {
		if (!name.endsWith(suffix)) continue;
		const file = path.join(dir, name);
		const version = auditFileVersion(file);
		if (version) files.set(file, version);
	}
	return files;
}

function launchAuditFacts(paths, investigations, loaded, selectedFps, auditSubjectIds, analystStart) {
	const pending = new Set(loaded.session?.pendingAnalystJobs);
	if (loaded.session?.analystModelsUnknown && !pending.size) return null;
	const models = new Set(loaded.analystModels);
	const configDecisions = [];
	const fps = new Set(selectedFps);
	const add = (model) => { if (typeof model === "string" && model) models.add(model); };
	const matches = (subject) => {
		if (!subject || !auditSubjectIds) return false;
		const { sessionId, taskId, parentSessionId } = subject;
		// A parent pointing at an unrelated task is not itself a subject match.
		return auditSubjectIds.sessionIds.has(sessionId) || (parentSessionId
			? auditSubjectIds.childTasksByParent.get(parentSessionId)?.has(taskId)
			: auditSubjectIds.taskIds.has(taskId));
	};
	for (const fp of fps) {
		const current = investigations.get(fp);
		if (current?.id === fp) add(current.model);
	}
	// A new investigation can supply the subject for decision rows that carry only its fp.
	for (const [file, version] of auditFileVersions(paths.health.investigationsDir, ".json")) {
		if (sameAuditVersion(version, analystStart.investigations.get(file))) continue;
		const current = readJsonSafe(file);
		if (typeof current?.id !== "string" || !current.id || !matches(current.subject)) continue;
		fps.add(current.id);
		add(current.model);
	}
	// The daemon appends complete decision lines. Track file boundaries rather than
	// comparing event timestamps: even a backdated append or a new day is covered.
	const decisions = auditFileVersions(paths.health.decisionsDir, ".jsonl");
	for (const file of [...decisions.keys()].sort()) {
		const version = decisions.get(file);
		const start = analystStart.decisions.get(file);
		if (sameAuditVersion(version, start)) continue;
		const tail = new JsonlTail(file, { maxReadBytes: 64 * 1024 });
		if (start && start.ino === version.ino && start.birthtimeMs === version.birthtimeMs && start.size < version.size) {
			tail.offset = start.size;
		}
		let batch;
		do {
			batch = tail.readNew();
			for (const row of batch.entries) {
				if (row?.event === "config") {
					const fact = configDecisionFact(row);
					if (fact) configDecisions.push(fact);
				}
				if (!row || (!fps.has(row.fp) && !matches(row.subject))) continue;
				if (typeof row.fp === "string" && row.fp) fps.add(row.fp);
				if (row.status !== "analyzing" && !row.analyst?.verdict && !row.jobId && row.usedModels === undefined) continue;
				if (!collectAnalystDecisionModels(models, row, paths.health.jobsDir, pending)) return null;
			}
		} while (batch.more);
	}
	return recoverPendingAnalystModels(models, pending, paths.health.jobsDir) ? { analystModels: models, configDecisions } : null;
}

export function readVersionedAuditTimeline(file, tokens, { maxFileBytes = TIMELINE_MAX_BYTES, timeline = usageTimeline, log } = {}) {
	const version = auditFileVersion(file);
	if (!version || version.size > maxFileBytes) return { full: null };
	try {
		const full = timeline(file, { ...tokens, maxFileBytes });
		if (!full) return { full };
		// usageTimeline reads against its own fstat. Bracket that scan so a file
		// that changed while opening or reading cannot certify model coverage.
		const changedDuringScan = !sameAuditVersion(version, auditFileVersion(file));
		return { full, timelineSource: { file, version, changedDuringScan } };
	} catch (error) {
		log?.warn?.("audit_timeline_failed", { file: path.basename(file), error: error.message });
		return { full: null };
	}
}

export function readAuditTimeline(file, tokens, options) {
	const { full, timelineSource } = readVersionedAuditTimeline(file, tokens, options);
	return timelineSource?.changedDuringScan ? null : full;
}

export function createAuditor({ paths, config, clock, log, runner, index, env = process.env, timelineMaxBytes = TIMELINE_MAX_BYTES, createWorker = (url, options) => new Worker(url, options), afterStart } = {}) {
	const auditsDir = paths.health.auditsDir;
	const jobsDir = paths.health.jobsDir;
	const investigations = createInvestigations({ paths, clock });
	const lookupAbort = new AbortController();
	const jobs = runner.offTick?.(lookupAbort.signal) ?? runner;
	const lookups = new Map();
	let worker;
	let pending; // Memory only. The file remains queued until a tick consumes the reply.
	const records = new Map();
	/** Memory only: a restarted daemon polls every running record at once. */
	const lastPollMs = new Map();
	let seq = 0;
	let lastPruneMs = clock.now();

	const recordFile = (sessionId) => path.join(auditsDir, `${sessionId}.json`);
	const save = (record) => atomicWriteJson(recordFile(record.sessionId), record);
	const bundleFileOf = (jobId) => path.join(jobsDir, jobId, "bundle.md");
	const held = (record) => record.holdUntilExit === true;

	// The record retains its slot and charge while a runner operation is in flight. Only a tick
	// consumes the result; promise handlers neither transition records nor start another audit.
	function lookup(record, kind, run) {
		let work = lookups.get(record);
		if (!work) {
			const value = run();
			if (!(value instanceof Promise)) return value;
			work = { kind, pending: true };
			lookups.set(record, work);
			void value.then(
				(result) => Object.assign(work, { pending: false, result }),
				(error) => Object.assign(work, { pending: false, failed: true, error }),
			);
		}
		if (work.pending) return LOOKUP_PENDING;
		lookups.delete(record);
		if (work.failed) throw work.error;
		return work.result;
	}

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
		if (lookups.get(record)?.kind === "start") return startJob(record);
		try {
			const result = lookup(record, "launch-adopt", () =>
				readJsonSafe(path.join(jobsDir, record.jobId, "meta.json")) ? "running" :
					jobs.adoptJob(record.jobId, adoptOptions(record)));
			if (result === LOOKUP_PENDING) return;
			if (result !== "running") {
				fail(record, "launch-uncertain", null, clock.now());
				return;
			}
			record.status = "running";
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

	function launchPrepared(record, now, { loaded, selectedFps, auditSubjectIds, full, warning, timelineSource, discoveryTooLarge }, changedVersions, analystStart) {
		if (config.audit?.enabled !== true) return fail(record, "disabled", null, now);
		if (discoveryTooLarge) return fail(record, "evidence-too-large", null, now);
		if (!loaded?.found) return fail(record, "not-found", null, now);
		if (readBudget(paths, now).count >= config.audit.perDay) return fail(record, "cap", null, now);
		if (warning) log?.warn?.("audit_timeline_failed", warning);
		if (timelineSource && (timelineSource.changedDuringScan ||
			!sameAuditVersion(timelineSource.version, auditFileVersion(timelineSource.file)))) {
			if (changedVersions + 1 >= MAX_CHANGED_TIMELINES) return fail(record, "models-unknown", null, now);
			return startPreparation(record, now, changedVersions + 1);
		}
		// The resident index may have learned identities since the worker prepared the evidence.
		const facts = auditModelFacts(index ? usageEntryOf(index, loaded.session ?? {}) : null, full);
		if (!facts.sessionModelsKnown) return fail(record, "models-unknown", null, now);
		const launchFacts = launchAuditFacts(paths, investigations, loaded, selectedFps, auditSubjectIds, analystStart);
		if (!launchFacts) return fail(record, "analyst-models-unknown", null, now);
		const { analystModels, configDecisions } = launchFacts;
		const choice = resolveAuditModel(paths, config, { ...facts, analystModels });
		if (!choice) return fail(record, "no-model", null, now);

		let bundle;
		try {
			bundle = auditBundle(loaded, full, { config, now, configDecisions });
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
		startJob(record);
	}

	function startJob(record) {
		const { jobId, launchMs: now } = record;
		try {
			const result = lookup(record, "start", () =>
				jobs.start({ jobId, kind: "audit", command: commandOf(), args: argsOf(record), cwd: path.join(jobsDir, jobId), timeoutMs: config.audit.timeoutMs, ...AUDIT_CONTRACT }));
			if (result === LOOKUP_PENDING) return;
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

	function lostWorker(owner, error) {
		if (worker !== owner) return; // A late exit after an error or shutdown.
		worker = undefined;
		if (pending) {
			pending.error = truncate(redact(String(error?.message ?? error)), 300);
			pending.resolve();
		}
	}

	function startPreparation(record, now, changedVersions = 0) {
		if (config.audit?.enabled !== true) return fail(record, "disabled", null, now);
		pending = { record, changedVersions, ...Promise.withResolvers() };
		try {
			if (!worker) {
				worker = createWorker(new URL("./audit-prepare-worker.mjs", import.meta.url), {
					workerData: { paths, auditPrepareWorker: true }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
				});
				const owner = worker;
				owner.on("message", (result) => {
					if (worker !== owner || !pending) return;
					pending.result = result;
					pending.resolve();
					owner.unref();
				});
				owner.on("error", (error) => lostWorker(owner, error));
				owner.on("exit", (code) => lostWorker(owner, `preparation worker exited (${code})`));
			}
			worker.ref();
			pending.analystStart = {
				decisions: auditFileVersions(paths.health.decisionsDir, ".jsonl"),
				investigations: auditFileVersions(paths.health.investigationsDir, ".json"),
			};
			// The daemon passes its resident index; an auditor built without one reads the file here, never in the worker.
			const source = index ?? readUsageIndex(paths.health.usageIndexFile);
			worker.postMessage({ sessionId: record.sessionId, now, indexEntries: relatedUsageEntries(source, record.sessionId), indexFull: source?.full === true, bounds: {
				preparationMaxBytes: TIMELINE_MAX_BYTES + MESSAGE_SCAN_TOTAL_BYTES,
				messageScanMaxBytes: timelineMaxBytes, messageScanTotalBytes: MESSAGE_SCAN_TOTAL_BYTES,
				descendantScanMax: DESCENDANT_SCAN_MAX, tokens: config.tokens,
			} });
		} catch (error) {
			worker?.terminate();
			lostWorker(worker, error);
		}
	}

	function startNext(now) {
		// A tick that had to recover a launching record starts nothing new: the next tick sees the settled slot.
		const recovering = [...records.values()].filter((record) => record.status === "launching");
		for (const record of recovering) resolveLaunching(record);
		if (recovering.length || slotHeld()) return;
		if (pending) {
			const { record, result, error, changedVersions, analystStart } = pending;
			if (!result && error === undefined) return;
			pending = undefined;
			if (error !== undefined) return fail(record, "prepare-error", error, now);
			return launchPrepared(record, now, result, changedVersions, analystStart);
		}
		const next = [...records.values()].filter((record) => record.status === "queued").sort((a, b) => a.requestedMs - b.requestedMs)[0];
		if (next) startPreparation(next, now);
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
			if (!out.exitConfirmed) record.holdUntilExit = true;
			fail(record, "timeout", null, now);
		} else if (out.status === "unavailable") {
			fail(record, `unavailable:${out.reason}`, out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		} else if (out.status === "failed" && out.spawned === false) {
			// Refund first: a restart before fail() saves the record can replay this outcome safely.
			refund(record.jobId, record.launchMs ?? now);
			fail(record, "spawn-error", out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		} else if (out.status === "failed" && out.reason === "no-job") {
			adoptRunning(record, now);
		} else if (out.status === "failed") {
			if (out.holdUntilExit) record.holdUntilExit = true;
			fail(record, String(out.reason ?? "failed"), out.detail ? truncate(redact(String(out.detail)), 300) : null, now);
		}
	}

	function adoptRunning(record, now) {
		try {
			if (lookup(record, "running-adopt", () => jobs.adoptJob(record.jobId, adoptOptions(record))) === "absent") fail(record, "no-job", null, now);
		} catch (error) {
			log?.warn?.("audit_adopt_pending", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
		}
	}

	/** A termination request is not proof of exit; only a negative liveness check releases a legacy hold. */
	function releaseHold(record) {
		try {
			const remains = (alive) => {
				if (!alive) return false;
				const termination = jobs.terminate(record.jobId);
				return termination instanceof Promise ? termination.then(() => true) : true;
			};
			if (lookup(record, "hold", () => {
				const alive = jobs.alive(record.jobId);
				return alive instanceof Promise ? alive.then(remains) : remains(alive);
			}) !== false) return;
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
			const work = lookups.get(record);
			if (!work) {
				if (last !== undefined && now - last < ANALYST_POLL_MS) continue;
				lastPollMs.set(record.sessionId, now);
			}
			if (!running) {
				releaseHold(record);
				continue;
			}
			if (work?.kind === "running-adopt") {
				adoptRunning(record, now);
				continue;
			}
			let out;
			try {
				out = lookup(record, "poll", () => jobs.poll(record.jobId));
			} catch (error) {
				log?.warn?.("audit_poll_failed", { sessionId: record.sessionId, jobId: record.jobId, error: error.message });
				continue;
			}
			if (out !== LOOKUP_PENDING) finish(record, out ?? {}, now);
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
		preparing: () => pending?.promise,
		close() {
			lookupAbort.abort();
			lookups.clear();
			const owner = worker;
			worker = undefined;
			pending?.resolve();
			pending = undefined;
			return owner?.terminate();
		},
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
