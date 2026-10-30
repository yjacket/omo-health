import { makeFinding } from "./finding.mjs";

/**
 * D12 self health (plan todo 14).
 *
 * Engine-provided inputs relied on:
 *   world.self  { pid, startedMs, tickLagMs, workerRestartsLastHour, rssBytes, cpuFrac,
 *                 parse: [{ source, lines, bad, unknown, unknownNames: [], unknownCounts: {}, unknownFirstSeenMs: {} }] (last hour),
 *                 versions: { omoAi, senpi }, previousVersions: { omoAi, senpi } | undefined }
 *   world.self.analyst  analyst.health() { failing, holdOff, failures, last? } (absent when there is no analyst)
 *   world.config.selfBudget { rssBytes, cpuFrac }
 *   world.sensors Map sessionId -> heartbeat { sessionId, pid, ts, ... }
 *   world.liveHostPids  live senpi host pids
 */
export const id = "D12";

const PARSE_BAD_FRAC = 0.05;
const PARSE_MIN_LINES = 20;
const SESSION_BAD_MIN = 2;
const TICK_LAG_MS = 120_000;
const WORKER_RESTARTS = 3;
const SENSOR_MISSING_MS = 5 * 60_000;

function parseDrift(world) {
	const out = [];
	for (const p of world.self.parse ?? []) {
		const lines = Number(p.lines ?? 0);
		const bad = Number(p.bad ?? 0);
		if (lines >= PARSE_MIN_LINES && bad / lines > PARSE_BAD_FRAC) {
			const pct = Math.round((bad / lines) * 1000) / 10;
			out.push(
				makeFinding({
					detector: id,
					kind: "parse-drift",
					subject: { key: `parse:${p.source}` },
					evidence: [`source:${p.source}`, `bad:${bad}`, `lines:${lines}`],
					titleKo: `기록 해석 실패 증가: ${p.source} ${pct}%`,
					detailKo: `최근 1시간 ${p.source} 기록 ${lines}줄 중 ${bad}줄(${pct}%)을 해석하지 못했습니다. omo 기록 형식이 바뀌었을 수 있어 이 소스에 기댄 탐지는 신뢰도가 낮습니다.`,
					data: { source: p.source, lines, bad, unknown: p.unknown ?? 0, unknownNames: p.unknownNames ?? [], degraded: true },
				}),
			);
		}

		out.push(...unknownEvents(p));
	}
	return out;
}

/**
 * Unknown event names of one source. `p.unknown` counts only warn/error/level-less lines; a name seen solely at info
 * or debug level is "quiet": listed in status (own finding, `data.quiet`) but it neither files an incident nor counts.
 * Parse input without `unknownLoudNames` (older engines, fixtures) treats every name as loud.
 */
function unknownEvents(p) {
	const unknown = Number(p.unknown ?? 0);
	const names = [...(p.unknownNames ?? [])].sort();
	const counts = p.unknownCounts ?? {};
	const firstSeenMs = p.unknownFirstSeenMs ?? {};
	const seen = (name) => Number(counts[name] ?? 0) > 0;
	const loudSet = new Set(p.unknownLoudNames ?? []);
	let loud = [];
	let quiet = [];
	if (unknown > 0) {
		loud = p.unknownLoudNames && names.some((n) => loudSet.has(n)) ? names.filter((n) => loudSet.has(n)) : names;
		if (loud.length < names.length) quiet = names.filter((n) => !loudSet.has(n) && seen(n));
	} else if (p.unknownLoudNames) {
		quiet = names.filter(seen);
	}
	const out = [];
	for (const [group, quietGroup] of [[loud, false], [quiet, true]]) {
		if (!group.length) continue;
		const nameText = group.join(", ");
		const groupCounts = Object.fromEntries(group.filter((n) => Object.hasOwn(counts, n)).map((n) => [n, counts[n]]));
		const groupFirstSeen = Object.fromEntries(group.filter((n) => Object.hasOwn(firstSeenMs, n)).map((n) => [n, firstSeenMs[n]]));
		const total = quietGroup ? Object.values(groupCounts).reduce((sum, n) => sum + Number(n), 0) : unknown;
		out.push(
			makeFinding({
				detector: id,
				kind: "unknown-events",
				severity: "info",
				subject: { key: `unknown-events${quietGroup ? "-quiet" : ""}:${p.source}` },
				evidence: [`source:${p.source}`, `unknown:${total}`, `names:${nameText}`],
				titleKo: `모르는 omo 기록 이벤트: ${p.source} ${nameText}`,
				detailKo: quietGroup
					? `omo가 새 정보성 이벤트를 기록하기 시작했습니다(${nameText}). 경고나 오류가 아니라서 감시에는 영향이 없고 이슈도 등록하지 않습니다.`
					: `omo가 새 이벤트를 기록하기 시작했습니다(${nameText}). 기록은 정상적으로 읽히므로 감시는 온전합니다. omo-health가 스스로 이슈를 등록해 반영합니다.`,
				data: { source: p.source, names: group, counts: groupCounts, firstSeenMs: groupFirstSeen, degraded: false, ...(quietGroup ? { quiet: true } : {}) },
			}),
		);
	}
	return out;
}

/** Session JSONL lines that no longer parse: that session's view (pending calls, turns) is incomplete. */
function sessionParseDrift(world) {
	const out = [];
	for (const s of world.self.sessionParse ?? []) {
		const bad = Number(s.bad ?? 0);
		const total = Number(s.lines ?? 0) + bad;
		if (bad < SESSION_BAD_MIN || bad / total <= PARSE_BAD_FRAC) continue;
		const pct = Math.round((bad / total) * 1000) / 10;
		out.push(
			makeFinding({
				detector: id,
				kind: "session-parse-drift",
				subject: { sessionId: s.id, key: `session-parse:${s.id}` },
				evidence: [`bad:${bad}`, `lines:${total}`],
				titleKo: `세션 기록 형식 오류: ${bad}줄 해석 실패`,
				detailKo: `세션 ${s.id}의 기록 ${total}줄 중 ${bad}줄(${pct}%)을 JSON으로 읽지 못했습니다. 기록 형식이 바뀌었거나 파일이 손상되었을 수 있어 이 세션의 멈춤 감시는 불완전합니다.`,
				data: { sessionId: s.id, lines: total, bad, degraded: true },
			}),
		);
	}
	return out;
}

function versionChanged(world) {
	const cur = world.self.versions;
	const prev = world.self.previousVersions;
	if (!cur || !prev) return [];
	const changes = ["omoAi", "senpi"].filter((name) => prev[name] !== undefined && cur[name] !== undefined && prev[name] !== cur[name]).map((name) => ({ name, from: prev[name], to: cur[name] }));
	if (!changes.length) return [];
	const text = changes.map((c) => `${c.name} ${c.from} → ${c.to}`).join(", ");
	return [
		makeFinding({
			detector: id,
			kind: "version-changed",
			severity: "info",
			subject: { key: `versions:${changes.map((c) => `${c.name}=${c.to}`).join(",")}` },
			evidence: changes.map((c) => `${c.name}:${c.from}->${c.to}`),
			titleKo: `버전 변경 감지: ${text}`,
			detailKo: `${text}. 기록 형식이 달라졌을 수 있어 해석기 점검을 다시 합니다.`,
			data: { changes },
		}),
	];
}

function simple(world, kind, key, evidence, titleKo, detailKo, data) {
	return makeFinding({ detector: id, kind, subject: { key }, evidence, titleKo, detailKo, data });
}

function runtime(world) {
	const self = world.self;
	const budget = world.config.selfBudget;
	const out = [];
	if (Number(self.tickLagMs) > TICK_LAG_MS) {
		const s = Math.round(self.tickLagMs / 1000);
		out.push(simple(world, "tick-lag", "self:tick-lag", [`tickLagMs:${self.tickLagMs}`], `감시 주기 지연: ${s}초`, `감시기의 한 주기가 ${s}초 늦어졌습니다. 탐지와 조치가 그만큼 늦습니다.`, { tickLagMs: self.tickLagMs }));
	}
	if (Number(self.workerRestartsLastHour) > WORKER_RESTARTS) {
		const n = self.workerRestartsLastHour;
		out.push(simple(world, "worker-restarts", "self:worker-restarts", [`restarts:${n}`], `프로세스 수집기 재기동 ${n}회/시간`, `프로세스 수집 워커가 최근 1시간에 ${n}번 다시 시작되었습니다. 프로세스 정보가 끊겨 일부 탐지가 늦을 수 있습니다.`, { workerRestartsLastHour: n }));
	}
	const overRss = Number.isFinite(self.rssBytes) && self.rssBytes > budget.rssBytes;
	const overCpu = Number.isFinite(self.cpuFrac) && self.cpuFrac > budget.cpuFrac;
	if (overRss || overCpu) {
		const mb = Math.round((self.rssBytes ?? 0) / 1048576);
		const cpu = Math.round((self.cpuFrac ?? 0) * 1000) / 10;
		out.push(
			simple(
				world,
				"self-budget",
				"self:budget",
				[...(overRss ? [`rss:${mb}MB`] : []), ...(overCpu ? [`cpu:${cpu}%`] : [])],
				`감시기 자원 초과: 메모리 ${mb}MB, CPU ${cpu}%`,
				`omo-health 자신이 정해진 예산(메모리 ${Math.round(budget.rssBytes / 1048576)}MB, CPU ${budget.cpuFrac * 100}%)을 넘었습니다.`,
				{ rssBytes: self.rssBytes, cpuFrac: self.cpuFrac, overRss, overCpu },
			),
		);
	}
	return out;
}

/** The stall analyst failed repeatedly: until it recovers no stall is released on a model's word, and every look is retried later. */
function analystFailing(world) {
	const analyst = world.self.analyst;
	if (!analyst?.failing) return [];
	const last = analyst.last ?? {};
	return [
		makeFinding({
			detector: id,
			kind: "analyst-failing",
			subject: { key: "self:analyst" },
			evidence: [`failures:${analyst.failures}`, ...(last.error ? [`error:${last.error}`] : [])],
			titleKo: `멈춤 분석가 연속 실패: ${analyst.failures}회`,
			detailKo: `멈춤 분석가(omo -p)가 ${analyst.failures}번 연속 실패했습니다.${last.error ? ` 마지막 오류: ${last.error}.` : ""} 원인이 풀릴 때까지 분류되지 않는 멈춤은 아무것도 종료하지 않고 조사 목록에만 남으며, 분석가는 analyst.retryMs마다 한 번만 다시 시도합니다. omo 설치와 로그인, 레인 모델 설정을 확인하세요.`,
			data: { failures: analyst.failures, last },
		}),
	];
}

function sensorMissing(world) {
	const out = [];
	for (const pid of world.liveHostPids) {
		const proc = world.procs.get(pid);
		// a host that just started has not had time to write its first heartbeat
		if (proc && Number.isFinite(proc.ctimeMs) && proc.ctimeMs > 0 && world.now - proc.ctimeMs < SENSOR_MISSING_MS) continue;
		let fresh = false;
		for (const hb of world.sensors.values()) {
			if (hb.pid === pid && world.now - (hb.ts ?? 0) <= SENSOR_MISSING_MS) {
				fresh = true;
				break;
			}
		}
		if (fresh) continue;
		out.push(
			makeFinding({
				detector: id,
				kind: "sensor-missing",
				severity: "info",
				subject: { hostPid: pid, key: `sensor:${pid}` },
				evidence: [`hostPid:${pid}`],
				titleKo: `센서 미로드: omo 세션(pid ${pid})`,
				detailKo: `실행 중인 omo 세션(pid ${pid})에서 5분 넘게 센서 신호가 없습니다. 센서 미로드: 세션 재시작 또는 리로드 필요. 해당 omo 세션을 다시 시작하거나 /reload 하세요.`,
				data: { hostPid: pid },
			}),
		);
	}
	return out;
}

export function detect(world) {
	return [...parseDrift(world), ...sessionParseDrift(world), ...versionChanged(world), ...runtime(world), ...analystFailing(world), ...sensorMissing(world)];
}
