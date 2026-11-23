import path from "node:path";
import { probeSessionHeader } from "./collect/session-files.mjs";
import { idFromFileName } from "./collect/sessions.mjs";
import { childSubjectOf, ledgerParentSubject, liveSessionView, PACKED_PROJECT, packScopedText, parseSubjectKey, sessionSubjects, SubjectMap, subjectKey, subjectOf, taskParentResolver, unpackScopedText } from "./session-subject.mjs";
import { isInside, pathKey } from "./paths.mjs";
import { boardTaskLinks } from "./session-board.mjs";
import { ENDED_LOCATION, locateEndedRows, readEndedCwd, streamEnded } from "./session-ledger.mjs";
import { ledgerUsageSessionId, legacyParentOwners, retainedTreeRows, usageTreeLink } from "./session-record.mjs";
import { USAGE_TICK_BYTES, compactUsage, fresh as isFresh, isTaskOnlyEntry, parentSubject, treeTotals, usageEntryFor } from "./usage-index.mjs";
import { statSafe } from "./util/fsx.mjs";

/**
 * The daemon's token tracker (plan todo 5): one per-tick byte budget shared by
 * live appends, first reads of live sessions and the ended-session backlog,
 * including live verification and discovery of the backlog's main-session files.
 *
 * Live sessions are indexed only from their own file: a main file name or
 * session header must carry its session id, and children use the spawning-store
 * locator rather than trusting the live collector's newest-file fallback.
 */
const DAY_MS = 24 * 60 * 60_000;
const ANCESTOR_DEPTH = 8;

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const needsLedgerCwd = (row) => Object.hasOwn(row, ENDED_LOCATION) && !row[ENDED_LOCATION] && row.cwd === undefined;
const ledgerIdentity = {
	get projectKey() { return unpackScopedText(this[PACKED_PROJECT]); },
	get parentProjectKey() { return unpackScopedText(this.packedParentProject); },
};
const packedMap = (ordered = false) => new SubjectMap({ ordered, packed: true });

function treeKeys() {
	const keys = packedMap();
	return (key, insert = true) => {
		if (key == null) return null;
		const subject = parseSubjectKey(key);
		let token = keys.get(subject);
		if (!token && insert) keys.set(subject, token = {});
		return token;
	};
}

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
	const ledgerRows = packedMap();
	const compactProject = (row, key) => { row[PACKED_PROJECT] = ledgerRows.canonicalProject(packScopedText(key)); };
	/** Keep distinct fallback ledger rows for ownership ambiguity. */
	const fallbackRows = packedMap();
	function* fallbacks() {
		for (const bucket of fallbackRows.values()) {
			yield* bucket.parents.values();
			yield* bucket.cwds.values();
		}
	}
	/** Ended task-only reads whose ownership needs watching even when the byte queue is drained. */
	const taskOnlyChecks = packedMap();
	/** Rows waiting for bytes: id -> ledger row, newest first. */
	let queue = packedMap(true);
	/** Live session ids waiting for a header probe or to enter the index. Rebuilt each tick. */
	const pendingLive = packedMap();
	const liveHeaders = packedMap();
	let searched = new WeakSet();
	let liveTreeRows = [];
	let parentOwners = new Map();
	let parentLinksChanged = false;
	let trees;
	let treeKey;
	let backlogLogged = false;
	let fullLogged = false;
	let sawBacklog = false;

	const keyOf = (row) => subjectKey(subjectOf(row));
	const exactEntry = (key) => (index.getExact ?? index.get).call(index, key);
	const liveIdentities = new WeakMap();
	const identityOf = (row) => liveIdentities.get(row) ?? row;
	const ledgerParent = (row) => ledgerParentSubject(row, parentOwners);
	const linkedSubject = (row, field) => {
		const identity = identityOf(row);
		const sessionId = row?.[`${field}SessionId`];
		if (field === "parent") {
			if (row && Object.hasOwn(row, ENDED_LOCATION)) {
				const parent = ledgerParent(row);
				if (parent?.projectKey != null || (parentOwners.has(sessionId) && !parent)) return parent;
				return resolveLiveCwdParent?.(sessionId) ?? parent;
			}
			if (row?.id && !liveIdentities.has(row)) return parentSubject(row);
			if (identity?.parentKey === "") return null;
		}
		return parseSubjectKey(identity?.[`${field}Key`]) ??
			(sessionId ? { projectKey: subjectOf(identity).projectKey, sessionId } : null);
	};
	let resolveLiveCwdParent;
	const cwdChain = function* (row, liveSessions) {
		yield row;
		const seen = packedMap();
		if (row?.sessionId || row?.id) seen.set(identityOf(row), true);
		let current = row;
		for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
			const subject = linkedSubject(current, "parent");
			if (!subject || seen.has(subject)) break;
			seen.set(subject, true);
			const parent = ledgerRows.get(subject) ?? liveSessions?.get(subject) ?? exactEntry(subjectKey(subject));
			if (!parent?.sessionId && !parent?.id) break;
			yield parent;
			current = parent;
		}
	};

	const childStoreQuery = (row, liveSessions, cwdOf) => {
		const storeDir = row.task?.storeDir ?? row.storeDir ?? liveSessions.get(identityOf(row))?.task?.storeDir;
		if (isNonEmptyString(storeDir)) return { storeDir };
		const cwds = new Set();
		const chain = cwdChain(row, liveSessions);
		chain.next(); // The child's own cwd is only a fallback candidate.
		const parent = chain.next().value;
		const parentCwd = parent && cwdOf(parent);
		if (isNonEmptyString(parentCwd)) return { parentCwd };
		for (const node of [row, ...chain]) {
			const cwd = cwdOf(node);
			if (isNonEmptyString(cwd)) cwds.add(cwd);
		}
		return { cwds: [...cwds] };
	};

	const metaOf = (source) => ({
		kind: source?.kind ?? null,
		parentSessionId: source?.parentSessionId ?? null,
		rootSessionId: source?.rootSessionId ?? null,
		parentKey: Object.hasOwn(source, ENDED_LOCATION) && source.parentSessionId
			? subjectKey(ledgerParent(source)) ?? "" : identityOf(source)?.parentKey ?? null,
		rootKey: identityOf(source)?.rootKey ?? null,
	});

	const childCandidate = (query) => (locator?.childCandidate ?? locator?.childFile)?.(query);

	/** Verify that the live collector's file belongs to this session before billing it. */
	const verify = (session, file, liveSessions, cwdOf, maxBytes) => {
		const result = (matches) => ({ matches, bytesRead: 0 });
		if (session.kind === "child" && isNonEmptyString(session.taskId)) {
			const query = { taskId: session.taskId, sessionId: session.id, ...childStoreQuery(session, liveSessions, cwdOf) };
			const candidate = childCandidate(query);
			return { ...result(Boolean(candidate)), candidate };
		}
		if (!isNonEmptyString(file)) return result(false);
		if (session.kind === "main") {
			if (idFromFileName(file) === session.id) return result(true);
			const stat = statSafe(file);
			const subject = identityOf(session);
			const cached = liveHeaders.get(subject);
			if (!stat?.isFile()) {
				liveHeaders.delete(subject);
				return result(false);
			}
			const { size, mtimeMs, ino } = stat;
			if (cached?.file === file && cached.size === size && cached.mtimeMs === mtimeMs && cached.ino === ino) return result(cached.matches);
			liveHeaders.delete(subject);
			const probe = probeSessionHeader(file, size, maxBytes);
			const matches = probe.id === session.id;
			// Don't cache an I/O failure on a nonempty file; retry it next tick.
			if (!probe.pending && (probe.bytesRead > 0 || size === 0)) liveHeaders.set(subject, { file, size, mtimeMs, ino, matches });
			return { matches, pending: probe.pending, bytesRead: probe.bytesRead };
		}
		return result(false);
	};

	const locate = (row, liveSessions, cwdOf, maxBytes) => {
		if (row.kind === "child") {
			const query = { taskId: row.taskId ?? row.sessionId, sessionId: row.sessionId, ...childStoreQuery(row, liveSessions, cwdOf) };
			return { file: childCandidate(query), bytesRead: 0 };
		}
		const subject = subjectOf(identityOf(row));
		return locator?.findMainFile?.(subject, index.get(subjectKey(subject))?.file ?? null, { maxBytes }) ?? { bytesRead: 0 };
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
		const ambiguous = packedMap();
		const seen = packedMap();
		for (const row of fallbacks()) {
			if (!row.taskId) continue;
			const task = { sessionId: row.taskId, taskId: row.taskId, [PACKED_PROJECT]: row[PACKED_PROJECT] };
			if (seen.has(task)) ambiguous.set(task, true);
			else seen.set(task, true);
		}
		treeKey = treeKeys();
		function* links() {
			for (const row of ledgerRows.values()) if (ledgerUsageSessionId(row)) yield usageTreeLink(index, row, ambiguous, parentOwners);
			for (const row of fallbacks()) yield usageTreeLink(index, row, ambiguous, parentOwners);
			yield* liveTreeRows;
		}
		return treeTotals(index.values(), links(), treeKey);
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
				for (const [key, bucket] of fallbackRows.subjects()) {
					for (const rows of [bucket.parents, bucket.cwds]) {
						for (const [id, row] of rows) if (row.endedMs < cutoff) rows.delete(id);
					}
					if (!bucket.parents.size && !bucket.cwds.size) fallbackRows.delete(key);
				}
				for (const [id, row] of ledgerRows.subjects()) {
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
				const row = Object.assign(Object.create(ledgerIdentity), {
					sessionId, kind, endedMs, parentSessionId, rootSessionId, [ENDED_LOCATION]: source[ENDED_LOCATION],
				});
				if (taskId != null) row.taskId = taskId;
				if (source.parentTaskId != null) row.parentTaskId = source.parentTaskId;
				compactProject(row, projectKey);
				if (isNonEmptyString(source.storeDir)) row.storeDir = source.storeDir;
				if (source.parentProjectKey != null) row.packedParentProject = packScopedText(source.parentProjectKey);
				// Unpositioned callers keep any supplied cwd. Daemon rows always
				// have locations and resolve cwd from the ledger line instead.
				if (!row[ENDED_LOCATION] && source.cwd !== undefined) row.cwd = source.cwd;
				incoming.push(row);
				if (!ledgerUsageSessionId(row)) {
					let bucket = fallbackRows.get(row);
					if (!bucket) fallbackRows.set(row, bucket = { parents: new Map(), cwds: new Map() });
					if (parentSessionId) bucket.parents.set(parentSessionId, row);
					else bucket.cwds.set(packScopedText(source.cwd || null), row);
				}
			}
			const resolve = sessionSubjects([...ledgerRows.values(), ...incoming]);
			for (const row of incoming) {
				if (row[PACKED_PROJECT] === null) compactProject(row, resolve(row).projectKey);
				else row[PACKED_PROJECT] = ledgerRows.canonicalProject(row[PACKED_PROJECT]);
				ledgerRows.set(row, row);
			}
			function* compactRows() {
				for (const row of ledgerRows.values()) yield row;
				yield* fallbacks();
			}
			const links = () => {
				const compact = compactRows();
				return paths ? (function* () { yield* compact; yield* streamEnded(paths); })() : compact;
			};
			parentOwners = legacyParentOwners(compactRows, links);
			for (const row of ledgerRows.values()) {
				if (row.parentSessionId && ledgerUsageSessionId(row)) {
					parentLinksChanged = index.recordParentLink?.(row, metaOf(row).parentKey) || parentLinksChanged;
				}
			}
			for (const row of incoming) {
				const entry = ledgerUsageSessionId(row) ? index.get(keyOf(row)) : exactEntry(keyOf(row));
				if (row.kind === "child" && !ledgerUsageSessionId(row) && (entry?.state === "ok" || taskOnlyChecks.has(row))) {
					taskOnlyChecks.set(row, row);
				}
				const checkedAgo = nowMs() - (Number.isFinite(entry?.checkedMs) ? entry.checkedMs : 0) > DAY_MS;
				let need = false;
				if (!entry || entry.state === "full") need = true;
				else if (entry.state === "ok" && entry.complete !== true) need = true;
				else if (entry.gone === true) need = checkedAgo;
				else if (entry.complete === true && (entry.readError === true || !isFresh(entry) ||
					(row.kind === "child" && ledgerUsageSessionId(row) && (row.parentSessionId || row.storeDir)))) need = true;
				else if (entry.state === "missing" && checkedAgo) need = true;
				if (need) queue.set(row, row);
			}
			const sorted = [...queue.subjects()].sort((a, b) => (Number(b[1]?.endedMs) || 0) - (Number(a[1]?.endedMs) || 0));
			queue = packedMap(true);
			for (const [key, row] of sorted) queue.set(key, row);
			if (queue.size) sawBacklog = true;
			return queue.size;
		},

		/**
		 * Spend this tick's transcript allowance: live appends of indexed sessions
		 * first, then their first/incomplete reads, then the backlog newest first.
		 * A record longer than the remaining budget is resumed on a later tick.
		 */
		tick(world, { maxBytes = USAGE_TICK_BYTES } = {}) {
			let budget = maxBytes;
			let ownershipChanged = false;
			const sensorSessions = new Set();
			const byId = new Map();
			for (const [id, raw] of world?.sessions ?? []) {
				const session = liveSessionView(raw, world);
				if (session !== raw) sensorSessions.add(session);
				byId.set(id, session);
			}
			const sessions = [...byId.values()];
			const resolve = sessionSubjects([...sessions, ...ledgerRows.values()], world);
			const liveSubject = sessionSubjects(sessions, world);
			const taskParent = taskParentResolver(world, paths?.agentDir);
			resolveLiveCwdParent = (id) => {
				const row = byId.get(id) ?? ledgerRows.getForSubject({ sessionId: id });
				if (!row) return null;
				return resolve(row);
			};
			const liveSessions = packedMap(true);
			for (const session of sessions) {
				if (!isNonEmptyString(session?.id)) continue;
				const hasSpawningStore = session.kind === "child" && session.task?.storeDir;
				const spawningParent = hasSpawningStore && taskParent(session.task);
				const subject = hasSpawningStore
					? childSubjectOf({ sessionId: session.id, task: session.task, world, parent: spawningParent, child: session })
					: liveSubject(session);
				const parent = byId.get(session.parentSessionId);
				const root = byId.get(session.rootSessionId);
				for (const [field, relative] of [["parent", parent], ["root", root]]) {
					if (field === "parent" && hasSpawningStore) {
						subject.parentKey = subjectKey(spawningParent) ?? "";
						continue;
					}
					if (!relative) continue;
					const linked = liveSubject(relative);
					if (linked.taskId != null || linked.projectKey !== subject.projectKey || linked.sessionId !== session[`${field}SessionId`]) {
						subject[`${field}Key`] = subjectKey(linked);
					}
				}
				liveIdentities.set(session, subject);
				liveSessions.set(subject, session);
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
						if (session.kind === "child" && isNonEmptyString(session.taskId)) collect(session);
					}
					locateEndedRows(paths, pending, ledgerOptions);
				}
				return node[ENDED_LOCATION] ? readEndedCwd(paths, node, ledgerOptions) : node.cwd;
			};
			const liveAppends = [];
			const liveFirstReads = [];
			const priority = index.fragmentPriority;
			let priorityLive;
			pendingLive.clear();
			for (const [id, { file }] of liveHeaders.subjects()) {
				const session = liveSessions.get(id);
				if (session?.kind !== "main" || session.file !== file) liveHeaders.delete(id);
			}
			for (const session of liveSessions.values()) {
				const entry = exactEntry(keyOf(identityOf(session)));
				if (priority && entry === priority) {
					priorityLive = { session, entry };
					continue;
				}
				const reads = entry?.state === "ok" && entry.complete === true ? liveAppends : liveFirstReads;
				reads.push({ session, entry });
			}
			const checkedFiles = packedMap();
			const readBacklog = (queuedKey, row) => {
				if (index.fragmentBlocked?.(exactEntry(keyOf(row)))) return;
				if (row[PACKED_PROJECT] === null) {
					const cwd = cwdOf(row);
					compactProject(row, resolve({ ...row, cwd }).projectKey);
					if (cwd !== undefined) resolvedCwds.set(row, cwd);
				}
				const id = keyOf(row);
				if (queuedKey[PACKED_PROJECT] !== row[PACKED_PROJECT]) {
					ledgerRows.delete(queuedKey);
					ledgerRows.set(row, row);
				}
				const { file: rowFile, pending, bytesRead = 0 } = checkedFiles.has(row)
					? { file: checkedFiles.get(row) }
					: locate(row, liveSessions, cwdOf, budget);
				resolvedCwds.delete(row);
				budget -= bytesRead;
				if (pending) return false;
				if (!rowFile) {
					// Don't turn an uncounted row into a negative-cache hit at capacity.
					// Existing rows still need missing/gone and ownership updates.
					if (!index.full || exactEntry(id)?.state !== "full") {
						index.markMissing(subjectOf(row), metaOf(row), { withdraw: rowFile === null });
					}
					queue.delete(queuedKey);
					return;
				}
				const taskOnly = row.kind === "child" && !ledgerUsageSessionId(row);
				if (taskOnly) taskOnlyChecks.set(row, row);
				if (budget <= 0) return false;
				budget = Math.max(0, budget - index.update(subjectOf(row), rowFile, metaOf(row), {
					maxBytes: budget, ownershipUnique: taskOnly ? true : null,
				}));
				const entry = exactEntry(id);
				// Missing/gone files are retried by queueLedger, not every tick.
				if (entry.readError === true) return;
				if (entry.state === "missing" || entry.state === "full" || entry.gone === true ||
					(entry.state === "ok" && entry.complete === true && entry.evaluatedTo === entry.size)) {
					queue.delete(queuedKey);
				}
			};
			// Give the reserve owner (or oldest waiter) the first chance to
			// progress even if it moved from the live set into the backlog.
			const priorityBacklog = !priorityLive && priority ? queue.get(priority) : undefined;
			const backlogReady = !priorityBacklog || budget <= 0 || readBacklog({
				sessionId: priorityBacklog.sessionId, taskId: priorityBacklog.taskId, [PACKED_PROJECT]: priorityBacklog[PACKED_PROJECT],
			}, priorityBacklog) !== false;
			if (priorityLive) liveAppends.unshift(priorityLive);
			// (a) live appends, then (b) first/incomplete live reads. A previous
			// publication sets priority, not whether a file has unread bytes.
			for (const { session, entry } of [...liveAppends, ...liveFirstReads]) {
				const subject = identityOf(session);
				let file = session.file;
				if (session.kind === "main" && file && index.fragmentBlocked?.(entry, file)) continue;
				// The raw-ID registry can attach a different project’s default-store file.
				if (session.kind === "main" && !sensorSessions.has(session) && subject.projectKey && file && paths?.sessionsDir &&
					isInside(file, paths.sessionsDir) &&
					pathKey(path.dirname(file)) !== pathKey(path.join(paths.sessionsDir, subject.projectKey))) {
					const found = locate(session, liveSessions, cwdOf, budget);
					const { pending, bytesRead } = found;
					file = found.file;
					budget -= bytesRead;
					if (pending || (file && budget === 0 && !entry)) pendingLive.set(subject, true);
					if (!file) continue;
				}
				const { matches, pending, bytesRead, candidate } = verify(session, file, liveSessions, cwdOf, budget);
				if (session.kind === "child") file = candidate;
				budget -= bytesRead;
				if (pending || (matches && budget === 0 && !entry)) pendingLive.set(subject, true);
				if (isTaskOnlyEntry(entry) && entry.state === "ok" && (!matches || pathKey(file) !== pathKey(entry.file))) {
					if (!entry.gone || candidate !== undefined) {
						index.markMissing(subject, metaOf(session), { withdraw: candidate !== undefined });
						ownershipChanged = true;
					}
				}
				if (!matches || budget <= 0) continue;
				budget = Math.max(0, budget - index.update(subject, file, metaOf(session), {
					maxBytes: budget, ownershipUnique: session.id === session.taskId ? true : null,
				}));
			}
			// Ownership checks cost no transcript bytes and must run even when live
			// reads exhaust the budget. A different path or a veto invalidates the old claim.
			for (const [key, row] of taskOnlyChecks.subjects()) {
				const id = subjectKey(key);
				const { file } = locate(row, liveSessions, cwdOf, 0);
				const entry = exactEntry(id);
				const withdraw = file === null || (file !== undefined && pathKey(file) !== pathKey(entry?.file));
				if (entry?.state === "ok" && (withdraw || (file === undefined && (!entry.gone || entry.ownershipUnique !== true)))) {
					index.markMissing(subjectOf(row), metaOf(row), { withdraw });
					ownershipChanged = true;
				}
				if (file) {
					checkedFiles.set(key, file);
				if (!isFresh(exactEntry(id))) queue.set(key, row);
					else if (index.recordOwnership(id, true)) ownershipChanged = true;
				} else {
					queue.delete(key);
				}
			}
			// (c) the ended-session backlog, newest first
			for (const [queuedKey, row] of queue.subjects()) {
				if (!backlogReady || budget <= 0) break;
				if (row === priorityBacklog) continue;
				if (readBacklog(queuedKey, row) === false) break;
			}
			// An exact-session child can also be the alias of a task-only history row.
			// Refresh only aliases history can use; exact-ID rows need no directory check.
			if (fallbackRows.size > 0) {
				const taskIds = packedMap();
				for (const row of fallbacks()) if (row.taskId) taskIds.set({ [PACKED_PROJECT]: row[PACKED_PROJECT], sessionId: row.taskId }, true);
				for (const entry of index.values()) {
					if (entry.kind === "child" && entry.state === "ok" && !isTaskOnlyEntry(entry) && taskIds.has({ projectKey: entry.projectKey, sessionId: entry.taskId })) {
						if (index.checkAliasOwnership(keyOf(entry))) ownershipChanged = true;
					}
				}
			}
			const board = boardTaskLinks(world, nowMs());
			liveTreeRows = [
				...[...liveSessions.values()].map((row) => ({ key: identityOf(row), parentKey: linkedSubject(row, "parent") })),
				...(world?.tasks ?? []).filter((task) => task.childSessionId).map((task) => {
					const { childSessionId, parentSessionId } = task;
					const parent = taskParent(task, task.storeDir ? null : liveSubject(byId.get(parentSessionId)));
					const child = childSubjectOf({ sessionId: childSessionId, task, world, parent });
					return { key: child, parentKey: parent };
				}),
				...board.rows.filter((row) => !row.sessionId).map((row) => usageTreeLink(index, row, board.ambiguous)),
			];
			trees = totals();
			const state = counts();
			// Persist deletions for history and revocations so removing a competing
			// file cannot revive the old on-disk cursor before a recount.
			if (ownershipChanged || parentLinksChanged) index.save();
			parentLinksChanged = false;
			if (index.full && !fullLogged) {
				fullLogged = true;
				log?.warn?.("usage_index_full");
			}
			if (sawBacklog && !backlogLogged && queue.size === 0) {
				index.save();
				log?.info?.("usage_backlog", state);
				backlogLogged = true;
			}
			return { bytesRead: maxBytes - budget, ...state };
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
			const treeId = treeKey(id, false);
			const treeTokens = trees.get(treeId) ?? null;
			const treeTokensComplete = !pendingLive.has(id) && trees.complete.get(treeId) === true;
			const tree = treeTokens === null ? {} : { treeTokens, treeTokensComplete };
			if (pendingLive.has(key)) return { pending: true, ...tree };
			if (!entry) return entry === undefined && index.full && taskId ? { state: "full", ...tree } : treeTokens === null ? null : tree;
			if (entry.state === "full") return { state: "full", ...tree };
			const tokens = compactUsage(entry);
			if (tokens) return { tokens, treeTokens, treeTokensComplete, ...(entry.pending && !entry.gone ? { pending: true } : {}) };
			if (entry.state === "ok" && entry.readError !== true) return { pending: true, ...tree };
			return treeTokens === null ? null : tree;
		},
	};
}
