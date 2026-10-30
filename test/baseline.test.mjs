import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { countTempFiles, createBaseline, ownerMetrics, quantile, robustStats } from "../src/baseline.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { closeDb, openDb } from "../src/db/db.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { newRecord, planFinding } from "../src/judge/policy.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-09-30T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const cfg = DEFAULT_CONFIG;

function sandbox() {
	const root = tmpDir("omoh-baseline-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { root, paths };
}

/** This machine's usual rates: `count` samples per metric over two days, cycling through small values. */
function seed(paths, { count = 300, spanMs = 2 * DAY, endMs = T, old = 0 } = {}) {
	const values = { births: [0, 0, 1, 0, 2], cpu: [0.1, 0.2, 0.05], mem: [0, 1, 2], writes: [0, 0.5, 1], temp: [0, 10, 5] };
	const samples = {};
	for (const [metric, list] of Object.entries(values)) {
		samples[metric] = [
			...Array.from({ length: old }, (_, i) => [endMs - 8 * DAY + i, 0]),
			...Array.from({ length: count }, (_, i) => [endMs - spanMs + Math.floor((i * spanMs) / count), list[i % list.length]]),
		];
	}
	fs.writeFileSync(paths.health.baselineFile, JSON.stringify({ v: 1, firstMs: endMs - spanMs - (old ? 8 * DAY : 0), samples }));
}

const HOST = 10;
const SHELL = 100;
const WORKER = 101;
const MEMBERS = [
	{ pid: SHELL, ctime: iso(T - 10 * MIN), name: "bash.exe" },
	{ pid: WORKER, ctime: iso(T - 10 * MIN + 500), name: "node.exe" },
];

/**
 * A call's tree (bash -> node) sampled every 20 s. `births(i)`: children node starts before snapshot i and that are gone
 * by the next one; `grow`: the worker's CPU (ms), private bytes and writes added per snapshot.
 */
function run({ ticks, births = () => 0, grow = { cpu: 0, pv: 0, wb: 0 }, unrelated = 0, onTick }) {
	const tracker = new ProcessTracker();
	for (let i = 0; i < ticks; i++) {
		const t = T + i * 20_000;
		const rows = [
			{ p: HOST, pp: 1, n: "node.exe", c: iso(T - DAY), cpu: 0, pv: 1e8, wb: 0, cl: "node senpi/cli.js" },
			{ p: SHELL, pp: HOST, n: "bash.exe", c: MEMBERS[0].ctime, cpu: 0, pv: 2e6, wb: 0, cl: 'bash -c "node driver.mjs"' },
			{ p: WORKER, pp: SHELL, n: "node.exe", c: MEMBERS[1].ctime, cpu: i * grow.cpu, pv: 4e7 + i * grow.pv, wb: i * grow.wb, cl: "node driver.mjs" },
		];
		for (let k = 0; k < (i ? births(i) : 0); k++) rows.push({ p: 1000 + i * 10 + k, pp: WORKER, n: "chrome.exe", c: iso(t - 500 - k), cpu: 0, pv: 1e6, wb: 0, cl: "chrome --headless" });
		for (let k = 0; k < (i ? unrelated : 0); k++) rows.push({ p: 5000 + i * 10 + k, pp: HOST, n: "git.exe", c: iso(t - 500 - k), cpu: 0, pv: 1e6, wb: 0, cl: "git status" });
		const table = tracker.update({ takenAtMs: t, rows: normalizeRows(rows) });
		onTick?.({ t, table, i });
	}
	return tracker;
}

const ownerFinding = (callMs = T - 3 * MIN) =>
	makeFinding({
		detector: "D1",
		kind: "stall",
		subject: { sessionId: "c1", toolCallId: "toolu_1" },
		cls: "progressing",
		data: { call: { id: "toolu_1", name: "bash", commandHead: "node driver.mjs", ms: callMs }, match: { state: "running", confidence: "high", tree: MEMBERS, orphans: [] } },
	});

test("quantiles and robust statistics", () => {
	assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
	assert.equal(quantile(Array.from({ length: 200 }, (_, i) => i), 0.995), 198.005);
	const stats = robustStats([100, 1, 2, 1, 2]);
	assert.deepEqual([stats.median, stats.mad, stats.sorted], [2, 1, [1, 1, 2, 2, 100]]);
});

test("owner metrics read D17's ProcessTracker births under the call's tree and the tree's CPU, memory and writes", () => {
	let metrics;
	run({
		ticks: 7,
		births: () => 1,
		unrelated: 2,
		grow: { cpu: 10_000, pv: 10 * 1024 * 1024, wb: 5 * 1024 * 1024 },
		onTick: ({ t, table, i }) => {
			if (i === 6) metrics = ownerMetrics({ procs: table, members: MEMBERS, fromMs: T, now: t });
		},
	});
	// 6 births under the worker in 2 min; the host's own git children are someone else's.
	assert.deepEqual(metrics, { births: 3, cpu: 0.5, mem: 30, writes: 15 });
});

test("cold start: without minSamples samples over minSpanMs of history nothing deviates, however extreme", () => {
	const { paths } = sandbox();
	const clock = createFakeClock(T);
	const baseline = createBaseline({ paths, config: cfg, clock });
	const found = [];
	run({
		ticks: 30,
		births: () => 3,
		onTick: ({ t, table }) => {
			clock.set?.(t);
			const out = baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] });
			if (out.size) found.push(t);
		},
	});
	assert.deepEqual(found, [], "a fresh install never fires");
	const status = baseline.status(T + 10 * MIN);
	assert.deepEqual([status.births.ready, status.births.samples], [false, 10], "it learns meanwhile: one sample a minute");
});

test("a warm baseline flags an owner far above the usual rates after persistSamples samples, and only above the floors (#55 C)", () => {
	const { paths } = sandbox();
	seed(paths);
	const baseline = createBaseline({ paths, config: cfg, clock: createFakeClock(T) });
	const seen = [];
	run({
		ticks: 10,
		births: () => 3,
		onTick: ({ t, table }) => {
			const out = baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] });
			if (out.size) seen.push([(t - T) / 1000, out.get("c1:toolu_1")]);
		},
	});
	// Samples at 0 s (no births known yet), 60 s (9/min: streak 1) and 120 s (streak 2: active).
	assert.equal(seen[0][0], 120);
	const [births] = seen[0][1].metrics;
	assert.deepEqual([births.metric, births.value, births.median, births.samples, seen[0][1].metrics.length], ["births", 9, 0, 2, 1]);
	assert.ok(births.z >= cfg.baseline.zMin && births.value > births.q);
	assert.equal(baseline.status(T).births.samples, 301, "deviating samples stay out of the baseline: only the 0 s one joined");

	// Above the usual quantile but below the births floor (3/min): not a deviation.
	const quiet = createBaseline({ paths, config: cfg, clock: createFakeClock(T) });
	let any = 0;
	run({
		ticks: 20,
		births: (i) => (i % 2 ? 1 : 0),
		onTick: ({ t, table }) => {
			any += quiet.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] }).size;
		},
	});
	assert.equal(any, 0);
});

test("the baseline is saved in the DB's baseline_samples, reloads, and keeps only the rolling window", (t) => {
	const { paths } = sandbox();
	seed(paths, { old: 50 });
	const clock = createFakeClock(T);
	const db = openDb({ file: paths.health.dbFile });
	t.after(() => closeDb(db));
	const baseline = createBaseline({ paths, config: cfg, clock, db });
	assert.equal(baseline.status(T).births.samples, 350);
	run({
		ticks: 4,
		onTick: ({ t, table }) => baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] }),
	});
	baseline.flush();
	const saved = db.prepare("SELECT t FROM baseline_samples WHERE metric = 'births'").all();
	assert.equal(saved.length, 302, "8-day-old samples left the 7-day window; two new ones joined");
	assert.ok(saved.every((row) => T + 60_000 - row.t <= cfg.baseline.windowMs));
	assert.equal(createBaseline({ paths, config: cfg, clock, db }).status(T).births.samples, 302);
});

test("the machine's temp-file growth is reported with an owner's deviation and raises nothing by itself", () => {
	const { paths } = sandbox();
	seed(paths);
	let files = 1000;
	const config = { ...cfg, baseline: { ...cfg.baseline, tempScanMs: MIN } };
	const withOwner = createBaseline({ paths, config, clock: createFakeClock(T), tempFiles: () => files });
	let last;
	run({
		ticks: 10,
		births: () => 3,
		onTick: ({ t, table }) => {
			files += 700;
			last = withOwner.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] }).get("c1:toolu_1") ?? last;
		},
	});
	assert.deepEqual(last.machine.map((m) => [m.metric, m.value]), [["temp", 2100]]);

	const alone = createBaseline({ paths, config, clock: createFakeClock(T), tempFiles: () => files });
	let raised = 0;
	run({
		ticks: 10,
		onTick: ({ t, table }) => {
			files += 700;
			raised += alone.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()] }).size;
		},
	});
	assert.equal(raised, 0);
});

test("countTempFiles counts the temp directory and one level below, within its cap", () => {
	const { root } = sandbox();
	const dir = path.join(root, "tmp");
	fs.mkdirSync(path.join(dir, "profile"), { recursive: true });
	for (const name of ["a.tmp", "b.tmp", "c.tmp"]) fs.writeFileSync(path.join(dir, name), "");
	for (const name of ["1.tmp", "2.tmp", "3.tmp", "4.tmp"]) fs.writeFileSync(path.join(dir, "profile", name), "");
	assert.equal(countTempFiles(dir), 7);
	assert.equal(countTempFiles(dir, { cap: 5 }), 5);
	assert.equal(countTempFiles(path.join(root, "missing")), undefined);
});

/** A child's call with a live baseline deviation: a progressing one (no action of its own) or R11's analyze suspicion. */
function deviating({ cls = "progressing", action = null, dueMs = T + 60 * MIN, deviation = { sinceMs: T, atMs: T, metrics: [{ metric: "births", value: 9, median: 0, q: 2, z: 999, unit: "/min" }] } } = {}) {
	return makeFinding({
		detector: "D1",
		kind: "stall",
		subject: { sessionId: "c1", toolCallId: "toolu_1" },
		cls,
		data: {
			classification: { cls, rule: { id: cls === "unknown" ? "R11" : "R10", v: 4 }, confidence: 0.8, dueMs, action, evidence: [], data: {} },
			match: { tree: [{ pid: SHELL, ctime: "a", name: "bash.exe" }, { pid: WORKER, ctime: "b", name: "node.exe" }], orphans: [] },
			call: { id: "toolu_1", name: "bash", commandHead: "node driver.mjs", ms: T - 3 * MIN },
			ageMs: 3 * MIN,
			...(deviation ? { deviation } : {}),
		},
	});
}

test("a deviation only annotates the finding: it asks nothing and moves no due time (#55 C)", () => {
	const plan = (finding, now) => {
		const out = planFinding({ finding, record: newRecord(finding.fp, T), now, config: cfg });
		return [out.requests.map((r) => r.kind), out.state];
	};
	// A progressing call has no action of its own: the signal alone neither asks the analyst nor acts, at any age.
	for (const now of [T + MIN, T + 10 * MIN, T + 90 * MIN]) assert.deepEqual(plan(deviating(), now), [[], "observe"]);
	// R11 asks the analyst at its due time only; a deviation before it changes nothing, and after it nothing extra.
	const suspicion = (deviation) => deviating({ cls: "unknown", action: { kind: "analyze" }, dueMs: T + 10 * MIN, ...(deviation === null ? { deviation: null } : {}) });
	assert.deepEqual(plan(suspicion(), T + 4 * MIN), [[], "waiting-due"]);
	assert.deepEqual(plan(suspicion(null), T + 4 * MIN), [[], "waiting-due"]);
	assert.deepEqual(plan(suspicion(), T + 10 * MIN), plan(suspicion(null), T + 10 * MIN));
	assert.deepEqual(plan(suspicion(), T + 10 * MIN), [["analyze"], "analyzing"]);
});

test("an owner whose pattern triage found normal k times asks for no early look, and feeds nothing into the shared window (#87 review)", () => {
	const { paths } = sandbox();
	seed(paths);
	const baseline = createBaseline({ paths, config: cfg, clock: createFakeClock(T) });
	let raised = 0;
	run({
		ticks: 10,
		births: () => 3,
		onTick: ({ t, table }) => {
			raised += baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()], learned: () => true }).size;
		},
	});
	assert.equal(raised, 0, "its deviation is only counted");
	assert.equal(baseline.summary(T + 3 * MIN).fires.quietedLastDay, 1);
	assert.equal(baseline.status(T).births.samples, 301, "its deviating samples stay out, as everyone's do");
});

test("a learned-normal owner cannot stop another owner from deviating (#87 review)", () => {
	const { paths } = sandbox();
	seed(paths);
	const baseline = createBaseline({ paths, config: cfg, clock: createFakeClock(T) });
	// Owner A's pattern is learned normal; it starts 60 processes a minute for half an hour.
	run({ ticks: 90, births: () => 20, onTick: ({ t, table }) => baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [ownerFinding()], learned: () => true }) });
	// Owner B, another call, is a 40/min runaway afterwards: it still deviates.
	const other = () => makeFinding({ detector: "D1", kind: "stall", subject: { sessionId: "c2", toolCallId: "toolu_2" }, cls: "progressing", data: { call: { id: "toolu_2", name: "bash", commandHead: "node other.mjs", ms: T - 3 * MIN }, match: { state: "running", confidence: "high", tree: MEMBERS, orphans: [] } } });
	let deviation;
	run({ ticks: 10, births: (i) => (i % 3 ? 13 : 14), onTick: ({ t, table }) => { deviation = baseline.observe({ world: { now: t, procsFresh: true, procs: table }, findings: [other()] }).get("c2:toolu_2") ?? deviation; } });
	assert.deepEqual(deviation?.metrics.map((m) => m.metric), ["births"]);
});
