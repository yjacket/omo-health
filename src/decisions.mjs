import fs from "node:fs";
import path from "node:path";
import { appendJsonl, listDirSafe } from "./util/fsx.mjs";
import { redact } from "./util/text.mjs";

/**
 * Append-only decision log (design 5.6): one JSON line per decision in
 * healthHome/decisions/<YYYY-MM-DD>.jsonl. Machine-readable evidence of every
 * action, would-action, skip and judge call.
 */
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const detail = (parts) => parts.filter(Boolean).join("; ").slice(0, 200);

/** The one-line outcome of an action decision, as the history samples and the session record show it. */
export function actionDetail(entry) {
	const o = isRecord(entry.outcome) ? entry.outcome : {};
	const pids = (list) => (Array.isArray(list) && list.length ? list.map((p) => p?.pid ?? p).join(",") : null);
	return detail([pids(o.killed) && `killed ${pids(o.killed)}`, pids(o.survived) && `survived ${pids(o.survived)}`, o.delivered !== undefined && `delivered ${o.delivered}`, o.via && `via ${o.via}`, o.error && `error ${o.error}`, entry.rule && `rule ${isRecord(entry.rule) ? entry.rule.id : entry.rule}`]);
}

export function appendDecision(paths, entry) {
	const ts = entry.ts ?? new Date().toISOString();
	const file = path.join(paths.health.decisionsDir, `${ts.slice(0, 10)}.jsonl`);
	appendJsonl(file, JSON.parse(redact(JSON.stringify({ ...entry, ts }))));
	return file;
}

export function readDecisions(paths, sinceMs = 0) {
	const out = [];
	for (const name of listDirSafe(paths.health.decisionsDir).filter((n) => n.endsWith(".jsonl")).sort()) {
		if (Date.parse(`${name.slice(0, 10)}T23:59:59Z`) < sinceMs) continue;
		for (const line of fs.readFileSync(path.join(paths.health.decisionsDir, name), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (Date.parse(entry.ts) >= sinceMs) out.push(entry);
			} catch {
				// skip malformed
			}
		}
	}
	return out;
}

function parseDecision(line) {
	try {
		const entry = JSON.parse(line.toString("utf8"));
		return Number.isFinite(Date.parse(entry?.ts)) ? entry : null;
	} catch {
		return null;
	}
}

/** Stream every retained day, oldest first, in append order within each day. */
export function* streamDecisions(paths) {
	const dir = paths.health.decisionsDir;
	const chunk = Buffer.allocUnsafe(64 * 1024);
	for (const name of listDirSafe(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
		let fd;
		try {
			fd = fs.openSync(path.join(dir, name), "r");
			let parts = [];
			for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null));) {
				const bytes = chunk.subarray(0, n);
				let start = 0;
				for (let end; (end = bytes.indexOf(10, start)) !== -1; start = end + 1) {
					const tail = bytes.subarray(start, end);
					const entry = parseDecision(parts.length ? Buffer.concat([...parts, tail]) : tail);
					parts = [];
					if (entry) yield entry;
				}
				if (start < n) parts.push(Buffer.from(bytes.subarray(start)));
			}
			const last = parts.length ? parseDecision(Buffer.concat(parts)) : null;
			if (last) yield last;
		} catch {
			// A retained file may disappear or be unreadable during a scan.
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
}
