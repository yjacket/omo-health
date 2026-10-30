import path from "node:path";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { createTaskStoreReader, findChildSessionFile, readRunEvents, senpiTaskStoreDir } from "./tasks.mjs";

const SETTLED_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function artifactsDir(file) {
	return file ? `${file.replace(/\.jsonl$/i, "")}-artifacts` : undefined;
}

/** Eval-cell logs of one session or child session: `eval-*.log` and `local/detached-eval-*.log`. */
function evalLogStats(file) {
	const dir = artifactsDir(file);
	if (!dir) return { dir: undefined, newestMtimeMs: undefined, count: 0 };
	let newestMtimeMs;
	let count = 0;
	for (const [scanDir, prefix] of [[dir, "eval-"], [path.join(dir, "local"), "detached-eval-"]]) {
		for (const name of listDirSafe(scanDir)) {
			if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
			const stat = statSafe(path.join(scanDir, name));
			if (!stat) continue;
			count += 1;
			if (newestMtimeMs === undefined || stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
		}
	}
	return { dir, newestMtimeMs, count };
}

function maxFinite(values) {
	let max;
	for (const value of values) if (Number.isFinite(value) && (max === undefined || value > max)) max = value;
	return max;
}

function countNodes(nodes) {
	const counts = { total: nodes.length, completed: 0, running: 0, pending: 0, ended: 0 };
	for (const node of nodes) {
		switch (node.state) {
			case "completed": counts.completed += 1; break;
			case "running":
			case "scheduled": counts.running += 1; break;
			case "pending":
			case "blocked": counts.pending += 1; break;
			case "failed":
			case "cancelled":
			case "skipped": counts.ended += 1; break;
			default: break;
		}
	}
	return counts;
}

/**
 * WorkView for one session: its own subagent tasks, its own DAG runs and its own eval-cell logs, all read
 * from senpi's store. Missing or half-written files read as empty data; unreadable stores are flagged.
 */
export function createWorkReader({ taskReader = createTaskStoreReader() } = {}) {
	const readEvents = typeof taskReader.readRunEvents === "function"
		? (storeDir, runId) => taskReader.readRunEvents(storeDir, runId)
		: readRunEvents;
	return {
		read({ session, agentDir }) {
			const evalLogs = evalLogStats(session?.file);
			const storeDir = session?.cwd && agentDir ? senpiTaskStoreDir(session.cwd, agentDir) : undefined;
			if (!storeDir) return { storeDir: undefined, storeReadable: false, runsReadable: false, tasks: [], runs: [], evalLogs };

			const store = taskReader.read(session.cwd, storeDir);
			const tasks = store.tasks
				.filter((task) => task.parentSessionId === session.id)
				.map((task) => {
					let childFile;
					let childMtimeMs;
					let artifactsMtimeMs;
					if (task.active) {
						childFile = findChildSessionFile(storeDir, task.taskId, task.childSessionId);
						if (childFile) {
							childMtimeMs = statSafe(childFile)?.mtimeMs;
							artifactsMtimeMs = evalLogStats(childFile).newestMtimeMs;
						}
					}
					return {
						taskId: task.taskId,
						uid: task.uid,
						name: task.name,
						summary: task.summary,
						status: task.status,
						active: task.active,
						terminal: task.terminal,
						residency: task.residency,
						createdAtMs: task.createdAtMs,
						updatedAtMs: task.updatedAtMs,
						terminalAtMs: task.terminalAtMs,
						hostPid: task.hostPid,
						pid: task.pid,
						childSessionId: task.childSessionId,
						owner: task.owner,
						childFile,
						childMtimeMs,
						artifactsMtimeMs,
						lastProgressMs: maxFinite([task.updatedAtMs, childMtimeMs, artifactsMtimeMs]),
					};
				});

			const dag = taskReader.readRuns(storeDir);
			const runs = dag.runs
				.filter((run) => run.parentSessionId === session.id || run.rootSessionId === session.id)
				.map((run) => {
					const settled = SETTLED_RUN_STATUSES.has(run.status);
					const events = settled ? {} : readEvents(storeDir, run.runId);
					const lastEventAtMs = settled ? (run.completedAtMs ?? run.updatedAtMs) : events.lastEventAtMs;
					const lastEventType = settled ? undefined : events.lastEventType;
					return {
						runId: run.runId,
						name: run.name,
						status: run.status,
						pauseReason: run.pauseReason,
						settled,
						parentSessionId: run.parentSessionId,
						rootSessionId: run.rootSessionId,
						createdAtMs: run.createdAtMs,
						updatedAtMs: run.updatedAtMs,
						lastEventAtMs,
						lastEventType,
						nodes: run.nodes,
						counts: countNodes(run.nodes),
						lastProgressMs: maxFinite([
							lastEventAtMs,
							...run.nodes.flatMap((node) => [node.lastActivityAtMs, node.startedAtMs, node.completedAtMs]),
						]),
					};
				});

			return {
				storeDir,
				storeReadable: Boolean(store.exists && store.badRecords === 0),
				runsReadable: Boolean(dag.exists && dag.badRuns === 0),
				tasks,
				runs,
				evalLogs,
			};
		},
	};
}
