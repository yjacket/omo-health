import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { powershellToastRunner } from "./act/notify.mjs";
import { createProcessSource } from "./collect/procs.mjs";
import { daemonState } from "./daemon.mjs";
import { defaultRegRunner, install, readRunValue, runCommandValue, runValueName, STUB_NAME, stubContent, stubCurrent, taskkillDaemon, uninstall } from "./install.mjs";
import { compareExpected, runReplay } from "./replay.mjs";
import { runScan } from "./scan.mjs";
import { listDirSafe, readJsonSafe, readTextSafe } from "./util/fsx.mjs";

function arg(args, name) {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export class DoctorWarning extends Error {}

async function doctor({ paths, config, checks, regRunner = defaultRegRunner } = {}) {
	const rows = [];
	const defaultChecks = {
		nodeVersion: async () => {
			const major = Number(process.versions.node.split(".")[0]);
			if (major < 24) throw new Error(`node ${process.versions.node}`);
			return process.versions.node;
		},
		processWorker: async () => {
			const source = createProcessSource({ binDir: paths.health.binDir });
			try {
				const snap = await source.snapshot();
				const os = await source.os();
				if (!snap.rows.length) throw new Error("empty snapshot");
				return `${source.kind} worker, ${snap.rows.length} processes, commit ${(os.commitFrac * 100).toFixed(1)}%`;
			} finally {
				source.close();
			}
		},
		toastScript: () => {
			if (!fs.existsSync(path.join(paths.repoRoot, "scripts", "toast.ps1"))) throw new Error("scripts/toast.ps1 missing");
			return "scripts/toast.ps1";
		},
		omoCli: () => {
			const command = process.env.OMO_HEALTH_OMO ?? config.analyst.command;
			const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000, shell: !/\.exe$/i.test(command) });
			if (result.status !== 0) throw new Error(`exit ${result.status}`);
			return `${result.stdout.trim()} (${command})`;
		},
		runtime: () => {
			const current = readJsonSafe(paths.health.currentFile);
			if (!current) throw new Error(`${paths.health.currentFile} missing (run install)`);
			if (current.channel !== "pinned" && current.channel !== "dev" && current.channel !== "package") throw new Error(`unknown channel ${current.channel}`);
			const detail = `${current.channel} ${current.version} ${current.root}`;
			if (typeof current.root !== "string" || !fs.existsSync(path.join(current.root, "bin", "omo-health.mjs"))) throw new Error(`${detail}: root missing (run install)`);
			return detail;
		},
		bootstrap: () => {
			if (!fs.existsSync(paths.health.bootFile)) throw new Error(`${paths.health.bootFile} missing (run install)`);
			return paths.health.bootFile;
		},
		sensorStub: () => {
			const file = path.join(paths.extensionsDir, STUB_NAME);
			const current = readJsonSafe(paths.health.currentFile);
			if (current?.channel === "package") {
				if (readTextSafe(file) !== undefined) throw new Error(`${file} legacy stub이 남아 있어 센서가 두 번 로드됩니다`);
				return "legacy stub ABSENT";
			}
			if (readTextSafe(file) === undefined) throw new Error(`${file} missing (run install)`);
			return file;
		},
		stubUpToDate: () => {
			const current = readJsonSafe(paths.health.currentFile);
			if (current?.channel === "package") {
				const manifestPath = path.join(current.source, "package.json");
				const manifest = readJsonSafe(manifestPath);
				if (!manifest?.pi?.extensions?.includes("extension/entry.ts")) throw new Error(`${manifestPath} pi.extensions missing extension/entry.ts`);
				return "current.source/package.json pi.extensions includes extension/entry.ts";
			}
			const text = readTextSafe(path.join(paths.extensionsDir, STUB_NAME));
			if (text === undefined) throw new Error("stub missing (run install)");
			const head = text.split(/\r?\n/, 1)[0];
			if (!stubCurrent(paths, text)) throw new Error(`stub differs from the installed runtime (${head}; run install)`);
			return text === stubContent(paths) ? head : `${head} (same sensor as the installed runtime)`;
		},
		sensorLoads: () => {
			const stubMs = fs.statSync(path.join(paths.extensionsDir, STUB_NAME), { throwIfNoEntry: false })?.mtimeMs ?? 0;
			const since = Math.max(Date.now() - 24 * 3600_000, stubMs);
			const failures = (readTextSafe(path.join(paths.health.logsDir, "sensor-stub.log")) ?? "").split("\n").filter((line) => /^\d{4}-\d\d-\d\dT/.test(line) && Date.parse(line.slice(0, 24)) >= since);
			if (failures.length) throw new Error(`stub failed to load the sensor ${failures.length}x in 24 h; last: ${failures.at(-1).slice(0, 300)}`);
			const live = listDirSafe(paths.health.sensorsDir).filter((name) => name.endsWith(".json")).map((name) => readJsonSafe(path.join(paths.health.sensorsDir, name))).filter((hb) => hb && Date.now() - hb.ts < 60_000);
			return `${live.length} session(s) with a live sensor heartbeat`;
		},
		logonAutostart: () => {
			const value = readRunValue(regRunner, { OMO_HEALTH_RUN_VALUE: runValueName() });
			if (value !== runCommandValue(paths)) throw new Error(value ? `unexpected value: ${value}` : "missing (run install)");
			return value;
		},
		daemonRunning: () => {
			const state = daemonState(paths);
			if (!state.running) throw new Error(state.stopped ? "stopped (run start)" : "not running");
			const age = Date.now() - (state.heartbeat?.ts ?? 0);
			if (age > 60_000) throw new Error(`heartbeat ${Math.round(age / 1000)} s old`);
			return `pid ${state.pid}, mode ${state.heartbeat?.mode}, heartbeat ${Math.round(age / 1000)} s ago`;
		},
		logParsingHealthy: () => {
			const global = readJsonSafe(path.join(paths.health.statusDir, "_global.json"));
			if (!global) throw new Error("no status yet");
			if (global.degraded) throw new Error("degraded: omo log/session format changed");
			const loudUnknown = (global.unknownEvents ?? []).filter((e) => !e.quiet);
			if (loudUnknown.length) {
				const detail = `unknown events: ${loudUnknown.map((e) => `${e.source} ${(e.names ?? []).join(", ")}`).join("; ")}`;
				const warn = new DoctorWarning(detail);
				throw warn;
			}
			return `failures: ${(global.failures ?? []).length}`;
		},
		omoInstallUntouched: () => {
			const stubInInstall = [paths.npmOmoRoot, paths.bunOmoRoot].some((root) => root && fs.existsSync(path.join(root, "plugin", "extensions", STUB_NAME)));
			if (stubInInstall) throw new Error("found omo-health file inside the omo install");
			return "no omo-health files inside the omo-ai install";
		},
	};
	
	const checksToRun = { ...defaultChecks, ...checks };
	const checkFns = {
		"node >= 24": checksToRun.nodeVersion,
		"process worker snapshot": checksToRun.processWorker,
		"toast script present": checksToRun.toastScript,
		"omo CLI (analyst)": checksToRun.omoCli,
		runtime: checksToRun.runtime,
		"bootstrap present": checksToRun.bootstrap,
		"sensor stub installed": checksToRun.sensorStub,
		"stub up to date": checksToRun.stubUpToDate,
		"sensor loads in sessions": checksToRun.sensorLoads,
		"logon autostart (HKCU Run)": checksToRun.logonAutostart,
		"daemon running": checksToRun.daemonRunning,
		"log parsing healthy": checksToRun.logParsingHealthy,
		"omo install untouched by omo-health": checksToRun.omoInstallUntouched,
	};

	for (const [name, fn] of Object.entries(checkFns)) {
		if (!fn) continue;
		try {
			const detail = await fn();
			rows.push({ name, status: "ok", ok: true, detail: String(detail ?? "") });
		} catch (error) {
			if (error instanceof DoctorWarning) {
				rows.push({ name, status: "warn", ok: true, detail: error.message });
			} else {
				rows.push({ name, status: "fail", ok: false, detail: error.message });
			}
		}
	}
	return rows;
}

export { doctor };

/** `report` answers: queued and duplicate are fine for the agent that asked (exit 0); a flood is not (exit 1). */
function reportMessage(result, { daemonRunning, perHour }) {
	switch (result.outcome) {
		case "queued":
			return [`보고를 접수했습니다 [${result.report.id}] ${result.report.subject}`, daemonRunning ? "감시기가 다음 확인(약 15초 안)에 사건으로 기록하고 증거 스냅샷을 남깁니다." : "감시기가 실행 중이 아니어서 다음에 시작할 때 기록합니다."].join("\n");
		case "duplicate":
			return "같은 대상에 같은 내용의 보고가 최근 1시간 안에 이미 있어 다시 기록하지 않습니다.";
		case "rate-limited":
			return `최근 1시간 보고가 한도(${perHour}건)에 닿아 기록하지 않았습니다.`;
		default:
			return `보고할 수 없습니다: ${result.problem}`;
	}
}

export async function run(command, args, { paths, config, startDetached, checks, diagnose }) {
	switch (command) {
		case "install": {
			const report = await install({
				paths,
				dev: args.includes("--dev"),
				fromPackage: args.includes("--from-package"),
				startDaemon: async () => {
					// startDetached launches app/boot.mjs, which install has just written.
					const launched = await startDetached(paths);
					return `${launched.pid ?? "?"} via ${launched.via}${launched.wmiError ? ` (${launched.wmiError})` : ""}`;
				},
			});
			console.log(JSON.stringify(report, null, 2));
			return 0;
		}
		case "uninstall": {
			const report = uninstall({ paths, purge: args.includes("--purge"), stopDaemon: taskkillDaemon });
			console.log(JSON.stringify(report, null, 2));
			return 0;
		}
		case "doctor": {
			const rows = await doctor({ paths, config, checks });
			if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
			else for (const row of rows) {
				const prefix = row.status === "ok" ? "OK  " : row.status === "warn" ? "WARN" : "FAIL";
				console.log(`${prefix} ${row.name.padEnd(36)} ${row.detail}`);
			}
			if (args.includes("--toast")) console.log(JSON.stringify(powershellToastRunner({ title: "omo-health doctor", body: "알림 경로 시험입니다.", tag: "doctor" })));
			return rows.some((row) => row.status === "fail") ? 1 : 0;
		}
		case "scan": {
			const fromMs = Date.parse(arg(args, "--from"));
			const toMs = Date.parse(arg(args, "--to"));
			if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
				console.error("scan needs --from <ISO> --to <ISO>");
				return 2;
			}
			const findings = await runScan({ fromMs, toMs, stepMs: Number(arg(args, "--step") ?? 15_000) });
			if (args.includes("--json")) console.log(JSON.stringify(findings, null, 2));
			else for (const f of findings) console.log(`${f.at} [${f.severity}] ${f.detector}/${f.kind}${f.cls ? `/${f.cls}` : ""} ${f.titleKo ?? ""}`);
			return 0;
		}
		case "replay": {
			const dir = args.find((a) => !a.startsWith("--"));
			if (!dir) {
				console.error("replay needs a fixture directory");
				return 2;
			}
			const result = await runReplay(path.resolve(dir));
			const expected = readJsonSafe(path.join(dir, "expected.json"));
			const problems = expected ? compareExpected(result, expected) : [];
			const out = { findings: result.findings.map((f) => ({ at: new Date(f.firstAtMs).toISOString(), detector: f.detector, kind: f.kind, cls: f.cls, severity: f.maxSeverity, subject: f.subject })), actions: result.actions.map((a) => ({ ...a, at: new Date(a.atMs).toISOString() })), problems };
			console.log(args.includes("--json") ? JSON.stringify(out, null, 2) : [...out.findings.map((f) => `${f.at} [${f.severity}] ${f.detector}/${f.kind}/${f.cls ?? ""}`), ...out.actions.map((a) => `${a.at} ACTION ${a.kind} ${a.targets?.join(",") ?? ""}`), ...problems.map((p) => `PROBLEM ${p}`)].join("\n"));
			return problems.length ? 1 : 0;
		}
		case "diagnose": {
			const id = args.find((a) => !a.startsWith("--"));
			if (!id) {
				console.error("diagnose needs a task id or a session id: omo-health diagnose <task|session> [--json]");
				return 2;
			}
			// Loaded on demand: the other commands need neither the collectors nor the classifier.
			const { formatDiagnosis, runDiagnose } = await import("./diagnose.mjs");
			const report = await runDiagnose({ paths, config, id, ...diagnose });
			console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDiagnosis(report));
			return report.found ? 0 : 1;
		}
		case "report": {
			const [subject, ...words] = args.filter((a) => a !== "--json");
			const text = words.join(" ");
			if (!subject || !text.trim()) {
				console.error("report needs a task or session id and the text: omo-health report <task|session> <text> [--json]");
				return 2;
			}
			const { queueReport, REPORTS_PER_HOUR } = await import("./reports/intake.mjs");
			const result = queueReport(paths, { subject, text, via: "cli", now: Date.now() });
			const daemonRunning = daemonState(paths).running;
			const messageKo = reportMessage(result, { daemonRunning, perHour: REPORTS_PER_HOUR });
			if (args.includes("--json")) console.log(JSON.stringify({ ok: result.ok, outcome: result.outcome, id: result.report.id, subject: result.report.subject, text: result.report.text, file: result.file ?? null, daemonRunning, messageKo }, null, 2));
			else console.log(messageKo);
			return result.outcome === "invalid" ? 2 : result.outcome === "rate-limited" ? 1 : 0;
		}
		default:
			console.error(`unknown command ${command}`);
			return 2;
	}
}
