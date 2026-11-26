import fs from "node:fs";
import path from "node:path";
import { idFromFileName } from "./collect/sessions.mjs";
import { createSessionFileLocator, isSavedTranscriptVersion, mainHeaderConflicts, ownsLiveMain, probeSessionHeader } from "./collect/session-files.mjs";
import { senpiTaskStoreDir } from "./collect/tasks.mjs";
import { isExactInode, readUsageFileStamp, sessionHeader } from "./collect/usage.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import { maskedSubjectKey, streamDecisions, subjectIdJoinKey } from "./decisions.mjs";
import { streamInvestigations } from "./investigations.mjs";
import { safeSubjectId } from "./session-id.mjs";
import { isInside, pathKey } from "./paths.mjs";
import { ENDED_LOCATION, endedKey, endedSelector, streamEnded } from "./session-ledger.mjs";
import { ledgerParentSubject, rememberParentOwner, sessionSubjects, subjectKey, subjectOf, uniqueMatch } from "./session-subject.mjs";
import { compactUsage, fresh, parentSubject, readUsageIndex, usageEntryFor } from "./usage-index.mjs";
import { reasonCode } from "./audit-codes.mjs";
import { AUDIT_CHECK_MAX, AUDIT_DETECTOR_ID, AUDIT_LIST_CAPS, BUNDLE_MAX_CHARS, auditEvidence, auditHistoryRow, auditMessageKind } from "./judge/audit.mjs";
import { readFallbackTargets } from "./runner.mjs";
import { readJsonSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * The per-session record (plan todo 7, GAP-6): everything omo-health itself
 * recorded about one ended session and its descendants. The loader reads the
 * 30-day ledger, the token index, recent decisions plus retained machine
 * incident and coverage history, every investigation
 * file and the `omo-health` transcript entries of the session and its
 * descendants; `buildSessionRecord` is pure and does the joining.
 *
 * Selection is by ids and fps only, never by time, so a child that keeps
 * running after its parent ends keeps its actions and verdicts. The machine
 * overlap check uses the union of the session tree's active intervals.
 */

const DAY_MS = 86_400_000;
const DEPTH_MAX = 8;
const LINE_MAX = 300;
const DETAIL_TEXT_MAX = 20_000;
const TITLE_MAX = 200;
const TEXT_MAX = 2000;
// Entries with more than one role list their discriminator before the default.
// A gate row is retained as the outcome of an action decision, not as an execution.
export const DECISION_EVENT_SHAPES = Object.freeze({
	// Older retained action rows carry no event; every reader still takes a row with an `action` object as an action (#34).
	action: "action",
	opened: "finding",
	reopened: "finding",
	severity: "finding",
	resolved: "finding",
	investigation: Object.freeze({ "result:hold-toast": "action", acted: "action", default: "investigation" }),
	"notice-withdrawn": "action",
	"park-transition": Object.freeze({ "to:launched": "action", "why:launch-failed": "action", default: "bookkeeping" }),
	"park-gated": "action",
	"baseline-deviation": "bookkeeping",
	"report-expired": "bookkeeping",
	config: "bookkeeping", // thresholdsHash is provenance, not a finding or action.
	coverage: "bookkeeping",
});
const FINDING_EVENTS = new Set(Object.keys(DECISION_EVENT_SHAPES).filter((event) => DECISION_EVENT_SHAPES[event] === "finding"));

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** `redact` plus the GitHub token shape it does not mask yet. */
const scrub = (value) => redact(String(value ?? "")).replace(/ghp_[A-Za-z0-9]{8,}/g, "ghp_[REDACTED]");
export const isRedactedLedgerId = (id) => typeof id === "string" && scrub(id) !== id;
const clean = (value, max = LINE_MAX) => (typeof value === "string" && value ? truncate(scrub(value), max) : null);
export const displayLedgerId = (id) => typeof id === "string" ? truncate(scrub(id), TEXT_MAX) : id;
const msOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : Number.NaN);
const timeOf = (entry) => msOf(entry?.ts);

export function configDecisionFact(entry) {
	const ms = timeOf(entry);
	if (entry?.event !== "config" || !Number.isFinite(ms)) return null;
	const hash = entry.thresholdsHash;
	return { ms, thresholdsHash: typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : null };
}

/** Every string of a stored record through `redact`, every value bounded (a raw investigation keeps its shape). */
function cleanValue(value, depth = 0) {
	if (typeof value === "string") return truncate(scrub(value), TEXT_MAX);
	if (Array.isArray(value)) return depth >= 6 ? [] : value.slice(0, 500).map((item) => cleanValue(item, depth + 1));
	if (!isRecord(value)) return value;
	if (depth >= 6) return {};
	const out = {};
	for (const [key, item] of Object.entries(value)) out[scrub(key)] = cleanValue(item, depth + 1);
	return out;
}

const cleanDetail = (value) => clean(value, DETAIL_TEXT_MAX);

function cleanLines(lines) {
	if (!Array.isArray(lines)) return [];
	return lines.map(cleanDetail).filter(Boolean);
}

// Unlike the history samples, owner-local action details retain the complete outcome.
function actionDetail(outcome, rule, investigation = false) {
	const ids = (list) => Array.isArray(list) && list.length
		? list.map((item) => isRecord(item) ? (item.pid ?? (investigation ? "?" : item)) : item).join(investigation ? ", " : ",")
		: null;
	const killed = ids(outcome.killed);
	const noop = investigation && ids(outcome.noop);
	const survived = ids(outcome.survived);
	const parts = [
		killed && `killed ${killed}`,
		noop && `noop ${noop}`,
		survived && `survived ${survived}`,
		outcome.delivered !== undefined && (!investigation || outcome.delivered !== null) && `delivered ${outcome.delivered}`,
		!investigation && outcome.via && `via ${outcome.via}`,
		!investigation && outcome.error && `error ${outcome.error}`,
		rule && `rule ${isRecord(rule) ? rule.id : rule}`,
	];
	return cleanDetail(parts.filter(Boolean).join("; "));
}

function verdictText(verdict) {
	return {
		reason: cleanDetail(verdict.reason),
		diagnosis: cleanDetail(verdict.diagnosis),
		mechanism: cleanDetail(verdict.mechanism),
		avoid: cleanDetail(verdict.avoid),
		advice: cleanDetail(verdict.advice),
		evidence: cleanLines(verdict.evidence),
	};
}

function byNewest(a, b) {
	const am = msOf(a?.ts);
	const bm = msOf(b?.ts);
	return (Number.isFinite(bm) ? bm : 0) - (Number.isFinite(am) ? am : 0);
}

// Limit payloads, not join keys or counts. Equal timestamps keep scan order;
// the decision join puts about rows before recipient-only rows on a tie.
function newest(limit, compare) {
	const rows = [];
	let count = 0;
	return {
		add(row) {
			count++;
			if (rows.length === limit && compare(row, rows.at(-1)) >= 0) return;
			rows.push(row);
			rows.sort(compare);
			if (rows.length > limit) rows.pop();
		},
		get rows() { return rows; },
		get count() { return count; },
	};
}

function auditFindings(limit, compare) {
	const byOrder = (a, b) => compare(a, b) || a.retentionOrder - b.retentionOrder;
	const list = newest(limit, byOrder);
	const representatives = new Map();
	return {
		add(row) {
			row.retentionOrder = list.count;
			list.add(row);
			if (!AUDIT_DETECTOR_ID.test(row.detector)) return;
			const current = representatives.get(row.detector);
			if (!representatives.has(row.detector) || (current && byOrder(row, current) < 0)) {
				// The bundle rejects this many detectors; keep counting IDs, not payloads.
				representatives.set(row.detector, representatives.size < AUDIT_CHECK_MAX || current ? row : null);
			}
		},
		get count() { return list.count; },
		get representatives() { return representatives; },
		get rows() { return list.rows; },
		byOrder,
	};
}

function descendantKey(node, ledgerRow) {
	return endedKey(ledgerRow) ?? (nonEmpty(node.sessionId) ? `session:${node.sessionId}` : nonEmpty(node.taskId) ? `task:${node.taskId}` : null);
}

/**
 * Descendant sessions and tasks, recursively over `parentSessionId` in the
 * ledger rows and the usage index (depth <= 8). A parent may be named by its
 * session id or its task id, so unambiguous parent links join the frontier.
 */
function collectDescendants(row, ledger, usageEntries) {
	return recordDescendants(row, () => ledger.filter(isRecord), usageEntries);
}

function trackOwner(owners, taskId, identity) {
	if (!owners.has(taskId)) owners.set(taskId, identity);
	else if (owners.get(taskId) !== identity) owners.set(taskId, null);
}

function activeWindows(row, descendants, now) {
	const start = msOf(row.startedMs);
	const endOf = (end, start) => Number.isFinite(end) ? end : now ?? (Number.isFinite(start) ? start : Infinity);
	const intervals = [[Number.isFinite(start) ? start : -Infinity, endOf(msOf(row.endedMs), start)]];
	for (const node of descendants) {
		const startedMs = msOf(node.startedMs);
		if (!Number.isFinite(startedMs)) continue;
		intervals.push([startedMs, endOf(node.indexOnly ? NaN : msOf(node.endedMs), startedMs)]);
	}
	const windows = [];
	for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
		if (to < from) continue;
		const prev = windows.at(-1);
		if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], to);
		else windows.push([from, to]);
	}
	return windows;
}

function overlaps(windows, from, to) {
	let lo = 0;
	let hi = windows.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (windows[mid][1] < from) lo = mid + 1;
		else hi = mid;
	}
	return lo < windows.length && windows[lo][0] <= to;
}

/** Stream machine incidents, coverage and config decisions (time and threshold hash only). */
function scanDecisionHistory(decisions, row, windows, retained) {
	const open = new Map();
	const configDecisions = [];
	const matched = retained ? null : [];
	const keep = (finding) => retained ? retained.add(finding) : matched.push(finding);
	const keepRise = ({ rise, riseMs }, end) => {
		if (rise && overlaps(windows, riseMs, end)) keep(rise);
	};
	const keepInterval = (interval, end) => {
		if (!overlaps(windows, interval.openedMs, end)) return;
		keep(interval.opener);
		keepRise(interval, end);
	};
	const startedMs = msOf(row.startedMs);
	const endedMs = msOf(row.endedMs);
	const coverageEnd = Number.isFinite(startedMs) ? startedMs : Number.isFinite(endedMs) ? endedMs : Infinity;
	const lastEnd = windows.at(-1)?.[1] ?? -Infinity;
	let coverageMs = -Infinity;
	for (const entry of decisions) {
		if (!isRecord(entry)) continue;
		const { fp, event, subject } = entry;
		const ts = timeOf(entry);
		if (!Number.isFinite(ts)) continue;
		if (event === "config") configDecisions.push(configDecisionFact(entry));
		if (event === "coverage" && entry.infoFindings === true && ts < coverageEnd && ts > coverageMs) coverageMs = ts;
		if (!FINDING_EVENTS.has(event) || !nonEmpty(fp)) continue;
		const interval = open.get(fp);
		if (event === "resolved") {
			if (interval) keepInterval(interval, ts);
			open.delete(fp);
		} else if (ts <= lastEnd && !nonEmpty(subject?.sessionId) && !nonEmpty(subject?.taskId)) {
			if (event === "severity") {
				if (!interval) continue;
				keepRise(interval, ts);
				interval.rise = machineRow(entry, fp, ts, Boolean(retained));
				interval.riseMs = ts;
			} else if (!interval) {
				open.set(fp, { openedMs: ts, opener: machineRow(entry, fp, ts, Boolean(retained)) });
			}
		}
	}
	for (const interval of open.values()) keepInterval(interval, Infinity);
	return { machine: matched, infoFindings: Number.isFinite(coverageMs), configDecisions };
}

function findingRow(entry, { fp = entry.fp ?? null, ts = entry.ts ?? null, scope = "session", bounded = false } = {}) {
	const subject = entry.subject ?? {};
	return {
		fp,
		ts,
		event: entry.event,
		detector: clean(entry.detector, 20),
		kind: clean(entry.kind, 80),
		severity: clean(entry.severity, 20),
		scope,
		...(bounded ? {
			subject: cleanValue({ sessionId: subject.sessionId, taskId: subject.taskId, sessionKey: subject.sessionKey, taskKey: subject.taskKey }),
			auditEvidence: auditEvidence((function* () {
				for (const line of Array.isArray(entry.evidence) ? entry.evidence : []) {
					const cleaned = cleanDetail(line);
					if (cleaned) yield cleaned;
				}
			})()),
		} : { titleKo: clean(entry.titleKo, TITLE_MAX), subject: cleanValue(subject), evidence: cleanLines(entry.evidence) }),
	};
}

function machineRow(entry, fp, ts, bounded) {
	return findingRow(entry, { fp, ts: new Date(ts).toISOString(), scope: "machine", bounded });
}

function factsOf(entry) {
	const outcome = isRecord(entry.outcome) ? entry.outcome : {};
	const count = (list) => (Array.isArray(list) ? list.length : 0);
	const reason = outcome.reason ?? entry.reason ?? (entry.result !== "execute" ? entry.result : null);
	return {
		delivered: typeof outcome.delivered === "boolean" ? outcome.delivered : null,
		via: clean(outcome.via, 80),
		killed: count(outcome.killed),
		survived: count(outcome.survived),
		error: outcome.error !== undefined && outcome.error !== null && outcome.error !== false,
		reasonCode: reasonCode(typeof reason === "string" ? reason : null),
	};
}

function actionRow(entry, subjectByFp, bounded = false, acted) {
	let kind = entry.action?.kind;
	let result = entry.result;
	let facts = factsOf(entry);
	let detail = "";
	if (!isRecord(entry.action)) {
		if (entry.event === "investigation" && result === "hold-toast") {
			kind = "hold-toast";
			result = ["shown", "cooldown", "failed"].includes(entry.toast) ? entry.toast : "failed";
			facts = { ...facts, delivered: result === "shown", error: result === "failed", reasonCode: result === "cooldown" ? "skipped" : null };
		} else if (entry.event === "investigation" && nonEmpty(entry.acted?.kind)) {
			kind = entry.acted.kind;
			facts = { ...facts, delivered: typeof entry.delivered === "boolean" ? entry.delivered : null, killed: Array.isArray(entry.killed) ? entry.killed.length : 0, reasonCode: null };
		} else if (entry.event === "notice-withdrawn") {
			kind = "notice-withdrawn";
			result = ["withdrawn:expired", "withdrawn:restored"].includes(result) ? result : "withdrawn";
			facts = { ...facts, reasonCode: null };
		} else if (entry.detector === "D20" && entry.kind === "park-resume") {
			kind = "relaunch";
			if (entry.event === "park-transition" && entry.to === "launched") result = entry.to;
			else if (entry.event === "park-transition" && entry.why === "launch-failed") result = entry.why;
			else if (entry.event !== "park-gated") return null;
			facts = { ...facts, error: result === "launch-failed" };
		} else return null;
	} else {
		const outcome = isRecord(entry.outcome) ? entry.outcome : {};
		if (acted && facts.delivered === null && typeof acted.delivered === "boolean") facts.delivered = acted.delivered;
		if (acted && !Array.isArray(outcome.killed) && Array.isArray(acted.killed)) facts.killed = acted.killed.length;
		if (!bounded) {
			detail = actionDetail({ delivered: acted?.delivered, killed: acted?.killed, ...outcome }, entry.rule) ?? "";
			const actedResult = clean(acted?.result, 120);
			if (actedResult && actedResult !== result) detail = cleanDetail([`investigation ${actedResult}`, detail].filter(Boolean).join("; "));
		}
	}
	const factsRow = { ts: entry.ts ?? null, detector: clean(entry.detector, 20), kind: clean(kind, 80), result: clean(result, 120), facts };
	if (bounded) return factsRow;
	const subject = entry.subject ?? (!isRecord(entry.action) ? subjectByFp.get(entry.fp) : null) ?? {};
	const recipient = isRecord(entry.outcome) && nonEmpty(entry.outcome.sessionId) ? entry.outcome.sessionId : nonEmpty(subject.sessionId) ? subject.sessionId : null;
	return {
		...factsRow,
		// An engine action decision carries the finding's kind at top level and the action's kind under `action`.
		findingKind: clean(entry.kind, 80),
		detail,
		recipient,
		subject: cleanValue(subject),
	};
}

// The engine writes the acted row during perform(), then the execute row when
// that request returns (engine.mjs:209,632,1198,1216). It stamps each write
// separately (:467–469) and stores no tick ID. Require producer order as well
// as same request/finding and at most one default tick's elapsed time.
function sameExecution(acted, entry) {
	const elapsed = timeOf(entry) - timeOf(acted);
	return entry.result === "execute" && acted.fp === entry.fp && acted.acted.key === entry.action?.key &&
		acted.acted.kind === entry.action.kind && elapsed >= 0 && elapsed <= DEFAULT_CONFIG.tickMs;
}

function verdictFacts(entry) {
	const a = entry.analyst;
	if (!isRecord(a) || !nonEmpty(a.verdict)) return null;
	return {
		ts: entry.ts ?? null,
		verdict: a.verdict,
		assessment: a.assessment ?? null,
		cause: a.cause ?? null,
		confidence: Number.isFinite(a.confidence) ? a.confidence : null,
		failed: a.failed === true || entry.result === "analyst-failed",
	};
}

function analystJobDir(jobsDir, jobId) {
	return jobsDir && typeof jobId === "string" && /^[A-Za-z0-9][\w-]{0,127}$/.test(jobId) ? path.join(jobsDir, jobId) : null;
}

/** Read related decisions in producer order; false means a terminal row lacks provenance. */
export function collectAnalystDecisionModels(models, entry, jobsDir, pending) {
	if (entry.event !== "investigation") return true;
	if (nonEmpty(entry.model)) models.add(entry.model);
	// The engine writes jobId/step/model on start and jobId/step/analyst on answer.
	// Either row can retain the investigation's earlier status after resolution.
	if (nonEmpty(entry.jobId) && !nonEmpty(entry.analyst?.verdict) && entry.usedModels === undefined &&
		(entry.status === "analyzing" || (entry.step != null && nonEmpty(entry.model)))) {
		pending.add(entry.jobId);
		return true;
	}
	if (!nonEmpty(entry.analyst?.verdict) && entry.usedModels === undefined &&
		!(entry.jobId && (entry.status === "verdict" || entry.status === "failed"))) return true;
	pending.delete(entry.jobId);
	const dir = analystJobDir(jobsDir, entry.jobId);
	const used = Array.isArray(entry.usedModels) && entry.usedModels.every(nonEmpty) ? entry.usedModels :
		dir ? readFallbackTargets(path.join(dir, "err.log")) : null;
	if (!used) return false;
	for (const model of used) models.add(model);
	return true;
}

function analystJobEnded(dir) {
	const exit = readJsonSafe(path.join(dir, "exit.json"));
	if (Number.isInteger(exit?.code) || nonEmpty(exit?.signal)) return true;
	const meta = readJsonSafe(path.join(dir, "meta.json"));
	if (["done", "failed", "unavailable"].includes(meta?.final?.status) && !meta.final.holdUntilExit) return true;
	// A restarted daemon may have missed the exit event. Probe for absence only;
	// a live or inaccessible PID cannot certify the log (even if the PID was reused).
	const pid = meta?.pid;
	if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}

/** Recover only runs whose retained stderr can no longer be extended by the analyst. */
export function recoverPendingAnalystModels(models, pending, jobsDir) {
	for (const jobId of pending) {
		const dir = analystJobDir(jobsDir, jobId);
		const used = dir && analystJobEnded(dir) ? readFallbackTargets(path.join(dir, "err.log")) : null;
		if (!used) continue;
		for (const model of used) models.add(model);
		pending.delete(jobId);
	}
	return pending.size === 0;
}

const byVerdictTime = (a, b) => (msOf(a.ts) || 0) - (msOf(b.ts) || 0);

function verdictRows(decisions, fp) {
	const rows = [];
	for (const entry of decisions) {
		if (!isRecord(entry) || entry.fp !== fp || entry.event !== "investigation") continue;
		const facts = verdictFacts(entry);
		if (facts) rows.push({ ...facts, ...verdictText(entry.analyst) });
	}
	return rows.sort(byVerdictTime);
}

// Copy just the inputs to investigationsOf; keep the dashboard's normalization
// for these fields but never build its prose-heavy raw record for an audit.
function investigationFacts(record) {
	const { id, openedMs, trigger, status, detector, cls, model, lane, failures, rule, verdict, actions } = record;
	return cleanValue({
		id, openedMs, trigger, status, detector, cls, model, lane, failures,
		rule: isRecord(rule) ? { id: rule.id, confidence: rule.confidence } : null,
		verdict: isRecord(verdict) ? {
			verdict: verdict.verdict, assessment: verdict.assessment, cause: verdict.cause, confidence: verdict.confidence,
			reused: verdict.reused, failed: verdict.failed, reason: reasonCode(cleanDetail(verdict.reason)), notReached: verdict.notReached,
		} : null,
		actions: Array.isArray(actions) ? actions.slice(0, 500).map((action) => ({ kind: action?.kind, delivered: action?.delivered })) : [],
	});
}

function investigationRow(record, decisions) {
	const raw = cleanValue(record);
	const actions = Array.isArray(record.actions) ? record.actions.slice(0, 500) : null;
	return {
		...raw,
		evidence: cleanLines(record.evidence),
		signals: cleanLines(record.signals),
		...(isRecord(record.verdict) ? { verdict: { ...raw.verdict, ...verdictText(record.verdict) } } : {}),
		...(actions ? { actions: actions.map((action, i) => isRecord(action) ? {
			...raw.actions[i],
			detail: actionDetail(action, action.rule, true),
			advice: cleanDetail(action.advice),
		} : raw.actions[i]) } : {}),
		verdictHistory: verdictRows(decisions, record.id),
	};
}

const sortRank = (tokens) => (Number.isNaN(tokens) ? Infinity : tokens);

function modelRows(published) {
	const models = isRecord(published?.models) ? published.models : {};
	return Object.entries(models)
		// Accounting has already bounded these keys; audit fallback needs their full identity.
		// A non-finite value (counters are added as supplied) is kept; JSON and the dashboard show it as "-".
		.map(([key, value]) => ({ key: scrub(key), tokens: typeof value?.tokens === "number" ? value.tokens : 0, cost: typeof value?.cost === "number" ? value.cost : 0 }))
		.sort((a, b) => sortRank(b.tokens) - sortRank(a.tokens) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function ledgerUsageSessionId({ sessionId, taskId }) {
	// Live and backfill writers use the task ID as the ledger key if there is no child session ID.
	return nonEmpty(sessionId) && sessionId !== taskId ? sessionId : null;
}

export function childHeaderConflicts(subject, file, header) {
	// A task-only ledger key is an alias, not the transcript's session id.
	const sessionId = ledgerUsageSessionId(subject) ?? idFromFileName(file);
	return mainHeaderConflicts({ ...subject, sessionId }, header);
}

const ambiguousUsageFallback = (row, ambiguous, ids = row) =>
	!ledgerUsageSessionId(ids) && (row.usageTaskIdAmbiguous === true || ambiguous?.has(ids.taskId) ||
		ambiguous?.has(subjectKey({ ...subjectOf(row), sessionId: ids.taskId })));

export function ambiguousLedgerTaskIds(rows, { scoped = false } = {}) {
	const seen = new Set();
	const ambiguous = new Set();
	for (const row of rows) {
		if (!isRecord(row) || !nonEmpty(row.taskId) || ledgerUsageSessionId(row)) continue;
		const key = scoped ? subjectKey({ ...subjectOf(row), sessionId: row.taskId }) : row.taskId;
		if (seen.has(key)) ambiguous.add(key);
		else seen.add(key);
	}
	return ambiguous;
}

export function usageEntryOf(usage, row, ambiguous) {
	if (row.usageStoreUnresolved) return null;
	const ids = row.ledgerIds ?? row;
	if (ambiguousUsageFallback(row, ambiguous, ids)) return null;
	const subject = { ...subjectOf(row), sessionId: ledgerUsageSessionId(ids), taskId: ids.taskId ?? null };
	let entry = usageEntryFor(usage, subject, ids.taskId);
	// An old cwd-less child may have been verified through a live parent not recorded in the ledger.
	if (entry === undefined && !subject.sessionId && !subject.projectKey && ids.parentSessionId) {
		const matches = new Set();
		for (const candidate of usage.values()) {
			if (candidate.parentSessionId !== ids.parentSessionId ||
				(subject.sessionId ? candidate.id !== subject.sessionId : candidate.taskId !== ids.taskId)) continue;
			matches.add(subjectOf(candidate).projectKey);
		}
		if (matches.size === 1) entry = usageEntryFor(usage, { ...subject, projectKey: matches.values().next().value }, ids.taskId);
	}
	return entry ?? (usage.full === true ? FULL_USAGE : null);
}

export function usageTreeLink(usage, row, ambiguous, parentOwners) {
	const entry = usageEntryOf(usage, row, ambiguous);
	const subject = subjectOf(row, subjectOf(entry));
	const id = ledgerUsageSessionId(row) ?? entry?.id;
	const key = subjectKey(entry?.id && !ledgerUsageSessionId(row) ? subjectOf(entry) : { ...subject, sessionId: id ?? row.taskId });
	const parentKey = row.parentKey ?? subjectKey(ledgerParentSubject(row, parentOwners));
	return { key, parentKey, ...(id ? {} : { unresolved: true }) };
}

/** Resolve bare parent links against the retained ledger, not just visible rows. */
export function legacyParentOwners(compactRows, rows) {
	const ids = new Set();
	const scopedIds = new Set();
	for (const row of compactRows()) {
		if (!row.parentSessionId || row.parentTaskId != null) continue;
		(row.parentProjectKey == null ? ids : scopedIds).add(row.parentSessionId);
	}
	const owners = new Map();
	if (scopedIds.size) {
		for (const row of compactRows()) if (scopedIds.has(row.sessionId) && !ids.has(row.sessionId)) rememberParentOwner(owners, subjectOf(row));
	}
	if (!ids.size) return owners;
	const family = [...ledgerSubjectParents(new Set(ids), rows)];
	const resolve = sessionSubjects(family);
	for (const row of family) if (ids.has(row.sessionId)) rememberParentOwner(owners, resolve(row));
	return owners;
}

/** Stream older descendants of the supplied history rows, one pass per depth. */
export function* retainedTreeRows(paths, rows, { beforeMs, withLocation } = {}) {
	let parents = new Set();
	for (const row of rows ?? []) {
		if (nonEmpty(row?.sessionId)) parents.add(row.sessionId);
		yield row;
	}
	const seen = new Set(parents);
	for (let depth = 0; depth < DEPTH_MAX && parents.size; depth += 1) {
		const next = new Set();
		for (const row of streamEnded(paths, { beforeMs, withLocation })) {
			const { sessionId, taskId, kind, endedMs, parentSessionId, parentTaskId, parentProjectKey, endedProjectKey, rootSessionId, cwd } = row;
			if (!parents.has(parentSessionId) || !nonEmpty(sessionId)) continue;
			yield { sessionId, taskId, kind, endedMs, parentSessionId, parentTaskId, parentProjectKey, endedProjectKey, rootSessionId, cwd, [ENDED_LOCATION]: row[ENDED_LOCATION] };
			if (!seen.has(sessionId)) {
				seen.add(sessionId);
				next.add(sessionId);
			}
		}
		parents = next;
	}
}

const FULL_USAGE = Object.freeze({ state: "full" });

/** Resolve a stored subject ID against the join keys of exact ledger IDs. */
export function createSubjectIdMatcher(ids) {
	const byKey = new Map();
	for (const id of ids) {
		const key = subjectIdJoinKey(id);
		if (key) trackOwner(byKey, key, id);
	}
	return (id, key) => {
		const maskedKey = maskedSubjectKey(id, key);
		return maskedKey ? byKey.get(maskedKey) : id;
	};
}

function joinSessionDecisions(row, descendants, investigations, decisions, { blockedIds, blockedTasks, taskParentOwners, unknownLiveParents }, bounded, jobsDir) {
	const nodes = [row, ...descendants];
	const sessionAllowed = new Set(nodes.map((node) => node.sessionId).filter(nonEmpty));
	// D8 addresses the parent session but names the affected child by its task id.
	const childTasksByParent = new Map();
	for (const { parentSessionId, taskId } of nodes) {
		if (!nonEmpty(parentSessionId) || !nonEmpty(taskId)) continue;
		if (!childTasksByParent.has(parentSessionId)) childTasksByParent.set(parentSessionId, new Set());
		childTasksByParent.get(parentSessionId).add(taskId);
	}
	const taskOnly = new Set(nodes.filter((node) => !nonEmpty(node.sessionId)).map((node) => node.taskId).filter(nonEmpty));
	const sessionTasks = new Map(nodes.filter((node) => sessionAllowed.has(node.sessionId)).map((node) => [node.sessionId, subjectOf(node).taskId]));
	const matchSessionId = createSubjectIdMatcher([...sessionAllowed, ...blockedIds, ...childTasksByParent.keys()]);
	const taskIds = new Set(nodes.map((node) => node.taskId).filter(nonEmpty));
	const matchTaskId = createSubjectIdMatcher(taskIds);
	const sessionOf = (subject) => matchSessionId(subject?.sessionId, subject?.sessionKey);
	const taskOf = (subject) => matchTaskId(subject.taskId, subject.taskKey);
	const taskSubjects = new Map();
	if (taskOnly.size) {
		const countSubject = ({ subject } = {}) => {
			if (!isRecord(subject)) return;
			const taskId = taskOf(subject);
			if (!taskOnly.has(taskId)) return;
			const sessionKey = maskedSubjectKey(subject.sessionId, subject.sessionKey) ?? subjectIdJoinKey(subject.sessionId);
			const identity = sessionKey ? `masked-session:${sessionKey}` : nonEmpty(subject.sessionId)
				? `session:${subject.sessionId}` : `parent:${subject.parentSessionId ?? subject.rootSessionId ?? ""}`;
			trackOwner(taskSubjects, taskId, identity);
		};
		// A competing owner can veto a task-only match, even if its row would not be retained.
		for (const entry of decisions()) if (isRecord(entry)) countSubject(entry);
		for (const record of investigations()) if (isRecord(record)) countSubject(record);
	}
	const subjectAttribution = (subject, legacySessionId) => {
		if (nonEmpty(subject?.taskId)) {
			const taskId = taskOf(subject);
			if (!taskIds.has(taskId)) return "other";
			if (blockedTasks.has(taskId)) {
				const sessionId = sessionOf(subject);
				// An independently unique session can disambiguate a reused task id.
				if (!blockedIds.has(sessionId) && sessionTasks.get(sessionId) === taskId) return "owned";
				// D8 names the parent as both session and parent. In that
				// shape the parent and task together can identify one child.
				if (subject.sessionId === subject.parentSessionId && !blockedIds.has(sessionId) &&
					childTasksByParent.get(sessionId)?.has(taskId) && !unknownLiveParents.has(taskId) &&
					taskParentOwners.get(taskId)?.get(sessionId) != null) return "owned";
				if (nonEmpty(sessionId) && !sessionAllowed.has(sessionId) && !childTasksByParent.get(sessionId)?.has(taskId) &&
					!taskOnly.has(taskId)) return "other";
				return "blocked";
			}
			return taskSubjects.get(taskId) === null ? "blocked" : "owned";
		}
		const sessionId = nonEmpty(subject?.sessionId) ? sessionOf(subject)
			: legacySessionId ?? subject?.parentSessionId ?? subject?.rootSessionId;
		if (nonEmpty(subject?.sessionId) && !nonEmpty(sessionId)) return "other";
		if (!nonEmpty(sessionId)) return "none";
		if (!sessionAllowed.has(sessionId)) return "other";
		return blockedIds.has(sessionId) ? "blocked" : "owned";
	};
	const unattributedHealth = { findings: 0, actions: 0, verdicts: 0, investigations: 0 };

	// 1. investigations about the session or its descendants
	const selectedInvestigations = [];
	// Keep the unfiltered keys and model provenance for reviewer independence and launch rechecks.
	const fpSet = new Set();
	const blockedFps = new Set();
	const analystModels = new Set();
	const pendingAnalystJobs = new Set();
	let analystModelsKnown = true;
	for (const record of investigations()) {
		if (!isRecord(record)) continue;
		const attribution = subjectAttribution(record.subject);
		if (attribution !== "owned" && attribution !== "blocked") continue;
		if (nonEmpty(record.id)) {
			fpSet.add(record.id);
			if (attribution === "blocked") blockedFps.add(record.id);
		}
		if (nonEmpty(record.model)) analystModels.add(record.model);
		if (attribution === "blocked") unattributedHealth.investigations++;
		else if (bounded) bounded.investigations.add({ ...investigationFacts(record), historyId: record.id });
		else selectedInvestigations.push(record);
	}

	// 2. the fp set: selected investigations plus lifecycle rows whose subject matches
	for (const entry of decisions()) {
		if (!isRecord(entry) || !nonEmpty(entry.fp)) continue;
		const attribution = subjectAttribution(entry.subject, entry.sessionId);
		if ((attribution === "owned" || attribution === "blocked") &&
			(FINDING_EVENTS.has(entry.event) || entry.event === "investigation")) fpSet.add(entry.fp);
		if (attribution === "blocked") blockedFps.add(entry.fp);
	}

	// 3. decisions about the session; 4. decisions delivered to it or its descendants.
	// Scan again so an action written before the lifecycle row can still join by fp.
	const about = [];
	const delivered = [];
	const actionEntries = [];
	let pending;
	const addAction = (entry, deliveredOnly, unattributed, acted) => {
		if (unattributed) {
			if (actionRow(entry, null, true, acted)) unattributedHealth.actions++;
		} else if (!bounded) actionEntries.push({ entry, deliveredOnly, acted });
		else {
			const action = actionRow(entry, null, true, acted);
			if (action) bounded.actions.add({ ...action, deliveredOnly });
		}
	};
	const histories = new Map(bounded?.investigations.rows.map(({ historyId }) => [historyId, { rows: [], chars: 2 }]));
	for (const entry of decisions()) {
		if (!isRecord(entry)) continue;
		const attribution = subjectAttribution(entry.subject, entry.sessionId);
		const related = attribution === "owned" || attribution === "blocked" || (attribution === "none" && fpSet.has(entry.fp));
		const selected = related || sessionAllowed.has(entry.outcome?.sessionId);
		const acted = pending && sameExecution(pending.entry, entry) && selected ? pending.entry : undefined;
		if (pending?.selected && !acted) addAction(pending.entry, pending.deliveredOnly, pending.unattributed);
		const unattributed = attribution === "blocked" || (attribution === "none" && blockedFps.has(entry.fp)) ||
			(!related && blockedIds.has(entry.outcome?.sessionId)) || Boolean(acted && pending.unattributed);
		pending = undefined;
		// A relay summary can supply facts for a selected delivery even when
		// its source child isn't in this record's retained family.
		const hasActed = entry.event === "investigation" && nonEmpty(entry.fp) && nonEmpty(entry.acted?.key) && nonEmpty(entry.acted?.kind);
		if (hasActed) pending = { entry, selected, deliveredOnly: !related, unattributed };
		if (!selected) continue;
		if (related && !collectAnalystDecisionModels(analystModels, entry, jobsDir, pendingAnalystJobs)) analystModelsKnown = false;
		if (!hasActed) addAction(entry, !related, unattributed, acted);
		if (unattributed) {
			if (FINDING_EVENTS.has(entry.event)) unattributedHealth.findings++;
			if (related && entry.event === "investigation" && verdictFacts(entry)) unattributedHealth.verdicts++;
			continue;
		}
		if (!bounded) {
			(related ? about : delivered).push(entry);
			continue;
		}
		if (FINDING_EVENTS.has(entry.event)) bounded.findings.add({ ...findingRow(entry, { bounded: true }), deliveredOnly: !related });
		if (related && entry.event === "investigation") {
			const history = histories.get(entry.fp);
			const facts = history?.rows && verdictFacts(entry);
			if (!facts) continue;
			const projected = auditHistoryRow({ ...facts, reason: cleanDetail(entry.analyst.reason) });
			history.chars += JSON.stringify(projected).length + (history.rows.length ? 1 : 0);
			// This history alone can make the final bundle too large. Keep a
			// sentinel rather than accumulating a list the bundle can't send.
			if (history.chars > BUNDLE_MAX_CHARS) history.rows = null;
			else history.rows.push(projected);
		}
	}
	if (pending?.selected) addAction(pending.entry, pending.deliveredOnly, pending.unattributed);
	recoverPendingAnalystModels(analystModels, pendingAnalystJobs, jobsDir);
	const modelHistory = {
		unattributedHealth,
		analystModels: [...analystModels],
		analystModelsKnown: analystModelsKnown && pendingAnalystJobs.size === 0,
		// If terminal provenance was missing, resolving the pending jobs alone cannot establish coverage.
		pendingAnalystJobs: analystModelsKnown ? [...pendingAnalystJobs] : [],
	};
	if (bounded) {
		for (const investigation of bounded.investigations.rows) {
			const { rows } = histories.get(investigation.historyId);
			delete investigation.historyId;
			if (rows === null) investigation.verdictHistoryTooLarge = true;
			else investigation.verdictHistory = rows.sort(byVerdictTime);
		}
		return {
			...modelHistory, selectedFps: [...fpSet],
			auditSubjectIds: { sessionIds: sessionAllowed, taskIds, childTasksByParent },
		};
	}
	return { selectedInvestigations, fpSet, about, selected: [...new Set([...about, ...delivered])], actionEntries, ...modelHistory };
}

function recordHealth(inputs, row, descendants) {
	if (inputs.auditHealth) return { ...inputs.auditHealth, ...inputs.decisionJoin, configDecisions: inputs.decisionHistory.configDecisions };
	const { decisions, investigations, messages: messagesIn } = inputs;
	const { selectedInvestigations, fpSet, about, selected, actionEntries, analystModels, analystModelsKnown, pendingAnalystJobs, unattributedHealth } =
		inputs.decisionJoin ?? joinSessionDecisions(row, descendants, () => investigations, () => decisions, healthAttributionOwners([row, ...descendants], () => [row, ...inputs.ledger]));
	const findings = selected.filter((entry) => FINDING_EVENTS.has(entry.event)).map((entry) => findingRow(entry));
	const { machine, infoFindings, configDecisions } = inputs.decisionHistory ?? scanDecisionHistory(
		decisions.filter((entry) => Number.isFinite(timeOf(entry))).sort((a, b) => timeOf(a) - timeOf(b)), row, activeWindows(row, descendants, inputs.now),
	);
	const allFindings = [...findings, ...machine].sort(byNewest);
	const subjectByFp = new Map(selectedInvestigations.map(({ id, subject }) => [id, subject]));
	for (const entry of about) {
		if (FINDING_EVENTS.has(entry.event) && nonEmpty(entry.fp) && isRecord(entry.subject) && !subjectByFp.has(entry.fp)) subjectByFp.set(entry.fp, entry.subject);
	}
	const actions = actionEntries.flatMap(({ entry, deliveredOnly, acted }) => {
		const action = actionRow(entry, subjectByFp, false, acted);
		return action ? [{ action, ts: action.ts, deliveredOnly }] : [];
	}).sort(byDecisionTime).map(({ action }) => action);
	const investigationRows = selectedInvestigations.map((record) => investigationRow(record, about)).sort(byInvestigationTime);
	const messages = messagesIn.filter(isRecord).map((message) => ({
		ms: Number.isFinite(message.ms) ? message.ms : null, kind: auditMessageKind(message.kind), recipient: clean(message.recipient, 200), text: cleanDetail(message.text),
	})).sort(byMessageTime);
	return {
		infoFindings,
		configDecisions,
		analystModels,
		analystModelsKnown,
		pendingAnalystJobs,
		unattributedHealth,
		selectedFps: [...fpSet],
		health: {
			findings: allFindings, actions, investigations: investigationRows, messages,
			counts: { findings: allFindings.length, actions: actions.length, investigations: investigationRows.length, messages: messages.length },
		},
	};
}

const byInvestigationTime = (a, b) => (b.openedMs ?? 0) - (a.openedMs ?? 0);
const byMessageTime = (a, b) => (b.ms ?? 0) - (a.ms ?? 0);
const byDecisionTime = (a, b) => byNewest(a, b) || Number(a.deliveredOnly) - Number(b.deliveredOnly);

function auditRecordHealth(retained, infoFindings) {
	const { findings, machine, actions, investigations, messages } = retained;
	const sessionReps = findings.representatives;
	const machineReps = machine.representatives;
	const sortFindings = (session, global) => [
		...session.sort(findings.byOrder), ...global.sort(machine.byOrder),
	].sort(byNewest);
	const orderedReps = sortFindings([...sessionReps.values()].filter(Boolean), [...machineReps.values()].filter(Boolean));
	const firedDetectors = [...new Set([...orderedReps.map(({ detector }) => detector), ...sessionReps.keys(), ...machineReps.keys()])];
	return {
		infoFindings,
		health: {
			findings: sortFindings(
				[...new Set([...findings.rows, ...[...sessionReps.values()].filter(Boolean)])],
				[...new Set([...machine.rows, ...[...machineReps].filter(([id, row]) => row && !sessionReps.has(id)).map(([, row]) => row)])],
			),
			actions: actions.rows,
			investigations: investigations.rows,
			messages: messages.rows,
			firedDetectors,
			counts: { findings: findings.count + machine.count, actions: actions.count, investigations: investigations.count, messages: messages.count },
		},
	};
}

/**
 * Join every stored record about `inputs.row` and its descendants. Pure: the
 * loader supplies already-read inputs, so tests can drive a fixture directly.
 */
export function buildSessionRecord(inputs = {}) {
	const { id, row } = inputs;
	const ledger = Array.isArray(inputs.ledger) ? inputs.ledger : [];
	const usage = typeof inputs.usage?.get === "function" && typeof inputs.usage?.values === "function" ? inputs.usage : new Map();
	const decisions = Array.isArray(inputs.decisions) ? inputs.decisions : [];
	const investigations = Array.isArray(inputs.investigations) ? inputs.investigations : [];
	const messagesIn = Array.isArray(inputs.messages) ? inputs.messages : [];
	const truncated = isRecord(inputs.truncated) ? inputs.truncated : { messagesSkipped: [] };
	if (!isRecord(row)) return { found: false, id };

	const startedMs = msOf(row.startedMs);
	const endedMs = msOf(row.endedMs);
	const descendants = (inputs.descendants ?? collectDescendants(row, ledger, usage)).map((node) => ({ ...node, ...subjectOf(node, subjectOf(row)) }));
	const ambiguous = inputs.ambiguous ?? ambiguousLedgerTaskIds(ledger);
	const { health, infoFindings, configDecisions, analystModels, analystModelsKnown, pendingAnalystJobs, selectedFps, unattributedHealth } =
		recordHealth({ ...inputs, ledger, decisions, investigations, messages: messagesIn }, row, descendants);

	const entry = usageEntryOf(usage, row, ambiguous);
	const compact = compactUsage(entry);
	// Sum the ownership-checked descendants; a separate index-only fallback
	// could count a child whose ledger row deliberately did not resolve.
	let subtotal = compact?.total ?? 0;
	let counted = false;
	let treeTokensComplete = Number.isFinite(compact?.total);
	const seen = new Set(entry?.id ? [subjectKey(subjectOf(entry))] : []);
	const blocked = new Set(ambiguousUsageFallback(row, ambiguous) ? [row.sessionId] : []);
	const children = descendants
		.map((node) => {
			const childEntry = usageEntryOf(usage, node, ambiguous);
			const childCompact = compactUsage(childEntry);
			const total = childCompact?.total;
			// Descendants are discovered breadth first. Do not sum a branch
			// reached through a task ID that could belong to another parent.
			const branchBlocked = blocked.has(node.parentSessionId) || ambiguousUsageFallback(node, ambiguous);
			if (branchBlocked) blocked.add(node.sessionId ?? node.taskId);
			if (branchBlocked || !Number.isFinite(total)) treeTokensComplete = false;
			const childKey = subjectKey(subjectOf(childEntry));
			if (!branchBlocked && typeof total === "number" && !seen.has(childKey)) {
				seen.add(childKey);
				counted = true;
				subtotal += total;
			}
			return {
				sessionId: node.sessionId,
				taskId: node.taskId,
				parentSessionId: node.parentSessionId,
				title: clean(node.title, TITLE_MAX),
				outcome: clean(node.outcome, 40),
				endedMs: node.endedMs,
				depth: node.depth,
				tokens: childCompact,
				tokensState: childCompact ? "ok" : ["missing", "full"].includes(childEntry?.state) ? childEntry.state : "pending",
			};
		})
		.sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));

	const tokens = entry || counted
		? {
				...(compact ?? { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, costUnknown: false, turns: null }),
				models: modelRows(entry?.published),
				state: entry?.state ?? "pending",
				complete: entry?.complete === true,
				treeTotal: counted ? subtotal : null,
				treeTokensComplete: treeTokensComplete && Number.isFinite(subtotal),
				gone: entry?.gone === true,
			}
		: null;

	const session = cleanValue(row);
	delete session.storeDir;
	// Keep exact join keys off the display fields that also feed the reviewer bundle.
	session.projectKey = subjectOf(row, subjectOf(entry)).projectKey;
	session.ledgerIds = {
		sessionId: safeSubjectId(row.sessionId),
		taskId: safeSubjectId(row.taskId),
		parentSessionId: safeSubjectId(row.parentSessionId),
	};
	// Cached previews and audit preparation re-read the index from this session alone.
	if (!ledgerUsageSessionId(row) && ambiguousUsageFallback(row, ambiguous)) session.usageTaskIdAmbiguous = true;
	// Cached previews only receive session metadata and the model list.
	if (!analystModelsKnown) session.analystModelsUnknown = true;
	if (pendingAnalystJobs?.length) session.pendingAnalystJobs = pendingAnalystJobs;
	session.durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;

	return {
		found: true,
		id: row.sessionId,
		session,
		tokens,
		children,
		coverage: { infoFindings },
		configDecisions,
		analystModels,
		selectedFps,
		truncated: {
			messagesSkipped: Array.isArray(truncated.messagesSkipped) ? truncated.messagesSkipped : [],
			...(truncated.descendantsSkipped > 0 ? { descendantsSkipped: truncated.descendantsSkipped } : {}),
			...(unattributedHealth && Object.values(unattributedHealth).some(Boolean) ? { unattributedHealth } : {}),
		},
		health,
	};
}

const SCAN_CHUNK = 4 * 1024 * 1024;
const SCAN_LINE_MAX = 1024 * 1024;
const SCAN_NEWLINE = 0x0a;
const SCAN_MARKER = Buffer.from('"customType":"omo-health"', "utf8");

// The usage scanner has a fixed projection that omits content and display.
// Walk top-level members and details.kind; skip other nested values by depth.
function oversizedMessageScanner(bounded) {
	const fields = Object.create(null);
	// At most six encoded bytes per UTF-16 unit. The lookahead also leaves
	// room for a two-unit UTF-8 character at the display truncation boundary.
	const raw = Buffer.allocUnsafe(bounded ? 6 * 128 : 6 * (DETAIL_TEXT_MAX + 1));
	let state = "root";
	let key;
	let inDetails = false;
	let depth = 0;
	let quoted = false;
	let escape = 0;
	let limit = 0;
	let units = 0;
	let length = 0;

	const reset = (max) => { limit = max; units = length = 0; };
	const parse = (string) => {
		const text = raw.toString("utf8", 0, length);
		return JSON.parse(string ? `"${text}"` : text);
	};
	const wanted = () => key === "type" || key === "customType" || key === "timestamp" ||
		key === "display" || (!bounded && key === "content");
	const assign = (value) => {
		if (inDetails) {
			if (key === "kind") fields.details.kind = value;
		} else if (wanted()) fields[key] = value;
		else if (key === "details") fields.details = undefined;
		state = "after";
	};

	function step(byte) {
		if (quoted) {
			if (byte === 0x22 && escape === 0) {
				quoted = false;
				if (depth !== 0) return;
				const value = limit && (units <= limit || !inDetails && key === "content" && state === "value") ? parse(true) : undefined;
				if (state === "value") assign(value);
				else {
					key = value;
					state = "colon";
				}
				return;
			}
			if (byte < 0x20) { state = "invalid"; return; }
			if (limit) {
				// A JSON escape or a UTF-8 continuation belongs to the preceding unit.
				if (escape === 0 && (byte & 0xc0) !== 0x80) units += byte >= 0xf0 ? 2 : 1;
				if (units <= limit && length < raw.length) raw[length++] = byte;
			}
			if (escape === -1) escape = byte === 0x75 ? 4 : 0; // \uXXXX
			else if (escape > 0) escape--;
			else if (byte === 0x5c) escape = -1;
			return;
		}
		if (depth !== 0) {
			if (byte === 0x22) quoted = true;
			else if (byte === 0x7b || byte === 0x5b) depth++;
			else if ((byte === 0x7d || byte === 0x5d) && --depth === 0) assign(undefined);
			return;
		}
		const space = byte === 0x20 || byte === 0x09 || byte === 0x0d;
		if (state === "scalar") {
			if (space || byte === 0x2c || byte === 0x7d) assign(limit && length <= limit ? parse(false) : undefined);
			else {
				if (length <= limit && limit) raw[length++] = byte;
				return;
			}
		}
		if (space) return;
		if (state === "root" && byte === 0x7b) state = "first";
		else if ((state === "first" || state === "after") && byte === 0x7d) {
			state = inDetails ? "after" : "end";
			inDetails = false;
		} else if ((state === "first" || state === "key") && byte === 0x22) {
			reset(inDetails ? 4 : 32);
			quoted = true;
		} else if (state === "colon" && byte === 0x3a) state = "value";
		else if (state === "after" && byte === 0x2c) state = "key";
		else if (state === "value") {
			if (byte === 0x22) {
				if (inDetails) reset(key === "kind" ? 41 : 0); // auditMessageKind's maximum length
				else reset(wanted() ? key === "content" ? DETAIL_TEXT_MAX + 1 : 128 : 0);
				quoted = true;
			} else if (!inDetails && key === "details" && byte === 0x7b) {
				fields.details = Object.create(null);
				inDetails = true;
				state = "first";
			} else if (byte === 0x7b || byte === 0x5b) {
				reset(0);
				depth = 1;
			} else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x74 || byte === 0x66 || byte === 0x6e) {
				reset(!inDetails && (key === "timestamp" || key === "display") ? 128 : 0);
				if (limit) raw[length++] = byte;
				state = "scalar";
			} else state = "invalid";
		} else state = "invalid";
	}

	return {
		push(bytes) {
			try {
				for (let i = 0; i < bytes.length && state !== "invalid"; i++) step(bytes[i]);
			} catch {
				// An invalid captured JSON token invalidates this line, not the scan.
				state = "invalid";
			}
		},
		finish() { return state === "end" ? fields : null; },
	};
}

/**
 * Only lines naming the `omo-health` custom type are parsed; the rest of the
 * transcript is never decoded as content. The file is read in 4 MiB chunks so
 * a session file larger than the daemon heap (96 MiB) cannot exhaust it, and a
 * line over 1 MiB switches to the bounded message scanner.
 */
export function scanOmoHealthMessages(file) {
	return [...streamOmoHealthMessages(file)];
}

function* streamOmoHealthMessages(file, bounded = false, rejectsHeader) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return;
	}
	const project = (entry) => {
		if (!isRecord(entry) || (entry.type !== "custom_message" && entry.type !== "custom") || entry.customType !== "omo-health") return;
		const ms = msOf(entry.timestamp);
		const message = { ms: Number.isFinite(ms) ? ms : null, kind: auditMessageKind(entry.details?.kind) };
		if (bounded) return message;
		const text = typeof entry.content === "string" ? entry.content : isRecord(entry.content) ? JSON.stringify(entry.content) : "";
		return { ...message, text: cleanDetail(text) };
	};
	const consume = (bytes) => {
		if (!bytes.length || !bytes.includes(SCAN_MARKER)) return;
		try {
			return project(JSON.parse(bytes.toString("utf8")));
		} catch {
			return;
		}
	};
	try {
		const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
		let carry = null;
		let oversized = null;
		for (;;) {
			const n = fs.readSync(fd, chunk, 0, SCAN_CHUNK, null);
			if (n === 0) break;
			const view = chunk.subarray(0, n);
			if (rejectsHeader) {
				if (rejectsHeader(sessionHeader(view))) return;
				rejectsHeader = undefined;
			}
			let pos = 0;
			while (pos < n) {
				const newline = view.indexOf(SCAN_NEWLINE, pos);
				const piece = view.subarray(pos, newline === -1 ? n : newline);
				if (!oversized && (carry?.length ?? 0) + piece.length > SCAN_LINE_MAX) {
					oversized = oversizedMessageScanner(bounded);
					if (carry) oversized.push(carry);
					carry = null;
				}
				if (oversized) oversized.push(piece);
				if (newline === -1) {
					if (!oversized) carry = carry ? Buffer.concat([carry, piece]) : Buffer.from(piece);
					break;
				}
				const message = oversized ? project(oversized.finish()) : consume(carry ? Buffer.concat([carry, piece]) : piece);
				if (message) yield message;
				oversized = carry = null;
				pos = newline + 1;
			}
		}
		const message = oversized ? project(oversized.finish()) : carry && consume(carry);
		if (message) yield message;
	} catch {
		return;
	} finally {
		fs.closeSync(fd);
	}
}

function* dirNames(directory) {
	let dir;
	try {
		dir = fs.opendirSync(directory);
		for (let entry; (entry = dir.readSync());) yield entry.name;
	} catch {
		// Absent or removed during lookup.
	} finally {
		dir?.closeSync();
	}
}

function findRecordFiles(paths, nodes, ancestors, locator, usage, ambiguous, auditRetention) {
	const wanted = new Set(nodes.filter((node) => !nonEmpty(node.taskId)).map((node) => subjectKey(subjectOf(node))));
	const main = new Map();
	const unscoped = new Map();
	if (!locator && wanted.size) {
		for (const slug of dirNames(paths.sessionsDir)) {
			const dir = path.join(paths.sessionsDir, slug);
			for (const name of dirNames(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const sid = idFromFileName(name);
				const exact = subjectKey(subjectOf({ sessionId: sid, projectKey: slug }));
				const unknown = subjectKey(subjectOf({ sessionId: sid }));
				if (!wanted.has(exact) && !wanted.has(unknown)) continue;
				const file = path.join(dir, name);
				if (!statSafe(file)?.isFile()) continue;
				if (wanted.has(exact) && (!main.has(exact) || file > main.get(exact))) main.set(exact, file);
				if (wanted.has(unknown)) {
					const prior = unscoped.get(unknown);
					if (prior !== null) unscoped.set(unknown, prior?.slug === slug
						? (file > prior.file ? { slug, file } : prior)
						: uniqueMatch([prior, { slug, file }], (match) => match));
				}
			}
		}
	}
	const childCandidate = locator?.childCandidate ?? createSessionFileLocator({ paths }).childCandidate;
	return nodes.map((node) => {
		const { sessionId, taskId } = node;
		if (!nonEmpty(taskId)) {
			const subject = subjectOf(node);
			const key = subjectKey(subject);
			const file = locator ? locator.mainFile(subject) : subject.projectKey == null ? unscoped.get(key)?.file : main.get(key);
			// Detail uses fast filename/index discovery. Check only its final choice,
			// not every candidate, and leave audit preparation's byte budget alone.
			if (!auditRetention && file) {
				const stat = statSafe(file);
				if (!stat?.isFile()) return { sessionId };
				const projectKey = subject.projectKey ?? (isInside(file, paths.sessionsDir)
					? path.basename(path.dirname(file)) : usageEntryOf(usage, node, ambiguous)?.projectKey);
				const probe = probeSessionHeader(file, stat.size, Infinity);
				if (probe.pending || mainHeaderConflicts({ ...subject, projectKey }, probe)) {
					node.usageStoreUnresolved = true;
					return { sessionId };
				}
			}
			return { sessionId, file };
		}
		const owner = childStoreOf(node, ancestors);
		const candidate = childCandidate({ taskId, sessionId, ...owner });
		const entry = usageEntryOf(usage, node, ambiguous);
		const store = owner.storeDir ?? (owner.parentCwd && senpiTaskStoreDir(owner.parentCwd, paths.agentDir));
		const taskDirectory = path.join("children", taskId, "sessions", taskId);
		const indexedDir = entry?.file && pathKey(path.dirname(entry.file));
		const taskLayout = indexedDir?.endsWith(`/${taskDirectory.replaceAll("\\", "/").toLowerCase()}`);
		// A competing candidate (or an ambiguous fallback) invalidates a
		// pre-existing cursor, even when its file has not changed.
		const mismatch = entry?.file && (candidate ? pathKey(entry.file) !== pathKey(candidate)
			: taskLayout && store && indexedDir !== pathKey(path.join(store, taskDirectory)));
		if (candidate === null || mismatch) node.usageStoreUnresolved = true;
		// A tracker-verified file may be outside the known ledger cwds (e.g.
		// the spawning parent was still live when the tracker saw it).
		const savedFile = !node.usageStoreUnresolved && entry?.readError !== true && entry?.file;
		let file = candidate ?? (savedFile && fresh(entry) ? savedFile : undefined);
		// Store discovery can rediscover the saved path after it has been replaced.
		if (savedFile && isExactInode(entry.ino) && Number.isFinite(entry.birthtimeMs) && (candidate || !file)) {
			const stamp = readUsageFileStamp(savedFile);
			if (stamp && !isSavedTranscriptVersion(stamp, entry)) {
				const subject = { ...subjectOf(node), sessionId: ledgerUsageSessionId(node.ledgerIds ?? node) ?? entry.id };
				const probe = probeSessionHeader(savedFile, stamp.size, Infinity);
				if (ownsLiveMain(subject, savedFile, probe, false)) file = candidate ?? savedFile;
				else {
					file = undefined;
					node.usageStoreUnresolved = true;
				}
			}
		}
		const subject = { ...subjectOf(node, subjectOf(entry)), sessionId: ledgerUsageSessionId(node.ledgerIds ?? node) ?? entry?.id ?? sessionId };
		const rejectsHeader = (header) => {
			if (!header.pending && !childHeaderConflicts(subject, file, header)) return false;
			node.usageStoreUnresolved = true;
			return true;
		};
		return { sessionId, file, rejectsHeader };
	}).filter(({ file }) => file);
}

function childStoreOf(node, ancestors) {
	if (nonEmpty(node.storeDir)) return { storeDir: node.storeDir };
	const parent = ancestors.get(parentLookupKey(node));
	if (nonEmpty(parent?.cwd)) return { parentCwd: parent.cwd };
	const out = [];
	let current = node;
	const seen = new Set();
	for (let depth = 0; depth < DEPTH_MAX && isRecord(current); depth += 1) {
		if (nonEmpty(current.cwd) && !out.includes(current.cwd)) out.push(current.cwd);
		const parent = ancestors.get(parentLookupKey(current));
		const key = subjectKey(subjectOf(parent));
		if (!key || seen.has(key)) break;
		seen.add(key);
		current = parent;
	}
	return { cwds: out };
}

const later = (a, b) => !b || Number(a.endedMs) > Number(b.endedMs);

const parentLookupKey = (row) => subjectKey({ sessionId: row.parentSessionId, projectKey: row.parentProjectKey, taskId: row.parentTaskId });

/** Resolve an ended ID (or unique task alias) without retaining unrelated rows. */
export function resolveLedgerSubject(paths, id, { row: selector, subject, usage, liveOwners = [] } = {}) {
	const rows = () => streamEnded(paths);
	const selected = resolveLedgerSubjects(new Set([id]), rows, rows, { selector, subject, usage, allowAliases: true }).get(id) ?? {};
	if (selector === undefined && !subject && selected.row &&
		liveOwners.some((owner) => owner.sessionId === selected.subject.sessionId && subjectKey(owner) !== subjectKey(selected.subject))) {
		return { error: "ambiguous-session" };
	}
	return selected;
}

// Shared with the bare-ID 409 route.
function resolveLedgerSubjects(ids, rows, retainedRows, { selector, subject, usage, allowAliases } = {}) {
	const candidates = new Map();
	const parents = new Set();
	for (const row of rows()) {
		const isExact = ids.has(row.sessionId) && (selector === undefined || endedSelector(row) === selector);
		if (!isExact && (!allowAliases || selector !== undefined || subject || !ids.has(row.taskId))) continue;
		const own = subjectOf(row);
		if (!own.projectKey && row.parentSessionId) parents.add(row.parentSessionId);
		const key = JSON.stringify([subjectKey(own), row.parentSessionId ?? null, isExact]);
		if (later(row, candidates.get(key)?.row)) candidates.set(key, { row, isExact });
	}
	const family = [...candidates.values()].map(({ row }) => row);
	for (const row of ledgerSubjectParents(parents, retainedRows)) family.push(row);
	const resolve = sessionSubjects(family);
	const wanted = subjectKey(subject);
	const matchesById = new Map();
	for (const { row, isExact } of candidates.values()) {
		let scoped = resolve(row);
		// Explicit null selects the ledger identity; inferring a project for a
		// token lookup must not change which audit request the row belongs to.
		if (!scoped.projectKey && usage && subject?.projectKey !== null) scoped = subjectOf(row, subjectOf(usageEntryOf(usage, row)));
		const key = subjectKey(scoped);
		if (subject && key !== wanted) continue;
		const id = isExact ? row.sessionId : row.taskId;
		if (!matchesById.has(id)) matchesById.set(id, { exact: new Map(), aliases: new Map() });
		const { exact, aliases } = matchesById.get(id);
		const matches = isExact ? exact : aliases;
		if (later(row, matches.get(key))) matches.set(key, { ...row, projectKey: scoped.projectKey });
	}
	const results = new Map();
	for (const [id, { exact, aliases }] of matchesById) {
		const matches = exact.size ? exact : aliases;
		if (matches.size > 1) {
			results.set(id, { error: "ambiguous-session" });
		} else {
			const row = matches.values().next().value;
			if (row) results.set(id, { row, subject: subjectOf(row) });
		}
	}
	return results;
}

function* ledgerSubjectParents(parents, rows) {
	const visited = new Set();
	for (let depth = 0; depth < DEPTH_MAX && parents.size; depth += 1) {
		const next = new Set();
		for (const id of parents) visited.add(id);
		for (const row of rows()) {
			if (!parents.has(row.sessionId)) continue;
			yield row;
			if (!subjectOf(row).projectKey && row.parentSessionId && !visited.has(row.parentSessionId)) next.add(row.parentSessionId);
		}
		parents = next;
	}
}

function healthAttributionOwners(nodes, rows, usage, liveOwners = []) {
	const ids = new Set(nodes.flatMap(({ sessionId, parentSessionId, rootSessionId }) =>
		[sessionId, parentSessionId, rootSessionId]).filter(nonEmpty));
	const tasks = new Set(nodes.map((node) => node.taskId).filter(nonEmpty));
	const firstSubject = new Map();
	const taskOwners = new Map();
	const taskParentOwners = new Map();
	const unknownLiveParents = new Set();
	const blockedIds = new Set();
	const unscoped = new Map();
	const consider = (id, projectKey, taskId, parentId) => {
		if (tasks.has(taskId)) {
			const key = JSON.stringify([projectKey ?? null, id ?? null]);
			trackOwner(taskOwners, taskId, key);
			if (nonEmpty(parentId)) {
				if (!taskParentOwners.has(taskId)) taskParentOwners.set(taskId, new Map());
				trackOwner(taskParentOwners.get(taskId), parentId, key);
			}
		}
		if (!ids.has(id) || blockedIds.has(id)) return;
		const first = firstSubject.get(id);
		if (!first) firstSubject.set(id, { projectKey: projectKey ?? null, taskId: taskId ?? null });
		else if (first.projectKey !== (projectKey ?? null) || first.taskId !== (taskId ?? null)) {
			blockedIds.add(id);
			firstSubject.delete(id);
		}
	};
	for (const { sessionId, projectKey, taskId } of liveOwners) {
		if (tasks.has(taskId)) unknownLiveParents.add(taskId);
		consider(sessionId, projectKey, taskId);
	}
	// Check both keys across all retained dates, regardless of the detail row selector.
	// Do not retain full matching rows or stringify the project key for each ID.
	for (const row of rows()) {
		const { sessionId, parentSessionId, endedMs, ledgerIds, usageTaskIdAmbiguous } = row;
		const taskId = row.kind === "main" ? null : ledgerIds?.taskId ?? row.taskId ?? null;
		if (!tasks.has(taskId) && (!ids.has(sessionId) || blockedIds.has(sessionId))) continue;
		const { projectKey } = subjectOf(row);
		if (projectKey) consider(sessionId, projectKey, taskId, parentSessionId);
		else {
			const key = JSON.stringify([sessionId, parentSessionId ?? null, taskId ?? null]);
			if (later(row, unscoped.get(key))) unscoped.set(key, { sessionId, parentSessionId, taskId, endedMs, ledgerIds, usageTaskIdAmbiguous, projectKey });
		}
	}
	const relevant = ({ sessionId, taskId }) => tasks.has(taskId) || !blockedIds.has(sessionId);
	const parents = new Set();
	for (const row of unscoped.values()) {
		if (row.parentSessionId && relevant(row)) parents.add(row.parentSessionId);
	}
	const family = new Map();
	for (const row of ledgerSubjectParents(parents, rows)) {
		const own = subjectOf(row);
		let peers = family.get(own.sessionId);
		if (!peers) family.set(own.sessionId, peers = { scoped: new Map(), unscoped: new Map() });
		if (own.projectKey) peers.scoped.set(own.projectKey, own);
		else peers.unscoped.set(row.parentSessionId, { ...own, parentSessionId: row.parentSessionId });
	}
	const resolve = sessionSubjects(function* () {
		for (const { scoped, unscoped } of family.values()) {
			yield* scoped.values();
			yield* unscoped.values();
		}
	}());
	for (const row of unscoped.values()) {
		if (!relevant(row)) continue;
		const inherited = resolve(row).projectKey;
		consider(row.sessionId, inherited ?? (usage ? subjectOf(usageEntryOf(usage, row)).projectKey : null), row.taskId, row.parentSessionId);
	}
	const blockedTasks = new Set();
	for (const [taskId, owner] of taskOwners) if (owner === null) blockedTasks.add(taskId);
	return { blockedIds, blockedTasks, taskParentOwners, unknownLiveParents };
}

function recordDescendants(subject, rows, usage) {
	const projects = new Map();
	const identityOf = (row) => {
		const key = descendantKey(row, row);
		if (typeof row.sessionId !== "string") return key;
		const [id, parent, project, taskId] = JSON.parse(key);
		if (typeof project !== "string") return key;
		// Keep the exact ledger identity without copying the same project path
		// into every descendant key. These ordinals never leave this walk.
		if (!projects.has(project)) projects.set(project, projects.size);
		return `project:${JSON.stringify([id, parent, projects.get(project), taskId ?? null])}`;
	};
	const seen = new Set([identityOf(subject), descendantKey(subject)]);
	const nodes = new Map();
	let lastCwd;
	let frontier = [subject];
	for (let depth = 1; depth <= DEPTH_MAX && frontier.length; depth += 1) {
		const owners = new Map();
		const aliases = new Map();
		const ids = new Map();
		for (const node of frontier) {
			for (const [id, map] of [[node.sessionId, ids], [node.taskId, aliases]]) {
				if (!nonEmpty(id)) continue;
				let projects = map.get(id);
				if (!projects) map.set(id, projects = new Map());
				projects.set(subjectOf(node).projectKey, node);
			}
		}
		const collisions = new Set();
		const parentOwners = new Map();
		// Stream both visible and retained rows once per depth. Buffer only the
		// newest matching rows, separating direct matches from unverified aliases.
		const direct = new Map();
		const indirect = new Map();
		const indexChildren = new Set();
		for (const entry of usage.values()) {
			const parentId = parentSubject(entry)?.sessionId;
			if (ids.has(parentId) || aliases.has(parentId)) indexChildren.add(subjectOf(entry).sessionId);
		}
		const ledgerMirrors = new Set();
		const consider = (node, fromLedger) => {
			const own = subjectOf(node);
			const peers = ids.get(node.sessionId);
			if (fromLedger) {
				if (peers) rememberParentOwner(parentOwners, {
					...own, projectKey: own.projectKey ?? node.parentProjectKey ?? (peers.size === 1 ? peers.keys().next().value : null),
				});
				if (indexChildren.has(node.sessionId)) ledgerMirrors.add(subjectKey(own));
				if (aliases.has(node.sessionId)) collisions.add(node.sessionId);
				if (aliases.has(node.taskId)) trackOwner(owners, node.taskId, subjectKey(own) ?? "");
			}
			const parent = node.parentSessionId;
			if (!nonEmpty(parent) || (!node.sessionId && !node.taskId)) return;
			const map = ids.has(parent) ? direct : aliases.has(parent) ? indirect : null;
			if (!map) return;
			const identity = fromLedger ? identityOf(node) : subjectKey(own);
			if (seen.has(identity)) return;
			const key = map === indirect ? parent : null;
			if (!map.has(key)) map.set(key, new Map());
			const matches = map.get(key);
			const prior = matches.get(identity);
			if (!prior || (fromLedger && later(node, prior.node))) {
				const { sessionId, taskId, parentSessionId, parentTaskId, parentProjectKey, title, outcome, startedMs, endedMs, cwd } = node;
				// JSON parsing yields fresh strings even for adjacent identical cwd values.
				if (cwd !== lastCwd) lastCwd = cwd;
				matches.set(identity, { node: { sessionId, taskId, parentSessionId, parentTaskId, parentProjectKey, title, outcome, startedMs, endedMs, cwd: lastCwd, projectKey: own.projectKey }, fromLedger });
			}
		};
		consider(subject, true);
		for (const row of rows()) consider(row, true);
		for (const entry of usage.values()) {
			const { sessionId: id, projectKey } = subjectOf(entry);
			const { taskId, parentKey, startedMs, checkedMs } = entry;
			const parent = parentSubject({ ...entry, projectKey });
			if (parent && !ledgerMirrors.has(subjectKey({ sessionId: id, projectKey, taskId })) &&
				!ledgerMirrors.has(subjectKey({ sessionId: id, projectKey: null, taskId }))) {
				consider({ sessionId: id, taskId, parentSessionId: parent.sessionId, parentTaskId: parent.taskId, parentProjectKey: parentKey ? parent.projectKey : undefined, startedMs, endedMs: checkedMs, projectKey }, false);
			}
		}
		const matches = direct.get(null) ?? new Map();
		for (const [alias, candidates] of indirect) {
			if (collisions.has(alias) || owners.get(alias) === null) continue;
			for (const [id, candidate] of candidates) {
				const prior = matches.get(id);
				if (!prior || (candidate.fromLedger && later(candidate.node, prior.node))) matches.set(id, candidate);
			}
		}
		frontier = [];
		for (const [identity, { node, fromLedger }] of matches) {
			const parentId = node.parentSessionId;
			const peers = ids.get(parentId) ?? aliases.get(parentId);
			const owner = ledgerParentSubject(node, parentOwners);
			const parent = owner ? peers.get(owner.projectKey)
				: parentOwners.has(parentId) ? null
				: (!fromLedger && node.projectKey != null) ? peers.get(node.projectKey)
				: peers.size === 1 ? peers.values().next().value : null;
			if (!parent || (owner && subjectOf(parent).taskId !== (owner.taskId ?? null)) ||
				(!owner && fromLedger && ids.has(parentId) && !parent.indexOnly)) continue;
			const parentProject = subjectOf(parent).projectKey;
			const { sessionId, taskId, parentSessionId, title, outcome, endedMs, cwd, storeDir } = node;
			let { startedMs } = node;
			// An index-only child with no known start inherits its parent's start
			// for machine overlap: it spawns while the parent is active, so the union is unchanged.
			if (!fromLedger && !Number.isFinite(msOf(startedMs))) {
				startedMs = parent.startedMs;
			}
			seen.add(identity);
			const descendant = { sessionId, taskId: taskId ?? null, parentSessionId, parentTaskId: subjectOf(parent).taskId, parentProjectKey: parentProject, title: title ?? null, outcome: outcome ?? null, startedMs, endedMs: Number.isFinite(msOf(endedMs)) ? msOf(endedMs) : null, cwd, projectKey: subjectOf(node, parent).projectKey, depth, indexOnly: !fromLedger };
			if (nonEmpty(storeDir)) descendant.storeDir = storeDir;
			frontier.push(descendant);
			nodes.set(identity, descendant);
		}
	}
	return [...nodes.values()];
}

function recordLedger(subject, rows, usage, descendantScanMax) {
	const descendants = recordDescendants(subject, rows, usage);
	const newest = [...descendants].sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));
	const scanned = Number.isFinite(descendantScanMax) ? newest.slice(0, descendantScanMax) : newest;
	const descendantsSkipped = newest.length - scanned.length;
	const ancestors = new Map();
	let children = [subject, ...scanned].filter((node) => nonEmpty(node.taskId));
	const visited = new Set();
	for (let depth = 1; depth < DEPTH_MAX && children.length; depth += 1) {
		const requested = new Set(children.map((node) => node.parentSessionId).filter(nonEmpty));
		if (!requested.size) break;
		const family = [...ledgerSubjectParents(requested, rows)];
		const resolve = sessionSubjects(family);
		const owners = new Map();
		const found = new Map();
		for (const node of family) {
			if (!requested.has(node.sessionId)) continue;
			const owner = resolve(node);
			const key = subjectKey(owner);
			rememberParentOwner(owners, owner);
			if (later(node, found.get(key))) found.set(key, node);
		}
		const next = [];
		for (const child of children) {
			const key = parentLookupKey(child);
			if (!key || visited.has(key)) continue;
			visited.add(key);
			const parent = found.get(subjectKey(ledgerParentSubject(child, owners)));
			if (!parent) continue;
			ancestors.set(key, parent);
			next.push(parent);
		}
		children = next;
	}
	const fallback = new Set([subject, ...descendants].filter((node) => !ledgerUsageSessionId(node) && nonEmpty(node.taskId)).map((node) => node.taskId));
	const relevantRows = function* () {
		for (const rec of rows()) if (fallback.has(rec.taskId)) yield rec;
	};
	const ambiguous = ambiguousLedgerTaskIds(fallback.size ? relevantRows() : []);
	return { row: subject, descendants, ancestors, scanned, descendantsSkipped, ambiguous };
}

/**
 * Read everything the record needs and join it. A file that exceeds the
 * per-file limit or the remaining total message scan budget is skipped and
 * listed in `truncated.messagesSkipped`. Descendants outside the scan cap
 * are counted in `truncated.descendantsSkipped`. `auditRetention` keeps only the
 * daemon's audit samples; the dashboard defaults to no retention limit.
 * Non-audit records report the transcript paths scanned for detail caching.
 */
export function loadSessionRecord({ paths, subject, id = subject?.sessionId, row: selector, now = Date.now(), messageScanMaxBytes = Infinity, messageScanTotalBytes = Infinity, descendantScanMax = Infinity, scanMessages, auditRetention = false, locator, index, liveOwners } = {}) {
	if (!nonEmpty(id)) return { found: false, id };
	const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
	const selected = resolveLedgerSubject(paths, id, { row: selector, subject, usage, liveOwners });
	if (!selected.row) return { found: false, id, ...(selected.error ? { error: selected.error } : {}) };
	const joined = recordLedger(selected.row, () => streamEnded(paths), usage, descendantScanMax);
	const { row, descendants, ancestors, scanned, descendantsSkipped, ambiguous } = joined;
	const startedMs = msOf(row.startedMs);
	const sinceMs = (Number.isFinite(startedMs) ? startedMs : now) - 30 * DAY_MS;
	const retained = auditRetention ? {
		findings: auditFindings(AUDIT_LIST_CAPS.findings, byDecisionTime),
		machine: auditFindings(AUDIT_LIST_CAPS.machineFindings, byNewest),
		actions: newest(AUDIT_LIST_CAPS.actions, byDecisionTime),
		investigations: newest(AUDIT_LIST_CAPS.investigations, byInvestigationTime),
		messages: newest(AUDIT_LIST_CAPS.messages, byMessageTime),
	} : null;
	const decisionHistory = scanDecisionHistory(streamDecisions(paths), row, activeWindows(row, descendants, now), retained?.machine);
	const owners = healthAttributionOwners([row, ...descendants], () => streamEnded(paths), usage, liveOwners);
	const decisionJoin = joinSessionDecisions(row, descendants, () => streamInvestigations(paths), () => streamDecisions(paths, sinceMs), owners, retained, paths.health.jobsDir);
	const files = findRecordFiles(paths, [row, ...scanned], ancestors, locator, usage, ambiguous, auditRetention);

	const messages = [];
	const skipped = [];
	const transcriptFiles = auditRetention ? null : new Set();
	let scannedBytes = 0;
	for (const { sessionId, file, rejectsHeader } of files) {
		const stat = statSafe(file);
		if (!stat?.isFile()) continue;
		const overBudget = stat.size > messageScanMaxBytes || scannedBytes + stat.size > messageScanTotalBytes;
		if (rejectsHeader && !auditRetention && (overBudget || scanMessages) &&
			rejectsHeader(probeSessionHeader(file, stat.size, Infinity))) continue;
		if (overBudget) {
			skipped.push(file);
			continue;
		}
		scannedBytes += stat.size;
		let refused = false;
		const checkHeader = rejectsHeader && ((header) => (refused = rejectsHeader(header)));
		for (const message of (scanMessages ? scanMessages(file) : streamOmoHealthMessages(file, auditRetention, checkHeader)) ?? []) {
			if (!retained) messages.push({ ...message, recipient: sessionId });
			else if (isRecord(message)) retained.messages.add({ ms: Number.isFinite(message.ms) ? message.ms : null, kind: auditMessageKind(message.kind) });
		}
		if (!refused) transcriptFiles?.add(file);
	}

	const auditHealth = retained && auditRecordHealth(retained, decisionHistory.infoFindings);
	const record = buildSessionRecord({
		id, row, descendants, ambiguous, usage, decisionJoin, decisionHistory, auditHealth, messages,
		truncated: { messagesSkipped: skipped, descendantsSkipped },
	});
	return auditRetention ? { ...record, subject: selected.subject, auditSubjectIds: decisionJoin.auditSubjectIds } : { ...record, subject: selected.subject, transcriptFiles: [...transcriptFiles] };
}
