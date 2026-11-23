import fs from "node:fs";
import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { isInside, pathKey } from "../paths.mjs";
import { packScopedText, projectKeyOf, uniqueMatch } from "../session-subject.mjs";
import { fresh, soleChildSessionFile } from "../usage-index.mjs";
import { idFromFileName } from "./sessions.mjs";
import { senpiTaskStoreDir } from "./tasks.mjs";
import { isExactInode, readUsageFileStamp, sameFileIdentity } from "./usage.mjs";

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
		return entry?.type === "session" ? { id: entry.id, cwd: entry.cwd, bytesRead } : { bytesRead };
	} catch {
		return { bytesRead };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** The saved row supplies ownership for a legacy header only for the same file identity. */
function ownsExternal(subject, file, probe, saved) {
	if (probe.id !== subject.sessionId) return false;
	const headerProject = projectKeyOf(probe.cwd);
	if (subject.projectKey != null && headerProject != null) return headerProject === subject.projectKey;
	if (saved?.kind !== "main" || saved.file !== file || saved.projectKey == null) return false;
	if (subject.projectKey != null && saved.projectKey !== subject.projectKey) return false;
	return headerProject == null
		? sameFileIdentity(readUsageFileStamp(file), saved)
		: headerProject === saved.projectKey;
}

/** An indexed identity describes a particular path, not a heartbeat's newly reported path. */
export function indexedMainIdentity(file, saved, stamp) {
	if (!isExactInode(saved?.ino) || !Number.isFinite(saved.birthtimeMs) ||
		!saved.file || (saved.file !== file && pathKey(saved.file) !== pathKey(file))) return undefined;
	return sameFileIdentity(stamp, saved);
}

/** A new live path earns trust by name or header; a replacement has to prove both scoped keys. */
export function ownsLiveMain(subject, file, probe, sameIdentity) {
	if (sameIdentity === true) return true;
	if (probe.pending) return false;
	const { sessionId, projectKey } = subject;
	const headerProject = projectKeyOf(probe.cwd);
	if (sameIdentity === false) return probe.id === sessionId && headerProject != null && headerProject === projectKey;
	if ((probe.id != null && probe.id !== sessionId) || (headerProject != null && headerProject !== projectKey)) return false;
	return probe.id === sessionId || idFromFileName(file) === sessionId;
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
 * `indexedEntry(subject)` returns a row from an index the caller already holds.
 * With `probeHeaders: false`, use fresh index entries or filename discovery inside
 * the sessions tree; external paths still require a header ownership check.
 */
export function createSessionFileLocator({ paths, clock, rescanMs = 60_000, indexedEntry, probeHeaders = true } = {}) {
	const nowMs = typeof clock?.now === "function" ? () => clock.now() : () => Date.now();
	const projects = new Map();

	function* mainCandidates(dir) {
		for (const name of listDirSafe(dir)) {
			if (name.endsWith(".jsonl")) yield path.join(dir, name);
		}
	}

	/** A header probe is atomic; leave the candidate at the cursor if its prefix won't fit. */
	const findMainFile = (subject, saved, { maxBytes = Infinity } = {}) => {
		let bytesRead = 0;
		const result = (file, pending = false) => ({ file, pending, bytesRead });
		const header = (file, size) => {
			const probe = probeSessionHeader(file, size, maxBytes - bytesRead);
			bytesRead += probe.bytesRead;
			return probe;
		};
		const { sessionId, projectKey } = subject ?? {};
		if (!sessionId || subject.taskId != null) return result();
		if (saved === undefined) saved = indexedEntry?.({ ...subject, taskId: null });
		const indexedFile = saved?.kind === "main" ? saved.file : undefined;
		const external = indexedFile && !isInside(indexedFile, paths.sessionsDir);
		const probeIndexed = () => {
			const stat = statSafe(indexedFile);
			if (!stat?.isFile()) return result();
			const probe = header(indexedFile, stat.size);
			if (probe.pending) return result(undefined, true);
			const matches = external ? ownsExternal(subject, indexedFile, probe, saved) : probe.id === sessionId;
			return result(matches ? indexedFile : undefined);
		};
		if (projectKey == null) {
			let pending = false;
			const file = uniqueMatch(listDirSafe(paths.sessionsDir, { withFileTypes: true }), (entry) => {
				if (pending || !entry.isDirectory()) return undefined;
				const found = scanProject(path.join(paths.sessionsDir, entry.name), entry.name, sessionId, header);
				pending = found.pending;
				return found.file;
			});
			if (file === null) return { ...result(), ambiguous: true };
			if (pending || file) return result(file && !pending ? file : undefined, pending);
			return external ? probeIndexed() : result();
		}
		if (!/^--[^/\\:]*--$/.test(projectKey)) return result();
		const dir = path.join(paths.sessionsDir, projectKey);
		const inProject = indexedFile && pathKey(path.dirname(indexedFile)) === pathKey(dir);
		if (!probeHeaders && inProject && saved.readError !== true && fresh(saved)) return result(indexedFile);
		if (inProject) {
			const stamp = readUsageFileStamp(indexedFile);
			if (stamp && indexedMainIdentity(indexedFile, saved, stamp) === false) {
				// A scan by name (or its cached result) must not resurrect a replaced indexed file.
				const probe = header(indexedFile, stamp.size);
				return result(ownsLiveMain(subject, indexedFile, probe, false) ? indexedFile : undefined, probe.pending);
			}
		}
		if (external || (probeHeaders && inProject)) {
			const found = probeIndexed();
			if (found.file || found.pending) return found;
		}
		const { file, pending } = scanProject(dir, projectKey, sessionId, header);
		return result(file, pending);
	};

	function scanProject(dir, projectKey, sessionId, header) {
		const result = (file, pending = false) => ({ file, pending });
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
	}

	const mainFile = (subject, saved) => findMainFile(subject, saved).file;

	const childFiles = new Map();
	const childMisses = new Map();

	const ownerStore = ({ storeDir, parentCwd }) =>
		storeDir || (parentCwd && senpiTaskStoreDir(parentCwd, paths.agentDir));

	const locateChild = ({ taskId, sessionId, cwds }, owner) => {
		if (!taskId) return undefined;
		const wantId = sessionId && sessionId !== taskId ? sessionId : undefined;
		const inStore = (storeDir) => {
			const dir = path.join(storeDir, "children", taskId, "sessions", taskId);
			if (!wantId) return soleChildSessionFile(dir);
			const exact = listDirSafe(dir).find((name) =>
				idFromFileName(name) === wantId && statSafe(path.join(dir, name))?.isFile());
			return exact && path.join(dir, exact);
		};
		if (owner) return inStore(owner);
		const seen = new Set();
		let match;
		for (const cwd of cwds ?? []) {
			if (typeof cwd !== "string" || !cwd) continue;
			const storeDir = senpiTaskStoreDir(cwd, paths.agentDir);
			const key = pathKey(storeDir);
			if (seen.has(key)) continue;
			seen.add(key);
			const file = inStore(storeDir);
			if (file === null || (file && match)) return null;
			if (file) match = file;
		}
		return match;
	};

	/** A known spawning store is authoritative; otherwise require a unique store. */
	const childFile = (row = {}) => {
		const { taskId, sessionId, cwds } = row;
		if (!taskId) return undefined;
		const owner = ownerStore(row);
		const key = packScopedText(JSON.stringify([taskId, sessionId ?? null, owner ? pathKey(owner) : cwds ?? []]));
		// A second store can acquire the same exact ID after a successful fallback.
		const cacheExact = owner && sessionId && sessionId !== taskId;
		const cached = childFiles.get(key);
		if (cacheExact && cached && statSafe(cached)?.isFile()) return cached;
		childFiles.delete(key);
		const now = nowMs();
		const missedAt = childMisses.get(key);
		if (missedAt !== undefined && now - missedAt < rescanMs) return undefined;
		const file = locateChild(row, owner);
		if (file) {
			if (cacheExact) childFiles.set(key, file);
			childMisses.delete(key);
			return file;
		}
		// Ambiguity can clear on the very next use, unlike a cold miss.
		if (file !== null) childMisses.set(key, now);
		return undefined;
	};

	// Ownership checks need an uncached answer: undefined is absence, null is a veto.
	return { mainFile, findMainFile, childFile, childCandidate: (row) => locateChild(row, ownerStore(row)) };
}
