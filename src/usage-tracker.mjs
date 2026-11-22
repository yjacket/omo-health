import { probeSessionHeader } from "./collect/session-files.mjs";
import { idFromFileName } from "./collect/sessions.mjs";
import { pathKey } from "./paths.mjs";
import { boardTaskLinks } from "./session-board.mjs";
import { ENDED_LOCATION, endedKey, locateEndedRows, readEndedCwd } from "./session-ledger.mjs";
import { ambiguousLedgerTaskIds, ledgerUsageSessionId, usageTreeLink } from "./session-record.mjs";
import { USAGE_TICK_BYTES, compactUsage, fresh as isFresh, isTaskOnlyEntry, treeTotals } from "./usage-index.mjs";
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
	/** Keep scoped fallback links even though the index itself has only one slot per raw ID. */
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

	const cwdChain = function* (row, liveSessions) {
		yield row;
		const seen = new Set();
		if (isNonEmptyString(row?.sessionId)) seen.add(row.sessionId);
		let current = row;
		for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
			const parentId = current?.parentSessionId;
			if (!isNonEmptyString(parentId) || seen.has(parentId)) break;
			seen.add(parentId);
			const parent = ledgerRows.get(parentId) ?? index.get(parentId) ?? liveSessions?.get?.(parentId);
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
	});

	/** Verify that the live collector's file belongs to this session before billing it. */
	const verify = (session, liveSessions, cwdOf, maxBytes) => {
		const file = session?.file;
		const result = (matches) => ({ matches, bytesRead: 0 });
		if (!isNonEmptyString(file)) return result(false);
		if (session.kind === "main") {
			if (idFromFileName(file) === session.id) return result(true);
			const stat = statSafe(file);
			const cached = liveHeaders.get(session.id);
			if (!stat?.isFile()) {
				liveHeaders.delete(session.id);
				return result(false);
			}
			const { size, mtimeMs, ino } = stat;
			if (cached?.file === file && cached.size === size && cached.mtimeMs === mtimeMs && cached.ino === ino) return result(cached.matches);
			liveHeaders.delete(session.id);
			const probe = probeSessionHeader(file, size, maxBytes);
			const matches = probe.id === session.id;
			// Don't cache an I/O failure on a nonempty file; retry it next tick.
			if (!probe.pending && (probe.bytesRead > 0 || size === 0)) liveHeaders.set(session.id, { file, size, mtimeMs, ino, matches });
			return { matches, pending: probe.pending, bytesRead: probe.bytesRead };
		}
		if (session.kind !== "child" || !isNonEmptyString(session.taskId)) return result(false);
		const found = locator?.childFile?.({ taskId: session.taskId, sessionId: session.id, cwds: cwdCandidates(session, liveSessions, cwdOf) });
		return result(found && pathKey(found) === pathKey(file));
	};

	const locate = (row, liveSessions, cwdOf, maxBytes) => {
		if (row.kind === "child") {
			const file = locator?.childFile?.({ taskId: row.taskId ?? row.sessionId, sessionId: row.sessionId, cwds: cwdCandidates(row, liveSessions, cwdOf) });
			return { file, bytesRead: 0 };
		}
		return locator?.findMainFile?.(row.sessionId, index.get(row.sessionId)?.file ?? null, { maxBytes }) ?? { bytesRead: 0 };
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
		const ambiguous = ambiguousLedgerTaskIds(fallbackRows.values());
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
			// The daemon passes a stream for the daily window and an array
			// for live exits. Only sweep the old window on refresh.
			if (!Array.isArray(rows)) {
				for (const [key, row] of fallbackRows) if (row.endedMs < cutoff) fallbackRows.delete(key);
				for (const [id, row] of ledgerRows) {
					if (row.endedMs < cutoff) {
						ledgerRows.delete(id);
						queue.delete(id);
						taskOnlyChecks.delete(id);
					}
				}
			}
			for (const source of rows ?? []) {
				if (!isNonEmptyString(source?.sessionId)) continue;
				const { sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId } = source;
				const row = { sessionId, taskId, kind, endedMs, parentSessionId, rootSessionId, [ENDED_LOCATION]: source[ENDED_LOCATION] };
				// Unpositioned callers keep any supplied cwd. Daemon rows always
				// have locations and resolve cwd from the ledger line instead.
				if (!row[ENDED_LOCATION] && source.cwd !== undefined) row.cwd = source.cwd;
				ledgerRows.set(row.sessionId, row);
				if (!ledgerUsageSessionId(row)) fallbackRows.set(endedKey(source), row);
				const entry = index.get(row.sessionId);
				if (row.kind === "child" && !ledgerUsageSessionId(row) && (entry?.state === "ok" || taskOnlyChecks.has(sessionId))) {
					taskOnlyChecks.set(sessionId, row);
				}
				const checkedAgo = nowMs() - (Number.isFinite(entry?.checkedMs) ? entry.checkedMs : 0) > DAY_MS;
				let need = false;
				if (!entry || entry.state === "full") need = true;
				else if (entry.state === "ok" && entry.complete !== true) need = true;
				else if (entry.gone === true) need = checkedAgo;
				else if (entry.complete === true && (entry.readError === true || !isFresh(entry))) need = true;
				else if (entry.state === "missing" && checkedAgo) need = true;
				if (need) queue.set(row.sessionId, row);
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
			let withdrew = false;
			const sessions = [...(world?.sessions?.values?.() ?? [])];
			const liveSessions = new Map(sessions.filter((session) => isNonEmptyString(session?.id)).map((session) => [session.id, session]));
			const ledgerOptions = ledgerFs ? { fs: ledgerFs } : undefined;
			const cwdOf = (node) => {
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
				const entry = index.get(session.id);
				const reads = entry?.state === "ok" && entry.complete === true ? liveAppends : liveFirstReads;
				reads.push({ session, entry });
			}
			// (a) live appends, then (b) first/incomplete live reads. A previous
			// publication sets priority, not whether a file has unread bytes.
			for (const { session, entry } of [...liveAppends, ...liveFirstReads]) {
				const { matches, pending, bytesRead } = verify(session, liveSessions, cwdOf, budget);
				budget -= bytesRead;
				if (pending || (matches && budget === 0 && !entry)) pendingLive.add(session.id);
				if (isTaskOnlyEntry(entry) && entry.state === "ok" && (!matches || pathKey(session.file) !== pathKey(entry.file))) {
					index.markMissing(session.id, metaOf(session));
					withdrew = true;
				}
				if (!matches || budget <= 0) continue;
				budget = Math.max(0, budget - index.update(session.id, session.file, metaOf(session), { maxBytes: budget }));
			}
			// Ownership checks cost no transcript bytes and must run even when live
			// reads exhaust the budget. A restored path starts with a cleared cursor.
			const checkedFiles = new Map();
			for (const [id, row] of taskOnlyChecks) {
				const { file } = locate(row, liveSessions, cwdOf, 0);
				const entry = index.get(id);
				if (entry?.state === "ok" && (!file || pathKey(file) !== pathKey(entry.file))) {
					index.markMissing(id, metaOf(row));
					withdrew = true;
				}
				if (file) {
					checkedFiles.set(id, file);
					if (!isFresh(index.get(id))) queue.set(id, row);
				} else {
					queue.delete(id);
				}
			}
			// (c) the ended-session backlog, newest first
			for (const [id, row] of queue) {
				if (budget <= 0) break;
				const { file: rowFile, pending, bytesRead = 0 } = checkedFiles.has(id)
					? { file: checkedFiles.get(id) }
					: locate(row, liveSessions, cwdOf, budget);
				budget -= bytesRead;
				if (pending) break;
				if (!rowFile) {
					index.markMissing(id, metaOf(row));
					queue.delete(id);
					continue;
				}
				if (row.kind === "child" && !ledgerUsageSessionId(row)) taskOnlyChecks.set(id, row);
				if (budget <= 0) break;
				budget = Math.max(0, budget - index.update(id, rowFile, metaOf(row), { maxBytes: budget }));
				const entry = index.get(id);
				// Missing/gone files are retried by queueLedger, not every tick.
				if (entry.readError === true) continue;
				if (entry.state === "missing" || entry.state === "full" || entry.gone === true ||
					(entry.state === "ok" && entry.complete === true && entry.evaluatedTo === entry.size)) {
					queue.delete(id);
				}
			}
			const board = boardTaskLinks(world, nowMs());
			liveTreeRows = [
				...liveSessions.values(),
				...(world?.tasks ?? []).filter((task) => task.childSessionId).map(({ childSessionId, parentSessionId }) => ({ id: childSessionId, parentSessionId })),
				...board.rows.filter((row) => !row.sessionId).map((row) => usageTreeLink(index, row, board.ambiguous)),
			];
			trees = totals();
			const state = counts();
			// History reads the saved index. Persist revocation now so that removing
			// the competing file cannot revive the old on-disk cursor before a recount.
			if (withdrew) index.save();
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
		 * A counted descendant can supply a tree total even without an own total.
		 */
		tokensOf(sessionId, taskId) {
			const entry = index.get(sessionId, taskId);
			const id = entry?.id ?? sessionId;
			trees ??= totals();
			const treeTokens = trees.get(id) ?? null;
			const treeTokensComplete = !pendingLive.has(id) && trees.complete.get(id) === true;
			const tree = treeTokens === null ? {} : { treeTokens, treeTokensComplete };
			if (pendingLive.has(sessionId)) return { pending: true, ...tree };
			if (!entry) return treeTokens === null ? null : tree;
			if (entry.state === "full") return { state: "full", ...tree };
			const tokens = compactUsage(entry);
			if (tokens) return { tokens, treeTokens, treeTokensComplete };
			if (entry.state === "ok" && entry.readError !== true) return { pending: true, ...tree };
			return treeTokens === null ? null : tree;
		},
	};
}
