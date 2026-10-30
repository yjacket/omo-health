import fs from "node:fs";
import path from "node:path";
import { pendingMessages, sendToSession, sweepUndelivered } from "./act/inbox.mjs";
import { executeKill } from "./act/kill.mjs";
import { composeAbortContinue, composeActionNotice, composeBootGapNotice, composeGoalWake, composeMainStallNotice, composeMonitorOrphanNotice, composeNudge, composeRelayCancel, composeRespawnNotice, composeRespawnTriageNotice, composeRevertNotice, composeScopeCheck, composeTriageNotice, composeWake, composeWhyNotice, composeWrongCommandRelease } from "./act/messages.mjs";
import { ownerKeyOf } from "./baseline.mjs";
import { footerText, waitingText, writeGlobalStatus, writeSessionStatus } from "./act/notify.mjs";
import { writeReport } from "./act/reports.mjs";
import { EventWindow } from "./collect/logs.mjs";
import { procKey, ProcessTracker } from "./collect/procs.mjs";
import { readPause } from "./control.mjs";
import { createAnomalyWatch } from "./anomaly/watch.mjs";
import { ANOMALY_DETECTOR } from "./anomaly/signals.mjs";
import { closeDb } from "./db/db.mjs";
import { appendDecision } from "./decisions.mjs";
import { makeFinding, SEVERITY_RANK } from "./detect/finding.mjs";
import { beyondReach, readMonitorManifests, restoreRemembered, sessionFileFor, unionMonitors, watcherMembers } from "./detect/monitor-orphans.mjs";
import { readReflectionRuns, reflectionOrphans } from "./detect/reflection-orphans.mjs";
import { readSessionTerminalManifest } from "./detect/goal-liveness.mjs";
import { CRASH_ACTIONS, performCrashAction } from "./act/crash-resume.mjs";
import { readDagRuns, readHostExits } from "./collect/crashes.mjs";
import { createTaskStoreReader, readGoalStore } from "./collect/tasks.mjs";
import { createWorkReader } from "./collect/work.mjs";
import { workWakeCount } from "./util/wake-sources.mjs";
import { readParkRecords } from "./collect/parks.mjs";
import { defaultLaunchers, defaultTerminals, runParkLifecycle } from "./act/park-resume.mjs";
import { couldNotAnswer, gate, needsWhy, newRecord, planFinding, planReport, planWhy, PROCESS_ACTIONS, settle } from "./judge/policy.mjs";
import { ANALYST_POLL_MS } from "./judge/analyst.mjs";
import { compactFinding, triageSignature } from "./judge/triage.mjs";
import { createInvestigations, RESOLVED } from "./investigations.mjs";
import { installedOmoRoot } from "./paths.mjs";
import { buildWorld } from "./state.mjs";
import { listDirSafe, readJsonSafe, statSafe } from "./util/fsx.mjs";
import { truncate } from "./util/text.mjs";

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
/** A finding that disappeared still owes its one explanation for this long (analyst-why e2). */
const GONE_WHY_MS = 2 * HOUR_MS;
const STALE_FINDING_MS = 60 * 60_000;
const RECORD_KEEP_MS = DAY_MS;
/** A report's look gives up after this (the analyst's time limit plus margin); the decision log says so (#60 item 5). */
const REPORT_TRIAGE_MS = 30 * 60_000;
/** An undelivered monitor-orphan notice is withdrawn after this (#102): it would describe a state long gone. */
const ORPHAN_NOTICE_WITHDRAW_MS = 30 * 60_000;
/** A kill-respawner owner notice that failed to build or deliver: at most this many attempts, this far apart. */
const RESPAWN_NOTICE_TRIES = 5;
const RESPAWN_NOTICE_RETRY_MS = 30_000;
/** Status level order; SEVERITY_RANK has no `ok` (G51). */
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, crit: 3 };

/** Log stats maps (Map or plain object) copied into a plain object for the parse window. */
function plainMap(value) {
	return value instanceof Map ? Object.fromEntries(value) : { ...value };
}

/** Size, mtime and the last 4 KB of a file a tool call writes to (world.fileProbe); undefined when it is not a file. */
export function probeFile(file) {
	const stat = statSafe(file);
	if (!stat?.isFile()) return undefined;
	let tail = "";
	try {
		const fd = fs.openSync(file, "r");
		const length = Math.min(4096, stat.size);
		const buf = Buffer.alloc(length);
		fs.readSync(fd, buf, 0, length, stat.size - length);
		fs.closeSync(fd);
		tail = buf.toString("utf8");
	} catch {
		tail = "";
	}
	return { size: stat.size, mtimeMs: stat.mtimeMs, tail };
}

/** Every detector, in evaluation order (D1 first: it attributes processes for D2/D9). */
export async function loadDetectors() {
	const names = ["stall", "runaway", "respawn", "tokens", "tps", "provider", "config", "orphans", "monitor-orphans", "reflection-orphans", "crashes", "parks", "leftovers", "loops", "reload", "self", "offtrack", "align", "goal-liveness", "boot-gap"];
	const detectors = [];
	for (const name of names) {
		try {
			detectors.push({ name, ...(await import(`./detect/${name}.mjs`)) });
		} catch (error) {
			if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
		}
	}
	return detectors;
}

/** Sensor heartbeats of the last 10 minutes by session id (the engine and `omo-health diagnose`). */
export function readSensors(paths, now) {
	const sensors = new Map();
	for (const name of listDirSafe(paths.health.sensorsDir)) {
		if (!name.endsWith(".json")) continue;
		const hb = readJsonSafe(path.join(paths.health.sensorsDir, name));
		if (!hb?.sessionId || !Number.isFinite(hb.ts)) continue;
		if (now - hb.ts > 10 * 60_000) continue;
		sensors.set(hb.sessionId, hb);
	}
	return sensors;
}

function readVersions(paths) {
	const root = installedOmoRoot(paths);
	const omoAi = readJsonSafe(path.join(root, "package.json"))?.version;
	const senpi = readJsonSafe(path.join(root, "node_modules", "@code-yeongyu", "senpi", "package.json"))?.version
		?? readJsonSafe(path.join(root, "..", "@code-yeongyu", "senpi", "package.json"))?.version;
	return { omoAi, senpi };
}

/**
 * The supervisor core (plan todo 11). One `tick()` = collect -> world ->
 * detectors -> finding lifecycle -> policy -> actions -> verify -> status,
 * reports and decision log. All effects go through `actors` so replay and
 * tests run the identical code path.
 */
/**
 * The footer (each status' level and text) shows only what stops subagent work: stalls, hangs, dead or failing
 * children, runaway processes and loops, and what only the operator can fix. D4 tokens, D11 reloads, D12 self-checks,
 * D14 outside writes, D15 scope checks and the rest stay in /health and `status --json`; footer.showAll shows all.
 */
const FOOTER_DETECTORS = new Set(["D1", "D2", "D5", "D8", "D10"]);
function onFooter(finding, showAll) {
	if (finding.detector === "D16" || finding.detector === "D17" || finding.detector === "D22") return false;
	// A machine-wide observation (e.g. D2 machine-commit) is not a subagent problem: /health and status only.
	if (finding.subject?.key === "machine" && finding.severity === "info" && !finding.humanNeeded) return showAll;
	return showAll || Boolean(finding.humanNeeded) || FOOTER_DETECTORS.has(finding.detector);
}

export function createEngine({ paths, config, clock, log, sources, actors = {}, detectors, mode, options = {} }) {
	const tracker = new ProcessTracker();
	const events = new EventWindow(6 * 3600_000);
	const memories = new Map();
	const records = new Map();
	const attributed = new Map();
	const repeatLog = [];
	const fileProbeCache = new Map();
	const parseWindow = [];
	let table = tracker.table;
	let lastSnapshotMs = -Infinity;
	let os;
	let ports;
	let portsAtMs = -Infinity;
	let secrets = {};
	let secretsAtMs = -Infinity;
	let versions = {};
	let previousVersions;
	let versionsAtMs = -Infinity;
	let lastStatusJson = new Map();
	let tickCount = 0;
	let lastTickMs;
	let disabledDetectors = new Set();
	let disabledActions = new Set();
		let acknowledgedEvents = {};
	let acknowledgedParseDrift = {};
	let quarantinedSessions = [];
	const startedMs = clock.now();
	const selfPid = options.selfPid ?? process.pid;
	/** The investigation list: every stall suspicion is recorded here before anything is done about it (plan todo 8). */
	const investigations = options.investigations ?? createInvestigations({ paths, clock });
	/** The tool-call history and the general anomaly signals; only a daemon with a history DB has them (never a scan or a replay). */
	const watch = actors.db && !options.scan ? createAnomalyWatch({ db: actors.db, config, clock, log, laneSessionIds: () => actors.analyst?.laneSessionIds?.() }) : undefined;
	/** The findings of the tick being run: the analyst refuses to start while the provider itself is down (D6). */
	let tickFindings = [];
	let lastPruneMs = -Infinity;
	/** Reports being triaged (#60 item 5), by report id; each lives until its answer went out. */
	const reportRecords = new Map();
	/**
	 * Report analyst jobs whose report is gone (expired, or saved by a daemon that restarted), by job id: polled to their
	 * end like a finding's, so the runner still kills them at the time limit. Their answer is only logged.
	 */
	const orphanJobs = new Map();
	const reportQueue = [];

	/** A fresh evidence snapshot of a finding's subject for the triage bundle; a failed capture never blocks judging. */
	function captureEvidence(world, finding, reason) {
		const subjectId = finding.subject?.taskId ?? finding.subject?.sessionId;
		if (!actors.evidence || !subjectId) return undefined;
		try {
			return actors.evidence.capture(world, subjectId, reason);
		} catch (error) {
			log?.warn?.("evidence_failed", { fp: finding.fp, error: error.message });
			return undefined;
		}
	}

	/** The part of a finding's subject an investigation keeps. */
	const pickSubject = (s = {}) => ({ sessionId: s.sessionId ?? null, taskId: s.taskId ?? null, toolCallId: s.toolCallId ?? null, parentSessionId: s.parentSessionId ?? null });
	const investigationOf = (fp) => (options.scan ? undefined : investigations.get(fp));

	/**
	 * Record one step of a suspicion in its investigation and the decision log (event `investigation`). The first call for
	 * an fp opens the investigation. A resolved investigation keeps its status: a late verdict never reopens it.
	 */
	function investigate(finding, record, patch = {}, { trigger = finding.detector === "report" ? "report" : finding.detector === ANOMALY_DETECTOR ? "anomaly" : "stall", row = {} } = {}) {
		if (options.scan) return undefined;
		const now = clock.now();
		let inv = investigations.get(finding.fp);
		if (!inv) {
			const classification = finding.data?.classification;
			inv = investigations.open({ id: finding.fp, trigger, subject: pickSubject(finding.subject), detector: finding.detector, cls: finding.cls, rule: classification?.rule ? { id: classification.rule.id, v: classification.rule.v, confidence: classification.confidence ?? null } : null, signature: triageSignature(finding), evidence: finding.evidence ?? [], lane: config.analyst?.lane });
			decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, event: "investigation", status: "open", trigger });
		}
		record.invOpenedMs ??= inv.openedMs;
		const next = { ...patch };
		if (RESOLVED.has(inv.status) && !(RESOLVED.has(next.status) && inv.status !== "closed")) delete next.status;
		if (Object.keys(next).length) {
			inv = investigations.attach(finding.fp, next) ?? inv;
			decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, event: "investigation", status: inv.status, trigger: inv.trigger, ...row });
		}
		record.invStatus = inv.status;
		return inv;
	}

	/** What an investigation keeps of a verdict: the words and the numbers, not the bundle. */
	function summarizeVerdict(verdict, now, record) {
		return { atMs: now, verdict: verdict.verdict, assessment: verdict.assessment ?? null, actionId: verdict.actionId ?? null, confidence: verdict.confidence ?? null, cause: verdict.cause ?? null, diagnosis: verdict.diagnosis ?? null, mechanism: verdict.mechanism ?? null, avoid: verdict.avoid ?? null, advice: verdict.advice ?? null, evidence: verdict.evidence ?? [], reason: verdict.reason ?? null, failed: Boolean(verdict.failed), notReached: Boolean(verdict.notReached), recheckAfterS: verdict.recheckAfterS ?? null, reused: Boolean(verdict.reused), why: Boolean(record?.analyst?.why), stuck: verdict.verdict === "act" || Boolean(verdict.repeatStall), repeatStall: Boolean(verdict.repeatStall) };
	}

	/**
	 * A why look's answer for the same triage signature, answered within a day by another investigation (C14): reused
	 * without a new analyst run. Only answered why verdicts qualify (investigations.findAnswered).
	 */
	function reusableWhy(finding, now) {
		if (options.scan) return undefined;
		const found = investigations.findAnswered({ signature: triageSignature(finding), sinceMs: now - DAY_MS });
		if (!found || found.id === finding.fp) return undefined;
		const v = found.verdict;
		return { id: found.id, verdict: { tier: 2, verdict: v.verdict, assessment: v.assessment ?? undefined, actionId: v.actionId ?? undefined, reason: v.reason ?? undefined, cause: v.cause ?? undefined, confidence: v.confidence ?? undefined, diagnosis: v.diagnosis ?? undefined, mechanism: v.mechanism ?? undefined, avoid: v.avoid ?? undefined, advice: v.advice ?? undefined, evidence: v.evidence ?? [], recheckAfterS: v.recheckAfterS ?? undefined, reused: true } };
	}

	/**
	 * Who hears a why-notice (analyst-why d): the parent of a child (a task subject or a child session), else the session
	 * itself; a D2 process without a session goes to the session whose sensor runs in its host process.
	 */
	function whyRecipient(finding, world) {
		const s = finding.subject ?? {};
		// A D1 finding names its own session's kind: a main session's call is explained to that session itself.
		if (finding.data?.sessionKind === "main" && s.sessionId) return { role: "self", sessionId: s.sessionId };
		if (s.taskId || (s.sessionId && world.sessions.get(s.sessionId)?.kind === "child")) return { role: "parent", sessionId: s.parentSessionId ?? deliveryTarget(finding, world) };
		if (s.sessionId) return { role: "self", sessionId: s.sessionId };
		if (s.hostPid !== undefined) for (const [id, hb] of world.sensors ?? []) if (hb?.pid === s.hostPid) return { role: "self", sessionId: id };
		return { role: "self", sessionId: undefined };
	}

	/**
	 * e2: does a finding that disappeared still owe its one explanation? Within GONE_WHY_MS of its disappearance, while a
	 * look runs, an answered non-normal verdict waits for its notice, or a look may still be asked (analyst.perFinding).
	 */
	function goneOwesWhy(record, now) {
		if (!needsWhy(record.finding, record) || now - (record.resolvedMs ?? now) > GONE_WHY_MS) return false;
		const job = record.analyst;
		if (job?.jobId && !job.verdict) return true;
		if (job?.verdict && !couldNotAnswer(job.verdict)) return settle({ record, config }).verdict?.assessment !== "normal";
		return Boolean(config.analyst?.enabled) && (record.looks ?? 0) < config.analyst.perFinding;
	}

	/** The footer says 조사중 while a look runs or a why look is still owed for this finding (C8, IS-7). */
	function investigatingOf(finding) {
		const record = finding ? records.get(finding.fp) : undefined;
		if (!record) return false;
		if (record.analyst?.jobId && !record.analyst.verdict) return true;
		return Boolean(config.analyst?.enabled && needsWhy(record.finding, record) && settle({ record, config }).kind !== "decided");
	}

	/**
	 * A second `stuck` verdict for the same task within analyst.repeatWindowMs is unrecoverable: the parent hears it once, with
	 * the analyst's own respawn text, instead of a release that already did not help. The earlier verdicts are the
	 * investigations of that task, so the rule survives a restart of the daemon.
	 */
	function repeatStall(finding, verdict, now) {
		const who = finding.subject?.taskId ?? finding.subject?.sessionId;
		if (!who || options.scan) return verdict;
		const window = config.analyst.repeatWindowMs;
		const prior = investigations.list({ sinceMs: now - window }).find((inv) => inv.id !== finding.fp && (inv.subject?.taskId ?? inv.subject?.sessionId) === who && inv.verdict?.stuck && now - (inv.verdict.atMs ?? 0) <= window);
		if (!prior) return verdict;
		return { ...verdict, verdict: "escalate", actionId: null, assessment: "abnormal", repeatStall: true, advice: verdict.advice ?? verdict.diagnosis };
	}

	/**
	 * The analyst's answer to a look (a job that ended, or a start that was refused), as the planner and the investigation
	 * keep it. An analyst that could not answer (off, held off, out of budget, failed, unusable output) kills nothing:
	 * the look is retried after analyst.retryMs and the investigation reads `failed`.
	 */
	function onAnalysis(record, finding, job, verdict, now) {
		const answered = !couldNotAnswer(verdict);
		// A main session's verdict is never turned into an advice for a parent: it has none (its notice is its own).
		const answer = answered && verdict.verdict === "act" && finding.data?.sessionKind !== "main" ? repeatStall(finding, verdict, now) : verdict;
		job.verdict = answer;
		record.nextLookMs = now + (answered ? (answer.recheckAfterS ?? 900) * 1000 : config.analyst.retryMs);
		record.history.push({ atMs: now, kind: "analyst", status: answered ? answer.verdict : `failed:${answer.reason}`, detail: `${answer.assessment ?? ""} ${answer.actionId ?? ""} conf=${answer.confidence ?? "?"}${answer.repeatStall ? " repeat" : ""}`.trim() });
		const acts = answered && (answer.verdict === "act" || (answer.verdict === "escalate" && answer.advice && !answer.reason));
		const jobId = job.jobId ?? answer.jobId ?? null;
		const analyst = { verdict: answer.verdict, assessment: answer.assessment ?? null, actionId: answer.actionId ?? null, confidence: answer.confidence ?? null, cause: answer.cause ?? null, reason: answer.reason ?? null, diagnosis: answer.diagnosis ?? null, advice: answer.advice ?? null, costUsd: answer.costUsd ?? null, repeatStall: Boolean(answer.repeatStall), elapsedMs: job.startedMs === undefined ? null : now - job.startedMs };
		const retryAtMs = acts ? null : record.nextLookMs;
		if (answered) investigate(finding, record, { status: "verdict", verdict: summarizeVerdict(answer, now, record), ...(jobId ? { jobId } : {}), retryAtMs }, { row: { jobId, step: job.step, analyst } });
		else investigate(finding, record, { status: "failed", verdict: summarizeVerdict(answer, now, record), ...(jobId ? { jobId } : {}), failures: "+1", retryAtMs }, { row: { jobId, step: job.step, result: answer.notReached ? "skipped:analyst-unavailable" : "analyst-failed", reason: answer.reason ?? null, detail: answer.detail ?? null, analyst } });
	}

	/** Read a running analyst job's answer (at most every ANALYST_POLL_MS) and keep it for the planner; it is recorded either way. */
	function pollAnalyst(record, finding, now) {
		const job = record.analyst;
		if (!job?.jobId || job.verdict || !actors.analyst || now < (job.nextPollMs ?? 0)) return;
		job.nextPollMs = now + ANALYST_POLL_MS;
		let verdict;
		try {
			verdict = actors.analyst.poll(job.jobId, { candidates: job.candidates, pool: job.pool, dayKey: job.dayKey, fp: job.fp, chargedMs: job.chargedMs, model: job.model, sessionId: job.sessionId });
		} catch (error) {
			verdict = { tier: 2, verdict: "escalate", reason: `poll-error:${error.message}`, failed: true };
			log?.warn?.("analyst_error", { error: verdict.reason, jobId: job.jobId });
		}
		if (!verdict) return;
		onAnalysis(record, finding, job, verdict, now);
	}

	/** An investigation still unresolved after analyst.holdToastMs reaches the operator, once (a toast; the list has the rest). */
	function toastHeldInvestigations(now) {
		const hold = config.analyst?.holdToastMs;
		if (!hold || options.scan) return;
		for (const record of records.values()) {
			if (!record.invOpenedMs || record.holdToasted || RESOLVED.has(record.invStatus ?? "open") || now - record.invOpenedMs < hold) continue;
			// A main session's stall without an anomaly signal is only noticed, never analysed: nothing is on hold.
			if (!record.analyst && record.finding?.data?.sessionKind === "main") continue;
			record.holdToasted = true;
			const finding = record.finding ?? {};
			const toast = actors.notifier?.toast({ title: "omo-health: 멈춤 의심 조사가 끝나지 않았습니다", body: `${truncate(finding.titleKo ?? record.fp, 80)} (${Math.round((now - record.invOpenedMs) / 60_000)}분째, 상태 ${record.invStatus ?? "open"}). 분석가 판정이 없어 아무것도 종료하지 않았습니다.`, tag: `analyst-hold-${record.fp}` });
			decision({ fp: record.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, event: "investigation", status: record.invStatus ?? "open", result: "hold-toast", toast: toast?.ok ? "shown" : toast?.skipped ?? "failed" });
		}
	}

/** The report's own finding (detector `report`): its subject, its text and the subject's most severe finding as related evidence. */
	function addReportRecord({ report, snapshot, subject, top }, now) {
		if (!report?.id || reportRecords.has(report.id) || !(subject?.sessionId || subject?.taskId)) return;
		const text = String(report.text ?? "");
		const finding = makeFinding({
			detector: "report",
			kind: "report",
			severity: "info",
			subject: { sessionId: subject.sessionId ?? undefined, taskId: subject.taskId ?? undefined, parentSessionId: subject.parentSessionId ?? undefined, rootSessionId: subject.rootSessionId ?? undefined, key: `report:${report.id}` },
			cls: top?.cls,
			evidence: [`via:${report.via}`, ...(top ? [`finding:${top.detector}/${top.kind}${top.cls ? `/${top.cls}` : ""}`] : [])],
			titleKo: `보고: ${truncate(text.replace(/\s+/g, " "), 60)}`,
			detailKo: text,
			data: { report: { id: report.id, via: report.via, text, subject: report.subject, reporterSessionId: report.reporterSessionId ?? null }, related: compactFinding(top), call: top?.data?.call, ageMs: top?.data?.ageMs, programs: top?.data?.programs, sessionKind: subject.kind, cwd: top?.data?.cwd ?? subject.cwd ?? null },
		});
		reportRecords.set(report.id, { ...newRecord(finding.fp, now), finding, history: [], state: "open", subjectKind: subject.kind, snapshotFile: snapshot ?? undefined });
	}

	const effectiveMode = () => mode ?? config.mode;

	function memoryFor(name) {
		if (!memories.has(name)) memories.set(name, {});
		return memories.get(name);
	}

	async function snapshotNow() {
		const snapshot = await sources.procs.snapshot();
		table = tracker.update(snapshot);
		lastSnapshotMs = clock.now();
		return table;
	}

	function fileProbe(file) {
		const now = clock.now();
		const cached = fileProbeCache.get(file);
		if (cached && now - cached.at < 10_000) return cached.value;
		const value = probeFile(file);
		fileProbeCache.set(file, { at: now, value });
		if (fileProbeCache.size > 500) fileProbeCache.delete(fileProbeCache.keys().next().value);
		return value;
	}

	const dagRunsCache = new Map();
	// D21 reads each goal session's senpi-task store where senpi keeps it; the reader caches records by mtime across ticks.
	const goalTaskReader = createTaskStoreReader();
	const workReader = createWorkReader({ taskReader: goalTaskReader });
	/** D18 input: every sensor heartbeat, senpi's crash traces, and the workflow runs of a session whose host just died. */
	function collectHostExits(now) {
		const exits = readHostExits(paths);
		for (const entry of exits.heartbeats) {
			const { hb } = entry;
			const age = now - hb.ts;
			if (!hb.cwd || age < 30_000 || age > config.crashResume.maxAgeMs || !table.size || table.isAlive(hb.pid)) continue;
			const key = `${hb.sessionId}|${hb.pid}|${hb.ts}`;
			if (!dagRunsCache.has(key)) dagRunsCache.set(key, readDagRuns(hb.cwd, { agentDir: paths.agentDir, sinceMs: hb.ts - 6 * 3600_000, maxFiles: 10 }));
			entry.dagRuns = dagRunsCache.get(key);
		}
		while (dagRunsCache.size > 50) dagRunsCache.delete(dagRunsCache.keys().next().value);
		return exits;
	}

	function collectParkRecords(now) {
		return readParkRecords(paths, { includeMalformed: true });
	}

	function needsPorts(registry, now) {
		const threshold = Math.min(config.stall.serverForegroundMs, config.stall.softMs) - 30_000;
		for (const session of registry.sessions.values()) {
			for (const call of session.pending?.values?.() ?? []) {
				if (/^(bash|shell)$/i.test(call.name) && now - call.ms >= threshold) return true;
			}
		}
		return false;
	}

	function deliveryTarget(finding, world) {
		const s = finding.subject ?? {};
		const session = s.sessionId ? world.sessions.get(s.sessionId) : undefined;
		if (session?.kind === "child") return session.parentSessionId ?? s.parentSessionId;
		return s.sessionId ?? s.parentSessionId;
	}

	/**
	 * Deliver through the sensor inbox; fall back to the root session, then a toast.
	 * selfOnly: the message speaks to that session about its own work (nudge, abort-continue), so it is never
	 * rerouted to another session or a toast; without a sensor it is simply not delivered.
	 */
	function deliver(world, sessionId, message, finding, record, { selfOnly = false } = {}) {
		const candidates = [sessionId];
		const target = sessionId ? world.sessions.get(sessionId) : undefined;
		if (!selfOnly && target?.rootSessionId && target.rootSessionId !== sessionId) candidates.push(target.rootSessionId);
		if (!selfOnly && finding.subject?.rootSessionId) candidates.push(finding.subject.rootSessionId);
		for (const candidate of candidates) {
			if (candidate && world.sensorFor(candidate)) {
				const file = actors.send ? actors.send({ ...message, sessionId: candidate }) : sendToSession(paths, { ...message, sessionId: candidate });
				return { delivered: true, via: "inbox", sessionId: candidate, file, messageId: message.id };
			}
		}
		if (selfOnly) return { delivered: false, via: "none", sessionId };
		const toast = actors.notifier?.toast({ title: `omo-health: ${truncate(finding.titleKo ?? finding.kind, 60)}`, body: message.content.split("\n").slice(0, 2).join(" "), tag: `deliver-${finding.fp}` });
		record.history.push({ atMs: clock.now(), kind: "fallback-toast", status: toast?.ok ? "shown" : "failed", detail: `no sensor for ${sessionId ?? "?"}` });
		return { delivered: false, via: "toast", toast };
	}

	function isRepeat(finding, now) {
		const key = finding.subject?.taskId ?? finding.subject?.sessionId;
		return repeatLog.some((entry) => entry.key === key && entry.cls === finding.cls && now - entry.atMs <= config.stall.repeatWindowMs && entry.fp !== finding.fp);
	}

	/**
	 * The sensor cannot see processes, so the re-check of a waiting monitor-orphan notice is ours (#102). It is
	 * withdrawn once every monitor it names runs again under a live host with a launcher other than the killed ones
	 * (presence in a manifest is not enough: the orphan's own stale manifest keeps listing it), or once it is old.
	 */
	function withdrawOrphanNotices(monitors, procs, procsFresh, now) {
		const byKey = new Map(monitors.map((monitor) => [`${monitor.sessionId}:${monitor.monitorId}`, monitor]));
		for (const dir of listDirSafe(paths.health.inboxDir)) {
			if (dir === "_undelivered") continue;
			for (const { file, message } of pendingMessages(paths, dir)) {
				if (message.kind !== "self-notice" || message.details?.actionKind !== "kill-orphan-watchers") continue;
				const killed = new Set(message.details.killed ?? []);
				const listed = Array.isArray(message.details.monitors) ? message.details.monitors : [];
				const restored = procsFresh && listed.length > 0 && listed.every((item) => {
					const current = byKey.get(`${item.sessionId ?? message.sessionId}:${item.monitorId}`);
					if (!current) return false;
					const { launcher, live } = watcherMembers(current, procs);
					return live && !killed.has(`${launcher.pid}:${launcher.ctime}`);
				});
				const reason = now - (message.createdMs ?? 0) > ORPHAN_NOTICE_WITHDRAW_MS ? "expired" : restored ? "restored" : undefined;
				if (!reason) continue;
				fs.rmSync(file, { force: true });
				decision({ detector: "D16", kind: "orphan-monitor", event: "notice-withdrawn", result: `withdrawn:${reason}`, subject: { sessionId: message.sessionId }, messageId: message.id, monitors: listed.map((item) => item.monitorId) });
			}
		}
	}

	function decision(entry) {
		const full = { mode: effectiveMode(), versions, ...entry, ts: new Date(clock.now()).toISOString() };
		if (actors.decide) actors.decide(full);
		else appendDecision(paths, full);
	}

	/**
	 * Tell the owner a respawner was killed (record.pendingNotice holds what the notice needs). A throw while building or
	 * delivering keeps the notice pending, logged each time, until it is sent or RESPAWN_NOTICE_TRIES attempts are used.
	 */
	function sendRespawnNotice(finding, record, world, now) {
		const pending = record.pendingNotice;
		const sessionId = finding.subject?.sessionId;
		pending.attempts += 1;
		try {
			record.reportPath = writeReport(paths, finding, record, now);
			const notice = composeRespawnNotice({ finding, sessionId, now, outcome: pending.outcome, hold: pending.hold, triage: pending.triage });
			const delivery = deliver(world, sessionId, notice, finding, record, { selfOnly: true });
			record.history.push({ atMs: now, kind: "notice", status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${delivery.sessionId ?? sessionId ?? "-"}` });
			record.pendingNotice = undefined;
			return { delivery };
		} catch (error) {
			const gaveUp = pending.attempts >= RESPAWN_NOTICE_TRIES;
			pending.nextMs = now + RESPAWN_NOTICE_RETRY_MS;
			if (gaveUp) record.pendingNotice = undefined;
			record.history.push({ atMs: now, kind: "notice", status: "failed", detail: `${error.message} (attempt ${pending.attempts}/${RESPAWN_NOTICE_TRIES}${gaveUp ? ", given up" : ""})` });
			log?.error?.("respawn_notice_failed", { fp: record.fp, attempt: pending.attempts, gaveUp, error: error.message });
			return { noticeError: error.message };
		}
	}

	/** Retry the kill-respawner owner notices whose delivery failed, spaced by RESPAWN_NOTICE_RETRY_MS. */
	function retryRespawnNotices(now, world, paused) {
		if (paused || effectiveMode() === "shadow") return;
		for (const record of records.values()) if (record.pendingNotice && now >= record.pendingNotice.nextMs) sendRespawnNotice(record.finding, record, world, now);
	}

	async function perform(req, finding, record, world) {
		const now = clock.now();
		const s = finding.subject ?? {};
		if (req.kind === "kill-orphan-watchers") {
			// Re-evaluate ownership against the current process snapshot before invoking the verified kill path.
			const fresh = await snapshotNow();
			const monitor = (world.monitors ?? []).find((m) => m.monitorId === finding.data.monitorId && m.sessionId === s.sessionId);
			const current = monitor && watcherMembers(monitor, fresh);
			const owned = (world.monitors ?? []).some((other) => {
				const live = watcherMembers(other, fresh);
				return live.live && live.members.some((proc) => current?.members.some((member) => member.pid === proc.pid));
			});
			if (!current?.members.length || current.live || owned || beyondReach(current.members, fresh)) {
				record.executed.delete(req.key);
				return { skipped: "no-longer-orphan" };
			}
			const allowed = new Set(req.remedy.targets.map((p) => `${p.pid}@${p.ctime}`));
			const targets = current.members.filter((p) => allowed.has(`${p.pid}@${p.ctime}`)).map((p) => req.remedy.targets.find((t) => t.pid === p.pid));
			const outcome = await (actors.kill ?? executeKill)({ request: { ...req, targets }, snapshot: actors.snapshot ?? snapshotNow, guard: world });
			record.history.push({ atMs: now, kind: req.kind, status: outcome.killed.length ? "execute" : "no-effect", detail: `killed ${outcome.killed.map((p) => p.pid).join(",")}; survived ${outcome.survived.map((p) => p.pid).join(",")}` });
			record.killedCount = (record.killedCount ?? 0) + outcome.killed.length;
			if (outcome.survived.length || (targets.length && !outcome.killed.length && outcome.noop.length)) record.executed.delete(req.key);
			else if (record.killedCount) {
				memoryFor("monitor-orphans").done ??= {};
				memoryFor("monitor-orphans").done[`${s.sessionId}:${finding.data.monitorId}`] = now;
			}
			return { outcome };
		}
		if (req.kind === "kill-reflection-orphans") {
			// Re-identify against a fresh snapshot and a fresh final.json read: the run must still be
			// terminal-settled and the candidate processes still children of it (never stale remedy data).
			const fresh = await snapshotNow();
			const runs = readReflectionRuns(paths, fresh);
			const current = reflectionOrphans({ procs: fresh, runs, omoHome: paths.omoHome, now, graceMs: config.reflectionOrphans?.graceMs ?? 0 }).find((entry) => entry.run.key === finding.data.runKey);
			if (!current) {
				record.executed.delete(req.key);
				return { skipped: "no-longer-orphan" };
			}
			const allowed = new Set(req.remedy.targets.map((p) => `${p.pid}@${p.ctime}`));
			const targets = current.procs.filter((p) => allowed.has(`${p.pid}@${p.ctime}`)).map((p) => req.remedy.targets.find((t) => t.pid === p.pid));
			const outcome = await (actors.kill ?? executeKill)({ request: { ...req, targets }, snapshot: actors.snapshot ?? snapshotNow, guard: world });
			record.history.push({ atMs: now, kind: req.kind, status: outcome.killed.length ? "execute" : "no-effect", detail: `killed ${outcome.killed.map((p) => p.pid).join(",")}; survived ${outcome.survived.map((p) => p.pid).join(",")}; noop ${outcome.noop.map((n) => `${n.pid}:${n.reason}`).join(",")}` });
			record.killedCount = (record.killedCount ?? 0) + outcome.killed.length;
			// Retry only on real failures; a permanently no-op'd target (protected, pid-reused) is done being quiet.
			if (outcome.survived.length || outcome.errors.length) record.executed.delete(req.key);
			return { outcome };
		}
		if (CRASH_ACTIONS.has(req.kind)) return performCrashAction(req, finding, record, world, { paths, config, memory: memoryFor("crashes"), now, snapshot: actors.snapshot ?? snapshotNow, deliver, actors });
		if (PROCESS_ACTIONS.has(req.kind)) {
			const outcome = await (actors.kill ?? executeKill)({ request: req, snapshot: actors.snapshot ?? snapshotNow, guard: world });
			record.step += 1;
			record.lastActionMs = now;
			record.lastActionKind = req.kind;
			const acted = outcome.killed.length > 0;
			if (acted) watch?.released(s.toolCallId, now);
			record.history.push({ atMs: now, kind: req.kind, status: acted ? "execute" : "no-effect", detail: `killed ${outcome.killed.map((p) => `${p.name}(${p.pid})`).join(", ") || "-"}; noop ${outcome.noop.map((n) => `${n.pid}:${n.reason}`).join(", ") || "-"}${outcome.survived.length ? `; survived ${outcome.survived.map((p) => p.pid).join(",")}` : ""}` });
			if (req.kind === "detach-server") {
				for (const server of req.serverPids ?? []) {
					const proc = world.procs.get(server.pid);
					if (proc) attributed.set(procKey(proc), { sessionId: s.sessionId, taskId: s.taskId, toolCallId: s.toolCallId, sinceMs: now, role: "detached-server" });
				}
			}
			// Every process action on a child is quiet (IS-6): recorded in its investigation, never sent to the parent.
			if (req.quiet || world.sessions.get(s.sessionId)?.kind === "child") {
				if (acted) repeatLog.push({ key: s.taskId ?? s.sessionId, cls: finding.cls, atMs: now, fp: finding.fp });
				const action = { kind: req.kind, quiet: true, rule: finding.data?.classification?.rule?.id ?? null, killed: outcome.killed.map((p) => `${p.name}(${p.pid})`), noop: outcome.noop.map((n) => `${n.pid}:${n.reason}`), survived: outcome.survived.map((p) => p.pid), ...(req.triage ? { diagnosis: req.triage.diagnosis ?? null, cause: req.triage.cause ?? null } : {}) };
				investigate(finding, record, { ...(acted ? { status: "released" } : {}), action }, { row: { result: acted ? "released" : "no-effect", acted: { key: req.key, kind: req.kind, quiet: true }, killed: action.killed } });
				return { outcome, quiet: true };
			}
			if (req.wrongCommand) {
				// A main session's call released on the analyst's proof of a wrong command: recorded, then the one explanation.
				const action = { kind: req.kind, quiet: false, rule: finding.data?.classification?.rule?.id ?? null, killed: outcome.killed.map((p) => `${p.name}(${p.pid})`), noop: outcome.noop.map((n) => `${n.pid}:${n.reason}`), survived: outcome.survived.map((p) => p.pid), diagnosis: req.triage?.diagnosis ?? null, cause: req.triage?.cause ?? null };
				investigate(finding, record, { ...(acted ? { status: "released" } : {}), action }, { row: { result: acted ? "released" : "no-effect", acted: { key: req.key, kind: req.kind }, killed: action.killed } });
				if (!acted) return { outcome };
				repeatLog.push({ key: s.taskId ?? s.sessionId, cls: finding.cls, atMs: now, fp: finding.fp });
				// Only whether the AGENT is idle decides if the message starts a turn; the human's last input is never read.
				const message = composeWrongCommandRelease({ finding, sessionId: s.sessionId, now, outcome, triage: req.triage, idle: world.sensorFor(s.sessionId)?.idle });
				const delivery = deliver(world, s.sessionId, message, finding, record);
				record.whyNoticed = true;
				record.history.push({ atMs: now, kind: "notice", status: delivery.delivered ? "delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? s.sessionId ?? "-"}` });
				return { outcome, delivery };
			}
			if (acted) {
				const repeat = isRepeat(finding, now);
				repeatLog.push({ key: s.taskId ?? s.sessionId, cls: finding.cls, atMs: now, fp: finding.fp });
				const session = world.sessions.get(s.sessionId);
				const selfSensor = session?.kind === "main" && world.sensorFor(session.id);
				const target = selfSensor ? session.id : deliveryTarget(finding, world);
				const parent = target ? world.sessions.get(target) : undefined;
				const parentHb = target ? world.sensorFor(target) : undefined;
				const reportPath = writeReport(paths, finding, record, now);
				const message = composeActionNotice({ finding, actionKind: req.kind, outcome: { ...outcome, serverPids: req.serverPids }, target: selfSensor ? "self" : "parent", sessionId: target, now, parentIdle: parentHb ? parentHb.idle : parent?.lastMessage?.role === "assistant", repeat, reportPath, triage: req.triage });
				const delivery = deliver(world, target, message, finding, record);
				record.history.push({ atMs: now, kind: "notice", status: delivery.delivered ? "delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				return { outcome, delivery, repeat };
			}
			return { outcome };
		}
		if (req.kind === "kill-respawner") {
			// Re-verify the respawner on a fresh snapshot: it may have stopped relaunching by itself.
			const fresh = await snapshotNow();
			if (!req.remedy.targets.every((t) => fresh.isAlive(t.pid, t.ctime))) {
				record.executed.delete(req.key);
				return { skipped: "already-stopped" };
			}
			const outcome = await (actors.kill ?? executeKill)({ request: { kind: req.kind, targets: req.remedy.targets }, snapshot: actors.snapshot ?? snapshotNow, guard: world });
			record.history.push({ atMs: now, kind: req.kind, status: outcome.killed.length ? "execute" : "no-effect", detail: `killed ${outcome.killed.map((p) => p.pid).join(",")}; survived ${outcome.survived.map((p) => p.pid).join(",")}` });
			if (!outcome.killed.length) {
				record.executed.delete(req.key);
				return { outcome };
			}
			// The kill is done and never repeated; a notice that fails is retried on later ticks (retryRespawnNotices).
			record.remedyDone = true;
			record.pendingNotice = { outcome, hold: req.hold, triage: req.triage, attempts: 0, nextMs: now };
			return { outcome, ...sendRespawnNotice(finding, record, world, now) };
		}
		switch (req.kind) {
			case "relay-cancel": {
				record.step += 1;
				record.lastActionMs = now;
				record.lastActionKind = req.kind;
				const target = deliveryTarget(finding, world);
				const reportPath = writeReport(paths, finding, record, now);
				const hb = target ? world.sensorFor(target) : undefined;
				const delivery = deliver(world, target, composeRelayCancel({ finding, sessionId: target, now, parentIdle: hb?.idle, reportPath, triage: req.triage }), finding, record);
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				// C12: the relay is the one message the parent gets about this fp.
				record.whyNoticed = true;
				if (investigationOf(finding.fp)) investigate(finding, record, { status: "advised", action: { kind: req.kind, delivered: delivery.delivered, advice: req.triage?.advice ?? null } }, { row: { result: "advised", acted: { key: req.key, kind: req.kind }, delivered: delivery.delivered } });
				return { delivery };
			}
			case "why-notice": {
				// The one explanation of a footer problem (analyst-why IS-3): cause, mechanism and what to do instead.
				const { role, sessionId: target } = whyRecipient(finding, world);
				const self = role === "self";
				const message = composeWhyNotice({ finding, sessionId: target, now, verdict: req.verdict, target: self ? "self" : "parent", parentIdle: target ? world.sensorFor(target)?.idle : undefined });
				const delivery = target ? deliver(world, target, message, finding, record, { selfOnly: self }) : { delivered: false, via: "none", sessionId: undefined };
				record.whyNoticed = true;
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : delivery.via === "toast" ? "fallback" : "not-delivered", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				investigate(finding, record, { status: "advised", action: { kind: req.kind, delivered: delivery.delivered } }, { row: { result: "advised", acted: { key: req.key, kind: req.kind }, delivered: delivery.delivered } });
				return { delivery };
			}
			case "respawn-notice": {
				// The analyst found D17's relaunch loop suspicious, or nothing vouched for a kill (#55 C): the owner is told.
				const target = deliveryTarget(finding, world);
				const hb = target ? world.sensorFor(target) : undefined;
				const message = composeRespawnTriageNotice({ finding, sessionId: target, now, verdict: req.verdict, target: target === s.sessionId ? "self" : "parent", parentIdle: hb?.idle });
				const delivery = deliver(world, target, message, finding, record);
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				return { delivery };
			}
			case "notify": {
				record.step += 1;
				record.lastActionKind = req.kind;
				record.history.push({ atMs: now, kind: "notify", status: "status-only" });
				// A main session's stall suspicion without an anomaly signal: recorded, and the analyst is not asked.
				if (finding.data?.sessionKind === "main" && ["R10x", "R11"].includes(finding.data?.classification?.rule?.id)) investigate(finding, record);
				return {};
			}
			case "main-notice": {
				// The analyst looked at a main session's call and did not prove a wrong command: one notice, nothing released.
				const message = composeMainStallNotice({ finding, sessionId: s.sessionId, now, verdict: req.verdict });
				const delivery = deliver(world, s.sessionId, message, finding, record, { selfOnly: true });
				record.whyNoticed = true;
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${delivery.sessionId ?? s.sessionId ?? "-"}` });
				investigate(finding, record, { status: "noticed", action: { kind: req.kind, delivered: delivery.delivered, cause: req.verdict?.cause ?? null } }, { row: { result: "noticed", acted: { key: req.key, kind: req.kind }, delivered: delivery.delivered } });
				return { delivery };
			}
			case "analyze": {
				// A stall suspicion that is due, or a report: open its investigation, then start the analyst; pollAnalyst reads the
				// answer on later ticks. Nothing here releases or kills anything.
				// A why look (analyst-why C7) opens its investigation with trigger `why`, or marks an existing one (a rule release's).
				const why = Boolean(req.why);
				const trigger = req.reportId ? "report" : finding.detector === ANOMALY_DETECTOR ? "anomaly" : why ? "why" : "stall";
				investigate(finding, record, why ? { why: true } : {}, { trigger });
				record.looks = (record.looks ?? 0) + 1;
				// C14: a why look whose signature another investigation answered within a day reuses that answer; no job runs.
				const reused = why ? reusableWhy(finding, now) : undefined;
				if (reused) {
					record.analyst = { step: req.step, candidates: req.candidates, why: true };
					record.history.push({ atMs: now, kind: "analyst", status: "reused", detail: `analyst reused ${reused.id}` });
					onAnalysis(record, finding, record.analyst, reused.verdict, now);
					return { analyst: { reused: reused.id, step: req.step } };
				}
				const snapshotFile = req.snapshotFile ?? captureEvidence(world, finding, { kind: "triage", fp: finding.fp, step: req.step });
				const snapshot = snapshotFile ? readJsonSafe(snapshotFile) : undefined;
				let started;
				if (!actors.analyst) started = { tier: 2, verdict: "escalate", reason: "analyst-off", notReached: true };
				else {
					try {
						started = actors.analyst.start(finding, req.candidates, { snapshot, pool: req.reportId ? "reports" : "stall", openFindings: tickFindings });
					} catch (error) {
						started = { tier: 2, verdict: "escalate", reason: `spawn-error:${error.message}`, failed: true, notReached: true };
						log?.warn?.("analyst_error", { error: started.reason });
					}
				}
				if (started.verdict === undefined && started.jobId) {
					record.analyst = { step: req.step, jobId: started.jobId, startedMs: now, candidates: req.candidates, pool: started.pool, dayKey: started.dayKey, fp: started.fp, chargedMs: started.chargedMs, model: started.model, sessionId: started.sessionId, nextPollMs: now, why };
					record.history.push({ atMs: now, kind: "analyst", status: "started", detail: `job ${started.jobId}${started.queued ? " (queued)" : ""}` });
					investigate(finding, record, { status: "analyzing", jobId: started.jobId, model: started.model, lane: config.analyst.lane }, { trigger, row: { jobId: started.jobId, step: req.step, model: started.model } });
					return { analyst: { jobId: started.jobId, step: req.step } };
				}
				record.analyst = { step: req.step, candidates: req.candidates, why };
				onAnalysis(record, finding, record.analyst, started, now);
				return { analyst: { reason: started.reason, failed: Boolean(started.failed), step: req.step } };
			}
			case "triage-notice": {
				// A report's answer (#60 item 5): to the parent of a child, to a main session itself (notice only).
				const self = record.subjectKind === "main";
				const target = self ? s.sessionId : (s.parentSessionId ?? deliveryTarget(finding, world));
				const hb = target ? world.sensorFor(target) : undefined;
				const snapshot = record.snapshotFile ? readJsonSafe(record.snapshotFile) : undefined;
				const message = composeTriageNotice({ finding, sessionId: target, now, verdict: req.verdict, target: self ? "self" : "parent", parentIdle: hb?.idle, ruleDiagnosis: snapshot?.diagnosis, snapshotFile: record.snapshotFile });
				const delivery = deliver(world, target, message, finding, record, { selfOnly: self });
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : delivery.via === "none" ? "not-delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				if (finding.detector === "report") investigate(finding, record, { status: "noticed", action: { kind: req.kind, delivered: delivery.delivered, reportId: req.reportId ?? null } }, { row: { result: "noticed", acted: { key: req.key, kind: req.kind }, delivered: delivery.delivered } });
				return { delivery };
			}
			case "wake-parent":
			case "nudge":
			case "abort-continue": {
				record.remedyDone = true;
				const target = req.kind === "wake-parent" ? deliveryTarget(finding, world) : s.sessionId;
				const reportPath = writeReport(paths, finding, record, now);
				const message = req.kind === "wake-parent" ? composeWake({ finding, sessionId: target, now, reportPath }) : req.kind === "nudge" ? composeNudge({ finding, sessionId: target, now }) : composeAbortContinue({ finding, sessionId: target, now });
				const delivery = deliver(world, target, message, finding, record, { selfOnly: req.kind !== "wake-parent" });
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : delivery.via === "none" ? "not-delivered" : "fallback", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				writeReport(paths, finding, record, now);
				return { delivery };
			}
			case "goal-wake": {
				// D21: a goal session that waits on nothing real, woken once (the detector spaces the next wake by minWakeGapMs).
				// The wake names the evidence and the analyst's answer when one was asked for.
				record.remedyDone = true;
				const message = composeGoalWake({ sessionId: s.sessionId, reason: req.remedy.reason, now, sources: finding.data?.sources ?? [], verdict: req.verdict });
				const delivery = deliver(world, s.sessionId, message, finding, record, { selfOnly: true });
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${delivery.sessionId ?? s.sessionId ?? "-"}` });
				if (delivery.delivered && req.verdict) record.whyNoticed = true;
				if (investigationOf(finding.fp)) investigate(finding, record, { status: "advised", action: { kind: req.kind, delivered: delivery.delivered } }, { row: { result: "advised", acted: { key: req.key, kind: req.kind }, delivered: delivery.delivered } });
				if (delivery.delivered) {
					const memory = memoryFor("goal-liveness");
					memory.lastWake ??= {};
					memory.wakes ??= {};
					memory.lastWake[s.sessionId] = now;
					memory.wakes[s.sessionId] = (memory.wakes[s.sessionId] ?? 0) + 1;
				}
				return { delivery };
			}
			case "scope-check": {
				const session = world.sessions.get(s.sessionId);
				const self = session?.kind !== "child";
				const target = self ? s.sessionId : deliveryTarget(finding, world);
				const hb = target ? world.sensorFor(target) : undefined;
				// Older sensors discard unknown message kinds. Do not send or toast.
				const version = hb?.sensorVersion;
				const parts = typeof version === "string" && version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/);
				const compatible = Boolean(parts && (Number(parts[1]) > 0 || Number(parts[2]) >= 2));
				const message = composeScopeCheck({ finding, sessionId: target, now, forward: !self, deliverAs: hb?.idle ? "nextTurn" : "steer", verdict: req.verdict });
				const delivery = compatible ? deliver(world, target, message, finding, record, { selfOnly: true }) : { delivered: false, via: "none", sessionId: target };
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${target ?? "-"}` });
				if (delivery.delivered) {
					// A delivered nudge is the alignment history D15 reads, and only then does it spend the gap slot.
					record.remedyDone = true;
					const memory = memoryFor("align");
					if (!Array.isArray(memory[target])) memory[target] = [];
					memory[target].push({ ms: now, key: finding.subject?.key });
				} else {
					// An undelivered nudge spends nothing; the policy retries after nextNudgeMs instead of every tick.
					record.remedyDone = false;
					record.executed.delete(req.key);
					record.nextNudgeMs = now + 5 * 60_000;
				}
				return { delivery };
			}
			case "boot-notice": {
				// D23: the one notice a main session gets about the work the downtime cut off.
				const target = s.sessionId;
				const hb = world.sensorFor(target);
				const message = composeBootGapNotice({ sessionId: target, now, gap: finding.data?.gap, tasks: finding.data?.tasks, runs: finding.data?.runs, goalActive: finding.data?.goalActive, idle: hb?.idle === true });
				const delivery = deliver(world, target, message, finding, record, { selfOnly: true });
				record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${delivery.sessionId ?? target ?? "-"}` });
				if (delivery.delivered) {
					record.remedyDone = true;
					const memory = memoryFor("boot-gap");
					memory.noticed ??= {};
					memory.noticed[`${target}@${finding.data?.gap?.downSinceMs}`] = now;
				} else {
					record.executed.delete(req.key);
				}
				return { delivery };
			}
			case "revert-settings": {
				record.remedyDone = true;
				const outcome = actors.revert({ paths, fromSha1: req.remedy.fromSha1, toSha1: req.remedy.toSha1, clock: () => now });
				record.history.push({ atMs: now, kind: "revert-settings", status: outcome.ok ? "execute" : `skipped:${outcome.skipped ?? outcome.error}`, detail: outcome.rejectedCopy ? `rejected copy ${outcome.rejectedCopy}` : "" });
				if (outcome.ok) {
					actors.notifier?.toast({ title: "omo-health: settings.json을 직전 정상본으로 되돌렸습니다", body: `변경 직후 공급자 설정 오류가 연달아 발생했습니다. 거부된 파일: ${outcome.rejectedCopy}`, tag: `revert-${finding.fp}` });
					const writer = finding.data?.writer?.sessionId;
					if (writer) deliver(world, writer, composeRevertNotice({ finding, sessionId: writer, now, outcome }), finding, record);
				}
				writeReport(paths, finding, record, now);
				return { outcome };
			}
			case "toast": {
				record.toasted = true;
				const toast = actors.notifier?.toast({ title: `omo-health: ${truncate(finding.titleKo ?? finding.kind, 60)}`, body: (finding.detailKo ?? "").split("\n")[0], tag: finding.data?.toastTag ?? `${finding.detector}-${finding.kind}` });
				record.history.push({ atMs: now, kind: "toast", status: toast?.ok ? "shown" : toast?.skipped ?? "failed" });
				return { toast };
			}
			default:
				return { error: `unknown action ${req.kind}` };
		}
	}

	function statusFor(world, findingsBySession, incidentsBySession) {
		const now = clock.now();
		const statuses = [];
		const showAll = Boolean(config.footer?.showAll);
		const sessionIds = new Set([...world.sensors.keys(), ...findingsBySession.keys()]);
		for (const sessionId of sessionIds) {
			const open = findingsBySession.get(sessionId) ?? [];
			// The footer reads level/text; the full list stays in `open` for /health.
			const shown = open.filter((f) => onFooter(f, showAll));
			const top = shown.slice().sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))[0];
			let level = top ? (top.severity === "info" ? "info" : top.severity) : "ok";
			let text = footerText(level, top, shown.length, investigatingOf(top));
			let waiting;
			const session = world.sessions.get(sessionId);
			const hb = world.sensorFor(sessionId);
			if (!shown.length && session?.kind === "main" && hb?.idle === true && !((hb.executingTools ?? 0) > 0) && !session.pending?.size) {
				const count = workWakeCount(hb.wakeSources);
				if (count > 0) {
					const run = (world.workOf(session)?.runs ?? []).filter((r) => !r.settled && r.parentSessionId === sessionId).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0];
					const dag = run ? { completed: run.counts?.completed ?? 0, total: run.counts?.total ?? 0 } : null;
					level = "ok";
					text = waitingText({ dag, count });
					waiting = { count, dag: dag ? { ...dag, runId: run.runId, name: run.name } : null };
				}
			}
			statuses.push({ sessionId, status: { sessionId, ts: now, level, text, ...(waiting ? { waiting } : {}), open: open.map((f) => ({ fp: f.fp, severity: f.severity, titleKo: f.titleKo })), incidents: incidentsBySession.get(sessionId) ?? [] } });
		}
		return statuses;
	}

	function writeStatusIfChanged(key, status, writer) {
		const { ts, ...comparable } = status;
		const json = JSON.stringify(comparable);
		if (lastStatusJson.get(key) === json && ts - (lastStatusJson.get(`${key}#ts`) ?? 0) < 60_000) return;
		lastStatusJson.set(key, json);
		lastStatusJson.set(`${key}#ts`, ts);
		writer(status);
	}

	async function tick() {
		const now = clock.now();
		tickCount += 1;
		const tickLagMs = lastTickMs === undefined ? 0 : Math.max(0, now - lastTickMs - config.tickMs);
		lastTickMs = now;
		const failures = [];
		const quarantined = [];
		const paused = readPause(paths, now);
		const sensors = actors.sensors ? actors.sensors(now) : readSensors(paths, now);

		if (now - lastSnapshotMs >= config.procSnapshotMs - 1000) {
			try {
				await snapshotNow();
				os = await sources.procs.os();
			} catch (error) {
				failures.push(`procs:${error.message}`);
				log?.warn?.("snapshot_failed", { error: error.message });
			}
		}
		const registry = sources.registry.refresh({ sensors });
		watch?.record(registry.completions);
		// A historical scan has no process data, so nothing may be judged dead from it.
		const procsFresh = options.liveness !== "history" && now - lastSnapshotMs <= 2 * config.procSnapshotMs;
		const monitors = !options.scan && config.monitorOrphans?.enabled
			? unionMonitors(memoryFor("monitor-orphans"), actors.monitors ? actors.monitors(now) : readMonitorManifests(paths, now), table, now, procsFresh)
			: [];
		const reflectionRuns = !options.scan && config.reflectionOrphans?.enabled && table.size ? (actors.reflectionRuns ? actors.reflectionRuns() : readReflectionRuns(paths, table)) : new Map();
		const hostExits = options.scan ? undefined : actors.hostExits ? actors.hostExits(now) : collectHostExits(now);
		sources.logs.setExcludedSessions?.(actors.analyst?.laneSessionIds?.());
		const parkRecords = options.scan ? undefined : actors.parkRecords ? actors.parkRecords(now) : collectParkRecords(now);
		sources.logs.read();
		const newEvents = sources.logs.drain(now);
		events.add(newEvents, now);
		for (const [source, stats] of sources.logs.stats) parseWindow.push({ atMs: now, source, lines: stats.lines, bad: stats.bad, unknown: stats.unknown, unknownNames: [...stats.unknownNames], unknownLoudNames: [...stats.unknownLoudNames], unknownCounts: plainMap(stats.unknownCounts), unknownFirstSeenMs: plainMap(stats.unknownFirstSeenMs) });
		while (parseWindow.length && now - parseWindow[0].atMs > 3600_000) parseWindow.shift();

		let configState = {};
		try {
			configState = sources.config ? sources.config.update({ events, sessions: registry.sessions }) : {};
		} catch (error) {
			failures.push(`config:${error.message}`);
		}
		if (sources.secrets && now - secretsAtMs >= 60_000) {
			secretsAtMs = now;
			try {
				secrets = sources.secrets();
			} catch (error) {
				failures.push(`secrets:${error.message}`);
			}
		}
		if (now - versionsAtMs >= 5 * 60_000) {
			versionsAtMs = now;
			const next = sources.versions ? sources.versions() : readVersions(paths);
			if (versions.omoAi && (next.omoAi !== versions.omoAi || next.senpi !== versions.senpi)) previousVersions = versions;
			versions = next;
		}
		if (sources.procs.ports && needsPorts(registry, now) && now - portsAtMs >= 20_000) {
			try {
				ports = await sources.procs.ports();
				portsAtMs = now;
			} catch (error) {
				failures.push(`ports:${error.message}`);
			}
		}
		for (const [key] of attributed) {
			const [pid, ctime] = [Number(key.split("@")[0]), key.slice(key.indexOf("@") + 1)];
			if (table.size && !table.isAlive(pid, ctime)) attributed.delete(key);
		}
		const lastParse = new Map();
		for (const entry of parseWindow) {
			const first = lastParse.get(entry.source)?.first ?? entry;
			lastParse.set(entry.source, { first, last: entry });
		}
		const self = {
			pid: selfPid,
			startedMs,
			tickLagMs,
			workerRestartsLastHour: sources.procs.restarts ?? 0,
			analyst: actors.analyst?.health?.(),
			rssBytes: options.selfStats?.()?.rssBytes ?? process.memoryUsage().rss,
			cpuFrac: options.selfStats?.()?.cpuFrac ?? 0,
			parse: [...lastParse.entries()].map(([source, { first, last }]) => ({
				source,
				lines: last.lines - (first === last ? 0 : first.lines),
				bad: last.bad - (first === last ? 0 : first.bad),
				unknown: last.unknown - (first === last ? 0 : first.unknown),
				unknownNames: last.unknownNames,
				unknownLoudNames: last.unknownLoudNames,
				unknownCounts: Object.fromEntries(Object.entries(last.unknownCounts).map(([name, count]) => [name, count - (first === last ? 0 : (first.unknownCounts[name] ?? 0))]).filter(([, count]) => count > 0)),
				unknownFirstSeenMs: last.unknownFirstSeenMs,
			})),
			sessionParse: [...registry.sessions.values()].map((s) => ({ id: s.id, lines: s.parsedLines, bad: s.badLines })),
			versions,
			previousVersions,
			failures,
			paused,
			mode: effectiveMode(),
		};
		const manifestCache = new Map();
		const goalStoreCache = new Map();
		const workCache = new Map();
		const world = buildWorld({
			now,
			config,
			paths,
			registry,
			monitors,
			reflectionRuns,
			hostExits,
			parkRecords,
			procs: table,
			procsFresh,
			os,
			ports: now - portsAtMs <= 60_000 ? ports : undefined,
			events,
			newEvents,
			sensors,
			configState,
			secrets,
			versions,
			self,
			attributed,
			intentFor: ({ session, call }) => sources.transcripts?.find({ toolCallId: call.id, cwd: session.kind === "child" ? (session.task?.spawnCwd ?? session.cwd) : session.cwd, sinceMs: call.ms }) ?? null,
			fileProbe: sources.fileProbe ?? fileProbe,
			terminalManifest: (session) => {
				if (!manifestCache.has(session.id)) manifestCache.set(session.id, readSessionTerminalManifest(paths, session.id, session.file));
				return manifestCache.get(session.id);
			},
			goalStore: (cwd) => {
				if (!goalStoreCache.has(cwd)) goalStoreCache.set(cwd, readGoalStore(cwd, paths.agentDir, goalTaskReader));
				return goalStoreCache.get(cwd);
			},
			workOf: (session) => {
				if (!session?.cwd) return undefined;
				if (!workCache.has(session.id)) workCache.set(session.id, workReader.read({ session, agentDir: paths.agentDir, now }));
				return workCache.get(session.id);
			},
			downtime: options.downtime,
			liveness: options.liveness,
		});

		// Without any process data (a replay fixture with no process table) a fresh sensor heartbeat is the only proof that
		// its host runs; in-process children share that host pid. A populated table always decides by pid + creation time.
		if (!world.procs.size) {
			for (const [sessionId, hb] of world.sensors) {
				if (world.sensorFor(sessionId) && Number.isFinite(hb.pid)) world.liveHostPids.add(hb.pid);
			}
		}

		watch?.capture(world);

		// A broken session is excluded only from its failing detector; all other sessions remain supervised.
		quarantinedSessions = quarantinedSessions.filter((q) => q.untilMs > now);
		const findings = [];
		for (const detector of detectors) {
			if (disabledDetectors.has(detector.name) && detector.name !== "stall") continue;
			const excluded = new Set(quarantinedSessions.filter((q) => q.detector === detector.name).map((q) => q.sessionId));
			const active = new Map([...world.sessions].filter(([id]) => !excluded.has(id)));
			const detectorWorld = excluded.size ? { ...world, sessions: active } : world;
			let found;
			try {
				found = detector.detect(detectorWorld, memoryFor(detector.name));
			} catch (error) {
				failures.push(`detector:${detector.name}:${error.message}`);
				log?.error?.("detector_failed", { detector: detector.name, error: error.message, stack: truncate(error.stack, 800) });
				found = [];
				for (const [id, session] of [...active].slice(0, 50)) {
					const subset = new Map([[id, session]]);
					if (session.parentSessionId && active.has(session.parentSessionId)) subset.set(session.parentSessionId, active.get(session.parentSessionId));
					for (const [childId, child] of active) if (child.parentSessionId === id) subset.set(childId, child);
					try { found.push(...detector.detect({ ...world, sessions: subset }, memoryFor(detector.name))); }
					catch (sessionError) {
						quarantinedSessions.push({ detector: detector.name, sessionId: id, untilMs: now + 6 * 3600_000 });
						quarantined.push({ detector: detector.name, sessionId: id, error: String(sessionError?.message ?? sessionError) });
					}
				}
			}
			for (const finding of found) {
				if (finding.data?.atMs !== undefined && now - finding.data.atMs > STALE_FINDING_MS && !options.scan) continue;
				if (finding.detector === "D12" && finding.kind === "unknown-events" && (finding.data?.names ?? []).every((n) => acknowledgedEvents[finding.data.source]?.includes(n))) continue;
				if (finding.detector === "D12" && ["parse-drift", "session-parse-drift"].includes(finding.kind) && acknowledgedParseDrift[finding.kind === "session-parse-drift" ? "session" : finding.data?.source]?.untilMs > now) {
					findings.push({ ...finding, severity: "info", data: { ...finding.data, degraded: false } });
					continue;
				}
				findings.push(finding);
			}
			if (detector.name === "stall") {
				for (const [key, value] of memoryFor("stall").attributed ?? []) if (!attributed.has(key)) attributed.set(key, { ...value, role: "tool" });
			}
		}

		// General anomaly signals (todo 10): a long pending call of a subagent with a signal gets an investigation like a stall suspicion.
		if (watch) {
			try {
				findings.push(...watch.raise({ world, findings }));
			} catch (error) {
				failures.push(`anomaly:${error.message}`);
				log?.warn?.("anomaly_failed", { error: error.message, stack: truncate(error.stack, 800) });
			}
		}

		// Baseline-deviation signals (#55 C): an owner far above this machine's usual rates gets an earlier tier-1 look; the
		// signal itself never acts.
		if (actors.baseline) {
			try {
				const deviations = actors.baseline.observe({ world, findings });
				for (const finding of findings) {
					const deviation = finding.detector === "D1" && finding.kind === "stall" ? deviations.get(ownerKeyOf(finding)) : undefined;
					if (!deviation) continue;
					finding.data = { ...finding.data, deviation };
					// One line per deviation fire, so their rate can be read from the decision log as well as status --json.
					if (deviation.sinceMs === now) decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, event: "baseline-deviation", subject: finding.subject, deviation: { metrics: deviation.metrics, machine: deviation.machine ?? [] } });
					finding.evidence = [...(finding.evidence ?? []), ...deviation.metrics.map((m) => `deviation:${m.metric}=${m.value}`)];
				}
			} catch (error) {
				failures.push(`baseline:${error.message}`);
				log?.warn?.("baseline_failed", { error: error.message, stack: truncate(error.stack, 800) });
			}
		}

		// Finding lifecycle + policy + actions.
		const stoppedMonitors = new Map();
		// Findings logged opened or reopened this tick: the daemon snapshots their evidence before it fades.
		const opened = [];
		const seen = new Set();
		const results = [];
		tickFindings = findings;
		/** Gate, perform and log one plan's requests; shared by findings and reports. */
		const runRequests = async (plan, finding, record, subjectKind) => {
			for (const req of plan.requests) {
				const verdict = gate(req, { mode: effectiveMode(), paused, config, executed: record.executed, subject: finding.subject, subjectKind, disabledActions });
				if (verdict === "skipped:done") continue;
				if (verdict === "skipped:paused" || (verdict === "skipped:switch-off" && req.kind === "analyze")) {
					// Not marked executed, so the same action runs once the pause ends or the switch is turned back on; logged once per key.
					record.pausedKeys ??= new Set();
					if (record.pausedKeys.has(req.key)) continue;
					record.pausedKeys.add(req.key);
				} else record.executed.add(req.key);
				const params = { targets: (req.targets ?? req.remedy?.targets ?? []).map((t) => `${t.name ?? "?"}:${t.pid}`), serverPids: (req.serverPids ?? []).map((t) => t.pid) };
				if (verdict !== "execute") {
					// A look that will not run asks nothing and releases nothing (the report is told without a verdict).
					if (req.kind === "analyze" && verdict === "would") {
						record.looks = (record.looks ?? 0) + 1;
						record.analyst = { step: req.step, verdict: { tier: 2, verdict: "escalate", reason: "would", notReached: true } };
						record.nextLookMs = Number.POSITIVE_INFINITY;
					} else if (req.kind === "analyze" && verdict !== "skipped:paused" && verdict !== "skipped:switch-off") record.analyst = { step: req.step, verdict: { tier: 2, verdict: "escalate", reason: verdict, notReached: true } };
					if (!PROCESS_ACTIONS.has(req.kind) && req.kind !== "analyze" && verdict === "would") record.remedyDone = true;
					if (PROCESS_ACTIONS.has(req.kind) && verdict === "would") {
						record.step += 1;
						record.lastActionMs = now;
						record.lastActionKind = req.kind;
					}
					record.history.push({ atMs: now, kind: req.kind, status: verdict });
					decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, rule: finding.data?.classification?.rule, action: { key: req.key, kind: req.kind, params }, result: verdict, evidence: finding.evidence });
					results.push({ fp: finding.fp, kind: req.kind, result: verdict });
					continue;
				}
				let result;
				try {
					result = await perform(req, finding, record, world);
				} catch (error) {
					result = { error: error.message };
					// Not done: the next tick plans the same step again (the kill guard re-verifies every target).
					record.executed.delete(req.key);
					log?.error?.("action_failed", { kind: req.kind, error: error.message });
				}
				// A stall omo-health acted on or reported makes D1 watch the task closer for a while (#52): a process action or a relay-cancel.
				if (!result?.error && finding.detector === "D1" && finding.kind === "stall" && finding.subject?.taskId && (PROCESS_ACTIONS.has(req.kind) || req.kind === "relay-cancel")) {
					memoryFor("stall").stalls ??= new Map();
					memoryFor("stall").stalls.set(finding.subject.taskId, { atMs: now, toolCallId: finding.subject.toolCallId });
				}
				if (req.kind === "kill-orphan-watchers" && result?.outcome?.killed?.length && !finding.data.ownerPresent && !memoryFor("monitor-orphans").notified?.[`${finding.subject.sessionId}:${finding.data.monitorId}`]) {
					memoryFor("monitor-orphans").notified ??= {};
					memoryFor("monitor-orphans").notified[`${finding.subject.sessionId}:${finding.data.monitorId}`] = now;
					const items = stoppedMonitors.get(finding.subject.sessionId) ?? [];
					items.push({ description: finding.data.description, monitorId: finding.data.monitorId, count: record.killedCount, persistent: Boolean(finding.data.persistent), killed: result.outcome.killed.map((proc) => `${proc.pid}:${proc.ctime}`), sessionFile: sessionFileFor(finding.data.sessionDir, finding.subject.sessionId) });
					stoppedMonitors.set(finding.subject.sessionId, items);
				}
				decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, rule: finding.data?.classification?.rule, action: { key: req.key, kind: req.kind, params }, result: "execute", outcome: summarize(result), evidence: finding.evidence, ...(req.reportId ? { reportId: req.reportId } : {}) });
				results.push({ fp: finding.fp, kind: req.kind, result: "execute", outcome: result });
			}
		};
		for (const finding of findings) {
			seen.add(finding.fp);
			let record = records.get(finding.fp);
			const isNew = !record;
			if (!record) {
				record = { ...newRecord(finding.fp, now), history: [], state: "open" };
				records.set(finding.fp, record);
			}
			const previousSeverity = record.finding?.severity;
			const previousResolvedMs = record.resolvedMs;
			record.finding = finding;
			record.lastSeenMs = now;
			if (finding.severity !== "info") {
				// `logged`: an opened/reopened line exists, so the matching `resolved` may be written (G33).
				if (!isNew && previousResolvedMs) {
					decision({ event: "reopened", fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, severity: finding.severity, subject: finding.subject, evidence: finding.evidence, afterMs: now - previousResolvedMs });
					record.logged = true;
					opened.push(finding);
				} else if (!record.logged) {
					decision({ fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, severity: finding.severity, event: "opened", subject: finding.subject, evidence: finding.evidence });
					record.logged = true;
					opened.push(finding);
				}
			}
			record.resolvedMs = undefined;
			if (finding.severity === "crit" && (isNew || previousSeverity !== "crit")) writeReport(paths, finding, record, now);
			// An analyst answer that arrived is read before planning, so it settles this tick.
			pollAnalyst(record, finding, now);
			const plan = planFinding({ finding, record, now, config });
			record.state = plan.state;
			const subjectKind = finding.subject?.sessionId ? world.sessions.get(finding.subject.sessionId)?.kind : undefined;
			// D15 drift-normal: the analyst found nothing to nudge. Spend the one gap slot without a message so the
			// finding ends, and close its investigation with no hold toast.
			if (plan.state === "drift-normal") {
				const target = deliveryTarget(finding, world);
				if (target) {
					const align = memoryFor("align");
					if (!Array.isArray(align[target])) align[target] = [];
					const history = align[target];
					if (!history.some((entry) => entry.key === finding.subject?.key)) history.push({ ms: now, key: finding.subject?.key });
				}
				if (investigationOf(finding.fp)) investigate(finding, record, { status: "closed" });
			}
			await runRequests(plan, finding, record, subjectKind);
			// An analyze that could not answer at once (analyst off, budget, provider limit) settles within this tick; plan
			// once more so the rule fallback lands on the same tick, as before the look-first policy. One re-plan per finding.
			if (plan.requests.some((r) => r.kind === "analyze") && record.analyst?.verdict && couldNotAnswer(record.analyst.verdict)) {
				const replanned = planFinding({ finding, record, now, config });
				record.state = replanned.state;
				await runRequests(replanned, finding, record, subjectKind);
			}
		}
		if (watch) for (const a of watch.annotate(investigations)) decision({ fp: a.fp, detector: ANOMALY_DETECTOR, kind: "anomaly", event: "investigation", status: a.status, trigger: "anomaly", signal: a.kind });
		// D20 park-resume: the record lifecycle runs every tick (claims and launches age out on timers, not on findings).
		if (parkRecords?.length) {
			try {
				await runParkLifecycle({
					paths,
					config,
					now,
					world,
					parkRecords,
					memory: memoryFor("crashes"),
					gate: (req, sessionId) => gate(req, { mode: effectiveMode(), paused, config, subject: { sessionId }, subjectKind: world.sessions.get(sessionId)?.kind, disabledActions }),
					launchers: actors.parkLaunchers ?? defaultLaunchers({ paths, herdrCli: actors.herdr }),
					terminals: actors.parkTerminals ?? defaultTerminals({ herdrCli: actors.herdr }),
					notifier: actors.notifier,
					decide: decision,
					log,
				});
			} catch (error) {
				failures.push(`parks:${error.message}`);
				log?.error?.("park_lifecycle_failed", { error: error.message, stack: truncate(error.stack, 800) });
			}
		}
		retryRespawnNotices(now, world, paused);
		// Reports (#60 item 5): each is triaged like a finding and answered once, to the session that owns its subject.
		while (reportQueue.length) addReportRecord(reportQueue.shift(), now);
		for (const [id, record] of reportRecords) {
			pollAnalyst(record, record.finding, now);
			const plan = planReport({ record, config });
			record.state = plan.state;
			await runRequests(plan, record.finding, record, record.subjectKind);
			const answered = record.executed.has(`triage-notice:${record.fp}:report`);
			if (answered || now - record.firstSeenMs > REPORT_TRIAGE_MS) {
				if (!answered) decision({ fp: record.fp, detector: "report", kind: "report", event: "report-expired", reportId: id, state: record.state });
				if (record.analyst?.jobId && !record.analyst.verdict) orphanJobs.set(record.analyst.jobId, record);
				else if (!answered) investigate(record.finding, record, { status: "closed" }, { row: { result: "report-expired" } });
				reportRecords.delete(id);
			}
		}
		for (const [jobId, orphan] of orphanJobs) {
			pollAnalyst(orphan, orphan.finding, now);
			if (orphan.analyst.verdict) orphanJobs.delete(jobId);
		}
		for (const [fp, record] of records) {
			if (seen.has(fp)) continue;
			// An analyst job outlives its finding: it is still polled, so the runner ends it at its time limit; the answer is only recorded.
			pollAnalyst(record, record.finding, now);
			// e2: a finding that disappeared still owes its supervising session the one explanation (a D1 release, a look that
			// was asked), within GONE_WHY_MS and the per-finding looks; its investigation stays open meanwhile.
			const owesWhy = !options.scan && goneOwesWhy(record, now);
			if (owesWhy) {
				const requests = [];
				planWhy({ finding: record.finding, record, now, config, requests, gone: true });
				const subjectId = record.finding.subject?.sessionId;
				if (requests.length) await runRequests({ requests }, record.finding, record, subjectId ? world.sessions.get(subjectId)?.kind : undefined);
			}
			const stillOwes = owesWhy && goneOwesWhy(record, now);
			if (!stillOwes && record.resolvedMs && record.invStatus && !RESOLVED.has(record.invStatus)) investigate(record.finding, record, { status: "closed", retryAtMs: null }, { row: { result: "finding-resolved" } });
			if (!record.resolvedMs) {
				record.resolvedMs = now;
				record.state = "resolved";
				if (!stillOwes && record.invStatus && !RESOLVED.has(record.invStatus)) investigate(record.finding, record, { status: "closed", retryAtMs: null }, { row: { result: "finding-resolved" } });
				record.resolution = record.history.length ? "원인 신호가 사라졌습니다(도구 결과 도착 또는 조건 해소)" : "조건이 해소되었습니다";
				if (record.logged) {
					decision({ fp, detector: record.finding.detector, kind: record.finding.kind, cls: record.finding.cls, event: "resolved", subject: record.finding.subject, afterMs: now - record.firstSeenMs });
				}
				if (record.history.length || record.reportPath) writeReport(paths, record.finding, record, now);
			}
			if (now - record.resolvedMs > RECORD_KEEP_MS) records.delete(fp);
		}

		toastHeldInvestigations(now);
		if (!options.scan && now - lastPruneMs >= DAY_MS) {
			lastPruneMs = now;
			try {
				investigations.prune(config.history?.retentionDays ?? 90);
			} catch (error) {
				failures.push(`investigations:${error.message}`);
			}
		}

		if (!actors.send && !options.scan) withdrawOrphanNotices(monitors, table, procsFresh, now);
		for (const [sessionId, items] of stoppedMonitors) {
			const message = composeMonitorOrphanNotice({ sessionId, items, now });
			if (actors.send) actors.send(message);
			else sendToSession(paths, message);
		}

		// Undelivered inbox messages fall back to a toast.
		if (!actors.send) {
			for (const message of sweepUndelivered(paths, now)) {
				actors.notifier?.toast({ title: "omo-health: 세션 메시지 전달 실패", body: truncate(message.content.split("\n")[0], 200), tag: `undelivered-${message.id}` });
			}
		}

		// Status files for the footer, /health and `omo-health status`.
		const findingsBySession = new Map();
		const incidentsBySession = new Map();
		const pushTo = (map, key, value) => {
			if (!key) return;
			if (!map.has(key)) map.set(key, []);
			map.get(key).push(value);
		};
		for (const finding of findings) {
			const target = deliveryTarget(finding, world);
			pushTo(findingsBySession, finding.subject?.sessionId, finding);
			if (target && target !== finding.subject?.sessionId) pushTo(findingsBySession, target, finding);
		}
		for (const record of records.values()) {
			if (now - record.firstSeenMs > DAY_MS) continue;
			if (record.finding.severity === "info" && !record.history.length) continue;
			const item = { fp: record.fp, titleKo: record.finding.titleKo, severity: record.finding.severity, firstSeenMs: record.firstSeenMs, resolvedMs: record.resolvedMs, reportPath: record.reportPath, actions: record.history.map((h) => `${h.kind}:${h.status}`) };
			pushTo(incidentsBySession, record.finding.subject?.sessionId, item);
			const target = deliveryTarget(record.finding, world);
			if (target && target !== record.finding.subject?.sessionId) pushTo(incidentsBySession, target, item);
		}
		const globalFindings = findings.filter((f) => f.humanNeeded || f.subject?.key === "machine" || !f.subject?.sessionId);
		const degraded = findings.some((f) => f.detector === "D12" && f.data?.degraded);
		const showAll = Boolean(config.footer?.showAll);
		// The degraded flag and unknown-event notices never hide (or stand in for) a real problem.
		const rankedGlobal = globalFindings.filter((f) => !(f.detector === "D12" && (f.data?.degraded || f.kind === "unknown-events")) && onFooter(f, showAll));
		const topGlobal = rankedGlobal.slice().sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))[0];
		const topRank = topGlobal ? LEVEL_RANK[topGlobal.severity] : LEVEL_RANK.ok;
		const showDegraded = showAll && degraded;
		const globalLevel = showDegraded && topRank < LEVEL_RANK.warn ? "warn" : (topGlobal?.severity ?? "ok");
		const globalText =
			topRank >= LEVEL_RANK.warn ? footerText(topGlobal.severity, topGlobal, 0, investigatingOf(topGlobal)) : showDegraded ? footerText("warn", { detector: "D12" }) : footerText(globalLevel, topGlobal, rankedGlobal.length);
		const globalStatus = {
			ts: now,
			daemon: { pid: selfPid, startedMs, mode: effectiveMode(), paused, tickLagMs, versions },
			level: globalLevel,
			degraded,
			text: globalText,
			unknownEvents: findings.filter((f) => f.detector === "D12" && f.kind === "unknown-events").map((f) => ({ source: f.data?.source, names: f.data?.names, counts: f.data?.counts, ...(f.data?.quiet ? { quiet: true } : {}) })),
			humanNeeded: findings.filter((f) => f.humanNeeded).map((f) => ({ fp: f.fp, titleKo: f.titleKo, severity: f.severity })),
			open: findings.filter((f) => f.severity !== "info").map((f) => ({ fp: f.fp, detector: f.detector, kind: f.kind, cls: f.cls, severity: f.severity, titleKo: f.titleKo, sessionId: f.subject?.sessionId, taskId: f.subject?.taskId })),
			// #55 C: how often deviations fire and deviation looks are paid for, and whether each metric is past its cold start.
			...(actors.baseline ? { baseline: actors.baseline.summary(now) } : {}),
			incidents: [...records.values()].filter((r) => now - r.firstSeenMs <= DAY_MS && (r.history.length || r.finding.severity !== "info")).map((r) => ({ fp: r.fp, titleKo: r.finding.titleKo, severity: r.finding.severity, firstSeenMs: r.firstSeenMs, resolvedMs: r.resolvedMs, state: r.state, reportPath: r.reportPath, actions: r.history.map((h) => `${h.kind}:${h.status}`) })),
			// runningTasks: active subagents of a live host.
			counts: { sessions: registry.sessions.size, tasks: registry.tasks.length, runningTasks: registry.tasks.filter((t) => t.active && world.liveHostPids.has(t.hostPid)).length, liveHosts: world.liveHostPids.size, sensors: sensors.size, findings: findings.length },
			failures,
		};
		if (!options.noStatus) {
			writeStatusIfChanged("_global", globalStatus, (st) => writeGlobalStatus(paths, st));
			for (const { sessionId, status } of statusFor(world, findingsBySession, incidentsBySession)) writeStatusIfChanged(sessionId, status, (st) => writeSessionStatus(paths, sessionId, st));
		}
		return { now, findings, results, world, globalStatus, failures, quarantined, opened };
	}

	return {
		tick,
		records,
		attributed,
		get table() {
			return table;
		},
		setDisabledDetectors(names) { disabledDetectors = new Set(names ?? []); },
		setMitigations(value = {}) {
			disabledDetectors = new Set(value.disabledDetectors ?? []);
			disabledActions = new Set(value.disabledActions ?? []);
						acknowledgedEvents = value.acknowledgedEvents ?? {};
			acknowledgedParseDrift = value.acknowledgedParseDrift ?? {};
			const existing = new Set(quarantinedSessions.map((q) => `${q.detector}:${q.sessionId}`));
			for (const q of value.quarantinedSessions ?? []) if (!existing.has(`${q.detector}:${q.sessionId}`)) quarantinedSessions.push(q);
			sources.logs.setExtraKnown?.(acknowledgedEvents);
		},
		get quarantinedSessions() { return quarantinedSessions; },
		/** Queue a recorded report for triage (#60 item 5): `{ report, snapshot, subject, top }` from src/reports/intake.mjs. */
		triageReport(entry) {
			if (entry?.report?.id) reportQueue.push(entry);
		},
		reportRecords,
		/** Records and D15 memory for `~/.omo-health/state.json`, so a daemon restart re-sends no wake/notice (todo 32). */
		snapshotState() {
			const list = [...records.values()].map((r) => ({
				fp: r.fp,
				firstSeenMs: r.firstSeenMs,
				lastSeenMs: r.lastSeenMs,
				resolvedMs: r.resolvedMs,
				state: r.state,
				executed: [...r.executed],
				remedyDone: r.remedyDone,
				step: r.step,
				lastActionMs: r.lastActionMs,
				lastActionKind: r.lastActionKind,
				looks: r.looks ?? 0,
				nextLookMs: Number.isFinite(r.nextLookMs) ? r.nextLookMs : 0,
				nextNudgeMs: Number.isFinite(r.nextNudgeMs) ? r.nextNudgeMs : 0,
				// C12: the one message per fp survives a restart.
				whyNoticed: Boolean(r.whyNoticed),
				// A running analyst job is polled again after a restart (its answer is recorded; the finding is looked at afresh).
				...(runningJob(r) ? { analyst: runningJob(r) } : {}),
				...(r.invOpenedMs ? { invOpenedMs: r.invOpenedMs, invStatus: r.invStatus, holdToasted: Boolean(r.holdToasted) } : {}),
				loggedOpen: Boolean(r.logged),
				history: r.history.slice(-10),
				finding: r.finding && { fp: r.finding.fp, detector: r.finding.detector, kind: r.finding.kind, cls: r.finding.cls, severity: r.finding.severity, subject: r.finding.subject, titleKo: r.finding.titleKo },
			}));
			// Report analyst jobs too, so none outlives its time limit unpolled; the reports themselves are not kept.
			const jobs = [...reportRecords.values(), ...orphanJobs.values()].filter(runningJob).map((r) => ({ finding: { fp: r.finding.fp, detector: r.finding.detector, kind: r.finding.kind, cls: r.finding.cls ?? null }, analyst: runningJob(r) }));
			// D21: the wake count is part of the finding key, so it survives a restart for longer than the records it keys (twice their keep).
			const goal = memories.get("goal-liveness") ?? {};
			const keep = Object.entries(goal.lastWake ?? {}).filter(([, ms]) => Number.isFinite(ms) && clock.now() - ms <= 2 * RECORD_KEEP_MS).map(([id]) => id);
			const goalLiveness = { lastWake: Object.fromEntries(keep.map((id) => [id, goal.lastWake[id]])), wakes: Object.fromEntries(keep.map((id) => [id, goal.wakes?.[id] ?? 0])) };
			return { v: 1, savedMs: clock.now(), records: list, jobs, memories: { align: memories.get("align") ?? {}, monitorOrphans: memories.get("monitor-orphans") ?? {}, crashes: memories.get("crashes") ?? {}, bootGap: memories.get("boot-gap") ?? {}, tokens: { burn: memories.get("tokens")?.burn ?? {} }, stall: { stalls: Object.fromEntries(memories.get("stall")?.stalls ?? []) }, goalLiveness } };
		},
		restoreState(snapshot, now = clock.now()) {
			if (snapshot?.v !== 1) return 0;
			let restored = 0;
			for (const r of snapshot.records ?? []) {
				if (!r?.fp || !r.finding || records.has(r.fp)) continue;
				const refMs = r.resolvedMs ?? r.lastSeenMs;
				if (!Number.isFinite(refMs) || now - refMs > RECORD_KEEP_MS) continue;
				const record = { ...newRecord(r.fp, r.firstSeenMs ?? refMs), history: [], state: "open" };
				Object.assign(record, {
					lastSeenMs: r.lastSeenMs,
					resolvedMs: r.resolvedMs ?? undefined,
					state: r.state ?? record.state,
					executed: new Set(r.executed ?? []),
					remedyDone: Boolean(r.remedyDone),
					step: r.step ?? 0,
					lastActionMs: r.lastActionMs ?? undefined,
					lastActionKind: r.lastActionKind ?? undefined,
					looks: r.looks ?? 0,
					nextLookMs: r.nextLookMs ?? 0,
					nextNudgeMs: r.nextNudgeMs ?? 0,
					whyNoticed: Boolean(r.whyNoticed),
					analyst: r.analyst?.jobId ? restoredJob(r.analyst) : undefined,
					...(r.invOpenedMs ? { invOpenedMs: r.invOpenedMs, invStatus: r.invStatus, holdToasted: Boolean(r.holdToasted) } : {}),
					logged: Boolean(r.loggedOpen),
					history: Array.isArray(r.history) ? r.history.slice(-10) : [],
					finding: r.finding,
				});
				records.set(r.fp, record);
				restored += 1;
			}
			// Report analyst jobs of the previous daemon: polled to their end.
			for (const job of snapshot.jobs ?? []) {
				if (!job?.analyst?.jobId || orphanJobs.has(job.analyst.jobId)) continue;
				orphanJobs.set(job.analyst.jobId, { fp: job.finding?.fp, finding: job.finding ?? {}, analyst: restoredJob(job.analyst), looks: 0, nextLookMs: 0, history: [] });
			}
			const monitorOrphans = snapshot.memories?.monitorOrphans;
			if (monitorOrphans && typeof monitorOrphans === "object") {
				const memory = memoryFor("monitor-orphans");
				memory.done = Object.fromEntries(Object.entries(monitorOrphans.done ?? {}).filter(([, at]) => Number.isFinite(at) && now - at < 30 * DAY_MS));
				memory.notified = Object.fromEntries(Object.entries(monitorOrphans.notified ?? {}).filter(([, at]) => Number.isFinite(at) && now - at < 30 * DAY_MS));
				memory.remembered = restoreRemembered(monitorOrphans.remembered, now);
			}
			const align = snapshot.memories?.align;
			if (align && typeof align === "object") Object.assign(memoryFor("align"), align);
			// D23: firstLive and noticed survive a restart, so a boot notice is never sent twice.
			const bootGap = snapshot.memories?.bootGap;
			if (bootGap && typeof bootGap === "object") Object.assign(memoryFor("boot-gap"), bootGap);
			// D4: an open burn spike's hold survives a restart, so a dip right after it is still the same episode (IS-12).
			const burn = snapshot.memories?.tokens?.burn;
			if (burn && typeof burn === "object") {
				memoryFor("tokens").burn = Object.fromEntries(Object.entries(burn).filter(([, held]) => Number.isFinite(held?.lastHitMs) && now - held.lastHitMs < DAY_MS && typeof held.finding?.fp === "string"));
			}
			// D18: crash history, resume counts and pending/stopped recoveries survive a daemon restart (rate limit, crash loop).
			const crashes = snapshot.memories?.crashes;
			if (crashes && typeof crashes === "object") Object.assign(memoryFor("crashes"), crashes);
			const goalLiveness = snapshot.memories?.goalLiveness;
			if (goalLiveness && typeof goalLiveness === "object") {
				const memory = memoryFor("goal-liveness");
				for (const field of ["lastWake", "wakes"]) {
					const saved = goalLiveness[field];
					if (!saved || typeof saved !== "object") continue;
					memory[field] ??= {};
					for (const [id, value] of Object.entries(saved)) if (Number.isFinite(value) && !(id in memory[field])) memory[field][id] = value;
				}
			}
			// #82: the restall record survives a restart, and `omo-health diagnose` reads the same record from state.json.
			const stalls = restoreStalls(snapshot.memories?.stall?.stalls);
			if (stalls.size) memoryFor("stall").stalls = new Map([...stalls, ...(memoryFor("stall").stalls ?? [])]);
			return restored;
		},
		close() {
			actors.baseline?.flush?.();
			sources.procs.close?.();
			closeDb(actors.db);
		},
	};
}

/** The saved restall record ({taskId: {atMs, toolCallId}}) as the D1 memory map; malformed entries are dropped. */
export function restoreStalls(saved) {
	const stalls = new Map();
	if (!saved || typeof saved !== "object") return stalls;
	for (const [taskId, stall] of Object.entries(saved)) if (Number.isFinite(stall?.atMs)) stalls.set(taskId, { atMs: stall.atMs, toolCallId: stall.toolCallId });
	return stalls;
}

/** A record's analyst job while it runs, as state.json keeps it: enough to poll it, validate its answer and refund it. */
function runningJob(record) {
	const job = record.analyst;
	if (!job?.jobId || job.verdict) return undefined;
	return { step: job.step, jobId: job.jobId, startedMs: job.startedMs, candidates: job.candidates, pool: job.pool ?? "stall", dayKey: job.dayKey ?? null, fp: job.fp ?? null, chargedMs: job.chargedMs ?? null, model: job.model ?? null, sessionId: job.sessionId ?? null, why: Boolean(job.why) };
}

function restoredJob(saved) {
	return { step: saved.step, jobId: saved.jobId, startedMs: saved.startedMs, candidates: Array.isArray(saved.candidates) ? saved.candidates : [], pool: saved.pool ?? "stall", dayKey: saved.dayKey ?? undefined, fp: saved.fp ?? undefined, chargedMs: saved.chargedMs ?? undefined, model: saved.model ?? undefined, sessionId: saved.sessionId ?? undefined, why: Boolean(saved.why), nextPollMs: 0 };
}

function summarize(result) {
	if (!result) return undefined;
	if (result.outcome && Array.isArray(result.outcome.killed)) {
		return { killed: result.outcome.killed.map((p) => `${p.name}:${p.pid}`), survived: result.outcome.survived.map((p) => p.pid), noop: result.outcome.noop, delivered: result.delivery?.delivered, via: result.delivery?.via, repeat: result.repeat, ...(result.quiet ? { quiet: true } : {}) };
	}
	if (result.outcome) return { ok: result.outcome.ok, skipped: result.outcome.skipped, reason: result.outcome.reason, rejectedCopy: result.outcome.rejectedCopy };
	if (result.removed !== undefined) return { removed: result.removed };
	if (result.delivery) return { delivered: result.delivery.delivered, via: result.delivery.via, sessionId: result.delivery.sessionId };
	if (result.toast) return { toast: result.toast.ok ? "shown" : result.toast.skipped ?? "failed" };
	if (result.analyst) return result.analyst;
	if (result.error) return { error: result.error };
	return undefined;
}
