import { idFromFileName } from "./collect/sessions.mjs";
import { pathKey } from "./paths.mjs";
import { USAGE_TICK_BYTES, compactUsage, fresh as isFresh, treeTotals } from "./usage-index.mjs";

/**
 * The daemon's token tracker (plan todo 5): one per-tick byte budget shared by
 * live appends, first reads of live sessions and the ended-session backlog, all
 * spent through the single writer of the index (`src/usage-index.mjs`).
 *
 * Live sessions are indexed only from a file that passes the backlog's exact-file
 * rule: a main file name must carry its session id, and a child file must be the
 * one the locator returns for its task and session id. The live collector can
 * attach a task directory's newest file to the wrong child
 * (`findChildSessionFile`), and that file's usage must never be billed there.
 */
const DAY_MS = 24 * 60 * 60_000;
const ANCESTOR_DEPTH = 8;

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

/**
 * @param {object} options
 * @param {object} options.paths        resolvePaths() result (index file, session dirs)
 * @param {object} options.index        createUsageIndex() instance; its file is the daemon's usage.json
 * @param {object} options.locator      createSessionFileLocator() instance
 * @param {object} options.clock        {now()}
 * @param {object} options.log          {info, error}
 */
export function createUsageTracker({ paths, index, locator, clock, log } = {}) {
	const nowMs = () => (typeof clock?.now === "function" ? clock.now() : Date.now());
	/** Every ledger row seen so far, for the ancestor cwd walk. */
	const ledgerRows = new Map();
	/** Rows waiting for bytes: id -> ledger row, newest first. */
	let queue = new Map();
	let trees;
	let backlogLogged = false;
	let sawBacklog = false;

	const cwdCandidates = (row, liveSessions) => {
		const cwds = [];
		const push = (cwd) => {
			if (isNonEmptyString(cwd) && !cwds.includes(cwd)) cwds.push(cwd);
		};
		push(row?.cwd);
		const seen = new Set();
		if (isNonEmptyString(row?.sessionId)) seen.add(row.sessionId);
		let current = row;
		for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
			const parentId = current?.parentSessionId;
			if (!isNonEmptyString(parentId) || seen.has(parentId)) break;
			seen.add(parentId);
			const parent = ledgerRows.get(parentId) ?? index.get(parentId) ?? liveSessions?.get?.(parentId);
			if (!parent) break;
			push(parent.cwd);
			current = parent;
		}
		return cwds;
	};

	const metaOf = (source) => ({
		kind: source?.kind ?? null,
		taskId: source?.taskId ?? null,
		parentSessionId: source?.parentSessionId ?? null,
		rootSessionId: source?.rootSessionId ?? null,
	});

	/** The live session's own file, only when it is the exact file the locator would choose. */
	const verifiedFile = (session, liveSessions) => {
		const file = session?.file;
		if (!isNonEmptyString(file)) return undefined;
		if (session.kind === "main") return idFromFileName(file) === session.id ? file : undefined;
		if (session.kind !== "child" || !isNonEmptyString(session.taskId)) return undefined;
		const found = locator?.childFile?.({ taskId: session.taskId, sessionId: session.id, cwds: cwdCandidates(session, liveSessions) });
		return found && pathKey(found) === pathKey(file) ? file : undefined;
	};

	const locate = (row, liveSessions) => {
		if (row.kind === "child") {
			return locator?.childFile?.({ taskId: row.taskId ?? row.sessionId, sessionId: row.sessionId, cwds: cwdCandidates(row, liveSessions) });
		}
		return locator?.mainFile?.(row.sessionId);
	};

	const isComplete = (id) => {
		const entry = index.get(id);
		return entry?.state === "ok" && entry.complete === true;
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

	return {
		/**
		 * Queue ledger rows that need bytes, newest first: unindexed rows, rows whose
		 * first read was interrupted, complete rows whose file moved past the indexed
		 * end (an append or a same-length rewrite, which `readUsage` recounts), and
		 * missing rows checked more than a day ago, and gone rows (deleted after a
		 * complete read) checked more than a day ago.
		 */
		queueLedger(rows) {
			for (const row of rows ?? []) {
				if (!isNonEmptyString(row?.sessionId)) continue;
				ledgerRows.set(row.sessionId, row);
				const entry = index.get(row.sessionId);
				const checkedAgo = nowMs() - (Number.isFinite(entry?.checkedMs) ? entry.checkedMs : 0) > DAY_MS;
				let need = false;
				if (!entry) need = true;
				else if (entry.state === "ok" && entry.complete !== true) need = true;
				else if (entry.gone === true) need = checkedAgo;
				else if (entry.complete === true && !isFresh(entry)) need = true;
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
			const sessions = [...(world?.sessions?.values?.() ?? [])];
			const liveSessions = new Map(sessions.filter((session) => isNonEmptyString(session?.id)).map((session) => [session.id, session]));
			const live = [];
			for (const session of sessions) {
				if (!isNonEmptyString(session?.id)) continue;
				const sessionFile = verifiedFile(session, liveSessions);
				if (!sessionFile) continue;
				live.push({ id: session.id, file: sessionFile, meta: metaOf(session) });
			}
			// (a) bytes appended to a session already indexed
			for (const item of live) {
				if (budget <= 0) break;
				if (!isComplete(item.id)) continue;
				budget = Math.max(0, budget - index.update(item.id, item.file, item.meta, { maxBytes: budget }));
			}
			// (b) live sessions never read, or whose first read was interrupted
			for (const item of live) {
				if (budget <= 0) break;
				if (isComplete(item.id)) continue;
				budget = Math.max(0, budget - index.update(item.id, item.file, item.meta, { maxBytes: budget }));
			}
			// (c) the ended-session backlog, newest first
			for (const [id, row] of queue) {
				if (budget <= 0) break;
				const rowFile = locate(row, liveSessions);
				if (!rowFile) {
					index.markMissing(id, metaOf(row));
					queue.delete(id);
					continue;
				}
				budget = Math.max(0, budget - index.update(id, rowFile, metaOf(row), { maxBytes: budget }));
				if (isComplete(id)) queue.delete(id);
			}
			trees = treeTotals(index.entries());
			const state = counts();
			if (sawBacklog && !backlogLogged && queue.size === 0) {
				index.save();
				log?.info?.("usage_backlog", state);
				backlogLogged = true;
			}
			return { bytesRead: USAGE_TICK_BYTES - budget, ...state };
		},

		/**
		 * The board's lookup: `{tokens, treeTokens}` for a complete entry
		 * (`treeTokens` only when descendants push it above the session's own total),
		 * `{pending:true}` while an entry's first full read has not finished, and
		 * null when nothing is known.
		 */
		tokensOf(id) {
			const entry = index.get(id);
			if (!entry) return null;
			if (entry.readError === true) return null;
			const tokens = compactUsage(entry);
			if (!tokens) return entry.state === "ok" ? { pending: true } : null;
			const totals = trees ?? treeTotals(index.entries());
			const tree = totals.get(entry.id) ?? tokens.total;
			return { tokens, treeTokens: tree > tokens.total ? tree : null };
		},
	};
}
