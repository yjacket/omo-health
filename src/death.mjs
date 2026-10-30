import { execFileSync } from "node:child_process";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config.mjs";
import { atomicWriteJson, ensureDir, readJsonSafe } from "./util/fsx.mjs";

const HUNG_MS = 3 * 60_000;
const CONFIRM_MS = 20_000;
/** A tick can wait on an analyst start for analyst.timeoutMs; this much more covers the rest of the tick. */
const TICK_GRACE_MS = 30_000;

/** Never kill a reused PID without verifying the Windows process command line. */
export function isOurDaemon(pid, exec = execFileSync) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		const line = String(exec("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 10_000 }));
		return /omo-health/i.test(line) && /(?:boot|omo-health)\.mjs/i.test(line) && /\sdaemon(?:\s|["']|$)/i.test(line);
	} catch {
		return false;
	}
}

/**
 * Confirm a hung heartbeat across a 20-second window before terminating its verified owner. The daemon stamps
 * tickStartedMs into its heartbeat when a tick starts: a tick younger than analyst.timeoutMs + 30 s (the first one after
 * a resume from sleep is the likeliest to run long) is not a hang, and a tick that starts during the window
 * stops the kill.
 */
export function killHungHolder(paths, holder, now, { exec = execFileSync, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), tickWaitMs = DEFAULT_CONFIG.analyst.timeoutMs } = {}) {
	const hb = readJsonSafe(paths.health.daemonJson);
	const tickRunning = Number.isFinite(hb?.tickStartedMs) && now - hb.tickStartedMs <= tickWaitMs + TICK_GRACE_MS;
	if (hb?.pid !== holder.pid || !Number.isFinite(hb.ts) || now - hb.ts <= HUNG_MS || tickRunning || !isOurDaemon(holder.pid, exec)) return false;
	wait(CONFIRM_MS);
	const confirmed = readJsonSafe(paths.health.daemonJson);
	const lock = readJsonSafe(paths.health.lockFile);
	if (confirmed?.pid !== holder.pid || confirmed.ts !== hb.ts || confirmed.tickStartedMs !== hb.tickStartedMs || lock?.pid !== holder.pid || !isOurDaemon(holder.pid, exec)) return false;
	try {
		exec("taskkill.exe", ["/F", "/PID", String(holder.pid)], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
	} catch {
		return false;
	}
	const ms = Date.now();
	ensureDir(paths.health.deathsDir);
	atomicWriteJson(path.join(paths.health.deathsDir, `${ms}-hung.json`), { kind: "hung", pid: holder.pid, lastTs: hb.ts, version: hb.version });
	return true;
}
