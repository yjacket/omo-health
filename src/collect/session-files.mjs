import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { idFromFileName } from "./sessions.mjs";
import { senpiTaskStoreDir } from "./tasks.mjs";

/**
 * Locate the session JSONL behind an ended-session ledger row (GAP-2).
 *
 * Main sessions live at `<agentDir>/sessions/<slug>/<timestamp>_<sessionId>.jsonl`
 * (`src/session-backfill.mjs`, `src/collect/sessions.mjs`).
 * Child sessions live at `<senpiTaskStoreDir(cwd)>/children/<taskId>/sessions/<taskId>/<timestamp>_<sessionId>.jsonl`
 * (`src/collect/tasks.mjs` `senpiTaskStoreDir`, `findChildSessionFile`).
 *
 * Nothing here writes; a negative lookup is retried after `rescanMs`, so the
 * daemon's backlog finds files that appear later without rescanning every tick.
 */
export function createSessionFileLocator({ paths, clock, rescanMs = 60_000 } = {}) {
	const nowMs = typeof clock?.now === "function" ? () => clock.now() : () => Date.now();
	let mainFiles = new Map();
	let mainScannedMs = -Infinity;

	const scanMain = () => {
		const found = new Map();
		for (const slug of listDirSafe(paths.sessionsDir)) {
			const dir = path.join(paths.sessionsDir, slug);
			for (const name of listDirSafe(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const file = path.join(dir, name);
				if (statSafe(file)?.isFile()) found.set(idFromFileName(file), file);
			}
		}
		mainFiles = found;
		mainScannedMs = nowMs();
	};

	/** `<sessionsDir>/<slug>/*.jsonl` keyed by the id in the file name; on a miss rescan once per `rescanMs`. */
	const mainFile = (sessionId) => {
		if (!sessionId) return undefined;
		let file = mainFiles.get(sessionId);
		if (file && statSafe(file)?.isFile()) return file;
		if (file) mainFiles.delete(sessionId);
		if (mainScannedMs !== -Infinity && nowMs() - mainScannedMs < rescanMs) return undefined;
		scanMain();
		file = mainFiles.get(sessionId);
		return file && statSafe(file)?.isFile() ? file : undefined;
	};

	const childFiles = new Map();
	const childMisses = new Map();

	const childKey = (taskId, sessionId, cwds) => JSON.stringify([taskId, sessionId ?? null, cwds ?? []]);

	const locateChild = ({ taskId, sessionId, cwds }) => {
		const stores = [];
		const seen = new Set();
		for (const cwd of cwds ?? []) {
			if (typeof cwd !== "string" || !cwd || seen.has(cwd)) continue;
			seen.add(cwd);
			stores.push(senpiTaskStoreDir(cwd, paths.agentDir));
		}
		const wantId = sessionId && sessionId !== taskId ? sessionId : undefined;
		for (const storeDir of stores) {
			const dir = path.join(storeDir, "children", taskId, "sessions", taskId);
			const files = listDirSafe(dir).filter((name) => name.endsWith(".jsonl"));
			if (!files.length) continue;
			if (wantId) {
				const exact = files.find((name) => name.endsWith(`_${wantId}.jsonl`));
				if (exact) return path.join(dir, exact);
				continue;
			}
			// Without a real child id only an unambiguous single file is safe; never the newest-file fallback.
			return files.length === 1 ? path.join(dir, files[0]) : undefined;
		}
		return undefined;
	};

	/** The child file of `{taskId, sessionId, cwds}`; stores are tried in cwd order (a child may live in an ancestor's cwd). */
	const childFile = (row = {}) => {
		const { taskId, sessionId, cwds } = row;
		if (!taskId) return undefined;
		const key = childKey(taskId, sessionId, cwds);
		const cached = childFiles.get(key);
		if (cached && statSafe(cached)?.isFile()) return cached;
		childFiles.delete(key);
		const now = nowMs();
		const missedAt = childMisses.get(key);
		if (missedAt !== undefined && now - missedAt < rescanMs) return undefined;
		const file = locateChild({ taskId, sessionId, cwds });
		if (file) {
			childFiles.set(key, file);
			childMisses.delete(key);
			return file;
		}
		childMisses.set(key, now);
		return undefined;
	};

	return { mainFile, childFile };
}
