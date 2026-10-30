import { makeFinding } from "./finding.mjs";

/**
 * D6 provider health (plan todo 13, IS-10).
 *
 * provider_error log events carry sessionId and provider (senpi 2026.9.29), so the
 * provider and the affected sessions come straight from the events.
 */
export const id = "D6";

const LANE_DEFAULT = "anthropic-subscription";

/** Classify a provider error text. */
export function classifyProviderError(text) {
	const t = String(text ?? "");
	if (/provider is not configured/i.test(t)) return "not-configured";
	if (/all anthropic subscription accounts are blocked/i.test(t) || /all claude accounts[\s\S]*blocked/i.test(t)) return "blocked";
	if (/\b401\b/.test(t) && /revoked/i.test(t)) return "revoked";
	if (/usage limit/i.test(t)) return "usage-limit";
	return "other";
}

/** Provider named by an error text, if recoverable. */
export function providerOfError(text) {
	const t = String(text ?? "");
	const match = /provider is not configured:\s*([A-Za-z0-9._-]+)/i.exec(t);
	if (match) return match[1];
	const cls = classifyProviderError(t);
	if (cls === "blocked" || cls === "revoked") return LANE_DEFAULT;
	return undefined;
}

/**
 * Is this error text one senpi answers by parking the selector and retrying later (usage limit / quota / rate limit, or all
 * accounts blocked with a stated retry time)? Returns { cls, resetAtMs? } or undefined for errors that end the turn for good
 * (revoked login, not configured, context overflow, transient blips senpi retries within a minute).
 * `resetAtMs` is the provider's own "Soonest automatic retry: <iso>" time when the text carries one.
 */
export function retryWaitOf(text) {
	const t = String(text ?? "");
	if (/all (?:claude|anthropic)[\s\S]*accounts?[\s\S]*blocked/i.test(t) || /accounts for [\w.-]+ are currently blocked/i.test(t)) {
		const hint = /soonest automatic retry:\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(t);
		const resetAtMs = hint ? Date.parse(hint[1]) : NaN;
		return Number.isFinite(resetAtMs) ? { cls: "accounts-blocked", resetAtMs } : undefined;
	}
	if (/usage[- ]limit|quota|billing|credits[-_ ]required|credits are required|session limit|reached your .{0,40} limit/i.test(t)) return { cls: "usage-limit" };
	if (/rate[ _-]?limit|\b429\b|too many requests/i.test(t)) return { cls: "rate-limit" };
	return undefined;
}

const isOkTurn = (turn) => turn && turn.stopReason !== "error" && Number.isFinite(turn.ms);

/** Provider errors from logs, typed: [{ms, cls, provider, text}] sorted by ms. */
function logErrors(world) {
	return world.events
		.all("providerError")
		.map((event) => ({ ms: event.ms, cls: classifyProviderError(event.error), provider: event.provider, sessionId: event.sessionId, text: event.error }))
		.filter((e) => Number.isFinite(e.ms))
		.sort((a, b) => a.ms - b.ms);
}

/** provider -> {lastErrorMs, lastErrorClass, lastOkMs}. */
export function providerHealth(world) {
	const out = new Map();
	const entry = (provider) => {
		if (!out.has(provider)) out.set(provider, { lastErrorMs: undefined, lastErrorClass: undefined, lastOkMs: undefined });
		return out.get(provider);
	};
	const noteError = (provider, ms, cls) => {
		if (!provider || !Number.isFinite(ms)) return;
		const e = entry(provider);
		if (e.lastErrorMs === undefined || ms >= e.lastErrorMs) {
			e.lastErrorMs = ms;
			e.lastErrorClass = cls;
		}
	};
	for (const session of world.sessions.values()) {
		for (const turn of session.turns ?? []) {
			if (!turn.provider || !isOkTurn(turn)) continue;
			const e = entry(turn.provider);
			if (e.lastOkMs === undefined || turn.ms > e.lastOkMs) e.lastOkMs = turn.ms;
		}
		for (const err of session.errors ?? []) noteError(err.provider, err.ms, classifyProviderError(err.text));
	}
	for (const err of logErrors(world)) noteError(err.provider, err.ms, err.cls);
	return out;
}

/** First successful assistant turn on `provider` strictly after sinceMs. */
export function laneRecoveredAfter(world, provider, sinceMs) {
	let best;
	for (const session of world.sessions.values()) {
		for (const turn of session.turns ?? []) {
			if (!isOkTurn(turn) || turn.ms <= sinceMs) continue;
			if (provider && turn.provider !== provider) continue;
			if (best === undefined || turn.ms < best) best = turn.ms;
		}
	}
	return best;
}

/** Last successful assistant turn on `provider` strictly before beforeMs. */
export function lastOkBefore(world, provider, beforeMs) {
	let best;
	for (const session of world.sessions.values()) {
		for (const turn of session.turns ?? []) {
			if (!isOkTurn(turn) || turn.ms >= beforeMs) continue;
			if (provider && turn.provider !== provider) continue;
			if (best === undefined || turn.ms > best) best = turn.ms;
		}
	}
	return best;
}

/** Distinct session ids carried by the given error events, sorted. */
export function affectedSessions(errors) {
	return [...new Set(errors.map((e) => e.sessionId).filter(Boolean))].sort();
}

/**
 * Earliest window of `windowMs` holding >= `count` of the (sorted) errors.
 * Returns the incident (from the window's first error to the last error of
 * the same run) or undefined.
 */
function findBurst(errors, count, windowMs) {
	for (let i = 0; i + count - 1 < errors.length; i++) {
		if (errors[i + count - 1].ms - errors[i].ms <= windowMs) {
			// extend the run while errors keep arriving within windowMs of each other
			let j = i + count - 1;
			while (j + 1 < errors.length && errors[j + 1].ms - errors[j].ms <= windowMs) j += 1;
			return { first: errors[i], last: errors[j], items: errors.slice(i, j + 1) };
		}
	}
	return undefined;
}

/** Latest burst (the one that matters now). */
function latestBurst(errors, count, windowMs) {
	let found;
	let rest = errors;
	for (;;) {
		const burst = findBurst(rest, count, windowMs);
		if (!burst) return found;
		found = burst;
		rest = rest.slice(rest.indexOf(burst.last) + 1);
	}
}

function blockedFindings(world, errors, findings) {
	const blocked = errors.filter((e) => e.cls === "blocked");
	const accountBlocks = (world.secrets?.authBlocks ?? []).filter((a) => a && a.blockReason);
	const last = blocked.at(-1);
	const recoveredAt = last ? laneRecoveredAfter(world, LANE_DEFAULT, last.ms) : undefined;
	const logActive = last && recoveredAt === undefined;
	if (!logActive && accountBlocks.length === 0) return undefined;
	// the incident is every blocked error after the last successful lane turn
	const okBefore = logActive ? lastOkBefore(world, LANE_DEFAULT, last.ms) : undefined;
	const run = logActive ? blocked.filter((e) => okBefore === undefined || e.ms > okBefore) : [];
	const firstMs = run[0]?.ms;
	const data = {
		provider: LANE_DEFAULT,
		count: run.length,
		firstMs,
		lastMs: run.at(-1)?.ms,
		accounts: accountBlocks.map((a) => ({ name: a.name, blockReason: a.blockReason, blockedUntil: a.blockedUntil })),
		affectedSessions: affectedSessions(run),
	};
	findings.push(
		makeFinding({
			detector: id,
			kind: "accounts-blocked",
			severity: "crit",
			humanNeeded: true,
			subject: { key: `provider:${LANE_DEFAULT}` },
			evidence: [`blocked:${run.length}`, `accounts:${accountBlocks.length}`],
			titleKo: "Claude 계정이 모두 차단됨 - /login 필요",
			detailKo: `anthropic-subscription 계정이 모두 차단되어 Claude 레인이 멈췄습니다(오류 ${run.length}건, 차단 계정 ${accountBlocks.length}개). 사람이 /login으로 다시 로그인해야 합니다.`,
			data,
		}),
	);
	return firstMs ?? world.now;
}

function notConfiguredFindings(world, errors, findings) {
	const { burst, burstWindowMs } = world.config.provider;
	const byProvider = new Map();
	for (const err of errors) {
		if (err.cls !== "not-configured") continue;
		const key = err.provider ?? "unknown";
		if (!byProvider.has(key)) byProvider.set(key, []);
		byProvider.get(key).push(err);
	}
	const active = [];
	for (const [provider, list] of byProvider) {
		const incident = latestBurst(list, burst, burstWindowMs);
		if (!incident) continue;
		const recoveredAt = laneRecoveredAfter(world, provider === "unknown" ? undefined : provider, incident.last.ms);
		const data = {
			provider,
			count: incident.items.length,
			firstMs: incident.first.ms,
			lastMs: incident.last.ms,
			affectedSessions: affectedSessions(incident.items),
			...(recoveredAt !== undefined ? { recoveredAt } : {}),
		};
		findings.push(
			makeFinding({
				detector: id,
				kind: "not-configured-burst",
				severity: recoveredAt === undefined ? "crit" : "info",
				subject: { key: `provider:${provider}:${incident.first.ms}` },
				evidence: [`not-configured:${incident.items.length}`, `provider:${provider}`],
				titleKo: recoveredAt === undefined ? `공급자 설정 오류 폭발: ${provider}` : `공급자 설정 오류 회복됨: ${provider}`,
				detailKo: `"Provider is not configured" 오류가 ${Math.round(burstWindowMs / 1000)}초 안에 ${incident.items.length}건 발생했습니다. 영향받은 세션 ${data.affectedSessions.length}개.${recoveredAt === undefined ? "" : " 이후 같은 공급자로 정상 응답이 확인되었습니다."}`,
				data,
			}),
		);
		if (recoveredAt === undefined) active.push(incident.first.ms);
	}
	return active.length ? Math.min(...active) : undefined;
}

function usageStormFindings(world, findings) {
	const { stormCount, stormWindowMs } = world.config.provider;
	const since = world.now - stormWindowMs;
	const bySelector = new Map();
	const note = (selector, ms, what) => {
		if (!selector) return;
		if (!bySelector.has(selector)) bySelector.set(selector, { cooldowns: 0, fallbacks: 0, firstMs: ms, lastMs: ms });
		const s = bySelector.get(selector);
		s[what] += 1;
		s.firstMs = Math.min(s.firstMs, ms);
		s.lastMs = Math.max(s.lastMs, ms);
	};
	for (const e of world.events.since(since, "cooldown")) note(e.selector, e.ms, "cooldowns");
	for (const e of world.events.since(since, "fallback")) note(e.from, e.ms, "fallbacks");
	for (const [selector, s] of bySelector) {
		// cooldown_noted and fallback_applied come in pairs for one incident; count the larger side
		const count = Math.max(s.cooldowns, s.fallbacks);
		if (count < stormCount) continue;
		findings.push(
			makeFinding({
				detector: id,
				kind: "usage-limit-storm",
				severity: "warn",
				subject: { key: `selector:${selector}` },
				evidence: [`cooldown:${s.cooldowns}`, `fallback:${s.fallbacks}`],
				titleKo: `사용량 한도 폭풍: ${selector}`,
				detailKo: `${selector}에서 ${Math.round(stormWindowMs / 60_000)}분 안에 cooldown ${s.cooldowns}회, fallback ${s.fallbacks}회가 발생했습니다.`,
				data: { selector, count, cooldowns: s.cooldowns, fallbacks: s.fallbacks, firstMs: s.firstMs, lastMs: s.lastMs },
			}),
		);
	}
}

export function detect(world) {
	const findings = [];
	const errors = logErrors(world);
	const blockedSince = blockedFindings(world, errors, findings);
	const notConfiguredSince = notConfiguredFindings(world, errors, findings);
	usageStormFindings(world, findings);

	const starts = [blockedSince, notConfiguredSince].filter((ms) => ms !== undefined);
	if (starts.length) {
		const sinceMs = Math.min(...starts);
		const lastingMs = world.now - sinceMs;
		if (lastingMs > world.config.provider.outageHumanMs) {
			findings.push(
				makeFinding({
					detector: id,
					kind: "outage-human",
					severity: "crit",
					humanNeeded: true,
					subject: { key: "provider-outage" },
					evidence: [`lastingMs:${lastingMs}`],
					titleKo: `공급자 장애가 ${Math.round(lastingMs / 60_000)}분째 계속됨`,
					detailKo: "공급자 오류가 자동 복구 없이 계속되고 있습니다. 사람의 확인이 필요합니다.",
					data: { sinceMs, lastingMs },
				}),
			);
		}
	}
	return findings;
}
