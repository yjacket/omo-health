import fs from "node:fs";
import { basename } from "node:path";
import { MODEL_KEY_LENGTH, MODEL_KEY_LIMIT, readUsage } from "./collect/usage.mjs";
import { atomicWriteFile, statSafe } from "./util/fsx.mjs";

/**
 * The token index (plan todo 3, GAP-3): one JSON file holding, per session id, the
 * resumable `readUsage` cursor plus the totals of the last read that reached the
 * end of the file (`published`). The daemon owns the file; the dashboard only
 * reads it through `readUsageIndex`.
 *
 * An entry is shown only when `complete` is true, which means a read reached the
 * end of the file at least once; `fresh()` additionally proves that the bytes on
 * disk are still the ones that were read. `usage` is the scan accumulator and
 * advances record by record, while `published` only moves when a read ends
 * `done`, so a partial append never shows an intermediate sum (IS-1, IS-3, IS-12).
 */
export const USAGE_INDEX_VERSION = 2;
/** Per-tick byte budget for live appends, first reads and the backlog. */
export const USAGE_TICK_BYTES = 32 * 1024 * 1024;
/** Total named model slots, including repeats between rows or counter maps. */
export const USAGE_INDEX_MODEL_BUDGET = 4096;
const PRUNE_KEEP_MS = 45 * 24 * 3600_000;
const TREE_DEPTH = 8;

const isObject = (value) => typeof value === "object" && value !== null;

const META_KEYS = ["kind", "taskId", "parentSessionId", "rootSessionId"];
const MEMORY_ONLY_KEYS = ["scanOffset", "partial", "readError"];
const USAGE_KEYS = ["usage", "overlay", "published"];
const OTHER_MODELS = "(other models)";
const SPILL_KEYS = new Set([OTHER_MODELS, "(model id too long)", "(model id unreadable)"]);
const COUNTER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "turns"];
const CURSOR_NUMBERS = ["size", "offset", "evaluatedTo", "mtimeMs", "ino", "birthtimeMs", "headLen"];
const PERSISTED_KEYS = [
	"id",
	"file",
	"kind",
	"taskId",
	"parentSessionId",
	"rootSessionId",
	"state",
	"complete",
	"gone",
	"size",
	"mtimeMs",
	"offset",
	"ino",
	"birthtimeMs",
	"head",
	"headLen",
	"tail",
	"usage",
	"overlay",
	"evaluatedTo",
	"published",
	"checkedMs",
];

function newEntry(id) {
	return {
		id,
		file: null,
		kind: null,
		taskId: null,
		parentSessionId: null,
		rootSessionId: null,
		state: "missing",
		complete: false,
		gone: false,
		size: null,
		mtimeMs: null,
		offset: null,
		ino: null,
		birthtimeMs: null,
		head: null,
		headLen: null,
		tail: null,
		usage: null,
		overlay: null,
		evaluatedTo: null,
		published: null,
		checkedMs: null,
	};
}

function applyMeta(entry, meta) {
	if (!isObject(meta)) return;
	for (const key of META_KEYS) if (key in meta) entry[key] = meta[key];
}

function hasNumericCursor(entry) {
	return CURSOR_NUMBERS.every((key) => Number.isFinite(entry[key]));
}

/** The identity facts `readUsage` resumes on; a change means it recounted from 0. */
function isRestart(previous, result) {
	if (!isObject(previous) || previous.state !== "ok" || previous.offset === undefined || previous.usage === undefined) return true;
	if (result.size < previous.size) return true;
	if (previous.ino !== undefined && (result.ino !== previous.ino || result.birthtimeMs !== previous.birthtimeMs)) return true;
	if (previous.headLen === result.headLen && previous.head !== result.head) return true;
	if (result.size === previous.size && previous.mtimeMs !== result.mtimeMs) return true;
	if (previous.offset === result.offset && previous.tail !== result.tail) return true;
	return false;
}

function ownerTotals(usage) {
	const src = isObject(usage) ? usage : {};
	return {
		total: src.total ?? 0,
		input: src.input ?? 0,
		output: src.output ?? 0,
		cacheRead: src.cacheRead ?? 0,
		cacheWrite: src.cacheWrite ?? 0,
		cost: src.cost ?? 0,
		costUnknown: src.costUnknown === true,
		turns: src.turns ?? 0,
	};
}

/**
 * The totals the board and history show, or null: only an `ok` entry whose first
 * full read finished has one, and a read failure keeps it null (IS-12).
 */
export function compactUsage(entry) {
	if (!isObject(entry) || entry.state !== "ok" || entry.complete !== true || entry.readError === true) return null;
	if (!isObject(entry.published)) return null;
	return ownerTotals(entry.published);
}

/**
 * True when the entry is complete and the file on disk still has exactly the
 * size, mtime and end the last read saw. Used for requeueing and reviewer
 * eligibility alike; a same-length rewrite (new mtimeMs) is never fresh.
 */
export function fresh(entry) {
	if (!isObject(entry) || entry.state !== "ok" || entry.complete !== true) return false;
	if (!hasNumericCursor(entry)) return false;
	if (entry.evaluatedTo !== entry.size) return false;
	const stat = statSafe(entry.file);
	return Boolean(stat && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs);
}

/** `fresh` under the name the requeue path uses. */
export function atEnd(entry) {
	return fresh(entry);
}

/**
 * Own plus descendants' complete totals via `parentSessionId`, one Map entry per
 * id. Cycle-safe, depth-capped at 8, each id counted once; an incomplete child
 * contributes nothing of its own.
 */
export function treeTotals(entries) {
	const list = entries instanceof Map ? [...entries.values()] : [...(entries ?? [])];
	const byId = new Map();
	const childrenByParent = new Map();
	for (const entry of list) {
		if (!isObject(entry) || entry.id === undefined) continue;
		byId.set(entry.id, entry);
		if (entry.parentSessionId === undefined || entry.parentSessionId === null) continue;
		const siblings = childrenByParent.get(entry.parentSessionId) ?? [];
		siblings.push(entry.id);
		childrenByParent.set(entry.parentSessionId, siblings);
	}
	const totals = new Map();
	for (const id of byId.keys()) {
		const own = compactUsage(byId.get(id));
		const seen = new Set([id]);
		let total = own ? own.total : 0;
		let frontier = [id];
		for (let depth = 0; depth < TREE_DEPTH && frontier.length; depth += 1) {
			const next = [];
			for (const parentId of frontier) {
				for (const childId of childrenByParent.get(parentId) ?? []) {
					if (seen.has(childId)) continue;
					seen.add(childId);
					const child = byId.get(childId);
					const childUsage = compactUsage(child);
					if (childUsage) total += childUsage.total;
					next.push(childId);
				}
			}
			frontier = next;
		}
		totals.set(id, total);
	}
	return totals;
}

function persisted(entry) {
	const out = {};
	for (const key of PERSISTED_KEYS) out[key] = entry[key];
	// Non-finite leaves are tagged by the serializer, not by copying the trees here:
	// a 105k-model entry copied into a second tree of the same size aborts at 96 MiB.
	return out;
}

function persistedMeta(entry) {
	const meta = { file: entry.file };
	for (const key of META_KEYS) meta[key] = entry[key];
	return meta;
}

function boundedModels(entry, remaining) {
	const budget = remaining;
	for (const name of USAGE_KEYS) {
		const tree = entry[name];
		if (!tree) continue;
		const { models, usedModels } = tree;
		let spill;
		for (const key in models) {
			if (SPILL_KEYS.has(key)) continue;
			if (remaining > 0) remaining--;
			else {
				spill ??= models[OTHER_MODELS] ?? { tokens: 0, cost: 0 };
				spill.tokens += models[key].tokens;
				spill.cost += models[key].cost;
				delete models[key];
			}
		}
		if (spill) {
			models[OTHER_MODELS] = spill;
			tree.modelsIncomplete = true;
		}
		for (const key in usedModels) {
			if (SPILL_KEYS.has(key)) continue;
			if (remaining > 0) remaining--;
			else {
				delete usedModels[key];
				tree.modelsIncomplete = true;
			}
		}
	}
	return budget - remaining;
}

const NUMBER_TAG = "$n";
const NUMBER_TAGS = new Map([["Infinity", Infinity], ["-Infinity", -Infinity], ["NaN", NaN]]);

/** JSON.stringify replacer: a non-finite number becomes an unambiguous tagged object. */
function encodeNonFinite(key, value) {
	if (typeof value !== "number" || Number.isFinite(value)) return value;
	if (Number.isNaN(value)) return { [NUMBER_TAG]: "NaN" };
	return { [NUMBER_TAG]: value > 0 ? "Infinity" : "-Infinity" };
}

const INVALID_NUMBER = Symbol("invalidNumber");

/** A well-formed tag is exactly `{"$n": "Infinity" | "-Infinity" | "NaN"}`. */
function taggedNumber(value) {
	if (!isObject(value) || Array.isArray(value)) return INVALID_NUMBER;
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== NUMBER_TAG) return INVALID_NUMBER;
	return NUMBER_TAGS.get(value[NUMBER_TAG]) ?? INVALID_NUMBER;
}

/**
 * Validate one persisted numeric slot in place. A v1 file only ever held plain
 * numbers (an exponent that parses to -Infinity stays a number); a v2 file may
 * also hold a well-formed tag, decoded here so the rest of the loader never sees
 * the tagged shape. Null, strings, plain objects and malformed tags are invalid.
 */
function normalizeNumber(node, key, version) {
	if (!Object.hasOwn(node, key)) return false;
	const value = node[key];
	if (typeof value === "number") return true;
	if (version !== 1) {
		const decoded = taggedNumber(value);
		if (decoded !== INVALID_NUMBER) {
			node[key] = decoded;
			return true;
		}
	}
	return false;
}

const ENTRY_NUMBERS = [...CURSOR_NUMBERS, "checkedMs"];
const CURSOR_NULLS = [...CURSOR_NUMBERS, "head", "tail", ...USAGE_KEYS];
const record = (value) => isObject(value) && !Array.isArray(value);
const nullableString = (value) => value === null || typeof value === "string";
const hasShape = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
	fields.every((key) => Object.hasOwn(value, key));
const DIAGNOSTICS_KEYS = ["badLines", "skippedLines"];
const MODEL_COUNTERS = ["tokens", "cost"];
const TREE_KEYS = [...COUNTER_KEYS, "costUnknown", "modelsIncomplete", "models", "usedModels", "diagnostics"];

/** Validate and decode a whole row atomically; -1 means recount, never publish. */
function validateEntry(entry, id, version, remaining) {
	if (entry.state === "ok") for (const key of MEMORY_ONLY_KEYS) delete entry[key];
	if (!hasShape(entry, PERSISTED_KEYS)) return -1;
	if (entry.id !== id || !META_KEYS.every((key) => nullableString(entry[key]))) return -1;
	if (!Number.isFinite(entry.checkedMs) || typeof entry.complete !== "boolean" || typeof entry.gone !== "boolean") return -1;
	if (entry.state === "missing") {
		return nullableString(entry.file) && !entry.complete && !entry.gone &&
			CURSOR_NULLS.every((key) => entry[key] === null) ? 0 : -1;
	}
	if (entry.state !== "ok" || typeof entry.file !== "string" || typeof entry.head !== "string" || typeof entry.tail !== "string") return -1;
	if (!ENTRY_NUMBERS.every((key) => Number.isFinite(entry[key]))) return -1;
	if (!["size", "offset", "evaluatedTo", "headLen"].every((key) => Number.isSafeInteger(entry[key]) && entry[key] >= 0)) return -1;
	if (entry.offset > entry.evaluatedTo || entry.evaluatedTo > entry.size || entry.headLen > Math.min(entry.size, 4096)) return -1;
	if (!entry.complete && (entry.gone || entry.published !== null)) return -1;
	let named = 0;
	for (const name of USAGE_KEYS) {
		if (name === "published" && !entry.complete) continue;
		const tree = entry[name];
		if (!hasShape(tree, TREE_KEYS) || typeof tree.costUnknown !== "boolean" || typeof tree.modelsIncomplete !== "boolean") return -1;
		const { models, usedModels, diagnostics } = tree;
		if (!record(models) || !record(usedModels) || !COUNTER_KEYS.every((key) => normalizeNumber(tree, key, version))) return -1;
		if (!hasShape(diagnostics, DIAGNOSTICS_KEYS) || !DIAGNOSTICS_KEYS.every((key) => normalizeNumber(diagnostics, key, version))) return -1;
		let sum = Number.isSafeInteger(tree.total) ? 0n : null;
		for (const map of [models, usedModels]) {
			let count = 0;
			for (const key in map) {
				if (++count > MODEL_KEY_LIMIT || key.length > MODEL_KEY_LENGTH) return -1;
				if (!SPILL_KEYS.has(key) && ++named > remaining) return -1;
				const value = map[key];
				if (map === usedModels) {
					if (value !== true) return -1;
				} else {
					if (!hasShape(value, MODEL_COUNTERS) || !MODEL_COUNTERS.every((field) => normalizeNumber(value, field, version))) return -1;
					if (sum !== null) sum = Number.isSafeInteger(value.tokens) ? sum + BigInt(value.tokens) : null;
				}
			}
		}
		// Costs are grouped in a different floating-point order than the owner total.
		if (sum !== null && sum !== BigInt(tree.total)) return -1;
	}
	return named;
}

/** Drop a lossy cursor and publication so the tracker recounts the session file. */
function invalidated(id, row) {
	const entry = newEntry(id);
	for (const key of ["file", ...META_KEYS]) if (typeof row?.[key] === "string") entry[key] = row[key];
	entry.checkedMs = Number.isFinite(row?.checkedMs) ? row.checkedMs : null;
	entry.state = "ok"; // The tracker queues incomplete reads immediately, unlike missing rows.
	entry.offset = 0;
	for (const key of [...USAGE_KEYS, "evaluatedTo"]) delete entry[key];
	return entry;
}

/**
 * `{file, clock, log, read}`: `file` is the only path ever written, and only
 * `save()` writes it. The file is loaded here, so a fresh process resumes every
 * persisted cursor; an unsupported version or a corrupt file starts empty, and the
 * memory-only keys are never taken from disk. `read` defaults to `readUsage` and
 * lets tests inject a read failure.
 */
export function createUsageIndex({ file, clock, log, read = readUsage } = {}) {
	const { entries, weights, count } = loadUsageIndex(file);
	let named = count;
	let dirty = false;

	const ensure = (id) => {
		let entry = entries.get(id);
		if (!entry) {
			entry = newEntry(id);
			entries.set(id, entry);
		}
		return entry;
	};

	const alias = (id) => {
		const direct = entries.get(id);
		if (direct) return direct;
		for (const entry of entries.values()) if (entry.taskId === id) return entry;
		return undefined;
	};

	const dropCursor = (entry) => {
		named -= weights.get(entry.id) ?? 0;
		weights.delete(entry.id);
		Object.assign(entry, newEntry(entry.id), persistedMeta(entry), { checkedMs: entry.checkedMs });
		entry.partial = undefined;
		entry.scanOffset = undefined;
	};

	return {
		file,
		get: alias,
		has(id) {
			return alias(id) !== undefined;
		},
		/**
		 * Read up to `maxBytes` more bytes of `file`. Returns bytesRead; a missing
		 * file marks the entry missing (or, after a complete read, gone) and a read
		 * error keeps the saved totals while `readError` hides them from the board.
		 */
		update(id, path, meta = {}, { maxBytes = Infinity } = {}) {
			const entry = ensure(id);
			entry.file = path;
			applyMeta(entry, meta);
			entry.checkedMs = clock.now();
			// Keep any last published total for a missing file, but never resume or compare a malformed cursor.
			const from = hasNumericCursor(entry) ? entry : undefined;
			let result;
			try {
				// Windows reports a directory as a zero-byte stream, so readUsage would succeed on one; a session file is never a directory.
				if (statSafe(path)?.isDirectory()) {
					const error = new Error("EISDIR: illegal operation on a directory, read");
					error.code = "EISDIR";
					throw error;
				}
				result = read(path, from, { maxBytes });
			} catch (error) {
				if (entry.readError !== true) {
					log?.error?.("usage_read_failed", { file: basename(String(path)), error: String(error?.message ?? error) });
				}
				entry.readError = true;
				dirty = true;
				return 0;
			}
			entry.readError = false;
			if (result === null) {
				if (entry.complete === true) {
					entry.gone = true;
				} else {
					dropCursor(entry);
				}
				dirty = true;
				return 0;
			}
			const restart = isRestart(from, result);
			entry.state = "ok";
			entry.gone = false;
			entry.complete = restart ? result.done === true : entry.complete === true || result.done === true;
			entry.size = result.size;
			entry.mtimeMs = result.mtimeMs;
			entry.offset = result.offset;
			entry.ino = result.ino;
			entry.birthtimeMs = result.birthtimeMs;
			entry.head = result.head;
			entry.headLen = result.headLen;
			entry.tail = result.tail;
			entry.usage = result.usage;
			entry.overlay = result.overlay;
			entry.evaluatedTo = result.evaluatedTo;
			entry.scanOffset = result.scanOffset;
			entry.partial = result.partial;
			if (result.done === true) entry.published = result.effective;
			else if (restart) entry.published = null;
			named -= weights.get(id) ?? 0;
			const slots = boundedModels(entry, USAGE_INDEX_MODEL_BUDGET - named);
			weights.set(id, slots);
			named += slots;
			dirty = true;
			return result.bytesRead;
		},
		/**
		 * No session file was located for `id`. A never-found row becomes `missing`;
		 * a row whose complete read already published a total keeps that total and
		 * turns `gone`, exactly like the read-null path above (IS-3).
		 */
		markMissing(id, meta = {}) {
			const entry = ensure(id);
			applyMeta(entry, meta);
			if (meta?.file) entry.file = meta.file;
			if (entry.state === "ok" && entry.complete === true) {
				entry.gone = true;
			} else {
				dropCursor(entry);
			}
			entry.checkedMs = clock.now();
			dirty = true;
			return entry;
		},
		fresh,
		atEnd,
		entries() {
			return [...entries.values()];
		},
		/** Write the index when anything changed; returns whether it wrote. */
		save() {
			if (!dirty) return false;
			const out = { v: USAGE_INDEX_VERSION, entries: Object.create(null) };
			for (const [id, entry] of entries) {
				if (entry.state === "ok" && !weights.has(id)) continue; // Recount still pending.
				out.entries[id] = persisted(entry);
			}
			atomicWriteFile(file, `${JSON.stringify(out, encodeNonFinite, 2)}\n`);
			dirty = false;
			return true;
		},
		/** Drop entries not checked since `nowMs - keepMs`. */
		prune(nowMs, keepMs = PRUNE_KEEP_MS) {
			const cutoff = nowMs - keepMs;
			let removed = 0;
			for (const [id, entry] of entries) {
				const checked = Number.isFinite(entry.checkedMs) ? entry.checkedMs : 0;
				if (checked < cutoff && entries.delete(id)) {
					named -= weights.get(id) ?? 0;
					weights.delete(id);
					removed += 1;
				}
			}
			if (removed) dirty = true;
			return removed;
		},
	};
}

function loadUsageIndex(file, trackWeights = true) {
	const entries = new Map();
	const weights = new Map();
	let count = 0;
	const clear = () => {
		entries.clear();
		weights.clear();
		return { entries, weights, count: 0 };
	};
	try {
		// Keep the source bytes outside the V8 heap and materialize one row at a
		// time. Old writers' oversized indexes can OOM before whole-file JSON.parse
		// completes, too early for a post-parse budget check.
		const bytes = fs.readFileSync(file);
		let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
		const fail = () => { throw new SyntaxError("invalid usage index"); };
		const peek = () => {
			while (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13) i++;
			return bytes[i];
		};
		const expect = (byte) => {
			if (peek() !== byte) fail();
			i++;
		};
		const stringEnd = () => {
			while (++i < bytes.length) {
				if (bytes[i] === 92) i++;
				else if (bytes[i] === 34) {
					i++;
					return;
				}
			}
			fail();
		};
		// Locate a value's byte span; JSON.parse still checks its actual grammar.
		const skipValue = () => {
			const first = peek();
			if (first === 34) return stringEnd();
			if (first !== 123 && first !== 91) {
				while (i < bytes.length && bytes[i] !== 44 && bytes[i] !== 125 && bytes[i] !== 93) i++;
				return;
			}
			let depth = 0;
			while (i < bytes.length) {
				const byte = bytes[i];
				if (byte === 34) {
					stringEnd();
					continue;
				}
				i++;
				if (byte === 123 || byte === 91) depth++;
				else if ((byte === 125 || byte === 93) && --depth === 0) return;
			}
			fail();
		};
		const fields = (visit) => {
			expect(123);
			if (peek() !== 125) {
				for (;;) {
					if (peek() !== 34) fail();
					const start = i;
					stringEnd();
					const key = JSON.parse(bytes.toString("utf8", start, i));
					expect(58);
					visit(key);
					if (peek() !== 44) break;
					i++;
				}
			}
			expect(125);
		};
		const parseValue = () => {
			peek();
			const start = i;
			skipValue();
			return JSON.parse(bytes.toString("utf8", start, i));
		};
		// Find the version before validating rows, including old compact files
		// with `entries` before `v`. Do not decode the entries object itself.
		let version;
		let entriesStart;
		fields((key) => {
			if (key === "entries") {
				peek();
				entriesStart = i;
				skipValue();
			} else {
				const value = parseValue();
				if (key === "v") version = value;
			}
		});
		if (peek() !== undefined || entriesStart === undefined || (version !== 1 && version !== USAGE_INDEX_VERSION)) return clear();
		i = entriesStart;
		fields((id) => {
			const row = parseValue();
			if (!record(row)) return;
			if (entries.has(id)) fail();
			const slots = validateEntry(row, id, version, USAGE_INDEX_MODEL_BUDGET - count);
			entries.set(id, slots < 0 ? invalidated(id, row) : row);
			if (slots >= 0) {
				count += slots;
				if (trackWeights) weights.set(id, slots);
			}
		});
		return { entries, weights, count };
	} catch {
		return clear();
	}
}

/** The index as the dashboard reads it: a Map of entries, empty when absent, unsupported or corrupt. */
export const readUsageIndex = (file) => loadUsageIndex(file, false).entries;
