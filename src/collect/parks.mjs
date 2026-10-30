import fs from "node:fs";
import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Read park records: usage limit park episodes where sessions parked and may need resuming.
 * Records are written by omo-limitless and validated here.
 * D20 park-due detection relies on this.
 */
export function readParkRecords(paths, { maxFiles = 500, includeMalformed = false } = {}) {
	const records = listDirSafe(paths.health.parksDir)
		.filter((name) => name.endsWith(".park.json"))
		.map((name) => {
			const file = path.join(paths.health.parksDir, name);
			const stat = statSafe(file);
			const record = parseJson(readFileSafe(file));
			return stat && (record || includeMalformed) ? { file, record, mtimeMs: stat.mtimeMs, name } : undefined;
		})
		.filter(Boolean)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, Math.max(0, maxFiles));

	return records;
}

function readFileSafe(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Validate a park record matches D7 schema: v, required keys, type checks.
 * Returns {ok: true} or {ok: false, error: string}.
 */
export function validateParkRecord(record) {
	if (!record || typeof record !== "object") return { ok: false, error: "not an object" };
	if (record.v !== 1) return { ok: false, error: `v must be 1, got ${record.v}` };

	const required = ["parkId", "sessionId", "createdAt", "resetAt", "status", "terminal"];
	for (const key of required) {
		if (!(key in record)) return { ok: false, error: `missing key: ${key}` };
	}

	// Basic type checks
	if (typeof record.parkId !== "string") return { ok: false, error: "parkId must be string" };
	if (typeof record.sessionId !== "string") return { ok: false, error: "sessionId must be string" };
	if (!Number.isFinite(record.createdAt)) return { ok: false, error: "createdAt must be numeric" };
	if (!Number.isFinite(record.resetAt)) return { ok: false, error: "resetAt must be numeric" };
	if (typeof record.status !== "string") return { ok: false, error: "status must be string" };
	if (typeof record.terminal !== "object" || !record.terminal) return { ok: false, error: "terminal must be object" };
	if (typeof record.terminal.kind !== "string") return { ok: false, error: "terminal.kind must be string" };

	return { ok: true };
}

/**
 * Parse and deduplicate park records per session.
 * Returns {valid: [{file, record, ...}], invalid: [{file, name, error}], superseded: [{file, record}]}.
 */
export function deduplicateParkRecords(recordsInput) {
	const valid = [];
	const invalid = [];
	const bySession = new Map();

	for (const entry of recordsInput) {
		const validation = validateParkRecord(entry.record);
		if (!validation.ok) {
			invalid.push({ file: entry.file, name: entry.name, error: validation.error });
			continue;
		}

		const sid = entry.record.sessionId;
		const episodes = bySession.get(sid) ?? [];
		episodes.push(entry);
		bySession.set(sid, episodes);
	}

	// For each session, mark all but the newest as superseded
	const superseded = [];
	for (const episodes of bySession.values()) {
		if (episodes.length > 1) {
			// Sort by createdAt descending, keep the first (newest)
			episodes.sort((a, b) => b.record.createdAt - a.record.createdAt);
			for (let i = 1; i < episodes.length; i++) {
				superseded.push(episodes[i]);
			}
		}
		// Add the newest (and only valid) one
		valid.push(episodes[0]);
	}

	return { valid, invalid, superseded };
}
