import { makeFinding, RECENT_EVIDENCE_MS } from "./finding.mjs";

/** D5: per-lane TPS collapse and hung child model turns (IS-11, plan todo 12). */
export const id = "D5";

/** Plan R1-B3: a cooldown/fallback in the last 5 minutes means "waiting for retry", not hung. */
const RETRY_QUIET_MS = 5 * 60_000;

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const tpsOf = (turn) => (Number.isFinite(turn.tps) ? turn.tps : turn.output / (turn.durMs / 1000));

function tpsCollapse(world) {
	const cfg = world.config.tps;
	const cutoff = world.now - RECENT_EVIDENCE_MS;
	const lanes = new Map();
	for (const session of world.sessions.values()) {
		// A child from a dead host is backlog from a newly visible store, not a current incident.
		if (session.kind === "child" && !world.isSessionLive(session)) continue;
		const byLane = new Map();
		for (const turn of session.turns ?? []) {
			if (!(turn.ms >= cutoff)) continue;
			if (!(turn.durMs > cfg.minDurMs && turn.output > cfg.minOutput)) continue;
			const lane = `${turn.provider ?? "?"}/${turn.model ?? "?"}`;
			if (!byLane.has(lane)) byLane.set(lane, { provider: turn.provider, model: turn.model, turns: [] });
			byLane.get(lane).turns.push(turn);
		}
		for (const [lane, entry] of byLane) {
			const recent = entry.turns.slice(-cfg.window);
			const medianTps = median(recent.map(tpsOf));
			const slowTurns = recent.filter((turn) => turn.durMs > cfg.slowTurnMs).length;
			if (!(medianTps < cfg.minTps && slowTurns >= cfg.slowTurns)) continue;
			if (!lanes.has(lane)) lanes.set(lane, { provider: entry.provider, model: entry.model, hits: [] });
			lanes.get(lane).hits.push({ sessionId: session.id, medianTps, slowTurns, turns: recent.length });
		}
	}
	const out = [];
	for (const [lane, { provider, model, hits }] of lanes) {
		const providerSide = hits.length >= 2;
		const worst = Math.min(...hits.map((hit) => hit.medianTps));
		const worstTps = Math.round(worst * 10) / 10;
		out.push(
			makeFinding({
				detector: id,
				kind: "tps-collapse",
				subject: { key: `lane:${lane}`, sessionId: providerSide ? undefined : hits[0].sessionId },
				evidence: [`lane:${lane}`, `medianTps:${worstTps}`, `sessions:${hits.length}`],
				titleKo: providerSide ? `응답 속도 저하(공급자 측): ${lane} ${worstTps} tok/s` : `응답 속도 저하: ${lane} ${worstTps} tok/s`,
				detailKo: `${lane} 레인의 최근 ${cfg.window}턴 중앙 속도가 ${cfg.minTps} tok/s 미만이고 ${cfg.slowTurnMs / 1000}초를 넘긴 턴이 ${cfg.slowTurns}개 이상입니다.${providerSide ? ` 세션 ${hits.length}개에서 동시에 나타나 공급자 쪽 문제로 보입니다.` : ""}`,
				data: {
					lane,
					provider,
					model,
					medianTps: worstTps,
					providerSide,
					sessionIds: hits.map((hit) => hit.sessionId),
					perSession: hits.map((hit) => ({ ...hit, medianTps: Math.round(hit.medianTps * 10) / 10 })),
				},
			}),
		);
	}
	return out;
}

function hungTurnChild(world) {
	const cfg = world.config.orphans;
	const retrying = world.events.since(world.now - RETRY_QUIET_MS).some((event) => event.type === "cooldown" || event.type === "fallback");
	if (retrying) return [];
	const out = [];
	for (const session of world.sessions.values()) {
		if (session.kind !== "child") continue;
		if (!world.isSessionLive(session)) continue;
		const role = session.lastMessage?.role;
		if (role !== "toolResult" && role !== "user") continue;
		if (session.pending?.size) continue;
		if (!Number.isFinite(session.lastEntryMs)) continue;
		const idleMs = world.now - session.lastEntryMs;
		if (idleMs < cfg.hungTurnMs) continue;
		const task = session.task ?? world.tasksById.get(session.taskId);
		if (!task?.active) continue;
		const minutes = Math.round(idleMs / 60_000);
		out.push(
			makeFinding({
				detector: id,
				kind: "hung-turn-child",
				subject: {
					sessionId: session.id,
					taskId: session.taskId ?? task.taskId,
					parentSessionId: session.parentSessionId ?? task.parentSessionId,
					hostPid: session.hostPid ?? task.hostPid,
					key: `hung@${session.lastEntryMs}`,
				},
				evidence: [`last:${role}`, `idleMs:${idleMs}`, `task:${task.status}`],
				titleKo: `서브에이전트 모델 응답 정지: ${minutes}분째 응답 없음`,
				detailKo: `서브에이전트 세션 ${session.id}(작업 ${task.taskId})의 마지막 기록이 ${role === "user" ? "사용자 메시지" : "도구 결과"}이고, 실행 중인 도구 없이 ${minutes}분 동안 모델 응답이 없습니다. 최근 5분 안에 재시도 대기(cooldown/fallback)도 없었습니다.`,
				data: { idleMs, lastRole: role, lastEntryMs: session.lastEntryMs, taskStatus: task.status, remedy: { kind: "wake-parent", reason: "hung-turn" } },
			}),
		);
	}
	return out;
}

export function detect(world) {
	return [...tpsCollapse(world), ...hungTurnChild(world)];
}
