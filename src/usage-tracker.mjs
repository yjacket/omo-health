import path from "node:path";
import { probeSessionHeader } from "./collect/session-files.mjs";
import { idFromFileName } from "./collect/sessions.mjs";
import { sessionSubjects, subjectKey, subjectOf } from "./session-subject.mjs";
import { isInside, pathKey } from "./paths.mjs";
import { boardTaskLinks } from "./session-board.mjs";
import { ENDED_LOCATION, endedKey, locateEndedRows, readEndedCwd } from "./session-ledger.mjs";
import { ambiguousLedgerTaskIds, ledgerUsageSessionId, retainedTreeRows, usageTreeLink } from "./session-record.mjs";
import { USAGE_TICK_BYTES, compactUsage, fresh as isFresh, isTaskOnlyEntry, treeTotals, usageEntryFor } from "./usage-index.mjs";
import { statSafe } from "./util/fsx.mjs";

/**
 * The daemon's token tracker (plan todo 5): one per-tick byte budget shared by
 * live appends, first reads of live sessions and the ended-session backlog,
 * including live verification and discovery of the backlog's main-session files.
 *
 * Live sessions are indexed only from their own file: a main file name or
 * session header must carry its session id, and a child file must be the one
 * the locator returns for its task and session id. The live collector can
 * attach a task directory's newest file to the wrong child
 * (`findChildSessionFile`), and that file's usage must never be billed there.
 */
const DAY_MS = 24 * 60 * 60_000;
const ANCESTOR_DEPTH = 8;

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const needsLedgerCwd = (row) => Object.hasOwn(row, ENDED_LOCATION) && !row[ENDED_LOCATION] && row.cwd === undefined;

/**
 * @param {object} options
 * @param {object} options.paths        resolvePaths() result (index file, session dirs)
 * @param {object} options.index        createUsageIndex() instance; its file is the daemon's usage.json
 * @param {object} options.locator      createSessionFileLocator() instance
 * @param {object} options.clock        {now()}
 * @param {object} options.log          {info, error}
 * @param {object} [options.ledgerFs]   fs implementation for ledger cwd reads (tests count bytes)
 */
export function createUsageTracker({ paths, index, locator, clock, log, ledgerFs } = {}) {
	const nowMs = () => (typeof clock?.now === "function" ? clock.now() : Date.now());
	/** Compact ledger rows, for the ancestor cwd walk. */
	const ledgerRows = new Map();
	/** Keep distinct fallback ledger rows for ownership ambiguity. */
	const fallbackRows = new Map();
	/** Ended task-only reads whose ownership needs watching even when the byte queue is drained. */
	const taskOnlyChecks = new Map();
	/** Rows waiting for bytes: id -> ledger row, newest first. */
	let queue = new Map();
	/** Live session ids waiting for a header probe or to enter the index. Rebuilt each tick. */
	const pendingLive = new Set();
	const liveHeaders = new Map();
	let searched = new WeakSet();
	let liveTreeRows = [];
	let trees;
	let backlogLogged = false;
	let fullLogged = false;
	let sawBacklog = false;

	const keyOf = (row) => subjectKey(subjectOf(row));
	const linkKey = (row, sessionId) => subjectKey({ ...subjectOf(row), sessionId });
	const cwdChain = function* (row, liveSessions) {
		yield row;
		const seen = new Set();
		if (isNonEmptyString(row?.sessionId)) seen.add(row.sessionId);
		let current = row;
		for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
			const parentId = current?.parentSessionId;
			if (!isNonEmptyString(parentId) || seen.has(parentId)) break;
			seen.add(parentId);
			const key = current.parentKey ?? linkKey(current, parentId);
			const parent = ledgerRows.get(key) ?? liveSessions?.get(key) ?? index.get(key);
			if (!parent) break;
			yield parent;
			current = parent;
		}
	};

	const cwdCandidates = (row, liveSessions, cwdOf) => {
		const cwds = new Set();
		for (const node of cwdChain(row, liveSessions)) {
			const cwd = cwdOf(node);
			if (isNonEmptyString(cwd)) cwds.add(cwd);
		}
		return [...cwds];
	};

	const metaOf = (source) => ({
		kind: source?.kind ?? null,
		taskId: source?.taskId ?? null,
		parentSessionId: source?.parentSessionId ?? null,
		rootSessionId: source?.rootSessionId ?? null,
		parentKey: source?.parentKey ?? linkKey(source, source?.parentSessionId),
		rootKey: source?.rootKey ?? linkKey(source, source?.rootSessionId),
	});

	const childCandidate = (query) => (locator?.childCandidate ?? locator?.childFile)?.(query);

	/** Verify that the live collector's file belongs to this session before billing it. */
	const verify = (session, liveSessions, cwdOf, maxBytes) => {
		const file = session?.file;
		const result = (matches) => ({ matches, bytesRead: 0 });
		if (!isNonEmptyString(file)) return result(false);
		if (session.kind === "main") {
			if (idFromFileName(file) === session.id) return result(true);
			const stat = statSafe(file);
			const cached = liveHeaders.get(keyOf(session));
			if (!stat?.isFile()) {
				liveHeaders.delete(keyOf(session));
				return result(false);
			}
			const { size, mtimeMs, ino } = stat;
			if (cached?.file === file && cached.size === size && cached.mtimeMs === mtimeMs && cached.ino === ino) return result(cached.matches);
			liveHeaders.delete(keyOf(session));
			const probe = probeSessionHeader(file, size, maxBytes);
			const matches = probe.id === session.id;
			// Don't cache an I/O failure on a nonempty file; retry it next tick.
			if (!probe.pending && (probe.bytesRead > 0 || size === 0)) liveHeaders.set(keyOf(session), { file, size, mtimeMs, ino, matches });
			return { matches, pending: probe.pending, bytesRead: probe.bytesRead };
		}
		if (session.kind !== "child" || !isNonEmptyString(session.taskId)) return result(false);
		const query = { taskId: session.taskId, sessionId: session.id, cwds: cwdCandidates(session, liveSessions, cwdOf) };
		const candidate = session.id === session.taskId ? childCandidate(query) : locator?.childFile?.(query);
		return { ...result(candidate && pathKey(candidate) === pathKey(file)), candidate };
	};

	const locate = (row, liveSessions, cwdOf, maxBytes) => {
		if (row.kind === "child") {
			const query = { taskId: row.taskId ?? row.sessionId, sessionId: row.sessionId, cwds: cwdCandidates(row, liveSessions, cwdOf) };
			const file = ledgerUsageSessionId(row) ? locator?.childFile?.(query) : childCandidate(query);
			return { file, bytesRead: 0 };
		}
		return locator?.findMainFile?.(subjectOf(row), index.get(keyOf(row))?.file ?? null, { maxBytes }) ?? { bytesRead: 0 };
	};

	const counts = () => {
		let indexed = 0;
		let missing = 0;
		for (const entry of index.entries()) {
			if (entry.state === "ok") indexed += 1;
			else if (entry.state === "missing") missing += 1;
		}
		return { indexed, missing };
	};

	const totals = () => {
		const ambiguous = ambiguousLedgerTaskIds(fallbackRows.values(), { scoped: true });
		return treeTotals(index.entries(), [
			...[...ledgerRows.values()].filter(ledgerUsageSessionId).map((row) => usageTreeLink(index, row, ambiguous)),
			...[...fallbackRows.values()].map((row) => usageTreeLink(index, row, ambiguous)),
			...liveTreeRows,
		]);
	};

	return {
		/**
		 * Queue ledger rows that need bytes, newest first: unindexed rows, rows whose
		 * first read was interrupted, complete rows whose file moved past the indexed
		 * end (an append or a same-length rewrite, which `readUsage` recounts), and
		 * missing rows checked more than a day ago, and gone rows (deleted after a
		 * complete read) checked more than a day ago.
		 */
		queueLedger(rows) {
			searched = new WeakSet();
			trees = undefined;
			const cutoff = nowMs() - 30 * DAY_MS;
			// Refresh from the daemon's window stream plus its retained descendants.
			// Live exits arrive as arrays; don't rescan the ledger for each exit.
			if (!Array.isArray(rows)) {
				for (const [key, row] of fallbackRows) if (row.endedMs < cutoff) fallbackRows.delete(key);
				for (const [id, row] of ledgerRows) {
					if (row.endedMs < cutoff) {
						ledgerRows.delete(id);
						queue.delete(id);
						taskOnlyChecks.delete(id);
					}
				}
				rows = retainedTreeRows(paths, rows, { beforeMs: cutoff, withLocation: true });
			}
			const incoming = [];
			for (const source of rows ?? []) {
				if (!isNonEmptyString(source?.sessionId)) continue;
				const { sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId } = source;
				const { projectKey } = subjectOf(source);
				const row = { sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId, projectKey, [ENDED_LOCATION]: source[ENDED_LOCATION] };
				// Unpositioned callers keep any supplied cwd. Daemon rows always
				// have locations and resolve cwd from the ledger line instead.
				if (!row[ENDED_LOCATION] && source.cwd !== undefined) row.cwd = source.cwd;
				incoming.push(row);
				if (!ledgerUsageSessionId(row)) fallbackRows.set(JSON.stringify([subjectKey(subjectOf(source)), endedKey(source)]), row);
			}
			const resolve = sessionSubjects([...ledgerRows.values(), ...incoming]);
			for (const row of incoming) {
				row.projectKey = resolve(row).projectKey;
				const key = keyOf(row);
				ledgerRows.set(key, row);
				const entry = index.get(key);
				if (row.kind === "child" && !ledgerUsageSessionId(row) && (entry?.state === "ok" || taskOnlyChecks.has(key))) {
					taskOnlyChecks.set(key, row);
				}
				const checkedAgo = nowMs() - (Number.isFinite(entry?.checkedMs) ? entry.checkedMs : 0) > DAY_MS;
				let need = false;
				if (!entry || entry.state === "full") need = true;
				else if (entry.state === "ok" && entry.complete !== true) need = true;
				else if (entry.gone === true) need = checkedAgo;
				else if (entry.complete === true && (entry.readError === true || !isFresh(entry))) need = true;
				else if (entry.state === "missing" && checkedAgo) need = true;
				if (need) queue.set(key, row);
			}
			queue = new Map([...queue.entries()].sort((a, b) => (Number(b[1]?.endedMs) || 0) - (Number(a[1]?.endedMs) || 0)));
			if (queue.size) sawBacklog = true;
			return queue.size;
		},

		/**
		 * Spend this tick's `USAGE_TICK_BYTES`: live appends of indexed sessions
		 * first, then their first/incomplete reads, then the backlog newest first.
		 * A record longer than the remaining budget is resumed on a later tick.
		 */
		tick(world) {
			let budget = USAGE_TICK_BYTES;
			let ownershipChanged = false;
			const sessions = [...(world?.sessions?.values?.() ?? [])];
			const resolve = sessionSubjects([...sessions, ...ledgerRows.values()]);
			const liveSubject = sessionSubjects(sessions);
			const liveSessions = new Map();
			for (const session of sessions) {
				if (!isNonEmptyString(session?.id)) continue;
				const subject = liveSubject(session);
				const parent = world?.sessions?.get?.(session.parentSessionId);
				const root = world?.sessions?.get?.(session.rootSessionId);
				liveSessions.set(subjectKey(subject), { ...session, ...subject,
					parentKey: parent ? subjectKey(liveSubject(parent)) : linkKey(subject, session.parentSessionId),
					rootKey: root ? subjectKey(liveSubject(root)) : linkKey(subject, session.rootSessionId) });
			}
			const ledgerOptions = ledgerFs ? { fs: ledgerFs } : undefined;
			const resolvedCwds = new WeakMap();
			const cwdOf = (node) => {
				if (resolvedCwds.has(node)) return resolvedCwds.get(node);
				if (!paths) return undefined;
				if (needsLedgerCwd(node) && !searched.has(node)) {
					// Share one scan across pending child lookups, including their
					// ancestors. Keep positions and remember misses until requeued.
					const pending = [];
					const collect = (row) => {
						for (const candidate of cwdChain(row, liveSessions)) {
							if (!needsLedgerCwd(candidate) || searched.has(candidate)) continue;
							searched.add(candidate);
							pending.push(candidate);
						}
					};
					for (const row of queue.values()) if (row.kind === "child") collect(row);
					for (const row of taskOnlyChecks.values()) collect(row);
					for (const session of liveSessions.values()) {
						if (session.kind === "child" && isNonEmptyString(session.file) && isNonEmptyString(session.taskId)) collect(session);
					}
					locateEndedRows(paths, pending, ledgerOptions);
				}
				return node[ENDED_LOCATION] ? readEndedCwd(paths, node, ledgerOptions) : node.cwd;
			};
			const liveAppends = [];
			const liveFirstReads = [];
			pendingLive.clear();
			for (const [id, { file }] of liveHeaders) {
				const session = liveSessions.get(id);
				if (session?.kind !== "main" || session.file !== file) liveHeaders.delete(id);
			}
			for (const session of liveSessions.values()) {
				const entry = index.get(keyOf(session));
				const reads = entry?.state === "ok" && entry.complete === true ? liveAppends : liveFirstReads;
				reads.push({ session, entry });
			}
			// (a) live appends, then (b) first/incomplete live reads. A previous
			// publication sets priority, not whether a file has unread bytes.
			for (const { session: observed, entry } of [...liveAppends, ...liveFirstReads]) {
				let session = observed;
				// The raw-ID registry can attach a different project’s default-store file.
				if (session.kind === "main" && session.projectKey && session.file && paths?.sessionsDir &&
					isInside(session.file, paths.sessionsDir) &&
					pathKey(path.dirname(session.file)) !== pathKey(path.join(paths.sessionsDir, session.projectKey))) {
					const { file, pending, bytesRead } = locate(session, liveSessions, cwdOf, budget);
					budget -= bytesRead;
					if (pending || (file && budget === 0 && !entry)) pendingLive.add(keyOf(session));
					if (!file) continue;
					session = { ...session, file };
				}
				const { matches, pending, bytesRead, candidate } = verify(session, liveSessions, cwdOf, budget);
				budget -= bytesRead;
				if (pending || (matches && budget === 0 && !entry)) pendingLive.add(keyOf(session));
				if (isTaskOnlyEntry(entry) && entry.state === "ok" && (!matches || pathKey(session.file) !== pathKey(entry.file))) {
					if (!entry.gone || candidate !== undefined) {
						index.markMissing(subjectOf(session), metaOf(session), { withdraw: candidate !== undefined });
						ownershipChanged = true;
					}
				}
				if (!matches || budget <= 0) continue;
				budget = Math.max(0, budget - index.update(subjectOf(session), session.file, metaOf(session), {
					maxBytes: budget, ownershipUnique: session.id === session.taskId ? true : null,
				}));
			}
			// Ownership checks cost no transcript bytes and must run even when live
			// reads exhaust the budget. A different path or a veto invalidates the old claim.
			const checkedFiles = new Map();
			for (const [id, row] of taskOnlyChecks) {
				const { file } = locate(row, liveSessions, cwdOf, 0);
				const entry = index.get(id);
				const withdraw = file === null || (file !== undefined && pathKey(file) !== pathKey(entry?.file));
				if (entry?.state === "ok" && (withdraw || (file === undefined && (!entry.gone || entry.ownershipUnique !== true)))) {
					index.markMissing(subjectOf(row), metaOf(row), { withdraw });
					ownershipChanged = true;
				}
				if (file) {
					checkedFiles.set(id, file);
					if (!isFresh(index.get(id))) queue.set(id, row);
					else if (index.recordOwnership(id, true)) ownershipChanged = true;
				} else {
					queue.delete(id);
				}
			}
			// (c) the ended-session backlog, newest first
			for (const [queuedKey, row] of queue) {
				if (budget <= 0) break;
				if (!row.projectKey) {
					const cwd = cwdOf(row);
					row.projectKey = resolve({ ...row, cwd }).projectKey;
					if (cwd !== undefined) {
						// This tick already read the position to establish the subject.
						resolvedCwds.set(row, cwd);
					}
				}
				const id = keyOf(row);
				if (queuedKey !== id) {
					ledgerRows.delete(queuedKey);
					ledgerRows.set(id, row);
				}
				const { file: rowFile, pending, bytesRead = 0 } = checkedFiles.has(id)
					? { file: checkedFiles.get(id) }
					: locate(row, liveSessions, cwdOf, budget);
				budget -= bytesRead;
				if (pending) break;
				if (!rowFile) {
					index.markMissing(subjectOf(row), metaOf(row), { withdraw: rowFile === null });
					queue.delete(queuedKey);
					continue;
				}
				const taskOnly = row.kind === "child" && !ledgerUsageSessionId(row);
				if (taskOnly) taskOnlyChecks.set(id, row);
				if (budget <= 0) break;
				budget = Math.max(0, budget - index.update(subjectOf(row), rowFile, metaOf(row), {
					maxBytes: budget, ownershipUnique: taskOnly ? true : null,
				}));
				const entry = index.get(id);
				// Missing/gone files are retried by queueLedger, not every tick.
				if (entry.readError === true) continue;
				if (entry.state === "missing" || entry.state === "full" || entry.gone === true ||
					(entry.state === "ok" && entry.complete === true && entry.evaluatedTo === entry.size)) {
					queue.delete(queuedKey);
				}
			}
			// An exact-session child can also be the alias of a task-only history row.
			// Refresh only aliases history can use; exact-ID rows need no directory check.
			if (fallbackRows.size > 0) {
				const taskIds = new Set([...fallbackRows.values()].map((row) => linkKey(row, row.taskId)));
				for (const entry of index.values()) {
					if (entry.kind === "child" && entry.state === "ok" && !isTaskOnlyEntry(entry) && taskIds.has(linkKey(entry, entry.taskId))) {
						if (index.checkAliasOwnership(keyOf(entry))) ownershipChanged = true;
					}
				}
			}
			const board = boardTaskLinks(world, nowMs());
			liveTreeRows = [
				...[...liveSessions.values()].map((row) => ({ key: keyOf(row), parentKey: row.parentKey })),
				...(world?.tasks ?? []).filter((task) => task.childSessionId).map(({ childSessionId, parentSessionId }) => {
					const parent = liveSubject(world.sessions?.get(parentSessionId));
					const child = subjectOf(world.sessions?.get(childSessionId), parent);
					return { key: subjectKey({ ...child, sessionId: childSessionId }), parentKey: subjectKey({ ...parent, sessionId: parentSessionId }) };
				}),
				...board.rows.filter((row) => !row.sessionId).map((row) => usageTreeLink(index, row, board.ambiguous)),
			];
			trees = totals();
			const state = counts();
			// Persist deletions for history and revocations so removing a competing
			// file cannot revive the old on-disk cursor before a recount.
			if (ownershipChanged) index.save();
			if (index.full && !fullLogged) {
				fullLogged = true;
				log?.warn?.("usage_index_full");
			}
			if (sawBacklog && !backlogLogged && queue.size === 0) {
				index.save();
				log?.info?.("usage_backlog", state);
				backlogLogged = true;
			}
			return { bytesRead: USAGE_TICK_BYTES - budget, ...state };
		},

		/**
		 * The board's lookup: `{tokens, treeTokens, treeTokensComplete}` for a complete entry
		 * (`treeTokens` is non-null when at least one descendant has a counted total),
		 * `{pending:true}` while a live header probe or first read is deferred or
		 * an entry's first full read has not finished, and null when nothing is known.
		 * A deferred exact reread can return both the last `tokens` and `pending:true`.
		 * A counted descendant can supply a tree total even without an own total.
		 */
		tokensOf(subject, taskId) {
			const entry = usageEntryFor(index, subject, taskId);
			const key = subjectKey(subject);
			const id = entry?.id ? keyOf(entry) : key;
			trees ??= totals();
			const treeTokens = trees.get(id) ?? null;
			const treeTokensComplete = !pendingLive.has(id) && trees.complete.get(id) === true;
			const tree = treeTokens === null ? {} : { treeTokens, treeTokensComplete };
			if (pendingLive.has(key)) return { pending: true, ...tree };
			if (!entry) return index.full && taskId ? { state: "full", ...tree } : treeTokens === null ? null : tree;
			if (entry.state === "full") return { state: "full", ...tree };
			const tokens = compactUsage(entry);
			if (tokens) return { tokens, treeTokens, treeTokensComplete, ...(entry.pending && !entry.gone ? { pending: true } : {}) };
			if (entry.state === "ok" && entry.readError !== true) return { pending: true, ...tree };
			return treeTokens === null ? null : tree;
		},
	};
}
