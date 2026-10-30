#!/usr/bin/env node
/**
 * omo-health bootstrap: the first code of every supervisor start.
 *
 *   node --max-semi-space-size=1 --max-old-space-size=96 <healthHome>/app/boot.mjs daemon [args]
 *   node <healthHome>/app/boot.mjs <command> [args]    any other command goes straight to main() of the current root
 *
 * Node built-ins only: install copies this file out of the repo to <healthHome>/app/boot.mjs, and it has to keep
 * working when the installed runtime is broken.
 *
 * A daemon start, in order:
 *   1. the previous daemon died uncleanly (no stoppedMs, pid gone, and an omo session that was already running
 *      when it last heartbeated is still alive) -> deaths/<ms>-unclean-exit.json;
 *   2. an EXISTING sensor stub is rewritten to load <root> when that root's sensor files differ from the ones it loads;
 *   3. import <root>/bin/omo-health.mjs (root from app/current.json: the pinned copy of HEAD, or a dev checkout)
 *      and run main(["daemon", ...args]). A start that throws is recorded as deaths/<ms>-start-failed.json.
 * There is no release channel: no update, no rollback, no crash-loop guard, no network.
 *
 * Stub contract (install writes the same content): the stub is rendered from <root>/extension/stub.ts.tpl with
 * __VERSION__ -> version, __FALLBACK_ROOT__ -> root and __SENSOR_PATH__ -> <root>/extension/sensor.mjs (forward
 * slashes); a root without a template only gets the first line `// omo-health release <version>` rewritten.
 * Boot rewrites a stub that exists and never creates one, so an uninstalled sensor stays uninstalled.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOG_TAIL_LINES = 40;
const RELEASE_LINE = /^\/\/ omo-health release [^\r\n]*/;
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function resolveBootPaths(env) {
	const home = env.USERPROFILE || env.HOME || os.homedir();
	const healthHome = env.OMO_HEALTH_HOME || path.join(home, ".omo-health");
	const omoHome = env.OMO_HEALTH_OMO_HOME || path.join(home, ".omo");
	const app = path.join(healthHome, "app");
	return {
		daemonJson: path.join(healthHome, "daemon.json"),
		lockFile: path.join(healthHome, "daemon.lock"),
		launcher: path.join(healthHome, "launch-hidden.vbs"),
		sensorsDir: path.join(healthHome, "sensors"),
		daemonLog: path.join(healthHome, "logs", "daemon.log"),
		bootLog: path.join(healthHome, "logs", "boot.log"),
		deathsDir: path.join(healthHome, "deaths"),
		currentFile: path.join(app, "current.json"),
		bootStateFile: path.join(app, "boot-state.json"),
		stubFile: path.join(omoHome, "agent", "extensions", "omo-health-sensor.ts"),
	};
}

// ---------------------------------------------------------------- files

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readJson(file) {
	const text = readText(file);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

/** Temp file + rename so the daemon, the sensor and install never read a half-written file. */
function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(tmp, text);
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (error) {
			if (attempt >= 5 || !RENAME_RETRY_CODES.has(error.code)) {
				fs.rmSync(tmp, { force: true });
				throw error;
			}
			// Windows: a reader holding the target open blocks the rename briefly.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
		}
	}
}

function writeJson(file, value) {
	writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function exists(file) {
	return fs.existsSync(file);
}

function listDir(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function tailLines(file, count) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, 64 * 1024);
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split(/\r?\n/);
		if (length < size) lines.shift(); // cut mid-line
		return lines.filter(Boolean).slice(-count);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function log(p, event, data = {}) {
	const line = `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data })}\n`;
	try {
		fs.mkdirSync(path.dirname(p.bootLog), { recursive: true });
		fs.appendFileSync(p.bootLog, line);
	} catch (error) {
		process.stderr.write(`omo-health boot: cannot write ${p.bootLog} (${error.message}): ${line}`);
	}
}

/** Boot's own bookkeeping must never keep the supervisor from starting: a failed step is logged and skipped. */
function step(p, name, fn, onError = () => undefined) {
	try {
		return fn();
	} catch (error) {
		log(p, "step_failed", { step: name, error: String(error?.stack ?? error).slice(0, 2000) });
		return onError();
	}
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function binOf(root) {
	return path.join(root, "bin", "omo-health.mjs");
}

// ---------------------------------------------------------------- state

function readCurrent(p) {
	const current = readJson(p.currentFile);
	return typeof current?.version === "string" && typeof current.root === "string" ? current : undefined;
}

function readBootState(p) {
	const deathCheckedTs = readJson(p.bootStateFile)?.deathCheckedTs;
	return { deathCheckedTs: Number.isFinite(deathCheckedTs) ? deathCheckedTs : null };
}

function saveBootState(p, state) {
	writeJson(p.bootStateFile, { v: 1, deathCheckedTs: state.deathCheckedTs });
}

function recordDeath(p, kind, ms, data) {
	const file = path.join(p.deathsDir, `${ms}-${kind}.json`);
	writeJson(file, { kind, atMs: ms, ...data });
	log(p, "death_recorded", { kind, file: path.basename(file), version: data.version ?? null });
}

/** When this process's daemon stops outside runDaemon's own cleanup, say so, so the next boot sees no unclean exit. */
function markStopped(p, exitReason, now) {
	const hb = readJson(p.daemonJson);
	if (hb?.pid === process.pid && !hb.stoppedMs) writeJson(p.daemonJson, { ...hb, stoppedMs: now, exitReason });
}

function releaseOwnLock(p) {
	if (readJson(p.lockFile)?.pid === process.pid) fs.rmSync(p.lockFile, { force: true });
}

// ---------------------------------------------------------------- step 2: previous-run death check

/** Start time (epoch ms) of each live pid; empty when the platform or PowerShell cannot say. */
function processStartTimes(p, pids) {
	const starts = new Map();
	// OMO_HEALTH_POWERSHELL is a test seam: a fake replaces the real PowerShell, whose start-up time varies.
	const override = process.env.OMO_HEALTH_POWERSHELL;
	if ((process.platform !== "win32" && !override) || !pids.length) return starts;
	const script = `foreach ($id in @(${pids.join(",")})) { try { $p = Get-Process -Id $id -ErrorAction Stop; '{0} {1}' -f $id, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { } }`;
	const [file, pre] = commandFor(override, "powershell.exe");
	const result = spawnSync(file, [...pre, "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
	if (result.error || result.status !== 0) log(p, "process_start_lookup_failed", { error: result.error?.message ?? String(result.stderr ?? "").slice(0, 500) });
	for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
		const [pid, ms] = line.trim().split(/\s+/).map(Number);
		if (pid > 0 && Number.isFinite(ms)) starts.set(pid, ms);
	}
	return starts;
}

/**
 * A live omo session that was already running when the daemon last heartbeated: the daemon died on its own
 * (a reboot or logoff ends every such session). A sensor rewrites its heartbeat every 10 s, so its `ts` is
 * always newer than a dead daemon's; the session's process start time is what dates it. The heartbeat must
 * postdate that start, so a stale sensor file whose pid now belongs to another process never counts.
 */
function sessionThatOutlived(p, lastTs) {
	const sensors = listDir(p.sensorsDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJson(path.join(p.sensorsDir, name)))
		.filter((s) => Number.isInteger(s?.pid) && Number.isFinite(s.ts) && pidAlive(s.pid));
	if (!sensors.length) return undefined;
	const starts = processStartTimes(p, [...new Set(sensors.map((s) => s.pid))]);
	return sensors.find((s) => starts.has(s.pid) && starts.get(s.pid) < lastTs && s.ts >= starts.get(s.pid));
}

function checkPreviousRun(p, state, now) {
	const hb = readJson(p.daemonJson);
	if (!hb || hb.stoppedMs || !Number.isFinite(hb.ts) || hb.ts === state.deathCheckedTs || pidAlive(hb.pid)) return;
	state.deathCheckedTs = hb.ts;
	if (!sessionThatOutlived(p, hb.ts)) {
		log(p, "previous_run_not_a_death", { lastTs: hb.ts, version: hb.version ?? null });
		return;
	}
	recordDeath(p, "unclean-exit", now, { version: hb.version ?? null, lastTs: hb.ts, pid: hb.pid ?? null, logTail: tailLines(p.daemonLog, LOG_TAIL_LINES) });
}

/** A .js/.mjs override (a test fake) runs under this node; anything else is executed directly. */
function commandFor(override, fallback) {
	const command = override || fallback;
	return /\.[cm]?js$/i.test(command) ? [process.execPath, [command]] : [command, []];
}

// ---------------------------------------------------------------- stub

function renderStub(template, { version, root }) {
	const slashed = root.replace(/\\/g, "/");
	const values = { __VERSION__: version, __FALLBACK_ROOT__: slashed, __SENSOR_PATH__: `${slashed}/extension/sensor.mjs` };
	return template.replace(/__(?:VERSION|FALLBACK_ROOT|SENSOR_PATH)__/g, (token) => values[token]);
}

// Files a loaded sensor runs; boot uses only its built-in release-management code.
const SENSOR_FILES = ["extension/sensor.mjs", "extension/import-fresh.mjs", "extension/stub.ts.tpl", "src/launch.mjs"];

function sameSensor(rootA, rootB) {
	return SENSOR_FILES.every((file) => {
		const a = readText(path.join(rootA, file));
		return a !== undefined && a === readText(path.join(rootB, file));
	});
}

/** A rewrite hot-reloads every open omo session's extensions, so an unchanged sensor leaves the stub alone. */
function writeStub(p, target) {
	const existing = readText(p.stubFile);
	if (existing === undefined) return;
	const loaded = /const FALLBACK_ROOT = "([^"]*)";/.exec(existing)?.[1];
	if (loaded && sameSensor(loaded, target.root)) return;
	const template = readText(path.join(target.root, "extension", "stub.ts.tpl"));
	const next = template !== undefined ? renderStub(template, target) : existing.replace(RELEASE_LINE, () => `// omo-health release ${target.version}`);
	if (next !== existing) writeAtomic(p.stubFile, next);
}

// ---------------------------------------------------------------- start

function relaunch(p, reason) {
	releaseOwnLock(p);
	if (!exists(p.launcher)) {
		log(p, "relaunch_skipped", { reason, missing: p.launcher });
		return;
	}
	const child = spawn("wscript.exe", [p.launcher], { detached: true, windowsHide: true, stdio: "ignore" });
	child.on("error", (error) => log(p, "relaunch_failed", { reason, error: error.message }));
	child.unref();
	log(p, "relaunched", { reason, pid: child.pid });
}

function startFailed(p, current, error) {
	const now = Date.now();
	const text = String(error?.stack ?? error);
	console.error(text);
	markStopped(p, "start-failed", now);
	recordDeath(p, "start-failed", now, { version: current.version, error: text.slice(0, 4000) });
	return 1;
}

async function start(p, current, args) {
	process.env.OMO_HEALTH_VIA_BOOT = "1";
	let code;
	try {
		const mod = await import(pathToFileURL(binOf(current.root)).href);
		if (typeof mod.main !== "function") throw new Error(`${binOf(current.root)} does not export main()`);
		code = await mod.main(["daemon", ...args]);
	} catch (error) {
		return startFailed(p, current, error);
	}
	const hb = readJson(p.daemonJson);
	if (hb?.pid === process.pid && ["update", "rollback", "restart"].includes(hb.exitReason)) {
		relaunch(p, hb.exitReason);
		return 0;
	}
	return Number.isInteger(code) ? code : 0;
}

async function passThrough(p, argv) {
	const current = readCurrent(p);
	const root = [current?.root, current?.lkg?.root].find((r) => typeof r === "string" && exists(binOf(r)));
	if (!root) {
		console.error(`omo-health: no runnable root in ${p.currentFile}`);
		return 1;
	}
	const mod = await import(pathToFileURL(binOf(root)).href);
	return mod.main(argv);
}

async function boot(argv) {
	const [command, ...args] = argv;
	const p = resolveBootPaths(process.env);
	if (command !== "daemon") return passThrough(p, argv);
	const now = Date.now();
	const current = readCurrent(p);
	if (!current) {
		recordDeath(p, "start-failed", now, { version: null, error: `${p.currentFile} is missing or invalid` });
		console.error(`omo-health: ${p.currentFile} is missing or invalid`);
		return 1;
	}
	const state = readBootState(p);
	step(p, "death-check", () => checkPreviousRun(p, state, now));
	step(p, "save-state", () => saveBootState(p, state));
	step(p, "stub", () => writeStub(p, current));
	return start(p, current, args);
}

boot(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code ?? 0;
	},
	(error) => {
		console.error(error?.stack ?? error);
		process.exitCode = 1;
	},
);
