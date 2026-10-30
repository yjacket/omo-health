import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./util/fsx.mjs";
import { redact } from "./util/text.mjs";

const ROTATE_BYTES = 5 * 1024 * 1024;

/** JSONL logger for the daemon's own diagnostics (never session content). */
export function createLogger({ file, clock, echo = false, level = "info" } = {}) {
	const order = { debug: 0, info: 1, warn: 2, error: 3 };
	const threshold = order[level] ?? 1;
	let bytes = 0;
	if (file) {
		ensureDir(path.dirname(file));
		try {
			bytes = fs.statSync(file).size;
		} catch {
			bytes = 0;
		}
	}
	const write = (lvl, event, data) => {
		if ((order[lvl] ?? 1) < threshold) return;
		const record = { ts: new Date(clock ? clock.now() : Date.now()).toISOString(), level: lvl, event, ...data };
		const line = `${redact(JSON.stringify(record))}\n`;
		if (echo) process.stderr.write(line);
		if (!file) return;
		try {
			if (bytes + line.length > ROTATE_BYTES) {
				try {
					fs.renameSync(file, `${file}.1`);
				} catch {
					// rotation is best-effort
				}
				bytes = 0;
			}
			fs.appendFileSync(file, line);
			bytes += line.length;
		} catch {
			// logging must never crash the daemon
		}
	};
	return {
		debug: (event, data = {}) => write("debug", event, data),
		info: (event, data = {}) => write("info", event, data),
		warn: (event, data = {}) => write("warn", event, data),
		error: (event, data = {}) => write("error", event, data),
	};
}

export const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };
