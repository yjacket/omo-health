import { watcherMembers } from "./monitor-orphans.mjs";

const RUN_SETTLED = new Set(["completed", "failed", "cancelled"]);
const RUN_DRIVABLE = new Set(["running", "paused", "pending"]);
const NODE_RUNNING = new Set(["running", "scheduled"]);
const NODE_WAITING = new Set(["pending", "blocked"]);

const finite = (value) => (Number.isFinite(value) ? value : undefined);

/**
 * Newest progress marker among the sources a sensor actually names. `sources` is the sensor's wakeSources,
 * `trees` the session's tracked monitors and background sessions. Undefined when no declared source is readable.
 */
export function workProgressMs(work, { sources, trees = [] } = {}) {
	const declared = (name) => Number(sources?.[name]) > 0;
	const marks = [];
	const add = (value) => {
		const ms = finite(value);
		if (ms !== undefined) marks.push(ms);
	};
	// An unreadable store or runs folder proves no progress: the wait keeps the plain hourly silent wake (IS-5).
	const tasksReadable = work?.storeReadable !== false;
	if (declared("senpi-task") && tasksReadable) {
		for (const task of work?.tasks ?? []) if (task?.active) add(task.lastProgressMs);
	}
	if (declared("omo-dag") && work?.runsReadable !== false) {
		for (const run of work?.runs ?? []) {
			if (run?.settled === true || RUN_SETTLED.has(run?.status)) continue;
			add(run.lastProgressMs);
			const running = new Set((run.nodes ?? []).filter((node) => NODE_RUNNING.has(node?.state)).map((node) => node.taskId).filter(Boolean));
			for (const task of tasksReadable ? (work?.tasks ?? []) : []) {
				if (task?.owner?.runId === run.runId || (task?.taskId && running.has(task.taskId))) add(task.lastProgressMs);
			}
		}
	}
	if (declared("terminal-monitors")) for (const tree of trees) if (tree?.kind === "monitor") add(tree.activeAtMs);
	if (declared("terminal-background-sessions")) for (const tree of trees) if (tree?.kind === "background") add(tree.activeAtMs);
	if (declared("senpi-codemode")) add(work?.evalLogs?.newestMtimeMs);
	return marks.length ? Math.max(...marks) : undefined;
}

/**
 * Runs this session waits on that can no longer finish on their own: a run node still running/scheduled whose
 * task already ended (the completion was never folded), or a drivable run with nothing running while nodes wait.
 * Returns [] unless both the task store and the workflow store were readable.
 */
export function stuckRuns(work, sessionId, now, foldGraceMs) {
	if (!work?.storeReadable || !work?.runsReadable) return [];
	const tasks = work.tasks ?? [];
	const cutoff = now - foldGraceMs;
	const out = [];
	for (const run of work.runs ?? []) {
		if (run?.parentSessionId !== sessionId) continue;
		if (run.settled === true || RUN_SETTLED.has(run.status)) continue;
		// Paused by the user's Stop (omo 5.1.47+): nothing runs until the user resumes it, by design.
		if (run.status === "paused" && run.pauseReason === "user_stop") continue;
		const nodes = run.nodes ?? [];
		const unfolded = [];
		for (const node of nodes) {
			if (!NODE_RUNNING.has(node?.state) || !node.taskId) continue;
			const task = tasks.find((item) => item?.taskId === node.taskId);
			if (!task?.terminal || !Number.isFinite(task.terminalAtMs) || task.terminalAtMs > cutoff) continue;
			unfolded.push({ nodeId: node.id, state: node.state, taskId: node.taskId, taskStatus: task.status, taskTerminalAtMs: task.terminalAtMs });
		}
		const waiting = nodes.filter((node) => NODE_WAITING.has(node?.state)).map((node) => node.id);
		let reason;
		if (unfolded.length) reason = "unfolded-workflow";
		else if (RUN_DRIVABLE.has(run.status)
			&& !nodes.some((node) => NODE_RUNNING.has(node?.state))
			&& waiting.length > 0
			&& Number.isFinite(run.lastEventAtMs)
			&& run.lastEventAtMs <= cutoff) reason = "stalled-workflow";
		if (!reason) continue;
		out.push({
			runId: run.runId,
			name: run.name,
			status: run.status,
			reason,
			counts: run.counts,
			lastEventAtMs: run.lastEventAtMs,
			unfolded: reason === "unfolded-workflow" ? unfolded : [],
			waiting,
		});
	}
	return out;
}

const clip = (text) => String(text ?? "").slice(0, 120);

/**
 * Monitors and background sessions of one session, with the last time each showed activity. Memory is keyed per
 * session and pruned to what this call saw. A tree is active when a fresh process table shows a live member using
 * CPU or writing bytes, or when its signature (members, fire count, checkpoint) changed.
 */
export function trackTrees({ manifest, procs, procsFresh, now, memory, sessionId, cpuIdleFrac }) {
	const out = [];
	const seen = new Set();
	const entries = [];
	for (const monitor of manifest?.monitors ?? []) {
		if (monitor?.runtimeKind === "command" && monitor.runtime) entries.push({ kind: "monitor", entry: monitor, id: monitor.monitorId, command: monitor.command, persistent: Boolean(monitor.persistent) });
	}
	for (const session of manifest?.backgroundSessions ?? []) {
		if (session?.runtime) entries.push({ kind: "background", entry: session, id: session.id, command: session.command, persistent: Boolean(session.persistent) });
	}
	for (const { kind, entry, id, command, persistent } of entries) {
		const { launcher, members, live } = watcherMembers({ runtimeKind: "command", runtime: entry.runtime, command }, procs);
		// Workers a background command spawns later are outside watcherMembers' launch window; a live tree owns
		// every identity-verified descendant of its launcher (and never a process born before that launcher).
		const tree = [...members];
		if (launcher) for (const proc of procs.descendants(launcher.pid)) {
			if (proc.ctimeMs >= launcher.ctimeMs && !tree.some((member) => member.pid === proc.pid)) tree.push(proc);
		}
		const key = `${sessionId}:${kind}:${entry.monitorId ?? entry.id}`;
		seen.add(key);
		const sig = JSON.stringify([tree.map((proc) => proc.pid).sort((a, b) => a - b), entry.fireWindow?.count ?? null, entry.lastCheckpoint ?? null]);
		memory[key] ??= { activeAtMs: now, sig };
		const active = procsFresh && live
			&& tree.some((proc) => procs.cpuFracs(proc, 1)[0] > cpuIdleFrac || procs.writeBytesDelta(proc, 1) > 0);
		if (active || memory[key].sig !== sig) memory[key].activeAtMs = now;
		memory[key].sig = sig;
		out.push({
			kind,
			id,
			description: entry.description,
			command,
			persistent,
			live,
			activeAtMs: memory[key].activeAtMs,
			idleMs: now - memory[key].activeAtMs,
			members: tree.map((proc) => ({ pid: proc.pid, ctime: proc.ctime, name: proc.name })),
		});
	}
	const prefix = `${sessionId}:`;
	for (const key of Object.keys(memory)) if (key.startsWith(prefix) && !seen.has(key)) delete memory[key];
	return out;
}

const iso = (ms) => new Date(ms).toISOString();
const minutes = (now, ms) => Math.round((now - ms) / 60_000);
const timePhrase = (now, ms) => (Number.isFinite(ms) ? `${iso(ms)} (${minutes(now, ms)} min ago)` : "unknown");

const ENDED_NODE = new Set(["completed", "failed", "cancelled", "skipped", "error"]);

/** English evidence line for one run returned by stuckRuns(), or for a live run (`reason: "active"`) a silent wake lists. */
export function runText(run, now) {
	const counts = run.counts ?? {};
	const head = `workflow run ${run.runId} "${run.name}" (${run.status}, ${counts.completed ?? 0}/${counts.total ?? 0} nodes done, last run event ${timePhrase(now, run.lastEventAtMs)})`;
	if (run.reason === "active") {
		const nodes = run.nodes ?? [];
		const list = (ids) => (ids.length ? ids.join(", ") : "none");
		const running = nodes.filter((node) => node.state === "running").map((node) => node.id);
		const queued = nodes.filter((node) => node.state !== "running" && !ENDED_NODE.has(node.state)).map((node) => node.id);
		return `${head}: running nodes: ${list(running)}; waiting nodes: ${list(queued)}.`;
	}
	const waiting = run.waiting?.length ? run.waiting.join(", ") : "none";
	if (run.reason === "unfolded-workflow") {
		const node = run.unfolded?.[0];
		if (!node) return `${head}: a node's task already ended but the run never took the result; waiting nodes: ${waiting}.`;
		return `${head}: node ${node.nodeId} is ${node.state} but its task ${node.taskId} ${node.taskStatus} at ${iso(node.taskTerminalAtMs)} - the completion was never folded into the run; waiting nodes: ${waiting}.`;
	}
	return `${head}: nothing is running or scheduled while ${waiting} wait - the run's scheduler is not driving it.`;
}

/** English evidence line for one idle tree returned by trackTrees(). */
export function treeText(tree) {
	const members = tree.members ?? [];
	const first = members[0];
	const pid = first?.pid ?? "?";
	const more = members.length - 1;
	const extra = more > 0 ? ` (with ${more} more)` : "";
	const mins = Math.round(tree.idleMs / 60_000);
	if (tree.kind === "background") return `background session ${tree.id} ${clip(tree.command)}: process ${pid}${extra} is alive but used no CPU and wrote nothing for ${mins} min.`;
	return `monitor ${tree.id} ${clip(tree.command)}: process ${pid}${extra} is alive but used no CPU, wrote nothing and fired nothing for ${mins} min; a command monitor reports only when its command exits.`;
}

/** English evidence line for one task returned by the WorkView. */
export function taskText(task, now) {
	return `task ${task.taskId} "${task.name}" ${task.status}, last progress ${timePhrase(now, task.lastProgressMs)}.`;
}
