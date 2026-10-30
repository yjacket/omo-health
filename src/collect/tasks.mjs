import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { toMs } from "../util/time.mjs";

export const ACTIVE_TASK_STATUSES = new Set(["running", "queued", "pending", "starting", "spawning"]);
export const TERMINAL_TASK_STATUSES = new Set(["completed", "error", "cancelled", "interrupted", "lost", "failed", "killed"]);

export function taskStoreDir(cwd) {
	return path.join(cwd, ".omo", "senpi-task");
}

/** omo-task's project folder name: `<basename>-<sha256(realpath)[0..12]>` (omo-ai plugin omo-task.js). */
export function projectStoreName(cwd) {
	const resolved = path.resolve(cwd);
	let real = resolved;
	try {
		real = fs.realpathSync.native(resolved);
	} catch {
		real = resolved;
	}
	return `${path.basename(real).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"}-${crypto.createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
}

/** omo-task's own rule for one entry: anything but a plain (dot-less) folder is a record, or a folder holding one. */
function hasRecordEntries(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return error?.code !== "ENOENT" && error?.code !== "ENOTDIR";
	}
	return entries.some((entry) => !(entry.isDirectory() && !entry.name.includes(".")) || hasRecordEntries(path.join(dir, entry.name)));
}

/**
 * Where senpi's task tool keeps a session's tasks and workflow runs, by omo-task's own rule: `<cwd>/.omo/senpi-task` while
 * it holds records, else `<agentDir>/projects/<projectStoreName>/senpi-task`. The OMO/SENPI/PI_CODING_AGENT_DIR and
 * settings.state_dir overrides belong to the session process, which the daemon cannot see; a store it cannot find proves nothing.
 */
export function senpiTaskStoreDir(cwd, agentDir) {
	const local = taskStoreDir(path.resolve(cwd));
	const stat = statSafe(local);
	if (stat && (!stat.isDirectory() || hasRecordEntries(local))) return local;
	return path.join(agentDir, "projects", projectStoreName(cwd), "senpi-task");
}

/** D21: the session's senpi-task store; its workflow runs (`dag`, every file) are read only when asked for. */
export function readGoalStore(cwd, agentDir, reader = createTaskStoreReader()) {
	const storeDir = senpiTaskStoreDir(cwd, agentDir);
	const { exists, tasks, badRecords } = reader.read(cwd, storeDir);
	let dag;
	return {
		storeDir,
		tasksExist: exists,
		tasks,
		badRecords,
		get dag() {
			dag ??= reader.readRuns(storeDir);
			return dag;
		},
	};
}

/** Normalize one senpi-task record (F-5). Unknown fields are ignored. */
export function normalizeTask(raw, storeDir) {
	const spawnCwd = raw?.spawn_spec?.cwd;
	return {
		taskId: raw.task_id,
		status: raw.status,
		residency: raw.residency_state,
		parentSessionId: raw.parent_session_id,
		rootSessionId: raw.root_session_id,
		depth: raw.depth,
		executionMode: raw.execution_mode,
		backgroundMode: raw.background_mode,
		hostPid: Number.isFinite(raw.host_pid) ? raw.host_pid : undefined,
		// process-mode children run in their own senpi process; their tool shells are its children (R1-B2)
		pid: Number.isFinite(raw.pid) ? raw.pid : undefined,
		childSessionId: raw.child_session_id,
		createdAtMs: toMs(raw.created_at),
		startedAtMs: toMs(raw.started_at),
		updatedAtMs: toMs(raw.updated_at),
		terminalAtMs: toMs(raw.terminal_at),
		name: raw.name,
		summary: raw.task_summary ?? raw.description,
		description: raw.description,
		category: raw.category,
		model: raw.resolved_model ?? raw.model ?? raw.requested_model,
		owner: raw.owner?.kind === "dag" ? { runId: raw.owner.runId ?? null, nodeId: raw.owner.nodeId ?? null } : null,
		spawnCwd,
		errorMessage: raw.error_message,
		hasFinalResponse: typeof raw.final_response === "string" && raw.final_response.length > 0,
		storeDir,
		// task ids are time-based and can collide across project stores: identify by store + id
		uid: `${storeDir}|${raw.task_id}`,
		active: ACTIVE_TASK_STATUSES.has(raw.status),
		terminal: TERMINAL_TASK_STATUSES.has(raw.status),
	};
}

/** Locate the child session JSONL of a task (newest file wins when ids are missing). */
export function findChildSessionFile(storeDir, taskId, childSessionId) {
	const dir = path.join(storeDir, "children", taskId, "sessions", taskId);
	const files = listDirSafe(dir).filter((name) => name.endsWith(".jsonl"));
	if (!files.length) return undefined;
	if (childSessionId) {
		const exact = files.find((name) => name.endsWith(`_${childSessionId}.jsonl`));
		if (exact) return path.join(dir, exact);
	}
	let newest;
	let newestMs = -1;
	for (const name of files) {
		const stat = statSafe(path.join(dir, name));
		if (stat && stat.mtimeMs > newestMs) {
			newest = name;
			newestMs = stat.mtimeMs;
		}
	}
	return newest ? path.join(dir, newest) : undefined;
}

const RUN_EVENTS_TAIL_BYTES = 8192;
const runEventsCache = new Map();

/**
 * Last complete event line of `<storeDir>/dag/events/<runId>.jsonl`, read only from the tail and cached by
 * file path + mtime + size. A line without its trailing newline is still being written and is skipped.
 */
export function readRunEvents(storeDir, runId) {
	const file = path.join(storeDir, "dag", "events", `${runId}.jsonl`);
	const stat = statSafe(file);
	if (!stat) return {};
	const cached = runEventsCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.events;
	let events = {};
	try {
		const length = Math.min(stat.size, RUN_EVENTS_TAIL_BYTES);
		const start = stat.size - length;
		const fd = fs.openSync(file, "r");
		let text;
		try {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, start);
			text = buf.subarray(0, n).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
		// The tail may begin in the middle of a line; that fragment is not a complete line.
		if (start > 0) {
			const end = text.indexOf("\n");
			text = end >= 0 ? text.slice(end + 1) : "";
		}
		const lines = text.split("\n");
		lines.pop(); // the unterminated tail, empty when the file ends with a newline
		for (let i = lines.length - 1; i >= 0; i--) {
			let event;
			try {
				event = JSON.parse(lines[i]);
			} catch {
				continue;
			}
			if (!event || typeof event.at !== "string") continue;
			events = { lastEventAtMs: toMs(event.at), lastEventType: typeof event.type === "string" ? event.type : undefined };
			break;
		}
	} catch {
		events = {};
	}
	runEventsCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
	return events;
}

function normalizeRunNode(raw) {
	return {
		id: raw?.id,
		state: raw?.state,
		attempt: raw?.attempt,
		taskId: raw?.taskId,
		startedAtMs: toMs(raw?.startedAt),
		completedAtMs: toMs(raw?.completedAt),
		lastActivityAtMs: toMs(raw?.lastActivityAt),
	};
}

function normalizeRun(raw) {
	return {
		runId: raw.runId,
		name: raw.name,
		status: raw.status,
		rootSessionId: raw.rootSessionId,
		parentSessionId: raw.parentSessionId,
		createdAtMs: toMs(raw.createdAt),
		updatedAtMs: toMs(raw.updatedAt),
		completedAtMs: toMs(raw.completedAt),
		// omo 5.1.47+: a run the user stopped is `paused` with `pause: { reason: "user_stop" }` until resumed.
		pauseReason: typeof raw.pause?.reason === "string" ? raw.pause.reason : undefined,
		nodes: (Array.isArray(raw.nodes) ? raw.nodes : []).map(normalizeRunNode),
	};
}

/** mtime-cached reader for `<cwd>/.omo/senpi-task/tasks/*.json`. */
export function createTaskStoreReader() {
	const cache = new Map();
	const runCache = new Map();
	return {
		/** Every workflow run summary under `<storeDir>/dag/runs` (no cap), cached by mtime and size. */
		readRuns(storeDir) {
			const dir = path.join(storeDir, "dag", "runs");
			const runs = [];
			let badRuns = 0;
			for (const name of listDirSafe(dir).filter((entry) => entry.endsWith(".json"))) {
				const file = path.join(dir, name);
				const stat = statSafe(file);
				if (!stat) continue;
				let cached = runCache.get(file);
				if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
					let run;
					try {
						const raw = JSON.parse(fs.readFileSync(file, "utf8"));
						if (raw && typeof raw.runId === "string") run = normalizeRun(raw);
					} catch {
						run = undefined;
					}
					cached = { mtimeMs: stat.mtimeMs, size: stat.size, run };
					runCache.set(file, cached);
				}
				if (cached.run) runs.push(cached.run);
				else badRuns += 1;
			}
			return { exists: statSafe(dir)?.isDirectory() ?? false, runs, badRuns };
		},
		readRunEvents(storeDir, runId) {
			return readRunEvents(storeDir, runId);
		},
		read(cwd, storeDir = taskStoreDir(cwd)) {
			const tasksDir = path.join(storeDir, "tasks");
			const names = listDirSafe(tasksDir).filter((name) => name.endsWith(".json"));
			const tasks = [];
			let badRecords = 0;
			for (const name of names) {
				const file = path.join(tasksDir, name);
				const stat = statSafe(file);
				if (!stat) continue;
				const cached = cache.get(file);
				if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
					if (cached.task) tasks.push(cached.task);
					else badRecords += 1;
					continue;
				}
				let task;
				try {
					const raw = JSON.parse(fs.readFileSync(file, "utf8"));
					if (raw && typeof raw.task_id === "string") task = normalizeTask(raw, storeDir);
				} catch {
					task = undefined;
				}
				cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, task });
				if (task) tasks.push(task);
				else badRecords += 1;
			}
			return { cwd, storeDir, exists: statSafe(tasksDir)?.isDirectory() ?? false, tasks, badRecords };
		},
	};
}
