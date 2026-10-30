import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../util/text.mjs";
import { toMs } from "../util/time.mjs";
import { ensureNativeWorker } from "./native-worker.mjs";

export const PS_WORKER_SCRIPT = path.resolve(fileURLToPath(new URL("../../scripts/ps-worker.ps1", import.meta.url)));

/**
 * Process source for the daemon: the native worker (scripts/procs-worker.cs, ~28 MB)
 * when it can be built, else the PowerShell worker (~110 MB and growing). Same protocol.
 */
export function createProcessSource({ binDir, ensureImpl = ensureNativeWorker, log, ...rest } = {}) {
	const exe = binDir ? ensureImpl({ binDir, log }) : undefined;
	if (exe) return createWorkerSource({ ...rest, log, command: exe, args: [], kind: "native" });
	return createPowerShellSource({ ...rest, log });
}

/** PowerShell worker (fallback, and the reference implementation of the protocol). */
export function createPowerShellSource({ scriptPath = PS_WORKER_SCRIPT, ...rest } = {}) {
	return createWorkerSource({ ...rest, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], kind: "powershell" });
}

/**
 * Long-lived worker process (one for the daemon's lifetime; see F-11: a CIM
 * snapshot of ~500 processes costs ~95 ms CPU). Requests are serialized.
 */
function createWorkerSource({ command, args, kind, spawnImpl = spawn, timeoutMs = 30_000, log }) {
	let child = null;
	let buffer = "";
	let starts = 0;
	const queue = [];
	let chain = Promise.resolve();

	function start() {
		starts += 1;
		child = spawnImpl(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const current = child;
		buffer = "";
		current.stdout.setEncoding("utf8");
		current.stdout.on("data", (text) => {
			buffer += text;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).replace(/^\uFEFF/, "").trim();
				buffer = buffer.slice(index + 1);
				if (line) {
					const waiter = queue.shift();
					if (waiter) {
						try {
							waiter.resolve(JSON.parse(line));
						} catch (error) {
							waiter.reject(new Error(`worker sent invalid JSON: ${error.message}`));
						}
					}
				}
				index = buffer.indexOf("\n");
			}
		});
		current.stderr.on("data", (text) => log?.warn?.("ps_worker_stderr", { text: String(text).slice(0, 500) }));
		current.on("error", (error) => {
			log?.warn?.("ps_worker_error", { error: error.message });
		});
		current.on("exit", (code) => {
			if (child === current) child = null;
			while (queue.length) queue.shift().reject(new Error(`ps worker exited (${code})`));
		});
	}

	function request(cmd) {
		const run = () =>
			new Promise((resolve, reject) => {
				if (!child) start();
				const current = child;
				const timer = setTimeout(() => {
					const index = queue.indexOf(entry);
					if (index >= 0) queue.splice(index, 1);
					try {
						current.kill();
					} catch {
						// already gone
					}
					if (child === current) child = null;
					reject(new Error(`ps worker timeout on ${cmd}`));
				}, timeoutMs);
				const entry = {
					resolve: (value) => {
						clearTimeout(timer);
						if (!value.ok) reject(new Error(`ps worker ${cmd} failed: ${value.error}`));
						else resolve(value);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				};
				queue.push(entry);
				current.stdin.write(`${cmd}\n`);
			});
		const result = chain.then(run, run);
		chain = result.catch(() => {});
		return result;
	}

	return {
		kind,
		async snapshot() {
			const response = await request("snap");
			return { takenAtMs: toMs(response.ts) ?? Date.now(), rows: normalizeRows(response.data), integrity: integrityOf(response.il) };
		},
		async os() {
			const { data } = await request("os");
			return normalizeOs(data);
		},
		async ports() {
			const { data } = await request("ports");
			return (Array.isArray(data) ? data : [data]).filter(Boolean).map((row) => ({ address: row.a, port: row.port, pid: row.p }));
		},
		get pid() {
			return child?.pid;
		},
		get restarts() {
			return Math.max(0, starts - 1);
		},
		close() {
			if (!child) return;
			try {
				child.stdin.write("exit\n");
				child.stdin.end();
			} catch {
				// ignore
			}
			const current = child;
			setTimeout(() => {
				try {
					current.kill();
				} catch {
					// ignore
				}
			}, 2000).unref();
			child = null;
		},
	};
}

/**
 * Windows mandatory integrity level as its RID (0x2000 medium, 0x3000 high, 0x4000 system), from the native worker.
 * A non-elevated daemon cannot terminate an elevated process, so kills compare it with the table's own `integrity`.
 */
function integrityOf(value) {
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeRows(data) {
	const rows = Array.isArray(data) ? data : data ? [data] : [];
	return rows.map((row) => ({
		pid: row.p,
		ppid: row.pp,
		name: String(row.n ?? ""),
		ctime: row.c ?? null,
		ctimeMs: toMs(row.c) ?? 0,
		cpuMs: Number(row.cpu ?? 0),
		privBytes: Number(row.pv ?? 0),
		wsBytes: Number(row.ws ?? 0),
		readBytes: Number(row.rb ?? 0),
		writeBytes: Number(row.wb ?? 0),
		cmd: row.cl ?? "",
		...(integrityOf(row.il) === undefined ? {} : { il: row.il }),
		// wv/wt: the process owns a visible top-level window, and its title (absent in older workers and fixtures).
		...(row.wv === undefined ? {} : { windowVisible: row.wv === true }),
		...(typeof row.wt === "string" && row.wt ? { windowTitle: redact(row.wt) } : {}),
	}));
}

export function normalizeOs(data) {
	if (!data) return undefined;
	const limit = Number(data.totalVirtualKB) * 1024;
	const free = Number(data.freeVirtualKB) * 1024;
	// A missing field must not read as "commit exhausted" (that would trip the machine guard).
	if (!(limit > 0) || data.freeVirtualKB === null || data.freeVirtualKB === undefined || !Number.isFinite(free)) return undefined;
	return {
		commitLimitBytes: limit,
		commitUsedBytes: limit - free,
		commitFrac: limit > 0 ? (limit - free) / limit : 0,
		physTotalBytes: Number(data.totalVisibleKB) * 1024,
		physFreeBytes: Number(data.freePhysicalKB) * 1024,
	};
}

/**
 * Replays recorded snapshots (NDJSON lines of {ts, procs:[raw rows], os, ports})
 * against an injected clock. Used by replay fixtures and tests.
 */
export function createFixtureSource({ records, file, clock }) {
	const list = (records ?? fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)))
		.map((record) => ({ ...record, ms: toMs(record.ts) }))
		.sort((a, b) => a.ms - b.ms);
	const current = () => {
		let chosen;
		for (const record of list) {
			if (record.ms <= clock.now()) chosen = record;
			else break;
		}
		return chosen;
	};
	return {
		kind: "fixture",
		async snapshot() {
			const record = current();
			return { takenAtMs: record?.ms ?? clock.now(), rows: normalizeRows(record?.procs ?? []) };
		},
		async os() {
			return normalizeOs(current()?.os);
		},
		async ports() {
			return (current()?.ports ?? []).map((row) => ({ address: row.a ?? "127.0.0.1", port: row.port, pid: row.p }));
		},
		pid: undefined,
		restarts: 0,
		close() {},
	};
}

/**
 * Keeps short per-process history across snapshots so CPU fraction (share of
 * one core) and private-memory growth can be computed. Identity is pid +
 * creation time, so a reused PID never inherits another process's history.
 */
export class ProcessTracker {
	constructor({ historySize = 40, birthKeepMs = 15 * 60_000 } = {}) {
		this.historySize = historySize;
		this.birthKeepMs = birthKeepMs;
		this.history = new Map();
		/** Processes first seen in a snapshot and created after the previous one (see respawnStorms). */
		this.births = [];
		this.snapshotTimes = [];
		this.table = new ProcessTable([], 0, this);
	}

	update({ rows, takenAtMs, integrity }) {
		const seen = new Set();
		const prevT = this.snapshotTimes.at(-1);
		const fresh = new Set();
		for (const row of rows) {
			const key = procKey(row);
			seen.add(key);
			let samples = this.history.get(key);
			if (!samples) {
				samples = [];
				this.history.set(key, samples);
				// Born since the last snapshot (not merely first seen after a daemon start).
				if (prevT !== undefined && takenAtMs > prevT && row.ctimeMs > prevT) fresh.add(row.pid);
			}
			const last = samples.at(-1);
			if (!last || last.t !== takenAtMs) samples.push({ t: takenAtMs, cpuMs: row.cpuMs, priv: row.privBytes, wb: row.writeBytes ?? 0 });
			if (samples.length > this.historySize) samples.shift();
		}
		for (const key of this.history.keys()) if (!seen.has(key)) this.history.delete(key);
		this.table = new ProcessTable(rows, takenAtMs, this, integrity);
		if (prevT === undefined || takenAtMs > prevT) {
			for (const birth of this.births) if (birth.lastT === prevT && seen.has(birth.key)) birth.lastT = takenAtMs;
			for (const row of rows) if (fresh.has(row.pid)) this.births.push(birthOf(row, this.table, fresh, takenAtMs));
			this.snapshotTimes.push(takenAtMs);
			const keepFrom = takenAtMs - this.birthKeepMs;
			while (this.snapshotTimes.length && this.snapshotTimes[0] < keepFrom) this.snapshotTimes.shift();
			if (this.births.length && this.births[0].t < keepFrom) this.births = this.births.filter((b) => b.t >= keepFrom);
			if (this.births.length > MAX_BIRTHS) this.births = this.births.slice(-MAX_BIRTHS);
		}
		return this.table;
	}

	samples(proc) {
		return this.history.get(procKey(proc)) ?? [];
	}
}

export function procKey(proc) {
	return `${proc.pid}@${proc.ctime ?? proc.ctimeMs}`;
}

const MAX_BIRTHS = 5000;
const BIRTH_SHELLS = new Set(["bash.exe", "sh.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "bash", "sh"]);
/** Never a relaunch loop by themselves: console hosts and the sleepers of polling loops. */
const RESPAWN_EXEMPT = new Set(["conhost.exe", "openconsole.exe", "sleep.exe", "timeout.exe", "ping.exe", "choice.exe", "waitfor.exe", "sleep"]);

/** Comparable command of a relaunch: path separators, case, hex handles and long numbers do not matter. */
export function respawnSignature(cmd) {
	const text = String(cmd ?? "").trim();
	if (!text) return "";
	return text.replace(/\\/g, "/").replace(/"/g, "").toLowerCase().replace(/0x[0-9a-f]+/g, "#").replace(/\d{4,}/g, "#").replace(/\s+/g, " ");
}

function birthOf(row, table, fresh, t) {
	const ancestors = table.ancestors(row.pid);
	const parent = ancestors[0];
	const name = row.name.toLowerCase();
	// Respawner: the nearest ancestor that already ran before this snapshot (a fresh ancestor was just
	// spawned this interval, so it is part of the same launch chain, not the launcher).
	const anchor = ancestors.find((proc) => !fresh.has(proc.pid));
	return {
		key: procKey(row),
		pid: row.pid,
		name,
		sig: respawnSignature(row.cmd),
		cmdHead: String(row.cmd ?? "").slice(0, 200),
		t,
		lastT: t,
		parentShell: Boolean(parent && BIRTH_SHELLS.has(parent.name.toLowerCase())),
		anchorKey: anchor ? procKey(anchor) : undefined,
		anchorPid: anchor?.pid,
		ancestorPids: ancestors.slice(0, 12).map((proc) => proc.pid),
	};
}

/**
 * Programs relaunched over and over (D17): a new instance of the same program shows up in nearly every
 * snapshot for several minutes, almost none survives to the next snapshot, and the instances run few
 * distinct commands. Shell children (polling loops of a script) and console hosts are not counted.
 * `respawner` is a live process that kept launching them, when snapshots caught one of its children.
 */
export function respawnStorms(tracker, table, now, cfg) {
	if (!tracker || !cfg) return [];
	const from = now - cfg.windowMs;
	const snaps = tracker.snapshotTimes.filter((t) => t > from && t <= now);
	if (snaps.length < cfg.minSnapshots) return [];
	const lastT = snaps.at(-1);
	const groups = new Map();
	for (const birth of tracker.births) {
		// Unreadable command lines cannot prove the program relaunched the same way.
		if (birth.t <= from || birth.t > now || birth.parentShell || RESPAWN_EXEMPT.has(birth.name) || !birth.sig) continue;
		const key = `${birth.name}|${birth.sig}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(birth);
	}
	const storms = [];
	for (const [key, births] of groups) {
		const name = key.slice(0, key.indexOf("|"));
		if (births.length < cfg.minBirths) continue;
		const present = new Set(births.map((b) => b.t));
		if (present.size < cfg.presenceFrac * snaps.length) continue;
		// A birth of the latest snapshot has not had the chance to survive yet.
		const judged = births.filter((b) => b.t < lastT);
		const survivors = judged.filter((b) => b.lastT > b.t).length;
		if (!judged.length || survivors > cfg.maxSurvivorFrac * judged.length) continue;
		const anchors = new Map();
		for (const b of births) if (b.anchorKey) anchors.set(b.anchorKey, (anchors.get(b.anchorKey) ?? 0) + 1);
		const [respawnerKey, respawnerCount] = [...anchors].sort((a, b) => b[1] - a[1])[0] ?? [];
		const respawnerPid = respawnerKey ? Number(respawnerKey.split("@")[0]) : undefined;
		const respawner = respawnerCount >= 2 && table?.get(respawnerPid) && procKey(table.get(respawnerPid)) === respawnerKey ? table.get(respawnerPid) : undefined;
		storms.push({
			name,
			births: births.length,
			snapshots: snaps.length,
			present: present.size,
			survivors,
			firstMs: births[0].t,
			lastMs: births.at(-1).t,
			cmdHead: births[0].cmdHead,
			respawner,
			respawnerBirths: respawner ? respawnerCount : 0,
			ancestorPids: [...new Set(births.flatMap((b) => b.ancestorPids))],
		});
	}
	return storms;
}

export class ProcessTable {
	/** integrity: the collecting (daemon) process's own integrity RID, when the worker reports it. */
	constructor(rows, takenAtMs, tracker, integrity) {
		this.takenAtMs = takenAtMs;
		this.tracker = tracker;
		this.integrity = integrityOf(integrity);
		this.byPid = new Map();
		this.childrenOf = new Map();
		for (const row of rows) this.byPid.set(row.pid, row);
		for (const row of rows) {
			const parent = this.byPid.get(row.ppid);
			// A parent created after the child is a reused PID: the real parent is dead.
			if (!parent || parent.pid === row.pid || parent.ctimeMs > row.ctimeMs) continue;
			if (!this.childrenOf.has(parent.pid)) this.childrenOf.set(parent.pid, []);
			this.childrenOf.get(parent.pid).push(row);
		}
	}

	get size() {
		return this.byPid.size;
	}

	all() {
		return [...this.byPid.values()];
	}

	get(pid) {
		return this.byPid.get(pid);
	}

	isAlive(pid, ctime) {
		const proc = this.byPid.get(pid);
		if (!proc) return false;
		return ctime === undefined || proc.ctime === ctime;
	}

	parentOf(proc) {
		const parent = this.byPid.get(proc.ppid);
		if (!parent || parent.pid === proc.pid || parent.ctimeMs > proc.ctimeMs) return undefined;
		return parent;
	}

	isOrphan(proc) {
		return this.parentOf(proc) === undefined;
	}

	children(pid) {
		return this.childrenOf.get(pid) ?? [];
	}

	descendants(pid) {
		const out = [];
		const stack = [...this.children(pid)];
		const seen = new Set();
		while (stack.length) {
			const proc = stack.pop();
			if (seen.has(proc.pid)) continue;
			seen.add(proc.pid);
			out.push(proc);
			stack.push(...this.children(proc.pid));
		}
		return out;
	}

	ancestors(pid) {
		const out = [];
		let current = this.byPid.get(pid);
		const seen = new Set();
		while (current) {
			const parent = this.parentOf(current);
			if (!parent || seen.has(parent.pid)) break;
			seen.add(parent.pid);
			out.push(parent);
			current = parent;
		}
		return out;
	}

	isDescendantOf(pid, ancestorPid) {
		return this.ancestors(pid).some((proc) => proc.pid === ancestorPid);
	}

	/** CPU share of one core over each of the last `n` snapshot intervals. */
	cpuFracs(proc, n = 2) {
		const samples = this.tracker ? this.tracker.samples(proc) : [];
		const fracs = [];
		for (let i = samples.length - 1; i > 0 && fracs.length < n; i--) {
			const dt = samples[i].t - samples[i - 1].t;
			if (dt <= 0) continue;
			fracs.push(Math.max(0, (samples[i].cpuMs - samples[i - 1].cpuMs) / dt));
		}
		return fracs;
	}

	/** Private-bytes growth in MB/min over (at most) the last `windowMs`. */
	growthMBPerMin(proc, windowMs) {
		const samples = this.tracker ? this.tracker.samples(proc) : [];
		if (samples.length < 2) return 0;
		const last = samples.at(-1);
		let first = samples[0];
		for (const sample of samples) {
			if (last.t - sample.t <= windowMs) {
				first = sample;
				break;
			}
		}
		const minutes = (last.t - first.t) / 60_000;
		if (minutes <= 0) return 0;
		return (last.priv - first.priv) / (1024 * 1024) / minutes;
	}

	/** Average CPU share of one core over (at most) the last `windowMs`; undefined without 2 samples. */
	avgCpuFrac(proc, windowMs) {
		const samples = this.tracker ? this.tracker.samples(proc) : [];
		if (samples.length < 2) return undefined;
		const last = samples.at(-1);
		let first = samples[0];
		for (const sample of samples) {
			if (last.t - sample.t <= windowMs) {
				first = sample;
				break;
			}
		}
		const dt = last.t - first.t;
		return dt > 0 ? Math.max(0, (last.cpuMs - first.cpuMs) / dt) : undefined;
	}

	/** Bytes written (files and pipes) over the last `n` snapshot intervals. */
	writeBytesDelta(proc, n = 2) {
		const samples = this.tracker ? this.tracker.samples(proc) : [];
		if (samples.length < 2) return 0;
		const first = samples[Math.max(0, samples.length - 1 - n)];
		return Math.max(0, samples.at(-1).wb - first.wb);
	}

	/** How long (ms) this process has been observed. */
	observedMs(proc) {
		const samples = this.tracker ? this.tracker.samples(proc) : [];
		return samples.length ? samples.at(-1).t - samples[0].t : 0;
	}

	orphansCreatedBetween(fromMs, toMs) {
		return this.all().filter((proc) => proc.ctimeMs >= fromMs && proc.ctimeMs <= toMs && this.isOrphan(proc));
	}
}
