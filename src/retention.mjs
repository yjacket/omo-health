import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
/** `.tmp` worker spools in sensors/ are short-lived: a day, not the general window. */
const SENSOR_TMP_DAYS = 1;

/** readdir with file types; `undefined` when the directory is missing or unreadable. */
function readDir(dir) {
	if (!dir) return undefined;
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

function mtimeMs(target) {
	try {
		return fs.statSync(target).mtimeMs;
	} catch {
		return undefined;
	}
}

function olderThan(ms, nowMs, days) {
	return ms !== undefined && ms < nowMs - days * DAY_MS;
}

/**
 * Prune old per-session files in the health home.
 *
 * Removes files in `alignmentDir`, `statusDir` (never `_global.json` or `_sessions.json`)
 * and `receiptsDir` older than `days`; empty session directories under `inboxDir` older
 * than `days`; and `*.tmp` files in `sensorsDir` older than a day.
 *
 * A missing directory is a no-op. An error on a single entry is captured and returned,
 * never thrown. Nothing outside those directories is touched: decisions, reports,
 * snapshots, investigations, jobs, deaths, intake, lkg, app, parks, sessions and the
 * database are all left alone.
 *
 * @param {object} paths resolvePaths() output.
 * @param {number} nowMs Current wall time in ms.
 * @param {{days?: number}} [options]
 * @returns {{removed: {path: string, kind: string}[], errors: {path: string, message: string}[]}}
 */
export function pruneHome(paths, nowMs, { days = 7 } = {}) {
	const health = paths?.health ?? {};
	const removed = [];
	const errors = [];
	const drop = (target, kind) => {
		try {
			fs.rmSync(target, { force: true });
			removed.push({ path: target, kind });
		} catch (error) {
			errors.push({ path: target, message: error?.message ?? String(error) });
		}
	};

	const pruneFiles = (dir, kind, keep = () => false) => {
		for (const entry of readDir(dir) ?? []) {
			if (!entry.isFile() || keep(entry.name)) continue;
			const file = path.join(dir, entry.name);
			if (olderThan(mtimeMs(file), nowMs, days)) drop(file, kind);
		}
	};

	pruneFiles(health.alignmentDir, "alignment");
	pruneFiles(health.statusDir, "status", (name) => name === "_global.json" || name === "_sessions.json");
	pruneFiles(health.receiptsDir, "receipts");

	for (const entry of readDir(health.sensorsDir) ?? []) {
		if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
		const file = path.join(health.sensorsDir, entry.name);
		if (olderThan(mtimeMs(file), nowMs, SENSOR_TMP_DAYS)) drop(file, "sensor-tmp");
	}

	for (const entry of readDir(health.inboxDir) ?? []) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(health.inboxDir, entry.name);
		const entries = readDir(dir);
		if (!entries || entries.length > 0) continue;
		if (!olderThan(mtimeMs(dir), nowMs, days)) continue;
		try {
			fs.rmdirSync(dir);
			removed.push({ path: dir, kind: "inbox-dir" });
		} catch (error) {
			errors.push({ path: dir, message: error?.message ?? String(error) });
		}
	}

	return { removed, errors };
}
