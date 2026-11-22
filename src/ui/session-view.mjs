import { actionLabel, analystVerdictLabel, auditJudgmentLabel, auditOverallLabel, auditReasonLabel, auditStatusLabel, auditTokenLabel, causeLabel, findingLabel, outcomeLabel, resultLabel, severityLabel, terminalLabel } from "./labels.mjs";
import { investigationRow } from "./model.mjs";

/**
 * The dashboard's session detail (plan todo 8): the stored record from
 * `src/session-record.mjs` plus the Korean labels the page renders. Pure: every
 * call takes the record and only derives strings, so the memo in
 * `src/ui/cli.mjs` can keep the historical record without ever freezing a label
 * or the audit block.
 */

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isRecord) : []);
const overflows = (value) => typeof value === "number" && !Number.isFinite(value);

function labelledSession(session) {
	if (!isRecord(session)) return null;
	const terminal = isRecord(session.terminal) ? session.terminal : null;
	return {
		...session,
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
	return { ...row, verdictHistory: labelledVerdictHistory(investigation.verdictHistory) };
}

function labelledChild(child) {
	const overflow = overflows(child.tokens?.total);
	return {
		...child,
		...(overflow ? { tokens: { ...child.tokens, total: null }, tokensState: "overflow" } : {}),
		outcomeKo: outcomeLabel(child.outcome),
	};
}

function detailTokens(tokens) {
	if (!tokens) return tokens;
	// The record's treeTotal is null when no descendant contributed, not when the sum equals the own total.
	return {
		...tokens,
		...(overflows(tokens.total) ? { total: null, tokensState: "overflow" } : {}),
		...(overflows(tokens.treeTotal) ? { treeTotal: null, treeTokensState: "overflow" } : {}),
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
	const { audit: auditExtra, ...rest } = extras;
	const audit = labelledAudit(auditExtra !== undefined ? auditExtra : record.audit ?? null);
	if (record.found === false) return { ...record, audit, ...rest };
	const health = isRecord(record.health) ? record.health : {};
	return {
		...record,
		session: labelledSession(record.session),
		...("tokens" in record ? { tokens: detailTokens(record.tokens) } : {}),
		children: list(record.children).map(labelledChild),
		health: {
			...health,
			findings: list(health.findings).map(labelledFinding),
			actions: list(health.actions).map(labelledAction),
			investigations: list(health.investigations).map(labelledInvestigation),
			messages: list(health.messages),
		},
		audit,
		...rest,
	};
}
