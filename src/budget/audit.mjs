// C-audit: the evidence bundle, owner question, strict opinion schema, model choice, guarded argv and
// json-mode output parsing for one budget audit. Pure except for reading the caller's inputs.
import { accountOf } from "./accounts.mjs";
import { GUARD_FLAGS, assertGuardFlags, modelFamily, providerOfModel } from "../judge/lane.mjs";
import { redact, truncate } from "../util/text.mjs";

/** Hard cap of the markdown evidence bundle. */
export const MAX_BUNDLE_CHARS = 60000;
/** Recent step lines and characters per line that reach the auditor. */
export const MAX_RECENT_STEPS = 60;
export const MAX_RECENT_STEP_CHARS = 300;
/** Owner requests in the bundle: the first ones (what was asked) and the latest ones (what is asked now). */
export const FIRST_USER_REQUESTS = 2;
export const MAX_USER_REQUESTS = 3;
/** Reviewer verdicts (newest) and omo-health notes (newest) in the bundle, and characters kept of each. */
export const MAX_REVIEW_VERDICTS = 30;
export const MAX_REVIEW_VERDICT_CHARS = 600;
export const MAX_HEALTH_NOTES = 6;
export const MAX_GOAL_CHARS = 6000;
/** Characters of the quick model's digest the auditor reads. */
export const MAX_DIGEST_CHARS = 12000;

/** What the quick-lane digest run must produce from the raw evidence (owner decision: the auditor reads a summary). */
export const DIGEST_INSTRUCTION = [
	"Read the attached raw evidence only. Summarize it for an auditor in plain text, at most 1500 words, with these headings:",
	"Reviewer runs (how many, what each round rejected, which findings repeat, which look requirement-level vs edge cases),",
	"Recent work (what the agent did lately and whether it produced new acceptance evidence),",
	"Earlier omo-health notes (what they said and whether the agent changed course).",
	"Quote short phrases as evidence. Do not judge the work and do not give advice.",
].join(" ");

/** The question every audit answers. */
export const AUDIT_QUESTION = [
	"Judge two things for the owner and the working agent.",
	"(1) Alignment: for each acceptance criterion, did it come from an owner request (quote it) or did the agent add it? Are the reviewer findings that still block completion requirement-level for what the owner asked, or hardening, edge cases and notation?",
	"(2) Feasibility under constraints: given the remaining allowance, the time and the remaining work, can the goal as defined finish? Should a criterion be narrowed or dropped?",
	"Who may relax it: an agent-added criterion may be dropped by the agent, which then reports it to the owner; an owner-given criterion goes to the owner.",
	"Weigh what was already delivered (an open PR, passed criteria) against spend after it.",
	"Also examine severity inflation, unjustified full reruns, design details promoted to requirements, source-equivalent notation reported as defects, harness failures blamed on the product, and repeated report saving.",
	"Cite evidence and counterevidence for every judgment. Say clearly when the evidence is insufficient. This is an opinion, never an instruction.",
].join(" ");

/** What the detached audit run must answer, and in which shape. */
export const AUDIT_INSTRUCTION = [
	"Read the attached evidence bundle only.",
	"Answer with one JSON object and nothing else, with exactly these keys:",
	'{"v":2,"auditId":"<from the bundle>","projectId":"<from the bundle>",',
	'"assessment":"justified"|"waste-likely"|"insufficient-evidence","confidence":0..1,',
	'"criteriaStatus":"unmet"|"apparently-met"|"unknown",',
	'"situation":"<=600 chars",',
	'"criteria":[{"criterion":"<=200 chars","origin":"owner"|"agent"|"unknown","status":"met"|"unmet"|"unknown","judgment":"<=500 chars"}] (at most 10),',
	'"counterevidence":"<=800 chars",',
	'"decides":[{"who":"agent"|"owner","what":"<=300 chars"}] (1 to 4),',
	'"findings":[{"pattern":"severity-inflation"|"unjustified-full-rerun"|"invented-requirement"|"source-equivalent-notation"|"harness-as-product-failure"|"repeated-report-saving"|"duplicate-delegation"|"repeated-qa-without-acceptance-gain"|"other","evidence":"<=400 chars","explanation":"<=600 chars"}],',
	'"advice":"40..1200 chars",',
	'"allocationOpinion":{"assessment":"support"|"revise"|"insufficient-evidence"|"not-applicable","reason":"<=400 chars"}}.',
	"A waste-likely answer carries at least one finding.",
	"The whole opinion is one page and each part is cut at its share, so stay within: situation 400, all criteria together 900, all findings together 600, counterevidence 350, advice 550, all decides together 350 characters; most important first.",
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
const OPINION_KEYS = Object.freeze(["v", "auditId", "projectId", "assessment", "confidence", "criteriaStatus", "situation", "criteria", "counterevidence", "decides", "findings", "advice", "allocationOpinion"]);
const CRITERION_KEYS = Object.freeze(["criterion", "origin", "status", "judgment"]);
const DECIDES_KEYS = Object.freeze(["who", "what"]);
const ORIGINS = Object.freeze(["owner", "agent", "unknown"]);
const CRITERION_STATUSES = Object.freeze(["met", "unmet", "unknown"]);
const DECIDERS = Object.freeze(["agent", "owner"]);
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

	if (obj.v !== 2) errors.push("opinion.v: must be 2");
	if (typeof obj.auditId !== "string" || obj.auditId.length === 0) errors.push("opinion.auditId: non-empty string required");
	else if (typeof auditId === "string" && obj.auditId !== auditId) errors.push("opinion.auditId: does not match this audit");
	if (typeof obj.projectId !== "string" || obj.projectId.length === 0) errors.push("opinion.projectId: non-empty string required");
	else if (typeof projectId === "string" && obj.projectId !== projectId) errors.push("opinion.projectId: does not match this project");

	const assessmentOk = ASSESSMENTS.includes(obj.assessment);
	if (!assessmentOk) errors.push(`opinion.assessment: one of ${ASSESSMENTS.join("|")}`);
	if (!isFiniteNumber(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) errors.push("opinion.confidence: number 0..1 required");
	if (!CRITERIA_STATUSES.includes(obj.criteriaStatus)) errors.push(`opinion.criteriaStatus: one of ${CRITERIA_STATUSES.join("|")}`);
	if (textLength(obj.situation) <= 0 || textLength(obj.situation) > 600) errors.push("opinion.situation: 1..600 chars required");
	if (textLength(obj.counterevidence) < 0 || textLength(obj.counterevidence) > 800) errors.push("opinion.counterevidence: string of at most 800 chars required");
	if (!Array.isArray(obj.criteria) || obj.criteria.length > 10) errors.push("opinion.criteria: array of at most 10 required");
	else obj.criteria.forEach((item, index) => {
		const where = `opinion.criteria[${index}]`;
		if (!isObject(item)) {
			errors.push(`${where}: object required`);
			return;
		}
		unknownKeys(item, CRITERION_KEYS, where, errors);
		if (textLength(item.criterion) <= 0 || textLength(item.criterion) > 200) errors.push(`${where}.criterion: 1..200 chars required`);
		if (!ORIGINS.includes(item.origin)) errors.push(`${where}.origin: one of ${ORIGINS.join("|")}`);
		if (!CRITERION_STATUSES.includes(item.status)) errors.push(`${where}.status: one of ${CRITERION_STATUSES.join("|")}`);
		if (textLength(item.judgment) <= 0 || textLength(item.judgment) > 500) errors.push(`${where}.judgment: 1..500 chars required`);
	});
	if (!Array.isArray(obj.decides) || obj.decides.length < 1 || obj.decides.length > 4) errors.push("opinion.decides: array of 1..4 required");
	else obj.decides.forEach((item, index) => {
		const where = `opinion.decides[${index}]`;
		if (!isObject(item)) {
			errors.push(`${where}: object required`);
			return;
		}
		unknownKeys(item, DECIDES_KEYS, where, errors);
		if (!DECIDERS.includes(item.who)) errors.push(`${where}.who: one of ${DECIDERS.join("|")}`);
		if (textLength(item.what) <= 0 || textLength(item.what) > 300) errors.push(`${where}.what: 1..300 chars required`);
	});

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
 * Markdown evidence bundle for one audit, capped at MAX_BUNDLE_CHARS. Owner requests arrive already chosen and capped
 * (src/budget/events.mjs); reviewer verdicts, notes and earlier opinions come newest-last. Recent steps (the last 60, 300
 * characters each) go last, so the cap cuts them first. Every rendered value is redacted.
 */
/** The bulky raw evidence: reviewer verdicts, earlier omo-health notes and recent steps (the last of each, newest last). */
function rawSections(lines, { reviews = null, healthNotes = [], recentSteps = [] }) {
	const steps = (Array.isArray(recentSteps) ? recentSteps : [])
		.slice(-MAX_RECENT_STEPS)
		.map((step) => redact(truncate(step, MAX_RECENT_STEP_CHARS)));
	const verdicts = (Array.isArray(reviews?.verdicts) ? reviews.verdicts : []).slice(-MAX_REVIEW_VERDICTS).map((v) =>
		`- ${isFiniteNumber(v.ms) ? new Date(v.ms).toISOString() : "-"} ${v.agent ?? "reviewer"} (${v.model ?? "model unknown"}) ${v.status ?? ""}: ${truncate(String(v.text ?? ""), MAX_REVIEW_VERDICT_CHARS).replace(/\s+/g, " ")}`);
	const notes = (Array.isArray(healthNotes) ? healthNotes : []).slice(-MAX_HEALTH_NOTES).map((n) =>
		`- ${isFiniteNumber(n.ms) ? new Date(n.ms).toISOString() : "-"} ${n.kind ?? "note"}: ${String(n.text ?? "").replace(/\s+/g, " ")}`);
	section(lines, "Reviewer runs", `${reviews?.spawns ?? 0} reviewer spawns, ${reviews?.verdictTotal ?? verdicts.length} verdicts recorded; the newest:\n${verdicts.length > 0 ? verdicts.join("\n") : "none"}`);
	section(lines, "Earlier omo-health notes", notes.length > 0 ? notes.join("\n") : "none");
	section(lines, "Recent steps", steps.length > 0 ? steps.map((step) => `- ${step}`).join("\n") : "not recorded");
}

function capped(lines) {
	const text = redact(lines.join("\n"));
	if (text.length <= MAX_BUNDLE_CHARS) return text;
	const marker = "\n[truncated]\n";
	return `${text.slice(0, MAX_BUNDLE_CHARS - marker.length)}${marker}`;
}

export function buildBundle({ project, goal, criteria, rounds = [], recentSteps = [], userRequests = [], reviews = null, healthNotes = [], earlierAudits = [], delivered = null, digest = null, ladder = null, indicators, triggers, ref, treasury } = {}) {
	const requests = (Array.isArray(userRequests) ? userRequests : []).map((request) => {
		const at = isObject(request) && isFiniteNumber(request.ms) ? ` (${new Date(request.ms).toISOString()})` : "";
		return `### Request${at}\n\n${redact(String(isObject(request) ? request.text ?? "" : request))}`;
	});
	const goalView = isObject(goal) && typeof goal.objective === "string" ? { ...goal, objective: truncate(goal.objective, MAX_GOAL_CHARS) } : goal;
	const roundRows = (Array.isArray(rounds) ? rounds : []).map((row) => {
		const round = isObject(row) ? row.round : undefined;
		const firstMs = isObject(row) ? row.firstMs : undefined;
		const costUsd = isObject(row) ? row.costUsd : undefined;
		return `| ${round ?? "-"} | ${isFiniteNumber(firstMs) ? new Date(firstMs).toISOString() : "-"} | ${usd(costUsd)} |`;
	});

	const lines = ["# Budget audit bundle", "", "## Question", "", AUDIT_QUESTION];
	section(lines, "Project", jsonBlock(project));
	section(lines, "Owner requests (first and latest, verbatim)", requests.length > 0 ? requests.join("\n\n") : "not recorded");
	section(lines, "Goal (as the agent registered it)", jsonBlock(goalView));
	section(lines, "Acceptance criteria (per-criterion status)", jsonBlock(criteria));
	section(lines, "Delivered", jsonBlock(delivered));
	section(lines, "Ladder", jsonBlock(ladder));
	section(lines, "Indicators", jsonBlock(indicators));
	section(lines, "Triggers", jsonBlock(triggers));
	section(lines, "Round table", ["| round | first | cost |", "| --- | --- | --- |", ...roundRows].join("\n"));
	section(lines, "Earlier audit opinions", jsonBlock(Array.isArray(earlierAudits) && earlierAudits.length > 0 ? earlierAudits : null));
	section(lines, "Reference class", jsonBlock(ref));
	section(lines, "Treasury", jsonBlock(treasury));
	if (typeof digest === "string" && digest.trim()) {
		// The quick model already read the bulky raw evidence; the auditor reads its summary and the counts.
		section(lines, "Evidence digest (quick-model summary of reviewer runs, recent work and earlier notes)", `${reviews?.spawns ?? 0} reviewer spawns, ${reviews?.verdictTotal ?? 0} verdicts recorded.\n\n${redact(truncate(digest.trim(), MAX_DIGEST_CHARS))}`);
	} else rawSections(lines, { reviews, healthNotes, recentSteps });
	return capped(lines);
}

/**
 * The auditor of one ladder tier (owner decision 2026-11-25): the top model of the main session's own family
 * (`topModels[family]`, e.g. claude -> Fable), thinking at `efforts[tier - 1]`. Null when the family has no top model,
 * its provider is not logged in, or its subscription account is `short`: the audit is then deferred, never handed to
 * a weaker model.
 */
export function auditModel({ topModels = {}, efforts = [], mainModel, tier, loggedIn = new Set(), accountState = () => "ok" } = {}) {
	if (typeof mainModel !== "string" || !mainModel) return null;
	const base = topModels?.[modelFamily(mainModel)];
	const effort = efforts[Math.max(1, Math.min(tier, efforts.length)) - 1];
	if (typeof base !== "string" || !base || !effort) return null;
	const provider = providerOfModel(base);
	if (!provider || !loggedIn.has(provider)) return null;
	const account = accountOf(provider);
	if ((account ? accountState(account) : undefined) === "short") return null;
	return `${base}:${effort}`;
}

/** Raw evidence the quick digest reads: reviewer verdicts, health notes and recent steps, newest last, redacted. */
export function buildDigestInput({ reviews = null, healthNotes = [], recentSteps = [] } = {}) {
	const lines = ["# Raw evidence"];
	rawSections(lines, { reviews, healthNotes, recentSteps });
	return capped(lines);
}

/** argv for the digest run: the same guard flags as every audit, the quick model and the raw evidence file. */
export function digestArgs({ model, inputFile }) {
	if (!model) throw new Error("digestArgs: model is required");
	if (!inputFile) throw new Error("digestArgs: inputFile is required");
	return assertGuardFlags(["-p", "--mode", "json", ...GUARD_FLAGS, "--model", model, `@${inputFile}`, DIGEST_INSTRUCTION]);
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
