import fs from "node:fs";
import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { isInside, pathKey } from "../paths.mjs";
import { packScopedText, SubjectMap } from "../session-subject.mjs";
import { fresh, readUsageIndex, soleChildSessionFile } from "../usage-index.mjs";
import { idFromFileName } from "./sessions.mjs";
import { senpiTaskStoreDir } from "./tasks.mjs";

const HEADER_BYTES = 64 * 1024;

/** A header probe is atomic; callers defer the candidate if its prefix won't fit. */
export function probeSessionHeader(file, size, maxBytes) {
	const length = Math.min(size, HEADER_BYTES);
	if (length > maxBytes) return { pending: true, bytesRead: 0 };
	if (length === 0) return { bytesRead: 0 };
	let fd;
	let bytesRead = 0;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(length);
		bytesRead = fs.readSync(fd, buf, 0, length, 0);
		const text = buf.toString("utf8", 0, bytesRead);
		const end = text.indexOf("\n");
		const entry = JSON.parse(end >= 0 ? text.slice(0, end) : text);
		return { id: entry?.type === "session" ? entry.id : undefined, bytesRead };
	} catch {
		return { bytesRead };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
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
 * `indexedFile(subject)` is an optional lookup into a token index the caller already holds (the daemon's resident
 * index); without it the locator reads the index file, once per change of that file.
 * With `probeHeaders: false`, use fresh on-disk index entries instead of probing, and discover by filename only.
 */
export function createSessionFileLocator({ paths, clock, rescanMs = 60_000, indexedFile, probeHeaders = true } = {}) {
	const nowMs = typeof clock?.now === "function" ? () => clock.now() : () => Date.now();
	const projects = new Map();
	let usageStamp;
	let indexedMainEntries = new SubjectMap();

	const residentMainFile = (subject) => {
		const file = indexedFile(subject);
		return file && idFromFileName(file) !== subject.sessionId ? file : undefined;
	};

	const readMainFile = (subject) => {
		const file = paths.health?.usageIndexFile;
		const stat = file && statSafe(file);
		const stamp = stat?.isFile() ? `${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}` : null;
		if (stamp !== usageStamp) {
			usageStamp = stamp;
			indexedMainEntries = new SubjectMap();
			if (stamp !== null) {
				for (const entry of readUsageIndex(file).values()) {
					if (entry.kind === "main" && entry.file && (!probeHeaders || idFromFileName(entry.file) !== entry.id)) indexedMainEntries.set(entry, entry);
				}
			}
		}
		const entry = indexedMainEntries.get(subject);
		if (!probeHeaders && (entry?.readError === true || !fresh(entry))) return undefined;
		return entry?.file;
	};

	const indexedMainFile = typeof indexedFile === "function" ? residentMainFile : readMainFile;

	function* mainCandidates(dir) {
		for (const name of listDirSafe(dir)) {
			if (name.endsWith(".jsonl")) yield path.join(dir, name);
		}
	}

	/** A header probe is atomic; leave the candidate at the cursor if its prefix won't fit. */
	const findMainFile = (subject, indexedFile, { maxBytes = Infinity } = {}) => {
		let bytesRead = 0;
		const result = (file, pending = false) => ({ file, pending, bytesRead });
		const header = (file, size) => {
			const probe = probeSessionHeader(file, size, maxBytes - bytesRead);
			bytesRead += probe.bytesRead;
			return probe;
		};
		const { sessionId, projectKey } = subject ?? {};
		if (!sessionId || !projectKey || !/^--[^/\\:]*--$/.test(projectKey)) return result();
		const dir = path.join(paths.sessionsDir, projectKey);
		const owns = (file) => file && pathKey(path.dirname(file)) === pathKey(dir);
		// An already verified custom transcript can live outside senpi’s sessions tree.
		const custom = (file) => file && !isInside(file, paths.sessionsDir);
		if (!probeHeaders) {
			const verified = readMainFile(subject);
			if (owns(verified) || custom(verified)) return result(verified);
		} else if (indexedFile === undefined) {
			indexedFile = indexedMainFile(subject);
		}
		if (probeHeaders && (owns(indexedFile) || custom(indexedFile)) && idFromFileName(indexedFile) !== sessionId) {
			const stat = statSafe(indexedFile);
			if (stat?.isFile()) {
				const probe = header(indexedFile, stat.size);
				if (probe.pending) return result(undefined, true);
				if (probe.id === sessionId) return result(indexedFile);
			}
		}
		const packed = packScopedText(projectKey);
		let project = projects.get(packed);
		if (!project) projects.set(packed, project = { files: new Map(), scannedMs: -Infinity });
		let file = project.files.get(sessionId);
		if (file && statSafe(file)?.isFile()) return result(file);
		if (file) project.files.delete(sessionId);
		if (!project.scan) {
			if (nowMs() - project.scannedMs < rescanMs) return result();
			const candidates = mainCandidates(dir);
			project.scan = { candidates, next: candidates.next(), found: new Map() };
		}
		const scan = project.scan;
		for (; !scan.next.done; scan.next = scan.candidates.next()) {
			const candidate = scan.next.value;
			const stat = statSafe(candidate);
			if (!stat?.isFile()) continue;
			const probe = probeHeaders ? header(candidate, stat.size) : undefined;
			if (probe?.pending) return result(undefined, true);
			const nameId = idFromFileName(candidate);
			const headerId = probe?.id;
			if (typeof headerId === "string" && headerId && headerId !== nameId) {
				// A differing header identifies this file, but don't displace a matching filename for that id.
				if (!scan.found.has(headerId)) scan.found.set(headerId, candidate);
			} else if (nameId) {
				scan.found.set(nameId, candidate);
			}
		}
		// Publish only the finished map: unseen files can still change which path wins.
		project.files = scan.found;
		project.scan = undefined;
		project.scannedMs = nowMs();
		file = project.files.get(sessionId);
		return result(file && statSafe(file)?.isFile() ? file : undefined);
	};

	const mainFile = (subject, indexedFile) => findMainFile(subject, indexedFile).file;

	const childFiles = new Map();
	const childMisses = new Map();

	const childKey = (taskId, sessionId, cwds) => packScopedText(JSON.stringify([taskId, sessionId ?? null, cwds ?? []]));

	const locateChild = ({ taskId, sessionId, cwds }) => {
		if (!taskId) return undefined;
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
			if (!wantId) {
				// An ambiguous store must not fall through to an ancestor.
				const sole = soleChildSessionFile(dir);
				if (sole !== undefined) return sole;
			} else {
				const exact = listDirSafe(dir).find((name) => idFromFileName(name) === wantId);
				if (exact) return path.join(dir, exact);
			}
		}
		return undefined;
	};

	/** The child file of `{taskId, sessionId, cwds}`; stores are tried in cwd order (a child may live in an ancestor's cwd). */
	const childFile = (row = {}) => {
		const { taskId, sessionId, cwds } = row;
		if (!taskId) return undefined;
		const key = childKey(taskId, sessionId, cwds);
		const exact = sessionId && sessionId !== taskId;
		const cached = childFiles.get(key);
		if (exact && cached && statSafe(cached)?.isFile()) return cached;
		childFiles.delete(key);
		const now = nowMs();
		const missedAt = childMisses.get(key);
		if (missedAt !== undefined && now - missedAt < rescanMs) return undefined;
		const file = locateChild({ taskId, sessionId, cwds });
		if (file) {
			if (exact) childFiles.set(key, file);
			childMisses.delete(key);
			return file;
		}
		// Ambiguity can clear on the very next use, unlike a cold miss.
		if (file !== null) childMisses.set(key, now);
		return undefined;
	};

	// Ownership checks need an uncached answer: undefined is absence, null is a veto.
	return { mainFile, findMainFile, childFile, childCandidate: locateChild };
}
