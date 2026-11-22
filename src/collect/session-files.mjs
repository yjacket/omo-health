import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { readUsageIndex } from "../usage-index.mjs";
import { idFromFileName, readSessionHeader } from "./sessions.mjs";
import { senpiTaskStoreDir } from "./tasks.mjs";

export function mainSessionFileMatches(file, sessionId) {
	return idFromFileName(file) === sessionId || readSessionHeader(file)?.id === sessionId;
}

/**
 * Locate the session JSONL behind an ended-session ledger row (GAP-2).
 *
 * Main sessions live under `<agentDir>/sessions/<slug>/`, usually named `<timestamp>_<sessionId>.jsonl`
 * (`src/session-backfill.mjs`, `src/collect/sessions.mjs`).
 * Child sessions live at `<senpiTaskStoreDir(cwd)>/children/<taskId>/sessions/<taskId>/<timestamp>_<sessionId>.jsonl`
 * (`src/collect/tasks.mjs` `senpiTaskStoreDir`, `findChildSessionFile`).
 *
 * Nothing here writes; a negative lookup is retried after `rescanMs`, so the
 * daemon's backlog finds files that appear later without rescanning every tick.
 */
/**
 * `indexedFile(sessionId)` is an optional lookup into a token index the caller already holds (the daemon's resident
 * index); without it the locator reads the index file, once per change of that file.
 */
export function createSessionFileLocator({ paths, clock, rescanMs = 60_000, indexedFile } = {}) {
	const nowMs = typeof clock?.now === "function" ? () => clock.now() : () => Date.now();
	let mainFiles = new Map();
	let mainScannedMs = -Infinity;
	let usageStamp;
	let customMainFiles = new Map();

	const residentMainFile = (sessionId) => {
		const file = indexedFile(sessionId);
		return file && idFromFileName(file) !== sessionId ? file : undefined;
	};

	const readMainFile = (sessionId) => {
		const file = paths.health?.usageIndexFile;
		const stat = file && statSafe(file);
		const stamp = stat?.isFile() ? `${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}` : null;
		if (stamp !== usageStamp) {
			usageStamp = stamp;
			customMainFiles = new Map();
			if (stamp !== null) {
				for (const [id, entry] of readUsageIndex(file)) {
					if (entry.kind === "main" && entry.file && idFromFileName(entry.file) !== id) customMainFiles.set(id, entry.file);
				}
			}
		}
		return customMainFiles.get(sessionId);
	};

	const indexedMainFile = typeof indexedFile === "function" ? residentMainFile : readMainFile;

	const scanMain = () => {
		const found = new Map();
		for (const slug of listDirSafe(paths.sessionsDir)) {
			const dir = path.join(paths.sessionsDir, slug);
			for (const name of listDirSafe(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const file = path.join(dir, name);
				if (!statSafe(file)?.isFile()) continue;
				const nameId = idFromFileName(file);
				const headerId = readSessionHeader(file)?.id;
				if (typeof headerId === "string" && headerId && headerId !== nameId) {
					// A differing header identifies this file, but don't displace a matching filename for that id.
					if (!found.has(headerId)) found.set(headerId, file);
				} else if (nameId) {
					found.set(nameId, file);
				}
			}
		}
		mainFiles = found;
		mainScannedMs = nowMs();
	};

	/** Prefer the indexed custom path; otherwise use the scan's header/filename map. */
	const mainFile = (sessionId, indexedFile = indexedMainFile(sessionId)) => {
		if (!sessionId) return undefined;
		if (indexedFile && idFromFileName(indexedFile) !== sessionId && mainSessionFileMatches(indexedFile, sessionId)) return indexedFile;
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
