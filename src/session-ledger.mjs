import fs from "node:fs";
import path from "node:path";
import { projectKeyOf, sessionSubjects, subjectOf } from "./session-subject.mjs";
import { ensureDir, listDirSafe } from "./util/fsx.mjs";
import { redact, sha1, truncate } from "./util/text.mjs";

const DAY_MS = 86_400_000;
const DEDUPE_DAYS = 30;
const REASON_MAX = 300;
const FILE_RE = /^ended-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const ENDED_LOCATION = Symbol("ended ledger location");

function dayOf(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

function ledgerFiles(paths, sinceDay, beforeDay) {
	return listDirSafe(paths.health.sessionsDir)
		.map((name) => ({ name, m: FILE_RE.exec(name) }))
		.filter((f) => f.m && (!sinceDay || f.m[1] >= sinceDay) && (!beforeDay || f.m[1] <= beforeDay))
		.sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1))
		.map((f) => path.join(paths.health.sessionsDir, f.name));
}

/** Ended records with endedMs >= sinceMs, newest first. */
export function readEnded(paths, { sinceMs } = {}) {
	return [...streamEnded(paths, { sinceMs })].sort((a, b) => Number(b.endedMs) - Number(a.endedMs));
}

function ledgerFile(paths, endedMs) {
	return path.join(paths.health.sessionsDir, `ended-${dayOf(endedMs)}.jsonl`);
}

function* ledgerLines(file, fsImpl = fs) {
	const chunk = Buffer.allocUnsafe(64 * 1024);
	let fd;
	try {
		fd = fsImpl.openSync(file, "r");
		let parts = [];
		let offset = 0;
		for (let n; (n = fsImpl.readSync(fd, chunk, 0, chunk.length, null));) {
			const bytes = chunk.subarray(0, n);
			let start = 0;
			for (let end; (end = bytes.indexOf(10, start)) !== -1; start = end + 1) {
				const tail = bytes.subarray(start, end);
				const line = parts.length ? Buffer.concat([...parts, tail]) : tail;
				yield { line, offset };
				offset += line.length + 1;
				parts = [];
			}
			if (start < n) parts.push(Buffer.from(bytes.subarray(start)));
		}
		if (parts.length) yield { line: Buffer.concat(parts), offset, unterminated: true };
	} catch {
		// Like the array reader, tolerate a ledger file disappearing during a read.
	} finally {
		if (fd !== undefined) fsImpl.closeSync(fd);
	}
}

function parseRow(line) {
	try {
		const row = JSON.parse(line.toString("utf8"));
		if (typeof row?.sessionId === "string") return row;
	} catch {
		// Tolerate corrupt lines.
	}
}

function* streamFile(file, sinceMs, withLocation, fsImpl = fs, beforeMs) {
	for (const { line, offset } of ledgerLines(file, fsImpl)) {
		const row = parseRow(line);
		if (!row || (Number.isFinite(sinceMs) && !(Number(row.endedMs) >= sinceMs))
			|| (Number.isFinite(beforeMs) && !(Number(row.endedMs) < beforeMs))) continue;
		if (withLocation) row[ENDED_LOCATION] = { file, offset, length: line.length };
		yield row;
	}
}

/** Ended records in file/line order, with optional inclusive lower and exclusive upper bounds. */
export function* streamEnded(paths, { sinceMs, beforeMs, withLocation = false, fs: fsImpl = fs } = {}) {
	const sinceDay = Number.isFinite(sinceMs) ? dayOf(sinceMs) : "";
	const beforeDay = Number.isFinite(beforeMs) ? dayOf(beforeMs) : "";
	for (const file of ledgerFiles(paths, sinceDay, beforeDay)) yield* streamFile(file, sinceMs, withLocation, fsImpl, beforeMs);
}

/**
 * Resolve a queued row against the append-only ledger without keeping its cwd in memory.
 * The row's byte position is the only read allowed: a day-wide rescan per queued row
 * turns a burst of live exits into a whole-ledger read per child.
 */
export function readEndedCwd(paths, row, { fs: fsImpl = fs } = {}) {
	const location = row?.[ENDED_LOCATION];
	if (!location) return undefined;
	const rec = readLocatedRow(location, fsImpl);
	if (rec?.sessionId === row.sessionId && rec.endedMs === row.endedMs) return rec.cwd;
}

function readLocatedRow({ file, offset, length }, fsImpl = fs) {
	let fd;
	try {
		fd = fsImpl.openSync(file, "r");
		const line = Buffer.allocUnsafe(length);
		let n = 0;
		while (n < length) {
			const read = fsImpl.readSync(fd, line, n, length - n, offset + n);
			if (!read) break;
			n += read;
		}
		if (n === length) return parseRow(line);
	} catch {
		// The ledger may have been rotated since queueing.
	} finally {
		if (fd !== undefined) fsImpl.closeSync(fd);
	}
}

/** Attach positions to requested unpositioned rows, scanning each affected day once. */
export function locateEndedRows(paths, rows, { fs: fsImpl = fs } = {}) {
	const days = new Map();
	for (const row of rows) {
		const endedMs = Number(row.endedMs);
		if (!Number.isFinite(endedMs) || Math.abs(endedMs) > 8.64e15) continue;
		const file = ledgerFile(paths, endedMs);
		if (!days.has(file)) days.set(file, new Map());
		const ids = days.get(file);
		if (!ids.has(row.sessionId)) ids.set(row.sessionId, new Set());
		ids.get(row.sessionId).add(row);
	}
	for (const [file, ids] of days) {
		for (const rec of streamFile(file, undefined, true, fsImpl)) {
			const pending = ids.get(rec.sessionId);
			if (!pending) continue;
			for (const row of pending) {
				if (rec.endedMs !== row.endedMs) continue;
				row[ENDED_LOCATION] = rec[ENDED_LOCATION];
				pending.delete(row);
			}
			if (!pending.size) ids.delete(rec.sessionId);
			if (!ids.size) break;
		}
	}
}

/** Use recorded project identity, not a project inferred later for display or usage. */
export function endedKey(row) {
	if (typeof row?.sessionId !== "string") return undefined;
	const parent = row.parentSessionId || null;
	return JSON.stringify([row.sessionId, parent, projectKeyOf(row.cwd) ?? row.endedProjectKey ?? (parent ? null : row.cwd || null)]);
}

export function endedSelector(row) {
	return sha1(JSON.stringify([endedKey(row), row.endedMs])).slice(0, 16);
}

/** Freeze inherited identity for append, selector lookup and tracker reads. */
function scopeEndedRow(row, projectKey) {
	return projectKey && !projectKeyOf(row.cwd) && !row.endedProjectKey
		? { ...row, endedProjectKey: projectKey }
		: row;
}

function scopeEndedRecords(paths, records, liveRows) {
	if (!records.some((row) => row?.parentSessionId && !subjectOf(row).projectKey)) {
		return records.map((row) => scopeEndedRow(row, subjectOf(row).projectKey));
	}
	liveRows = [...(liveRows ?? [])];
	const batch = sessionSubjects(records);
	const current = liveRows.length ? sessionSubjects([...records, ...liveRows]) : batch;
	const scoped = records.map((row) => scopeEndedRow(row, batch(row).projectKey ?? current(row).projectKey));
	let parents = new Set(scoped.filter((row) => row?.parentSessionId && !subjectOf(row).projectKey).map((row) => row.parentSessionId));
	if (!parents.size) return scoped;

	// Parents may predate the dedupe window. Retain only their identity and
	// follow unresolved ancestor links, never holding the full ledger in memory.
	const family = [];
	const visited = new Set();
	for (let depth = 0; depth < 8 && parents.size; depth++) {
		const next = new Set();
		for (const id of parents) visited.add(id);
		const add = (row) => {
			const sessionId = row?.sessionId ?? row?.id;
			if (!parents.has(sessionId)) return;
			const { projectKey } = subjectOf(row);
			const parentSessionId = projectKey ? null : row.parentSessionId;
			family.push({ sessionId, projectKey, parentSessionId });
			if (parentSessionId && !visited.has(parentSessionId)) next.add(parentSessionId);
		};
		for (const row of scoped) add(row);
		for (const row of liveRows) add(row);
		for (const row of streamEnded(paths)) add(row);
		parents = next;
	}
	const resolve = sessionSubjects(family);
	return scoped.map((row) => scopeEndedRow(row, resolve(row).projectKey));
}

/** Look up a record's identity, or any occurrence of a bare session ID, in the last 30 days. */
export function hasEnded(paths, record, { nowMs = Date.now(), liveRows } = {}) {
	return typeof record === "string" ? hasEndedKey(paths, record, nowMs, true)
		: hasEndedKey(paths, endedKey(scopeEndedRecords(paths, [record], liveRows)[0]), nowMs);
}

function hasEndedKey(paths, key, nowMs, byId = false) {
	if (key === undefined) return false;
	// The cutoff selects files, not rows: the entire cutoff day's file
	// participates in duplicate detection.
	const cutoff = nowMs - DEDUPE_DAYS * DAY_MS;
	const sinceDay = Number.isFinite(cutoff) ? dayOf(cutoff) : "";
	for (const file of ledgerFiles(paths, sinceDay)) {
		for (const row of streamFile(file)) if ((byId ? row.sessionId : endedKey(row)) === key) return true;
	}
	return false;
}

/** Append one ended record; returns false when the session is already recorded. */
export function appendEnded(paths, record, options = {}) {
	return appendEndedLocated(paths, record, options).appended;
}

/**
 * Append one ended record and report where its line landed, so the live token
 * queue can read that line back without scanning the day. `appended` mirrors
 * `appendEnded`; `location` is null when nothing was written.
 */
export function appendEndedLocated(paths, record, { nowMs = Date.now(), liveRows } = {}) {
	record = scopeEndedRecords(paths, [record], liveRows)[0];
	if (hasEndedKey(paths, endedKey(record), Math.max(nowMs, Number(record.endedMs) || 0))) return { appended: false, location: null };
	return writeEnded(paths, record);
}

/**
 * Append ends in input order with a shared disk scan. Backfill can also supply
 * its own window's recorded keys; successful writes are added to that set.
 */
export function appendEndedBatch(paths, records, { nowMs = Date.now(), recorded, liveRows } = {}) {
	const skipped = { appended: false, location: null };
	const candidates = new Set();
	let earliest;
	const pending = scopeEndedRecords(paths, records, liveRows).map((record) => {
		let id;
		try {
			id = endedKey(record);
			if (recorded?.has(id)) return { id, result: skipped };
			const ms = Math.max(nowMs, Number(record.endedMs) || 0) - DEDUPE_DAYS * DAY_MS;
			const cutoff = Number.isFinite(ms) ? dayOf(ms) : "";
			if (earliest === undefined || cutoff < earliest) earliest = cutoff;
			if (id !== undefined) candidates.add(id);
			return { record, id, cutoff };
		} catch (error) {
			return { id, result: { ...skipped, error } };
		}
	});
	const newest = new Map();
	const tails = new Map();
	const tailDays = new Map();
	for (const file of candidates.size ? ledgerFiles(paths, earliest) : []) {
		const [, day] = FILE_RE.exec(path.basename(file));
		for (const { line, offset, unterminated } of ledgerLines(file)) {
			const id = endedKey(parseRow(line));
			if (unterminated) {
				tails.set(file, { offset, id });
				if (candidates.has(id)) {
					if (!tailDays.has(id)) tailDays.set(id, new Set());
					tailDays.get(id).add(day);
				}
			} else if (candidates.has(id) && !newest.has(id)) {
				newest.set(id, day);
			}
		}
	}
	return pending.map(({ record, id, cutoff, result }) => {
		if (recorded?.has(id)) return skipped;
		if (result) return result;
		if (newest.get(id) >= cutoff) return skipped;
		for (const day of tailDays.get(id) ?? []) if (day >= cutoff) return skipped;
		try {
			let writtenId;
			const written = writeEnded(paths, record, (line) => { writtenId = endedKey(parseRow(line)); });
			recorded?.add(id);
			const { file, offset, length } = written.location;
			const day = FILE_RE.exec(path.basename(file))?.[1];
			const tail = tails.get(file);
			if (tail) {
				// Preserve sequential bytes: the write joined the old tail. Only
				// that merged line (not the old tail or the new row alone) is visible.
				tails.delete(file);
				tailDays.get(tail.id)?.delete(day);
				writtenId = endedKey(readLocatedRow({ file, offset: tail.offset, length: offset - tail.offset + length }));
			}
			if (day && candidates.has(writtenId) && day > (newest.get(writtenId) ?? "")) newest.set(writtenId, day);
			return written;
		} catch (error) {
			return { ...skipped, error };
		}
	});
}

function writeEnded(paths, record, onLine) {
	const rec = { v: 1, ...record, reason: truncate(redact(String(record.reason ?? "")), REASON_MAX) };
	ensureDir(paths.health.sessionsDir);
	const file = ledgerFile(paths, Number(rec.endedMs));
	const line = `${JSON.stringify(rec)}\n`;
	const offset = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
	fs.appendFileSync(file, line);
	onLine?.(line);
	return { appended: true, location: { file, offset, length: Buffer.byteLength(line) - 1 } };
}
