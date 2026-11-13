// C-ingest: the budget ledger's driver. Each run reads the appended, complete lines of every main and subagent
// transcript inside the backfill window (bounded bytes per run), turns them into usage rows (idempotent ids), round
// sightings and budget blocks, and reports the goals each main session has had.
//
// Attribution: a main-session event belongs to the goal whose [createdMs, (completedMs ?? Infinity) + closeGraceMs)
// holds the event time (latest createdMs wins). A subagent event belongs for life to the goal its task was created
// under: projectOf(task.created_at) over the root session's goals, a function of stored records only, so a restart
// that re-reads from offset 0 attributes every row the same way.
import fs from "node:fs";
import path from "node:path";
import { createTaskStoreReader, senpiTaskStoreDir } from "../collect/tasks.mjs";
import { listDirSafe, readJsonSafe, readTextSafe, statSafe } from "../util/fsx.mjs";
import { toMs } from "../util/time.mjs";
import { extractEvents } from "./events.mjs";

const DAY_MS = 24 * 3600_000;
const HEADER_BYTES = 64 * 1024;
const SCAN_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

function budgetOf(config) {
	const value = typeof config === "function" ? config() : config;
	return value?.budget ?? value ?? {};
}

function num(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Goal store timestamps are epoch seconds; ISO strings are accepted too. */
function goalMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
	const ms = toMs(value);
	return Number.isFinite(ms) ? ms : null;
}

function identityOf(stat) {
	return `${stat.birthtimeMs}:${stat.ino}`;
}

/** First line of a transcript: the `type: "session"` header carrying the session id and cwd. */
function readHeader(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(HEADER_BYTES);
		const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
		const end = buf.subarray(0, n).indexOf(NEWLINE);
		if (end < 0) return null;
		const entry = JSON.parse(buf.subarray(0, end).toString("utf8"));
		if (!entry || entry.type !== "session" || typeof entry.id !== "string") return null;
		return { id: entry.id, cwd: typeof entry.cwd === "string" ? entry.cwd : null };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * Bytes from `offset` up to and including the next newline, or null when no complete line is left in the file.
 * `first` is the bounded chunk already read from `offset`; the rest is scanned in capped blocks so a huge line
 * costs memory only once, and the returned buffer never ends mid-line.
 */
function readLineEnd(file, offset, size, first) {
	const head = first.indexOf(NEWLINE);
	if (head >= 0) return first.subarray(0, head + 1);
	if (first.length === 0) return null;
	const parts = [first];
	let pos = offset + first.length;
	let fd;
	try {
		fd = fs.openSync(file, "r");
		while (pos < size) {
			const len = Math.min(size - pos, SCAN_BYTES);
			const buf = Buffer.alloc(len);
			const n = fs.readSync(fd, buf, 0, len, pos);
			if (n <= 0) break;
			const part = buf.subarray(0, n);
			pos += n;
			const end = part.indexOf(NEWLINE);
			if (end >= 0) {
				parts.push(part.subarray(0, end + 1));
				return Buffer.concat(parts);
			}
			parts.push(part);
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function goalOf(raw) {
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
	const createdMs = goalMs(raw.createdAt);
	if (createdMs === null) return null;
	return {
		id: raw.id,
		objective: typeof raw.objective === "string" ? raw.objective : "",
		status: typeof raw.status === "string" ? raw.status : "active",
		createdMs,
		completedMs: goalMs(raw.completedAt),
		updatedMs: goalMs(raw.updatedAt) ?? createdMs,
	};
}

/** `<dir>/extensions/goal/<sid>.json` (current goal) and `<sid>.history.jsonl` (archived completed goals). */
function readGoalFiles(dir, sessionId) {
	const base = path.join(dir, "extensions", "goal");
	const file = readJsonSafe(path.join(base, `${sessionId}.json`));
	const exists = file !== undefined;
	const current = goalOf(file && typeof file === "object" && "goal" in file ? file.goal : file);
	const history = [];
	const text = readTextSafe(path.join(base, `${sessionId}.history.jsonl`), "");
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const goal = goalOf(JSON.parse(line));
			if (goal) history.push(goal);
		} catch {
			// a torn history line is skipped
		}
	}
	return { exists, current, history };
}

/**
 * The goal list of one session: archived goals, the current goal, and goals the ledger already knows (a replaced
 * goal is overwritten in the goal file, so the stored project is the only memory of it). A goal that is neither
 * current nor completed ended when its successor was created (status `replaced`); a known goal with no successor
 * and no record on disk is `missing`: the goal file was deleted, or the goal id left the file and its history.
 * A missing goal is never active; it gets no audit, budget request or checkpoint.
 */
function mergeGoals({ files, known }) {
	const byId = new Map();
	const onDisk = new Set();
	for (const goal of known) byId.set(goal.id, { ...goal });
	for (const goal of files?.history ?? []) {
		byId.set(goal.id, { ...goal });
		onDisk.add(goal.id);
	}
	if (files?.current) {
		byId.set(files.current.id, { ...files.current });
		onDisk.add(files.current.id);
	}
	const goals = [...byId.values()].sort((a, b) => a.createdMs - b.createdMs || (a.id < b.id ? -1 : 1));
	const currentId = files?.current?.id ?? null;
	for (let i = 0; i < goals.length; i++) {
		const goal = goals[i];
		if (goal.id === currentId) continue;
		const doneStatus = goal.status === "complete" || goal.status === "completed";
		if (doneStatus && goal.completedMs !== null) continue;
		const next = goals[i + 1];
		if (next) {
			if (goal.completedMs === null) goal.completedMs = next.createdMs;
			if (!doneStatus) goal.status = "replaced";
		} else if (!onDisk.has(goal.id)) {
			goal.status = "missing";
		}
	}
	return goals;
}

/** The goal whose attribution window holds `ms`; latest createdMs wins. */
export function projectOfGoals(sessionId, goals, ms, graceMs) {
	let best = null;
	for (const goal of goals ?? []) {
		if (ms < goal.createdMs) continue;
		if (ms >= (goal.completedMs ?? Infinity) + graceMs) continue;
		if (!best || goal.createdMs >= best.createdMs) best = goal;
	}
	return best ? `${sessionId}:${best.id}` : null;
}

/** `<cwd>/.omo/ulw-loop/<sid>/goals.json` -> {total, evidenced, allEvidencedMs|null}. */
function readCriteria(cwd, sessionId) {
	if (!cwd) return null;
	const data = readJsonSafe(path.join(cwd, ".omo", "ulw-loop", sessionId, "goals.json"));
	const goals = Array.isArray(data?.goals) ? data.goals : null;
	if (!goals || goals.length === 0) return null;
	let evidenced = 0;
	let maxUpdated = null;
	for (const goal of goals) {
		const captured = goal?.capturedEvidence;
		const hasEvidence = Array.isArray(captured) ? captured.length > 0 : typeof captured === "string" ? captured.length > 0 : !!captured && typeof captured === "object" && Object.keys(captured).length > 0;
		if (hasEvidence || ["passed", "met", "done"].includes(goal?.status)) evidenced++;
		const updated = toMs(goal?.updatedAt);
		if (Number.isFinite(updated)) maxUpdated = Math.max(maxUpdated ?? updated, updated);
	}
	return { total: goals.length, evidenced, allEvidencedMs: evidenced === goals.length ? maxUpdated : null };
}

function listJsonl(dir, recursive) {
	const out = [];
	for (const entry of listDirSafe(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recursive) out.push(...listJsonl(full, true));
		} else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

/** Default task store discovery: one senpi-task store per main-session cwd (src/collect/tasks.mjs rule). */
function defaultReadTaskStores(paths) {
	const reader = createTaskStoreReader();
	return (cwds) => {
		const seen = new Set();
		const stores = [];
		for (const cwd of cwds) {
			const storeDir = senpiTaskStoreDir(cwd, paths.agentDir);
			if (seen.has(storeDir)) continue;
			seen.add(storeDir);
			const { tasks } = reader.read(cwd, storeDir);
			stores.push({ storeDir, tasks });
		}
		return stores;
	};
}

/**
 * @param {{paths: object, store: object, clock: {now(): number}, config: object|function, readTaskStores?: (cwds: string[]) => Array<{storeDir: string, tasks: Array}>}} options
 */
export function createIngest({ paths, store, clock, config, readTaskStores }) {
	const readStores = readTaskStores ?? defaultReadTaskStores(paths);
	const headers = new Map(); // file -> {identity, header}
	const providers = new Map(); // file -> latest model_change provider (seeded from the stored offset)

	function headerOf(file, identity) {
		const cached = headers.get(file);
		if (cached && cached.identity === identity) return cached.header;
		const header = readHeader(file);
		if (header) headers.set(file, { identity, header });
		return header;
	}

	function knownGoalsBySession() {
		const map = new Map();
		for (const project of store.listProjects()) {
			const list = map.get(project.sessionId) ?? [];
			list.push({
				id: project.goalId,
				objective: project.objective ?? "",
				status: project.data?.goalStatus ?? "active",
				createdMs: project.createdMs,
				completedMs: Number.isFinite(project.data?.goalCompletedMs) ? project.data.goalCompletedMs : null,
				updatedMs: project.updatedMs,
			});
			map.set(project.sessionId, list);
		}
		return map;
	}

	return {
		run() {
			const budget = budgetOf(config);
			const now = clock.now();
			const sinceMs = now - num(budget.backfillDays, 8) * DAY_MS;
			const graceMs = num(budget.closeGraceMs, DAY_MS);
			let budgetBytes = num(budget.ingestBytesPerTick, 8 * 1024 * 1024);
			const known = knownGoalsBySession();

			// Main sessions: discovery, headers, goals.
			const sessions = new Map(); // sid -> {file, cwd, dir}
			const pending = [];
			for (const projectDir of listDirSafe(paths.sessionsDir, { withFileTypes: true })) {
				if (!projectDir.isDirectory()) continue;
				const dir = path.join(paths.sessionsDir, projectDir.name);
				for (const name of listDirSafe(dir)) {
					if (!name.endsWith(".jsonl")) continue;
					const file = path.join(dir, name);
					const stat = statSafe(file);
					if (!stat || !stat.isFile() || stat.mtimeMs < sinceMs) continue;
					const identity = identityOf(stat);
					const header = headerOf(file, identity);
					if (!header) continue;
					sessions.set(header.id, { file, cwd: header.cwd, dir });
					pending.push({ file, stat, identity, sessionId: header.id, rootSessionId: header.id, source: "main", taskId: null });
				}
			}
			const goals = new Map();
			for (const [sid, info] of sessions) {
				goals.set(sid, mergeGoals({ files: readGoalFiles(info.dir, sid), known: known.get(sid) ?? [] }));
			}
			const goalsFor = (sid) => goals.get(sid) ?? mergeGoals({ files: null, known: known.get(sid) ?? [] });

			// Subagent transcripts: every task record created inside the backfill window.
			const cwds = [...new Set([...sessions.values()].map((s) => s.cwd).filter(Boolean))];
			for (const { storeDir, tasks } of readStores(cwds) ?? []) {
				for (const task of tasks ?? []) {
					const createdMs = task.createdAtMs;
					if (!Number.isFinite(createdMs) || createdMs < sinceMs || !task.taskId) continue;
					const rootSessionId = task.rootSessionId ?? task.parentSessionId;
					if (!rootSessionId) continue;
					const projectId = projectOfGoals(rootSessionId, goalsFor(rootSessionId), createdMs, graceMs);
					for (const file of listJsonl(path.join(storeDir, "children", task.taskId, "sessions"), true)) {
						const stat = statSafe(file);
						if (!stat || !stat.isFile()) continue;
						const identity = identityOf(stat);
						const header = headerOf(file, identity);
						const sessionId = header?.id ?? task.childSessionId ?? task.taskId;
						pending.push({ file, stat, identity, sessionId, rootSessionId, source: "child", taskId: task.taskId, fixedProjectId: projectId });
					}
				}
			}

			// Bounded read: oldest pending first, complete lines only, offsets saved after each file.
			const work = [];
			const progress = { totalBytes: 0, pendingBytes: 0, files: 0, pendingFiles: 0 };
			for (const item of pending) {
				const stored = store.getOffset(item.file);
				const sameIdentity = !!stored && stored.identity === item.identity;
				let offset = sameIdentity ? stored.offset : 0;
				if (offset > item.stat.size) offset = 0;
				// The byte offset carries the provider context of the lines before it: a restarted reader resumes
				// mid-transcript without re-reading the model_change that set it. Only a resume at that stored offset keeps it;
				// a different identity or a shrunk file is read again from 0 and starts with no provider.
				const resumes = sameIdentity && offset > 0 && offset === stored.offset;
				if (!providers.has(item.file) || offset === 0) providers.set(item.file, resumes ? stored.provider ?? null : null);
				progress.files += 1;
				progress.totalBytes += item.stat.size;
				if (item.stat.size > offset) {
					progress.pendingBytes += item.stat.size - offset;
					progress.pendingFiles += 1;
					work.push({ ...item, offset });
				} else if (!stored || stored.identity !== item.identity || stored.offset !== offset) store.setOffset(item.file, item.identity, offset, now, providers.get(item.file) ?? null);
			}
			work.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || (a.file < b.file ? -1 : 1));

			const result = { files: 0, bytes: 0, inserted: 0, progress, goals, sessions, rounds: [], blocks: [], criteria: new Map() };
			for (const item of work) {
				if (budgetBytes <= 0) break;
				const length = Math.min(item.stat.size - item.offset, budgetBytes);
				const buf = Buffer.alloc(length);
				let n = 0;
				try {
					const fd = fs.openSync(item.file, "r");
					try {
						n = fs.readSync(fd, buf, 0, length, item.offset);
					} finally {
						fs.closeSync(fd);
					}
				} catch {
					continue;
				}
				let chunk = buf.subarray(0, n);
				const last = chunk.lastIndexOf(NEWLINE);
				let consumed;
				if (last >= 0) {
					consumed = last + 1;
					chunk = chunk.subarray(0, consumed);
				} else {
					// No complete line inside the bounded read: either the pending line is still being written or it is
					// longer than a whole run's budget. A line that big is read completely in this run (complete lines
					// only, the cap still applies to every other file); an unterminated one consumes nothing, so the
					// stored offset never lands in the middle of a line.
					chunk = readLineEnd(item.file, item.offset, item.stat.size, chunk);
					if (!chunk) continue;
					consumed = chunk.length;
				}
				budgetBytes -= consumed;
				result.files++;
				result.bytes += consumed;

				const sessionGoals = item.source === "main" ? goalsFor(item.sessionId) : null;
				const projectOf = item.source === "main"
					? (ms) => projectOfGoals(item.sessionId, sessionGoals, ms, graceMs)
					: () => item.fixedProjectId;
				const usage = [];
				let start = 0;
				while (start < consumed) {
					let end = chunk.indexOf(NEWLINE, start);
					if (end < 0 || end >= consumed) end = consumed;
					const lineOffset = item.offset + start;
					const text = chunk.subarray(start, end).toString("utf8").trim();
					start = end + 1;
					if (!text) continue;
					let entry;
					try {
						entry = JSON.parse(text);
					} catch {
						continue;
					}
					const out = extractEvents(entry, {
						sessionId: item.sessionId,
						rootSessionId: item.rootSessionId,
						taskId: item.taskId,
						source: item.source,
						provider: providers.get(item.file),
						// The byte offset of the line: stable across re-reads of the same file.
						lineNo: lineOffset,
						projectOf,
					});
					if (out.modelProvider) providers.set(item.file, out.modelProvider);
					if (out.usage) usage.push(out.usage);
					if (item.source !== "main") continue;
					const ms = out.usage?.ms ?? toMs(entry.timestamp) ?? null;
					if (!Number.isFinite(ms)) continue;
					const projectId = projectOf(ms);
					if (!projectId) continue;
					for (const round of out.rounds) {
						store.recordRound(projectId, round, ms);
						result.rounds.push({ projectId, round, ms });
					}
					for (const block of out.blocks) {
						result.blocks.push({ projectId, sessionId: item.sessionId, ms, kind: block.kind, body: block.body, entryId: entry.id ?? null });
					}
				}
				if (usage.length) result.inserted += store.insertUsage(usage);
				store.setOffset(item.file, item.identity, item.offset + consumed, now, providers.get(item.file) ?? null);
			}

			// Acceptance criteria belong to the session's current goal.
			for (const [sid, info] of sessions) {
				const list = goals.get(sid) ?? [];
				const current = projectOfGoals(sid, list.filter((g) => g.completedMs === null), now, graceMs);
				if (current) result.criteria.set(current, readCriteria(info.cwd, sid));
			}
			return result;
		},
	};
}
