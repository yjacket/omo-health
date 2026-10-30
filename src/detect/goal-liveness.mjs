import path from "node:path";
import { listDirSafe, readJsonSafe } from "../util/fsx.mjs";
import { workWakeSources } from "../util/wake-sources.mjs";
import { makeFinding } from "./finding.mjs";
import { runText, stuckRuns, taskText, trackTrees, treeText, workProgressMs } from "./goal-wait.mjs";
import { watcherMembers } from "./monitor-orphans.mjs";
import { deadChildIdleMs } from "./orphans.mjs";

export const id = "D21";

const DEFAULTS = { enabled: true, livenessMs: 3_570_000, graceMs: 120_000, minWakeGapMs: 3_570_000, quietMs: 30 * 60_000, foldGraceMs: 2 * 60_000 };
const KEEPALIVE_HOLD = "omo-keepalive";
/** Kinds of the wait sources a finding lists in data.sources (not finding kinds). */
const SOURCE_KIND = Object.freeze({ workflow: "workflow", task: "task", run: "run", monitor: "monitor" });

const TITLE_KO = {
	"leaked-monitor": "goal 세션이 끝난 monitor를 기다리고 있음",
	"leaked-task": "goal 세션이 존재하지 않는 서브에이전트를 기다리고 있음",
	"leaked-workflow": "goal 세션이 끝난 워크플로를 기다리고 있음",
	"unfolded-workflow": "goal 세션이 반영되지 않은 워크플로를 기다리고 있음",
	"stalled-workflow": "goal 세션이 진행하지 않는 워크플로를 기다리고 있음",
	"idle-monitor": "goal 세션이 멈춘 monitor를 기다리고 있음",
	"idle-background": "goal 세션이 멈춘 백그라운드 세션을 기다리고 있음",
	silent: "goal 세션이 오래 아무 진행이 없음",
};

const IDLE_REASONS = new Set(["idle-monitor", "idle-background"]);
const IDLE_QUESTION = "Is this wait still legitimate (the process works, or waits for something that will come) or will it never end by itself? progressing = leave it; stuck = name which source is blocked and why (mechanism) and what the session should do instead (avoid), e.g. read its output and stop it, or re-dispatch the work."
	+ " Answer with verdict stuck or progressing and cause unknown unless one of the listed causes fits; mechanism and avoid must each be at least 20 characters.";

/**
 * The session's terminal manifest (every runtimeKind), next to its session file or in any known session directory.
 * Called by the engine (world.terminalManifest), never by detect(): detectors do not touch the filesystem.
 */
export function readSessionTerminalManifest(paths, sessionId, sessionFile) {
	const dirs = [];
	if (typeof sessionFile === "string") dirs.push(path.dirname(sessionFile));
	if (paths?.sessionsDir) for (const name of listDirSafe(paths.sessionsDir)) dirs.push(path.join(paths.sessionsDir, name));
	for (const dir of dirs) {
		const manifest = readJsonSafe(path.join(dir, "extensions", "terminal", `${sessionId}.json`));
		if (manifest && Array.isArray(manifest.monitors)) return manifest;
	}
	return undefined;
}

/**
 * Only a manifest we could read can prove a leak. A file monitor (native watch) or any kind besides a command monitor
 * is alive by definition; a command monitor is alive while its launcher runs under its host.
 */
function monitorsLeaked(world, session) {
	if (!world.procsFresh) return false;
	const manifest = world.terminalManifest(session);
	if (!manifest || !Array.isArray(manifest.monitors)) return false;
	return manifest.monitors.every((monitor) => {
		if (monitor?.runtimeKind !== "command") return false;
		if (!monitor.runtime || typeof monitor.command !== "string") return false;
		return !watcherMembers(monitor, world.procs).live;
	});
}

/** omo-task's settled workflow states; any other state is a run the session still waits on. */
const DAG_DONE = new Set(["completed", "failed", "cancelled"]);

// Only the store senpi writes for this cwd can prove a leak, and only once it holds a record of this session: a missing
// store, an unreadable record, or a store with nothing of this session (not the one its work went to) proves nothing.
function tasksLeaked(world, session) {
	const store = session.cwd ? world.goalStore(session.cwd) : undefined;
	if (!store?.tasksExist || store.badRecords > 0) return false;
	const own = store.tasks.filter((task) => task.parentSessionId === session.id);
	return own.length > 0 && !own.some((task) => task.active);
}

function workflowsLeaked(world, session) {
	const dag = session.cwd ? world.goalStore(session.cwd)?.dag : undefined;
	if (!dag?.exists || dag.badRuns > 0) return false;
	const own = dag.runs.filter((run) => run.rootSessionId === session.id || run.parentSessionId === session.id);
	return own.length > 0 && !own.some((run) => typeof run.status !== "string" || !DAG_DONE.has(run.status));
}

const minutesOf = (ms) => Math.round(ms / 60_000);
const CLIP_CHARS = 600;
/** One evidence line, cut with a visible ellipsis only when it is long. */
const clip = (text) => {
	const value = String(text ?? "");
	return value.length > CLIP_CHARS ? `${value.slice(0, CLIP_CHARS - 1)}…` : value;
};
const timeOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown");

/** What a leaked wait still names: the ended command monitors, the session's ended tasks, or its settled runs. */
function leakedSources(world, session, reason) {
	if (reason === "leaked-monitor") {
		return (world.terminalManifest(session)?.monitors ?? []).filter((monitor) => monitor?.runtimeKind === "command").slice(0, 8).map((monitor) => ({
			kind: SOURCE_KIND.monitor,
			id: monitor.monitorId,
			name: monitor.description ?? monitor.command,
			state: "ended",
			text: clip(`monitor ${monitor.monitorId} ${String(monitor.command ?? "").slice(0, 120)}: its process ${monitor.runtime?.pid ?? "?"} is gone, so this monitor will never report.`),
		}));
	}
	const store = session.cwd ? world.goalStore(session.cwd) : undefined;
	if (reason === "leaked-task") {
		const endedAt = (task) => task.terminalAtMs ?? task.updatedAtMs ?? 0;
		return (store?.tasks ?? []).filter((task) => task.parentSessionId === session.id).sort((a, b) => endedAt(b) - endedAt(a)).slice(0, 3).map((task) => ({
			kind: SOURCE_KIND.task,
			id: task.taskId,
			name: task.name,
			state: task.status,
			text: clip(`task ${task.taskId} "${task.name ?? ""}" ${task.status} at ${timeOf(task.terminalAtMs ?? task.updatedAtMs)}; no task of this session is still running.`),
		}));
	}
	const runs = (store?.dag?.runs ?? []).filter((run) => run.rootSessionId === session.id || run.parentSessionId === session.id);
	return runs.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)).slice(0, 3).map((run) => ({
		kind: SOURCE_KIND.run,
		id: run.runId,
		name: run.name,
		state: run.status,
		text: clip(`workflow run ${run.runId} "${run.name ?? ""}" ${run.status} at ${timeOf(run.completedAtMs ?? run.updatedAtMs)}; no run of this session is still unsettled.`),
	}));
}

/** One source entry per workflow run that proves the chosen reason. */
function workflowSources(runs, reason, now) {
	return runs
		.filter((run) => run.reason === reason)
		.map((run) => ({
			kind: SOURCE_KIND.workflow,
			id: run.runId,
			name: run.name,
			state: run.status,
			idleMs: Number.isFinite(run.lastEventAtMs) ? now - run.lastEventAtMs : undefined,
			text: clip(runText(run, now)),
		}));
}

/** One source entry per idle monitor/background tree. */
function idleSources(trees, kind) {
	return trees
		.filter((tree) => tree.kind === kind)
		.map((tree) => ({
			kind: tree.kind,
			id: tree.id,
			name: tree.description ?? tree.command,
			state: "idle",
			idleMs: tree.idleMs,
			text: clip(treeText(tree)),
		}));
}

/**
 * The live work sources a silent wait names: its own tasks and runs when the store is readable, and the trees it waits on.
 * Non-work sources (ask-user, desk, ...) are never listed here.
 */
function silentSources(work, trees, wakeSources, now) {
	const declared = (name) => Number(wakeSources[name]) > 0;
	const out = [];
	if (declared("senpi-task")) {
		for (const task of work?.tasks ?? []) {
			if (!task?.active) continue;
			out.push({ kind: SOURCE_KIND.task, id: task.taskId, name: task.name, state: task.status, idleMs: Number.isFinite(task.lastProgressMs) ? now - task.lastProgressMs : undefined, text: clip(taskText(task, now)) });
		}
	}
	if (declared("omo-dag")) {
		for (const run of work?.runs ?? []) {
			if (run?.settled === true || DAG_DONE.has(run?.status)) continue;
			out.push({ kind: SOURCE_KIND.run, id: run.runId, name: run.name, state: run.status, idleMs: Number.isFinite(run.lastProgressMs) ? now - run.lastProgressMs : undefined, text: clip(runText({ ...run, reason: run.reason ?? "active" }, now)) });
		}
	}
	if (declared("terminal-monitors")) for (const tree of trees) if (tree.kind === "monitor" && tree.live) out.push({ kind: tree.kind, id: tree.id, name: tree.description ?? tree.command, state: "live", idleMs: tree.idleMs, text: clip(treeText(tree)) });
	if (declared("terminal-background-sessions")) for (const tree of trees) if (tree.kind === "background" && tree.live) out.push({ kind: tree.kind, id: tree.id, name: tree.description ?? tree.command, state: "live", idleMs: tree.idleMs, text: clip(treeText(tree)) });
	return out;
}

function detailFor(reason, focus) {
	if (reason === "unfolded-workflow") {
		const run = focus[0];
		const node = run?.unfolded?.[0];
		return `${TITLE_KO[reason]}. 워크플로 실행 ${run?.runId ?? "?"}의 노드 ${node?.nodeId ?? "?"}가 ${node?.state ?? "?"}인데 작업 ${node?.taskId ?? "?"}가 ${node?.taskStatus ?? "?"}입니다. 완료가 실행에 반영되지 않아 스스로 끝나지 않습니다.`;
	}
	if (reason === "stalled-workflow") {
		const run = focus[0];
		const waiting = run?.waiting?.length ? run.waiting.join(", ") : "?";
		return `${TITLE_KO[reason]}. 워크플로 실행 ${run?.runId ?? "?"}에 실행 중인 노드가 없고 ${waiting}가 기다립니다. 스케줄러가 실행을 진행하지 않습니다.`;
	}
	if (IDLE_REASONS.has(reason)) {
		const tree = focus[0];
		const pids = (tree?.members ?? []).map((member) => member.pid).filter(Number.isFinite);
		return `${TITLE_KO[reason]}. 프로세스 ${pids.length ? pids.join(", ") : "?"}가 ${minutesOf(tree?.idleMs ?? 0)}분째 아무 일도 하지 않습니다. 이 대기가 정당한지 먼저 analyst에게 묻고, 답에 따라 깨웁니다.`;
	}
	return `${TITLE_KO[reason]}. 이 세션에 확인을 요청하는 깨움 메시지를 한 번 보냅니다.`;
}

export function detect(world, memory = {}) {
	const config = { ...DEFAULTS, ...world.config.goalLiveness };
	if (!config.enabled || world.self?.mode === "history") return [];
	memory.first ??= {};
	memory.lastWake ??= {};
	memory.wakes ??= {};
	memory.trees ??= {};
	const seen = new Set();
	const evaluated = new Set();
	const out = [];
	for (const session of world.sessions.values()) {
		const anchor = session.anchor;
		if (session.kind !== "main" || anchor?.source !== "goal" || anchor.status !== "active") continue;
		const sensor = world.sensorFor(session.id);
		if (!sensor || sensor.idle !== true || session.pending?.size) continue;
		evaluated.add(session.id);
		const wakeSources = sensor.wakeSources && typeof sensor.wakeSources === "object" ? sensor.wakeSources : {};
		const total = Object.values(wakeSources).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
		const work = world.workOf(session);
		const workSources = workWakeSources(wakeSources);
		const trees = trackTrees({
			manifest: world.terminalManifest(session),
			procs: world.procs,
			procsFresh: world.procsFresh,
			now: world.now,
			memory: memory.trees,
			sessionId: session.id,
			cpuIdleFrac: world.config.stall.cpuIdleFrac,
		});
		const progress = workProgressMs(work, { sources: wakeSources, trees });
		const progressAgeMs = Number.isFinite(progress) ? world.now - progress : undefined;
		const freshProgress = workSources.length > 0 && progressAgeMs !== undefined && progressAgeMs < config.quietMs;
		const candidates = [];
		const leaks = total > 0 ? [
			["leaked-monitor", wakeSources["terminal-monitors"] > 0 && monitorsLeaked(world, session)],
			["leaked-task", wakeSources["senpi-task"] > 0 && tasksLeaked(world, session)],
			["leaked-workflow", wakeSources["omo-dag"] > 0 && workflowsLeaked(world, session)],
		] : [];
		for (const [reason, isLeaked] of leaks) {
			const key = `${session.id}:${reason}`;
			if (!isLeaked) continue;
			seen.add(key);
			memory.first[key] ??= world.now;
			if (world.now - memory.first[key] >= config.graceMs) candidates.push({ reason, sources: leakedSources(world, session, reason), focus: [] });
		}
		// A workflow can only prove a stuck wait when at least one live WORK source exists, whatever its name says.
		const stuck = workSources.length > 0 ? stuckRuns(work, session.id, world.now, config.foldGraceMs) : [];
		if (stuck.some((run) => run.reason === "unfolded-workflow")) {
			candidates.push({ reason: "unfolded-workflow", sources: workflowSources(stuck, "unfolded-workflow", world.now), focus: stuck.filter((run) => run.reason === "unfolded-workflow") });
		} else if (stuck.some((run) => run.reason === "stalled-workflow")) {
			candidates.push({ reason: "stalled-workflow", sources: workflowSources(stuck, "stalled-workflow", world.now), focus: stuck.filter((run) => run.reason === "stalled-workflow") });
		}
		// An idle tree only counts as its own wait while no other declared work source is still moving.
		const quietEvent = Number.isFinite(sensor.lastEventAt) && world.now - sensor.lastEventAt >= config.quietMs;
		const idleTree = (kind, sourceName) => quietEvent && wakeSources[sourceName] > 0 && !freshProgress
			? trees.find((tree) => tree.kind === kind && tree.live && (kind !== "monitor" || !tree.persistent) && tree.idleMs >= config.quietMs)
			: undefined;
		const idleMonitor = idleTree("monitor", "terminal-monitors");
		const idleBackground = idleMonitor ? undefined : idleTree("background", "terminal-background-sessions");
		if (idleMonitor) {
			const idleMonitors = trees.filter((tree) => tree.kind === "monitor" && tree.live && !tree.persistent && tree.idleMs >= config.quietMs);
			candidates.push({ reason: "idle-monitor", sources: idleSources(idleMonitors, "monitor"), focus: idleMonitors });
		} else if (idleBackground) {
			const idleBackgrounds = trees.filter((tree) => tree.kind === "background" && tree.live && tree.idleMs >= config.quietMs);
			candidates.push({ reason: "idle-background", sources: idleSources(idleBackgrounds, "background"), focus: idleBackgrounds });
		}
		const silentDue = sensor.goalLivenessSchema === 1 && Array.isArray(sensor.holds) && sensor.holds.includes(KEEPALIVE_HOLD)
			&& Number.isFinite(sensor.lastEventAt) && world.now - sensor.lastEventAt >= config.livenessMs;
		// A child D8 will wake the parent for is D8's case; fresh work progress wakes the session when it ends.
		const d8Owns = workSources.length > 0 && (work?.tasks ?? []).some((task) => task?.active && deadChildIdleMs(world, task) !== undefined);
		if (silentDue && !freshProgress && !d8Owns) {
			candidates.push({ reason: "silent", sources: silentSources(work, trees, wakeSources, world.now), focus: [] });
		}
		if (!candidates.length) continue;
		if (world.now - (memory.lastWake[session.id] ?? -Infinity) < config.minWakeGapMs) continue;
		const { reason, focus } = candidates[0];
		const isIdle = IDLE_REASONS.has(reason);
		const capped = candidates[0].sources.slice(0, 12);
		out.push(makeFinding({
			detector: id,
			kind: isIdle ? "goal-wait-idle" : "goal-wait-stuck",
			severity: isIdle ? "warn" : "info",
			// The wake count is part of the key: a later stuck wait after a delivered wake is a new incident with its own wake.
			subject: { sessionId: session.id, key: `${reason}:${memory.wakes[session.id] ?? 0}` },
			evidence: [
				`reason:${reason}`,
				`wakeSources:${Object.entries(wakeSources).map(([name, count]) => `${name}=${count}`).join(",")}`,
				...capped.map((source) => `source:${source.text}`),
			],
			titleKo: TITLE_KO[reason],
			detailKo: detailFor(reason, focus),
			data: {
				reason,
				sessionKind: "main",
				lastEventAt: sensor.lastEventAt,
				progressAgeMs,
				sources: capped,
				remedy: { kind: "goal-wake", reason },
				...(isIdle ? { question: IDLE_QUESTION } : {}),
			},
		}));
	}
	for (const key of Object.keys(memory.first)) if (!seen.has(key)) delete memory.first[key];
	const prefixes = [...evaluated].map((sessionId) => `${sessionId}:`);
	for (const key of Object.keys(memory.trees)) {
		if (!prefixes.some((prefix) => key.startsWith(prefix))) delete memory.trees[key];
	}
	return out;
}
