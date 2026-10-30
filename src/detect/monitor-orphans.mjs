import path from "node:path";
import { listDirSafe, readJsonSafe, statSafe } from "../util/fsx.mjs";
import { sha1 } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";
import { segmentArgv } from "./match.mjs";

export const id = "D16";
const MONTH = 30 * 24 * 3600_000;

/** Read only terminal manifests in known per-cwd session directories, including dormant ones. */
export function readMonitorManifests(paths, now) {
	const monitors = [];
	let scanned = 0;
	for (const dir of listDirSafe(paths.sessionsDir)) {
		const terminal = path.join(paths.sessionsDir, dir, "extensions", "terminal");
		for (const name of listDirSafe(terminal)) {
			if (!name.endsWith(".json")) continue;
			if (++scanned > 500) return monitors;
			const file = path.join(terminal, name);
			const stat = statSafe(file);
			if (!stat?.isFile() || now - stat.mtimeMs > MONTH) continue;
			const manifest = readJsonSafe(file);
			if (!manifest?.sessionId || !Array.isArray(manifest.monitors)) continue;
			for (const monitor of manifest.monitors) {
				// sessionDir: the owner's session file (<ISO-time>_<sessionId>.jsonl) lives next to its terminal manifest.
				if (monitor?.runtimeKind === "command" && monitor.runtime && monitor.sessionId === manifest.sessionId && monitor.monitorId) monitors.push({ ...monitor, sessionDir: path.join(paths.sessionsDir, dir) });
			}
		}
	}
	return monitors;
}

export const REMEMBER_MAX = 200;

/** senpi re-runs a persistent monitor itself after a restart (manifest: `persistent`, `durabilityClass`). */
export function isPersistent(monitor) {
	return monitor?.persistent === true || monitor?.durabilityClass === "restartable-command";
}

/** Only what matching needs, or undefined for a malformed or month-old entry. */
export function rememberedEntry(monitor, lastSeenMs, now) {
	const runtime = monitor?.runtime;
	if (!monitor || typeof monitor !== "object" || typeof monitor.sessionId !== "string" || !monitor.sessionId || typeof monitor.monitorId !== "string" || !monitor.monitorId) return undefined;
	if (monitor.runtimeKind !== "command" || typeof monitor.command !== "string" || !monitor.command.trim()) return undefined;
	if (!runtime || !Number.isInteger(runtime.pid) || !Number.isFinite(runtime.startedAtMs) || now - runtime.startedAtMs > MONTH) return undefined;
	if (!Number.isFinite(lastSeenMs)) return undefined;
	return {
		sessionId: monitor.sessionId,
		monitorId: monitor.monitorId,
		...(typeof monitor.description === "string" ? { description: monitor.description } : {}),
		runtimeKind: "command",
		command: monitor.command,
		runtime: { pid: runtime.pid, startedAtMs: runtime.startedAtMs },
		...(typeof monitor.sessionDir === "string" ? { sessionDir: monitor.sessionDir } : {}),
		...(isPersistent(monitor) ? { persistent: true } : {}),
		lastSeenMs,
	};
}

/** Keeps the REMEMBER_MAX most recently seen entries. */
export function boundRemembered(remembered) {
	return Object.fromEntries(Object.entries(remembered).sort(([, a], [, b]) => b.lastSeenMs - a.lastSeenMs).slice(0, REMEMBER_MAX));
}

/** Persisted entries, strictly validated; malformed ones are skipped. */
export function restoreRemembered(value, now) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const entry of Object.values(value)) {
		const clean = rememberedEntry(entry, entry?.lastSeenMs, now);
		if (clean) out[`${clean.sessionId}:${clean.monitorId}`] = clean;
	}
	return boundRemembered(out);
}

/**
 * senpi removes a monitor's manifest entry when it settles, possibly leaving pipeline members behind; D16 remembers
 * the entries it saw so those are still matched. The manifest copy wins over a remembered one. A remembered entry
 * with no members and no valid launcher has nothing left to reap and is dropped, but only against a fresh table.
 */
export function unionMonitors(memory, manifests, procs, now, fresh) {
	const remembered = memory.remembered ?? {};
	const keys = new Set();
	for (const monitor of manifests) {
		const key = `${monitor.sessionId}:${monitor.monitorId}`;
		keys.add(key);
		const entry = rememberedEntry(monitor, now, now);
		if (entry) remembered[key] = entry;
	}
	const out = [...manifests];
	for (const [key, entry] of Object.entries(remembered)) {
		if (keys.has(key)) continue;
		// Age is already bound on write (rememberedEntry) and on restore (restoreRemembered).
		if (fresh) {
			const { launcher, members } = watcherMembers(entry, procs);
			if (!members.length && !launcher) { delete remembered[key]; continue; }
		}
		out.push(entry);
	}
	memory.remembered = boundRemembered(remembered);
	return out;
}

/** The owner's session file next to its manifest, when it still exists. */
export function sessionFileFor(sessionDir, sessionId) {
	if (typeof sessionDir !== "string" || !sessionId) return undefined;
	const name = listDirSafe(sessionDir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
	return name ? path.join(sessionDir, name) : undefined;
}

/**
 * Windows denies terminating a process of higher integrity: such a kill is never planned. Unknown integrity on
 * either side (PowerShell worker, old fixtures) keeps the previous behavior.
 */
export function beyondReach(targets, procs) {
	return Number.isInteger(procs?.integrity) && targets.some((proc) => Number.isInteger(proc.il) && proc.il > procs.integrity);
}

/** Only a bare, unquoted pipe separates watcher processes. */
function pipeline(command) {
	const parts = [];
	let quote = null;
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if ((char === "'" || char === '"') && command[i - 1] !== "\\") {
			if (!quote) quote = char;
			else if (quote === char) quote = null;
		} else if (char === "|" && !quote && command[i + 1] !== "|" && command[i - 1] !== "|") {
			parts.push(command.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(command.slice(start).trim());
	return parts.filter(Boolean);
}

function shellCommand(proc, command) {
	if (!/^(bash|sh)(\.exe)?$/i.test(proc.name)) return false;
	const cmd = String(proc.cmd ?? "");
	const marker = cmd.match(/(?:^|\s)-c\s+/);
	if (!marker) return false;
	const tail = cmd.slice(marker.index + marker[0].length).trim();
	return tail === command || tail === `"${command.replace(/"/g, '\\"')}"` || tail === `'${command}'`;
}

function within(proc, start, before, after) {
	return Number.isFinite(proc.ctimeMs) && proc.ctimeMs > 0 && proc.ctimeMs >= start - before && proc.ctimeMs <= start + after;
}

/**
 * No parent-pid inference for members: MSYS pipeline members often have dead parents from birth.
 * `live`: the launcher still runs under its senpi host. senpi kills only the launcher when a monitor
 * ends, so launcher-gone or host-gone is decided from processes alone, never from a sensor heartbeat.
 */
export function watcherMembers(monitor, procs) {
	const { runtime, command } = monitor;
	if (monitor.runtimeKind !== "command" || !runtime || !Number.isFinite(runtime.startedAtMs) || !Number.isInteger(runtime.pid) || typeof command !== "string" || !command.trim()) return { launcher: undefined, members: [], live: false };
	const start = runtime.startedAtMs;
	const launcher = procs.get(runtime.pid);
	const validLauncher = launcher && within(launcher, start, 3000, 3000) && shellCommand(launcher, command) ? launcher : undefined;
	const segments = pipeline(command).map(segmentArgv);
	const members = procs.all().filter((proc) => {
		if (!within(proc, start, 3000, 30_000)) return false;
		if (proc.pid === runtime.pid) return proc === validLauncher;
		if (shellCommand(proc, command)) return true;
		const argv = segmentArgv(proc.cmd ?? "");
		return segments.some((segment) => segment.length && segment.every((token) => !token.variable)
			&& JSON.stringify(argv) === JSON.stringify(segment)
			&& proc.name.replace(/\.exe$/i, "").toLowerCase() === segment[0].text);
	});
	return { launcher: validLauncher, members, live: Boolean(validLauncher && procs.parentOf(validLauncher)) };
}

export function detect(world, memory = {}) {
	if (!world.config.monitorOrphans?.enabled || !world.procsFresh || world.self?.mode === "history") return [];
	if (!memory.active) memory.active = {};
	if (!memory.done) memory.done = {};
	const active = memory.active;
	const done = memory.done;
	const seen = new Set();
	const out = [];
	const owned = new Set();
	for (const monitor of world.monitors ?? []) {
		const { live, members } = watcherMembers(monitor, world.procs);
		if (live) for (const proc of members) owned.add(proc.pid);
	}
	for (const monitor of world.monitors ?? []) {
		const key = `${monitor.sessionId}:${monitor.monitorId}`;
		seen.add(key);
		if (done[key]) continue;
		const { live, members } = watcherMembers(monitor, world.procs);
		if (!members.length || live || members.some((proc) => owned.has(proc.pid)) || beyondReach(members, world.procs)) { delete active[key]; continue; }
		// Only for the notice: a running owner already got senpi's own "monitor ended" message.
		const hb = world.sensorFor(monitor.sessionId);
		active[key] ??= world.now;
		if (world.now - active[key] < world.config.monitorOrphans.graceMs) continue;
		out.push(makeFinding({ detector: id, kind: "orphan-monitor", severity: "info",
			subject: { sessionId: monitor.sessionId, key },
			titleKo: "소유자가 없는 monitor 감시 프로세스 정리",
			data: { monitorId: monitor.monitorId, description: monitor.description ?? monitor.monitorId, sessionDir: monitor.sessionDir, persistent: isPersistent(monitor), ownerPresent: Boolean(hb && world.procs.isAlive(hb.pid)),
				remedy: { kind: "kill-orphan-watchers", targets: members.map((proc) => ({ pid: proc.pid, ctime: proc.ctime, cmdSha1: sha1(proc.cmd ?? ""), name: proc.name })) } },
		}));
	}
	for (const key of Object.keys(active)) if (!seen.has(key)) delete active[key];
	return out;
}
