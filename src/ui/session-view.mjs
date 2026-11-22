import { displayLedgerId } from "../session-record.mjs";
import { actionLabel, analystVerdictLabel, auditJudgmentLabel, auditOverallLabel, auditReasonLabel, auditStatusLabel, auditTokenLabel, causeLabel, findingLabel, outcomeLabel, resultLabel, severityLabel, terminalLabel } from "./labels.mjs";
import { investigationRow } from "./model.mjs";

/**
 * The dashboard's session detail (plan todo 8): the stored record from
 * `src/session-record.mjs` plus the Korean labels the page renders. Pure: every
 * call takes a record and only derives strings. The dashboard calls this
 * after the detail worker projects the cached historical record into a page.
 */

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isRecord) : []);
const overflows = (value) => typeof value === "number" && !Number.isFinite(value);
export const SESSION_LISTS = Object.freeze(["children", "findings", "actions", "investigations", "messages"]);
const SESSION_PAGE = 50;

function sessionItems(record, name) {
	return list(name === "children" ? record.children : record.health?.[name]);
}

/** Worker-side projection. Totals and offsets count the same valid items as the view. */
export function sessionRecordPage(record, name, offset) {
	if (name !== null) {
		const items = sessionItems(record, name);
		return { list: name, offset, total: items.length, items: items.slice(offset, offset + SESSION_PAGE) };
	}
	// Internal history (e.g. selected finding IDs and analyst model provenance)
	// stays in the worker, not in the dashboard's first page.
	const { found, id, session, tokens, coverage, health } = record;
	const { pendingAnalystJobs, ledgerIds, ...sessionFields } = isRecord(session) ? session : {};
	const pages = Object.fromEntries(SESSION_LISTS.map((key) => [key, sessionRecordPage(record, key, 0)]));
	return {
		found, id, session: session ? sessionFields : session, tokens, coverage,
		...(record.truncated?.unattributedHealth ? { truncated: { unattributedHealth: record.truncated.unattributedHealth } } : {}),
		children: pages.children.items,
		health: { counts: health?.counts, findings: pages.findings.items, actions: pages.actions.items, investigations: pages.investigations.items, messages: pages.messages.items },
		counts: Object.fromEntries(SESSION_LISTS.map((key) => [key, pages[key].total])),
	};
}

function labelledSession(session) {
	if (!isRecord(session)) return null;
	const terminal = isRecord(session.terminal) ? session.terminal : null;
	const { ledgerIds, ...display } = session;
	return {
		...display,
		outcomeKo: outcomeLabel(session.outcome),
		terminalLabel: terminal ? terminalLabel(terminal.kind) : null,
	};
}

function labelledFinding(finding) {
	const titleKo = typeof finding.titleKo === "string" && finding.titleKo ? finding.titleKo : findingLabel(finding.detector, finding.kind);
	return { ...finding, severityKo: severityLabel(finding.severity), titleKo };
}

function labelledAction(action) {
	return { ...action, actionKo: actionLabel(action.kind), resultKo: resultLabel(action.result) };
}

/** The phrase for one analyst answer; a failed verdict keeps the dash, as the investigation list shows it. */
function labelledVerdictHistory(history) {
	return list(history).map((entry) => ({ ...entry, verdictKo: analystVerdictLabel(entry), causeKo: causeLabel(entry.cause) }));
}

function labelledInvestigation(investigation) {
	const row = investigationRow(investigation);
	const verdict = row.verdict;
	const last = list(investigation.actions).at(-1);
	// The shared list row makes previews. The detail API sends the local text unchanged.
	return {
		...row,
		evidence: investigation.evidence ?? [],
		signals: investigation.signals ?? [],
		verdict: verdict ? {
			...verdict,
			diagnosis: investigation.verdict.diagnosis ?? null,
			mechanism: investigation.verdict.mechanism ?? null,
			avoid: investigation.verdict.avoid ?? null,
			advice: investigation.verdict.advice ?? null,
			reason: investigation.verdict.reason ?? null,
			evidence: investigation.verdict.evidence ?? [],
		} : null,
		action: last && row.action ? {
			...row.action,
			detail: last.detail ?? row.action.detail,
			advice: last.advice ?? null,
		} : row.action,
		verdictHistory: labelledVerdictHistory(investigation.verdictHistory),
	};
}

function labelledChild(child) {
	const overflow = overflows(child.tokens?.total);
	return {
		...child,
		sessionId: displayLedgerId(child.sessionId),
		taskId: displayLedgerId(child.taskId),
		parentSessionId: displayLedgerId(child.parentSessionId),
		...(overflow ? { tokens: { ...child.tokens, total: null }, tokensState: "overflow" } : {}),
		outcomeKo: outcomeLabel(child.outcome),
	};
}

const ITEM_LABELS = Object.freeze({
	children: labelledChild,
	findings: labelledFinding,
	actions: labelledAction,
	investigations: labelledInvestigation,
	messages: (item) => item,
});

export function buildSessionListView(page) {
	return { ...page, items: page.items.map(ITEM_LABELS[page.list]) };
}

function detailTokens(tokens) {
	if (!tokens) return tokens;
	const { treeTotal } = tokens;
	return {
		...tokens,
		...(overflows(tokens.total) ? { total: null, tokensState: "overflow" } : {}),
		...(overflows(treeTotal) ? { treeTotal: null, treeTokensState: "overflow" } : {}),
	};
}

function labelledAuditResult(result) {
	if (!isRecord(result)) return result ?? null;
	const tokens = isRecord(result.tokens) ? result.tokens : null;
	return {
		...result,
		overallKo: auditOverallLabel(result.overall),
		tokens: tokens ? { ...tokens, judgmentKo: auditTokenLabel(tokens.judgment) } : tokens,
		checks: list(result.checks).map((check) => ({ ...check, judgmentKo: auditJudgmentLabel(check.judgment) })),
	};
}

/** Todo 13's audit block: the raw state plus Korean labels; the cli supplies `planned`, `blocked` and friends. */
function labelledAudit(audit) {
	if (!isRecord(audit)) return audit ?? null;
	const state = isRecord(audit.state) ? audit.state : null;
	if (!state) return audit;
	const status = state.status === "requested" ? "queued" : state.status;
	return {
		...audit,
		state: {
			...state,
			status,
			statusKo: auditStatusLabel(status),
			reasonKo: state.reason ? auditReasonLabel(state.reason) : null,
			result: labelledAuditResult(state.result),
		},
		statusKo: auditStatusLabel(status),
	};
}

/**
 * Add the Korean labels to one session record. `extras` overrides the result
 * (todo 13 passes the audit block and live daemon status here); `audit` stays
 * null until that todo lands.
 */
export function buildSessionView(record, extras = {}) {
	if (!isRecord(record)) return record;
	if (record.error === "ambiguous-session") return { found: false, error: record.error };
	const { audit: auditExtra, ...rest } = extras;
	const audit = labelledAudit(auditExtra !== undefined ? auditExtra : record.audit ?? null);
	if (record.found === false) return { ...record, audit, ...rest };
	const health = isRecord(record.health) ? record.health : {};
	return {
		...record,
		session: labelledSession(record.session),
		...("tokens" in record ? { tokens: detailTokens(record.tokens) } : {}),
		children: sessionItems(record, "children").map(ITEM_LABELS.children),
		health: {
			...health,
			...Object.fromEntries(SESSION_LISTS.slice(1).map((name) => [name, sessionItems(record, name).map(ITEM_LABELS[name])])),
		},
		audit,
		...rest,
	};
}
