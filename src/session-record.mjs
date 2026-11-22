import fs from "node:fs";
import path from "node:path";
import { idFromFileName } from "./collect/sessions.mjs";
import { senpiTaskStoreDir } from "./collect/tasks.mjs";
import { streamDecisions } from "./decisions.mjs";
import { streamInvestigations } from "./investigations.mjs";
import { endedSelector, streamEnded } from "./session-ledger.mjs";
import { compactUsage, readUsageIndex, treeTotals, usageEntryFor } from "./usage-index.mjs";
import { reasonCode } from "./audit-codes.mjs";
import { AUDIT_CHECK_MAX, AUDIT_DETECTOR_ID, AUDIT_LIST_CAPS, BUNDLE_MAX_CHARS, auditEvidence, auditHistoryRow, auditMessageKind } from "./judge/audit.mjs";
import { statSafe } from "./util/fsx.mjs";
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
 * running after its parent ends keeps its actions and verdicts. Only the
 * machine-wide overlap check uses the parent's [startedMs, endedMs] window.
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
	resolved: "finding",
	investigation: Object.freeze({ "result:hold-toast": "action", acted: "action", default: "investigation" }),
	"notice-withdrawn": "action",
	"park-transition": Object.freeze({ "to:launched": "action", "why:launch-failed": "action", default: "bookkeeping" }),
	"park-gated": "action",
	"baseline-deviation": "bookkeeping",
	"report-expired": "bookkeeping",
	config: "bookkeeping",
	coverage: "bookkeeping",
});
const FINDING_EVENTS = new Set(Object.keys(DECISION_EVENT_SHAPES).filter((event) => DECISION_EVENT_SHAPES[event] === "finding"));

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** `redact` plus the GitHub token shape it does not mask yet. */
const scrub = (value) => redact(String(value ?? "")).replace(/ghp_[A-Za-z0-9]{8,}/g, "ghp_[REDACTED]");
const clean = (value, max = LINE_MAX) => (typeof value === "string" && value ? truncate(scrub(value), max) : null);
const msOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : Number.NaN);
const timeOf = (entry) => msOf(entry?.ts);

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

/**
 * Descendant sessions and tasks, recursively over `parentSessionId` in the
 * ledger rows and the usage index (depth <= 8). A parent may be named by its
 * session id or its task id, so unambiguous parent links join the frontier.
 */
function collectDescendants(row, ledger, usageEntries) {
	const nodes = new Map();
	const all = [];
	for (const r of ledger) if (isRecord(r)) all.push({ sessionId: r.sessionId ?? null, taskId: r.taskId ?? null, parentSessionId: r.parentSessionId ?? null, title: r.title ?? null, outcome: r.outcome ?? null, endedMs: msOf(r.endedMs), cwd: r.cwd ?? null, ledgerRow: r });
	for (const e of usageEntries) if (nonEmpty(e?.taskId) || nonEmpty(e?.parentSessionId)) all.push({ sessionId: e.id ?? null, taskId: e.taskId ?? null, parentSessionId: e.parentSessionId, title: null, outcome: null, endedMs: msOf(e.checkedMs), cwd: null });
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
	const keyOf = (link) => nonEmpty(link.sessionId) ? link.sessionId : nonEmpty(link.taskId) ? `task:${link.taskId}` : null;
	const discovered = new Set([keyOf(row)]);
	let frontier = new Set();
	addLinks(frontier, row);
	for (let depth = 1; depth <= DEPTH_MAX && frontier.size; depth += 1) {
		const next = new Set();
		for (const n of all) {
			const parent = n.parentSessionId;
			if (!nonEmpty(parent) || !frontier.has(parent)) continue;
			const key = keyOf(n);
			if (!key || discovered.has(key)) continue;
			discovered.add(key);
			nodes.set(key, {
				sessionId: nonEmpty(n.sessionId) ? n.sessionId : null,
				taskId: nonEmpty(n.taskId) ? n.taskId : null,
				parentSessionId: parent,
				title: n.title,
				outcome: n.outcome,
				endedMs: Number.isFinite(n.endedMs) ? n.endedMs : null,
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

/**
 * Machine-wide incidents (no subject session or task) whose active interval
 * overlaps the session window, and the latest info coverage marker before it.
 * Consume lifecycle rows oldest first and keep only the open intervals and
 * the openers of closed intervals that overlap the session.
 */
function scanDecisionHistory(decisions, row, retained) {
	const startedMs = msOf(row.startedMs);
	const endedMs = msOf(row.endedMs);
	const startMs = Number.isFinite(startedMs) ? startedMs : -Infinity;
	const endMs = Number.isFinite(endedMs) ? endedMs : Number.isFinite(startedMs) ? startedMs : Infinity;
	const open = new Map();
	const matched = retained ? null : [];
	const keep = (finding) => retained ? retained.add(finding) : matched.push(finding);
	const coverageEnd = Number.isFinite(startedMs) ? startedMs : Number.isFinite(endedMs) ? endedMs : Infinity;
	let coverageMs = -Infinity;
	for (const entry of decisions) {
		if (!isRecord(entry)) continue;
		const { fp, event, subject } = entry;
		const ts = timeOf(entry);
		if (!Number.isFinite(ts)) continue;
		if (event === "coverage" && entry.infoFindings === true && ts < coverageEnd && ts > coverageMs) coverageMs = ts;
		if (!FINDING_EVENTS.has(event) || !nonEmpty(fp)) continue;
		if (event === "resolved") {
			const opened = open.get(fp);
			if (opened && ts >= startMs) keep(opened);
			open.delete(fp);
		} else if (ts <= endMs && !open.has(fp) && !nonEmpty(subject?.sessionId) && !nonEmpty(subject?.taskId)) {
			open.set(fp, machineRow(entry, fp, ts, Boolean(retained)));
		}
	}
	for (const finding of open.values()) keep(finding);
	return { machine: matched, infoFindings: Number.isFinite(coverageMs) };
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

function actionRow(entry, subjectByFp, bounded = false) {
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
	} else if (!bounded) {
		detail = actionDetail(isRecord(entry.outcome) ? entry.outcome : {}, entry.rule) ?? "";
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
	const sessionId = ledgerUsageSessionId(row);
	if (!sessionId && (row.usageTaskIdAmbiguous === true || ambiguous?.has(row.taskId))) return null;
	return usageEntryFor(usage, sessionId, row.taskId) ?? (usage.full === true ? FULL_USAGE : null);
}

const FULL_USAGE = Object.freeze({ state: "full" });

function joinSessionDecisions(row, descendants, investigations, decisions, bounded) {
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
	const addModel = (model) => { if (nonEmpty(model)) analystModels.add(model); };
	for (const record of investigations()) {
		if (!isRecord(record) || !subjectMatches(record.subject)) continue;
		if (nonEmpty(record.id)) fpSet.add(record.id);
		if (bounded) {
			addModel(record.model);
			bounded.investigations.add({ ...investigationFacts(record), historyId: record.id });
		} else selectedInvestigations.push(record);
	}

	// 2. the fp set: selected investigations plus lifecycle rows whose subject matches
	for (const entry of decisions()) if (isRecord(entry) && FINDING_EVENTS.has(entry.event) && nonEmpty(entry.fp) && subjectMatches(entry.subject)) fpSet.add(entry.fp);

	// 3. decisions about the session; 4. decisions delivered to it or its descendants.
	// Scan again so an action written before the lifecycle row can still join by fp.
	const about = [];
	const delivered = [];
	const histories = new Map(bounded?.investigations.rows.map(({ historyId }) => [historyId, { rows: [], chars: 2 }]));
	for (const entry of decisions()) {
		if (!isRecord(entry)) continue;
		const related = (nonEmpty(entry.fp) && fpSet.has(entry.fp)) || subjectMatches(entry.subject) || (nonEmpty(row.sessionId) && entry.sessionId === row.sessionId);
		if (!related && !sessionAllowed.has(entry.outcome?.sessionId)) continue;
		if (!bounded) {
			(related ? about : delivered).push(entry);
			continue;
		}
		if (FINDING_EVENTS.has(entry.event)) bounded.findings.add({ ...findingRow(entry, { bounded: true }), deliveredOnly: !related });
		const action = actionRow(entry, null, true);
		if (action) bounded.actions.add({ ...action, deliveredOnly: !related });
		if (related && entry.event === "investigation") {
			if (fpSet.has(entry.fp)) addModel(entry.model);
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
	if (bounded) {
		for (const investigation of bounded.investigations.rows) {
			const { rows } = histories.get(investigation.historyId);
			delete investigation.historyId;
			if (rows === null) investigation.verdictHistoryTooLarge = true;
			else investigation.verdictHistory = rows.sort(byVerdictTime);
		}
		const taskIds = new Set(nodes.map((node) => node.taskId).filter(nonEmpty));
		return {
			analystModels: [...analystModels], selectedFps: [...fpSet],
			auditSubjectIds: { sessionIds: sessionAllowed, taskIds, childTasksByParent },
		};
	}
	return { selectedInvestigations, fpSet, about, selected: [...new Set([...about, ...delivered])] };
}

function recordHealth(inputs, row, descendants) {
	if (inputs.auditHealth) return { ...inputs.auditHealth, ...inputs.decisionJoin };
	const { decisions, investigations, messages: messagesIn } = inputs;
	const { selectedInvestigations, fpSet, about, selected } = inputs.decisionJoin ?? joinSessionDecisions(row, descendants, () => investigations, () => decisions);
	const analystModels = new Set();
	const addModel = (model) => { if (nonEmpty(model)) analystModels.add(model); };
	for (const record of selectedInvestigations) addModel(record.model);
	for (const entry of about) {
		if (entry.event === "investigation" && fpSet.has(entry.fp)) addModel(entry.model);
	}
	const findings = selected.filter((entry) => FINDING_EVENTS.has(entry.event)).map((entry) => findingRow(entry));
	const { machine, infoFindings } = inputs.decisionHistory ?? scanDecisionHistory(decisions.filter((entry) => Number.isFinite(timeOf(entry))).sort((a, b) => timeOf(a) - timeOf(b)), row);
	const allFindings = [...findings, ...machine].sort(byNewest);
	const subjectByFp = new Map(selectedInvestigations.map(({ id, subject }) => [id, subject]));
	for (const entry of about) {
		if (FINDING_EVENTS.has(entry.event) && nonEmpty(entry.fp) && isRecord(entry.subject) && !subjectByFp.has(entry.fp)) subjectByFp.set(entry.fp, entry.subject);
	}
	const actions = selected.map((entry) => actionRow(entry, subjectByFp)).filter(Boolean).sort(byNewest);
	const investigationRows = selectedInvestigations.map((record) => investigationRow(record, about)).sort(byInvestigationTime);
	const messages = messagesIn.filter(isRecord).map((message) => ({
		ms: Number.isFinite(message.ms) ? message.ms : null, kind: auditMessageKind(message.kind), recipient: clean(message.recipient, 200), text: cleanDetail(message.text),
	})).sort(byMessageTime);
	return {
		infoFindings,
		analystModels: [...analystModels],
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
	const { health, infoFindings, analystModels, selectedFps } = recordHealth({ ...inputs, decisions, investigations, messages: messagesIn }, row, descendants);

	const entry = usageEntryOf(usage, row, ambiguous);
	const compact = compactUsage(entry);
	const trees = treeTotals(usage.values());
	const tokens = entry
		? {
				...(compact ?? { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, costUnknown: false, turns: null }),
				models: modelRows(entry.published),
				state: typeof entry.state === "string" ? entry.state : null,
				complete: entry.complete === true,
				treeTotal: trees.get(entry.id) ?? null,
				gone: entry.gone === true,
			}
		: null;

	const children = descendants
		.map((node) => {
			const childEntry = usageEntryOf(usage, node, ambiguous);
			const childCompact = compactUsage(childEntry);
			return {
				sessionId: node.sessionId,
				taskId: node.taskId,
				title: clean(node.title, TITLE_MAX),
				outcome: clean(node.outcome, 40),
				endedMs: node.endedMs,
				depth: node.depth,
				tokens: childCompact,
				tokensState: childCompact ? "ok" : ["missing", "full"].includes(childEntry?.state) ? childEntry.state : "pending",
			};
		})
		.sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));

	const session = cleanValue(row);
	// Cached previews and audit preparation re-read the index from this session alone.
	if (!ledgerUsageSessionId(row) && ambiguous.has(row.taskId)) session.usageTaskIdAmbiguous = true;
	session.durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;

	return {
		found: true,
		id: row.sessionId,
		session,
		tokens,
		children,
		coverage: { infoFindings },
		analystModels,
		selectedFps,
		truncated: { messagesSkipped: Array.isArray(truncated.messagesSkipped) ? truncated.messagesSkipped : [] },
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

function findRecordFiles(paths, nodes, ancestors, locator) {
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
	return nodes.map(({ sessionId, taskId, ...node }) => ({
		sessionId,
		file: nonEmpty(taskId)
			? (locator?.childFile ?? childFile)({ taskId, sessionId, cwds: cwdsOf(node, ancestors) })
			: locator ? locator.mainFile(sessionId) : main.get(sessionId),
	})).filter(({ file }) => file);
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
	const seen = new Set([subject.sessionId]);
	const nodes = [];
	let frontier = [subject];
	for (let depth = 1; depth <= DEPTH_MAX && frontier.length; depth += 1) {
		const owners = new Map();
		const aliases = new Set(frontier.map((node) => node.taskId).filter(nonEmpty));
		const collisions = new Set();
		const ids = new Set(frontier.map((node) => node.sessionId));
		// Buffer only the newest row per candidate, separating direct and alias
		// matches until the scan can rule out competing alias owners.
		const direct = new Map();
		const indirect = new Map();
		const consider = (node, fromLedger) => {
			if (aliases.has(node.sessionId)) collisions.add(node.sessionId);
			if (aliases.has(node.taskId)) trackOwner(owners, node.taskId, node.sessionId ?? "");
			const parent = node.parentSessionId;
			if (!nonEmpty(parent) || !node.sessionId || seen.has(node.sessionId)) return;
			const map = ids.has(parent) ? direct : aliases.has(parent) ? indirect : null;
			if (!map) return;
			const key = map === indirect ? parent : null;
			if (!map.has(key)) map.set(key, new Map());
			const matches = map.get(key);
			const prior = matches.get(node.sessionId);
			if (!prior || (fromLedger && (!prior.fromLedger || later(node, prior.node)))) {
				const { sessionId, taskId, parentSessionId, title, outcome, endedMs } = node;
				matches.set(sessionId, { node: { sessionId, taskId, parentSessionId, title, outcome, endedMs }, fromLedger });
			}
		};
		consider(subject, true);
		for (const row of rows()) consider(row, true);
		for (const { id, taskId, parentSessionId, checkedMs } of usage.values()) {
			consider({ sessionId: id, taskId, parentSessionId, endedMs: checkedMs }, false);
		}
		const matches = direct.get(null) ?? new Map();
		for (const [alias, candidates] of indirect) {
			if (collisions.has(alias) || owners.get(alias) === null) continue;
			for (const [id, candidate] of candidates) {
				const prior = matches.get(id);
				if (!prior || (candidate.fromLedger && (!prior.fromLedger || later(candidate.node, prior.node)))) matches.set(id, candidate);
			}
		}
		frontier = [];
		for (const { node } of matches.values()) {
			const { sessionId, taskId, parentSessionId, title, outcome, endedMs } = node;
			seen.add(sessionId);
			frontier.push({ sessionId, taskId: taskId ?? null, parentSessionId, title: title ?? null, outcome: outcome ?? null, endedMs: Number.isFinite(msOf(endedMs)) ? msOf(endedMs) : null, depth });
		}
		nodes.push(...frontier);
	}
	return nodes;
}

function recordLedger(rows, id, selector, usage, descendantScanMax) {
	const subject = ledgerLookup(rows, new Set([id]), selector).get(id);
	if (!subject) return null;
	const descendants = recordDescendants(subject, rows, usage);
	const newest = [...descendants].sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));
	const scanned = Number.isFinite(descendantScanMax) ? newest.slice(0, descendantScanMax) : newest;
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
	const locations = new Map(scanned.filter((node) => nonEmpty(node.taskId)).map((node) => [node.sessionId, node]));
	const seen = new Set();
	const ambiguous = new Set();
	if (fallback.size || locations.size) {
		for (const rec of rows()) {
			const node = locations.get(rec.sessionId);
			if (node && node.endedMs === msOf(rec.endedMs) && node.taskId === rec.taskId && node.parentSessionId === rec.parentSessionId) {
				node.cwd = rec.cwd;
				locations.delete(rec.sessionId);
			}
			if (!fallback.has(rec.taskId) || ledgerUsageSessionId(rec)) continue;
			if (seen.has(rec.taskId)) ambiguous.add(rec.taskId);
			else seen.add(rec.taskId);
		}
	}
	return { row: subject, descendants, ancestors, scanned, ambiguous };
}

/**
 * Read everything the record needs and join it. A file that exceeds the
 * per-file limit or the remaining total message scan budget is skipped and
 * listed in `truncated.messagesSkipped`. `auditRetention` keeps only the
 * daemon's audit samples; the dashboard defaults to no retention limit.
 */
export function loadSessionRecord({ paths, id, row: selector, now = Date.now(), messageScanMaxBytes = Infinity, messageScanTotalBytes = Infinity, descendantScanMax = Infinity, scanMessages, auditRetention = false, locator, index } = {}) {
	if (!nonEmpty(id)) return { found: false, id };
	const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
	const joined = recordLedger(() => streamEnded(paths, { sinceMs: now - 30 * DAY_MS }), id, selector, usage, descendantScanMax);
	if (!joined) return { found: false, id };
	const { row, descendants, ancestors, scanned, ambiguous } = joined;
	const startedMs = msOf(row.startedMs);
	const sinceMs = (Number.isFinite(startedMs) ? startedMs : now) - 30 * DAY_MS;
	const retained = auditRetention ? {
		findings: auditFindings(AUDIT_LIST_CAPS.findings, byDecisionTime),
		machine: auditFindings(AUDIT_LIST_CAPS.machineFindings, byNewest),
		actions: newest(AUDIT_LIST_CAPS.actions, byDecisionTime),
		investigations: newest(AUDIT_LIST_CAPS.investigations, byInvestigationTime),
		messages: newest(AUDIT_LIST_CAPS.messages, byMessageTime),
	} : null;
	const decisionHistory = scanDecisionHistory(streamDecisions(paths), row, retained?.machine);
	const decisionJoin = joinSessionDecisions(row, descendants, () => streamInvestigations(paths), () => streamDecisions(paths, sinceMs), retained);
	const files = findRecordFiles(paths, [row, ...scanned], ancestors, locator);

	const messages = [];
	const skipped = [];
	let scannedBytes = 0;
	for (const { sessionId, file } of files) {
		const stat = statSafe(file);
		if (!stat?.isFile()) continue;
		if (stat.size > messageScanMaxBytes || scannedBytes + stat.size > messageScanTotalBytes) {
			skipped.push(file);
			continue;
		}
		scannedBytes += stat.size;
		for (const message of (scanMessages ? scanMessages(file) : streamOmoHealthMessages(file, auditRetention)) ?? []) {
			if (!retained) messages.push({ ...message, recipient: sessionId });
			else if (isRecord(message)) retained.messages.add({ ms: Number.isFinite(message.ms) ? message.ms : null, kind: auditMessageKind(message.kind) });
		}
	}

	const auditHealth = retained && auditRecordHealth(retained, decisionHistory.infoFindings);
	const record = buildSessionRecord({ id, row, descendants, ambiguous, usage, decisionJoin, decisionHistory, auditHealth, messages, truncated: { messagesSkipped: skipped } });
	return auditRetention ? { ...record, auditSubjectIds: decisionJoin.auditSubjectIds } : record;
}
