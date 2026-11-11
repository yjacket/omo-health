import fs from "node:fs";
import path from "node:path";
import { listDirSafe } from "../util/fsx.mjs";

const TAIL_BYTES = 256 * 1024;

/**
 * omo-keepalive's idle cache warm-up for one session: the newest `segment_open` record of
 * `<keepwarmHome>/records/<YYYY-MM>/<sessionId>.jsonl` (keepalive extension/keepwarm/records.mjs).
 * @returns {{record: false} | {record: true, eligible: boolean, disabledReason: string|null, disabledDetail: string|null, ms: number|undefined}}
 */
export function readWarmup(keepwarmHome, sessionId) {
	if (!keepwarmHome || !sessionId) return { record: false };
	const recordsDir = path.join(keepwarmHome, "records");
	for (const month of listDirSafe(recordsDir).sort().reverse()) {
		const file = path.join(recordsDir, month, `${sessionId}.jsonl`);
		let text;
		try {
			const stat = fs.statSync(file);
			const fd = fs.openSync(file, "r");
			try {
				const length = Math.min(stat.size, TAIL_BYTES);
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, stat.size - length);
				text = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/).reverse();
		for (const line of lines) {
			if (!line.includes('"segment_open"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "segment_open") continue;
				return { record: true, eligible: entry.eligible === true, disabledReason: entry.disabledReason ?? null, disabledDetail: entry.disabledDetail ?? null, ms: Date.parse(entry.ts) || undefined };
			} catch {
				// a torn first line of the tail window
			}
		}
	}
	return { record: false };
}
