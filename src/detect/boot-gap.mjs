import { iso } from "../util/time.mjs";
import { makeFinding } from "./finding.mjs";

/**
 * D23 boot gap: after omo-health was down long enough for D18 not to resume anything, each main
 * session that comes back gets one notice about the subagents and workflow runs that were live
 * before the gap and show no progress since it returned.
 *
 * Engine-provided inputs relied on:
 *   world.config.bootGap  { enabled, settleMs, windowMs }
 *   world.downtime        { kind: reboot|daemon-down, downSinceMs, upAtMs, bootMs }
 *   world.workOf(session) WorkView { storeReadable, tasks, runs }
 *   world.sensorFor(id)   fresh sensor heartbeat; world.procs ctimeMs tells a new host from a reused pid
 *
 * Memory (persisted by the engine): firstLive (when a session was first seen live after the gap)
 * and noticed (the engine sets it when the notice is delivered).
 */
export const id = "D23";

const GAP_KINDS = new Set(["reboot", "daemon-down"]);
const MAX_EVIDENCE = 20;

/** A task host is gone when it never had a pid, is absent from the table, or its pid was reused after the gap. */
function hostGone(procs, hostPid, downSinceMs) {
	if (!Number.isFinite(hostPid)) return true;
	const proc = procs.get(hostPid);
	if (!proc) return true;
	return Number.isFinite(proc.ctimeMs) && proc.ctimeMs > downSinceMs;
}

/** Work last updated before the gap's recent window is ancient history, not work the downtime cut off. */
function freshEnough(lastProgressMs, downSinceMs, recentMs) {
	return Number.isFinite(lastProgressMs) && lastProgressMs >= downSinceMs - recentMs;
}

function taskEvidence(task) {
	return `task:${task.taskId}:${task.status}:host=${Number.isFinite(task.hostPid) ? task.hostPid : "none"}`;
}

function runEvidence(run) {
	const counts = run.counts ?? {};
	return `run:${run.runId}:${run.status}:${counts.completed ?? 0}/${counts.total ?? 0}`;
}

function lostTasks(work, downSinceMs, upAtMs, procs, recentMs) {
	return work.tasks.filter(
		(task) =>
			task.active &&
			Number.isFinite(task.createdAtMs) &&
			task.createdAtMs < downSinceMs &&
			freshEnough(task.lastProgressMs, downSinceMs, recentMs) &&
			!(task.lastProgressMs >= upAtMs) &&
			hostGone(procs, task.hostPid, downSinceMs),
	);
}

function lostRuns(work, sessionId, downSinceMs, upAtMs, recentMs) {
	return work.runs.filter(
		(run) =>
			!run.settled &&
			run.parentSessionId === sessionId &&
			Number.isFinite(run.createdAtMs) &&
			run.createdAtMs < downSinceMs &&
			freshEnough(run.lastProgressMs, downSinceMs, recentMs) &&
			!(run.lastProgressMs >= upAtMs),
	);
}

function prune(memory, downSinceMs) {
	const suffix = `@${downSinceMs}`;
	for (const bucket of [memory.firstLive, memory.noticed]) {
		for (const key of Object.keys(bucket)) if (!key.endsWith(suffix)) delete bucket[key];
	}
}

export function detect(world, memory = {}) {
	const cfg = world.config?.bootGap;
	const gap = world.downtime;
	if (
		!cfg?.enabled ||
		world.self?.mode === "history" ||
		!gap ||
		!GAP_KINDS.has(gap.kind) ||
		!(world.now - gap.upAtMs <= cfg.windowMs) ||
		!world.procsFresh
	) {
		return [];
	}
	memory.firstLive ??= {};
	memory.noticed ??= {};
	prune(memory, gap.downSinceMs);

	const out = [];
	for (const session of world.sessions.values()) {
		if (session.kind !== "main" || !session.cwd) continue;
		const sensor = world.sensorFor(session.id);
		if (!sensor) continue;
		const host = world.procs.get(sensor.pid);
		// The session must have come back on a host started after the gap; an older host never went down.
		if (!host || !(host.ctimeMs > gap.downSinceMs)) continue;
		const key = `${session.id}@${gap.downSinceMs}`;
		if (memory.noticed[key]) continue;
		memory.firstLive[key] ??= world.now;
		if (world.now - memory.firstLive[key] < cfg.settleMs) continue;

		const work = world.workOf(session);
		if (!work?.storeReadable) continue;
		const recentMs = world.config?.sessions?.recentMs ?? 6 * 60 * 60_000;
		const tasks = lostTasks(work, gap.downSinceMs, gap.upAtMs, world.procs, recentMs);
		const runs = lostRuns(work, session.id, gap.downSinceMs, gap.upAtMs, recentMs);
		if (tasks.length === 0 && runs.length === 0) continue;

		const anchor = session.anchor;
		const evidence = [
			`gap:${gap.kind}:${iso(gap.downSinceMs)}..${iso(gap.upAtMs)}`,
			...tasks.map(taskEvidence),
			...runs.map(runEvidence),
		].slice(0, MAX_EVIDENCE);
		out.push(
			makeFinding({
				detector: id,
				kind: "work-lost",
				severity: "info",
				subject: { sessionId: session.id, key: `gap:${gap.downSinceMs}` },
				evidence,
				titleKo: `중단 전 작업이 이어지지 않음: 서브에이전트 ${tasks.length}개, 워크플로 ${runs.length}개`,
				detailKo: `omo-health가 ${iso(gap.downSinceMs)}부터 ${iso(gap.upAtMs)}까지 중단된 동안 멈춘 작업이 남아 있어 이 세션에 한 번만 알립니다.`,
				data: {
					gap: { kind: gap.kind, downSinceMs: gap.downSinceMs, upAtMs: gap.upAtMs, bootMs: gap.bootMs },
					goalActive: anchor?.source === "goal" && anchor?.status === "active",
					idle: sensor.idle === true,
					tasks: tasks.map((task) => ({
						taskId: task.taskId,
						name: task.name,
						status: task.status,
						createdAtMs: task.createdAtMs,
						lastProgressMs: task.lastProgressMs,
						hostPid: task.hostPid,
					})),
					runs: runs.map((run) => ({
						runId: run.runId,
						name: run.name,
						status: run.status,
						lastEventAtMs: run.lastEventAtMs,
						counts: run.counts,
						nodes: (run.nodes ?? []).map((node) => ({ id: node.id, state: node.state, attempt: node.attempt, taskId: node.taskId })),
					})),
					remedy: { kind: "boot-notice" },
				},
			}),
		);
	}
	return out;
}
