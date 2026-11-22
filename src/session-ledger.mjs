import fs from "node:fs";
import path from "node:path";
import { ensureDir, listDirSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

const DAY_MS = 86_400_000;
const DEDUPE_DAYS = 30;
const REASON_MAX = 300;
const FILE_RE = /^ended-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const ENDED_LOCATION = Symbol("ended ledger location");

function dayOf(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

function ledgerFiles(paths, sinceMs) {
	const sinceDay = Number.isFinite(sinceMs) ? dayOf(sinceMs) : null;
	return listDirSafe(paths.health.sessionsDir)
		.map((name) => ({ name, m: FILE_RE.exec(name) }))
		.filter((f) => f.m && (!sinceDay || f.m[1] >= sinceDay))
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

function* ledgerLines(file) {
	const chunk = Buffer.allocUnsafe(64 * 1024);
	let fd;
	try {
		fd = fs.openSync(file, "r");
		let parts = [];
		let offset = 0;
		for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null));) {
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
		if (parts.length) yield { line: Buffer.concat(parts), offset };
	} catch {
		// Like the array reader, tolerate a ledger file disappearing during a read.
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
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

function* streamFile(file, sinceMs, withLocation) {
	for (const { line, offset } of ledgerLines(file)) {
		const row = parseRow(line);
		if (!row || (Number.isFinite(sinceMs) && !(Number(row.endedMs) >= sinceMs))) continue;
		if (withLocation) row[ENDED_LOCATION] = { file, offset, length: line.length };
		yield row;
	}
}

/** Ended records in file/line order; callers needing newest-first order sort their selections. */
export function* streamEnded(paths, { sinceMs, withLocation = false } = {}) {
	for (const file of ledgerFiles(paths, sinceMs)) yield* streamFile(file, sinceMs, withLocation);
}

/** Resolve a queued row against the append-only ledger without keeping its cwd in memory. */
export function readEndedCwd(paths, row) {
	const location = row[ENDED_LOCATION];
	const matches = (rec) => rec?.sessionId === row.sessionId && rec.endedMs === row.endedMs;
	if (location) {
		const { file, offset, length } = location;
		let fd;
		try {
			fd = fs.openSync(file, "r");
			const line = Buffer.allocUnsafe(length);
			let n = 0;
			while (n < length) {
				const read = fs.readSync(fd, line, n, length - n, offset + n);
				if (!read) break;
				n += read;
			}
			const rec = n === length ? parseRow(line) : undefined;
			if (matches(rec)) return rec.cwd;
		} catch {
			// The ledger may have been rotated since queueing.
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	// Live exits are queued just after appending, so their date is known but
	// they do not have a byte position yet.
	const endedMs = Number(row.endedMs);
	if (!Number.isFinite(endedMs) || Math.abs(endedMs) > 8.64e15) return undefined;
	const file = location?.file ?? ledgerFile(paths, endedMs);
	for (const rec of streamFile(file)) if (matches(rec)) return rec.cwd;
}

/** True when the sessionId appears in the ledger files of the last 30 days. */
export function hasEnded(paths, sessionId, { nowMs = Date.now() } = {}) {
	// The cutoff selects files, not rows: the entire cutoff day's file
	// participates in duplicate detection.
	for (const file of ledgerFiles(paths, nowMs - DEDUPE_DAYS * DAY_MS)) {
		for (const row of streamFile(file)) if (row.sessionId === sessionId) return true;
	}
	return false;
}

/** Append one ended record; returns false when the session is already recorded. */
export function appendEnded(paths, record, { nowMs = Date.now() } = {}) {
	if (hasEnded(paths, record.sessionId, { nowMs: Math.max(nowMs, Number(record.endedMs) || 0) })) return false;
	const rec = { v: 1, ...record, reason: truncate(redact(String(record.reason ?? "")), REASON_MAX) };
	ensureDir(paths.health.sessionsDir);
	const file = ledgerFile(paths, Number(rec.endedMs));
	fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
	return true;
}
