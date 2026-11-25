// C-audit: the evidence bundle, owner question, strict opinion schema, model choice, guarded argv and
// json-mode output parsing for one budget audit. Pure except for reading the caller's inputs.
import { accountOf } from "./accounts.mjs";
import { GUARD_FLAGS, assertGuardFlags, providerOfModel } from "../judge/lane.mjs";
import { redact, truncate } from "../util/text.mjs";

/** Hard cap of the markdown evidence bundle. */
export const MAX_BUNDLE_CHARS = 60000;
/** Recent step lines and characters per line that reach the auditor. */
export const MAX_RECENT_STEPS = 60;
export const MAX_RECENT_STEP_CHARS = 300;
/** User requests included in the bundle. */
export const MAX_USER_REQUESTS = 3;

/** The question every audit answers. */
export const AUDIT_QUESTION = [
	"Which remaining activities are necessary for the required acceptance criteria?",
	"Does the additional main and subagent spend buy new acceptance evidence, or does it repeat checking, reporting, or minor corrections?",
	"Examine severity inflation, unjustified full reruns, design details promoted to requirements, source-equivalent notation reported as defects, harness failures blamed on the product, and repeated report saving.",
	"Cite evidence and counterevidence for every judgment.",
	"Recommend a cheaper path that keeps every required criterion.",
	"Say clearly when the evidence is insufficient.",
].join(" ");

/** What the detached audit run must answer, and in which shape. */
export const AUDIT_INSTRUCTION = [
	"Read the attached evidence bundle only.",
	"Answer with one JSON object and nothing else, with exactly these keys:",
	'{"v":1,"auditId":"<from the bundle>","projectId":"<from the bundle>",',
	'"assessment":"justified"|"waste-likely"|"insufficient-evidence","confidence":0..1,',
	'"criteriaStatus":"unmet"|"apparently-met"|"unknown",',
	'"findings":[{"pattern":"severity-inflation"|"unjustified-full-rerun"|"invented-requirement"|"source-equivalent-notation"|"harness-as-product-failure"|"repeated-report-saving"|"duplicate-delegation"|"repeated-qa-without-acceptance-gain"|"other","evidence":"<=400 chars","explanation":"<=600 chars"}],',
	'"advice":"40..1200 chars",',
	'"allocationOpinion":{"assessment":"support"|"revise"|"insufficient-evidence"|"not-applicable","reason":"<=400 chars"}}.',
	"A waste-likely answer carries at least one finding.",
].join(" ");

const ASSESSMENTS = Object.freeze(["justified", "waste-likely", "insufficient-evidence"]);
const CRITERIA_STATUSES = Object.freeze(["unmet", "apparently-met", "unknown"]);
const PATTERNS = Object.freeze([
	"severity-inflation",
	"unjustified-full-rerun",
	"invented-requirement",
	"source-equivalent-notation",
	"harness-as-product-failure",
	"repeated-report-saving",
	"duplicate-delegation",
	"repeated-qa-without-acceptance-gain",
	"other",
]);
const ALLOCATION_ASSESSMENTS = Object.freeze(["support", "revise", "insufficient-evidence", "not-applicable"]);
const OPINION_KEYS = Object.freeze(["v", "auditId", "projectId", "assessment", "confidence", "criteriaStatus", "findings", "advice", "allocationOpinion"]);
const FINDING_KEYS = Object.freeze(["pattern", "evidence", "explanation"]);
const ALLOCATION_KEYS = Object.freeze(["assessment", "reason"]);

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function textLength(value) {
	return typeof value === "string" ? value.trim().length : -1;
}

/** Unknown keys at one object level are rejected, never ignored. */
function unknownKeys(obj, allowed, where, errors) {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) errors.push(`${where}.${key}: unknown key`);
	}
}

/**
 * Strict opinion validation against C-audit. Unknown keys are rejected at every level; `waste-likely`
 * requires at least one finding; advice is 40..1200 characters (trimmed).
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateOpinion(obj, { auditId, projectId } = {}) {
	const errors = [];
	if (!isObject(obj)) return { ok: false, errors: ["opinion: not an object"] };
	unknownKeys(obj, OPINION_KEYS, "opinion", errors);

	if (obj.v !== 1) errors.push("opinion.v: must be 1");
	if (typeof obj.auditId !== "string" || obj.auditId.length === 0) errors.push("opinion.auditId: non-empty string required");
	else if (typeof auditId === "string" && obj.auditId !== auditId) errors.push("opinion.auditId: does not match this audit");
	if (typeof obj.projectId !== "string" || obj.projectId.length === 0) errors.push("opinion.projectId: non-empty string required");
	else if (typeof projectId === "string" && obj.projectId !== projectId) errors.push("opinion.projectId: does not match this project");

	const assessmentOk = ASSESSMENTS.includes(obj.assessment);
	if (!assessmentOk) errors.push(`opinion.assessment: one of ${ASSESSMENTS.join("|")}`);
	if (!isFiniteNumber(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) errors.push("opinion.confidence: number 0..1 required");
	if (!CRITERIA_STATUSES.includes(obj.criteriaStatus)) errors.push(`opinion.criteriaStatus: one of ${CRITERIA_STATUSES.join("|")}`);

	if (!Array.isArray(obj.findings)) errors.push("opinion.findings: array required");
	else {
		if (obj.findings.length > 8) errors.push("opinion.findings: at most 8");
		if (obj.assessment === "waste-likely" && obj.findings.length === 0) errors.push("opinion.findings: waste-likely requires at least one finding");
		obj.findings.forEach((finding, index) => {
			const where = `opinion.findings[${index}]`;
			if (!isObject(finding)) {
				errors.push(`${where}: object required`);
				return;
			}
			unknownKeys(finding, FINDING_KEYS, where, errors);
			if (!PATTERNS.includes(finding.pattern)) errors.push(`${where}.pattern: one of ${PATTERNS.join("|")}`);
			if (textLength(finding.evidence) <= 0 || textLength(finding.evidence) > 400) errors.push(`${where}.evidence: 1..400 chars required`);
			if (textLength(finding.explanation) <= 0 || textLength(finding.explanation) > 600) errors.push(`${where}.explanation: 1..600 chars required`);
		});
	}

	const adviceLength = textLength(obj.advice);
	if (adviceLength < 40 || adviceLength > 1200) errors.push("opinion.advice: 40..1200 chars required");

	const allocation = obj.allocationOpinion;
	if (!isObject(allocation)) errors.push("opinion.allocationOpinion: object required");
	else {
		unknownKeys(allocation, ALLOCATION_KEYS, "opinion.allocationOpinion", errors);
		if (!ALLOCATION_ASSESSMENTS.includes(allocation.assessment)) errors.push(`opinion.allocationOpinion.assessment: one of ${ALLOCATION_ASSESSMENTS.join("|")}`);
		if (textLength(allocation.reason) <= 0 || textLength(allocation.reason) > 400) errors.push("opinion.allocationOpinion.reason: 1..400 chars required");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: obj };
}

function usd(value) {
	return isFiniteNumber(value) ? `$${value.toFixed(2)}` : "-";
}

function jsonBlock(value) {
	return value === undefined || value === null ? "not recorded" : redact(JSON.stringify(value, null, 2));
}

function section(lines, title, body) {
	lines.push("", `## ${title}`, "", body);
}

/**
 * Markdown evidence bundle for one audit, capped at MAX_BUNDLE_CHARS. Recent steps are cut to the last
 * 60, each to 300 characters, and every rendered value is redacted (credentials never reach the model).
 */
export function buildBundle({ project, goal, criteria, rounds = [], recentSteps = [], userRequests = [], indicators, triggers, ref, treasury } = {}) {
	const steps = (Array.isArray(recentSteps) ? recentSteps : [])
		.slice(-MAX_RECENT_STEPS)
		.map((step) => redact(truncate(step, MAX_RECENT_STEP_CHARS)));
	const requests = (Array.isArray(userRequests) ? userRequests : [])
		.slice(-MAX_USER_REQUESTS)
		.map((request) => redact(truncate(request, MAX_RECENT_STEP_CHARS)));
	const roundRows = (Array.isArray(rounds) ? rounds : []).map((row) => {
		const round = isObject(row) ? row.round : undefined;
		const firstMs = isObject(row) ? row.firstMs : undefined;
		const costUsd = isObject(row) ? row.costUsd : undefined;
		return `| ${round ?? "-"} | ${isFiniteNumber(firstMs) ? new Date(firstMs).toISOString() : "-"} | ${usd(costUsd)} |`;
	});

	const lines = ["# Budget audit bundle", "", "## Question", "", AUDIT_QUESTION];
	section(lines, "Project", jsonBlock(project));
	section(lines, "Goal", jsonBlock(goal));
	section(lines, "Acceptance criteria", jsonBlock(criteria));
	section(lines, "Indicators", jsonBlock(indicators));
	section(lines, "Triggers", jsonBlock(triggers));
	section(lines, "Round table", ["| round | first | cost |", "| --- | --- | --- |", ...roundRows].join("\n"));
	section(lines, "Recent steps", steps.length > 0 ? steps.map((step) => `- ${step}`).join("\n") : "not recorded");
	section(lines, "User requests", requests.length > 0 ? requests.map((request) => `- ${request}`).join("\n") : "not recorded");
	section(lines, "Reference class", jsonBlock(ref));
	section(lines, "Treasury", jsonBlock(treasury));

	const text = redact(lines.join("\n"));
	if (text.length <= MAX_BUNDLE_CHARS) return text;
	const marker = "\n[truncated]\n";
	return `${text.slice(0, MAX_BUNDLE_CHARS - marker.length)}${marker}`;
}

/**
 * The first configured model whose provider is logged in and whose subscription account is not `short`.
 * Providers without an account are usable: they have no window that could be short.
 */
export function chooseModel({ models = [], loggedIn = new Set(), accountState = () => "ok" } = {}) {
	for (const model of Array.isArray(models) ? models : []) {
		if (typeof model !== "string" || model.length === 0) continue;
		const provider = providerOfModel(model);
		if (!provider || !loggedIn.has(provider)) continue;
		const account = accountOf(provider);
		const state = account ? accountState(account) : undefined;
		if (state === "short") continue;
		return model;
	}
	return null;
}

/**
 * argv for one audit run: print mode, json event stream, every guard flag, the chosen model and the bundle
 * as an attached file. `assertGuardFlags` throws, so a later edit cannot quietly loosen the sandbox.
 */
export function auditArgs({ model, bundleFile }) {
	if (!model) throw new Error("auditArgs: model is required");
	if (!bundleFile) throw new Error("auditArgs: bundleFile is required");
	return assertGuardFlags(["-p", "--mode", "json", ...GUARD_FLAGS, "--model", model, `@${bundleFile}`, AUDIT_INSTRUCTION]);
}

function textOfMessage(message) {
	if (!isObject(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((item) => isObject(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function usageOf(message) {
	if (!isObject(message) || !isObject(message.usage)) return null;
	const usage = message.usage;
	const cost = isObject(usage.cost) ? usage.cost.total : undefined;
	const reported = isFiniteNumber(cost);
	return {
		input: isFiniteNumber(usage.input) ? usage.input : 0,
		output: isFiniteNumber(usage.output) ? usage.output : 0,
		cacheRead: isFiniteNumber(usage.cacheRead) ? usage.cacheRead : 0,
		cacheWrite: isFiniteNumber(usage.cacheWrite) ? usage.cacheWrite : 0,
		cost: reported ? cost : null,
		costStatus: reported ? "reported" : "missing",
	};
}

function modelOf(message) {
	if (!isObject(message)) return null;
	const provider = typeof message.provider === "string" && message.provider.length > 0 ? message.provider : null;
	const model = typeof message.model === "string" && message.model.length > 0 ? message.model : null;
	if (provider && model) return `${provider}/${model}`;
	return model ?? provider;
}

/**
 * Parse a `--mode json` stdout stream (senpi dist/modes/print-mode.js:120-122, one JSON event per line;
 * message_end at core/agent-session.js:6702 carries the final assistant message). The opinion is the final
 * assistant text. stdout with no JSON events is plain text: the whole stdout is the opinion and usage is null.
 */
export function parseOutput(stdout) {
	const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
	const events = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed[0] !== "{") continue;
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (isObject(event) && typeof event.type === "string") events.push(event);
	}
	if (events.length === 0) return { opinionText: text.trim(), usage: null, model: null };

	let final = null;
	for (const event of events) {
		if (event.type === "message_end" && isObject(event.message) && event.message.role === "assistant") final = event.message;
	}
	return {
		opinionText: final ? textOfMessage(final) : "",
		usage: final ? usageOf(final) : null,
		model: final ? modelOf(final) : null,
	};
}
