import path from "node:path";
import { pathKey } from "../paths.mjs";
import { makeFinding } from "./finding.mjs";
import { classifyProviderError, lastOkBefore, providerOfError } from "./provider.mjs";

/**
 * D7 settings/config lint + auto-revert decision (plan todo 13, IS-10a, D-11).
 * Pure: reads world.configState (src/collect/config-files.mjs) and acts only
 * through data.remedy = {kind:"revert-settings", fromSha1, toSha1}.
 */
export const id = "D7";

const WRITER_WINDOW_MS = 15_000;
/** NTFS mtime is sub-millisecond and runs up to ~1 ms ahead of Date.now(); log timestamps are whole milliseconds. */
const CLOCK_SLACK_MS = 2;

/** Settings change time: tracker's changedAtMs, else the latest change_detected naming the file. */
function settingsChangedAt(world, settings) {
	if (Number.isFinite(settings.changedAtMs)) return settings.changedAtMs;
	const key = pathKey(settings.file ?? world.paths?.settingsFile ?? "settings.json");
	const hits = world.events.all("change").filter((e) => (e.paths ?? []).some((p) => pathKey(p) === key));
	return hits.at(-1)?.ms;
}

/** Session tool call that wrote the settings file within +-15 s of changedAtMs. */
export function findWriter(world, file, changedAtMs) {
	if (!file || !Number.isFinite(changedAtMs)) return undefined;
	const key = pathKey(file);
	const tailKey = [path.basename(path.dirname(file)), path.basename(file)].join("/").toLowerCase();
	let best;
	const consider = (session, item) => {
		const dist = Math.abs(item.ms - changedAtMs);
		if (dist > WRITER_WINDOW_MS) return;
		if (!best || dist < best.dist) best = { dist, sessionId: session.id, toolCallId: item.id, tool: item.tool, ms: item.ms };
	};
	for (const session of world.sessions.values()) {
		for (const w of session.writes ?? []) {
			if (Number.isFinite(w.ms) && pathKey(w.path) === key) consider(session, w);
		}
		for (const c of session.commands ?? []) {
			if (!Number.isFinite(c.ms)) continue;
			const text = String(c.text ?? "").replace(/\\+/g, "/").toLowerCase();
			if (text.includes(tailKey)) consider(session, c);
		}
	}
	return best ? { sessionId: best.sessionId, toolCallId: best.toolCallId, tool: best.tool } : undefined;
}

function notConfiguredAfter(world, fromMs, toMs) {
	const logs = world.events
		.all("providerError")
		.filter((e) => e.ms >= fromMs && e.ms <= toMs && classifyProviderError(e.error) === "not-configured")
		.map((e) => ({ ms: e.ms, text: e.error }));
	const fromSessions = [];
	for (const session of world.sessions.values()) {
		for (const e of session.errors ?? []) if (e.ms >= fromMs && e.ms <= toMs && classifyProviderError(e.text) === "not-configured") fromSessions.push({ ms: e.ms, text: e.text });
	}
	return logs.length >= fromSessions.length ? logs : fromSessions;
}

/**
 * IS-10a decision. Returns {remedy} or {skipped} (plus context), or undefined
 * when there is no not-configured burst after the change (nothing to decide).
 */
export function revertDecision(world, configState) {
	const settings = configState.settings;
	if (!settings?.exists || !settings.sha1) return undefined;
	const changedAtMs = settingsChangedAt(world, settings);
	if (!Number.isFinite(changedAtMs)) return undefined;
	const cfg = world.config.config;
	const errors = notConfiguredAfter(world, changedAtMs - CLOCK_SLACK_MS, changedAtMs + cfg.revertErrorWindowMs);
	if (errors.length < world.config.provider.burst) return undefined;

	const provider = providerOfError(errors[0].text);
	const base = { changedAtMs, provider, errorCount: errors.length, firstErrorMs: errors[0].ms };
	const lastRevert = configState.lastRevert;
	const lkg = configState.lkg;
	const lastOk = lastOkBefore(world, provider, changedAtMs);

	let skipped;
	if (cfg.autoRevert === false) skipped = "disabled";
	else if (lastOk === undefined || changedAtMs - lastOk > cfg.laneOkLookbackMs) skipped = "lane-not-ok-before-change";
	else if (!lkg?.sha1) skipped = "no-lkg";
	else if (lkg.sha1 === settings.sha1) skipped = "lkg-same";
	else if (lastRevert && lastRevert.toSha1 === settings.sha1) skipped = "is-revert";
	else if (lastRevert && world.now - lastRevert.atMs < cfg.revertCooldownMs) skipped = "cooldown";

	if (skipped) return { ...base, lastOkMs: lastOk, skipped };
	return { ...base, lastOkMs: lastOk, remedy: { kind: "revert-settings", fromSha1: settings.sha1, toSha1: lkg.sha1 } };
}

export function detect(world) {
	const findings = [];
	const cs = world.configState ?? {};
	const settings = cs.settings;
	const changedAtMs = settings?.exists ? settingsChangedAt(world, settings) : undefined;
	const writer = settings?.exists ? findWriter(world, settings.file ?? world.paths?.settingsFile, changedAtMs) : undefined;
	// Historical scan: the change time comes from the logs; the file's content back then is unknown.
	const key = settings?.historical ? `settings:history@${changedAtMs}` : `settings:${settings?.sha1 ?? "none"}`;
	const common = { sha1: settings?.sha1, changedAtMs, ...(writer ? { writer } : {}) };

	if (settings?.exists && !settings.historical) {
		if (settings.parseError) {
			findings.push(
				makeFinding({
					detector: id,
					kind: "settings-parse-error",
					severity: "crit",
					subject: { key },
					evidence: ["lint:L1"],
					titleKo: "settings.json 파싱 실패",
					detailKo: `settings.json을 JSON으로 읽을 수 없습니다: ${settings.parseError}`,
					data: { ...common, lint: "L1", parseError: settings.parseError },
				}),
			);
		} else {
			const asp = settings.parsed?.anthropicSubscriptionProvider;
			const ambient = asp?.tokenInjection === "ambient";
			const enabled = asp?.enabled === true;
			if (ambient && !enabled) {
				findings.push(
					makeFinding({
						detector: id,
						kind: "ambient-not-enabled",
						severity: "crit",
						subject: { key },
						evidence: ["lint:L2"],
						titleKo: "ambient 토큰 주입이 켜져 있지 않음",
						detailKo: 'anthropicSubscriptionProvider.tokenInjection이 "ambient"인데 enabled가 true가 아닙니다. 이 상태면 anthropic-subscription 공급자가 "Provider is not configured"로 실패합니다.',
						data: { ...common, lint: "L2" },
					}),
				);
			}
		}
	}

	if (cs.omoJsonc?.exists && cs.omoJsonc.parseError) {
		findings.push(
			makeFinding({
				detector: id,
				kind: "omo-jsonc-parse-error",
				severity: "warn",
				subject: { key: `omo-jsonc:${cs.omoJsonc.sha1 ?? "none"}` },
				evidence: ["lint:L4"],
				titleKo: "omo.jsonc 파싱 실패",
				detailKo: `omo.jsonc를 읽을 수 없습니다(자동 수정하지 않음): ${cs.omoJsonc.parseError}`,
				data: { lint: "L4", sha1: cs.omoJsonc.sha1, parseError: cs.omoJsonc.parseError },
			}),
		);
	}

	const decision = revertDecision(world, cs);
	if (decision) {
		const data = { ...common, ...decision };
		delete data.remedy;
		delete data.skipped;
		if (decision.remedy) {
			data.remedy = decision.remedy;
			data.revert = { from: decision.remedy.fromSha1, to: decision.remedy.toSha1 };
		} else {
			data.revertSkipped = decision.skipped;
		}
		const humanNeeded = decision.skipped === "is-revert";
		findings.push(
			makeFinding({
				detector: id,
				kind: "settings-broke-provider",
				severity: "crit",
				humanNeeded,
				subject: { key },
				evidence: [`not-configured:${decision.errorCount}`, decision.remedy ? "revert:planned" : `revert:skipped:${decision.skipped}`],
				titleKo: decision.remedy ? "설정 변경으로 공급자 장애 - 직전 정상본으로 자동 복구" : "설정 변경으로 공급자 장애 - 자동 복구 보류",
				detailKo: `settings.json 변경 직후 "Provider is not configured" 오류가 ${decision.errorCount}건 발생했습니다.${writer ? ` 변경한 세션: ${writer.sessionId} (${writer.tool}).` : ""}${decision.remedy ? " 직전 정상본(LKG)으로 되돌립니다." : ` 자동 복구하지 않은 이유: ${decision.skipped}.`}${humanNeeded ? " 복구한 설정에서도 오류가 계속되어 사람의 확인이 필요합니다." : ""}`,
				data,
			}),
		);
	}
	return findings;
}
