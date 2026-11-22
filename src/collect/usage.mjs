import crypto from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
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
 * `partial` only live in memory for a record cut by `maxBytes` or EOF.
 */

export const USAGE_TOOLS_KEY = "Tools/summaries";
export const MODEL_KEY_LIMIT = 1000;
export const MODEL_KEY_LENGTH = 256;

const RECORD_PARSE_LIMIT = 16 * 1024 * 1024;
const USAGE_BUFFER_LIMIT = 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
const HEAD_LIMIT = 4096;
const BOM_0 = 0xef;
const BOM_1 = 0xbb;
const BOM_2 = 0xbf;
const NEWLINE = 0x0a;
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
const VALUE_RAW_LIMIT = 64 * 1024;
const KEY_RAW_LIMIT = 128;
const MODEL_ID_TOO_LONG = "(model id too long)";
const MODEL_ID_UNREADABLE = "(model id unreadable)";
const OTHER_MODELS = "(other models)";
const modelMapSizes = new WeakMap();
const TRUNCATED_STRING_ID = Symbol("truncatedStringIdentity");
const TRUNCATED_USAGE = Symbol("truncatedUsage");
const TRUNCATED_VALUE = Object.freeze({});
const RECORD_ACCUMULATOR = Symbol("recordAccumulator");

const STATE_VALUE = 0;
const STATE_KEY = 1;
const STATE_COLON = 2;
const STATE_AFTER = 3;
const STATE_END = 4;
const STATE_NUMBER = 5;
const STATE_LITERAL = 6;
const STATE_FIRST_KEY = 7;
const STATE_FIRST_ELEMENT = 8;

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
/** A parsed JS number counts exactly as supplied (negatives and +/-Infinity too); anything else counts 0. */
const counter = (value) => (typeof value === "number" ? value : 0);
const isWhitespace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte) => byte >= ZERO && byte <= NINE;

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

function modelMapSize(map) {
	let state = modelMapSizes.get(map);
	if (!state) {
		state = { count: 0, last: undefined };
		for (const key in map) {
			if (!Object.hasOwn(map, key)) continue;
			state.count += 1;
			if (key !== OTHER_MODELS) state.last = key;
		}
		modelMapSizes.set(map, state);
	}
	return state;
}

export const emptyModelBilling = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 });

export function addModelCounters(billing, input, output, cacheRead, cacheWrite, cost) {
	billing.input += input;
	billing.output += output;
	billing.cacheRead += cacheRead;
	billing.cacheWrite += cacheWrite;
	// A key's tokens are the four counters as they stand, like getUsageCostBreakdown.
	billing.tokens = billing.input + billing.output + billing.cacheRead + billing.cacheWrite;
	billing.cost += cost;
}

function addModelBilling(totals, key, input, output, cacheRead, cacheWrite, cost) {
	const models = totals.models;
	if (key.length > MODEL_KEY_LENGTH) key = MODEL_ID_TOO_LONG;
	if (!Object.hasOwn(models, key)) {
		const state = modelMapSize(models);
		if (state.count === MODEL_KEY_LIMIT) {
			totals.modelsIncomplete = true;
			key = OTHER_MODELS;
			if (!Object.hasOwn(models, key)) {
				// Make room for the spill bucket without losing the last key's billing.
				models[key] = models[state.last];
				delete models[state.last];
			}
		} else {
			state.count += 1;
			if (key !== OTHER_MODELS) state.last = key;
			models[key] = emptyModelBilling();
		}
	}
	addModelCounters(models[key], input, output, cacheRead, cacheWrite, cost);
}

function addUsedModel(totals, id) {
	const usedModels = totals.usedModels;
	if (Object.hasOwn(usedModels, id)) return;
	const state = modelMapSize(usedModels);
	if (state.count === MODEL_KEY_LIMIT) {
		totals.modelsIncomplete = true;
		return;
	}
	state.count += 1;
	usedModels[id] = true;
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
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "turns"]) {
		if (typeof out[key] !== "number") return undefined;
	}
	if (typeof out.diagnostics.badLines !== "number" || typeof out.diagnostics.skippedLines !== "number") return undefined;
	out.total = out.input + out.output + out.cacheRead + out.cacheWrite;
	for (const [key, value] of Object.entries(src.models ?? {})) {
		if ((!key.includes("/") && key !== MODEL_ID_TOO_LONG && key !== OTHER_MODELS) || !isObject(value)) return undefined;
		const { input, output, cacheRead, cacheWrite, cost } = value;
		if (![input, output, cacheRead, cacheWrite, cost].every((number) => typeof number === "number")) return undefined;
		addModelBilling(out, key, input, output, cacheRead, cacheWrite, cost);
	}
	for (const key of Object.keys(src.usedModels ?? {})) {
		if (!key.includes("/") && key !== MODEL_ID_TOO_LONG) return undefined;
		if (key.length > MODEL_KEY_LENGTH) out.modelsIncomplete = true;
		addUsedModel(out, key.length > MODEL_KEY_LENGTH ? MODEL_ID_TOO_LONG : key);
	}
	return out;
}

function mergeUsage(into, extra) {
	into.input += extra.input;
	into.output += extra.output;
	into.cacheRead += extra.cacheRead;
	into.cacheWrite += extra.cacheWrite;
	into.total = into.input + into.output + into.cacheRead + into.cacheWrite;
	into.cost += extra.cost;
	if (extra.costUnknown) into.costUnknown = true;
	into.turns += extra.turns;
	if (extra.modelsIncomplete) into.modelsIncomplete = true;
	into.diagnostics.skippedLines += extra.diagnostics.skippedLines;
	into.diagnostics.badLines += extra.diagnostics.badLines;
	for (const [key, { input, output, cacheRead, cacheWrite, cost }] of Object.entries(extra.models)) {
		addModelBilling(into, key, input, output, cacheRead, cacheWrite, cost);
	}
	for (const key of Object.keys(extra.usedModels)) addUsedModel(into, key);
}

function billingPart(value) {
	if (typeof value === "string") return value;
	try {
		return String(value);
	} catch {
		return MODEL_ID_UNREADABLE;
	}
}

/** Billing key text for values a JSON line can put where a model id belongs. */
function billingKey(provider, model) {
	const left = billingPart(provider);
	const right = billingPart(model);
	return left.length + 1 + right.length > MODEL_KEY_LENGTH ? MODEL_ID_TOO_LONG : `${left}/${right}`;
}

/** The usage object a record's type/role/customType selects, or undefined. */
function usageCarrier(entry) {
	if (!isObject(entry)) return undefined;
	const type = entry.type;
	if ((type === "usage" || type === "branch_summary" || type === "compaction") && isObject(entry.usage)) return entry.usage;
	if (type === "custom" && entry.customType === "prompt-cache-prewarm") {
		const data = entry.data;
		if (isObject(data) && data.phase === "warmed" && isObject(data.usage)) return data.usage;
		return undefined;
	}
	const message = entry.message;
	if (type === "message" && isObject(message) && isObject(message.usage)) {
		if (message.role === "toolResult" || message.role === "assistant") return message.usage;
	}
	return undefined;
}

/**
 * The usage a single session record contributes, or undefined. Checked in the
 * order omo's `/session` uses.
 */
export function usageOfEntry(entry) {
	if (!isObject(entry)) return undefined;
	const type = entry.type;
	if (type === "usage" && isObject(entry.usage)) {
		return { usage: entry.usage, key: billingKey(entry.provider, entry.model) };
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
				key: billingKey(message.provider, message.responseModel ?? message.model),
				turn: true,
			};
		}
	}
	return undefined;
}

/** Fold one `usageOfEntry` hit into a totals accumulator. */
export function addUsage(totals, hit) {
	const usage = hit.usage;
	const input = counter(usage.input);
	const output = counter(usage.output);
	const cacheRead = counter(usage.cacheRead);
	const cacheWrite = counter(usage.cacheWrite);
	const cost = counter(usage.cost?.total);
	totals.input += input;
	totals.output += output;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	totals.cost += cost;
	if (usage.costUnknown === true) totals.costUnknown = true;
	if (hit.turn) totals.turns += 1;
	addModelBilling(totals, hit.key ?? USAGE_TOOLS_KEY, input, output, cacheRead, cacheWrite, cost);
}

function addModelId(out, provider, model) {
	const known = (value) => typeof value === "string" && value.length > 0;
	const truncated = (value) => value?.[TRUNCATED_STRING_ID] !== undefined;
	if (known(provider) && known(model)) {
		if (provider.length + 1 + model.length > MODEL_KEY_LENGTH) {
			out.ids.push(MODEL_ID_TOO_LONG);
			out.incomplete = true;
		} else out.ids.push(`${provider}/${model}`);
		return true;
	}
	// Both fields were there but at least one lost its tail: the identity is unusable.
	if ((known(provider) || truncated(provider)) && (known(model) || truncated(model))) out.incomplete = true;
	return false;
}

/**
 * Real model ids that processed the session (reviewer exclusion in the audit
 * plan), independent of the billing keys in `models`. Every usage carrier also
 * supplies the identity that produced its usage: assistant/toolResult messages
 * use `message`, compaction/branch_summary entries use the entry root, and
 * prewarm data uses `data`.
 */
export function modelsOfEntry(entry) {
	const out = { ids: [], incomplete: false };
	if (!isObject(entry)) return out;
	const type = entry.type;
	const message = entry.message;
	if (type === "message" && isObject(message)) {
		if (message.role === "assistant") {
			const byModel = addModelId(out, message.provider, message.model);
			const byResponse = addModelId(out, message.provider, message.responseModel);
			if (!byModel && !byResponse) out.incomplete = true;
		}
		if (message.role === "toolResult" && isObject(message.usage)) {
			if (!addModelId(out, message.provider, message.model)) out.incomplete = true;
		}
	}
	if (type === "usage") {
		if (!addModelId(out, entry.provider, entry.model)) out.incomplete = true;
	}
	if (type === "custom" && entry.customType === "prompt-cache-prewarm" && isObject(entry.data)) {
		if (!addModelId(out, entry.data.provider, entry.data.model)) out.incomplete = true;
	}
	if ((type === "compaction" || type === "branch_summary") && isObject(entry.usage)) {
		if (!addModelId(out, entry.provider, entry.model)) out.incomplete = true;
	}
	return out;
}

function consumeEntry(totals, entry, skipUsage = false) {
	if (skipUsage) totals.diagnostics.skippedLines += 1;
	else {
		const hit = usageOfEntry(entry);
		if (hit) addUsage(totals, hit);
	}
	const models = modelsOfEntry(entry);
	for (const id of models.ids) addUsedModel(totals, id);
	if (models.incomplete) totals.modelsIncomplete = true;
}

const USAGE_MARKERS = ['"usage"', '"assistant"', '"prompt-cache-prewarm"'];
const STAT_MARKERS = ['"isError"', '"image"', '"toolCall"', '"compaction"'];

// A standalone JSON string token survives arbitrary separator whitespace.
// An escape anywhere may hide a relevant key or value from either marker set.
const wantsUsage = (text) => text.includes("\\") || USAGE_MARKERS.some((marker) => text.includes(marker));
const wantsStats = (text) => STAT_MARKERS.some((marker) => text.includes(marker));

function stripBomBuffer(buffer) {
	if (buffer.length >= 3 && buffer[0] === BOM_0 && buffer[1] === BOM_1 && buffer[2] === BOM_2) {
		return buffer.subarray(3);
	}
	return buffer;
}

function sha1(buffer) {
	return crypto.createHash("sha1").update(buffer).digest("hex");
}

const COST_FIELDS = { total: "usage" };
// costUnknown is only compared to `true`, so an over-cap value keeps its prefix
// instead of marking the counted usage as unusable.
const USAGE_FIELDS = { input: "usage", output: "usage", cacheRead: "usage", cacheWrite: "usage", costUnknown: "value", cost: COST_FIELDS };
const ROOT_FIELDS = {
	type: "value", customType: "value", provider: "identity", model: "identity", usage: USAGE_FIELDS,
	message: { role: "value", provider: "identity", model: "identity", responseModel: "identity", usage: USAGE_FIELDS },
	data: { phase: "value", provider: "identity", model: "identity", usage: USAGE_FIELDS },
};
const NUMBER_DIGITS = 800;

function newDecimal(negative) {
	return { negative, digits: "", sticky: false, integerDigits: 0, leadingZeros: 0, exponent: 0, exponentSign: 1 };
}

function rememberDigit(decimal, byte, numberState) {
	if (numberState === NUMBER_EXP) {
		decimal.exponent = Math.min(Number.MAX_SAFE_INTEGER, decimal.exponent * 10 + byte - ZERO);
		return;
	}
	if (numberState !== NUMBER_FRAC) decimal.integerDigits += 1;
	if (decimal.digits.length === 0 && byte === ZERO) decimal.leadingZeros += 1;
	else if (decimal.digits.length < NUMBER_DIGITS) decimal.digits += String.fromCharCode(byte);
	else if (byte !== ZERO) decimal.sticky = true;
}

function roundedDecimal(decimal) {
	if (decimal.digits.length === 0) return decimal.negative ? -0 : 0;
	const { negative, digits, sticky, integerDigits, leadingZeros, exponent, exponentSign } = decimal;
	const scale = integerDigits - leadingZeros - 1 + exponentSign * exponent;
	// A binary64 rounding midpoint has at most 768 significant decimal digits.
	// After 800 digits only exact equality to a midpoint can depend on the tail.
	return Number((negative ? "-" : "") + digits[0] + "." + digits.slice(1) + (sticky ? "1" : "") + "e" + scale);
}

function truncatedIdentity(prefix) {
	return {
		[TRUNCATED_STRING_ID]: prefix,
		[Symbol.toPrimitive]: () => MODEL_ID_TOO_LONG,
	};
}

const TRUNCATED_NONSTRING_ID = Object.freeze({ [Symbol.toPrimitive]: () => MODEL_ID_TOO_LONG });

/** Validating projection for records above the buffer limit. Only a selected
 * value can own the capture buffer. The stack below the projected objects is
 * just container-kind bits: ancestors always resume in STATE_AFTER. */
export function createRecordScanner() {
	let containers = new Uint8Array(128);
	let depth = 0;
	const projected = [];
	let state = STATE_VALUE;
	let malformed = false;
	let finished = false;
	let entry = null;
	let pendingKey;
	let pendingPlan;
	let string = false;
	let keyString = false;
	let keyLength = 0;
	let escape = 0; // -1 after a backslash; positive while reading hex digits
	let numberState;
	let literal;
	let literalIndex;
	let capture;
	const keyRaw = Buffer.allocUnsafe(KEY_RAW_LIMIT);
	// Allow 64 KiB of string content plus its opener and an overflow sentinel.
	const raw = Buffer.allocUnsafe(VALUE_RAW_LIMIT + 2);

	function openContainer(object) {
		const index = Math.floor(depth / 8);
		if (index === containers.length) {
			const grown = new Uint8Array(containers.length * 2);
			grown.set(containers);
			containers = grown;
		}
		const mask = 1 << (depth % 8);
		if (object) containers[index] |= mask;
		else containers[index] &= ~mask;
		depth += 1;
		state = object ? STATE_FIRST_KEY : STATE_FIRST_ELEMENT;
	}

	function currentObject() {
		const index = depth - 1;
		return (containers[Math.floor(index / 8)] & (1 << (index % 8))) !== 0;
	}

	function beginObject(plan, value) {
		openContainer(true);
		projected.push({ depth, plan, value, truncations: new Set() });
	}

	function keep(byte) {
		if (capture && capture.length < raw.length) raw[capture.length++] = byte;
	}

	function finishValue() {
		if (capture?.depth === depth) {
			const { frame, key, plan, kind, length, decimal, prefixEnd } = capture;
			if (length <= VALUE_RAW_LIMIT) {
				frame.value[key] = JSON.parse(raw.toString("utf8", 0, length));
			} else if (decimal) {
				frame.value[key] = roundedDecimal(decimal);
			} else {
				const prefix = kind === QUOTE
					? JSON.parse('"' + new StringDecoder("utf8").write(raw.subarray(1, prefixEnd)) + '"')
					: undefined;
				if (plan === "identity") frame.value[key] = prefix === undefined ? TRUNCATED_NONSTRING_ID : truncatedIdentity(prefix);
				else frame.value[key] = prefix ?? TRUNCATED_VALUE;
				if (plan === "usage" || plan === USAGE_FIELDS || plan === COST_FIELDS) frame.truncations.add(key);
			}
			capture = undefined;
		}
		state = depth === 0 ? STATE_END : STATE_AFTER;
	}

	function closeContainer() {
		const frame = projected.at(-1);
		if (frame?.depth === depth) {
			if (frame.truncations.size) frame.value[TRUNCATED_USAGE] = frame.truncations;
			projected.pop();
		}
		depth -= 1;
		finishValue();
	}

	function beginValue(byte) {
		const frame = projected.at(-1);
		if (depth === 0 && byte === OPEN_OBJECT) {
			entry = {};
			beginObject(ROOT_FIELDS, entry);
			return;
		}
		if (pendingPlan !== undefined) {
			const key = pendingKey;
			const plan = pendingPlan;
			pendingPlan = undefined;
			frame.truncations.delete(key);
			if (typeof plan === "object" && byte === OPEN_OBJECT) {
				const value = {};
				frame.value[key] = value;
				beginObject(plan, value);
				return;
			}
			capture = { depth, frame, key, plan, kind: byte, length: 0, prefixEnd: 1, decimal: undefined };
			keep(byte); // step() did not yet have a capture for this byte.
		}

		if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) openContainer(byte === OPEN_OBJECT);
		else if (byte === QUOTE) {
			string = true;
			keyString = false;
		} else if (byte === MINUS || isDigit(byte)) {
			numberState = byte === MINUS ? NUMBER_AFTER_MINUS : byte === ZERO ? NUMBER_ZERO : NUMBER_INT;
			state = STATE_NUMBER;
			if (capture?.depth === depth) {
				capture.decimal = newDecimal(byte === MINUS);
				if (isDigit(byte)) rememberDigit(capture.decimal, byte, numberState);
			}
		} else {
			literal = byte === 0x74 ? "true" : byte === 0x66 ? "false" : byte === 0x6e ? "null" : undefined;
			if (literal === undefined) malformed = true;
			else {
				literalIndex = 1;
				state = STATE_LITERAL;
			}
		}
	}

	function stepString(byte) {
		if (escape > 0) {
			if (!isHexDigit(byte)) malformed = true;
			escape -= 1;
		} else if (escape === -1) {
			if (!isSimpleEscape(byte)) malformed = true;
			escape = byte === LOWER_U ? 4 : 0;
		} else if (byte === QUOTE) {
			string = false;
			if (keyString) {
				const frame = projected.at(-1);
				if (frame?.depth === depth && keyLength <= KEY_RAW_LIMIT) {
					const key = JSON.parse('"' + keyRaw.toString("utf8", 0, keyLength) + '"');
					if (Object.hasOwn(frame.plan, key)) {
						pendingKey = key;
						pendingPlan = frame.plan[key];
					}
				}
				state = STATE_COLON;
			} else finishValue();
			return;
		} else if (byte === BACKSLASH) escape = -1;
		else if (byte < 0x20) malformed = true;

		if (keyString) {
			if (keyLength < KEY_RAW_LIMIT) keyRaw[keyLength++] = byte;
			else keyLength = KEY_RAW_LIMIT + 1;
		} else if (capture?.depth === depth && escape === 0 && capture.length < raw.length) {
			capture.prefixEnd = capture.length;
		}
	}

	function numberCanEnd() {
		return numberState === NUMBER_ZERO || numberState === NUMBER_INT || numberState === NUMBER_FRAC || numberState === NUMBER_EXP;
	}

	// False means this byte ends the number and must be reprocessed as syntax.
	function stepNumber(byte) {
		if (isDigit(byte)) {
			switch (numberState) {
				case NUMBER_AFTER_MINUS: numberState = byte === ZERO ? NUMBER_ZERO : NUMBER_INT; break;
				case NUMBER_ZERO: malformed = true; return true;
				case NUMBER_AFTER_DOT: numberState = NUMBER_FRAC; break;
				case NUMBER_AFTER_E:
				case NUMBER_AFTER_E_SIGN: numberState = NUMBER_EXP; break;
			}
			if (capture?.decimal) rememberDigit(capture.decimal, byte, numberState);
		} else if (byte === DOT && (numberState === NUMBER_ZERO || numberState === NUMBER_INT)) {
			numberState = NUMBER_AFTER_DOT;
		} else if ((byte === LOWER_E || byte === UPPER_E) && (numberState === NUMBER_ZERO || numberState === NUMBER_INT || numberState === NUMBER_FRAC)) {
			numberState = NUMBER_AFTER_E;
		} else if ((byte === PLUS || byte === MINUS) && numberState === NUMBER_AFTER_E) {
			numberState = NUMBER_AFTER_E_SIGN;
			if (capture?.decimal && byte === MINUS) capture.decimal.exponentSign = -1;
		} else return false;
		return true;
	}

	function step(byte) {
		if (string) {
			keep(byte);
			stepString(byte);
			return;
		}
		if (state === STATE_NUMBER) {
			if (stepNumber(byte)) {
				keep(byte);
				return;
			}
			if (!numberCanEnd()) {
				malformed = true;
				return;
			}
			finishValue();
		}
		if (state === STATE_LITERAL) {
			if (byte !== literal.charCodeAt(literalIndex++)) malformed = true;
			else {
				keep(byte);
				if (literalIndex === literal.length) finishValue();
			}
			return;
		}
		if (isWhitespace(byte)) return;
		keep(byte);
		switch (state) {
			case STATE_FIRST_KEY:
				if (byte === CLOSE_OBJECT) { closeContainer(); return; }
				// fall through
			case STATE_KEY:
				if (byte === QUOTE) {
					string = true;
					keyString = true;
					keyLength = projected.at(-1)?.depth === depth ? 0 : KEY_RAW_LIMIT + 1;
					return;
				}
				break;
			case STATE_COLON:
				if (byte === COLON) { state = STATE_VALUE; return; }
				break;
			case STATE_FIRST_ELEMENT:
				if (byte === CLOSE_ARRAY) { closeContainer(); return; }
				// fall through
			case STATE_VALUE:
				beginValue(byte);
				return;
			case STATE_AFTER: {
				const object = currentObject();
				if (byte === COMMA) { state = object ? STATE_KEY : STATE_VALUE; return; }
				if (byte === (object ? CLOSE_OBJECT : CLOSE_ARRAY)) { closeContainer(); return; }
				break;
			}
		}
		malformed = true;
	}

	return {
		push(chunk) {
			if (finished || malformed) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			for (let i = 0; i < bytes.length && !malformed; i += 1) step(bytes[i]);
		},
		finish() {
			if (!finished) {
				finished = true;
				if (state === STATE_NUMBER && numberCanEnd()) finishValue();
				if (string || state !== STATE_END || depth !== 0) malformed = true;
			}
			return malformed ? undefined : entry;
		},
		// Only an object can contribute usage, and its closing brace already
		// completes it. Do not finalize a torn object at a provisional EOF.
		preview() {
			return !malformed && state === STATE_END ? entry : undefined;
		},
		get malformed() {
			return malformed;
		},
		get oversized() {
			if (malformed || state !== STATE_END || !entry) return false;
			const carrier = usageCarrier(entry);
			if (!carrier) return false;
			if (carrier[TRUNCATED_USAGE]?.size) return true;
			const cost = carrier.cost;
			return isObject(cost) && (cost[TRUNCATED_USAGE]?.size ?? 0) > 0;
		},
	};
}

function newAccumulator(start) {
	return { [RECORD_ACCUMULATOR]: true, start, kind: "buffer", parts: [], len: 0 };
}

function appendBytes(accumulator, bytes) {
	if (!bytes.length) return accumulator;
	let acc = accumulator;
	if (acc.kind === "buffer") {
		if (acc.len + bytes.length > RECORD_PARSE_LIMIT) {
			const scanner = createRecordScanner();
			const parts = [...acc.parts, bytes];
			let skip = 0;
			if (acc.start === 0) {
				const first = parts[0].length < 3 ? Buffer.concat(parts.slice(0, 3), 3) : parts[0];
				if (stripBomBuffer(first) !== first) skip = 3;
			}
			for (const part of parts) {
				const consumed = Math.min(skip, part.length);
				skip -= consumed;
				scanner.push(part.subarray(consumed));
			}
			acc = { [RECORD_ACCUMULATOR]: true, start: acc.start, kind: "scanner", scanner };
		} else {
			acc.parts.push(Buffer.from(bytes));
			acc.len += bytes.length;
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
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function finishRecord(totals, acc) {
	if (acc.kind === "scanner") {
		consumeScannerRecord(totals, acc.scanner);
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
	const text = accumulatorText(acc);
	if (!text.trim() || !wantsUsage(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function consumeScannerRecord(totals, scanner, fragment = false) {
	if (fragment) {
		const entry = scanner.preview();
		if (entry) consumeEntry(totals, entry, scanner.oversized);
		return;
	}
	const entry = scanner.finish();
	if (scanner.malformed) {
		totals.diagnostics.badLines += 1;
		return;
	}
	consumeEntry(totals, entry, scanner.oversized);
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
			!Number.isSafeInteger(from.size) || from.size < 0 ||
			!Number.isSafeInteger(from.offset) || from.offset < 0 || from.offset > from.size ||
			!Number.isSafeInteger(from.headLen) || from.headLen < 0 || from.headLen > Math.min(from.size, HEAD_LIMIT) ||
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
		let cachedOverlay;
		const savedUsage = restart ? undefined : cloneUsage(from.usage);
		if (!savedUsage) {
			usage = emptyUsage();
			offset = 0;
			scanOffset = 0;
			partial = undefined;
			headLen = Math.min(size, HEAD_LIMIT);
			head = hashRange(0, headLen);
		} else {
			usage = savedUsage;
			offset = from.offset;
			const resumable = from.partial?.[RECORD_ACCUMULATOR] === true && Number.isInteger(from.scanOffset) && from.partial.start === offset;
			if (resumable && from.partial.kind === "reread" && size === from.size) {
				cachedOverlay = cloneUsage(from.overlay);
			}
			const reusePartial = resumable && (from.partial.kind !== "reread" || cachedOverlay);
			scanOffset = reusePartial ? from.scanOffset : offset;
			partial = reusePartial ? from.partial : undefined;
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

		const overlay = cachedOverlay ?? emptyUsage();
		if (!cachedOverlay && acc && position === size) {
			if (acc.kind === "scanner") consumeScannerRecord(overlay, acc.scanner, true);
			else {
				const entry = finalFragment(acc);
				if (entry !== undefined) consumeEntry(overlay, entry);
				// Keep the preview, not the medium record's bytes. Growth restarts
				// at offset so the eventual commit uses whole-record parsing too.
				if (acc.len > USAGE_BUFFER_LIMIT) {
					acc = { [RECORD_ACCUMULATOR]: true, start: acc.start, kind: "reread" };
				}
			}
		}
		const evaluatedTo = position;
		const effective = cloneUsage(usage);
		mergeUsage(effective, overlay);
		const tailLength = Math.min(offset, HEAD_LIMIT);
		return {
			offset,
			scanOffset: position,
			partial: acc,
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
	const timestamp = entry.timestamp;
	if (Number.isFinite(timestamp)) return timestamp;
	try {
		const parsed = Date.parse(timestamp);
		if (Number.isFinite(parsed)) return parsed;
	} catch {
		// JSON objects can shadow the methods Date.parse uses for coercion.
	}
	return Number.isFinite(message.timestamp) ? message.timestamp : NaN;
}

function timelineErrorClass(text) {
	try {
		return classifyProviderError(text);
	} catch {
		return classifyProviderError("");
	}
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
	if (!isObject(entry)) return;
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
		const input = usage ? counter(usage.input) : 0;
		const output = usage ? counter(usage.output) : 0;
		const cacheRead = usage ? counter(usage.cacheRead) : 0;
		const cacheWrite = usage ? counter(usage.cacheWrite) : 0;
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
			const top = stats.topTurns;
			// Insert after equal totals, just as the stable sort did (also for Infinity).
			if (top.length < 10 || total > top[9].total) {
				let index = top.length;
				while (index > 0 && total > top[index - 1].total) index -= 1;
				top.splice(index, 0, {
					ms,
					key: billingKey(message.provider, message.responseModel ?? message.model),
					input,
					output,
					cacheRead,
					cacheWrite,
					total,
					stopReason: message.stopReason,
				});
				if (top.length > 10) top.pop();
			}
			const denominator = input + cacheRead + cacheWrite;
			if (cacheWrite >= options.cacheStormWrite && cacheRead < options.cacheStormReadFrac * denominator) {
				stats.stormTurns += 1;
			}
		}
		if (message.stopReason === "error") {
			stats.errors.count += 1;
			const cls = timelineErrorClass(message.errorMessage);
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
		stats.largeRecords += 1;
		consumeScannerRecord(totals, acc.scanner);
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
		if (usageWanted) totals.diagnostics.badLines += 1;
		else totals.diagnostics.skippedLines += 1;
		return;
	}
	if (usageWanted) consumeEntry(totals, entry);
	else totals.diagnostics.skippedLines += 1;
	consumeTimelineStats(stats, entry, options);
}

function consumeTimelineFragment(totals, stats, acc, options) {
	if (acc.kind === "scanner") {
		stats.largeRecords += 1;
		consumeScannerRecord(totals, acc.scanner, true);
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
			largeRecords: 0,
			hours: new Map(),
			topTurns: [],
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
		// The scanner preserves accounting but does not parse the full record for statistics.
		const incomplete = stats.largeRecords > 0;
		return {
			totals,
			largeRecords: stats.largeRecords,
			hours: [...stats.hours.values()].sort((a, b) => a.hourMs - b.hourMs).slice(-240),
			topTurns: stats.topTurns,
			cache: {
				hitRate: denominator > 0 ? totals.cacheRead / denominator : null,
				stormTurns: stats.stormTurns,
			},
			errors: { ...stats.errors, incomplete },
			tools: {
				rows: [...stats.tools]
					.map(([name, value]) => ({ name, calls: value.calls, errors: value.errors }))
					.sort((a, b) => b.calls - a.calls || b.errors - a.errors || a.name.localeCompare(b.name))
					.slice(0, 20),
				incomplete,
			},
			images: { peakCount: stats.peakCount, peakMiB: stats.peakBytes / (1024 * 1024), incomplete },
			prepMs: performance.now() - started,
		};
	} finally {
		fs.closeSync(fd);
	}
}
