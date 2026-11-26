// C-events: turn one parsed senpi v3 JSONL entry into ledger usage, budget blocks and round numbers.
// Blocks come only from assistant `text` items of replies that did not fail part-way (stopReason error/aborted).
// Rounds come from assistant text, `todo` tool-call arguments and reviewer spawn summaries; every D15 round match counts.
// Audit evidence (`evidence`): owner requests, reviewer spawns and verdicts, omo-health notes and the first PR link a
// tool result shows, each capped here so a long transcript never grows the ledger without bound.

import { REVIEW_AGENTS } from "../align/steps.mjs";
import { redact } from "../util/text.mjs";
import { ROUND } from "../detect/align.mjs";
import { extractBlocks } from "./protocol.mjs";

/**
 * Characters kept per evidence item; a request keeps its head and tail (a skill wrapper puts the owner's words last).
 * Every text is redacted before it is cut: a cut can drop the prefix (`sk-ant-`, `Bearer `) the redaction matches on.
 */
export const REQUEST_CHARS = 4000;
export const VERDICT_CHARS = 1500;
export const NOTE_CHARS = 1200;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
// An owner answer to a question: the question tool's result with status answered, or the answer to a deferred question
// delivered as a user message. A timeout, a pending acknowledgement and any other user message (agents type into panes
// too) are not answers.
const QUESTION_TOOL = /(^|__)ask_user_question$/;
const DEFERRED_ANSWER = "[Answer to question ";

function headTail(text, max) {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.375);
	return `${text.slice(0, head)}\n[...]\n${text.slice(text.length - (max - head - 7))}`;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

/** Reviewer spawns of one `task` call: a single spawn or a batch under `tasks`. */
function reviewSpawns(args, evidence, rounds) {
	const items = Array.isArray(args?.tasks) ? args.tasks.map((t) => ({ ...args, ...t })) : [args ?? {}];
	for (const item of items) {
		const agent = item.subagent_type;
		if (!REVIEW_AGENTS.has(agent)) continue;
		const summary = String(item.task_summary ?? item.description ?? item.name ?? "").slice(0, 300);
		collectRounds(summary, rounds);
		evidence.push({ kind: "review-spawn", data: { agent, name: item.name ?? null, summary } });
	}
}

/** Reviewer verdicts a task-completion wake carries (senpi-task.completion producer details). */
function reviewVerdicts(entry, evidence) {
	const content = textOf(entry.content);
	for (const producer of Array.isArray(entry.details?.producerDetails) ? entry.details.producerDetails : []) {
		if (producer?.customType !== "senpi-task.completion") continue;
		for (const done of Array.isArray(producer.details) ? producer.details : []) {
			if (!REVIEW_AGENTS.has(done?.agent_type)) continue;
			const at = done.name ? content.indexOf(`name:${done.name}`) : -1;
			const text = redact(at >= 0 ? content.slice(at) : content).slice(0, VERDICT_CHARS);
			evidence.push({ kind: "review-verdict", data: { agent: done.agent_type, name: done.name ?? null, model: done.model ?? null, status: done.status ?? null, text } });
		}
	}
}

const NO_BLOCK_STOP = new Set(["error", "aborted"]);
// senpi v3 has no transcript entry for a goal edit (C-ingest reads the goal extension files); a host that
// writes one under these names is still reported as a goal change.
const GOAL_CHANGE = /^goal[._-](created|updated|completed|cleared|replaced|state)$/i;

function toMs(value) {
	const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
	return Number.isFinite(ms) ? ms : undefined;
}

function collectRounds(text, rounds) {
	if (typeof text !== "string" || !text) return;
	for (const match of text.matchAll(ROUND)) rounds.push(Number(match[1] ?? match[2] ?? match[3]));
}

/** Every string leaf of a tool-call argument tree (todo items live in nested arrays and objects). */
function eachString(value, visit) {
	if (typeof value === "string") visit(value);
	else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
	else if (value && typeof value === "object") for (const item of Object.values(value)) eachString(item, visit);
}

function count(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Extract one entry's contributions. Always returns blocks and rounds arrays; usage is present only for an
 * assistant message with a usage record. `ctx.provider` follows the latest `model_change.provider`.
 */
export function extractEvents(entry, ctx = {}) {
	const blocks = [];
	const rounds = [];
	const evidence = [];
	const result = { blocks, rounds, evidence };
	if (!entry || typeof entry !== "object") return result;

	if (entry.type === "model_change") {
		if (typeof entry.provider === "string" && entry.provider) result.modelProvider = entry.provider;
		return result;
	}
	if ((entry.type === "custom" || entry.type === "custom_message") && GOAL_CHANGE.test(String(entry.customType ?? ""))) {
		result.goalChange = true;
		return result;
	}
	if (entry.type === "custom_message" && entry.customType === "omo-senpi:wake") {
		reviewVerdicts(entry, evidence);
		return result;
	}
	if (entry.type === "custom_message" && entry.customType === "omo-health") {
		const text = textOf(entry.content);
		if (text) evidence.push({ kind: "health-note", data: { kind: entry.details?.kind ?? entry.details?.actionKind ?? null, text: redact(text).slice(0, NOTE_CHARS) } });
		return result;
	}
	if (entry.type === "message" && entry.message?.role === "user") {
		const text = textOf(entry.message.content).trim();
		if (text) evidence.push({ kind: "request", data: { text: headTail(redact(text), REQUEST_CHARS) } });
		if (text.startsWith(DEFERRED_ANSWER)) evidence.push({ kind: "owner-answer", data: { via: "deferred" } });
		return result;
	}
	if (entry.type === "message" && entry.message?.role === "toolResult") {
		if (QUESTION_TOOL.test(String(entry.message.toolName ?? "")) && entry.message.details?.status === "answered") {
			evidence.push({ kind: "owner-answer", data: { via: "question-tool" } });
		}
		const url = textOf(entry.message.content).match(PR_URL)?.[0];
		if (url) evidence.push({ kind: "pr", data: { url } });
		return result;
	}
	if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") return result;

	const message = entry.message;
	const content = Array.isArray(message.content) ? message.content : [];
	const ms = toMs(entry.timestamp) ?? toMs(message.timestamp) ?? 0;
	const blocksAllowed = !NO_BLOCK_STOP.has(message.stopReason);

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "text") {
			collectRounds(item.text, rounds);
			if (blocksAllowed) blocks.push(...extractBlocks(item.text));
		} else if (item.type === "toolCall" && String(item.name ?? "").toLowerCase() === "todo") {
			eachString(item.arguments, (text) => collectRounds(text, rounds));
		} else if (item.type === "toolCall" && /(^|__)task$/.test(String(item.name ?? ""))) {
			reviewSpawns(item.arguments, evidence, rounds);
		}
	}

	const usage = message.usage;
	if (usage && typeof usage === "object") {
		const total = usage.cost?.total;
		const reported = typeof total === "number" && Number.isFinite(total);
		const projectId = typeof ctx.projectOf === "function" ? ctx.projectOf(ms) : undefined;
		result.usage = {
			id: entry.id ? `${ctx.sessionId}:${entry.id}` : `${ctx.sessionId}:${ms}:${ctx.lineNo}`,
			ms,
			sessionId: ctx.sessionId,
			rootSessionId: ctx.rootSessionId,
			projectId: projectId ?? null,
			taskId: ctx.taskId ?? null,
			source: ctx.source,
			provider: message.provider ?? ctx.provider ?? null,
			model: message.model ?? null,
			input: count(usage.input),
			output: count(usage.output),
			cacheRead: count(usage.cacheRead),
			cacheWrite: count(usage.cacheWrite),
			cost: reported ? total : null,
			costStatus: reported ? "reported" : "missing",
		};
	}
	return result;
}
