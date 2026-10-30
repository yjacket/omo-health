import { makeFinding, RECENT_EVIDENCE_MS } from "./finding.mjs";

/** D4: token anomalies (IS-11) - cache storm, hourly burn spike, full resend, context runaway. Alert only. */
export const id = "D4";

const HOUR = 3_600_000;
/** Plan 4c: within the flatten's own session, the turn with the largest cacheWrite within +-30 s is the evidence turn. */
const RESEND_MATCH_MS = 30_000;

const contextOf = (turn) => (turn.input ?? 0) + (turn.cacheRead ?? 0) + (turn.cacheWrite ?? 0);
const tokensOf = (turn) => (turn.input ?? 0) + (turn.output ?? 0) + (turn.cacheRead ?? 0) + (turn.cacheWrite ?? 0);
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sessionSubject(session, key) {
	return { sessionId: session.id, taskId: session.taskId, parentSessionId: session.parentSessionId, key };
}

/** 4a: the latest run of >= 2 consecutive storm turns. */
function cacheStorm(session, cfg) {
	const turns = session.turns ?? [];
	let run = [];
	let best;
	let prevContext;
	for (let i = 1; i < turns.length; i += 1) {
		const turn = turns[i];
		const context = contextOf(turns[i - 1]);
		const storm = turn.cacheWrite >= cfg.cacheStormWrite && turn.cacheRead < cfg.cacheStormReadFrac * context;
		if (!storm) {
			run = [];
			continue;
		}
		if (!run.length) prevContext = context;
		run.push(turn);
		if (run.length >= 2) best = { turns: [...run], prevContext };
	}
	if (!best) return [];
	const stormTurns = best.turns;
	const totalCost = stormTurns.reduce((sum, turn) => sum + (turn.cost ?? 0), 0);
	const last = stormTurns.at(-1);
	const costPerTurn = round(totalCost / stormTurns.length);
	return [
		makeFinding({
			detector: id,
			kind: "cache-storm",
			subject: sessionSubject(session, `storm@${stormTurns[0].ms}`),
			evidence: [`cacheWrite:${last.cacheWrite}`, `cacheRead:${last.cacheRead}`, `turns:${stormTurns.length}`],
			titleKo: `캐시 폭풍: ${stormTurns.length}턴 연속 캐시 재작성 (턴당 약 $${costPerTurn})`,
			detailKo: `세션 ${session.id}에서 ${stormTurns.length}턴 연속으로 캐시를 ${cfg.cacheStormWrite}토큰 이상 새로 쓰면서 캐시 읽기는 직전 컨텍스트의 ${cfg.cacheStormReadFrac * 100}% 미만이었습니다. 캐시가 매 턴 무효화되고 있어 비용이 크게 늘어납니다. 추정 비용은 턴당 $${costPerTurn}, 합계 $${round(totalCost)}입니다.`,
			data: {
				turns: stormTurns.length,
				startMs: stormTurns[0].ms,
				atMs: stormTurns[1].ms,
				lastMs: last.ms,
				cacheWrite: last.cacheWrite,
				cacheRead: last.cacheRead,
				prevContext: best.prevContext,
				costPerTurn,
				totalCost: round(totalCost),
				provider: last.provider,
				model: last.model,
			},
		}),
	];
}

/** 4b: last-60-min token sum vs this session's earlier hourly buckets. */
function burnSpike(session, cfg, now) {
	let recent = 0;
	const buckets = new Map();
	for (const turn of session.turns ?? []) {
		if (!Number.isFinite(turn.ms) || turn.ms > now) continue;
		if (turn.ms > now - HOUR) recent += tokensOf(turn);
		else {
			const bucket = Math.floor((now - turn.ms) / HOUR);
			buckets.set(bucket, (buckets.get(bucket) ?? 0) + tokensOf(turn));
		}
	}
	if (buckets.size < 3) return null;
	const med = median([...buckets.values()]);
	if (!(recent > cfg.burnPerHour && recent > cfg.burnMultiple * med)) return null;
	return makeFinding({
		detector: id,
		kind: "burn-spike",
		subject: sessionSubject(session, "burn"),
		evidence: [`tokens1h:${recent}`, `median1h:${med}`],
		titleKo: `토큰 폭증: 최근 1시간 ${recent.toLocaleString("en-US")}토큰`,
		detailKo: `세션 ${session.id}가 최근 60분 동안 ${recent}토큰을 썼습니다. 한도 ${cfg.burnPerHour}을 넘었고, 이 세션의 이전 시간대 중앙값(${med})의 ${cfg.burnMultiple}배보다 많습니다.`,
		data: { tokensLastHour: recent, medianPerHour: med, multiple: med > 0 ? round(recent / med, 2) : null, earlierHours: buckets.size },
	});
}

/** 4c: continuity flatten with a huge resend count; attributed to the event's own sessionId (no sessionId -> no finding). */
function fullResend(world, cfg) {
	const bySubject = new Map();
	for (const event of world.events.all("continuity")) {
		if (event.kind !== "flatten" || !(Number(event.count) >= cfg.resendCount)) continue;
		if (!event.sessionId || !Number.isFinite(event.ms) || world.now - event.ms > RECENT_EVIDENCE_MS) continue;
		const session = world.sessions.get(event.sessionId) ?? { id: event.sessionId };
		let turn;
		for (const candidate of session.turns ?? []) {
			if (!Number.isFinite(candidate.ms) || Math.abs(candidate.ms - event.ms) > RESEND_MATCH_MS) continue;
			if (!turn || candidate.cacheWrite > turn.cacheWrite) turn = candidate;
		}
		const prev = bySubject.get(session.id);
		if (!prev || event.ms >= prev.event.ms) bySubject.set(session.id, { event, session, turn });
	}
	const out = [];
	for (const { event, session, turn } of bySubject.values()) {
		const count = Number(event.count);
		out.push(
			makeFinding({
				detector: id,
				kind: "full-resend",
				subject: sessionSubject(session),
				evidence: [`flatten:${count}`, `reason:${event.reason ?? ""}`],
				titleKo: `전체 재전송: 대화 ${count}개 메시지를 통째로 다시 보냄`,
				detailKo: `세션 ${session.id}에서 연속성 복구(flatten)로 메시지 ${count}개가 한꺼번에 재전송되었습니다(사유: ${event.reason ?? "알 수 없음"}).${turn ? ` 같은 시각 캐시 쓰기가 ${turn.cacheWrite}토큰이었습니다.` : ""}`,
				data: { count, reason: event.reason, eventMs: event.ms, turnMs: turn?.ms, cacheWrite: turn?.cacheWrite },
			}),
		);
	}
	return out;
}

/** 4d: context >= contextMax and growing >= contextGrowth per turn for contextTurns turns. */
function contextRunaway(session, cfg) {
	const turns = session.turns ?? [];
	let run = 0;
	let best;
	for (let i = 1; i < turns.length; i += 1) {
		const context = contextOf(turns[i]);
		const growth = context - contextOf(turns[i - 1]);
		if (context >= cfg.contextMax && growth >= cfg.contextGrowth) {
			run += 1;
			if (run >= cfg.contextTurns) best = { end: i, run };
		} else run = 0;
	}
	if (!best) return [];
	const first = turns[best.end - best.run + 1];
	const last = turns[best.end];
	const context = contextOf(last);
	const growthPerTurn = Math.round((context - contextOf(turns[best.end - best.run])) / best.run);
	return [
		makeFinding({
			detector: id,
			kind: "context-runaway",
			subject: sessionSubject(session, `runaway@${first.ms}`),
			evidence: [`context:${context}`, `growth:${growthPerTurn}`, `turns:${best.run}`],
			titleKo: `컨텍스트 폭주: ${context.toLocaleString("en-US")}토큰, 턴당 +${growthPerTurn.toLocaleString("en-US")}`,
			detailKo: `세션 ${session.id}의 컨텍스트가 ${cfg.contextMax}토큰을 넘은 상태에서 ${best.run}턴 연속 턴당 ${cfg.contextGrowth}토큰 이상 커졌습니다. 현재 ${context}토큰입니다. 큰 도구 출력이 계속 쌓이고 있는지 확인이 필요합니다.`,
			data: { context, growthPerTurn, turns: best.run, startMs: first.ms, atMs: last.ms },
		}),
	];
}

export function detect(world, memory = {}) {
	const cfg = world.config.tokens;
	memory.burn ??= {};
	const out = [];
	for (const session of world.sessions.values()) {
		let spike = burnSpike(session, cfg, world.now);
		if (spike) memory.burn[session.id] = { lastHitMs: world.now, finding: spike };
		else {
			const held = memory.burn[session.id];
			if (held && world.now - held.lastHitMs < cfg.burnHoldMs) spike = held.finding;
			else delete memory.burn[session.id];
		}
		out.push(...cacheStorm(session, cfg), ...(spike ? [spike] : []), ...contextRunaway(session, cfg));
	}
	for (const sessionId of Object.keys(memory.burn)) {
		if (!world.sessions.has(sessionId)) delete memory.burn[sessionId];
	}
	out.push(...fullResend(world, cfg));
	return out;
}
