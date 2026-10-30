import path from "node:path";
import { atomicWriteJson, listDirSafe, readJsonSafe, removeSafe } from "../util/fsx.mjs";

const DAY_MS = 24 * 60 * 60_000;
const GAP_FILE = /^\d+\.json$/;

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecentGap(dir) {
	const gaps = [];
	for (const name of listDirSafe(dir)) {
		if (!GAP_FILE.test(name)) continue;
		const file = path.join(dir, name);
		const record = readJsonSafe(file);
		if (!record || typeof record !== "object") continue;
		const upAtMs = finite(record.upAtMs);
		if (upAtMs === undefined) continue;
		gaps.push({ file, record, upAtMs });
	}
	return gaps;
}

function pruneGaps(dir, now, keepDays) {
	const cutoff = now - Math.max(0, keepDays) * DAY_MS;
	for (const { file, upAtMs } of readRecentGap(dir)) {
		if (upAtMs >= cutoff) continue;
		removeSafe(file);
	}
}

/**
 * Record the gap between the previous daemon heartbeat and this start, before the new daemon overwrites
 * daemon.json and state.json. A gap under bootGap.minGapMs is ignored; a gap long enough to matter is
 * classified by whether the machine also rebooted during it (D23).
 */
export function readDowntime({ paths, now, uptimeMs, config }) {
	const daemon = readJsonSafe(paths.health.daemonJson) ?? {};
	const state = readJsonSafe(paths.health.stateFile) ?? {};
	const candidates = [finite(daemon.ts), finite(daemon.stoppedMs), finite(state.savedMs)].filter((value) => value !== undefined);
	if (candidates.length === 0) return { kind: "none" };
	const prevMs = Math.max(...candidates);
	const gapMs = now - prevMs;
	if (gapMs < config.bootGap.minGapMs) return { kind: "none", gapMs };
	// No omo host was alive when the previous daemon exited, so nothing in the gap could have been cut off.
	if (daemon.exitReason === "idle-no-omo-hosts") return { kind: "none", gapMs, exitReason: daemon.exitReason };
	const bootMs = now - uptimeMs;
	const record = {
		v: 1,
		kind: bootMs > prevMs - 60_000 ? "reboot" : "daemon-down",
		downSinceMs: prevMs,
		upAtMs: now,
		gapMs,
		bootMs,
		prevPid: daemon.pid ?? null,
		exitReason: daemon.exitReason ?? null,
	};
	atomicWriteJson(path.join(paths.health.bootGapsDir, `${prevMs}.json`), record);
	pruneGaps(paths.health.bootGapsDir, now, config.bootGap.keepDays);
	return record;
}

/** The newest recorded downtime that ended within the window (D23 acts only on these). */
export function latestBootGap({ paths, now, windowMs }) {
	const since = now - windowMs;
	let latest;
	for (const { record, upAtMs } of readRecentGap(paths.health.bootGapsDir)) {
		if (upAtMs < since) continue;
		if (!latest || upAtMs > latest.upAtMs) latest = { ...record, upAtMs };
	}
	return latest;
}

/** This start's own gap when it matters, otherwise the newest one still in the action window. */
export function currentDowntime({ paths, now, uptimeMs, config }) {
	const record = readDowntime({ paths, now, uptimeMs, config });
	if (record.kind === "reboot" || record.kind === "daemon-down") return record;
	return latestBootGap({ paths, now, windowMs: config.bootGap.windowMs });
}
