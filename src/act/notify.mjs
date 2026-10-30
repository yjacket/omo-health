import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonSafe } from "../util/fsx.mjs";
import { truncate } from "../util/text.mjs";

export const TOAST_SCRIPT = path.resolve(fileURLToPath(new URL("../../scripts/toast.ps1", import.meta.url)));

/** The footer's mark (stands for omo-health); the details live in the web UI. */
export const FOOTER_MARK = "👀";
/** One word per problem type for the footer: by finding kind first, else by detector. */
const WORD_BY_KIND = {
	"accounts-blocked": "로그인",
	"outage-human": "공급자장애",
	"host-crash-stopped": "재개중단",
	"hung-main-turn": "무응답",
	"child-error-unhandled": "오류방치",
	"error-storm": "오류폭풍",
	"machine-commit": "메모리",
	"tps-collapse": "느림",
};
const WORD_BY_DETECTOR = { D1: "멈춤", D2: "폭주", D4: "토큰", D5: "무응답", D6: "공급자", D7: "설정", D8: "작업정지", D9: "잔여", D10: "루프", D11: "리로드", D12: "자체점검", D14: "범위밖", D15: "범위", D16: "정리", D17: "재시작", D18: "호스트", D20: "한도" };

/**
 * Footer text for a status level and its top finding: the mark and one word (the sensor colors it by the status level).
 * While the top problem is under investigation (`investigating`), the footer says so instead of the alarm word, in the
 * problem's own level color (analyst-why C8/IS-7).
 */
export function footerText(level, finding, count = 0, investigating = false) {
	if (investigating && finding && (level === "warn" || level === "crit")) return `${FOOTER_MARK} 조사중`;
	if (level === "info" && finding && count) return `${FOOTER_MARK} 관찰${count}`;
	if (level === "ok" || level === "info" || !finding) return `${FOOTER_MARK} 정상`;
	return `${FOOTER_MARK} ${WORD_BY_KIND[finding.kind] ?? WORD_BY_DETECTOR[finding.detector] ?? "문제"}`;
}

/** A session parked on live work: workflow progress when a DAG is running, else the live work count. */
export function waitingText({ dag, count } = {}) {
	if (dag?.total > 0) return `${FOOTER_MARK} DAG${dag.completed ?? 0}/${dag.total}`;
	return `${FOOTER_MARK} 대기${count}`;
}

export function writeSessionStatus(paths, sessionId, status) {
	atomicWriteJson(path.join(paths.health.statusDir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`), status);
}

export function writeGlobalStatus(paths, status) {
	atomicWriteJson(path.join(paths.health.statusDir, "_global.json"), status);
}

export function readStatus(paths, sessionId) {
	return readJsonSafe(path.join(paths.health.statusDir, `${sessionId}.json`));
}

/** Default toast runner: PowerShell 5.1 WinRT via scripts/toast.ps1. */
export function powershellToastRunner({ title, body, tag }) {
	const file = path.join(os.tmpdir(), `omo-health-toast-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(file, JSON.stringify({ title, body, tag }), "utf8");
	try {
		const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", TOAST_SCRIPT, "-File", file], { windowsHide: true, encoding: "utf8", timeout: 20_000 });
		return { ok: result.status === 0 && /shown/.test(result.stdout ?? ""), status: result.status, stderr: truncate(result.stderr ?? "", 300) };
	} finally {
		try {
			fs.unlinkSync(file);
		} catch {
			// ignore
		}
	}
}

/**
 * Toast with a per-tag cooldown persisted in healthHome/toast-state.json, so
 * the same human-needed condition does not nag (IS-10c, notify.toastCooldownMs).
 */
export function createNotifier({ paths, clock, config, runner = powershellToastRunner, log }) {
	const stateFile = path.join(paths.healthHome, "toast-state.json");
	return {
		toast({ title, body, tag }) {
			const now = clock.now();
			const state = readJsonSafe(stateFile, {});
			const last = state[tag];
			if (last && now - last < config.notify.toastCooldownMs) return { ok: false, skipped: "cooldown" };
			const result = runner({ title, body: truncate(body, 240), tag });
			if (result.ok) {
				state[tag] = now;
				atomicWriteJson(stateFile, state);
			} else {
				log?.warn?.("toast_failed", { tag, status: result.status, stderr: result.stderr });
			}
			return result;
		},
	};
}
