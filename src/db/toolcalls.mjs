import { createHash } from "node:crypto";
import { quantile, robustStats } from "../baseline.mjs";
import { patternOf, treeLineage } from "../judge/triage.mjs";
import { redact, truncate } from "../util/text.mjs";

/**
 * Tool-call history on the local DB (todo 10 wires the producers). Only shapes are stored, never raw command text:
 * `shape_key` is patternOf(command) (paths and numbers normalized away) and `lineage` is the redacted program names
 * of the call's process tree, so the DB and the pattern-signature ledger agree on what "the same call" means.
 * Only the daemon writes; every function here that writes needs a writable connection.
 */

const bit = (value) => (value === undefined || value === null ? null : value ? 1 : 0);
const orNull = (value) => (value === undefined ? null : value);

/** The normalized shape of a command (stored instead of the command). */
export const shapeKeyOf = (command) => patternOf(command);

/** Lineage text (program names in tree order, joined by `>`, redacted) and its fingerprint, for a call's process tree. */
export function lineageOf(tree, callMs) {
	const names = treeLineage(tree, callMs);
	const text = truncate(redact(names.join(">")), 300);
	return { lineage: text, fp: createHash("sha1").update(names.join(">")).digest("hex").slice(0, 16) };
}

/**
 * Upserts a finished (or censored) tool call by id.
 * @param {{id: string, sessionId?: string, taskId?: string, kind?: "main"|"child", tool?: string, shapeKey?: string,
 *   lineageFp?: string, lineage?: string, startMs?: number, endMs?: number, durMs?: number, isError?: boolean,
 *   endedBy?: "result"|"omo-health"|"cancel"|"unknown", windowSeen?: boolean}} row
 */
export function recordCompletion(db, row) {
	const durMs = row.durMs ?? (Number.isFinite(row.endMs) && Number.isFinite(row.startMs) ? row.endMs - row.startMs : undefined);
	db.prepare(
		`INSERT INTO tool_calls (id, session_id, task_id, kind, tool, shape_key, lineage_fp, lineage, start_ms, end_ms, dur_ms, is_error, ended_by, window_seen)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			session_id = excluded.session_id, task_id = excluded.task_id, kind = excluded.kind, tool = excluded.tool,
			shape_key = excluded.shape_key, lineage_fp = excluded.lineage_fp, lineage = excluded.lineage,
			start_ms = excluded.start_ms, end_ms = excluded.end_ms, dur_ms = excluded.dur_ms,
			is_error = excluded.is_error, ended_by = excluded.ended_by, window_seen = excluded.window_seen`,
	).run(
		String(row.id),
		orNull(row.sessionId),
		orNull(row.taskId),
		orNull(row.kind),
		orNull(row.tool),
		orNull(row.shapeKey),
		orNull(row.lineageFp),
		orNull(row.lineage),
		orNull(row.startMs),
		orNull(row.endMs),
		orNull(durMs),
		bit(row.isError),
		orNull(row.endedBy),
		bit(row.windowSeen),
	);
}

/** Counts one sighting of a lineage fingerprint. */
export function recordLineage(db, fp, lineage, ms) {
	db.prepare(
		`INSERT INTO lineages (fp, lineage, first_ms, last_ms, count) VALUES (?, ?, ?, ?, 1)
		ON CONFLICT(fp) DO UPDATE SET first_ms = MIN(first_ms, excluded.first_ms), last_ms = MAX(last_ms, excluded.last_ms), count = count + 1`,
	).run(fp, orNull(lineage), ms, ms);
}

export function lineageSeen(db, fp) {
	return Boolean(db.prepare("SELECT 1 AS seen FROM lineages WHERE fp = ?").get(fp));
}

/** How many finished calls the history holds (the anomaly signals stay silent until it is large enough). */
export function completionCount(db) {
	return Number(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n);
}

/**
 * Duration statistics of one shape since `sinceMs`: {n, median, p99, mad} (`p99` is the `q` quantile, 0.99 by default) over calls that ended on their own. A call
 * omo-health or a cancel ended is censored (its duration is when someone stopped waiting), so it stays out. With no
 * samples, n is 0 and the rest undefined.
 */
export function shapeStats(db, shapeKey, sinceMs = 0, q = 0.99) {
	const rows = db
		.prepare(
			`SELECT dur_ms FROM tool_calls
			WHERE shape_key = ? AND end_ms >= ? AND dur_ms IS NOT NULL AND COALESCE(ended_by, 'unknown') NOT IN ('omo-health', 'cancel')`,
		)
		.all(shapeKey, sinceMs);
	if (!rows.length) return { n: 0, median: undefined, p99: undefined, mad: undefined };
	const stats = robustStats(rows.map((row) => row.dur_ms));
	return { n: stats.n, median: stats.median, p99: quantile(stats.sorted, q), mad: stats.mad };
}
