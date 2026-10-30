import fs from "node:fs";
import path from "node:path";
import { appendJsonl, listDirSafe } from "./util/fsx.mjs";
import { redact } from "./util/text.mjs";

/**
 * Append-only decision log (design 5.6): one JSON line per decision in
 * healthHome/decisions/<YYYY-MM-DD>.jsonl. Machine-readable evidence of every
 * action, would-action, skip and judge call.
 */
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
