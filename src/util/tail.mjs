import fs from "node:fs";

const NEWLINE = 0x0a;

/**
 * Incremental JSONL reader. Each readNew() returns only complete lines appended
 * since the previous call. Partial trailing lines are buffered as bytes (so
 * multi-byte UTF-8 split across reads is safe). A shrinking or re-created file
 * is treated as truncation/rotation and read again from the start.
 */
export class JsonlTail {
	/**
	 * @param {string} file
	 * @param {{maxReadBytes?: number, startTailBytes?: number|null}} [options]
	 *   startTailBytes: on the very first read of a large file, start this many
	 *   bytes before the end (the first, likely partial, line is skipped).
	 */
	constructor(file, options = {}) {
		this.file = file;
		this.maxReadBytes = options.maxReadBytes ?? 8 * 1024 * 1024;
		this.startTailBytes = options.startTailBytes ?? null;
		this.offset = 0;
		this.rest = Buffer.alloc(0);
		this.identity = undefined;
		this.started = false;
		this.skipFirstLine = false;
		this.totalBadLines = 0;
		this.totalLines = 0;
		this.resets = 0;
	}

	readNew() {
		let stat;
		try {
			stat = fs.statSync(this.file);
		} catch {
			return { entries: [], badLines: 0, missing: true, reset: false };
		}
		const identity = `${stat.birthtimeMs}:${stat.ino}`;
		let reset = false;
		if (this.started && (stat.size < this.offset || (this.identity !== undefined && identity !== this.identity))) {
			this.offset = 0;
			this.rest = Buffer.alloc(0);
			this.skipFirstLine = false;
			this.resets += 1;
			reset = true;
		}
		if (!this.started) {
			this.started = true;
			if (this.startTailBytes !== null && stat.size > this.startTailBytes) {
				this.offset = stat.size - this.startTailBytes;
				this.skipFirstLine = true;
			}
		}
		this.identity = identity;
		const available = stat.size - this.offset;
		if (available <= 0) return { entries: [], badLines: 0, missing: false, reset };
		const length = Math.min(available, this.maxReadBytes);
		const chunk = Buffer.alloc(length);
		const fd = fs.openSync(this.file, "r");
		let read = 0;
		try {
			read = fs.readSync(fd, chunk, 0, length, this.offset);
		} finally {
			fs.closeSync(fd);
		}
		this.offset += read;
		const buffer = this.rest.length ? Buffer.concat([this.rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
		const lastNewline = buffer.lastIndexOf(NEWLINE);
		if (lastNewline < 0) {
			this.rest = Buffer.from(buffer);
			return { entries: [], badLines: 0, missing: false, reset };
		}
		this.rest = Buffer.from(buffer.subarray(lastNewline + 1));
		const text = buffer.subarray(0, lastNewline).toString("utf8");
		const entries = [];
		let badLines = 0;
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (this.skipFirstLine) {
				this.skipFirstLine = false;
				continue;
			}
			if (!line) continue;
			this.totalLines += 1;
			try {
				entries.push(JSON.parse(line));
			} catch {
				badLines += 1;
			}
		}
		this.totalBadLines += badLines;
		return { entries, badLines, missing: false, reset, more: this.offset < stat.size };
	}
}
