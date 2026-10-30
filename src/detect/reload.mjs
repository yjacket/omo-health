import { makeFinding } from "./finding.mjs";
import { deadChildIdleMs } from "./orphans.mjs";

/** D11: config reload deferred by the same subagent for too long (IS-11, F-9). */
export const id = "D11";

const STREAK_QUIET_MS = 5 * 60_000;

/** Log names are truncated ("Implement plan todo..."); drop the ellipsis to get a prefix. */
function namePrefix(name) {
	return String(name ?? "")
		.replace(/(\.\.\.|\u2026)\s*$/, "")
		.trim();
}

/**
 * The task a deferral named at `ms`: one that existed then and had not ended yet. A retried DAG node reuses the name,
 * so resolving by name alone handed the retry the old task's streak and reopened the cancelled task (#52).
 */
function taskResolver(world) {
	const candidates = new Map();
	return (name, ms) => {
		if (!candidates.has(name)) {
			const prefix = namePrefix(name);
			candidates.set(name, prefix ? world.tasks.filter((task) => task.taskId === prefix || [task.summary, task.description, task.name].some((value) => typeof value === "string" && value.trim().startsWith(prefix))) : []);
		}
		const alive = candidates.get(name).filter((task) => (task.createdAtMs ?? -Infinity) <= ms && ms <= (task.terminalAtMs ?? Infinity));
		return alive.find((task) => task.active) ?? alive[0];
	};
}

function childSessionOf(world, task) {
	return world.children.get(task.uid ?? task.taskId)?.session ?? (task.childSessionId ? world.sessions.get(task.childSessionId) : undefined);
}

/**
 * The D1/D8 cross-link: is the named blocker still advancing, or is it itself stuck?
 * N3 is a live resident worker that `reload_deferred` names throughout and must not be
 * read as a core bug. Neither verdict holds when the task resolves but has been silent
 * for a while without meeting D8's dead-child rule (e.g. a resident worker idle after `stop`).
 */
function corroborate(world, task) {
	if (!task) return { blockerLive: false, blockerStuck: true, stuckBy: "unresolved" };
	if (task.terminal) return { blockerLive: false, blockerStuck: true, stuckBy: "terminal" };
	// D8 task-host-gone: still "active" in the store, but the omo process that ran it is gone.
	if (task.active && world.procsFresh && Number.isFinite(task.hostPid) && !(world.liveHostPids.has(task.hostPid) || world.procs.isAlive(task.hostPid))) return { blockerLive: false, blockerStuck: true, stuckBy: "host-gone" };
	// Stuck is exactly D8's dead-child verdict (N3 stop-resident workers and D5 cases excluded).
	if (deadChildIdleMs(world, task) !== undefined) return { blockerLive: false, blockerStuck: true, stuckBy: "dead-child" };
	const child = childSessionOf(world, task);
	const lastMs = child?.lastActivityMs ?? child?.lastEntryMs;
	if (!task.active || !Number.isFinite(lastMs)) return { blockerLive: false, blockerStuck: false };
	const blockerIdleMs = world.now - lastMs;
	return { blockerLive: blockerIdleMs <= world.config.stall.noProgressMs, blockerStuck: false, blockerIdleMs };
}

export function detect(world, memory = {}) {
	const cfg = world.config.reload;
	const events = world.events
		.all()
		.filter((event) => event.type === "reloadDeferred" || event.type === "reloadCompleted")
		.sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
	const resolve = taskResolver(world);
	// Streaks are keyed by the task a name meant at each deferral (by name only when no task was alive then).
	const streaks = new Map();
	for (const event of events) {
		if (event.type === "reloadCompleted") {
			streaks.clear();
			continue;
		}
		const keys = new Set();
		for (const name of new Set(event.names ?? [])) {
			const task = resolve(name, event.ms);
			const key = task ? `task:${task.uid ?? task.taskId}` : `name:${name}`;
			keys.add(key);
			const streak = streaks.get(key);
			if (streak) {
				streak.lastMs = event.ms;
				streak.events += 1;
			} else streaks.set(key, { name, task, startMs: event.ms, lastMs: event.ms, events: 1 });
		}
		for (const key of [...streaks.keys()]) if (!keys.has(key)) streaks.delete(key);
	}
	memory.stuckSince ??= new Map();
	const reported = new Set();
	const out = [];
	for (const [key, { name, task, ...streak }] of streaks) {
		const durMs = streak.lastMs - streak.startMs;
		if (durMs < cfg.starvationMs) continue;
		// Deferrals are logged continuously while they last; a streak that went quiet is over.
		if (world.now - streak.lastMs > STREAK_QUIET_MS) continue;
		const minutes = Math.round(durMs / 60_000);
		const verdict = corroborate(world, task);
		const deferralsPerMin = streak.events / (durMs / 60_000);
		// A blocker stuck longer than the stall threshold is escalated to the parent, not only logged (#52). D8's
		// dead-child wake already reaches the parent for the same verdict, and an unresolved name has no parent.
		reported.add(key);
		if (verdict.blockerStuck && !memory.stuckSince.has(key)) memory.stuckSince.set(key, world.now);
		if (!verdict.blockerStuck) memory.stuckSince.delete(key);
		const stuckMs = verdict.blockerStuck ? world.now - memory.stuckSince.get(key) : 0;
		const escalate = stuckMs >= world.config.stall.quietMs && task?.parentSessionId && verdict.stuckBy !== "dead-child";
		out.push(
			makeFinding({
				detector: id,
				kind: "reload-starvation",
				subject: task ? { sessionId: task.parentSessionId, taskId: task.taskId, key: `reload:${task.taskId}` } : { key: `reload:${name}` },
				evidence: [`name:${name}`, `durMs:${durMs}`, `events:${streak.events}`, `blocker:${verdict.blockerLive ? "live" : verdict.blockerStuck ? "stuck" : "unknown"}`, `deferralsPerMin:${Math.round(deferralsPerMin)}`, ...(stuckMs ? [`stuckMs:${stuckMs}`] : [])],
				titleKo: `리로드 기아: 서브에이전트 때문에 설정 리로드가 ${minutes}분째 보류`,
				detailKo: `설정 리로드가 서브에이전트 "${name}" 때문에 ${minutes}분 동안 계속 보류되었습니다.${task ? ` 해당 작업은 ${task.taskId}(상태 ${task.status})이고 부모 세션은 ${task.parentSessionId}입니다.` : " 이름에 맞는 작업을 찾지 못했습니다."} 설정 변경이 적용되지 않은 상태입니다.${escalate ? ` 작업이 ${Math.round(stuckMs / 60_000)}분째 멈춰 있어 부모 세션에 알립니다.` : ""}`,
				data: { name, durMs, sinceMs: streak.startMs, lastMs: streak.lastMs, events: streak.events, deferralsPerMin, resolved: Boolean(task), taskId: task?.taskId, taskStatus: task?.status, ...verdict, stuckMs, ...(escalate ? { idleMs: stuckMs, remedy: { kind: "wake-parent", reason: "reload-starvation" } } : {}) },
			}),
		);
	}
	for (const key of [...memory.stuckSince.keys()]) if (!reported.has(key)) memory.stuckSince.delete(key);
	return out;
}
