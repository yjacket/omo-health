import { ProcessTable, respawnStorms } from "./collect/procs.mjs";
import { EventWindow } from "./collect/logs.mjs";

const SENPI_HOST_RE = /senpi[\\/]+dist[\\/]+bundle[\\/]+cli\.js/i;
const OMO_LAUNCHER_RE = /omo-ai[\\/]+bin[\\/]+omo\.js/i;

export function isSenpiHost(proc) {
	return /^(node|bun)(\.exe)?$/i.test(proc.name) && SENPI_HOST_RE.test(proc.cmd ?? "");
}

export function isOmoLauncher(proc) {
	return /^(node|bun)(\.exe)?$/i.test(proc.name) && OMO_LAUNCHER_RE.test(proc.cmd ?? "");
}

/**
 * Build the immutable per-tick snapshot every detector reads (plan todo 5).
 *
 * @param {object} input
 * @param {number} input.now
 * @param {object} input.config
 * @param {object} [input.paths]
 * @param {{sessions: Map, tasks: object[]}} input.registry   SessionRegistry.snapshot()
 * @param {ProcessTable} [input.procs]
 * @param {boolean} [input.procsFresh]
 * @param {object} [input.os]            normalizeOs() result
 * @param {object[]} [input.ports]      [{port, pid, address}] (only fetched when needed)
 * @param {EventWindow} [input.events]  rolling log events
 * @param {object[]} [input.newEvents]  events drained this tick
 * @param {Map} [input.sensors]         sessionId -> heartbeat
 * @param {object} [input.configState]
 * @param {object} [input.secrets]
 * @param {object} [input.versions]
 * @param {object} [input.self]         {pid, tickLagMs, workerRestarts, rssBytes, cpuFrac, workerPid, parse}
 * @param {Map} [input.attributed]      procKey -> {taskId, sessionId, toolCallId, role, sinceMs}
 * @param {Function} [input.intentFor]  ({session, call}) -> transcript intent | null
 */
export function buildWorld(input) {
	const now = input.now;
	const procs = input.procs ?? new ProcessTable([], now, undefined);
	const sessions = input.registry?.sessions ?? new Map();
	const tasks = input.registry?.tasks ?? [];
	const sensors = input.sensors ?? new Map();
	const staleMs = input.config?.daemonStaleMs ?? 45_000;

	const tasksById = new Map();
	for (const task of tasks) {
		if (task.uid) tasksById.set(task.uid, task);
		// a bare task id may be shared by two stores; keep the first (callers prefer session.task / uid)
		if (!tasksById.has(task.taskId)) tasksById.set(task.taskId, task);
	}

	const liveHostPids = new Set();
	for (const proc of procs.all()) if (isSenpiHost(proc)) liveHostPids.add(proc.pid);

	const children = new Map();
	for (const session of sessions.values()) {
		if (session.kind === "child" && session.taskId) {
			const task = session.task ?? tasksById.get(session.taskId);
			children.set(task?.uid ?? session.taskId, { task, session });
		}
	}

	const hosts = new Map();
	const addHost = (pid, sessionId) => {
		if (!Number.isFinite(pid)) return;
		if (!hosts.has(pid)) hosts.set(pid, { pid, alive: procs.isAlive(pid) || liveHostPids.has(pid), sessionIds: new Set() });
		if (sessionId) hosts.get(pid).sessionIds.add(sessionId);
	};
	for (const hb of sensors.values()) addHost(hb.pid, hb.sessionId);
	for (const session of sessions.values()) addHost(session.hostPid, session.id);
	for (const pid of liveHostPids) addHost(pid);

	const selfPid = input.self?.pid ?? process.pid;
	const protectedPids = new Set([selfPid]);
	for (const proc of procs.descendants(selfPid)) protectedPids.add(proc.pid);

	const world = {
		now,
		config: input.config,
		paths: input.paths,
		monitors: input.monitors ?? [],
		reflectionRuns: input.reflectionRuns ?? new Map(),
		/** D18: { heartbeats, crashRecords, liveMarkers } from src/collect/crashes.mjs; undefined in scans. */
		hostExits: input.hostExits,
		/** D20: park records from src/collect/parks.mjs (malformed files included); undefined in scans. */
		parkRecords: input.parkRecords,
		sessions,
		tasks,
		tasksById,
		children,
		procs,
		procsFresh: input.procsFresh ?? procs.size > 0,
		os: input.os,
		ports: input.ports,
		events: input.events ?? new EventWindow(),
		newEvents: input.newEvents ?? [],
		sensors,
		configState: input.configState ?? {},
		secrets: input.secrets ?? {},
		versions: input.versions ?? {},
		self: input.self ?? {},
		attributed: input.attributed ?? new Map(),
		hosts,
		liveHostPids,
		protectedPids,
		intentFor: input.intentFor ?? (() => null),
		/** (absPath) -> {size, mtimeMs, tail} | undefined ; engine-provided, cached, bounded reads. */
		fileProbe: input.fileProbe ?? (() => undefined),
		/** D21: (session) -> the session's terminal manifest (every runtimeKind) | undefined ; engine-provided, cached per tick. */
		terminalManifest: input.terminalManifest ?? (() => undefined),
		/** D21: (cwd) -> the senpi-task store senpi uses for that cwd (collect/tasks.mjs readGoalStore) | undefined ; engine-provided, cached per tick. */
		goalStore: input.goalStore ?? (() => undefined),
		/** 0.8.0: (session) -> the session's own live work (collect/work.mjs WorkView) | undefined ; engine-provided, cached per tick. */
		workOf: input.workOf ?? (() => undefined),
		/** 0.8.0 D23: the downtime record read at daemon start (collect/downtime.mjs) | undefined. */
		downtime: input.downtime,

		/** Fresh sensor heartbeat for a session, if any. */
		sensorFor(sessionId) {
			const hb = sensors.get(sessionId);
			return hb && now - (hb.ts ?? 0) <= staleMs ? hb : undefined;
		},

		/** Is the process that owns this session still running? */
		isSessionLive(session) {
			if (!session) return false;
			if (input.liveness === "history") {
				// Historical scan: no process data; a child counts as live while its task was running.
				if (session.kind === "main") return true;
				const task = session.task ?? tasksById.get(session.taskId);
				if (!task) return false;
				return (task.createdAtMs ?? 0) <= now && (task.terminalAtMs === undefined || task.terminalAtMs > now);
			}
			if (session.kind === "main") {
				if (world.sensorFor(session.id)) return true;
				return Number.isFinite(session.hostPid) && liveHostPids.has(session.hostPid);
			}
			const task = session.task ?? tasksById.get(session.taskId);
			if (!task) return false;
			const pid = task.executionMode === "process" && Number.isFinite(task.pid) ? task.pid : task.hostPid;
			if (!Number.isFinite(pid) || !liveHostPids.has(pid)) return false;
			// A PID reused by a senpi host started after the task is not that task's host.
			const started = task.createdAtMs ?? task.startedAtMs;
			const proc = procs.get(pid);
			if (proc && Number.isFinite(started) && proc.ctimeMs > started + 60_000) return false;
			return true;
		},

		/** PID whose direct children are this session's tool shells (R1-B2: process-mode children use task.pid). */
		shellParentPid(session) {
			if (!session) return undefined;
			if (session.kind === "child") {
				const task = session.task ?? tasksById.get(session.taskId);
				if (task?.executionMode === "process" && Number.isFinite(task.pid)) return task.pid;
				return task?.hostPid ?? session.hostPid;
			}
			return session.hostPid;
		},

		parentOf(session) {
			return session?.parentSessionId ? sessions.get(session.parentSessionId) : undefined;
		},

		/** Ports listening in the process tree rooted at pid (inclusive). */
		portsOfTree(pids) {
			if (!Array.isArray(input.ports)) return undefined;
			const set = new Set(pids);
			return input.ports.filter((row) => set.has(row.pid));
		},

		/** Programs being relaunched over and over right now (D17; memoized per tick). */
		respawnStorms() {
			if (world._respawnStorms === undefined) world._respawnStorms = procs.tracker ? respawnStorms(procs.tracker, procs, now, world.config.respawn) : (input.respawnStorms ?? []);
			return world._respawnStorms;
		},
	};
	return world;
}
