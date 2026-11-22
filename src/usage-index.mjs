import { basename } from "node:path";
import { readUsage } from "./collect/usage.mjs";
import { atomicWriteFile, readTextSafe, statSafe } from "./util/fsx.mjs";

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
const PRUNE_KEEP_MS = 45 * 24 * 3600_000;
const TREE_DEPTH = 8;

const isObject = (value) => typeof value === "object" && value !== null;

const META_KEYS = ["kind", "taskId", "parentSessionId", "rootSessionId"];
const MEMORY_ONLY_KEYS = new Set(["scanOffset", "partial", "readError"]);
const USAGE_KEYS = ["usage", "overlay", "published"];
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
	for (const key of PERSISTED_KEYS) {
		if (Object.hasOwn(entry, key)) out[key] = entry[key];
	}
	for (const [key, value] of Object.entries(entry)) {
		if (!Object.hasOwn(out, key) && !MEMORY_ONLY_KEYS.has(key) && value !== undefined) out[key] = value;
	}
	// Non-finite leaves are tagged by the serializer, not by copying the trees here:
	// a 105k-model entry copied into a second tree of the same size aborts at 96 MiB.
	return out;
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
	if (!Object.hasOwn(node, key)) return true;
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

/**
 * A persisted counter tree may be absent as a whole (a never-read row), but every
 * numeric leaf must be a number, or for v2 a well-formed tag. JSON.stringify turns
 * Infinity/NaN into null, so a null (or any other non-number) there is data loss;
 * the row must be recounted.
 */
function validCounterTree(tree, version) {
	if (tree === null || tree === undefined) return true;
	if (!isObject(tree) || Array.isArray(tree)) return false;
	for (const key of COUNTER_KEYS) if (!normalizeNumber(tree, key, version)) return false;
	if ("costUnknown" in tree && typeof tree.costUnknown !== "boolean") return false;
	if ("modelsIncomplete" in tree && typeof tree.modelsIncomplete !== "boolean") return false;
	for (const models of [tree.models, tree.usedModels, tree.diagnostics]) {
		if (models === null || models === undefined) continue;
		if (!isObject(models) || Array.isArray(models)) return false;
	}
	// for-in over the 105k-model maps: Object.values would allocate an array per tree
	// in a process the daemon caps at 96 MiB.
	const models = tree.models;
	if (models) {
		for (const key in models) {
			if (!Object.hasOwn(models, key)) continue;
			const model = models[key];
			if (!isObject(model) || Array.isArray(model)) return false;
			if (!normalizeNumber(model, "tokens", version) || !normalizeNumber(model, "cost", version)) return false;
			if (typeof model.tokens !== "number" || typeof model.cost !== "number") return false;
		}
	}
	const usedModels = tree.usedModels;
	if (usedModels) {
		for (const key in usedModels) if (Object.hasOwn(usedModels, key) && usedModels[key] !== true) return false;
	}
	const diagnostics = tree.diagnostics;
	if (diagnostics) {
		if (!normalizeNumber(diagnostics, "badLines", version) || !normalizeNumber(diagnostics, "skippedLines", version)) return false;
		if (typeof diagnostics.badLines !== "number" || typeof diagnostics.skippedLines !== "number") return false;
	}
	return true;
}

const ENTRY_NUMBERS = [...CURSOR_NUMBERS, "checkedMs"];

/** Every persisted numeric slot and counter leaf must fit the file's version. */
function validEntry(entry, version) {
	for (const key of ENTRY_NUMBERS) if (!normalizeNumber(entry, key, version)) return false;
	return USAGE_KEYS.every((key) => validCounterTree(entry[key], version));
}

/** Drop a lossy cursor and publication so the tracker recounts the session file. */
function invalidateCursor(entry) {
	delete entry.usage;
	delete entry.overlay;
	delete entry.published;
	delete entry.evaluatedTo;
	entry.offset = 0;
	entry.complete = false;
	entry.gone = false;
}

/**
 * `{file, clock, log, read}`: `file` is the only path ever written, and only
 * `save()` writes it. The file is loaded here, so a fresh process resumes every
 * persisted cursor; an unsupported version or a corrupt file starts empty, and the
 * memory-only keys are never taken from disk. `read` defaults to `readUsage` and
 * lets tests inject a read failure.
 */
export function createUsageIndex({ file, clock, log, read = readUsage } = {}) {
	const entries = new Map();
	let dirty = false;
	for (const [id, loaded] of readUsageIndex(file)) {
		const entry = newEntry(id);
		for (const [key, value] of Object.entries(loaded)) {
			if (!MEMORY_ONLY_KEYS.has(key)) entry[key] = value;
		}
		entry.id = id;
		entries.set(id, entry);
	}

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
					entry.state = "missing";
					entry.complete = false;
					entry.gone = false;
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
				entry.state = "missing";
				entry.complete = false;
				entry.gone = false;
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
			const out = { v: USAGE_INDEX_VERSION, entries: {} };
			for (const [id, entry] of entries) out.entries[id] = persisted(entry);
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
				if (checked < cutoff && entries.delete(id)) removed += 1;
			}
			if (removed) dirty = true;
			return removed;
		},
	};
}

/** The index as the dashboard reads it: a Map of entries, empty when absent, unsupported or corrupt. */
export function readUsageIndex(file) {
	const out = new Map();
	const text = readTextSafe(file);
	if (text === undefined) return out;
	let data;
	try {
		const body = text.replace(/^\uFEFF/, "");
		// No reviver: V8's reviver path keeps a temporary node array for the whole
		// document, which aborts a 105,000-model index under the daemon's 96 MiB cap.
		// The tagged leaves are rare and decoded in place per entry below.
		data = JSON.parse(body);
	} catch {
		return out;
	}
	if (!isObject(data) || (data.v !== 1 && data.v !== USAGE_INDEX_VERSION) || !isObject(data.entries)) return out;
	const version = data.v;
	for (const [id, entry] of Object.entries(data.entries)) {
		if (!isObject(entry)) continue;
		// A version mismatch, a malformed tag, a null or a string in a numeric slot
		// would otherwise publish a total the one-shot read disagrees with (IS-1).
		if (!validEntry(entry, version)) invalidateCursor(entry);
		out.set(id, entry);
	}
	return out;
}
