import fs from "node:fs";
import path from "node:path";
import { encodeClaudeProjectDir } from "../paths.mjs";
import { listDirSafe, statSafe } from "../util/fsx.mjs";

const TAIL_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NOT_FOUND_RETRY_MS = 60_000;

/**
 * Recover the model's original tool intent (run_in_background, timeout) from
 * the Claude Code transcript: senpi drops `run_in_background` when it maps
 * Bash input (F-1), but the transcript keeps it and `tool_use.id` equals the
 * senpi toolCall id (F-10). Only files touched since the call are opened and
 * only their last 32 MB is searched.
 *
 * Memory: the search walks backwards in 1 MB chunks over raw bytes and decodes
 * only the matching line. A "not found" is retried after 60 s but only over the
 * bytes appended since the previous look (whole 32 MB reads every minute were
 * the daemon's largest RSS spikes).
 */
export function createTranscriptIndex({ claudeProjectsDir, clock, chunkBytes = CHUNK_BYTES, tailBytes = TAIL_BYTES }) {
	const cache = new Map();

	function readRange(fd, start, length) {
		const buf = Buffer.allocUnsafe(length);
		const read = fs.readSync(fd, buf, 0, length, start);
		return read === length ? buf : buf.subarray(0, read);
	}

	/** Byte offset of the last `needle` in [from, to), or -1; chunks overlap so a needle across a boundary is found. */
	function lastIndexIn(fd, needle, from, to) {
		let end = to;
		while (end > from) {
			const start = Math.max(from, end - chunkBytes);
			const at = readRange(fd, start, end - start).lastIndexOf(needle);
			if (at >= 0) return start + at;
			if (start === from) return -1;
			end = start + needle.length - 1;
		}
		return -1;
	}

	/** The full line holding byte `pos`, decoded. */
	function lineAt(fd, pos, size) {
		let lineStart = 0;
		for (let end = pos; end > 0; ) {
			const start = Math.max(0, end - chunkBytes);
			const newline = readRange(fd, start, end - start).lastIndexOf(0x0a);
			if (newline >= 0) {
				lineStart = start + newline + 1;
				break;
			}
			end = start;
		}
		let lineEnd = size;
		for (let start = pos; start < size; ) {
			const length = Math.min(chunkBytes, size - start);
			const newline = readRange(fd, start, length).indexOf(0x0a);
			if (newline >= 0) {
				lineEnd = start + newline;
				break;
			}
			start += length;
		}
		return readRange(fd, lineStart, lineEnd - lineStart).toString("utf8");
	}

	function parseToolUse(line, toolCallId, file) {
		try {
			const entry = JSON.parse(line);
			const content = entry?.message?.content;
			const toolUse = Array.isArray(content) ? content.find((item) => item?.type === "tool_use" && item.id === toolCallId) : undefined;
			if (!toolUse) return undefined;
			const input = toolUse.input ?? {};
			return {
				tool: toolUse.name,
				runInBackground: input.run_in_background === true,
				timeoutMs: typeof input.timeout === "number" ? input.timeout : undefined,
				description: typeof input.description === "string" ? input.description.slice(0, 200) : undefined,
				file,
			};
		} catch {
			return undefined;
		}
	}

	/** Search `file` from byte `fromOffset` (the part not searched before) for the tool_use line. */
	function scanFile(file, toolCallId, fromOffset, size) {
		const needle = Buffer.from(`"id":"${toolCallId}"`);
		const from = Math.max(0, size - tailBytes, fromOffset - needle.length);
		if (from >= size) return undefined;
		let fd;
		try {
			fd = fs.openSync(file, "r");
			let end = size;
			while (end > from) {
				const at = lastIndexIn(fd, needle, from, end);
				if (at < 0) return undefined;
				const found = parseToolUse(lineAt(fd, at, size), toolCallId, file);
				if (found) return found;
				end = at + needle.length - 1;
			}
			return undefined;
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	return {
		find({ toolCallId, cwd, sinceMs }) {
			if (!toolCallId || !cwd) return null;
			const cached = cache.get(toolCallId);
			const now = clock.now();
			if (cached && (cached.value || now - cached.at < NOT_FOUND_RETRY_MS)) return cached.value;
			const scanned = cached?.scanned ?? new Map();
			const dir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
			let value = null;
			for (const name of listDirSafe(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const file = path.join(dir, name);
				const stat = statSafe(file);
				if (!stat || stat.mtimeMs < (sinceMs ?? 0) - 60_000) continue;
				const found = scanFile(file, toolCallId, scanned.get(file) ?? 0, stat.size);
				scanned.set(file, stat.size);
				if (found) {
					value = found;
					break;
				}
			}
			cache.set(toolCallId, { at: now, value, scanned: value ? undefined : scanned });
			if (cache.size > 2000) cache.delete(cache.keys().next().value);
			return value;
		},
	};
}
