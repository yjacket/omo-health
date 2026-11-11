import { makeFinding, RECENT_EVIDENCE_MS } from "./finding.mjs";

/**
 * D4: token anomalies (IS-11) - cache storm, hourly burn spike, full resend, context runaway: alert only.
 * Cache rewrites of a still-warm cache and a session's image load also tell the owner (toast) and the session (one notice).
 */
export const id = "D4";

const HOUR = 3_600_000;
/** Plan 4c: within the flatten's own session, the turn with the largest cacheWrite within +-30 s is the evidence turn. */
const RESEND_MATCH_MS = 30_000;

const contextOf = (turn) => (turn.input ?? 0) + (turn.cacheRead ?? 0) + (turn.cacheWrite ?? 0);
const tokensOf = (turn) => (turn.input ?? 0) + (turn.output ?? 0) + (turn.cacheRead ?? 0) + (turn.cacheWrite ?? 0);
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const MIB = 1024 * 1024;
const mib = (bytes) => round((bytes ?? 0) / MIB, 1);

const REMEDY_KO = "확인할 영역만 잘라 읽고, 레이아웃 확인은 절반 크기로 줄이고, 여러 화면은 4-6장씩 1568px 이하 한 장으로 붙여 읽고, 같은 스크린샷은 다시 읽지 마세요. 스크린샷이 40장을 넘는 작업은 서브에이전트를 나눠 새 세션에서 이어 가세요.";

/** Images in the context: `N장(이상), base64 X MiB`. */
function imageText(images, bytes, partial) {
	return `이미지 ${images ?? 0}장${partial ? " 이상" : ""}${bytes ? `, base64 ${mib(bytes)} MiB` : ""}`;
}

/** omo-keepalive's warm-up for the session (src/collect/warmup.mjs). */
function warmupText(warm) {
	if (!warm?.record) return "keepalive warm-up 기록 없음";
	if (warm.eligible) return "keepalive warm-up 켜짐";
	return `keepalive warm-up 꺼짐(${warm.disabledReason ?? "이유 없음"}${warm.disabledDetail ? `: ${warm.disabledDetail}` : ""})`;
}

function overTrim(turn, cfg) {
	return turn.imageBytes ? turn.imageBytes >= cfg.imageTrimBytes : (turn.images ?? 0) >= cfg.imageWarnCount;
}

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

/**
 * 4e: a storm-sized rewrite that starts within cacheWarmMs of the previous reply, while the cache should still be warm.
 * Unlike 4a these come one at a time (after a batch of screenshot reads), so 4a's two-in-a-row never sees them.
 */
function cacheRewrite(world, session, cfg) {
	const turns = session.turns ?? [];
	const hits = [];
	for (let i = 1; i < turns.length; i += 1) {
		const turn = turns[i];
		const prev = turns[i - 1];
		const gap = (turn.startMs ?? turn.ms) - prev.ms;
		if (!(gap >= 0 && gap <= cfg.cacheWarmMs)) continue;
		if (turn.cacheWrite >= cfg.cacheStormWrite && turn.cacheRead < cfg.cacheStormReadFrac * contextOf(prev)) hits.push(turn);
	}
	const last = hits.at(-1);
	if (!last || !(world.now - last.ms <= cfg.cacheRewriteWindowMs)) return [];
	const recent = hits.filter((turn) => last.ms - turn.ms <= cfg.cacheRewriteWindowMs);
	const images = overTrim(last, cfg);
	if (recent.length < cfg.cacheRewriteCount && !images) return [];
	const written = recent.reduce((sum, turn) => sum + turn.cacheWrite, 0);
	const totalCost = round(recent.reduce((sum, turn) => sum + (turn.cost ?? 0), 0));
	const warm = world.warmup(session.id);
	const load = imageText(last.images, last.imageBytes, session.imagesPartial);
	const cause = images
		? `이 세션에 쌓인 ${load}로 24 MiB를 넘었습니다. 요청 속 이미지 합이 24 MiB를 넘으면 가장 오래된 이미지가 잘려 나가 프롬프트가 바뀌므로, 이미지를 더 읽을 때마다 캐시 전체를 다시 씁니다.`
		: `이 세션에 쌓인 것은 ${load}입니다.`;
	return [
		makeFinding({
			detector: id,
			kind: "cache-rewrite",
			humanNeeded: true,
			subject: sessionSubject(session, "cache-rewrite"),
			evidence: [`rewrites:${recent.length}`, `cacheWrite:${last.cacheWrite}`, `cacheRead:${last.cacheRead}`, `images:${last.images ?? 0}`, `imageMiB:${mib(last.imageBytes)}`],
			titleKo: `캐시 재작성: ${cfg.cacheRewriteWindowMs / 60_000}분에 ${recent.length}번, ${round(written / 1e6, 1)}M 토큰`,
			detailKo: `세션 ${session.id}에서 캐시가 식기 전(직전 응답 뒤 ${cfg.cacheWarmMs / 60_000}분 안)에 캐시를 통째로 다시 쓴 요청이 최근 ${cfg.cacheRewriteWindowMs / 60_000}분에 ${recent.length}번, 합계 ${written}토큰(약 $${totalCost})입니다. ${cause} ${warmupText(warm)}.`,
			data: {
				rewrites: recent.length,
				startMs: recent[0].ms,
				atMs: last.ms,
				cacheWrite: last.cacheWrite,
				cacheRead: last.cacheRead,
				written,
				totalCost,
				images: last.images ?? 0,
				imageBytes: last.imageBytes ?? 0,
				imagesPartial: Boolean(session.imagesPartial),
				warmup: warm ?? null,
				provider: last.provider,
				model: last.model,
				remedy: { kind: "cache-notice" },
				advice: REMEDY_KO,
			},
		}),
	];
}

/** 4f: the images in a session's context near the size where they start rewriting the cache (or the count fallback). */
function imageLoad(session, cfg) {
	const bytes = session.imageBytes ?? 0;
	const images = session.images ?? 0;
	if (!(bytes ? bytes >= cfg.imageWarnBytes : images >= cfg.imageWarnCount)) return [];
	const over = bytes ? bytes >= cfg.imageTrimBytes : false;
	const load = imageText(images, bytes, session.imagesPartial);
	return [
		makeFinding({
			detector: id,
			kind: "image-load",
			humanNeeded: true,
			subject: sessionSubject(session, "image-load"),
			evidence: [`images:${images}`, `imageMiB:${mib(bytes)}`],
			titleKo: `이미지 누적: ${load}`,
			detailKo: over
				? `세션 ${session.id}의 컨텍스트에 ${load}가 쌓여 24 MiB를 넘었습니다. 이제 이미지를 더 읽을 때마다 가장 오래된 이미지가 잘려 나가 캐시 전체를 다시 씁니다.`
				: `세션 ${session.id}의 컨텍스트에 ${load}가 쌓였습니다. 이미지 합이 24 MiB를 넘으면 그때부터 이미지를 더 읽을 때마다 캐시 전체를 다시 씁니다.`,
			data: { images, imageBytes: bytes, imagesPartial: Boolean(session.imagesPartial), warnBytes: cfg.imageWarnBytes, trimBytes: cfg.imageTrimBytes, remedy: { kind: "cache-notice" }, advice: REMEDY_KO },
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
		out.push(...cacheStorm(session, cfg), ...cacheRewrite(world, session, cfg), ...imageLoad(session, cfg), ...(spike ? [spike] : []), ...contextRunaway(session, cfg));
	}
	for (const sessionId of Object.keys(memory.burn)) {
		if (!world.sessions.has(sessionId)) delete memory.burn[sessionId];
	}
	out.push(...fullResend(world, cfg));
	return out;
}
