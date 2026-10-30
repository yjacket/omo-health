import path from "node:path";
import { atomicWriteJson, listDirSafe, readJsonSafe } from "../util/fsx.mjs";
import { truncate } from "../util/text.mjs";

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const ACTIVE = new Set(["active", "running", "in_progress", "pending"]);
const plain = (value) => (value instanceof Map ? [...value] : Object.entries(value ?? {}));

/** Counters in the shape SessionTracker's seedActivity reads back after a restart. */
function activityRecord(activity) {
	if (!activity) return undefined;
	return {
		sinceMs: activity.sinceMs,
		toolCalls: activity.toolCalls,
		mutations: activity.mutations,
		mutationsBeforeAuto: activity.mutationsBeforeAuto,
		files: plain(activity.files).slice(0, 200),
		failingChecks: plain(activity.failingChecks),
		taskSpawns: (activity.taskSpawns ?? []).slice(-50),
		lastTodo: activity.lastTodo ?? null,
	};
}

/**
 * One session's alignment ledger (plan todo 24): the original goal, the latest requests,
 * open commitments and the scope checks sent. `previous` carries the todo list across user
 * turns (activity resets on each turn) and the nudge history.
 */
export function buildLedger(session, previous, newNudges = []) {
	const anchor = session.anchor;
	const goal = anchor?.objective
		? { objective: truncate(anchor.objective, 500), status: anchor.status ?? null, source: anchor.source }
		: session.firstUserText ? { objective: truncate(session.firstUserText, 500), status: null, source: "first-request" } : null;
	const todo = session.activity?.lastTodo;
	const nudges = [...(previous?.nudges ?? []), ...newNudges].slice(-10);
	return {
		sessionId: session.id,
		cwd: session.cwd ?? null,
		goal,
		firstRequest: session.firstUserText ?? null,
		requests: (session.userTurns ?? []).slice(-10).map((turn) => ({ ms: turn.ms, text: turn.text })),
		openCommitments: {
			todoOpen: todo ? todo.open : previous?.openCommitments?.todoOpen ?? 0,
			todoItems: todo ? (todo.openItems ?? []).slice(0, 10) : previous?.openCommitments?.todoItems ?? [],
			goalActive: Boolean(goal && ACTIVE.has(goal.status)),
		},
		nudges,
		// What the detector judges from: the newest steps, so an operator can see why a note was (not) sent.
		steps: (session.steps ?? []).slice(-50),
		activity: activityRecord(session.activity),
	};
}

/**
 * After an engine tick: write ~/.omo-health/alignment/<sid>.json for every tracked session,
 * only when its content changed. `cache` (sid -> last written JSON) spares re-reading files.
 */
export function writeLedgers(paths, { world, findings = [] } = {}, now, cache = new Map()) {
	const dir = paths.health.alignmentDir;
	const nudgesBySession = new Map();
	for (const finding of findings) {
		if (finding.detector !== "D15" || !finding.subject?.sessionId) continue;
		const list = nudgesBySession.get(finding.subject.sessionId) ?? [];
		list.push({ ms: now, signal: finding.data?.signal ?? finding.cls });
		nudgesBySession.set(finding.subject.sessionId, list);
	}
	let written = 0;
	for (const session of world?.sessions?.values() ?? []) {
		if (!SAFE_ID.test(session.id ?? "") || (!session.anchor && !session.firstUserText && !session.userTurns?.length)) continue;
		const file = path.join(dir, `${session.id}.json`);
		if (!cache.has(session.id)) {
			const saved = readJsonSafe(file);
			cache.set(session.id, saved ? JSON.stringify({ ...saved, updatedMs: undefined }) : undefined);
		}
		const previousText = cache.get(session.id);
		const ledger = buildLedger(session, previousText ? JSON.parse(previousText) : undefined, nudgesBySession.get(session.id));
		const text = JSON.stringify({ ...ledger, updatedMs: undefined });
		if (text === previousText) continue;
		atomicWriteJson(file, { ...ledger, updatedMs: now });
		cache.set(session.id, text);
		written++;
	}
	return written;
}

/** Ledgers updated within `maxAgeMs`, newest first (status --json). */
export function readLedgers(paths, { now = Date.now(), maxAgeMs = 24 * 3600_000, limit = 20 } = {}) {
	const dir = paths.health.alignmentDir;
	return listDirSafe(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJsonSafe(path.join(dir, name)))
		.filter((ledger) => ledger?.sessionId && Number.isFinite(ledger.updatedMs) && now - ledger.updatedMs <= maxAgeMs)
		.sort((a, b) => b.updatedMs - a.updatedMs)
		.slice(0, limit);
}
