import { procKey } from "../collect/procs.mjs";
import { truncate } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";

/**
 * D9 leftover processes (plan todo 14, IS-11). Report-only: never a remedy.
 *
 * Engine-provided inputs relied on:
 *   world.attributed  Map procKey("pid@ctime") -> { sessionId, taskId, toolCallId, sinceMs, role: "tool"|"detached-server" }
 *                     every process the engine ever tied to a tool call that is still alive
 *   world.config.leftovers.minAgeMs
 *   world.ports       [{ port, pid, address }] when fetched this tick, else undefined
 *
 * A process is a leftover when it is still alive (same pid AND ctime) and
 * either its task has been terminal for >= minAgeMs, or its session no longer
 * exists and it was attributed >= minAgeMs ago.
 */
export const id = "D9";

function ownerGoneSince(world, att) {
	const task = att.taskUid ? world.tasksById.get(att.taskUid) : att.taskId ? world.tasksById.get(att.taskId) : undefined;
	if (task?.terminal && Number.isFinite(task.terminalAtMs)) return { sinceMs: task.terminalAtMs, why: `task:${task.status}` };
	if (att.sessionId && !world.sessions.has(att.sessionId) && Number.isFinite(att.sinceMs)) return { sinceMs: att.sinceMs, why: "session-gone" };
	return undefined;
}

export function detect(world) {
	const minAgeMs = world.config.leftovers.minAgeMs;
	const out = [];
	for (const [key, att] of world.attributed ?? new Map()) {
		const pid = Number(String(key).split("@")[0]);
		const proc = world.procs.get(pid);
		if (!proc || procKey(proc) !== key) continue;
		const gone = ownerGoneSince(world, att);
		if (!gone) continue;
		const ageMs = world.now - gone.sinceMs;
		if (ageMs < minAgeMs) continue;
		const ports = Array.isArray(world.ports) ? world.ports.filter((row) => row.pid === pid).map((row) => row.port) : undefined;
		const killCommand = `taskkill /F /PID ${pid}`;
		const minutes = Math.round(ageMs / 60_000);
		out.push(
			makeFinding({
				detector: id,
				kind: "leftover-process",
				subject: { sessionId: att.sessionId, taskId: att.taskId, toolCallId: att.toolCallId, pids: [{ pid, ctime: proc.ctime }], key: `leftover:${key}` },
				evidence: [gone.why, `role:${att.role ?? "?"}`, ...(ports?.length ? [`ports:${ports.join(",")}`] : [])],
				titleKo: `남은 프로세스: ${proc.name} (pid ${pid})`,
				detailKo: `작업이 끝난 지 ${minutes}분이 지났지만 그 작업이 띄운 ${proc.name} (pid ${pid})가 아직 살아 있습니다${ports?.length ? `(포트 ${ports.join(", ")} 사용 중)` : ""}. 자동으로 끄지 않습니다. 필요 없으면 \`${killCommand}\`로 종료하세요.\n명령: ${truncate(proc.cmd ?? "", 300)}`,
				data: { pid, ctime: proc.ctime, name: proc.name, role: att.role, ageMs, killCommand, ports },
			}),
		);
	}
	return out;
}
