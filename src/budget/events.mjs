// C-events: turn one parsed senpi v3 JSONL entry into ledger usage, budget blocks and round numbers.
// Blocks come only from assistant `text` items of replies that did not fail part-way (stopReason error/aborted).
// Rounds come from assistant text and from `todo` tool-call arguments; every D15 round match counts.

import { ROUND } from "../detect/align.mjs";
import { extractBlocks } from "./protocol.mjs";

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
	for (const match of text.matchAll(ROUND)) rounds.push(Number(match[1] ?? match[2]));
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
	const result = { blocks, rounds };
	if (!entry || typeof entry !== "object") return result;

	if (entry.type === "model_change") {
		if (typeof entry.provider === "string" && entry.provider) result.modelProvider = entry.provider;
		return result;
	}
	if ((entry.type === "custom" || entry.type === "custom_message") && GOAL_CHANGE.test(String(entry.customType ?? ""))) {
		result.goalChange = true;
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
