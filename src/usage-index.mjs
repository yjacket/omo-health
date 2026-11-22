import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { addModelCounters, emptyModelBilling, MODEL_KEY_LENGTH, MODEL_KEY_LIMIT, readUsage } from "./collect/usage.mjs";
import { pathKey } from "./paths.mjs";
import { parseSubjectKey, SubjectMap, subjectKey, subjectOf, uniqueMatch } from "./session-subject.mjs";
import { atomicWriteChunks, statSafe } from "./util/fsx.mjs";

/**
 * The token index (plan todo 3, GAP-3): one JSON Lines file holding, per session id, the
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
export const USAGE_INDEX_VERSION = 5;
const INDEX_HEADER = JSON.stringify({ v: USAGE_INDEX_VERSION });
const FULL_HEADER = JSON.stringify({ v: USAGE_INDEX_VERSION, full: true });
const FULL_ENTRY = Object.freeze({ state: "full" });
/** Fixed per-row allowance for V8 objects, map entries and writer bookkeeping. */
export const INDEX_ENTRY_OVERHEAD = 1840; // Includes ordered slots and worst-case per-project buckets in both maps.
// Allow for the four model counters separately from line weight (eight bytes per counter).
const MODEL_COUNTER_BYTES = 4 * 8;
// The index must fit in the delta between the 80 MiB control and the 96 MiB daemon.
export const INDEX_BYTE_BUDGET = 16 * 1024 * 1024;
// Separate from resident rows: only one serialized/decoded line is processed at a time.
const INDEX_LINE_BYTE_BUDGET = 8 * 1024 * 1024;
/** Per-tick byte budget for live appends, first reads and the backlog. */
export const USAGE_TICK_BYTES = 32 * 1024 * 1024;
// readUsage can check the old head and tail, compute a new head, then hash the new tail.
export const USAGE_FINGERPRINT_BYTES_MAX = 4 * 4096;
/** Total named model slots, including repeats between rows or counter maps. */
export const USAGE_INDEX_MODEL_BUDGET = 4096;
const PRUNE_KEEP_MS = 45 * 24 * 3600_000;
const TREE_DEPTH = 8;

const isObject = (value) => typeof value === "object" && value !== null;

const META_KEYS = ["kind", "taskId", "parentSessionId", "rootSessionId", "parentKey", "rootKey"];
const MEMORY_ONLY_KEYS = ["scanOffset", "partial", "readError", "pending"];
const USAGE_KEYS = ["usage", "overlay", "published"];
const ENTRY_STRING_KEYS = ["id", "projectKey", "file", ...META_KEYS, "state", "head", "tail"];
const OTHER_MODELS = "(other models)";
const SPILL_KEYS = new Set([OTHER_MODELS, "(model id too long)", "(model id unreadable)"]);
export const isSpillModelKey = (key) => SPILL_KEYS.has(key);
const COUNTER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "turns"];
const CURSOR_NUMBERS = ["size", "offset", "evaluatedTo", "mtimeMs", "ino", "birthtimeMs", "headLen"];
const PERSISTED_KEYS = [
	"id",
	"projectKey",
	"file",
	"kind",
	"taskId",
	"parentSessionId",
	"rootSessionId",
	"parentKey",
	"rootKey",
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

function newEntry({ sessionId: id, projectKey = null }) {
	return {
		id,
		projectKey,
		file: null,
		kind: null,
		taskId: null,
		parentSessionId: null,
		rootSessionId: null,
		parentKey: null,
		rootKey: null,
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
	for (const [key, id] of [["parentKey", "parentSessionId"], ["rootKey", "rootSessionId"]]) {
		if (id in meta && !(key in meta)) entry[key] = null;
		const linked = parseSubjectKey(entry[key]);
		if (linked && linked.projectKey === entry.projectKey && linked.sessionId === entry[id]) entry[key] = null;
	}
}

export function parentSubject(entry) {
	// Empty distinguishes a checked-but-unresolved ledger link from a compact
	// same-project link (null).
	if (entry.parentKey === "") return null;
	return parseSubjectKey(entry.parentKey) ?? (entry.parentSessionId ?
		{ projectKey: entry.projectKey, sessionId: entry.parentSessionId } : null);
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

/** A task directory proves ownership only with one candidate. Stop at the second;
 * null is a veto, undefined means this directory has no candidate. */
export function soleChildSessionFile(dir) {
	let entries;
	try {
		entries = fs.opendirSync(dir);
		let file;
		for (let entry; (entry = entries.readSync());) {
			if (!entry.name.endsWith(".jsonl")) continue;
			const candidate = join(dir, entry.name);
			if (!entry.isFile() && !(entry.isSymbolicLink() && statSafe(candidate)?.isFile())) continue;
			if (file) return null;
			file = candidate;
		}
		return file;
	} catch (error) {
		return error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null;
	} finally {
		entries?.closeSync();
	}
}

export const isTaskOnlyEntry = (entry) => entry?.kind === "child" && Boolean(entry.taskId) && entry.id === entry.taskId;
const isSoleChildSessionFile = (file) => {
	const sole = file && soleChildSessionFile(dirname(file));
	return Boolean(sole && pathKey(sole) === pathKey(file));
};

function canShowTaskOnlyUsage(entry) {
	if (!entry.file) return false;
	const sole = soleChildSessionFile(dirname(entry.file));
	// Zero candidates does not contradict the last verified ownership.
	return sole === undefined || Boolean(sole && !entry.gone && pathKey(sole) === pathKey(entry.file));
}

/**
 * The totals the board and history show, or null: only an `ok` entry whose first
 * full read finished has one, and a read failure keeps it null (IS-12).
 */
export function compactUsage(entry) {
	if (!isObject(entry) || entry.state !== "ok" || entry.complete !== true || entry.readError === true) return null;
	if (!isObject(entry.published)) return null;
	if (isTaskOnlyEntry(entry) && entry.ownershipUnique !== true) return null;
	return ownerTotals(entry.published);
}

/**
 * True when the entry is complete and the file on disk still has exactly the
 * size, mtime and end the last read saw. Used for requeueing and reviewer
 * eligibility alike; a same-length rewrite (new mtimeMs) or a replaced file (new
 * ino or birthtimeMs, the identity `readUsage` checks) is never fresh.
 */
export function fresh(entry) {
	if (!isObject(entry) || entry.state !== "ok" || entry.complete !== true || entry.gone === true) return false;
	if (!hasNumericCursor(entry)) return false;
	if (entry.evaluatedTo !== entry.size) return false;
	if (isTaskOnlyEntry(entry) && !isSoleChildSessionFile(entry.file)) return false;
	const stat = statSafe(entry.file);
	return Boolean(
		stat &&
			stat.size === entry.size &&
			stat.mtimeMs === entry.mtimeMs &&
			stat.ino === entry.ino &&
			stat.birthtimeMs === entry.birthtimeMs,
	);
}

/** `fresh` under the name the requeue path uses. */
export function atEnd(entry) {
	return fresh(entry);
}

/**
 * Own plus descendants' complete totals via scoped parent links, or null when no
 * descendant contributes. Exactness requires a published own total and every
 * known descendant. Unresolved fallback links mark a branch partial without
 * joining it to an unrelated index entry with the same task ID.
 */
export function treeTotals(entries, knownRows = [], treeKey = (key) => key) {
	const byId = new Map();
	const childrenByParent = new Map();
	const knownIds = new Set();
	const unresolvedParents = new Set();
	const link = (id, parentKey) => {
		if (parentKey == null) return;
		const siblings = childrenByParent.get(parentKey) ?? new Set();
		siblings.add(id);
		childrenByParent.set(parentKey, siblings);
	};
	for (const row of knownRows) {
		const key = treeKey(row?.key);
		const parent = treeKey(row?.parentKey);
		if (key == null) continue;
		knownIds.add(key);
		if (!byId.has(key)) byId.set(key, null);
		if (row.unresolved) {
			if (parent != null) unresolvedParents.add(parent);
		} else link(key, parent);
	}
	for (const entry of (entries?.values?.() ?? entries ?? [])) {
		const key = treeKey(subjectKey(subjectOf(entry)));
		if (key == null) continue;
		byId.set(key, entry);
		if (!knownIds.has(key)) link(key, treeKey(subjectKey(parentSubject(entry))));
	}
	const totals = new Map();
	totals.complete = new Map();
	for (const id of byId.keys()) {
		const own = compactUsage(byId.get(id));
		if (!childrenByParent.has(id)) {
			totals.set(id, null);
			totals.complete.set(id, Number.isFinite(own?.total) && !unresolvedParents.has(id));
			continue;
		}
		let total = own ? own.total : 0;
		let hasCountedDescendant = false;
		let complete = Number.isFinite(own?.total);
		const seen = new Set([id]);
		let frontier = [id];
		for (let depth = 0; depth < TREE_DEPTH && frontier.length; depth += 1) {
			const next = [];
			for (const parentId of frontier) {
				if (unresolvedParents.has(parentId)) complete = false;
				for (const childId of childrenByParent.get(parentId) ?? []) {
					if (seen.has(childId)) continue;
					seen.add(childId);
					const child = byId.get(childId);
					const childUsage = compactUsage(child);
					if (childUsage) {
						total += childUsage.total;
						hasCountedDescendant = true;
					}
					if (!Number.isFinite(childUsage?.total)) complete = false;
					next.push(childId);
				}
			}
			frontier = next;
		}
		// A depth-limited subtotal is partial if a child beyond the cap was skipped.
		for (const parentId of frontier) {
			if (unresolvedParents.has(parentId)) complete = false;
			for (const childId of childrenByParent.get(parentId) ?? []) {
				if (!seen.has(childId)) complete = false;
			}
		}
		totals.set(id, hasCountedDescendant ? total : null);
		totals.complete.set(id, complete && Number.isFinite(total));
	}
	return totals;
}

function persisted(entry) {
	const out = {};
	for (const key of PERSISTED_KEYS) out[key] = entry[key];
	if (typeof entry.ownershipUnique === "boolean") out.ownershipUnique = entry.ownershipUnique;
	// Non-finite leaves are tagged by the serializer, not by copying the trees here:
	// a 105k-model entry copied into a second tree of the same size aborts at 96 MiB.
	return out;
}

function persistedMeta(entry) {
	const meta = { file: entry.file };
	for (const key of META_KEYS) meta[key] = entry[key];
	return meta;
}

function boundedModels(entry, remaining, keepPublished = false) {
	const budget = remaining;
	// A deferred reread must not spill names from an already admitted publication.
	for (const name of keepPublished ? ["published", "usage", "overlay"] : USAGE_KEYS) {
		const tree = entry[name];
		if (!tree) continue;
		const { models, usedModels } = tree;
		let spill;
		for (const key in models) {
			if (SPILL_KEYS.has(key)) continue;
			if (remaining > 0) remaining--;
			else {
				spill ??= models[OTHER_MODELS] ?? emptyModelBilling();
				const { input, output, cacheRead, cacheWrite, cost } = models[key];
				addModelCounters(spill, input, output, cacheRead, cacheWrite, cost);
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
 * Validate one persisted numeric slot in place, decoding any well-formed tag.
 * Null, strings, plain objects and malformed tags are invalid.
 */
function normalizeNumber(node, key) {
	if (!Object.hasOwn(node, key)) return false;
	const value = node[key];
	if (typeof value === "number") return true;
	const decoded = taggedNumber(value);
	if (decoded === INVALID_NUMBER) return false;
	node[key] = decoded;
	return true;
}

const ENTRY_NUMBERS = [...CURSOR_NUMBERS, "checkedMs"];
const CURSOR_NULLS = [...CURSOR_NUMBERS, "head", "tail", ...USAGE_KEYS];
const record = (value) => isObject(value) && !Array.isArray(value);
const nullableString = (value) => value === null || typeof value === "string";
const hasShape = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
	fields.every((key) => Object.hasOwn(value, key));
const DIAGNOSTICS_KEYS = ["badLines", "skippedLines"];
const MODEL_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "tokens", "cost"];
const TREE_KEYS = [...COUNTER_KEYS, "costUnknown", "modelsIncomplete", "models", "usedModels", "diagnostics"];

/** Validate and decode a whole row atomically; -1 means recount, never publish. */
function validateEntry(entry, remaining) {
	if (entry.state === "ok") for (const key of MEMORY_ONLY_KEYS) delete entry[key];
	const hasOwnership = Object.hasOwn(entry, "ownershipUnique");
	if (hasOwnership && typeof entry.ownershipUnique !== "boolean") return -1;
	if (Object.keys(entry).length !== PERSISTED_KEYS.length + Number(hasOwnership) ||
		!PERSISTED_KEYS.every((key) => Object.hasOwn(entry, key))) return -1;
	if (typeof entry.id !== "string" || !nullableString(entry.projectKey) || !META_KEYS.every((key) => nullableString(entry[key]))) return -1;
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
		if (!record(models) || !record(usedModels) || !COUNTER_KEYS.every((key) => normalizeNumber(tree, key))) return -1;
		if (!hasShape(diagnostics, DIAGNOSTICS_KEYS) || !DIAGNOSTICS_KEYS.every((key) => normalizeNumber(diagnostics, key))) return -1;
		for (const map of [models, usedModels]) {
			let count = 0;
			for (const key in map) {
				if (++count > MODEL_KEY_LIMIT || key.length > MODEL_KEY_LENGTH) return -1;
				if (!SPILL_KEYS.has(key) && ++named > remaining) return -1;
				const value = map[key];
				if (map === usedModels) {
					if (value !== true) return -1;
				} else {
					if (!hasShape(value, MODEL_COUNTERS) || !MODEL_COUNTERS.every((field) => normalizeNumber(value, field))) return -1;
					if (!Object.is(value.tokens, value.input + value.output + value.cacheRead + value.cacheWrite)) return -1;
				}
			}
		}
	}
	return named;
}

const serializeEntry = (entry) => JSON.stringify(persisted(entry), encodeNonFinite);

function stringBytes(value) {
	return typeof value === "string" ? value.length * (/[^\x00-\xff]/.test(value) ? 2 : 1) : 0;
}

function entryBytes(entry, line) {
	let strings = 0;
	let modelBytes = 0;
	for (const key of ENTRY_STRING_KEYS) strings += stringBytes(entry[key]);
	for (const name of USAGE_KEYS) {
		for (const key in entry[name]?.models) {
			strings += stringBytes(key);
			modelBytes += MODEL_COUNTER_BYTES;
		}
		for (const key in entry[name]?.usedModels) strings += stringBytes(key);
	}
	// The serialized weight also approximates variable-size non-string data (e.g. model
	// counters). It is a floor, not a measure of the resident strings' encoding.
	let serialized = line.length;
	for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 127) serialized++;
	return INDEX_ENTRY_OVERHEAD + modelBytes + Math.max(strings, serialized);
}

function fitsIndexLine(text) {
	return stringBytes(text) <= INDEX_LINE_BYTE_BUDGET && Buffer.byteLength(text) <= INDEX_LINE_BYTE_BUDGET;
}

function* indexChunks(entries, weights, full) {
	yield `${full ? FULL_HEADER : INDEX_HEADER}\n`;
	for (const entry of [...entries.values()].sort((a, b) => b.checkedMs - a.checkedMs)) {
		if (entry.state === "ok" && weights.get(entry).slots === null) continue; // Recount still pending.
		yield `${serializeEntry(entry)}\n`;
	}
}

const isId = (value) => typeof value === "string" && value.length > 0;

/** The dashboard can look up aliases using only the daemon's published ownership. */
export function publishedUsageView(usage) {
	return { get: (id) => usage.get(id), getForSubject: (subject) => usageEntryFor(usage, subject), values: () => usage.values(), full: usage.full, publishedOwnership: true };
}

/** Session ids are authoritative; a task id is only a lookup for a sessionless row. */
export function usageEntryFor(usage, subject, taskId) {
	if (subject?.sessionId) {
		if (usage?.getForSubject) return usage.getForSubject(subject);
		if (subject.projectKey != null) return usage?.get(subjectKey(subject));
		return uniqueMatch(usage?.values() ?? [], (entry) => entry?.id === subject.sessionId ? entry : undefined);
	}
	if (!isId(taskId)) return undefined;
	let match;
	for (const entry of usage?.values() ?? []) {
		if (entry?.taskId !== taskId || subjectOf(entry).projectKey !== subject?.projectKey) continue;
		if (match) return undefined;
		match = entry;
	}
	// An exact ID can still identify its file where a task-only alias cannot.
	if (match?.kind === "child" && match.state === "ok" && match.file) {
		const owned = usage.publishedOwnership ? match.ownershipUnique === true
			: isTaskOnlyEntry(match) ? canShowTaskOnlyUsage(match) : isSoleChildSessionFile(match.file);
		if (!owned) return undefined;
	}
	return match;
}

/** Snapshot the subject and descendants for one audit, not the resident scan cursors. */
export function relatedUsageEntries(index, sessionId) {
	const related = [];
	for (const entry of index?.values() ?? []) {
		let matches = entry.id === sessionId || entry.rootSessionId === sessionId;
		let parent = parentSubject(entry);
		for (let depth = 0; !matches && parent && depth < TREE_DEPTH; depth += 1) {
			const ancestor = (index.getExact ?? index.get).call(index, subjectKey(parent));
			matches = ancestor?.id === sessionId;
			parent = ancestor && parentSubject(ancestor);
		}
		if (matches) {
			// A partial record may contain a large buffer or scanner functions.
			const { partial, ...snapshot } = entry;
			related.push(snapshot);
		}
	}
	return related;
}

/**
 * `{file, clock, log, read}`: `file` is the only path ever written, and only
 * `save()` writes it. The file is loaded here, so a fresh process resumes every
 * persisted cursor; an unsupported or corrupt header starts the index empty, and the
 * memory-only keys are never taken from disk. `read` defaults to `readUsage` and
 * lets tests inject a read failure.
 */
export function createUsageIndex({ file, clock, log, read = readUsage } = {}) {
	const loaded = loadUsageIndex(file);
	const { entries, weights } = loaded;
	let { named, bytes, full } = loaded;
	let dirty = loaded.truncated;

	const unweigh = (id) => {
		const weight = weights.get(id);
		if (!weight) return;
		named -= weight.slots ?? 0;
		bytes -= weight.bytes;
		weights.delete(id);
	};

	const admit = (entry, slots) => {
		const key = entry;
		const line = serializeEntry(entry);
		const size = entryBytes(entry, line);
		if (bytes + size > INDEX_BYTE_BUDGET || !fitsIndexLine(line)) {
			if (entries.delete(key) || !full) dirty = true;
			full = true;
			return FULL_ENTRY;
		}
		dirty = true;
		entry.projectKey = entries.canonicalProject(entry.projectKey);
		entries.set(key, entry);
		weights.set(key, { slots, bytes: size });
		bytes += size;
		named += slots ?? 0;
		return entry;
	};

	const dropCursor = (entry) => {
		Object.assign(entry, newEntry(subjectOf(entry)), persistedMeta(entry), { checkedMs: entry.checkedMs });
		delete entry.ownershipUnique;
		entry.partial = undefined;
		entry.scanOffset = undefined;
		delete entry.pending;
	};

	return {
		file,
		recordParentLink(subject, meta) {
			const entry = entries.get(subject);
			if (!entry || !Object.hasOwn(entry, "parentKey")) return false;
			const previous = entry.parentKey;
			applyMeta(entry, { parentKey: meta });
			if (previous === entry.parentKey) return false;
			const { slots } = weights.get(subject);
			unweigh(subject);
			admit(entry, slots);
			return true;
		},
		get full() { return full; },
		getExact(key) { return entries.get(key) ?? (full && key ? FULL_ENTRY : undefined); },
		getForSubject(subject) {
			const entry = entries.getForSubject(subject);
			// Saturated: an absent row may have been skipped at capacity; an ambiguous one (null) stays unresolved.
			return entry === undefined && full ? FULL_ENTRY : entry;
		},
		get(key, taskId) {
			if (typeof key === "object" && key !== null) {
				const entry = usageEntryFor(entries, key, taskId);
				return entry === undefined && full && taskId ? FULL_ENTRY : entry ?? undefined;
			}
			// No rejected path or id is retained. While saturated, an absent row
			// cannot be distinguished from one skipped at the capacity boundary.
			const subject = parseSubjectKey(key);
			const entry = subject ? entries.getForSubject(subject) : undefined;
			return entry === undefined && full && key ? FULL_ENTRY : entry ?? undefined;
		},
		has(key, taskId) {
			if (typeof key === "object" && key !== null) return usageEntryFor(entries, key, taskId) != null;
			const subject = parseSubjectKey(key);
			return subject != null && entries.getForSubject(subject) != null;
		},
		values: () => entries.values(),
		recordOwnership(id, unique) {
			const entry = entries.get(id);
			if (!entry || entry.ownershipUnique === unique) return false;
			const { slots } = weights.get(id);
			unweigh(id);
			entry.ownershipUnique = unique;
			admit(entry, slots);
			return true;
		},
		checkAliasOwnership(id) {
			const entry = entries.get(id);
			return this.recordOwnership(id, isSoleChildSessionFile(entry?.file));
		},
		/**
		 * Read up to `maxBytes` more bytes of `file`. Returns bytesRead, including
		 * bytes spent before a read error. A missing file marks the entry missing
		 * (or, after a complete read, gone); a read error keeps the saved totals
		 * while `readError` hides them from the board.
		 */
		update(subject, path, meta = {}, { maxBytes = Infinity, ownershipUnique } = {}) {
			const id = subject;
			const stored = entries.get(id);
			const entry = stored && Object.hasOwn(stored, "file") ? stored : newEntry(subject);
			if (stored && entry !== stored) {
				entry.state = "ok";
				entry.offset = 0;
			}
			const previousSlots = weights.get(id)?.slots ?? null;
			unweigh(id);
			const sameFile = entry.file && pathKey(entry.file) === pathKey(path);
			entry.file = path;
			applyMeta(entry, meta);
			if (entry.kind === "child" && entry.taskId && ownershipUnique !== null) {
				entry.ownershipUnique = ownershipUnique ?? isSoleChildSessionFile(path);
			} else if (!sameFile || entry.kind !== "child" || !entry.taskId) delete entry.ownershipUnique;
			entry.checkedMs = clock.now();
			// Keep any last published total for a missing file, but never resume or compare a malformed cursor.
			const canResume = !isTaskOnlyEntry(entry) || (sameFile && !entry.gone);
			const from = canResume && hasNumericCursor(entry) ? entry : undefined;
			let result;
			let bytesRead = 0;
			try {
				// Windows reports a directory as a zero-byte stream, so readUsage would succeed on one; a session file is never a directory.
				if (statSafe(path)?.isDirectory()) {
					const error = new Error("EISDIR: illegal operation on a directory, read");
					error.code = "EISDIR";
					throw error;
				}
				result = read(path, from, { maxBytes, onScanBytes: (n) => { bytesRead += n; } });
			} catch (error) {
				if (entry.readError !== true) {
					log?.error?.("usage_read_failed", { file: basename(String(path)), error: String(error?.message ?? error) });
				}
				entry.readError = true;
				admit(entry, previousSlots);
				return bytesRead;
			}
			entry.readError = false;
			if (result === null) {
				if (entry.complete === true) {
					entry.gone = true;
				} else {
					dropCursor(entry);
				}
				admit(entry, entry.gone ? previousSlots : 0);
				return 0;
			}
			const restart = isRestart(from, result);
			entry.state = "ok";
			entry.gone = false;
			entry.complete = result.done === true || (!restart && entry.complete === true);
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
			entry.pending = result.pending === true;
			if (result.done === true) entry.published = result.effective;
			else if (restart) entry.published = null;
			const slots = boundedModels(entry, USAGE_INDEX_MODEL_BUDGET - named, entry.pending && entry.published !== null);
			admit(entry, slots);
			return result.bytesRead;
		},
		/**
		 * No session file was located for `id`. A never-found row becomes `missing`;
		 * a row whose complete read already published a total keeps that total and
		 * turns `gone` (IS-3). For a task-only row this requires zero candidates;
		 * a conflicting lookup (including one in another store) clears the claim.
		 */
		markMissing(subject, meta = {}, { withdraw = false } = {}) {
			const id = subject;
			const entry = entries.get(id) ?? newEntry(subject);
			const previousSlots = weights.get(id)?.slots ?? null;
			unweigh(id);
			applyMeta(entry, meta);
			if (meta?.file) entry.file = meta.file;
			const taskOnly = isTaskOnlyEntry(entry);
			const deleted = !taskOnly || (!withdraw && entry.file && soleChildSessionFile(dirname(entry.file)) === undefined);
			if (entry.state === "ok" && entry.complete === true && deleted) {
				entry.gone = true;
				// Zero candidates leaves a previously counted file's ownership unchallenged.
				if (taskOnly) entry.ownershipUnique = true;
				else delete entry.ownershipUnique;
			} else {
				dropCursor(entry);
				if (taskOnly) {
					entry.file = null;
					entry.readError = false;
					entry.ownershipUnique = false;
				}
			}
			entry.checkedMs = clock.now();
			return admit(entry, entry.gone ? previousSlots : 0);
		},
		fresh,
		atEnd,
		entries() {
			return [...entries.values()];
		},
		/** Write the index when anything changed; returns whether it wrote. */
		save() {
			if (!dirty) return false;
			atomicWriteChunks(file, indexChunks(entries, weights, full));
			dirty = false;
			return true;
		},
		/** Drop entries not checked since `nowMs - keepMs`. */
		prune(nowMs, keepMs = PRUNE_KEEP_MS) {
			const cutoff = nowMs - keepMs;
			let removed = 0;
			for (const [id, entry] of entries.subjects()) {
				const checked = Number.isFinite(entry.checkedMs) ? entry.checkedMs : 0;
				if (checked < cutoff && entries.delete(id)) {
					unweigh(id);
					removed += 1;
				}
			}
			if (removed) {
				full = false;
				dirty = true;
			}
			return removed;
		},
	};
}

function* indexLines(file) {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let parts = [];
		let carried = 0;
		let skipping = false;
		let header = true;
		let size;
		while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
			const chunk = buffer.subarray(0, size);
			let start = 0;
			for (let end; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
				if (!skipping && carried + end - start <= INDEX_LINE_BYTE_BUDGET) {
					const tail = chunk.subarray(start, end);
					yield parts.length ? Buffer.concat([...parts, tail]) : tail;
				} else if (header) return;
				parts = [];
				carried = 0;
				skipping = false;
				header = false;
			}
			if (start < size && !skipping) {
				if (header && start === 0 && size > FULL_HEADER.length + 1) return;
				carried += size - start;
				if (carried > INDEX_LINE_BYTE_BUDGET) {
					parts = [];
					skipping = true; // Discard only through this line's newline, even across chunks.
				} else parts.push(Buffer.from(chunk.subarray(start)));
			}
		}
		if (parts.length) yield Buffer.concat(parts);
	} finally {
		fs.closeSync(fd);
	}
}

function loadUsageIndex(file, trackWeights = true) {
	const entries = new SubjectMap({ ordered: true });
	const weights = new SubjectMap();
	let named = 0;
	let bytes = 0;
	let full = false;
	let truncated = false;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		function* rows() {
			let header = true;
			for (const line of indexLines(file)) {
				if (header) {
					const signature = line.toString("utf8").replace(/\r$/, "");
					if (signature !== INDEX_HEADER && signature !== FULL_HEADER) return;
					full ||= signature === FULL_HEADER;
					header = false;
					continue;
				}
				let text;
				let row;
				try {
					text = decoder.decode(line);
					if (stringBytes(text) > INDEX_LINE_BYTE_BUDGET) continue;
					row = JSON.parse(text);
				} catch {
					continue;
				}
				const key = record(row) && typeof row.id === "string" && row.id &&
					(typeof row.projectKey === "string" || row.projectKey === null ? row : subjectOf(row));
				if (key && !entries.has(key)) yield { row, key, text };
			}
		}
		let sawInvalid = false;
		for (const { row, text } of rows()) {
			const slots = validateEntry(row, USAGE_INDEX_MODEL_BUDGET - named);
			if (slots < 0) {
				sawInvalid = true;
				continue;
			}
			const { parentKey, rootKey } = row;
			if (parentKey !== null || rootKey !== null) applyMeta(row, {});
			const compacted = parentKey !== row.parentKey || rootKey !== row.rootKey;
			const size = entryBytes(row, compacted ? serializeEntry(row) : text.trimEnd());
			if (bytes + size > INDEX_BYTE_BUDGET) {
				full = truncated = true;
				break;
			}
			row.projectKey = entries.canonicalProject(row.projectKey);
			entries.set(row, row);
			bytes += size;
			named += slots;
			if (trackWeights) weights.set(row, { slots, bytes: size });
		}
		// The writer orders intact rows newest first. Only spend leftover space
		// on recounts; a second pass avoids buffering damaged rows or their IDs.
		const markerOverhead = 432; // Map/weight buckets, ordering and the fixed marker shape.
		if (sawInvalid && bytes + markerOverhead < INDEX_BYTE_BUDGET) {
			for (const { row, key } of rows()) {
				const { id } = row;
				const projectKey = entries.canonicalProject(key.projectKey);
				const size = markerOverhead + stringBytes(id) + stringBytes(projectKey);
				if (bytes + size > INDEX_BYTE_BUDGET || validateEntry(row, USAGE_INDEX_MODEL_BUDGET - named) >= 0) continue;
				const marker = { id, projectKey, state: "ok", complete: false, offset: 0 };
				entries.set(marker, marker);
				bytes += size;
				if (trackWeights) weights.set(marker, { slots: null, bytes: size });
			}
		}
		return { entries, weights, named, bytes, full, truncated };
	} catch {
		return { entries: new SubjectMap({ ordered: true }), weights: new SubjectMap(), named: 0, bytes: 0, full: false, truncated: false };
	}
}

/** The index as the dashboard reads it: a scoped map, empty when absent or the header is invalid. */
export function readUsageIndex(file) {
	const { entries, full } = loadUsageIndex(file, false);
	if (full) Object.defineProperty(entries, "full", { value: true });
	return entries;
}
