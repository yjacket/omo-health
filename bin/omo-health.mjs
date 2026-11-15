#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLedgers } from "../src/align/ledger.mjs";
import { loadConfig } from "../src/config.mjs";
import { clearPause, writePause } from "../src/control.mjs";
import { readDecisions } from "../src/decisions.mjs";
import { daemonState, runDaemon, VERSION } from "../src/daemon.mjs";
import { launchDaemon } from "../src/launch.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { BUDGET_AUDIT_DEFERRED_LABELS, BUDGET_DENIAL_LABELS, BUDGET_STAGE_LABEL, BUDGET_TRIGGER_LABELS, incidentStateLabel } from "../src/ui/labels.mjs";
import { ensureDir, listDirSafe, readJsonSafe, removeSafe } from "../src/util/fsx.mjs";
import { kst } from "../src/util/time.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS = {
	daemon: "run the supervisor in the foreground (--shadow, --config <file>, --echo)",
	start: "start the supervisor in the background (detached, hidden)",
	stop: "stop the supervisor and keep it stopped (the sensor will not restart it)",
	status: "show supervisor, sessions and recent incidents (--json for agents)",
	pause: "pause all automatic actions (--minutes N); detection and alerts continue",
	resume: "resume automatic actions",
	install: "install a pinned copy of HEAD (--dev: run this checkout, --from-package: install this package): sensor stub, logon autostart (HKCU Run), start the supervisor",
	uninstall: "uninstall: remove stub and autostart, stop the supervisor (--purge deletes data)",
	doctor: "check every dependency and print a table",
	scan: "replay past logs/sessions through the detectors (--from ISO --to ISO [--json])",
	replay: "run the engine over a fixture directory with a fake clock (<dir> [--json])",
	diagnose: "before cancelling a subagent: what it waits on, CPU and children, last progress, verdict and advice; no model call (<task|session> [--json])",
	report: "report a problem of a subagent or session to omo-health (<task|session> <text> [--json]); duplicates and floods are dropped",
	ui: "open the local dashboard in the default browser and return (--no-open, --json, --idle-minutes N); the server exits after 30 idle minutes",
	budget: "show subscription windows, project budgets and audits (--json)",
};

function arg(args, name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function usage() {
	const lines = [`omo-health ${VERSION}`, "", "Usage: omo-health <command> [options]", ""];
	for (const [name, text] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(10)} ${text}`);
	return lines.join("\n");
}

/**
 * Start the daemon outside this process tree (see launchDaemon); resolves to {via, pid, wmiError?}.
 * The installed bootstrap (app/boot.mjs) picks the runtime and passes extraArgs to main(["daemon", ...]).
 */
function startDetached(paths, extraArgs = []) {
	removeSafe(paths.health.stoppedFile);
	const script = fs.existsSync(paths.health.bootFile) ? paths.health.bootFile : path.join(HERE, "omo-health.mjs");
	return launchDaemon({ script, extraArgs });
}

/** Stale bound for a keepwarm snapshot without `staleAfter`. The producer's cadence is not in this repo; its fixtures put staleAfter about 11 min past ts. */
const KEEPWARM_DEFAULT_STALE_MS = 10 * 60_000;

/** Optional read-only keepwarm snapshot: null when absent, level "unknown" when unreadable or stale. */
export function keepwarmStatus({ env = process.env, now = Date.now() } = {}) {
	const file = path.join(env.OMO_KEEPWARM_HOME || path.join(os.homedir(), ".omo-keepwarm"), "status", "_global.json");
	if (!fs.existsSync(file)) return null;
	let snap;
	try {
		snap = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
	} catch {
		snap = undefined;
	}
	if (!snap || snap.v !== 1) return { level: "unknown", text: "keepwarm: unknown (unreadable)" };
	// A snapshot that names no numeric staleAfter (#82) is stale KEEPWARM_DEFAULT_STALE_MS after its ts; with neither it cannot be judged.
	const staleAfter = Number.isFinite(snap.staleAfter) ? snap.staleAfter : Number.isFinite(snap.ts) ? snap.ts + KEEPWARM_DEFAULT_STALE_MS : undefined;
	if (staleAfter === undefined) return { level: "unknown", text: "keepwarm: unknown (unreadable)" };
	if (now > staleAfter) return { level: "unknown", text: "keepwarm: unknown (stale)" };
	return { level: snap.level, text: snap.text, ts: snap.ts };
}

/** Snapshot state labels for the CLI and the status JSON (same words as the dashboard chips). */
export const BUDGET_STATE_KO = Object.freeze({ ok: "여유", tight: "빠듯", short: "부족", unknown: "모름" });

/** Snapshot project triggers (src/budget/metrics.mjs kinds plus projects.mjs audit reasons); short labels like the dashboard. */


const budgetLabel = (table, key) => (typeof key === "string" ? (table[key] ?? key) : "?");

/**
 * Budget part of `status --json`: every IS-1 window field copied from the snapshot, plus the project
 * view. Null when the daemon has written no snapshot yet. Nothing waits for a human: there is no
 * owner-pending list.
 */
export function budgetStatus(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return null;
	const windows = Array.isArray(snapshot.treasury?.windows) ? snapshot.treasury.windows : [];
	const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
	return {
		state: snapshot.treasury?.state ?? null,
		updatedMs: snapshot.updatedMs ?? null,
		windows: windows.map((w) => ({
			account: w.account ?? null,
			windowId: w.windowId ?? null,
			label: w.label ?? null,
			usedPercent: w.usedPercent ?? null,
			resetsAtMs: w.resetsAtMs ?? null,
			hoursLeft: w.hoursLeft ?? null,
			projectedAtResetPercent: w.projectedAtResetPercent ?? null,
			reservePercent: w.reservePercent ?? null,
			committedPercent: w.committedPercent ?? null,
			freePercent: w.freePercent ?? null,
			safeDailyPercent: w.safeDailyPercent ?? null,
			state: w.state ?? null,
			stale: w.stale === true,
			updatedMs: w.updatedMs ?? null,
			error: w.error ?? null,
			calibrated: w.calibrated === true,
			calibrationIntervals: w.calibrationIntervals ?? 0,
			percentPerUsd: w.percentPerUsd ?? null,
			coupons: w.coupons ?? 0,
		})),
		projects: projects.map((p) => ({
			id: p.id ?? null,
			objective: p.objective ?? null,
			status: p.status ?? null,
			spentUsd: p.spentUsd ?? null,
			approvedUsd: p.approvedUsd ?? null,
			stage: p.stage && typeof p.stage === "object" ? { nextCheckpoint: p.stage.nextCheckpoint ?? null } : null,
			triggers: Array.isArray(p.triggers) ? p.triggers.map((t) => ({ kind: t?.kind ?? null, heavy: t?.heavy === true, detail: t?.detail ?? null, firstMs: t?.firstMs ?? null })) : [],
			auditDeferred: p.auditDeferred && typeof p.auditDeferred === "object" ? { ms: p.auditDeferred.ms ?? null, reason: p.auditDeferred.reason ?? null } : null,
		})),
		ingest: snapshot.ingest ?? null,
	};
}

const pctText = (v) => (Number.isFinite(v) ? `${Math.round(v * 10) / 10}%` : "-");
const hoursText = (v) => (Number.isFinite(v) ? `${Math.round(v * 10) / 10}시간` : "-");
const usdText = (v) => (Number.isFinite(v) ? `$${Math.round(v * 100) / 100}` : "-");
/** `MM-DD HH:mm` in KST. */
const resetText = (ms) => (Number.isFinite(ms) ? kst(ms).slice(5, 16) : "-");
const agoText = (ms, now) => (Number.isFinite(ms) ? `${Math.max(0, Math.round((now - ms) / 60_000))}분 전` : "-");

/** The newest denial per project from the snapshot events (denied data.reason); a reasonless event is ignored. */
function deniedReasons(events) {
	const out = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.kind !== "denied" || typeof event.projectId !== "string" || out.has(event.projectId)) continue;
		const reason = typeof event.data?.reason === "string" && event.data.reason ? event.data.reason : null;
		if (reason) out.set(event.projectId, reason);
	}
	return out;
}

/** Compact Korean `budget` table: one line per window (IS-1 fields), then projects with staged and denial state. */
export function budgetTable(snapshot, now = Date.now()) {
	if (!snapshot || typeof snapshot !== "object") return "예산 기록 없음";
	const status = budgetStatus(snapshot);
	let headline = `예산 상태 ${BUDGET_STATE_KO[status.state] ?? status.state ?? "?"} · 갱신 ${agoText(status.updatedMs, now)}`;
	// Same backfill formula as the dashboard: covered share of the transcripts the ingest window covers.
	const ing = status.ingest;
	if (ing && ing.pendingBytes > 0 && ing.totalBytes > 0) headline += ` · 수집 중 ${Math.round((100 * (ing.totalBytes - ing.pendingBytes)) / ing.totalBytes)}%`;
	const lines = [headline];
	for (const w of status.windows) {
		const parts = [
			`${w.account ?? "?"} ${w.windowId ?? "?"} (${w.label ?? "-"})`,
			`사용 ${pctText(w.usedPercent)}`,
			`리셋 ${resetText(w.resetsAtMs)}`,
			`남은 시간 ${hoursText(w.hoursLeft)}`,
			`예상 ${pctText(w.projectedAtResetPercent)}`,
			`예비 ${pctText(w.reservePercent)}`,
			`배정 ${Number.isFinite(w.committedPercent) ? pctText(w.committedPercent) : "미보정"}`,
			`여유 ${pctText(w.freePercent)}`,
			`하루 ${pctText(w.safeDailyPercent)}`,
			`상태 ${BUDGET_STATE_KO[w.state] ?? w.state ?? "?"}`,
			`갱신 ${agoText(w.updatedMs, now)}`,
			`보정 ${w.calibrated ? `${w.calibrationIntervals}건` : "미보정"}`,
			`리셋권 ${w.coupons}`,
		];
		// Same markers as the dashboard: a stale poll and a failed poll are not just 상태 모름.
		if (w.stale) parts.push("오래됨");
		if (w.error !== null) parts.push("조회 실패");
		lines.push(parts.join(" · "));
	}
	if (!status.windows.length) lines.push("창 없음");
	lines.push("", `프로젝트 ${status.projects.length}건`);
	const denials = deniedReasons(snapshot.events);
	for (const p of status.projects) {
		let line = `- ${p.objective || p.id} [${p.status}] 지출 ${usdText(p.spentUsd)} / 승인 ${usdText(p.approvedUsd)}`;
		if (p.stage) line += ` · ${BUDGET_STAGE_LABEL}${p.stage.nextCheckpoint ? `: ${p.stage.nextCheckpoint}` : ""}`;
		if (p.triggers.length) line += ` · 기준: ${p.triggers.map((t) => `${budgetLabel(BUDGET_TRIGGER_LABELS, t.kind)}${t.heavy ? "!" : ""}`).join(", ")}`;
		if (p.auditDeferred) line += ` · 감사 미룸: ${budgetLabel(BUDGET_AUDIT_DEFERRED_LABELS, p.auditDeferred.reason)}`;
		if (denials.has(p.id)) line += ` · 거절: ${budgetLabel(BUDGET_DENIAL_LABELS, denials.get(p.id))}`;
		lines.push(line);
	}
	return lines.join("\n");
}

export function statusReport(paths, now = Date.now(), env = process.env) {
	const state = daemonState(paths);
	const global = readJsonSafe(path.join(paths.health.statusDir, "_global.json"));
	const deaths = listDirSafe(paths.health.deathsDir)
		.map((name) => {
			const record = readJsonSafe(path.join(paths.health.deathsDir, name));
			const atMs = Number.isFinite(record?.atMs) ? record.atMs : Number(/^(\d+)-/.exec(name)?.[1]);
			return record && typeof record.kind === "string" && Number.isFinite(atMs) ? { ...record, atMs } : null;
		})
		.filter(Boolean)
		.sort((a, b) => b.atMs - a.atMs);
	const sensors = listDirSafe(paths.health.sensorsDir)
		.filter((n) => n.endsWith(".json"))
		.map((n) => readJsonSafe(path.join(paths.health.sensorsDir, n)))
		.filter((hb) => hb && now - hb.ts < 10 * 60_000)
		.map((hb) => ({ sessionId: hb.sessionId, pid: hb.pid, cwd: hb.cwd, idle: hb.idle, ageMs: now - hb.ts }));
	const decisions = readDecisions(paths, now - 24 * 3600_000).filter((d) => d.result === "execute" || d.result === "would" || d.event === "opened");
	return {
		version: VERSION,
		daemon: { running: state.running, pid: state.pid, heartbeatAgeMs: state.heartbeat?.ts ? now - state.heartbeat.ts : undefined, mode: state.heartbeat?.mode, stopped: state.stopped, paused: state.paused ?? null, exitReason: state.heartbeat?.exitReason, liveHosts: state.heartbeat?.liveHosts },
		level: global?.level,
		text: global?.text,
		degraded: global?.degraded,
		humanNeeded: global?.humanNeeded ?? [],
		sessions: global?.counts?.sessions,
		tasks: global?.counts?.tasks,
		openFindings: global?.open ?? [],
		counts: global?.counts,
		sensors,
		deaths: { count: deaths.length, last: deaths.length ? { kind: deaths[0].kind, atMs: deaths[0].atMs } : null },
		unknownEvents: global?.unknownEvents ?? null,
		// #55 C: baseline-deviation fires (last hour, day) and each metric's cold start.
		baseline: global?.baseline ?? null,
		recentIncidents: global?.incidents ?? [],
		recentActions: decisions.filter((d) => d.result === "execute" || d.result === "would").slice(-20).map((d) => ({ ts: d.ts, kind: d.action?.kind, result: d.result, cls: d.cls, fp: d.fp, outcome: d.outcome })),
		keepwarm: keepwarmStatus({ env, now }),
		alignment: readLedgers(paths, { now }).map((l) => ({ sessionId: l.sessionId, goal: l.goal, openCommitments: l.openCommitments, lastNudge: l.nudges?.at(-1) ?? null })),
		budget: budgetStatus(readJsonSafe(paths.health.budgetSnapshotFile, null)),
	};
}

function printStatus(report) {
	const d = report.daemon;
	const lines = [];
	lines.push(`감시기: ${d.running ? `실행 중 (pid ${d.pid}, 모드 ${d.mode ?? "?"}${d.paused ? ", 자동 조치 일시정지" : ""})` : d.stopped ? "중지됨 (stop)" : "실행 중 아님"}`);
	if (report.text) lines.push(`상태: ${report.text}`);
	if (report.counts) lines.push(`세션 ${report.counts.sessions}, 서브에이전트 기록 ${report.counts.tasks}, omo 호스트 ${report.counts.liveHosts}, 센서 ${report.counts.sensors}`);
	if (report.keepwarm) lines.push(report.keepwarm.text);
	if (report.unknownEvents?.length) {
		lines.push(`모르는 로그 이벤트: ${report.unknownEvents.map((e) => `${e.source} ${(e.names ?? []).join(", ")}`).join("; ")}`);
	}
	if (report.humanNeeded.length) {
		lines.push("", "사람 조치 필요:");
		for (const h of report.humanNeeded) lines.push(`  - ${h.titleKo}`);
	}
	if (report.openFindings.length) {
		lines.push("", "열린 문제:");
		for (const f of report.openFindings) lines.push(`  - [${f.severity}] ${f.titleKo}`);
	}
	if (report.recentIncidents.length) {
		lines.push("", "최근 24시간 사건:");
		for (const i of report.recentIncidents.slice(-15)) lines.push(`  - ${kst(i.firstSeenMs)} ${i.titleKo}${i.resolvedMs ? " (해소)" : i.state ? ` (${incidentStateLabel(i.state)})` : ""}${i.actions.length ? ` [${i.actions.join(", ")}]` : ""}${i.reportPath ? `\n      ${i.reportPath}` : ""}`);
	}
	return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const [command, ...args] = argv;
	const paths = resolvePaths(env);
	if (!command || command === "--help" || command === "-h" || command === "help") {
		console.log(usage());
		return 0;
	}
	if (!COMMANDS[command]) {
		console.error(`unknown command: ${command}\n\n${usage()}`);
		return 2;
	}
	const configPath = arg(args, "--config");
	const { config, warnings } = loadConfig({ env: configPath ? { ...env, OMO_HEALTH_CONFIG: configPath } : env, paths });
	switch (command) {
		case "daemon": {
			for (const w of warnings) console.error(`config: ${w}`);
			const result = await runDaemon({ paths, config, mode: args.includes("--shadow") ? "shadow" : undefined, echo: args.includes("--echo"), configEnv: configPath ? { ...env, OMO_HEALTH_CONFIG: configPath } : env });
			if (result.reason === "already-running") console.log(`already running (pid ${result.holder?.pid})`);
			return result.exitCode;
		}
		case "start": {
			const state = daemonState(paths);
			if (state.running) {
				console.log(`already running (pid ${state.pid})`);
				return 0;
			}
			const launched = await startDetached(paths, configPath ? ["--config", path.resolve(configPath)] : []);
			console.log(`started (pid ${launched.pid ?? "?"} via ${launched.via}${launched.wmiError ? `; ${launched.wmiError}` : ""})`);
			return 0;
		}
		case "stop": {
			ensureDir(paths.healthHome);
			fs.writeFileSync(paths.health.stoppedFile, new Date().toISOString());
			const state = daemonState(paths);
			if (state.running) {
				// G09: a deliberate stop, so the bootstrap records neither an unclean death nor a failed start.
				const { markDaemonStopped } = await import("../src/install.mjs");
				markDaemonStopped(paths, "cli-stop");
				spawnSync("taskkill.exe", ["/F", "/PID", String(state.pid)], { windowsHide: true });
			}
			console.log(state.running ? `stopped (pid ${state.pid})` : "not running (stop flag set)");
			return 0;
		}
		case "status": {
			const report = statusReport(paths, Date.now(), env);
			console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : printStatus(report));
			return 0;
		}
		case "budget": {
			const snapshot = readJsonSafe(paths.health.budgetSnapshotFile, null);
			console.log(args.includes("--json") ? JSON.stringify(snapshot, null, 2) : budgetTable(snapshot));
			return 0;
		}
		case "pause": {
			const minutes = Number(arg(args, "--minutes"));
			writePause(paths, { minutes });
			console.log(Number.isFinite(minutes) && minutes > 0 ? `paused for ${minutes} min` : "paused until `omo-health resume`");
			return 0;
		}
		case "resume": {
			clearPause(paths);
			console.log("resumed");
			return 0;
		}
		case "ui": {
			const mod = await import("../src/ui/cli.mjs");
			return mod.runUiCli(args, { paths, env, config });
		}
		default: {
			const mod = await import("../src/cli-extra.mjs");
			return mod.run(command, args, { paths, config, env, startDetached });
		}
	}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error?.stack ?? error);
			process.exitCode = 1;
		},
	);
}
