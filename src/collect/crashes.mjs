import fs from "node:fs";
import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { redact, truncate } from "../util/text.mjs";
import { senpiTaskStoreDir, taskStoreDir } from "./tasks.mjs";

/** A version string from a live marker, or undefined when the marker omits it. */
function versionOf(value) {
	return typeof value === "string" ? truncate(redact(value), 40) : undefined;
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Read sensor heartbeats, swept crash records, and live senpi process markers. */
export function readHostExits(paths, { maxFiles = 500 } = {}) {
	const heartbeats = listDirSafe(paths.health.sensorsDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const file = path.join(paths.health.sensorsDir, name);
			const stat = statSafe(file);
			const hb = parseJson(readFileSafe(file));
			return stat && hb && typeof hb.sessionId === "string" && Number.isFinite(hb.pid) && Number.isFinite(hb.ts)
				? { file, hb, mtimeMs: stat.mtimeMs }
				: undefined;
		})
		.filter(Boolean)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, Math.max(0, maxFiles));

	const crashDir = path.join(paths.agentDir, "process-crashes");
	const crashFile = path.join(crashDir, "crashes.jsonl");
	let tail = "";
	try {
		const fd = fs.openSync(crashFile, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const length = Math.min(size, 64 * 1024);
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, size - length);
			tail = buffer.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Missing or unreadable crash history is empty.
	}
	const crashRecords = tail.split(/\r?\n/).filter(Boolean).slice(-50).flatMap((line) => {
		const record = parseJson(line);
		const atMs = Date.parse(record?.at);
		if (!Number.isFinite(atMs) || !Number.isFinite(record?.uptimeMs)) return [];
		return [{ atMs, kind: record.kind, detection: record.detection, uptimeMs: record.uptimeMs, startedMs: atMs - record.uptimeMs }];
	});

	const liveMarkers = new Map();
	const liveDir = path.join(crashDir, "live");
	for (const name of listDirSafe(liveDir)) {
		const match = /^(\d+)\.json$/.exec(name);
		if (!match) continue;
		const record = parseJson(readFileSafe(path.join(liveDir, name)));
		const stat = statSafe(path.join(liveDir, name));
		const pid = Number(match[1]);
		if (record && stat && Number.isFinite(pid)) liveMarkers.set(pid, { pid, kind: record.kind, startedAt: record.startedAt, mtimeMs: stat.mtimeMs, omoVersion: versionOf(record.productVersion), senpiVersion: versionOf(record.senpiVersion) });
	}
	return { heartbeats, crashRecords, liveMarkers };
}

function readFileSafe(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Read the newest DAG run summaries updated since `sinceMs`. */
export function readDagRuns(cwd, { sinceMs = 0, maxFiles = 30, agentDir } = {}) {
	const dir = path.join(agentDir ? senpiTaskStoreDir(cwd, agentDir) : taskStoreDir(cwd), "dag", "runs");
	return listDirSafe(dir).filter((name) => name.endsWith(".json")).map((name) => {
		const file = path.join(dir, name);
		const stat = statSafe(file);
		const run = parseJson(readFileSafe(file));
		return stat && stat.mtimeMs >= sinceMs && run ? { file, stat, run } : undefined;
	}).filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, Math.max(0, maxFiles)).map(({ file, stat, run }) => ({
		runId: run.runId,
		status: run.status,
		rootSessionId: run.rootSessionId,
		parentSessionId: run.parentSessionId,
		updatedAtMs: Date.parse(run.updatedAt),
		file,
	}));
}

/** Delete the sensor heartbeat only if it still belongs to the given session process and timestamp. */
export function removeHeartbeat(paths, { sessionId, pid, ts }) {
	const safeSessionId = String(sessionId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
	const file = path.join(paths.health.sensorsDir, `${safeSessionId}.json`);
	const hb = parseJson(readFileSafe(file));
	if (!hb || hb.pid !== pid || hb.ts !== ts) return false;
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}
