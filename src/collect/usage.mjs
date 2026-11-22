import crypto from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { classifyProviderError } from "../detect/provider.mjs";

/**
 * Token usage read from a senpi session JSONL file the way omo's own `/session`
 * (`getSessionStats`, senpi `core/agent-session.js:11953-12011`) sums it:
 * assistant-message, toolResult, `type:"usage"`, compaction/branch_summary and
 * warmed `prompt-cache-prewarm` usage, over the whole file. `totalTokens` is
 * never trusted; the four counters are summed instead.
 *
 * `readUsage` is incremental and resumable: persisted fields (`offset`, `usage`,
 * `head`, `tail`, file identity) never hold a whole file, and `scanOffset` /
 * `partial` only live in memory for a record cut by `maxBytes`.
 */

export const USAGE_TOOLS_KEY = "Tools/summaries";

const RECORD_PARSE_LIMIT = 16 * 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
const HEAD_LIMIT = 4096;
const BOM_0 = 0xef;
const BOM_1 = 0xbb;
const BOM_2 = 0xbf;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LOWER_B = 0x62;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
const LOWER_U = 0x75;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const STRING_KEEP_LIMIT = 64 * 1024;
const KEY_RAW_LIMIT = 512;
const MAX_STRING_RAW = 6 * STRING_KEEP_LIMIT + 16;
const MAX_NESTING = 1024;
const REDUCED_CHUNK = 64 * 1024;
const MODEL_ID_TOO_LONG = "(model id too long)";
const MODELS_INCOMPLETE = Symbol("scannerModelsIncomplete");

const STATE_VALUE = 0;
const STATE_KEY = 1;
const STATE_COLON = 2;
const STATE_AFTER = 3;
const STATE_END = 4;
const STATE_NUMBER = 5;
const STATE_LITERAL = 6;

const NUMBER_START = 0;
const NUMBER_AFTER_MINUS = 1;
const NUMBER_ZERO = 2;
const NUMBER_INT = 3;
const NUMBER_AFTER_DOT = 4;
const NUMBER_FRAC = 5;
const NUMBER_AFTER_E = 6;
const NUMBER_AFTER_E_SIGN = 7;
const NUMBER_EXP = 8;

const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const UPPER_E = 0x45;
const LOWER_E = 0x65;

const isSimpleEscape = (byte) =>
	byte === QUOTE || byte === BACKSLASH || byte === SLASH || byte === LOWER_B || byte === LOWER_F || byte === LOWER_N || byte === LOWER_R || byte === LOWER_T || byte === LOWER_U;

const isHexDigit = (byte) => (byte >= ZERO && byte <= NINE) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);

const isObject = (value) => typeof value === "object" && value !== null;
const nonNegative = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const isWhitespace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte) => byte >= ZERO && byte <= NINE;
const isNumberDelimiter = (byte) => isWhitespace(byte) || byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY;

function isFiniteCounter(value) {
	return Number.isFinite(value) && value >= 0;
}

function isPrewarmUsage(usage) {
	return (
		isObject(usage) &&
		Number.isFinite(usage.input) &&
		Number.isFinite(usage.output) &&
		Number.isFinite(usage.cacheRead) &&
		Number.isFinite(usage.cacheWrite) &&
		isObject(usage.cost) &&
		Number.isFinite(usage.cost.total)
	);
}

/** Fresh usage accumulator. */
export function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
		costUnknown: false,
		turns: 0,
		models: {},
		usedModels: {},
		modelsIncomplete: false,
		diagnostics: { badLines: 0, skippedLines: 0 },
	};
}

function cloneUsage(usage) {
	const src = isObject(usage) ? usage : emptyUsage();
	const out = {
		input: src.input ?? 0,
		output: src.output ?? 0,
		cacheRead: src.cacheRead ?? 0,
		cacheWrite: src.cacheWrite ?? 0,
		total: src.total ?? 0,
		cost: src.cost ?? 0,
		costUnknown: src.costUnknown === true,
		turns: src.turns ?? 0,
		models: {},
		usedModels: {},
		modelsIncomplete: src.modelsIncomplete === true,
		diagnostics: {
			badLines: src.diagnostics?.badLines ?? 0,
			skippedLines: src.diagnostics?.skippedLines ?? 0,
		},
	};
	for (const [key, value] of Object.entries(src.models ?? {})) {
		out.models[key] = { tokens: value?.tokens ?? 0, cost: value?.cost ?? 0 };
	}
	for (const key of Object.keys(src.usedModels ?? {})) out.usedModels[key] = true;
	return out;
}

function mergeUsage(into, extra) {
	into.input += extra.input;
	into.output += extra.output;
	into.cacheRead += extra.cacheRead;
	into.cacheWrite += extra.cacheWrite;
	into.total += extra.total;
	into.cost += extra.cost;
	if (extra.costUnknown) into.costUnknown = true;
	into.turns += extra.turns;
	if (extra.modelsIncomplete) into.modelsIncomplete = true;
	for (const [key, value] of Object.entries(extra.models)) {
		into.models[key] ??= { tokens: 0, cost: 0 };
		const model = into.models[key];
		model.tokens += value.tokens;
		model.cost += value.cost;
	}
	for (const key of Object.keys(extra.usedModels)) into.usedModels[key] = true;
}

/**
 * The usage a single session record contributes, or undefined. Checked in the
 * order omo's `/session` uses.
 */
export function usageOfEntry(entry) {
	if (!isObject(entry)) return undefined;
	const type = entry.type;
	if (type === "usage" && isObject(entry.usage)) {
		return { usage: entry.usage, key: `${entry.provider}/${entry.model}` };
	}
	if ((type === "branch_summary" || type === "compaction") && isObject(entry.usage)) {
		return { usage: entry.usage, key: USAGE_TOOLS_KEY };
	}
	if (type === "custom" && entry.customType === "prompt-cache-prewarm") {
		const data = entry.data;
		if (isObject(data) && data.phase === "warmed" && isPrewarmUsage(data.usage)) {
			return { usage: data.usage, key: USAGE_TOOLS_KEY };
		}
	}
	const message = entry.message;
	if (type === "message" && isObject(message)) {
		if (message.role === "toolResult" && isObject(message.usage)) {
			return { usage: message.usage, key: USAGE_TOOLS_KEY };
		}
		if (message.role === "assistant" && isObject(message.usage)) {
			return {
				usage: message.usage,
				key: `${message.provider}/${message.responseModel ?? message.model}`,
				turn: true,
			};
		}
	}
	return undefined;
}

/** Fold one `usageOfEntry` hit into a totals accumulator. */
export function addUsage(totals, hit) {
	const usage = hit.usage;
	const input = nonNegative(usage.input);
	const output = nonNegative(usage.output);
	const cacheRead = nonNegative(usage.cacheRead);
	const cacheWrite = nonNegative(usage.cacheWrite);
	const tokens = input + output + cacheRead + cacheWrite;
	const cost = Number.isFinite(usage.cost?.total) ? usage.cost.total : 0;
	totals.input += input;
	totals.output += output;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.total += tokens;
	totals.cost += cost;
	if (usage.costUnknown === true) totals.costUnknown = true;
	if (hit.turn) totals.turns += 1;
	const key = hit.key ?? USAGE_TOOLS_KEY;
	totals.models[key] ??= { tokens: 0, cost: 0 };
	const model = totals.models[key];
	model.tokens += tokens;
	model.cost += cost;
}

function modelId(provider, model) {
	return typeof provider === "string" && provider && typeof model === "string" && model ? `${provider}/${model}` : undefined;
}

/**
 * Real model ids that processed the session (reviewer exclusion in the audit
 * plan), independent of the billing keys in `models`.
 */
export function modelsOfEntry(entry) {
	const out = { ids: [], incomplete: false };
	if (!isObject(entry)) return out;
	const type = entry.type;
	const message = entry.message;
	if (type === "message" && isObject(message)) {
		if (message.role === "assistant") {
			const id = modelId(message.provider, message.model);
			if (id) out.ids.push(id);
			if (typeof message.responseModel === "string" && message.responseModel) {
				const responseId = modelId(message.provider, message.responseModel);
				if (responseId) out.ids.push(responseId);
			}
		}
		if (message.role === "toolResult" && isObject(message.usage) && !message.provider && !message.model) {
			out.incomplete = true;
		}
	}
	if (type === "usage") {
		const id = modelId(entry.provider, entry.model);
		if (id) out.ids.push(id);
	}
	if (type === "custom" && entry.customType === "prompt-cache-prewarm" && isObject(entry.data)) {
		const id = modelId(entry.data.provider, entry.data.model);
		if (id) out.ids.push(id);
	}
	if ((type === "compaction" || type === "branch_summary") && isObject(entry.usage) && !entry.provider && !entry.model) {
		out.incomplete = true;
	}
	return out;
}

function consumeEntry(totals, entry) {
	if (entry?.[MODELS_INCOMPLETE] === true) totals.modelsIncomplete = true;
	const hit = usageOfEntry(entry);
	if (hit) addUsage(totals, hit);
	const models = modelsOfEntry(entry);
	for (const id of models.ids) totals.usedModels[id] = true;
	if (models.incomplete) totals.modelsIncomplete = true;
}

const USAGE_MARKERS = ['"usage"', '"role":"assistant"', '"prompt-cache-prewarm"'];
const STAT_MARKERS = ['"isError":true', '"type":"image"', '"toolCall"', '"type":"compaction"'];

const wantsUsage = (text) => USAGE_MARKERS.some((marker) => text.includes(marker));
const wantsStats = (text) => STAT_MARKERS.some((marker) => text.includes(marker));

function stripBomBuffer(buffer) {
	if (buffer.length >= 3 && buffer[0] === BOM_0 && buffer[1] === BOM_1 && buffer[2] === BOM_2) {
		return buffer.subarray(3);
	}
	return buffer;
}

function stripBomText(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sha1(buffer) {
	return crypto.createHash("sha1").update(buffer).digest("hex");
}

function memberPlan(out, key) {
	if (typeof key !== "string") return { kind: "drop" };
	if (out === "root") {
		if (key === "type" || key === "customType") return { kind: "string" };
		if (key === "provider" || key === "model") return { kind: "identity", flagPath: key };
		if (key === "usage") return { kind: "full" };
		if (key === "message") return { kind: "object", frame: "message" };
		if (key === "data") return { kind: "object", frame: "data" };
	} else if (out === "message") {
		if (key === "role") return { kind: "string" };
		if (key === "provider" || key === "model" || key === "responseModel") return { kind: "identity", flagPath: `message.${key}` };
		if (key === "usage") return { kind: "full" };
	} else if (out === "data") {
		if (key === "phase") return { kind: "string" };
		if (key === "provider" || key === "model") return { kind: "identity", flagPath: `data.${key}` };
		if (key === "usage") return { kind: "full" };
	}
	return { kind: "drop" };
}

function decodeKey(buffer, length) {
	if (!length) return "";
	try {
		return JSON.parse(`"${buffer.toString("utf8", 0, length)}"`);
	} catch {
		return null;
	}
}

/**
 * Long identity strings are never replaced by a marker inside the reduced text.
 * The flag says "this field was too long to keep"; it is applied only when the
 * field is one usageOfEntry/modelsOfEntry would have read for this carrier.
 */
function applyTruncatedIdentities(entry, flags) {
	if (!isObject(entry)) return;
	let incomplete = false;
	const apply = (bucket, path, field) => {
		if (flags[path] !== true) return;
		bucket[field] = MODEL_ID_TOO_LONG;
		incomplete = true;
	};
	if (entry.type === "message" && isObject(entry.message)) {
		if (entry.message.role === "assistant") {
			apply(entry.message, "message.provider", "provider");
			apply(entry.message, "message.model", "model");
			apply(entry.message, "message.responseModel", "responseModel");
		}
	} else if (entry.type === "usage") {
		apply(entry, "provider", "provider");
		apply(entry, "model", "model");
	} else if (entry.type === "custom" && entry.customType === "prompt-cache-prewarm" && isObject(entry.data)) {
		apply(entry.data, "data.provider", "provider");
		apply(entry.data, "data.model", "model");
	}
	if (incomplete) entry[MODELS_INCOMPLETE] = true;
}

/**
 * Streaming reducer for records larger than RECORD_PARSE_LIMIT. It emits only
 * the fields usageOfEntry/modelsOfEntry read — top-level `type`, `customType`,
 * `provider`, `model`, `usage`, the filtered `message` and `data` objects, and
 * usage objects in full. Every other value is validated the way JSON.parse
 * validates it but never retained. Duplicate keys are emitted in order, so
 * JSON.parse of the reduced text keeps the last value. An identity string over
 * 64 KiB is omitted and remembered as a flag for that exact path.
 *
 * `push(chunk)` accepts a Buffer/Uint8Array/string. `finish()` returns the
 * parsed entry; `.malformed` and `.oversized` report why it is undefined.
 */
export function createRecordScanner() {
	let parts = [];
	let part;
	let partFill = 0;
	let total = 0;
	let oversized = false;
	let malformed = false;
	let finished = false;
	let result;
	const flags = Object.create(null);
	const stack = [];
	let state = STATE_VALUE;
	let rootSeen = false;
	let pendingKey = null;
	let numberState = NUMBER_START;
	let numberEmit = false;
	let literalWord = "";
	let literalIndex = 0;
	let literalEmit = false;
	let stringCtx = null;
	const keyBuffer = Buffer.allocUnsafe(KEY_RAW_LIMIT);
	const stringBuffer = Buffer.allocUnsafe(MAX_STRING_RAW);

	const emit = (byte) => {
		if (oversized) return;
		if (total >= RECORD_PARSE_LIMIT) {
			oversized = true;
			parts = [];
			part = undefined;
			partFill = 0;
			return;
		}
		if (!part || partFill === part.length) {
			if (part) parts.push(part);
			part = Buffer.allocUnsafe(REDUCED_CHUNK);
			partFill = 0;
		}
		part[partFill] = byte;
		partFill += 1;
		total += 1;
	};

	const top = () => stack[stack.length - 1];

	const pushFrame = (kind, out) => {
		if (stack.length >= MAX_NESTING) {
			oversized = true;
			return false;
		}
		stack.push({ kind, out, first: true, outCount: 0 });
		return true;
	};

	const finishValue = () => {
		state = stack.length ? STATE_AFTER : STATE_END;
	};

	const clearPrefix = (prefix) => {
		for (const key of Object.keys(flags)) {
			if (key === prefix || key.startsWith(`${prefix}.`)) delete flags[key];
		}
	};

	const clearMemberFlags = (frame, key) => {
		if (typeof key !== "string") return;
		if (frame.out === "root") {
			if (key === "provider" || key === "model") delete flags[key];
			else if (key === "message") clearPrefix("message");
			else if (key === "data") clearPrefix("data");
		} else if (frame.out === "message") {
			if (key === "provider" || key === "model" || key === "responseModel") delete flags[`message.${key}`];
		} else if (frame.out === "data") {
			if (key === "provider" || key === "model") delete flags[`data.${key}`];
		}
	};

	const emitNull = () => {
		emit(0x6e);
		emit(0x75);
		emit(0x6c);
		emit(0x6c);
	};

	const emitMemberPrefix = (frame, key) => {
		if (frame.outCount > 0) emit(COMMA);
		const encoded = Buffer.from(JSON.stringify(key));
		for (let index = 0; index < encoded.length; index += 1) emit(encoded[index]);
		emit(COLON);
		frame.outCount += 1;
	};

	const beginString = (kind, mode, flagPath, memberFrame, memberKey) => {
		stringCtx = { kind, mode, flagPath, memberFrame, memberKey, fill: 0, units: 0, over: false, escaped: false, unicodeLeft: 0 };
		if (mode === "emit") emit(QUOTE);
		else if (mode === "key-full") {
			const frame = top();
			if (frame.outCount > 0) emit(COMMA);
			frame.outCount += 1;
			emit(QUOTE);
		}
	};

	const keepStringByte = (byte) => {
		const ctx = stringCtx;
		if (ctx.mode === "emit" || ctx.mode === "key-full") {
			emit(byte);
			return;
		}
		if (ctx.mode === "buffer" || ctx.mode === "full-buffer") {
			if (ctx.over) return;
			if (ctx.fill >= MAX_STRING_RAW) {
				ctx.over = true;
				return;
			}
			stringBuffer[ctx.fill] = byte;
			ctx.fill += 1;
			return;
		}
		if (ctx.mode === "key-filter") {
			if (ctx.over) return;
			if (ctx.fill >= KEY_RAW_LIMIT) {
				ctx.over = true;
				return;
			}
			keyBuffer[ctx.fill] = byte;
			ctx.fill += 1;
		}
	};

	const endString = () => {
		const ctx = stringCtx;
		stringCtx = null;
		if (ctx.escaped || ctx.unicodeLeft > 0) malformed = true;
		if (ctx.mode === "emit") {
			emit(QUOTE);
			finishValue();
			return;
		}
		if (ctx.mode === "full-buffer") {
			const kept = !ctx.over && ctx.units <= STRING_KEEP_LIMIT;
			emit(QUOTE);
			if (kept) {
				for (let index = 0; index < ctx.fill; index += 1) emit(stringBuffer[index]);
			}
			emit(QUOTE);
			finishValue();
			return;
		}
		if (ctx.mode === "key-full") {
			emit(QUOTE);
			emit(COLON);
			state = STATE_COLON;
			return;
		}
		if (ctx.mode === "key-filter") {
			pendingKey = ctx.over ? null : decodeKey(keyBuffer, ctx.fill);
			state = STATE_COLON;
			return;
		}
		if (ctx.mode === "skip") {
			if (ctx.kind === "key") state = STATE_COLON;
			else finishValue();
			return;
		}
		const kept = !ctx.over && ctx.units <= STRING_KEEP_LIMIT;
		if (kept) {
			emitMemberPrefix(ctx.memberFrame, ctx.memberKey);
			emit(QUOTE);
			for (let index = 0; index < ctx.fill; index += 1) emit(stringBuffer[index]);
			emit(QUOTE);
		} else if (ctx.flagPath) {
			flags[ctx.flagPath] = true;
		}
		finishValue();
	};

	const stepString = (byte) => {
		const ctx = stringCtx;
		if (ctx.unicodeLeft > 0) {
			if (!isHexDigit(byte)) malformed = true;
			ctx.unicodeLeft -= 1;
			keepStringByte(byte);
			return;
		}
		if (ctx.escaped) {
			ctx.escaped = false;
			if (byte === LOWER_U) ctx.unicodeLeft = 4;
			else if (!isSimpleEscape(byte)) malformed = true;
			keepStringByte(byte);
			return;
		}
		if (byte === BACKSLASH) {
			ctx.escaped = true;
			if (ctx.mode === "buffer" || ctx.mode === "full-buffer") ctx.units += 1;
			keepStringByte(byte);
			return;
		}
		if (byte === QUOTE) {
			endString();
			return;
		}
		if (byte < SPACE) malformed = true;
		if ((ctx.mode === "buffer" || ctx.mode === "full-buffer") && (byte & 0xc0) !== 0x80) ctx.units += 1;
		keepStringByte(byte);
	};

	const validNumberEnd = () => numberState === NUMBER_ZERO || numberState === NUMBER_INT || numberState === NUMBER_FRAC || numberState === NUMBER_EXP;

	const stepNumber = (byte) => {
		if (isNumberDelimiter(byte)) {
			if (!validNumberEnd()) {
				malformed = true;
				return;
			}
			finishValue();
			step(byte);
			return;
		}
		const digit = isDigit(byte);
		if (numberState === NUMBER_START) {
			if (byte === MINUS) numberState = NUMBER_AFTER_MINUS;
			else if (byte === ZERO) numberState = NUMBER_ZERO;
			else if (digit) numberState = NUMBER_INT;
			else {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_AFTER_MINUS) {
			if (byte === ZERO) numberState = NUMBER_ZERO;
			else if (digit) numberState = NUMBER_INT;
			else {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_ZERO) {
			if (byte === DOT) numberState = NUMBER_AFTER_DOT;
			else if (byte === LOWER_E || byte === UPPER_E) numberState = NUMBER_AFTER_E;
			else {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_INT) {
			if (byte === DOT) numberState = NUMBER_AFTER_DOT;
			else if (byte === LOWER_E || byte === UPPER_E) numberState = NUMBER_AFTER_E;
			else if (!digit) {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_AFTER_DOT) {
			if (digit) numberState = NUMBER_FRAC;
			else {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_FRAC) {
			if (byte === LOWER_E || byte === UPPER_E) numberState = NUMBER_AFTER_E;
			else if (!digit) {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_AFTER_E) {
			if (byte === MINUS || byte === PLUS) numberState = NUMBER_AFTER_E_SIGN;
			else if (digit) numberState = NUMBER_EXP;
			else {
				malformed = true;
				return;
			}
		} else if (numberState === NUMBER_AFTER_E_SIGN) {
			if (digit) numberState = NUMBER_EXP;
			else {
				malformed = true;
				return;
			}
		} else if (!digit) {
			malformed = true;
			return;
		}
		if (numberEmit) emit(byte);
	};

	const beginLiteral = (byte, shouldEmit) => {
		literalWord = byte === 0x74 ? "true" : byte === 0x66 ? "false" : "null";
		literalIndex = 1;
		literalEmit = shouldEmit;
		state = STATE_LITERAL;
		if (shouldEmit) emit(byte);
	};

	const stepLiteral = (byte) => {
		if (byte !== literalWord.charCodeAt(literalIndex)) {
			malformed = true;
			return;
		}
		if (literalEmit) emit(byte);
		literalIndex += 1;
		if (literalIndex === literalWord.length) finishValue();
	};

	const beginNumber = (byte, shouldEmit) => {
		numberState = NUMBER_START;
		numberEmit = shouldEmit;
		state = STATE_NUMBER;
		stepNumber(byte);
	};

	const beginFullValue = (byte) => {
		if (byte === QUOTE) {
			beginString("value", "full-buffer", null, null, null);
			return;
		}
		if (byte === OPEN_OBJECT) {
			emit(OPEN_OBJECT);
			if (pushFrame("obj", "full")) state = STATE_KEY;
			return;
		}
		if (byte === OPEN_ARRAY) {
			emit(OPEN_ARRAY);
			if (pushFrame("arr", "full")) state = STATE_VALUE;
			return;
		}
		if (byte === MINUS || isDigit(byte)) {
			beginNumber(byte, true);
			return;
		}
		if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
			beginLiteral(byte, true);
			return;
		}
		malformed = true;
	};

	const beginDropValue = (byte) => {
		if (byte === QUOTE) {
			beginString("value", "skip", null, null, null);
			return;
		}
		if (byte === OPEN_OBJECT) {
			if (pushFrame("obj", "skip")) state = STATE_KEY;
			return;
		}
		if (byte === OPEN_ARRAY) {
			if (pushFrame("arr", "skip")) state = STATE_VALUE;
			return;
		}
		if (byte === MINUS || isDigit(byte)) {
			beginNumber(byte, false);
			return;
		}
		if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
			beginLiteral(byte, false);
			return;
		}
		malformed = true;
	};

	const closeFrame = () => {
		const frame = stack.pop();
		if (frame.out !== "skip") emit(frame.kind === "obj" ? CLOSE_OBJECT : CLOSE_ARRAY);
		finishValue();
	};

	const stepValue = (byte) => {
		if (isWhitespace(byte)) return;
		const frame = stack.length ? top() : undefined;
		if (!frame) {
			if (rootSeen) {
				malformed = true;
				return;
			}
			rootSeen = true;
			if (byte === OPEN_OBJECT) {
				emit(OPEN_OBJECT);
				if (pushFrame("obj", "root")) state = STATE_KEY;
				return;
			}
			beginDropValue(byte);
			return;
		}
		if (frame.kind === "arr") {
			if (frame.first && byte === CLOSE_ARRAY) {
				closeFrame();
				return;
			}
			frame.first = false;
			if (frame.out === "full") {
				if (frame.outCount > 0) emit(COMMA);
				frame.outCount += 1;
				beginFullValue(byte);
			} else {
				beginDropValue(byte);
			}
			return;
		}
		frame.first = false;
		const key = pendingKey;
		pendingKey = undefined;
		clearMemberFlags(frame, key);
		if (frame.out === "skip") {
			beginDropValue(byte);
			return;
		}
		if (frame.out === "full") {
			beginFullValue(byte);
			return;
		}
		const plan = memberPlan(frame.out, key);
		if (plan.kind === "object") {
			if (byte === OPEN_OBJECT) {
				emitMemberPrefix(frame, key);
				emit(OPEN_OBJECT);
				if (pushFrame("obj", plan.frame)) state = STATE_KEY;
				return;
			}
			emitMemberPrefix(frame, key);
			emitNull();
			beginDropValue(byte);
			return;
		}
		if (plan.kind === "full") {
			emitMemberPrefix(frame, key);
			beginFullValue(byte);
			return;
		}
		if (plan.kind === "string" || plan.kind === "identity") {
			if (byte === QUOTE) {
				beginString("value", "buffer", plan.flagPath ?? null, frame, key);
				return;
			}
			if (byte === MINUS || isDigit(byte)) {
				emitMemberPrefix(frame, key);
				beginNumber(byte, true);
				return;
			}
			if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
				emitMemberPrefix(frame, key);
				beginLiteral(byte, true);
				return;
			}
			emitMemberPrefix(frame, key);
			emitNull();
			beginDropValue(byte);
			return;
		}
		beginDropValue(byte);
	};

	const stepKey = (byte) => {
		if (isWhitespace(byte)) return;
		const frame = top();
		if (byte === CLOSE_OBJECT) {
			if (!frame.first) {
				malformed = true;
				return;
			}
			closeFrame();
			return;
		}
		if (byte === QUOTE) {
			if (frame.out === "full") beginString("key", "key-full", null, null, null);
			else if (frame.out === "skip") beginString("key", "skip", null, null, null);
			else beginString("key", "key-filter", null, null, null);
			return;
		}
		malformed = true;
	};

	const stepAfter = (byte) => {
		if (isWhitespace(byte)) return;
		const frame = top();
		if (!frame) {
			malformed = true;
			return;
		}
		if (frame.kind === "obj") {
			if (byte === COMMA) {
				state = STATE_KEY;
				return;
			}
			if (byte === CLOSE_OBJECT) {
				closeFrame();
				return;
			}
			malformed = true;
			return;
		}
		if (byte === COMMA) {
			state = STATE_VALUE;
			return;
		}
		if (byte === CLOSE_ARRAY) {
			closeFrame();
			return;
		}
		malformed = true;
	};

	const step = (byte) => {
		if (stringCtx) {
			stepString(byte);
			return;
		}
		if (state === STATE_NUMBER) {
			stepNumber(byte);
			return;
		}
		if (state === STATE_LITERAL) {
			stepLiteral(byte);
			return;
		}
		if (state === STATE_VALUE) {
			stepValue(byte);
			return;
		}
		if (state === STATE_KEY) {
			stepKey(byte);
			return;
		}
		if (state === STATE_COLON) {
			if (isWhitespace(byte)) return;
			if (byte === COLON) state = STATE_VALUE;
			else malformed = true;
			return;
		}
		if (state === STATE_AFTER) {
			stepAfter(byte);
			return;
		}
		if (!isWhitespace(byte)) malformed = true;
	};

	const push = (chunk) => {
		if (finished || oversized) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		for (let index = 0; index < buffer.length; index += 1) {
			if (oversized) return;
			step(buffer[index]);
		}
	};

	const finish = () => {
		if (finished) return result;
		finished = true;
		if (oversized) return undefined;
		if (stringCtx) {
			stringCtx = null;
			malformed = true;
		}
		if (state === STATE_NUMBER) {
			if (!validNumberEnd()) malformed = true;
		} else if (state !== STATE_END) {
			malformed = true;
		}
		if (stack.length) malformed = true;
		if (malformed || oversized) return undefined;
		if (part) {
			parts.push(partFill === part.length ? part : part.subarray(0, partFill));
			part = undefined;
		}
		const text = total > 0 ? Buffer.concat(parts, total).toString("utf8") : "null";
		parts = [];
		let entry;
		try {
			entry = JSON.parse(text);
		} catch {
			malformed = true;
			return undefined;
		}
		applyTruncatedIdentities(entry, flags);
		result = entry;
		return entry;
	};

	return {
		push,
		finish,
		get malformed() {
			return malformed;
		},
		get oversized() {
			return oversized;
		},
	};
}
function newAccumulator(start) {
	return { start, kind: "buffer", parts: [], len: 0 };
}

function appendBytes(accumulator, bytes) {
	if (!bytes.length) return accumulator;
	let acc = accumulator;
	if (acc.kind === "buffer") {
		acc.parts.push(Buffer.from(bytes));
		acc.len += bytes.length;
		if (acc.len > RECORD_PARSE_LIMIT) {
			const scanner = createRecordScanner();
			let first = true;
			for (const part of acc.parts) {
				const piece = first && acc.start === 0 ? stripBomBuffer(part) : part;
				first = false;
				if (piece.length) scanner.push(piece);
			}
			acc = { start: acc.start, kind: "scanner", scanner };
		}
	} else {
		acc.scanner.push(bytes);
	}
	return acc;
}

function accumulatorText(acc) {
	let buffer = acc.parts.length ? Buffer.concat(acc.parts, acc.len) : Buffer.alloc(0);
	if (acc.start === 0) buffer = stripBomBuffer(buffer);
	const text = buffer.toString("utf8");
	const end = text.endsWith("\r") ? text.length - 1 : text.length;
	return stripBomText(text.slice(0, end));
}

function finishRecord(totals, acc) {
	if (acc.kind === "scanner") {
		const entry = acc.scanner.finish();
		if (acc.scanner.malformed) {
			totals.diagnostics.badLines += 1;
			return;
		}
		if (acc.scanner.oversized) {
			totals.diagnostics.skippedLines += 1;
			totals.modelsIncomplete = true;
			return;
		}
		consumeEntry(totals, entry);
		return;
	}
	const text = accumulatorText(acc);
	if (!text.trim()) {
		totals.diagnostics.skippedLines += 1;
		return;
	}
	if (!wantsUsage(text)) {
		totals.diagnostics.skippedLines += 1;
		return;
	}
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		totals.diagnostics.badLines += 1;
		return;
	}
	consumeEntry(totals, entry);
}

function finalFragment(acc) {
	if (acc.kind === "scanner") {
		const entry = acc.scanner.finish();
		if (acc.scanner.malformed) return undefined;
		return acc.scanner.oversized ? { [MODELS_INCOMPLETE]: true } : entry;
	}
	const text = accumulatorText(acc);
	if (!text.trim() || !wantsUsage(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readRange(fd, position, length) {
	if (length <= 0) return Buffer.alloc(0);
	const buffer = Buffer.allocUnsafe(length);
	let got = 0;
	while (got < length) {
		const n = fs.readSync(fd, buffer, got, length - got, position + got);
		if (n === 0) break;
		got += n;
	}
	return got === length ? buffer : buffer.subarray(0, got);
}

/**
 * Read token usage from `file`, resuming from the persisted fields in `from`.
 * Returns null for a missing file; read errors throw. `offset` is the end of the
 * last complete record, `scanOffset`/`partial` an in-memory record in progress,
 * and `effective` = committed `usage` + the valid EOF `overlay`.
 */
export function readUsage(file, from, { maxBytes = Infinity } = {}) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		const size = stat.size;
		const mtimeMs = stat.mtimeMs;
		const ino = stat.ino;
		const birthtimeMs = stat.birthtimeMs;
		const hashRange = (position, length) => sha1(readRange(fd, position, length));

		let restart =
			!isObject(from) ||
			!isObject(from.usage) ||
			from.offset === undefined ||
			from.headLen === undefined ||
			typeof from.head !== "string" ||
			typeof from.tail !== "string";
		if (!restart) {
			if (size < from.size) {
				restart = true;
			} else if (from.ino === undefined || from.birthtimeMs === undefined || ino !== from.ino || birthtimeMs !== from.birthtimeMs) {
				restart = true;
			} else if (hashRange(0, from.headLen) !== from.head) {
				restart = true;
			} else if (hashRange(from.offset - Math.min(from.offset, HEAD_LIMIT), Math.min(from.offset, HEAD_LIMIT)) !== from.tail) {
				restart = true;
			} else if (size === from.size && from.mtimeMs !== mtimeMs) {
				restart = true;
			}
		}

		let usage;
		let offset;
		let scanOffset;
		let partial;
		let headLen;
		let head;
		if (restart) {
			usage = emptyUsage();
			offset = 0;
			scanOffset = 0;
			partial = undefined;
			headLen = Math.min(size, HEAD_LIMIT);
			head = hashRange(0, headLen);
		} else {
			usage = cloneUsage(from.usage);
			offset = from.offset;
			const resumable = isObject(from.partial) && Number.isInteger(from.scanOffset) && from.partial.start === offset;
			scanOffset = resumable ? from.scanOffset : offset;
			partial = resumable ? from.partial : undefined;
			headLen = from.headLen;
			head = from.head;
			if (headLen < HEAD_LIMIT && size > headLen) {
				headLen = Math.min(size, HEAD_LIMIT);
				head = hashRange(0, headLen);
			}
		}

		let position = scanOffset;
		const end = Math.min(size, scanOffset + maxBytes);
		let bytesRead = 0;
		let acc = partial;
		while (position < end) {
			const want = Math.min(READ_CHUNK, end - position);
			const chunk = readRange(fd, position, want);
			if (!chunk.length) break;
			const chunkStart = position;
			position += chunk.length;
			bytesRead += chunk.length;
			if (!acc) acc = newAccumulator(chunkStart);
			let index = 0;
			for (;;) {
				const newline = chunk.indexOf(NEWLINE, index);
				if (newline === -1) {
					acc = appendBytes(acc, chunk.subarray(index));
					break;
				}
				acc = appendBytes(acc, chunk.subarray(index, newline));
				finishRecord(usage, acc);
				offset = chunkStart + newline + 1;
				acc = newline + 1 >= chunk.length ? undefined : newAccumulator(chunkStart + newline + 1);
				index = newline + 1;
				if (index >= chunk.length) break;
			}
		}

		const overlay = emptyUsage();
		if (acc) {
			if (position === size) {
				const entry = finalFragment(acc);
				if (entry !== undefined) consumeEntry(overlay, entry);
				partial = undefined;
			} else {
				partial = acc;
			}
		}
		const evaluatedTo = position;
		const effective = cloneUsage(usage);
		mergeUsage(effective, overlay);
		const tailLength = Math.min(offset, HEAD_LIMIT);
		return {
			offset,
			scanOffset: position,
			partial,
			size,
			mtimeMs,
			ino,
			birthtimeMs,
			head,
			headLen,
			tail: hashRange(offset - tailLength, tailLength),
			usage,
			overlay,
			effective,
			done: evaluatedTo === size,
			evaluatedTo,
			bytesRead,
		};
	} finally {
		fs.closeSync(fd);
	}
}

function toolsEntry(stats, name) {
	let entry = stats.tools.get(name);
	if (!entry) {
		entry = { calls: 0, errors: 0 };
		stats.tools.set(name, entry);
	}
	return entry;
}

function timestampOf(entry, message) {
	const parsed = Date.parse(entry.timestamp);
	if (Number.isFinite(parsed)) return parsed;
	return Number.isFinite(message.timestamp) ? message.timestamp : NaN;
}

function imageBytes(item) {
	if (Number.isFinite(item.bytes) && item.bytes >= 0) return item.bytes;
	const base64 = typeof item.data === "string" ? item.data : typeof item.source?.data === "string" ? item.source.data : undefined;
	return base64 === undefined ? 0 : Buffer.byteLength(base64, "base64");
}

function countImages(stats, content) {
	if (!Array.isArray(content)) return;
	let count = 0;
	let bytes = 0;
	for (const item of content) {
		if (!isObject(item) || item.type !== "image") continue;
		count += 1;
		bytes += imageBytes(item);
	}
	if (count > stats.segmentCount) stats.segmentCount = count;
	if (bytes > stats.segmentBytes) stats.segmentBytes = bytes;
}

function consumeTimelineStats(stats, entry, options) {
	if (entry.type === "compaction") {
		stats.peakCount = Math.max(stats.peakCount, stats.segmentCount);
		stats.peakBytes = Math.max(stats.peakBytes, stats.segmentBytes);
		stats.segmentCount = 0;
		stats.segmentBytes = 0;
		return;
	}
	if (entry.type !== "message" || !isObject(entry.message)) return;
	const message = entry.message;
	if (message.role === "assistant") {
		const usage = isObject(message.usage) ? message.usage : undefined;
		const input = usage ? nonNegative(usage.input) : 0;
		const output = usage ? nonNegative(usage.output) : 0;
		const cacheRead = usage ? nonNegative(usage.cacheRead) : 0;
		const cacheWrite = usage ? nonNegative(usage.cacheWrite) : 0;
		const total = input + output + cacheRead + cacheWrite;
		const ms = timestampOf(entry, message);
		if (usage && Number.isFinite(ms)) {
			const hourMs = Math.floor(ms / 3_600_000) * 3_600_000;
			const hour = stats.hours.get(hourMs) ?? { hourMs, tokens: 0, turns: 0 };
			hour.tokens += total;
			hour.turns += 1;
			stats.hours.set(hourMs, hour);
		}
		if (usage) {
			stats.turns.push({
				ms,
				key: `${message.provider}/${message.responseModel ?? message.model}`,
				input,
				output,
				cacheRead,
				cacheWrite,
				total,
				stopReason: message.stopReason,
			});
			const denominator = input + cacheRead + cacheWrite;
			if (cacheWrite >= options.cacheStormWrite && cacheRead < options.cacheStormReadFrac * denominator) {
				stats.stormTurns += 1;
			}
		}
		if (message.stopReason === "error") {
			stats.errors.count += 1;
			const cls = classifyProviderError(message.errorMessage);
			stats.errors.byClass[cls] = (stats.errors.byClass[cls] ?? 0) + 1;
		}
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (isObject(item) && item.type === "toolCall" && typeof item.name === "string") {
					toolsEntry(stats, item.name).calls += 1;
				}
			}
		}
		return;
	}
	if (message.role === "toolResult") {
		if (message.isError === true && typeof message.toolName === "string") {
			toolsEntry(stats, message.toolName).errors += 1;
		}
		countImages(stats, message.content);
		return;
	}
	if (message.role === "user") countImages(stats, message.content);
}

function consumeTimelineRecord(totals, stats, acc, options) {
	if (acc.kind === "scanner") {
		const entry = acc.scanner.finish();
		if (acc.scanner.malformed) {
			totals.diagnostics.badLines += 1;
			return;
		}
		if (acc.scanner.oversized) {
			totals.diagnostics.skippedLines += 1;
			totals.modelsIncomplete = true;
			return;
		}
		consumeEntry(totals, entry);
		return;
	}
	const text = accumulatorText(acc);
	if (!text.trim()) {
		totals.diagnostics.skippedLines += 1;
		return;
	}
	const usageWanted = wantsUsage(text);
	const statsWanted = wantsStats(text);
	if (!usageWanted && !statsWanted) {
		totals.diagnostics.skippedLines += 1;
		return;
	}
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		totals.diagnostics.badLines += 1;
		return;
	}
	if (usageWanted) consumeEntry(totals, entry);
	consumeTimelineStats(stats, entry, options);
}

function consumeTimelineFragment(totals, stats, acc, options) {
	if (acc.kind === "scanner") {
		const entry = acc.scanner.finish();
		if (acc.scanner.malformed) return;
		if (acc.scanner.oversized) {
			totals.modelsIncomplete = true;
			return;
		}
		consumeEntry(totals, entry);
		return;
	}
	const text = accumulatorText(acc);
	if (!text.trim()) return;
	const usageWanted = wantsUsage(text);
	const statsWanted = wantsStats(text);
	if (!usageWanted && !statsWanted) return;
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		return;
	}
	if (usageWanted) consumeEntry(totals, entry);
	consumeTimelineStats(stats, entry, options);
}

/**
 * One-pass session report for the audit bundle: the same totals as a full
 * `readUsage` plus hour buckets, the largest turns, cache storms, provider
 * error classes, tool counts and image peaks. Returns null for a missing file
 * or one above `maxFileBytes`.
 */
export function usageTimeline(file, { cacheStormWrite = Infinity, cacheStormReadFrac = 0, maxFileBytes = 256 * 1024 * 1024 } = {}) {
	const started = performance.now();
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		const size = stat.size;
		if (size > maxFileBytes) return null;
		const totals = emptyUsage();
		const stats = {
			hours: new Map(),
			turns: [],
			errors: { count: 0, byClass: {} },
			tools: new Map(),
			stormTurns: 0,
			peakCount: 0,
			peakBytes: 0,
			segmentCount: 0,
			segmentBytes: 0,
		};
		const options = { cacheStormWrite, cacheStormReadFrac };
		let position = 0;
		let acc;
		while (position < size) {
			const want = Math.min(READ_CHUNK, size - position);
			const chunk = readRange(fd, position, want);
			if (!chunk.length) break;
			const chunkStart = position;
			position += chunk.length;
			if (!acc) acc = newAccumulator(chunkStart);
			let index = 0;
			for (;;) {
				const newline = chunk.indexOf(NEWLINE, index);
				if (newline === -1) {
					acc = appendBytes(acc, chunk.subarray(index));
					break;
				}
				acc = appendBytes(acc, chunk.subarray(index, newline));
				consumeTimelineRecord(totals, stats, acc, options);
				acc = newline + 1 >= chunk.length ? undefined : newAccumulator(chunkStart + newline + 1);
				index = newline + 1;
				if (index >= chunk.length) break;
			}
		}
		if (acc) consumeTimelineFragment(totals, stats, acc, options);
		stats.peakCount = Math.max(stats.peakCount, stats.segmentCount);
		stats.peakBytes = Math.max(stats.peakBytes, stats.segmentBytes);
		const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
		return {
			totals,
			hours: [...stats.hours.values()].sort((a, b) => a.hourMs - b.hourMs).slice(-240),
			topTurns: stats.turns.slice().sort((a, b) => b.total - a.total).slice(0, 10),
			cache: {
				hitRate: denominator > 0 ? totals.cacheRead / denominator : null,
				stormTurns: stats.stormTurns,
			},
			errors: stats.errors,
			tools: [...stats.tools]
				.map(([name, value]) => ({ name, calls: value.calls, errors: value.errors }))
				.sort((a, b) => b.calls - a.calls || b.errors - a.errors || a.name.localeCompare(b.name))
				.slice(0, 20),
			images: { peakCount: stats.peakCount, peakMiB: stats.peakBytes / (1024 * 1024) },
			prepMs: performance.now() - started,
		};
	} finally {
		fs.closeSync(fd);
	}
}
