import fs from "node:fs";
import path from "node:path";
import { ensureDir, listDirSafe, readTextSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

const DAY_MS = 86_400_000;
const DEDUPE_DAYS = 30;
const REASON_MAX = 300;
const FILE_RE = /^ended-(\d{4}-\d{2}-\d{2})\.jsonl$/;

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

function parseLines(file) {
	const out = [];
	for (const line of String(readTextSafe(file, "")).split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			if (rec && typeof rec === "object" && typeof rec.sessionId === "string") out.push(rec);
		} catch {
			// tolerate corrupt lines
		}
	}
	return out;
}

/** Ended records with endedMs >= sinceMs, newest first. */
export function readEnded(paths, { sinceMs } = {}) {
	const out = [];
	for (const file of ledgerFiles(paths, sinceMs)) out.push(...parseLines(file));
	return out
		.filter((r) => !Number.isFinite(sinceMs) || Number(r.endedMs) >= sinceMs)
		.sort((a, b) => Number(b.endedMs) - Number(a.endedMs));
}

function* ledgerLines(file) {
	const chunk = Buffer.allocUnsafe(64 * 1024);
	let fd;
	try {
		fd = fs.openSync(file, "r");
		let parts = [];
		for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null));) {
			const bytes = chunk.subarray(0, n);
			let start = 0;
			for (let end; (end = bytes.indexOf(10, start)) !== -1; start = end + 1) {
				const tail = bytes.subarray(start, end);
				yield parts.length ? Buffer.concat([...parts, tail]) : tail;
				parts = [];
			}
			if (start < n) parts.push(Buffer.from(bytes.subarray(start)));
		}
		if (parts.length) yield Buffer.concat(parts);
	} catch {
		// Like the array reader, tolerate a ledger file disappearing during a read.
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Ended records in file/line order; callers needing newest-first order sort their selections. */
export function* streamEnded(paths, { sinceMs } = {}) {
	for (const file of ledgerFiles(paths, sinceMs)) {
		for (const line of ledgerLines(file)) {
			let row;
			try {
				row = JSON.parse(line.toString("utf8"));
			} catch {
				continue;
			}
			if (typeof row?.sessionId === "string" && (!Number.isFinite(sinceMs) || Number(row.endedMs) >= sinceMs)) yield row;
		}
	}
}

/** True when the sessionId appears in the ledger files of the last 30 days. */
export function hasEnded(paths, sessionId, { nowMs = Date.now() } = {}) {
	for (const file of ledgerFiles(paths, nowMs - DEDUPE_DAYS * DAY_MS)) {
		if (parseLines(file).some((r) => r.sessionId === sessionId)) return true;
	}
	return false;
}

/** Append one ended record; returns false when the session is already recorded. */
export function appendEnded(paths, record) {
	if (hasEnded(paths, record.sessionId, { nowMs: Math.max(Date.now(), Number(record.endedMs) || 0) })) return false;
	const rec = { v: 1, ...record, reason: truncate(redact(String(record.reason ?? "")), REASON_MAX) };
	ensureDir(paths.health.sessionsDir);
	const file = path.join(paths.health.sessionsDir, `ended-${dayOf(Number(rec.endedMs))}.jsonl`);
	fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
	return true;
}
