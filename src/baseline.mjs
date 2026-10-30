import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db/db.mjs";
import { readJsonSafe } from "./util/fsx.mjs";

/**
 * Baseline-deviation signals (#55 C). The rules only flag "suspicious"; these signals flag it without a rule for the
 * case: an owner (a pending tool call and the process tree the D1 matcher gave it) doing much more than this machine's
 * owners usually do. Once per config.baseline.sampleMs an owner's rates over rateWindowMs are measured:
 *   births  processes born per minute under the tree (D17's ProcessTracker births, whose ancestors include a member)
 *   cpu     CPU cores the tree uses
 *   mem     private-memory growth of the tree, MB/min
 *   writes  bytes the tree writes, MB/min
 * and so, every tempScanMs, is the machine's temp-file growth (files/min). A file cannot be traced to the process that
 * made it without handle tracing, so temp growth is machine-wide: it is reported along with an owner's deviation and
 * raises nothing by itself.
 * Every sample that does not deviate joins a rolling window (the last windowMs, at most maxSamples per metric), saved
 * in the baseline_samples table of ~/.omo-health/omo-health.db (a legacy baseline.json is imported once and renamed
 * baseline.json.imported); a deviating one stays out, so a runaway owner cannot raise the usual values to its own. A value deviates when it is at least the metric's floor, above the window's `quantile`
 * and at least zMin robust z-scores (median, 1.4826 * MAD) above the median, for persistSamples samples in a row.
 * Cold start: nothing deviates before a metric has minSamples samples and the first sample is minSpanMs old, so a fresh
 * install never fires. A deviation is evidence for the triage (an earlier tier-1 look); it never acts on its own.
 */

export const OWNER_METRICS = Object.freeze(["births", "cpu", "mem", "writes"]);
const METRICS = [...OWNER_METRICS, "temp"];
const UNITS = { births: "/min", cpu: " cores", mem: " MB/min", writes: " MB/min", temp: " files/min" };
const MB = 1024 * 1024;

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Linearly interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
	if (!sorted.length) return undefined;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median, median absolute deviation and the ascending values (for quantiles). */
export function robustStats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const median = quantile(sorted, 0.5);
	const mad = quantile(values.map((value) => Math.abs(value - median)).sort((a, b) => a - b), 0.5);
	return { n: sorted.length, sorted, median, mad };
}

/** The owner a D1 stall finding is about: its session and tool call. */
export function ownerKeyOf(finding) {
	return `${finding.subject?.sessionId ?? "?"}:${finding.subject?.toolCallId ?? "?"}`;
}

/**
 * One owner's rates from `fromMs` to `now`: births per minute of processes whose ancestors at birth include a member
 * (or that are members), and the members' CPU cores, private-memory growth and writes (MB/min) between their first and
 * last sample in the window. `members`: tagged processes ({pid, ctime}) of the tree; a pid now held by another process
 * is skipped.
 */
export function ownerMetrics({ procs, members, fromMs, now }) {
	const tracker = procs.tracker;
	const pids = new Set(members.map((member) => member.pid));
	const minutes = Math.max(1, (now - fromMs) / 60_000);
	let births = 0;
	for (const birth of tracker?.births ?? []) {
		if (birth.t <= fromMs || birth.t > now) continue;
		if (pids.has(birth.pid) || birth.ancestorPids.some((pid) => pids.has(pid))) births += 1;
	}
	let cpu = 0;
	let mem = 0;
	let writes = 0;
	for (const member of members) {
		const proc = procs.get(member.pid);
		if (!proc || (member.ctime !== undefined && proc.ctime !== member.ctime)) continue;
		const samples = (tracker?.samples(proc) ?? []).filter((sample) => sample.t >= fromMs);
		if (samples.length < 2) continue;
		const first = samples[0];
		const last = samples.at(-1);
		const dt = last.t - first.t;
		if (dt <= 0) continue;
		cpu += Math.max(0, (last.cpuMs - first.cpuMs) / dt);
		mem += Math.max(0, (last.priv - first.priv) / MB) / (dt / 60_000);
		writes += Math.max(0, (last.wb - first.wb) / MB) / (dt / 60_000);
	}
	return { births: births / minutes, cpu, mem, writes };
}

/**
 * Files in the machine's temp directory and one level below it; `cap` bounds the work (a browser profile can hold
 * tens of thousands). Undefined when the directory cannot be read.
 */
export function countTempFiles(dir, { cap = 50_000 } = {}) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let count = 0;
	for (const entry of entries) {
		if (count >= cap) break;
		if (!entry.isDirectory()) {
			count += 1;
			continue;
		}
		try {
			count += fs.readdirSync(path.join(dir, entry.name)).length;
		} catch {
			// A subdirectory another user or a running installer holds: its files are not counted this time.
		}
	}
	return Math.min(count, cap);
}

/**
 * @param {{ tempFiles?: () => number|undefined, db?: import("node:sqlite").DatabaseSync|null, dbError?: Error }} opts
 *   tempFiles: the temp-file counter (the daemon counts os.tmpdir(); tests inject one; without it the temp metric is not sampled).
 *   db: the daemon's open (single-writer) connection; the caller owns it and closes it. Omitted: a private ":memory:"
 *   one (tests, scan, replay: nothing reaches a file). null: the daemon could not open its DB (dbError says why); the
 *   baseline runs in memory only and logs baseline_db_failed.
 */
export function createBaseline({ paths, config, clock, log, tempFiles, db: injected, dbError }) {
	const file = paths.health.baselineFile;
	const cfg = () => config.baseline;
	let db = injected === undefined ? openDb({ file: ":memory:" }) : injected;
	if (db === null) log?.warn?.("baseline_db_failed", { phase: "open", error: dbError?.message ?? "no database" });
	/** Samples added since the last save, [metric, t, value]. */
	let pending = [];
	const state = load();
	const statsCache = new Map();
	const owners = new Map();
	let dirty = false;
	let lastSaveMs = clock.now();
	let lastTemp;
	let machine = [];
	/** When owner deviations fired (became active), and when a learned-normal pattern's deviation was kept quiet, for the last day. */
	const fires = [];
	const quieted = [];

	/** Rows of baseline_samples as {metric: [[t, value], ...]} (oldest first), or undefined when the table cannot be read. */
	function readRows() {
		if (!db) return undefined;
		try {
			const samples = Object.fromEntries(METRICS.map((metric) => [metric, []]));
			for (const row of db.prepare("SELECT metric, t, value FROM baseline_samples ORDER BY t, rowid").iterate()) samples[row.metric]?.push([row.t, row.value]);
			return samples;
		} catch (error) {
			log?.warn?.("baseline_db_failed", { phase: "load", error: error.message });
			db = null;
			return undefined;
		}
	}

	/** The legacy baseline.json's samples ({metric: [[t, value], ...]}), or undefined when there is no readable file. */
	function readLegacy() {
		const saved = readJsonSafe(file, undefined);
		if (!saved || typeof saved !== "object") return undefined;
		const samples = {};
		for (const metric of METRICS) {
			const list = saved.samples?.[metric];
			samples[metric] = Array.isArray(list) ? list.filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1])) : [];
		}
		return samples;
	}

	/** One-time import of baseline.json into an empty table; the file is renamed (never deleted) once the rows are in. */
	function importLegacy(samples) {
		if (!db) return;
		try {
			db.exec("BEGIN IMMEDIATE");
			try {
				const insert = db.prepare("INSERT INTO baseline_samples (metric, t, value) VALUES (?, ?, ?)");
				for (const metric of METRICS) for (const [t, value] of samples[metric]) insert.run(metric, t, value);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} catch (error) {
			log?.warn?.("baseline_db_failed", { phase: "import", error: error.message });
			db = null;
			return;
		}
		// A private in-memory DB (tests, scan, replay) would lose the rows with the process: keep the file for the next run.
		if (db.location() === null) return;
		try {
			fs.renameSync(file, `${file}.imported`);
			log?.info?.("baseline_imported", { file });
		} catch (error) {
			log?.warn?.("baseline_import_rename_failed", { error: error.message });
		}
	}

	function load() {
		let samples = readRows();
		if (!samples || METRICS.every((metric) => !samples[metric].length)) {
			const legacy = readLegacy();
			if (legacy) {
				samples = legacy;
				importLegacy(legacy);
			}
		}
		samples ??= Object.fromEntries(METRICS.map((metric) => [metric, []]));
		const firsts = METRICS.map((metric) => samples[metric][0]?.[0]).filter(Number.isFinite);
		return { v: 1, firstMs: firsts.length ? Math.min(...firsts) : undefined, samples };
	}

	function add(metric, t, value) {
		const c = cfg();
		const list = state.samples[metric];
		list.push([t, round(value, 3)]);
		let old = 0;
		while (old < list.length && list[old][0] < t - c.windowMs) old += 1;
		const drop = Math.max(old, list.length - c.maxSamples);
		if (drop > 0) list.splice(0, drop);
		state.firstMs ??= t;
		pending.push([metric, t, list.at(-1)[1]]);
		statsCache.delete(metric);
		dirty = true;
	}

	/** This machine's usual values of a metric, or undefined while it is cold. */
	function statsOf(metric, now) {
		const c = cfg();
		const list = state.samples[metric];
		if (list.length < c.minSamples || state.firstMs === undefined || now - state.firstMs < c.minSpanMs) return undefined;
		if (!statsCache.has(metric)) statsCache.set(metric, robustStats(list.map((sample) => sample[1])));
		return statsCache.get(metric);
	}

	/** How far `value` is above the usual values of `metric`, or undefined when it is not a deviation. */
	function deviationOf(metric, value, now) {
		const c = cfg();
		const stats = statsOf(metric, now);
		if (!stats || !(value >= (c.floors?.[metric] ?? 0))) return undefined;
		const q = quantile(stats.sorted, c.quantile);
		const z = (value - stats.median) / Math.max(1.4826 * stats.mad, 1e-6);
		if (!(value > q) || z < c.zMin) return undefined;
		return { metric, value: round(value), median: round(stats.median), q: round(q), z: round(Math.min(z, 999), 1), unit: UNITS[metric] };
	}

	function sampleTemp(now) {
		const count = tempFiles();
		if (!Number.isFinite(count)) return;
		if (lastTemp && now > lastTemp.t) {
			const perMin = Math.max(0, count - lastTemp.count) / ((now - lastTemp.t) / 60_000);
			const found = deviationOf("temp", perMin, now);
			machine = found ? [found] : [];
			add("temp", now, perMin);
		}
		lastTemp = { t: now, count };
	}

	function save(now, force = false) {
		if (!dirty || (!force && now - lastSaveMs < cfg().saveMs)) return;
		if (!db) {
			// No DB (it failed to open or broke): the baseline lives in memory only.
			pending = [];
			dirty = false;
			return;
		}
		try {
			db.exec("BEGIN IMMEDIATE");
			try {
				const insert = db.prepare("INSERT INTO baseline_samples (metric, t, value) VALUES (?, ?, ?)");
				for (const [metric, t, value] of pending) insert.run(metric, t, value);
				// The table keeps what the in-memory window keeps.
				const trim = db.prepare("DELETE FROM baseline_samples WHERE metric = ? AND t < ?");
				for (const metric of METRICS) if (state.samples[metric].length) trim.run(metric, state.samples[metric][0][0]);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			pending = [];
			dirty = false;
			lastSaveMs = now;
		} catch (error) {
			log?.warn?.("baseline_db_failed", { phase: "save", error: error.message });
			lastSaveMs = now;
			if (pending.length > 5000) pending = pending.slice(-5000);
		}
	}

	return {
		file,
		/**
		 * One tick: sample the owners of this tick's D1 stall findings (a high-confidence match to a process tree) and the
		 * temp directory when due. Returns the active deviations by owner key (ownerKeyOf). `learned(finding)`: true for a
		 * pattern triage found normal k times (#55 D): its deviation asks for no early look (counted in quietedLastDay),
		 * and its deviating samples stay out of the shared window like everyone's, so it cannot hide another owner.
		 */
		observe({ world, findings, learned }) {
			const c = cfg();
			const now = world.now;
			const out = new Map();
			if (!c?.enabled) return out;
			if (tempFiles && now - (lastTemp?.t ?? Number.NEGATIVE_INFINITY) >= c.tempScanMs) sampleTemp(now);
			const seen = new Set();
			for (const finding of world.procsFresh ? findings : []) {
				const d = finding.data ?? {};
				if (finding.detector !== "D1" || finding.kind !== "stall" || d.match?.confidence !== "high" || !d.call) continue;
				const key = ownerKeyOf(finding);
				if (seen.has(key)) continue;
				seen.add(key);
				let owner = owners.get(key);
				if (!owner) {
					owner = { lastSampleMs: Number.NEGATIVE_INFINITY, streak: {}, deviation: undefined, seenMs: now };
					owners.set(key, owner);
				}
				owner.seenMs = now;
				if (now - d.call.ms >= c.minOwnerAgeMs && now - owner.lastSampleMs >= c.sampleMs) {
					owner.lastSampleMs = now;
					const members = [...(d.match.tree ?? []), ...(d.match.orphans ?? [])];
					const quiet = learned?.(finding) === true;
					// Births before the tracker's first snapshot are unknown: the window starts there at the earliest.
					const fromMs = Math.max(now - c.rateWindowMs, d.call.ms, world.procs.tracker?.snapshotTimes?.[0] ?? now);
					const rates = ownerMetrics({ procs: world.procs, members, fromMs, now });
					const found = [];
					for (const metric of OWNER_METRICS) {
						// Judged against the window before this sample joins it.
						const deviation = deviationOf(metric, rates[metric], now);
						owner.streak[metric] = deviation ? (owner.streak[metric] ?? 0) + 1 : 0;
						if (deviation && owner.streak[metric] >= c.persistSamples) found.push({ ...deviation, samples: owner.streak[metric] });
						// A deviating sample does not join the baseline: one runaway owner must not teach the machine its rate.
						// Not even one whose pattern triage found normal (#55 D): the window is every owner's yardstick.
						if (!deviation) add(metric, now, rates[metric]);
					}
					if (found.length && quiet) {
						// A pattern triage found normal k times (#55 D) asks for no early look; its deviation is only counted.
						if (!owner.quieted) quieted.push(now);
						owner.quieted = true;
						owner.deviation = undefined;
					} else {
						owner.quieted = false;
						if (found.length && !owner.deviation) fires.push(now);
						owner.deviation = found.length ? { sinceMs: owner.deviation?.sinceMs ?? now, atMs: now, metrics: found, ...(machine.length ? { machine } : {}) } : undefined;
					}
				}
				if (owner.deviation) out.set(key, owner.deviation);
			}
			for (const [key, owner] of owners) if (now - owner.seenMs > 10 * c.sampleMs) owners.delete(key);
			save(now);
			return out;
		},
		/** For status --json: deviation fires in the last hour and day, and each metric's cold start and sample count. */
		summary(now = clock.now()) {
			for (const list of [fires, quieted]) while (list.length && now - list[0] > 24 * 3600_000) list.shift();
			return { fires: { lastHour: fires.filter((t) => now - t <= 3600_000).length, lastDay: fires.length, quietedLastDay: quieted.length }, metrics: this.status(now) };
		},
		/** Whether each metric is past its cold start, and how many samples it holds. */
		status(now = clock.now()) {
			return Object.fromEntries(METRICS.map((metric) => [metric, { samples: state.samples[metric].length, ready: Boolean(statsOf(metric, now)) }]));
		},
		flush() {
			save(clock.now(), true);
		},
	};
}
