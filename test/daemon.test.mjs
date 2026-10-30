import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/daemon.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { queueReport } from "../src/reports/intake.mjs";
import { RUN_KEY } from "../src/install.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";
import { fakeProc, guardProcessListeners } from "./helpers/fake-proc.mjs";

guardProcessListeners();

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	let now = 100_000;
	const clock = { now: () => now };
	let ticks = 0;
	const fakeEngine = () => ({
		async tick() {
			now += 60_000;
			ticks++;
			return { findings: [] };
		},
		table: { all: () => [] }, close() {},
	});
	return { paths, clock, fakeEngine, get ticks() { return ticks; } };
}

test("a daemon started from another root than the installed release redirects to boot without taking the lock", async () => {
	const f = fixture();
	fs.mkdirSync(f.paths.health.appDir, { recursive: true });
	const release = path.join(f.paths.health.releasesDir, "1.0.0");
	fs.writeFileSync(f.paths.health.currentFile, JSON.stringify({ channel: "release", version: "1.0.0", root: release, previous: null, lkg: { version: "1.0.0", root: release }, bad: [] }));
	fs.writeFileSync(f.paths.health.bootFile, "// boot");
	const launches = [];
	const launch = async (options) => (launches.push(options), { via: "spawn", pid: 1 });
	let engines = 0;
	const createEngine = (...args) => (engines++, f.fakeEngine(...args));
	const config = { ...DEFAULT_CONFIG, idleExitMs: 60_000 };
	const result = await runDaemon({ proc: fakeProc(), paths: f.paths, config, clock: f.clock, overrides: { procs: { kind: "fake" }, createEngine, launch, env: {} } });
	assert.equal(result.reason, "redirect");
	assert.equal(launches.length, 1);
	assert.equal(launches[0].script, f.paths.health.bootFile);
	assert.equal(engines, 0);
	assert.equal(fs.existsSync(f.paths.health.lockFile), false);
	assert.equal(fs.existsSync(f.paths.health.daemonJson), false, "the redirecting process never heartbeats");

	const viaBoot = await runDaemon({ proc: fakeProc(), paths: f.paths, config, clock: f.clock, overrides: { procs: { kind: "fake" }, createEngine, launch, env: { OMO_HEALTH_VIA_BOOT: "1" } } });
	assert.equal(viaBoot.reason, "idle-no-omo-hosts", "started by boot, the daemon runs whatever root boot chose");
	assert.equal(launches.length, 1);
});

test("each tick stamps its start in the heartbeat before it runs, so a long tick is not taken for a hung daemon", async () => {
	const f = fixture();
	let ticks = 0;
	const seen = [];
	const engine = () => ({
		async tick() {
			seen.push(fs.existsSync(f.paths.health.daemonJson) ? JSON.parse(fs.readFileSync(f.paths.health.daemonJson, "utf8")) : null);
			ticks++;
			return { findings: [] };
		},
		table: { all: () => [] }, close() {},
	});
	const clock = { now: () => 100_000 + ticks * 60_000 };
	await runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock, overrides: { procs: { kind: "fake" }, createEngine: engine } });
	assert.equal(seen[0], null, "no heartbeat of this daemon before its first tick");
	assert.deepEqual(seen.slice(1).map((hb) => [hb.pid, hb.ts, hb.tickStartedMs]), [[process.pid, 160_000, 160_000], [process.pid, 220_000, 220_000]]);
	assert.deepEqual(seen.slice(1).map((hb) => hb.capabilities), [["park-resume", "goal-liveness"], ["park-resume", "goal-liveness"]], "each tick advertises park-resume and the goal-liveness capability in daemon.json");
	assert.deepEqual(seen.slice(1).map((hb) => hb.goalLiveness), [{ wakeReady: true, actionScope: null }, { wakeReady: true, actionScope: null }], "and what the goal wake would be gated on");
});

/** One daemon run whose last heartbeat is returned: the fake engine dies after two ticks (idle exit). */
async function livenessHeartbeat(config, { pause = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-liveness-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	if (pause) {
		fs.mkdirSync(paths.healthHome, { recursive: true });
		fs.writeFileSync(paths.health.pauseFile, JSON.stringify({ untilMs: 9e15 }));
	}
	let now = 100_000;
	let last;
	const engine = () => ({
		async tick() {
			now += 60_000;
			last = JSON.parse(fs.readFileSync(paths.health.daemonJson, "utf8"));
			return { findings: [] };
		},
		table: { all: () => [] }, close() {},
	});
	await runDaemon({ proc: fakeProc(), paths, config: { ...config, idleExitMs: 2 * 60_000 }, clock: { now: () => now }, overrides: { procs: { kind: "fake" }, createEngine: engine, env: {} } });
	return last;
}

test("the heartbeat carries the goal-liveness capability and the wakeReady verdict behind it", async () => {
	const cases = [
		["auto, empty scope", {}, { capabilities: ["park-resume", "goal-liveness"], wakeReady: true, actionScope: null }],
		["auto with an action scope: the scope never makes the probe false, it is mirrored separately", { actionScope: ["s1"] }, { capabilities: ["park-resume", "goal-liveness"], wakeReady: true, actionScope: ["s1"] }],
		["shadow mode", { mode: "shadow" }, { capabilities: ["park-resume", "goal-liveness"], wakeReady: false, actionScope: null }],
		["actions.wake off", { actions: { ...DEFAULT_CONFIG.actions, wake: false } }, { capabilities: ["park-resume", "goal-liveness"], wakeReady: false, actionScope: null }],
		["goalLiveness off: no capability and no block", { goalLiveness: { ...DEFAULT_CONFIG.goalLiveness, enabled: false } }, { capabilities: ["park-resume"], wakeReady: undefined, actionScope: undefined }],
	];
	for (const [name, patch, expected] of cases) {
		const hb = await livenessHeartbeat({ ...DEFAULT_CONFIG, ...patch });
		assert.deepEqual(hb.capabilities, expected.capabilities, name);
		assert.equal(hb.goalLiveness?.wakeReady, expected.wakeReady, name);
		assert.deepEqual(hb.goalLiveness?.actionScope, expected.actionScope, name);
	}
});

test("a paused daemon advertises goal-liveness but is not wakeReady", async () => {
	const hb = await livenessHeartbeat({ ...DEFAULT_CONFIG }, { pause: true });
	assert.deepEqual(hb.capabilities, ["park-resume", "goal-liveness"], "the capability is a build fact, not a mode");
	assert.deepEqual(hb.goalLiveness, { wakeReady: false, actionScope: null }, "nothing is woken while actions are paused");
});

test("a daemon whose setup throws closes the DB and frees the lock before it rethrows", async () => {
	const f = fixture();
	const createEngine = () => {
		throw new Error("setup failed");
	};
	await assert.rejects(runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG }, clock: f.clock, overrides: { procs: { kind: "fake" }, createEngine } }), /setup failed/);
	assert.equal(fs.existsSync(f.paths.health.lockFile), false);
	assert.equal(fs.existsSync(f.paths.health.dbFile), true);
	// An open DatabaseSync keeps the file locked on Windows; a closed one can be removed.
	fs.rmSync(f.paths.health.dbFile);
});

test("daemon startup prunes death records older than configured history retention", async () => {
	const f = fixture();
	fs.mkdirSync(f.paths.health.deathsDir, { recursive: true });
	const oldFile = path.join(f.paths.health.deathsDir, "old.json");
	const recentFile = path.join(f.paths.health.deathsDir, "recent.json");
	fs.writeFileSync(oldFile, JSON.stringify({ kind: "old", atMs: 1 }));
	fs.writeFileSync(recentFile, JSON.stringify({ kind: "recent", atMs: 99_000 }));
	const retentionDays = 2;
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
	fs.utimesSync(oldFile, (cutoff - 1000) / 1000, (cutoff - 1000) / 1000);
	fs.utimesSync(recentFile, (cutoff + 1000) / 1000, (cutoff + 1000) / 1000);
	await runDaemon({
		proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, history: { ...DEFAULT_CONFIG.history, retentionDays }, idleExitMs: 60_000 }, clock: { now: () => Date.now() + f.ticks * 60_001 },
		overrides: { procs: { kind: "fake" }, createEngine: f.fakeEngine },
	});
	assert.equal(fs.existsSync(oldFile), false);
	assert.equal(fs.existsSync(recentFile), true);
});

test("the daemon takes an evidence snapshot when a subagent finding opens", async () => {
	const f = fixture();
	const world = makeWorld({ sessions: [sessionState({ id: "c1", kind: "child", taskId: "st_c", parentSessionId: "p1", task: taskRecord({ taskId: "st_c" }) })] });
	const opened = [{ fp: "f1f1f1f1", detector: "D1", kind: "stall", cls: "unknown", severity: "warn", subject: { sessionId: "c1", taskId: "st_c" } }];
	let ticks = 0;
	const engine = () => ({
		async tick() {
			ticks++;
			return { findings: opened, opened: ticks === 1 ? opened : [], world };
		},
		table: { all: () => [] }, close() {},
	});
	const clock = { now: () => 100_000 + ticks * 60_000 };
	await runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock, overrides: { procs: { kind: "fake" }, createEngine: engine } });
	assert.deepEqual(fs.readdirSync(f.paths.health.snapshotsDir), [`${world.now}-finding-st_c-f1f1f1f1.json`]);
});

test("a recorded report reaches the engine's triage, and the engine gets the analyst and the evidence actor (#55 B, #60 item 5)", async () => {
	const f = fixture();
	const queued = [];
	let actors;
	const world = makeWorld({ sessions: [sessionState({ id: "c1", kind: "child", taskId: "st_c", parentSessionId: "p1", task: taskRecord({ taskId: "st_c" }) })] });
	const createEngine = (opts) => {
		actors = opts.actors;
		const engine = f.fakeEngine();
		return { ...engine, async tick() { await engine.tick(); return { findings: [], world }; }, triageReport: (entry) => queued.push(entry) };
	};
	assert.equal(queueReport(f.paths, { subject: "st_c", text: "st_c looks stuck", via: "cli", now: 100_000 }).outcome, "queued");
	await runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock: f.clock, overrides: { procs: { kind: "fake" }, createEngine } });
	assert.deepEqual(queued.map((e) => [e.report.text, e.subject.taskId, e.subject.sessionId, e.subject.kind]), [["st_c looks stuck", "st_c", "c1", "child"]]);
	assert.deepEqual([typeof actors.analyst?.start, typeof actors.analyst?.poll, typeof actors.evidence?.capture], ["function", "function", "function"]);
	assert.deepEqual([actors.judge, actors.tier2], [undefined, undefined], "the tier-1 judge and tier 2 are gone");
	// #55 C: the baseline of this machine's usual rates, saved under the health home.
	assert.deepEqual([typeof actors.baseline?.observe, actors.baseline?.file], ["function", f.paths.health.baselineFile]);
});

test("the daemon writes the session board each tick, records a session that left it, and runs backfill and retention once at start", async () => {
	const f = fixture();
	const start = Date.now();
	let ticks = 0;
	const clock = { now: () => start + ticks * 60_000 };
	fs.mkdirSync(f.paths.health.statusDir, { recursive: true });
	const oldStatus = path.join(f.paths.health.statusDir, "old-session.json");
	fs.writeFileSync(oldStatus, "{}");
	const oldS = (start - 8 * 24 * 60 * 60_000) / 1000;
	fs.utimesSync(oldStatus, oldS, oldS);
	const live = () => makeWorld({ now: clock.now(), procsFresh: true, sessions: [sessionState({ id: "m1", startedMs: start - 1000 })], sensors: [{ sessionId: "m1", pid: 4321, ts: clock.now(), idle: true }] });
	const empty = () => makeWorld({ now: clock.now(), procsFresh: true });
	const boards = [];
	const engine = () => ({
		async tick() {
			ticks++;
			if (ticks > 1) boards.push(JSON.parse(fs.readFileSync(f.paths.health.sessionsSnapshotFile, "utf8")));
			return { findings: [], world: ticks === 1 ? live() : empty() };
		},
		table: { all: () => [] }, close() {},
	});
	await runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock, overrides: { procs: { kind: "fake" }, createEngine: engine } });
	assert.ok(ticks >= 2);
	assert.deepEqual(boards[0].groups.flatMap((g) => g.sessions.map((s) => s.sessionId)), ["m1"]);
	const last = JSON.parse(fs.readFileSync(f.paths.health.sessionsSnapshotFile, "utf8"));
	assert.deepEqual(last.groups, []);
	const ledger = fs.readdirSync(f.paths.health.sessionsDir);
	assert.ok(ledger.includes(".backfilled"));
	const ended = ledger.filter((n) => n.startsWith("ended-")).flatMap((n) => fs.readFileSync(path.join(f.paths.health.sessionsDir, n), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
	assert.deepEqual(ended.map((r) => [r.sessionId, r.source]), [["m1", "live"]]);
	assert.equal(fs.existsSync(oldStatus), false);
	const log = fs.readFileSync(path.join(f.paths.health.logsDir, "daemon.log"), "utf8");
	assert.equal(log.match(/session_backfill/g)?.length, 1);
	assert.equal(log.match(/retention_pruned/g)?.length, 1);
});

test("a package daemon with a present source does not remove its Run value", async () => {
	const f = fixture();
	const source = path.join(f.paths.healthHome, "package");
	fs.mkdirSync(source, { recursive: true });
	fs.mkdirSync(f.paths.health.appDir, { recursive: true });
	fs.writeFileSync(f.paths.health.currentFile, JSON.stringify({ channel: "package", source }));
	const removed = [];
	const env = { OMO_HEALTH_RUN_VALUE: "custom-health", OMO_HEALTH_ORPHAN_GRACE_MS: "120000" };
	const engine = () => ({
		async tick() { f.clockNow += 60_000; return { findings: [] }; },
		table: { all: () => [] }, close() {},
	});
	f.clockNow = 100_000;
	const clock = { now: () => f.clockNow };
	const createEngine = engine;
	const result = await runDaemon({
		proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 20 * 60_000 }, clock,
		overrides: {
			env, procs: { kind: "fake" }, createEngine,
			regRunner: (args) => (removed.push(args), { status: 0 }),
			sleep: async () => {},
		},
	});
	assert.equal(result.reason, "idle-no-omo-hosts", "the source remained present");
	assert.deepEqual(removed, []);
});

test("a missing package source does not uninstall before the grace period", async () => {
	const f = fixture();
	fs.mkdirSync(f.paths.health.appDir, { recursive: true });
	fs.writeFileSync(f.paths.health.currentFile, JSON.stringify({ channel: "package", source: path.join(f.paths.healthHome, "missing") }));
	const removed = [];
	const result = await runDaemon({
		proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 60_000 }, clock: f.clock,
		overrides: { env: { OMO_HEALTH_ORPHAN_GRACE_MS: "120000" }, procs: { kind: "fake" }, createEngine: f.fakeEngine, regRunner: (args) => (removed.push(args), { status: 0 }), sleep: async () => {} },
	});
	assert.equal(result.reason, "idle-no-omo-hosts");
	assert.deepEqual(removed, []);
	assert.equal(fs.existsSync(f.paths.health.stoppedFile), false);
});

test("a missing package source uninstalls at grace, and a returning source resets its timer", async (t) => {
	for (const reappear of [false, true]) {
		await t.test(reappear ? "reappearance resets first-missing time" : "missing beyond grace uninstalls", async () => {
			const f = fixture();
			const source = path.join(f.paths.healthHome, "package");
			fs.mkdirSync(f.paths.health.appDir, { recursive: true });
			fs.writeFileSync(f.paths.health.currentFile, JSON.stringify({ channel: "package", source }));
			const removed = [];
			const env = { OMO_HEALTH_RUN_VALUE: "custom-health", OMO_HEALTH_ORPHAN_GRACE_MS: "120000" };
			let now = 100_000;
			let ticks = 0;
			const createEngine = () => ({
				async tick() {
					ticks++;
					now += 60_000;
					if (reappear && ticks === 2) fs.mkdirSync(source, { recursive: true });
					if (reappear && ticks === 3) fs.rmSync(source, { recursive: true, force: true });
					// Missing again since tick 3: two ticks later it is still inside the grace window, then stop for good.
					if (reappear && ticks === 5) fs.writeFileSync(f.paths.health.stoppedFile, "");
					return { findings: [] };
				},
				table: { all: () => [] }, close() {},
			});
			const result = await runDaemon({
				proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 20 * 60_000 },
				clock: { now: () => now },
				overrides: { env, procs: { kind: "fake" }, createEngine, regRunner: (args) => (removed.push(args), { status: 0 }), sleep: async () => {} },
			});
			if (reappear) {
				assert.equal(result.reason, "stopped-file");
				assert.deepEqual(removed, []);
				assert.equal(ticks, 5);
			} else {
				assert.equal(result.reason, "package-removed");
				assert.deepEqual(removed, [["delete", RUN_KEY, "/v", "custom-health", "/f"]]);
				assert.equal(fs.existsSync(f.paths.health.stoppedFile), true);
				assert.equal(JSON.parse(fs.readFileSync(f.paths.health.daemonJson, "utf8")).exitReason, "package-removed");
			}
		});
	}
});

test("the engine receives the downtime read before this start overwrites the previous heartbeat", async () => {
	const HOUR = 60 * 60_000;
	const now = 1_800_000_000_000;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-downtime-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ ts: now - 3 * HOUR, pid: 7, exitReason: "crash" }));
	fs.writeFileSync(paths.health.stateFile, JSON.stringify({ v: 1, savedMs: now - 3 * HOUR }));
	let captured;
	let ticks = 0;
	const createEngine = (opts) => {
		captured = opts.options?.downtime;
		return {
			async tick() { ticks++; return { findings: [] }; },
			table: { all: () => [] }, close() {},
		};
	};
	await runDaemon({
		proc: fakeProc(), paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock: { now: () => now + ticks * 60_000 }, uptimeMs: 5 * HOUR,
		overrides: { procs: { kind: "fake" }, createEngine },
	});
	assert.ok(["reboot", "daemon-down"].includes(captured?.kind));
	const record = JSON.parse(fs.readFileSync(path.join(paths.health.bootGapsDir, `${now - 3 * HOUR}.json`), "utf8"));
	assert.equal(record.downSinceMs, now - 3 * HOUR);
	assert.equal(record.upAtMs, now);
	assert.deepEqual(captured, record);
});

test("a downtime record that cannot be written is logged and the daemon still starts without one", async () => {
	const HOUR = 60 * 60_000;
	const now = 1_800_000_000_000;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-downtime-fail-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ ts: now - 3 * HOUR, pid: 7, exitReason: "crash" }));
	fs.writeFileSync(paths.health.bootGapsDir, "a file where the gap folder belongs");
	let captured = "unset";
	let ticks = 0;
	const createEngine = (opts) => {
		captured = opts.options?.downtime;
		return {
			async tick() { ticks++; return { findings: [] }; },
			table: { all: () => [] }, close() {},
		};
	};
	const result = await runDaemon({
		proc: fakeProc(), paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock: { now: () => now + ticks * 60_000 }, uptimeMs: 5 * HOUR,
		overrides: { procs: { kind: "fake" }, createEngine },
	});
	assert.equal(result.exitCode, 0);
	assert.ok(ticks > 0, "the daemon ran its ticks");
	assert.equal(captured, undefined);
	assert.match(fs.readFileSync(path.join(paths.health.logsDir, "daemon.log"), "utf8"), /"event":"downtime_error"/);
});

test("a fresh previous heartbeat gives the engine no downtime", async () => {
	const now = 1_800_000_000_000;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-downtime-fresh-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ ts: now - 60_000, pid: 7 }));
	fs.writeFileSync(paths.health.stateFile, JSON.stringify({ v: 1, savedMs: now - 60_000 }));
	let captured;
	let ticks = 0;
	const createEngine = (opts) => {
		captured = opts.options?.downtime;
		return {
			async tick() { ticks++; return { findings: [] }; },
			table: { all: () => [] }, close() {},
		};
	};
	await runDaemon({
		proc: fakeProc(), paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * 60_000 }, clock: { now: () => now + ticks * 60_000 }, uptimeMs: 5 * 60 * 60_000,
		overrides: { procs: { kind: "fake" }, createEngine },
	});
	assert.equal(captured, undefined);
	const log = fs.readFileSync(path.join(paths.health.logsDir, "daemon.log"), "utf8");
	assert.match(log, /"event":"downtime","kind":"none"/);
});

test("a pinned daemon never uninstalls when its source path is missing", async () => {
	const f = fixture();
	fs.mkdirSync(f.paths.health.appDir, { recursive: true });
	fs.writeFileSync(f.paths.health.currentFile, JSON.stringify({ channel: "pinned", source: path.join(f.paths.healthHome, "missing") }));
	const removed = [];
	const result = await runDaemon({
		proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 60_000 }, clock: f.clock,
		overrides: { env: { OMO_HEALTH_ORPHAN_GRACE_MS: "1" }, procs: { kind: "fake" }, createEngine: f.fakeEngine, regRunner: (args) => (removed.push(args), { status: 0 }), sleep: async () => {} },
	});
	assert.equal(result.reason, "idle-no-omo-hosts");
	assert.deepEqual(removed, []);
});
