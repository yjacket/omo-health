import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executeKill } from "../src/act/kill.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as refl from "../src/detect/reflection-orphans.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { sha1 } from "../src/util/text.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const START = Date.parse("2026-09-29T09:00:00Z");
const FINISH = Date.parse("2026-09-29T10:00:00Z");
const GRACE = 60_000;
const CLI = "C:/bun/install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js";

const row = (p, n, cl, ms = START, pp = 0) => ({ p, pp, n, cl, c: new Date(ms).toISOString() });
const reflCmd = (run) =>
	`node "${CLI}" -p --system-prompt "${run}/reflection-persona.md" --tools bash,edit --no-extensions --no-skills --no-prompt-templates --no-context-files --session-dir "${run}" --model test/model "@${run}/reflection-task.md"`;

function harness({ rows, final = { version: 1, runId: "reflection-run-1", outcome: "timed_out", finishedAt: new Date(FINISH).toISOString() }, finalText, enabled = true, graceMs = GRACE, sessions = [], mode = "auto", actionsKill = true, transform, runner } = {}) {
	const root = tmpDir("omoh-refl-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	const runDir = path.join(paths.omoHome, "memory", "agents", "e2e-agent", "runtime", "reflection", "runs", "reflection-run-1");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "reflection-persona.md"), "persona");
	fs.writeFileSync(path.join(runDir, "reflection-task.md"), "task");
	if (final !== null) fs.writeFileSync(path.join(runDir, "final.json"), finalText ?? JSON.stringify(final));
	rows ??= [
		row(10, "node.exe", reflCmd(runDir), FINISH - 600_000),
		row(11, "bun.exe", reflCmd(runDir), FINISH - 500_000),
		row(99, "bun.exe", "bun server.js", FINISH - 400_000),
	];
	const clock = createFakeClock(FINISH + graceMs + 1000);
	const live = new Map(rows.map((r) => [r.p, r]));
	const killed = [];
	const decisions = [];
	const toasts = [];
	const sent = [];
	let calls = 0;
	// sources.procs.snapshot yields {rows, takenAtMs}; executeKill's snapshot yields a ProcessTable.
	const sourceSnapshot = async () => {
		calls += 1;
		const current = transform ? transform([...live.values()], calls) : [...live.values()];
		return { rows: normalizeRows(current), takenAtMs: clock.now() };
	};
	const tableSnapshot = async () => new ProcessTracker().update(await sourceSnapshot());
	const engine = createEngine({ paths, config: { ...DEFAULT_CONFIG, reflectionOrphans: { enabled, graceMs }, actions: { ...DEFAULT_CONFIG.actions, kill: actionsKill } }, clock, mode,
		detectors: [{ name: "reflection-orphans", ...refl }],
		sources: { procs: { snapshot: sourceSnapshot, async os() { return {}; } }, registry: { refresh: () => ({ sessions: new Map(sessions.map((s) => [s.id, s])), tasks: [] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: { sensors: () => new Map(),
			kill: (args) => executeKill({ ...args, snapshot: tableSnapshot, runner(pid) { const r = runner ? runner(pid) : { status: 0 }; if (r.status === 0) live.delete(pid); killed.push(r.status === 0 ? pid : -pid); return r; }, sleep: async () => {} }),
			send(msg) { sent.push(msg); return "inbox"; },
			decide: (d) => decisions.push(d), notifier: { toast(msg) { toasts.push(msg); return { ok: true }; } } },
		options: { selfPid: 999999, noStatus: false } });
	return { engine, clock, live, killed, decisions, toasts, sent, paths, runDir, get calls() { return calls; } };
}

test("a finished timed_out run's node and bun children are killed once, quietly", async () => {
	const h = harness();
	const result = await h.engine.tick();
	assert.deepEqual(h.killed.sort(), [10, 11]);
	assert.equal(h.live.has(99), true);
	assert.equal(result.findings[0].severity, "info");
	assert.equal(result.globalStatus.level, "ok");
	assert.equal(h.toasts.length, 0);
	assert.equal(h.sent.length, 0);
	const entries = h.decisions.filter((d) => d.action?.kind === "kill-reflection-orphans");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].result, "execute");
	assert.equal(entries[0].outcome.killed.length, 2);
	await h.engine.tick();
	assert.equal(h.decisions.length, 1);
});

test("grace is honored exactly: untouched at the edge, killed one ms after", async () => {
	const h = harness();
	h.clock.set(FINISH + GRACE);
	assert.deepEqual((await h.engine.tick()).results, []);
	h.clock.advance(1);
	await h.engine.tick();
	assert.deepEqual(h.killed.sort(), [10, 11]);
});

test("a process started at or after finishedAt is a newer attempt and survives", async () => {
	const h = harness({ rows: [row(10, "node.exe", "", FINISH), row(11, "bun.exe", "", FINISH + 1)] });
	const cmd = reflCmd(h.runDir);
	for (const r of h.live.values()) r.cl = cmd;
	await h.engine.tick();
	assert.deepEqual(h.killed, []);
});

test("no final.json, malformed, wrong runId and non-terminal outcome are untouched", async () => {
	for (const opts of [{ final: null }, { final: {}, finalText: "{oops" }, { final: { version: 1, runId: "reflection-run-99", outcome: "timed_out", finishedAt: new Date(FINISH).toISOString() } }, { final: { version: 1, runId: "reflection-run-1", outcome: "running", finishedAt: new Date(FINISH).toISOString() } }]) {
		const h = harness(opts);
		await h.engine.tick();
		assert.deepEqual(h.killed, [], JSON.stringify(opts.final));
	}
});

test("the verified kill path refuses a reused pid and a changed command", async () => {
	const h = harness();
	const cmd = reflCmd(h.runDir);
	const targets = [
		{ pid: 10, ctime: new Date(FINISH - 600_000).toISOString(), cmdSha1: sha1(cmd), name: "node.exe" },
		{ pid: 11, ctime: new Date(FINISH - 500_000).toISOString(), cmdSha1: sha1(cmd), name: "bun.exe" },
	];
	const calls = [];
	const outcome = await executeKill({ request: { kind: "kill-reflection-orphans", targets },
		snapshot: async () => new ProcessTracker().update({ rows: normalizeRows([
			row(10, "node.exe", cmd, FINISH - 100),
			row(11, "bun.exe", "bun something-else.js", FINISH - 500_000),
		]), takenAtMs: FINISH + GRACE + 1000 }),
		guard: { liveHostPids: new Set(), hosts: new Map(), protectedPids: new Set() },
		runner(pid) { calls.push(pid); return { status: 0 }; }, sleep: async () => {} });
	assert.deepEqual(calls, []);
	assert.deepEqual(outcome.noop.map((n) => `${n.pid}:${n.reason}`).sort(), ["10:pid-reused", "11:command-changed"]);
});

test("a stale remedy is dropped when the re-identification no longer sees an orphan", async () => {
	// World snapshot (call 1) still shows the orphan; the perform() re-identification (call 2)
	// sees the pid reused by a process created after finishedAt and walks away.
	const h = harness({ transform: (rows, call) => (call >= 2 ? rows.map((r) => ({ ...r, c: new Date(FINISH + 500_000).toISOString() })) : rows) });
	await h.engine.tick();
	assert.deepEqual(h.killed, []);
});

test("a reflection child that also hosts a registered session stays protected", async () => {
	const h = harness({ sessions: [{ id: "s1", kind: "main", hostPid: 10 }] });
	await h.engine.tick();
	assert.deepEqual(h.killed, [11]);
	assert.equal(h.live.has(10), true);
});

test("a failed kill is retried on the next tick", async () => {
	let failed = true;
	const h = harness({ runner(pid) { if (failed && pid === 10) return { status: 1, error: "denied" }; return { status: 0 }; } });
	await h.engine.tick();
	assert.deepEqual(h.killed, [-10, 11]);
	assert.equal(h.live.has(10), true);
	failed = false;
	h.clock.advance(1000);
	await h.engine.tick();
	assert.equal(h.live.has(10), false);
	const executes = h.decisions.filter((d) => d.action?.kind === "kill-reflection-orphans" && d.result === "execute");
	assert.equal(executes.length, 2);
});

test("unrelated node and bun processes and off-layout commands are untouched", async () => {
	const h = harness();
	// outside omoHome: real run dir + final.json exist, but the path is not under <omoHome>/memory
	const outside = path.join(h.paths.home, "elsewhere", "memory", "agents", "x", "runtime", "reflection", "runs", "reflection-run-1");
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(outside, "final.json"), JSON.stringify({ version: 1, runId: "reflection-run-1", outcome: "timed_out", finishedAt: new Date(FINISH).toISOString() }));
	const rows = [
		row(10, "node.exe", `node "${CLI}"`, FINISH - 600_000), // real senpi host, interactive
		row(11, "node.exe", reflCmd(h.runDir).replace(" -p ", " "), FINISH - 550_000), // no -p: interactive session args
		row(12, "node.exe", reflCmd(outside), FINISH - 400_000), // outside omoHome
		row(13, "powershell.exe", reflCmd(h.runDir), FINISH - 300_000), // wrong image, full reflection cmd
		row(14, "node.exe", reflCmd("C:/x/runtime/reflection/runs/reflection-run-abc"), FINISH - 200_000), // not reflection-run-N
		row(15, "node.exe", reflCmd(h.runDir).replace(`"${CLI}"`, `"C:/x/fake.js"`), FINISH - 250_000), // not senpi cli.js
	];
	for (const r of rows) h.live.set(r.p, r);
	// off-layout shape: persona resolves to a dir that is not <omoHome>/agents/.../runs/reflection-run-N
	const weird = path.join(h.paths.omoHome, "memory", "agents", "x", "runtime", "reflection", "runs", "reflection-run-1");
	fs.mkdirSync(path.dirname(weird), { recursive: true });
	h.live.set(16, row(16, "node.exe", `node "${CLI}" -p --system-prompt "${h.runDir}/reflection-persona.md" --session-dir "${path.dirname(weird)}" --model m`, FINISH - 100_000));
	await h.engine.tick();
	assert.deepEqual(h.killed, []);
});

test("the detector gate itself refuses: disabled config, stale procs, history mode", async () => {
	const h = harness();
	const rows = [{ p: 10, pp: 0, n: "node.exe", cl: reflCmd(h.runDir), c: new Date(FINISH - 600_000).toISOString() }];
	const table = new ProcessTracker().update({ rows: normalizeRows(rows), takenAtMs: FINISH + GRACE + 1000 });
	const runs = refl.readReflectionRuns(h.paths, table);
	const { buildWorld } = await import("../src/state.mjs");
	const world = buildWorld({ now: FINISH + GRACE + 1000, config: { ...DEFAULT_CONFIG, reflectionOrphans: { enabled: true, graceMs: GRACE } }, paths: h.paths, registry: { sessions: new Map(), tasks: [] }, procs: table, procsFresh: true, reflectionRuns: runs });
	assert.equal(refl.detect(world, {}).length, 1); // sanity: detects before the gates are flipped
	assert.deepEqual(refl.detect({ ...world, config: { ...world.config, reflectionOrphans: { enabled: false } } }, {}), []);
	assert.deepEqual(refl.detect({ ...world, procsFresh: false }, {}), []);
	assert.deepEqual(refl.detect({ ...world, self: { mode: "history" } }, {}), []);
});

test("disabled config, the kill switch and shadow mode never touch processes", async () => {
	for (const opts of [{ enabled: false }, { actionsKill: false }, { mode: "shadow" }]) {
		const h = harness(opts);
		const result = await h.engine.tick();
		assert.deepEqual(h.killed, [], JSON.stringify(opts));
		if (opts.mode === "shadow") assert.ok(result.results.some((r) => r.result === "would" && r.kind === "kill-reflection-orphans"));
		if (opts.actionsKill === false) assert.ok(result.results.some((r) => r.result === "skipped:switch-off"));
		if (opts.enabled === false) assert.deepEqual(result.findings, []);
	}
});

test("readReflectionRuns reads bounded run dirs read-only, matching argv rules", () => {
	const h = harness();
	const proc = { name: "node.exe", cmd: reflCmd(h.runDir), pid: 1, ctime: "x", ctimeMs: 1 };
	assert.deepEqual(refl.windowsArgv(`"C:\\A B\\bun.exe" "\\\\server\\x" 'bare' "one \\"two\\""`), ["C:\\A B\\bun.exe", "\\\\server\\x", "'bare'", 'one "two"']);
	const shape = refl.reflectionShape(proc);
	assert.equal(shape.runId, "reflection-run-1");
	assert.equal(shape.agent, "e2e-agent");
	// fork mode: -p --fork <file> --session-dir <run> (no --system-prompt)
	const fork = { ...proc, cmd: `node "${CLI}" -p --fork "C:/sess/session.json" --session-dir "${h.runDir}" --model m "@${h.runDir}/reflection-task.md"` };
	assert.equal(refl.reflectionShape(fork)?.key, shape.key);
	// duplicated flags and a non-persona prompt reject
	assert.equal(refl.reflectionShape({ ...proc, cmd: reflCmd(h.runDir) + ` --session-dir "${h.runDir}"` }), undefined);
	assert.equal(refl.reflectionShape({ ...proc, cmd: reflCmd(h.runDir).replace("reflection-persona.md", "other.md") }), undefined);
	// file content is never mutated
	const file = path.join(h.runDir, "final.json");
	const before = fs.readFileSync(file, "utf8");
	const table = new ProcessTracker().update({ rows: normalizeRows([row(1, "node.exe", reflCmd(h.runDir))]), takenAtMs: FINISH });
	const runs = refl.readReflectionRuns(h.paths, table);
	assert.equal(runs.size, 1);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.equal(refl.finishedAtMs(runs.get(shape.key)), FINISH);
});
