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
const CARRIAGE = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const BRACE_OPEN = 0x7b;
const BRACE_CLOSE = 0x7d;
const BRACKET_OPEN = 0x5b;
const BRACKET_CLOSE = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const LOWER_U = 0x75;
const LOWER_B = 0x62;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const STRING_CAPTURE_LIMIT = 64 * 1024;
const STRING_CHUNK_SIZE = 4096;
const MODEL_ID_TOO_LONG = "(model id too long)";
const TOO_LONG = Symbol("scannerStringTooLong");
const MODELS_INCOMPLETE = Symbol("scannerModelsIncomplete");

const isObject = (value) => typeof value === "object" && value !== null;
const nonNegative = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const isWhitespace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

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

/**
 * Streaming JSON capture for records larger than `RECORD_PARSE_LIMIT`. It tracks
 * object/array depth, strings and escapes across chunk and call boundaries and
 * buffers only the values it captures; every other value is skipped.
 *
 * `push(chunk)` accepts a Buffer/Uint8Array/string. `finish()` returns a
 * synthetic entry (`{type, customType, provider, model, usage, message, data}`)
 * and sets `.malformed` when the record was not valid JSON.
 */
export function createRecordScanner() {
	const root = {};
	const message = {};
	const data = {};
	const stack = [];
	let expect = "start";
	let inString = false;
	let escaped = false;
	let unicodeLeft = 0;
	let stringChunks = [];
	let stringChunk;
	let stringChunkFill = 0;
	let stringLength = 0;
	let stringTarget;
	let stringIsKey = false;
	let stringIsIdentity = false;
	let stringOverflow = false;
	let identityLost = false;
	let literal;
	let capture;
	let malformed = false;
	let done = false;
	let result;

	const currentContainer = () => (stack.length ? stack[stack.length - 1] : undefined);

	const usageHolder = (container) => {
		if (!container) return undefined;
		const key = container.key;
		if (stack.length === 1) return key === "usage" ? root : undefined;
		if (stack.length === 2) {
			const parent = stack[0].key;
			if (parent === "message" && key === "usage") return message;
			if (parent === "data" && key === "usage") return data;
		}
		return undefined;
	};

	const stringValueTarget = (container) => {
		if (!container) return undefined;
		const key = container.key;
		if (stack.length === 1) {
			if (key === "type" || key === "customType" || key === "provider" || key === "model") return root;
			return undefined;
		}
		if (stack.length === 2) {
			const parent = stack[0].key;
			if (parent === "message" && (key === "role" || key === "provider" || key === "model" || key === "responseModel")) return message;
			if (parent === "data" && (key === "phase" || key === "provider" || key === "model")) return data;
		}
		return undefined;
	};

	// Identity strings must never be dropped: a lost provider/model would turn a
	// model id into "undefined" instead of flagging the list incomplete.
	const isIdentityValue = (target, container) => {
		if (!target || !container) return false;
		const key = container.key;
		if (target === message) return key === "provider" || key === "model" || key === "responseModel";
		if (target === root || target === data) return key === "provider" || key === "model";
		return false;
	};

	const decodeString = () => {
		if (stringOverflow) return undefined;
		try {
			return JSON.parse(`"${Buffer.concat(stringChunks, stringLength).toString("utf8")}"`);
		} catch {
			malformed = true;
			if (stringIsIdentity) identityLost = true;
			return undefined;
		}
	};

	// Captured strings are capped at 64 KiB and stored in Buffer chunks: an
	// identity over the cap is dropped (never retained byte by byte), and the
	// record is materialized with the "(model id too long)" key and a models
	// list flagged incomplete.
	const retainStringByte = (byte) => {
		if (!(stringIsKey || stringTarget) || stringOverflow) return;
		if (stringLength >= STRING_CAPTURE_LIMIT) {
			stringOverflow = true;
			return;
		}
		if (!stringChunk || stringChunkFill === stringChunk.length) {
			stringChunk = Buffer.allocUnsafe(Math.min(STRING_CHUNK_SIZE, STRING_CAPTURE_LIMIT - stringLength));
			stringChunkFill = 0;
			stringChunks.push(stringChunk);
		}
		stringChunk[stringChunkFill] = byte;
		stringChunkFill += 1;
		stringLength += 1;
	};

	// A selected key that recurs gets its last value. Clear the previous capture
	// before a new value starts; a null literal replaces it with null. A recurring
	// depth-1 parent (message, data) discards everything captured under the
	// earlier value, because JSON.parse keeps only the last member.
	const clearBucket = (bucket) => {
		for (const key of Object.keys(bucket)) delete bucket[key];
	};
	const clearSelectedValue = (byte) => {
		const container = currentContainer();
		if (!container) return;
		if (stack.length === 1) {
			if (container.key === "message") clearBucket(message);
			else if (container.key === "data") clearBucket(data);
		}
		const target = stringValueTarget(container);
		if (target) {
			const key = container.key;
			if (byte === LOWER_N) target[key] = null;
			else delete target[key];
		}
		const holder = usageHolder(container);
		if (holder) {
			if (byte === LOWER_N) holder.usage = null;
			else delete holder.usage;
		}
	};

	const isHexDigit = (byte) => (byte >= ZERO && byte <= NINE) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
	const isSimpleEscape = (byte) =>
		byte === QUOTE || byte === BACKSLASH || byte === SLASH || byte === LOWER_B || byte === LOWER_F || byte === LOWER_N || byte === LOWER_R || byte === LOWER_T || byte === LOWER_U;

	const isDigit = (byte) => byte >= ZERO && byte <= NINE;
	const isNonZeroDigit = (byte) => byte > ZERO && byte <= NINE;
	const isExponent = (byte) => byte === LOWER_E || byte === UPPER_E;

	const beginLiteral = (byte) => {
		if (byte === 0x74) literal = { token: "true", index: 1 };
		else if (byte === 0x66) literal = { token: "false", index: 1 };
		else if (byte === 0x6e) literal = { token: "null", index: 1 };
		else if (byte === MINUS) literal = { state: "minus" };
		else if (byte === ZERO) literal = { state: "zero" };
		else if (isNonZeroDigit(byte)) literal = { state: "int" };
		else {
			literal = undefined;
			malformed = true;
		}
	};

	const feedLiteral = (byte) => {
		if (!literal) return;
		if (literal.token) {
			if (literal.token.charCodeAt(literal.index) !== byte) malformed = true;
			literal.index += 1;
			return;
		}
		switch (literal.state) {
			case "minus":
				if (byte === ZERO) literal.state = "zero";
				else if (isNonZeroDigit(byte)) literal.state = "int";
				else malformed = true;
				break;
			case "zero":
				if (byte === DOT) literal.state = "fracStart";
				else if (isExponent(byte)) literal.state = "expStart";
				else malformed = true;
				break;
			case "int":
				if (isDigit(byte)) break;
				if (byte === DOT) literal.state = "fracStart";
				else if (isExponent(byte)) literal.state = "expStart";
				else malformed = true;
				break;
			case "fracStart":
				if (isDigit(byte)) literal.state = "frac";
				else malformed = true;
				break;
			case "frac":
				if (isExponent(byte)) literal.state = "expStart";
				else if (!isDigit(byte)) malformed = true;
				break;
			case "expStart":
				if (byte === PLUS || byte === MINUS) literal.state = "expSign";
				else if (isDigit(byte)) literal.state = "exp";
				else malformed = true;
				break;
			case "expSign":
				if (isDigit(byte)) literal.state = "exp";
				else malformed = true;
				break;
			case "exp":
				if (!isDigit(byte)) malformed = true;
				break;
		}
	};

	const endLiteral = () => {
		if (!literal) return false;
		const complete = literal.token
			? literal.index === literal.token.length
			: literal.state === "zero" || literal.state === "int" || literal.state === "frac" || literal.state === "exp";
		literal = undefined;
		return complete;
	};

	const beginString = () => {
		inString = true;
		escaped = false;
		unicodeLeft = 0;
		stringChunks = [];
		stringChunk = undefined;
		stringChunkFill = 0;
		stringLength = 0;
		stringOverflow = false;
		stringIsKey = expect === "key";
		stringIsIdentity = false;
		if (stringIsKey) {
			stringTarget = undefined;
			return;
		}
		if (expect !== "value") malformed = true;
		stringTarget = expect === "value" ? stringValueTarget(currentContainer()) : undefined;
		stringIsIdentity = isIdentityValue(stringTarget, currentContainer());
		if (expect === "value") clearSelectedValue(QUOTE);
	};

	const endString = () => {
		inString = false;
		const container = currentContainer();
		if (stringIsKey) {
			const key = decodeString();
			if (container) container.key = key;
			expect = "colon";
			return;
		}
		if (stringTarget) {
			const value = decodeString();
			if (value !== undefined && container && container.key !== undefined) stringTarget[container.key] = value;
			else if (stringOverflow && stringIsIdentity && container && container.key !== undefined) {
				stringTarget[container.key] = TOO_LONG;
			}
		}
		if (container) container.count += 1;
		expect = "after";
	};

	const openContainer = (byte) => {
		if (expect !== "value" && expect !== "start") malformed = true;
		const type = byte === BRACE_OPEN ? "object" : "array";
		let target;
		if (expect !== "start") {
			clearSelectedValue(byte);
			if (byte === BRACE_OPEN && !capture) target = usageHolder(currentContainer());
		}
		stack.push({ type, key: undefined, count: 0 });
		if (target) capture = { holder: target, key: "usage", depth: stack.length, bytes: [byte] };
		expect = type === "object" ? "key" : "value";
	};

	const closeContainer = (byte) => {
		const type = byte === BRACE_CLOSE ? "object" : "array";
		const container = currentContainer();
		if (!container || container.type !== type) {
			malformed = true;
			return;
		}
		const empty = container.count === 0;
		const closesCleanly =
			type === "object" ? expect === "after" || (empty && expect === "key") : expect === "after" || (empty && expect === "value");
		if (!closesCleanly) malformed = true;
		stack.pop();
		if (capture && stack.length === capture.depth - 1) {
			let value;
			try {
				value = JSON.parse(Buffer.from(capture.bytes).toString("utf8"));
			} catch {
				malformed = true;
			}
			if (value !== undefined) capture.holder[capture.key] = value;
			capture = undefined;
		}
		expect = "after";
		if (!stack.length) {
			done = true;
		} else {
			currentContainer().count += 1;
		}
	};

	const push = (chunk) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		for (let index = 0; index < buffer.length; index += 1) {
			const byte = buffer[index];
			if (done) {
				if (!isWhitespace(byte)) malformed = true;
				continue;
			}
			// A senpi usage object is a few numbers; one over the string cap is not one, and buffering it would break the heap bound.
		if (capture) {
			if (capture.bytes.length >= STRING_CAPTURE_LIMIT) {
				capture = undefined;
				malformed = true;
			} else capture.bytes.push(byte);
		}
			if (inString) {
				if (unicodeLeft > 0) {
					retainStringByte(byte);
					if (!isHexDigit(byte)) malformed = true;
					unicodeLeft -= 1;
					continue;
				}
				if (escaped) {
					retainStringByte(byte);
					escaped = false;
					if (byte === LOWER_U) unicodeLeft = 4;
					else if (!isSimpleEscape(byte)) malformed = true;
					continue;
				}
				if (byte === BACKSLASH) {
					retainStringByte(byte);
					escaped = true;
					continue;
				}
				if (byte === QUOTE) {
					endString();
					continue;
				}
				if (byte < 0x20) malformed = true;
				retainStringByte(byte);
				continue;
			}
			if (expect === "literal") {
				if (isWhitespace(byte)) {
					if (!endLiteral()) malformed = true;
					expect = "after";
					if (currentContainer()) currentContainer().count += 1;
					continue;
				}
				if (byte !== COMMA && byte !== BRACE_CLOSE && byte !== BRACKET_CLOSE) {
					feedLiteral(byte);
					continue;
				}
				if (!endLiteral()) malformed = true;
				expect = "after";
				if (currentContainer()) currentContainer().count += 1;
			} else if (isWhitespace(byte)) {
				continue;
			}
			switch (byte) {
				case QUOTE:
					beginString();
					break;
				case BRACE_OPEN:
				case BRACKET_OPEN:
					openContainer(byte);
					break;
				case BRACE_CLOSE:
				case BRACKET_CLOSE:
					closeContainer(byte);
					break;
				case COMMA:
					if (!stack.length || expect !== "after") {
						malformed = true;
					} else {
						expect = currentContainer().type === "object" ? "key" : "value";
					}
					break;
				case COLON:
					if (expect !== "colon") malformed = true;
					expect = "value";
					break;
				default:
					if (expect === "value") {
						clearSelectedValue(byte);
						beginLiteral(byte);
						expect = "literal";
					} else {
						malformed = true;
					}
					break;
			}
		}
	};

	const finish = () => {
		if (result) return result;
		if (inString || escaped || unicodeLeft > 0 || literal || stack.length > 0 || !done) malformed = true;
		let entry;
		if (!malformed) {
			let incomplete = identityLost;
			const materialize = (bucket) => {
				let lost = false;
				for (const key of Object.keys(bucket)) {
					if (bucket[key] !== TOO_LONG) continue;
					delete bucket[key];
					lost = true;
				}
				if (!lost) return;
				incomplete = true;
				if (typeof bucket.provider !== "string") bucket.provider = "";
				bucket.model = MODEL_ID_TOO_LONG;
				delete bucket.responseModel;
			};
			materialize(root);
			materialize(message);
			materialize(data);
			entry = {};
			if (root.type !== undefined) entry.type = root.type;
			if (root.customType !== undefined) entry.customType = root.customType;
			if (root.provider !== undefined) entry.provider = root.provider;
			if (root.model !== undefined) entry.model = root.model;
			if (root.usage !== undefined) entry.usage = root.usage;
			if (Object.keys(message).length) entry.message = { ...message };
			if (Object.keys(data).length) entry.data = { ...data };
			if (incomplete) entry[MODELS_INCOMPLETE] = true;
		}
		result = entry;
		return entry;
	};

	return {
		push,
		finish,
		get malformed() {
			return malformed;
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
		return acc.scanner.malformed ? undefined : entry;
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
