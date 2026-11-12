import { accountOf, windowApplies } from "./accounts.mjs";

/**
 * The budget ledger over the shared history DB (C-store). Every method is sync: the daemon is the DB's single
 * writer, and prepared statements keep a whole tick cheap. JSON columns are parsed on read.
 */

const DAY_MS = 24 * 3600_000;

function transaction(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function projectFromRow(row) {
	return {
		id: row.id,
		sessionId: row.session_id,
		goalId: row.goal_id,
		cwd: row.cwd ?? null,
		objective: row.objective ?? null,
		createdMs: row.created_ms,
		status: row.status,
		revision: row.revision,
		closedMs: row.closed_ms ?? null,
		updatedMs: row.updated_ms,
		data: JSON.parse(row.data),
	};
}

export function createBudgetStore(db) {
	const insertUsageStmt = db.prepare(
		`INSERT OR IGNORE INTO usage_events (id, ms, session_id, root_session_id, project_id, task_id, source, provider, model,
			input, output, cache_read, cache_write, cost, cost_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const getOffsetStmt = db.prepare("SELECT identity, offset FROM ingest_offsets WHERE file = ?");
	const setOffsetStmt = db.prepare(
		`INSERT INTO ingest_offsets (file, identity, offset, updated_ms) VALUES (?, ?, ?, ?)
		 ON CONFLICT(file) DO UPDATE SET identity = excluded.identity, offset = excluded.offset, updated_ms = excluded.updated_ms`,
	);
	const insertQuotaStmt = db.prepare(
		`INSERT OR IGNORE INTO quota_samples (account, window_id, updated_ms, used_percent, resets_at_ms, window_minutes)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const quotaSamplesStmt = db.prepare(
		`SELECT updated_ms, used_percent, resets_at_ms, window_minutes FROM quota_samples
		 WHERE account = ? AND window_id = ? AND updated_ms >= ? ORDER BY updated_ms ASC`,
	);
	const upsertProjectStmt = db.prepare(
		`INSERT INTO budget_projects (id, session_id, goal_id, cwd, objective, created_ms, status, revision, data, closed_ms, updated_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, goal_id = excluded.goal_id, cwd = excluded.cwd,
		   objective = excluded.objective, created_ms = excluded.created_ms, status = excluded.status, revision = excluded.revision,
		   data = excluded.data, closed_ms = excluded.closed_ms, updated_ms = excluded.updated_ms`,
	);
	const getProjectStmt = db.prepare("SELECT * FROM budget_projects WHERE id = ?");
	const recordRoundStmt = db.prepare("INSERT OR IGNORE INTO budget_rounds (project_id, round, first_ms) VALUES (?, ?, ?)");
	const roundsStmt = db.prepare("SELECT round, first_ms FROM budget_rounds WHERE project_id = ? ORDER BY first_ms ASC, round ASC");
	const appendEventStmt = db.prepare("INSERT INTO budget_events (ms, project_id, account, kind, data) VALUES (?, ?, ?, ?, ?)");

	return {
		/** INSERT OR IGNORE every event in one transaction; returns how many rows were actually inserted. */
		insertUsage(events = []) {
			return transaction(db, () => {
				let inserted = 0;
				for (const event of events) {
					const missing = event.costStatus === "missing" || event.cost == null;
					const result = insertUsageStmt.run(
						event.id,
						event.ms,
						event.sessionId,
						event.rootSessionId,
						event.projectId ?? null,
						event.taskId ?? null,
						event.source,
						event.provider ?? null,
						event.model ?? null,
						event.input ?? 0,
						event.output ?? 0,
						event.cacheRead ?? 0,
						event.cacheWrite ?? 0,
						missing ? null : event.cost,
						missing ? "missing" : "reported",
					);
					inserted += Number(result.changes);
				}
				return inserted;
			});
		},

		getOffset(file) {
			const row = getOffsetStmt.get(file);
			return row ? { identity: row.identity, offset: row.offset } : null;
		},

		setOffset(file, identity, offset, ms) {
			setOffsetStmt.run(file, identity, offset, ms);
		},

		/** INSERT OR IGNORE quota readings; the (account, window, updated_ms) key makes a re-read idempotent. */
		insertQuotaSamples(samples = []) {
			return transaction(db, () => {
				let inserted = 0;
				for (const sample of samples) {
					const result = insertQuotaStmt.run(
						sample.account,
						sample.windowId,
						sample.updatedMs,
						sample.usedPercent,
						sample.resetsAtMs ?? null,
						sample.windowMinutes ?? null,
					);
					inserted += Number(result.changes);
				}
				return inserted;
			});
		},

		quotaSamples({ account, windowId, sinceMs = 0 }) {
			return quotaSamplesStmt.all(account, windowId, sinceMs).map((row) => ({
				updatedMs: row.updated_ms,
				usedPercent: row.used_percent,
				resetsAtMs: row.resets_at_ms ?? null,
				windowMinutes: row.window_minutes ?? null,
			}));
		},

		/**
		 * Aggregates reported USD (and counts missing-cost events). `accounts` filters to one window: the row's
		 * provider must resolve to that account and the window must apply to the row's model.
		 */
		spend({ projectId, rootSessionId, sinceMs, untilMs, sources, accounts } = {}) {
			const where = [];
			const params = [];
			if (projectId !== undefined) {
				where.push("project_id = ?");
				params.push(projectId);
			}
			if (rootSessionId !== undefined) {
				where.push("root_session_id = ?");
				params.push(rootSessionId);
			}
			if (sinceMs !== undefined) {
				where.push("ms >= ?");
				params.push(sinceMs);
			}
			if (untilMs !== undefined) {
				where.push("ms < ?");
				params.push(untilMs);
			}
			if (sources?.length) {
				where.push(`source IN (${sources.map(() => "?").join(", ")})`);
				params.push(...sources);
			}
			const rows = db
				.prepare(
					`SELECT source, provider, model, cost, cost_status FROM usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
				)
				.all(...params);
			let costUsd = 0;
			let mainUsd = 0;
			let childUsd = 0;
			let auditUsd = 0;
			let missing = 0;
			let events = 0;
			const byModel = {};
			for (const row of rows) {
				if (accounts) {
					if (accountOf(row.provider, accounts.aliases) !== accounts.account) continue;
					if (!windowApplies(accounts.window, row.model)) continue;
				}
				events++;
				if (row.cost_status !== "reported" || row.cost == null) {
					missing++;
					continue;
				}
				costUsd += row.cost;
				if (row.source === "main") mainUsd += row.cost;
				else if (row.source === "child") childUsd += row.cost;
				else if (row.source === "audit") auditUsd += row.cost;
				const key = row.model ?? "unknown";
				byModel[key] = (byModel[key] ?? 0) + row.cost;
			}
			return { costUsd, mainUsd, childUsd, auditUsd, missing, events, byModel };
		},

		upsertProject(record) {
			upsertProjectStmt.run(
				record.id,
				record.sessionId,
				record.goalId,
				record.cwd ?? null,
				record.objective ?? null,
				record.createdMs,
				record.status,
				record.revision,
				JSON.stringify(record.data ?? {}),
				record.closedMs ?? null,
				record.updatedMs,
			);
		},

		getProject(id) {
			const row = getProjectStmt.get(id);
			return row ? projectFromRow(row) : null;
		},

		listProjects({ statuses, sinceMs } = {}) {
			const where = [];
			const params = [];
			if (statuses?.length) {
				where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
				params.push(...statuses);
			}
			if (sinceMs !== undefined) {
				where.push("updated_ms >= ?");
				params.push(sinceMs);
			}
			const sql = `SELECT * FROM budget_projects${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_ms ASC, id ASC`;
			return db.prepare(sql).all(...params).map(projectFromRow);
		},

		/** Keeps the first time a round was seen: a later sighting never moves it. */
		recordRound(projectId, round, ms) {
			recordRoundStmt.run(projectId, round, ms);
		},

		rounds(projectId) {
			return roundsStmt.all(projectId).map((row) => ({ round: row.round, firstMs: row.first_ms }));
		},

		appendEvent({ ms, projectId, account, kind, data }) {
			const result = appendEventStmt.run(ms, projectId ?? null, account ?? null, kind, JSON.stringify(data ?? {}));
			return Number(result.changes);
		},

		events({ projectId, sinceMs, limit } = {}) {
			const where = [];
			const params = [];
			if (projectId !== undefined) {
				where.push("project_id = ?");
				params.push(projectId);
			}
			if (sinceMs !== undefined) {
				where.push("ms >= ?");
				params.push(sinceMs);
			}
			let sql = `SELECT * FROM budget_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ms DESC, seq DESC`;
			if (limit !== undefined) {
				sql += " LIMIT ?";
				params.push(limit);
			}
			return db.prepare(sql).all(...params).map((row) => ({
				seq: row.seq,
				ms: row.ms,
				projectId: row.project_id ?? null,
				account: row.account ?? null,
				kind: row.kind,
				data: JSON.parse(row.data),
			}));
		},

		/** Retention: usage rows and quota readings expire; projects and their rounds/events are kept. */
		prune(now, retentionDays) {
			const cutoff = now - retentionDays * DAY_MS;
			return {
				usageEvents: Number(db.prepare("DELETE FROM usage_events WHERE ms < ?").run(cutoff).changes),
				quotaSamples: Number(db.prepare("DELETE FROM quota_samples WHERE updated_ms < ?").run(cutoff).changes),
			};
		},
	};
}
