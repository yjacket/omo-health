import fs from "node:fs";
import path from "node:path";
import { idFromFileName } from "./collect/sessions.mjs";
import { senpiTaskStoreDir } from "./collect/tasks.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import { streamDecisions } from "./decisions.mjs";
import { streamInvestigations } from "./investigations.mjs";
import { safeSubjectId } from "./session-id.mjs";
import { ENDED_LOCATION, endedKey, endedSelector, streamEnded } from "./session-ledger.mjs";
import { compactUsage, fresh, readUsageIndex, usageEntryFor } from "./usage-index.mjs";
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
	"(no event)": Object.freeze({ action: "action" }),
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
	const nodes = new Map();
	const all = [];
	for (const r of ledger) if (isRecord(r)) all.push({ sessionId: r.sessionId ?? null, taskId: r.taskId ?? null, parentSessionId: r.parentSessionId ?? null, title: r.title ?? null, outcome: r.outcome ?? null, startedMs: msOf(r.startedMs), endedMs: msOf(r.endedMs), cwd: r.cwd ?? null, ledgerRow: r });
	for (const e of usageEntries) if (nonEmpty(e?.taskId) || nonEmpty(e?.parentSessionId)) all.push({ sessionId: e.id ?? null, taskId: e.taskId ?? null, parentSessionId: e.parentSessionId, title: null, outcome: null, startedMs: msOf(e.startedMs), endedMs: msOf(e.checkedMs), cwd: null });
	const owners = new Map();
	const sessionIds = new Set();
	const remember = (link) => {
		if (nonEmpty(link.sessionId)) sessionIds.add(link.sessionId);
		if (nonEmpty(link.taskId)) trackOwner(owners, link.taskId, link.sessionId ?? "");
	};
	remember(row);
	for (const link of all) remember(link);
	const addLinks = (ids, link) => {
		if (nonEmpty(link.sessionId)) ids.add(link.sessionId);
		if (nonEmpty(link.taskId) && owners.get(link.taskId) !== null && !sessionIds.has(link.taskId)) ids.add(link.taskId);
	};
	const discovered = new Set([descendantKey(row, row), descendantKey(row)]);
	let frontier = new Set();
	addLinks(frontier, row);
	for (let depth = 1; depth <= DEPTH_MAX && frontier.size; depth += 1) {
		const next = new Set();
		for (const n of all) {
			const parent = n.parentSessionId;
			if (!nonEmpty(parent) || !frontier.has(parent)) continue;
			const key = descendantKey(n, n.ledgerRow);
			if (!key || discovered.has(key)) continue;
			discovered.add(key);
			// A ledger row supersedes an index entry with the same session ID.
			if (n.ledgerRow) {
				const indexKey = descendantKey(n);
				discovered.add(indexKey);
				if (indexKey !== key) nodes.delete(indexKey);
			}
			nodes.set(key, {
				sessionId: nonEmpty(n.sessionId) ? n.sessionId : null,
				taskId: nonEmpty(n.taskId) ? n.taskId : null,
				parentSessionId: parent,
				title: n.title,
				outcome: n.outcome,
				startedMs: n.startedMs,
				endedMs: Number.isFinite(n.endedMs) ? n.endedMs : null,
				indexOnly: !n.ledgerRow,
				cwd: n.cwd,
				depth,
				ledgerRow: n.ledgerRow,
			});
			addLinks(next, n);
		}
		frontier = next;
	}
	return [...nodes.values()];
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
			subject: cleanValue({ sessionId: subject.sessionId, taskId: subject.taskId }),
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
		// A non-finite value (counters are added as supplied) is kept; JSON and the dashboard show it as "-".
		.map(([key, value]) => ({ key: clean(key, 120) ?? key, tokens: typeof value?.tokens === "number" ? value.tokens : 0, cost: typeof value?.cost === "number" ? value.cost : 0 }))
		.sort((a, b) => sortRank(b.tokens) - sortRank(a.tokens) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function ledgerUsageSessionId({ sessionId, taskId }) {
	// Live and backfill writers use the task ID as the ledger key if there is no child session ID.
	return nonEmpty(sessionId) && sessionId !== taskId ? sessionId : null;
}

const ambiguousUsageFallback = (row, ambiguous, ids = row) =>
	!ledgerUsageSessionId(ids) && (row.usageTaskIdAmbiguous === true || ambiguous?.has(ids.taskId));

export function ambiguousLedgerTaskIds(rows) {
	const seen = new Set();
	const ambiguous = new Set();
	for (const row of rows) {
		if (!isRecord(row) || !nonEmpty(row.taskId) || ledgerUsageSessionId(row)) continue;
		if (seen.has(row.taskId)) ambiguous.add(row.taskId);
		else seen.add(row.taskId);
	}
	return ambiguous;
}

export function usageEntryOf(usage, row, ambiguous) {
	const ids = row.ledgerIds ?? row;
	if (ambiguousUsageFallback(row, ambiguous, ids)) return null;
	return usageEntryFor(usage, ledgerUsageSessionId(ids), ids.taskId) ?? (usage.full === true ? FULL_USAGE : null);
}

export function usageTreeLink(usage, row, ambiguous) {
	const { parentSessionId } = row;
	const id = ledgerUsageSessionId(row) ?? usageEntryOf(usage, row, ambiguous)?.id;
	return id ? { id, parentSessionId } : { id: row.taskId, parentSessionId, unresolved: true };
}

/** Add older ledger links only below a supplied row, not as new history roots. */
export function* retainedTreeRows(paths, rows, { beforeMs, withLocation } = {}) {
	const parents = new Set();
	for (const row of rows ?? []) {
		if (nonEmpty(row?.sessionId)) parents.add(row.sessionId);
		yield row;
	}
	if (!parents.size) return;
	const children = new Map();
	for (const row of streamEnded(paths, { beforeMs, withLocation })) {
		const { sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId } = row;
		if (!nonEmpty(parentSessionId)) continue;
		if (!children.has(parentSessionId)) children.set(parentSessionId, []);
		children.get(parentSessionId).push({ sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId, [ENDED_LOCATION]: row[ENDED_LOCATION] });
	}
	// Set iteration visits ids added below, once each even for cyclic links.
	for (const parentId of parents) {
		for (const child of children.get(parentId) ?? []) {
			yield child;
			parents.add(child.sessionId);
		}
	}
}

const FULL_USAGE = Object.freeze({ state: "full" });

function joinSessionDecisions(row, descendants, investigations, decisions, bounded, jobsDir) {
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
	const taskSubjects = new Map();
	if (taskOnly.size) {
		const countSubject = ({ subject } = {}) => {
			if (!isRecord(subject) || !taskOnly.has(subject.taskId)) return;
			const identity = nonEmpty(subject.sessionId) ? `session:${subject.sessionId}` : `parent:${subject.parentSessionId ?? subject.rootSessionId ?? ""}`;
			trackOwner(taskSubjects, subject.taskId, identity);
		};
		// A competing owner can veto a task-only match, even if its row would not be retained.
		for (const entry of decisions()) if (isRecord(entry)) countSubject(entry);
		for (const record of investigations()) if (isRecord(record)) countSubject(record);
	}
	const subjectMatches = (subject) => isRecord(subject) && (sessionAllowed.has(subject.sessionId) ||
		childTasksByParent.get(subject.sessionId)?.has(subject.taskId) ||
		(typeof taskSubjects.get(subject.taskId) === "string") ||
		sessionAllowed.has(subject.parentSessionId) || sessionAllowed.has(subject.rootSessionId));

	// 1. investigations about the session or its descendants
	const selectedInvestigations = [];
	const fpSet = new Set();
	const analystModels = new Set();
	const pendingAnalystJobs = new Set();
	let analystModelsKnown = true;
	for (const record of investigations()) {
		if (!isRecord(record) || !subjectMatches(record.subject)) continue;
		if (nonEmpty(record.id)) fpSet.add(record.id);
		if (nonEmpty(record.model)) analystModels.add(record.model);
		if (bounded) {
			bounded.investigations.add({ ...investigationFacts(record), historyId: record.id });
		} else selectedInvestigations.push(record);
	}

	// 2. the fp set: selected investigations plus lifecycle rows whose subject matches
	for (const entry of decisions()) if (isRecord(entry) && (FINDING_EVENTS.has(entry.event) || entry.event === "investigation") && nonEmpty(entry.fp) && subjectMatches(entry.subject)) fpSet.add(entry.fp);

	// 3. decisions about the session; 4. decisions delivered to it or its descendants.
	// Scan again so an action written before the lifecycle row can still join by fp.
	const about = [];
	const delivered = [];
	const actionEntries = [];
	let pending;
	const addAction = (entry, deliveredOnly, acted) => {
		if (!bounded) actionEntries.push({ entry, deliveredOnly, acted });
		else {
			const action = actionRow(entry, null, true, acted);
			if (action) bounded.actions.add({ ...action, deliveredOnly });
		}
	};
	const histories = new Map(bounded?.investigations.rows.map(({ historyId }) => [historyId, { rows: [], chars: 2 }]));
	for (const entry of decisions()) {
		if (!isRecord(entry)) continue;
		const related = (nonEmpty(entry.fp) && fpSet.has(entry.fp)) || subjectMatches(entry.subject) || (nonEmpty(row.sessionId) && entry.sessionId === row.sessionId);
		const selected = related || sessionAllowed.has(entry.outcome?.sessionId);
		const acted = pending && sameExecution(pending.entry, entry) && selected ? pending.entry : undefined;
		if (pending && !acted) addAction(pending.entry, pending.deliveredOnly);
		pending = undefined;
		if (!selected) continue;
		if (related && !collectAnalystDecisionModels(analystModels, entry, jobsDir, pendingAnalystJobs)) analystModelsKnown = false;
		if (entry.event === "investigation" && nonEmpty(entry.fp) && nonEmpty(entry.acted?.key) && nonEmpty(entry.acted?.kind)) {
			pending = { entry, deliveredOnly: !related };
		} else addAction(entry, !related, acted);
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
	if (pending) addAction(pending.entry, pending.deliveredOnly);
	recoverPendingAnalystModels(analystModels, pendingAnalystJobs, jobsDir);
	const modelHistory = {
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
		const taskIds = new Set(nodes.map((node) => node.taskId).filter(nonEmpty));
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
	const { selectedInvestigations, fpSet, about, selected, actionEntries, analystModels, analystModelsKnown, pendingAnalystJobs } = inputs.decisionJoin ?? joinSessionDecisions(row, descendants, () => investigations, () => decisions);
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
	const descendants = inputs.descendants ?? collectDescendants(row, ledger, usage.values());
	const ambiguous = inputs.ambiguous ?? ambiguousLedgerTaskIds(ledger);
	const { health, infoFindings, configDecisions, analystModels, analystModelsKnown, pendingAnalystJobs, selectedFps } = recordHealth({ ...inputs, decisions, investigations, messages: messagesIn }, row, descendants);

	const entry = usageEntryOf(usage, row, ambiguous);
	const compact = compactUsage(entry);
	// Sum the ownership-checked descendants; a separate index-only fallback
	// could count a child whose ledger row deliberately did not resolve.
	let subtotal = compact?.total ?? 0;
	let counted = false;
	let treeTokensComplete = Number.isFinite(compact?.total);
	const seen = new Set(entry?.id ? [entry.id] : []);
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
			if (!branchBlocked && typeof total === "number" && !seen.has(childEntry.id)) {
				seen.add(childEntry.id);
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
	// Keep exact join keys off the display fields that also feed the reviewer bundle.
	session.ledgerIds = {
		sessionId: safeSubjectId(row.sessionId),
		taskId: safeSubjectId(row.taskId),
		parentSessionId: safeSubjectId(row.parentSessionId),
	};
	// Cached previews and audit preparation re-read the index from this session alone.
	if (!ledgerUsageSessionId(row) && ambiguous.has(row.taskId)) session.usageTaskIdAmbiguous = true;
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
		},
		health,
	};
}

const SCAN_CHUNK = 4 * 1024 * 1024;
const SCAN_LINE_MAX = 1024 * 1024;
const SCAN_NEWLINE = 0x0a;
const SCAN_MARKER = Buffer.from('"customType":"omo-health"', "utf8");

/**
 * Only lines naming the `omo-health` custom type are parsed; the rest of the
 * transcript is never decoded as content. The file is read in 4 MiB chunks so
 * a session file larger than the daemon heap (96 MiB) cannot exhaust it, and a
 * line over 1 MiB is dropped without being buffered past the limit (an
 * `omo-health` message line is small, so it is never one).
 */
export function scanOmoHealthMessages(file) {
	return [...streamOmoHealthMessages(file)];
}

function* streamOmoHealthMessages(file, bounded = false) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return;
	}
	const consume = (bytes) => {
		if (!bytes.length || !bytes.includes(SCAN_MARKER)) return;
		let entry;
		try {
			entry = JSON.parse(bytes.toString("utf8"));
		} catch {
			return;
		}
		if (!isRecord(entry) || (entry.type !== "custom_message" && entry.type !== "custom") || entry.customType !== "omo-health") return;
		const ms = msOf(entry.timestamp);
		const message = { ms: Number.isFinite(ms) ? ms : null, kind: auditMessageKind(entry.details?.kind) };
		if (bounded) return message;
		const text = typeof entry.content === "string" ? entry.content : isRecord(entry.content) ? JSON.stringify(entry.content) : "";
		return { ...message, text: cleanDetail(text) };
	};
	try {
		const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
		let carry = null;
		let overlong = false;
		for (;;) {
			const n = fs.readSync(fd, chunk, 0, SCAN_CHUNK, null);
			if (n === 0) break;
			const view = chunk.subarray(0, n);
			let pos = 0;
			while (pos < n) {
				const newline = view.indexOf(SCAN_NEWLINE, pos);
				const piece = view.subarray(pos, newline === -1 ? n : newline);
				if (newline === -1) {
					if (!overlong) {
						if ((carry?.length ?? 0) + piece.length > SCAN_LINE_MAX) {
							overlong = true;
							carry = null;
						} else {
							carry = carry ? Buffer.concat([carry, piece]) : Buffer.from(piece);
						}
					}
					break;
				}
				if (overlong) {
					overlong = false;
					carry = null;
				} else if ((carry?.length ?? 0) + piece.length > SCAN_LINE_MAX) {
					carry = null;
				} else {
					const message = consume(carry ? Buffer.concat([carry, piece]) : piece);
					if (message) yield message;
					carry = null;
				}
				pos = newline + 1;
			}
		}
		if (!overlong && carry) {
			const message = consume(carry);
			if (message) yield message;
		}
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

function findRecordFiles(paths, nodes, ancestors, locator, usage, ambiguous) {
	const wanted = new Set(nodes.filter((node) => !nonEmpty(node.taskId)).map((node) => node.sessionId));
	const main = new Map();
	if (!locator && wanted.size) {
		for (const slug of dirNames(paths.sessionsDir)) {
			const dir = path.join(paths.sessionsDir, slug);
			for (const name of dirNames(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const sid = idFromFileName(name);
				if (!wanted.has(sid)) continue;
				const file = path.join(dir, name);
				const prior = main.get(sid);
				if ((!prior || file > prior) && statSafe(file)?.isFile()) main.set(sid, file);
			}
		}
	}
	const childFile = ({ taskId, sessionId, cwds }) => {
		for (const cwd of cwds) {
			const dir = path.join(senpiTaskStoreDir(cwd, paths.agentDir), "children", taskId, "sessions", taskId);
			let found;
			const exact = sessionId && sessionId !== taskId;
			for (const name of dirNames(dir)) {
				if (!name.endsWith(".jsonl") || (exact && !name.endsWith(`_${sessionId}.jsonl`))) continue;
				if (found && !exact) return undefined;
				if (!found || name < found) found = name;
			}
			if (found) return path.join(dir, found);
		}
	};
	return nodes.map((node) => {
		const { sessionId, taskId } = node;
		if (!nonEmpty(taskId)) return { sessionId, file: locator ? locator.mainFile(sessionId) : main.get(sessionId) };
		// The tracker may have verified the transcript through a live ancestor whose cwd is absent from the ledger.
		const entry = usageEntryOf(usage, node, ambiguous);
		const file = entry?.readError !== true && fresh(entry) ? entry.file
			: (locator?.childFile ?? childFile)({ taskId, sessionId, cwds: cwdsOf(node, ancestors) });
		return { sessionId, file };
	}).filter(({ file }) => file);
}

function cwdsOf(node, ancestors) {
	const out = [];
	let current = node;
	const seen = new Set();
	for (let depth = 0; depth < DEPTH_MAX && isRecord(current); depth += 1) {
		if (nonEmpty(current.cwd) && !out.includes(current.cwd)) out.push(current.cwd);
		const parentId = current.parentSessionId;
		if (!nonEmpty(parentId) || seen.has(parentId)) break;
		seen.add(parentId);
		current = ancestors.get(parentId);
	}
	return out;
}

const later = (a, b) => !b || Number(a.endedMs) > Number(b.endedMs);

function ledgerLookup(rows, ids, selector) {
	const exact = new Map();
	const aliases = new Map();
	for (const row of rows()) {
		if (ids.has(row.sessionId) && (selector === undefined || endedSelector(row) === selector) && later(row, exact.get(row.sessionId))) exact.set(row.sessionId, row);
		if (selector !== undefined || !ids.has(row.taskId)) continue;
		const prior = aliases.get(row.taskId);
		if (prior === null) continue;
		if (prior && prior.sessionId !== row.sessionId) aliases.set(row.taskId, null);
		else if (later(row, prior)) aliases.set(row.taskId, row);
	}
	return new Map([...ids].map((id) => [id, exact.get(id) ?? aliases.get(id)]));
}

function recordDescendants(subject, rows, usage) {
	const seen = new Set([descendantKey(subject, subject), descendantKey(subject)]);
	const nodes = new Map();
	let frontier = [subject];
	for (let depth = 1; depth <= DEPTH_MAX && frontier.length; depth += 1) {
		const owners = new Map();
		const aliases = new Map(frontier.filter((node) => nonEmpty(node.taskId)).map((node) => [node.taskId, node.startedMs]));
		const collisions = new Set();
		const ids = new Map(frontier.map((node) => [node.sessionId, node.startedMs]));
		// Buffer only the newest row per candidate, separating direct and alias
		// matches until the scan can rule out competing alias owners.
		const direct = new Map();
		const indirect = new Map();
		const consider = (node, fromLedger) => {
			if (aliases.has(node.sessionId)) collisions.add(node.sessionId);
			if (aliases.has(node.taskId)) trackOwner(owners, node.taskId, node.sessionId ?? "");
			const parent = node.parentSessionId;
			const identity = descendantKey(node, fromLedger ? node : undefined);
			if (!nonEmpty(parent) || !node.sessionId || seen.has(identity)) return;
			const map = ids.has(parent) ? direct : aliases.has(parent) ? indirect : null;
			if (!map) return;
			const key = map === indirect ? parent : null;
			if (!map.has(key)) map.set(key, new Map());
			const matches = map.get(key);
			const prior = matches.get(identity);
			if (!prior || (fromLedger && later(node, prior.node))) {
				const { sessionId, taskId, parentSessionId, title, outcome, startedMs, endedMs, cwd } = node;
				matches.set(identity, { node: { sessionId, taskId, parentSessionId, title, outcome, startedMs, endedMs, cwd }, fromLedger });
			}
		};
		consider(subject, true);
		for (const row of rows()) consider(row, true);
		for (const { id, taskId, parentSessionId, startedMs, checkedMs } of usage.values()) {
			consider({ sessionId: id, taskId, parentSessionId, startedMs, endedMs: checkedMs }, false);
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
		// Index entries mirror sessions, not scoped ledger rows. Keep them only
		// when no discovered ledger row represents the same session.
		for (const { node, fromLedger } of matches.values()) {
			if (!fromLedger) continue;
			const indexKey = descendantKey(node);
			seen.add(indexKey);
			nodes.delete(indexKey);
		}
		for (const [identity, { node, fromLedger }] of matches) {
			if (!fromLedger && seen.has(identity)) continue;
			const { sessionId, taskId, parentSessionId, title, outcome, endedMs, cwd } = node;
			let { startedMs } = node;
			// An index-only child with no known start inherits its parent's start
			// for machine overlap: it spawns while the parent is active, so the union is unchanged.
			if (!fromLedger && !Number.isFinite(msOf(startedMs))) {
				startedMs = ids.has(parentSessionId) ? ids.get(parentSessionId) : aliases.get(parentSessionId);
			}
			seen.add(identity);
			const descendant = { sessionId, taskId: taskId ?? null, parentSessionId, title: title ?? null, outcome: outcome ?? null, startedMs, endedMs: Number.isFinite(msOf(endedMs)) ? msOf(endedMs) : null, cwd, depth, indexOnly: !fromLedger };
			frontier.push(descendant);
			nodes.set(identity, descendant);
		}
	}
	return [...nodes.values()];
}

function recordLedger(visibleRows, rows, id, selector, usage, descendantScanMax) {
	const subject = ledgerLookup(visibleRows, new Set([id]), selector).get(id);
	if (!subject) return null;
	const descendants = recordDescendants(subject, rows, usage);
	const newest = [...descendants].sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));
	const scanned = Number.isFinite(descendantScanMax) ? newest.slice(0, descendantScanMax) : newest;
	const descendantsSkipped = newest.length - scanned.length;
	const ancestors = new Map();
	let parents = new Set([subject, ...scanned].filter((node) => nonEmpty(node.taskId)).map((node) => node.parentSessionId).filter(nonEmpty));
	const visited = new Set();
	for (let depth = 1; depth < DEPTH_MAX && parents.size; depth += 1) {
		const found = ledgerLookup(rows, parents);
		for (const parent of parents) visited.add(parent);
		parents = new Set();
		for (const [id, node] of found) {
			if (!node) continue;
			ancestors.set(id, node);
			if (nonEmpty(node.parentSessionId) && !visited.has(node.parentSessionId)) parents.add(node.parentSessionId);
		}
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
export function loadSessionRecord({ paths, id, row: selector, now = Date.now(), messageScanMaxBytes = Infinity, messageScanTotalBytes = Infinity, descendantScanMax = Infinity, scanMessages, auditRetention = false, locator, index } = {}) {
	if (!nonEmpty(id)) return { found: false, id };
	const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
	const joined = recordLedger(
		() => streamEnded(paths, { sinceMs: now - 30 * DAY_MS }),
		() => streamEnded(paths), id, selector, usage, descendantScanMax,
	);
	if (!joined) return { found: false, id };
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
	const decisionJoin = joinSessionDecisions(row, descendants, () => streamInvestigations(paths), () => streamDecisions(paths, sinceMs), retained, paths.health.jobsDir);
	const files = findRecordFiles(paths, [row, ...scanned], ancestors, locator, usage, ambiguous);

	const messages = [];
	const skipped = [];
	const transcriptFiles = auditRetention ? null : new Set();
	let scannedBytes = 0;
	for (const { sessionId, file } of files) {
		const stat = statSafe(file);
		if (!stat?.isFile()) continue;
		if (stat.size > messageScanMaxBytes || scannedBytes + stat.size > messageScanTotalBytes) {
			skipped.push(file);
			continue;
		}
		scannedBytes += stat.size;
		transcriptFiles?.add(file);
		for (const message of (scanMessages ? scanMessages(file) : streamOmoHealthMessages(file, auditRetention)) ?? []) {
			if (!retained) messages.push({ ...message, recipient: sessionId });
			else if (isRecord(message)) retained.messages.add({ ms: Number.isFinite(message.ms) ? message.ms : null, kind: auditMessageKind(message.kind) });
		}
	}

	const auditHealth = retained && auditRecordHealth(retained, decisionHistory.infoFindings);
	const record = buildSessionRecord({
		id, row, descendants, ambiguous, usage, decisionJoin, decisionHistory, auditHealth, messages,
		truncated: { messagesSkipped: skipped, descendantsSkipped },
	});
	return auditRetention ? { ...record, auditSubjectIds: decisionJoin.auditSubjectIds } : { ...record, transcriptFiles: [...transcriptFiles] };
}
