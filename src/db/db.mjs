import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The local history store (<healthHome>/omo-health.db, node:sqlite). The daemon is its single writer; a reader that is
 * not the daemon opens it with `readOnly: true`; scan and replay never touch the real file (they use ":memory:").
 * Windows note: a DatabaseSync holds the file (and its -wal/-shm) open until closeDb, so whoever opens one closes it.
 */

const DAY_MS = 24 * 3600_000;

/** Ordered DDL steps; step i (1-based) brings PRAGMA user_version to i. Never edit a shipped step: append a new one. */
const MIGRATIONS = [
	`CREATE TABLE tool_calls (
		id TEXT PRIMARY KEY,
		session_id TEXT,
		task_id TEXT,
		kind TEXT,
		tool TEXT,
		shape_key TEXT,
		lineage_fp TEXT,
		lineage TEXT,
		start_ms INTEGER,
		end_ms INTEGER,
		dur_ms INTEGER,
		is_error INTEGER,
		ended_by TEXT,
		window_seen INTEGER
	);
	CREATE INDEX tool_calls_shape ON tool_calls (shape_key, end_ms);
	CREATE INDEX tool_calls_end ON tool_calls (end_ms);
	CREATE TABLE lineages (
		fp TEXT PRIMARY KEY,
		lineage TEXT,
		first_ms INTEGER,
		last_ms INTEGER,
		count INTEGER
	);
	CREATE INDEX lineages_last ON lineages (last_ms);
	CREATE TABLE baseline_samples (
		metric TEXT NOT NULL,
		t INTEGER NOT NULL,
		value REAL NOT NULL
	);
	CREATE INDEX baseline_samples_metric_t ON baseline_samples (metric, t);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the schema to SCHEMA_VERSION. Idempotent; each step runs in its own transaction. Returns the version. */
export function migrate(db) {
	let version = db.prepare("PRAGMA user_version").get().user_version;
	for (; version < MIGRATIONS.length; version++) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(MIGRATIONS[version]);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	return version;
}

/**
 * Opens (creating when writable) the DB. Writable: WAL, then migrate. Read-only: no pragmas that write, no migration.
 * Throws when the file cannot be opened (a directory in its place, a lock, a corrupt file); the caller decides what to do.
 */
export function openDb({ file, readOnly = false } = {}) {
	const memory = file === ":memory:";
	if (!readOnly && !memory) fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file, { readOnly });
	try {
		db.exec("PRAGMA busy_timeout = 2000");
		// The daemon heap is capped at 96 MB (src/launch.mjs): 8 MB of page cache, not sqlite's default.
		db.exec("PRAGMA cache_size = -8000");
		if (!readOnly) {
			if (!memory) db.exec("PRAGMA journal_mode = WAL");
			migrate(db);
		}
	} catch (error) {
		closeDb(db);
		throw error;
	}
	return db;
}

/** Closes the DB; safe on undefined/null and when already closed. */
export function closeDb(db) {
	if (!db?.isOpen) return;
	try {
		db.close();
	} catch {
		// Already closing: nothing left to release.
	}
}

/** Deletes rows older than `days` days; returns the counts removed per table. */
export function retention(db, nowMs, days) {
	const cutoff = nowMs - days * DAY_MS;
	const run = (sql) => Number(db.prepare(sql).run(cutoff).changes);
	return {
		toolCalls: run("DELETE FROM tool_calls WHERE COALESCE(end_ms, start_ms, 0) < ?"),
		lineages: run("DELETE FROM lineages WHERE last_ms < ?"),
		baselineSamples: run("DELETE FROM baseline_samples WHERE t < ?"),
	};
}

/** Folds the WAL back into the main file and truncates it. */
export function checkpoint(db) {
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** The daemon's periodic upkeep: retention once a day, a WAL checkpoint every config.history.checkpointMs. */
export function createMaintainer({ db, config, clock, log }) {
	let lastRetentionMs = Number.NEGATIVE_INFINITY;
	let lastCheckpointMs = clock.now();
	return {
		tick(now = clock.now()) {
			const history = config.history;
			if (now - lastRetentionMs >= DAY_MS) {
				lastRetentionMs = now;
				try {
					const removed = retention(db, now, history.retentionDays);
					if (Object.values(removed).some(Boolean)) log?.info?.("db_retention", removed);
				} catch (error) {
					log?.error?.("db_retention_failed", { error: error.message });
				}
			}
			if (now - lastCheckpointMs >= history.checkpointMs) {
				lastCheckpointMs = now;
				try {
					checkpoint(db);
				} catch (error) {
					log?.error?.("db_checkpoint_failed", { error: error.message });
				}
			}
		},
	};
}
