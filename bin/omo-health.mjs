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
import { incidentStateLabel } from "../src/ui/labels.mjs";
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
