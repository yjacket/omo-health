import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { runDaemon } from "../src/daemon.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { fakeProc, guardProcessListeners } from "./helpers/fake-proc.mjs";

guardProcessListeners();

const created = [];
after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** Fake engine that records the config object it was built with and its actions.kill at every tick. */
function fixture({ onTick = () => {} } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-daemon-reload-"));
	created.push(root);
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	let now = 100_000;
	const seen = { config: undefined, kills: [], configs: [] };
	let ticks = 0;
	const createEngine = ({ config }) => {
		seen.config = config;
		return {
			async tick() {
				ticks++;
				seen.kills.push(config.actions.kill);
				seen.configs.push(config);
				onTick(ticks, paths);
				now += 60_000;
				return { findings: [] };
			},
			table: { all: () => [] },
			close() {},
		};
	};
	return { paths, seen, clock: { now: () => now }, overrides: { procs: { kind: "fake" }, createEngine, env: {} } };
}

const writeConfig = (paths, value, mtimeSec) => {
	fs.writeFileSync(paths.health.configFile, JSON.stringify(value));
	fs.utimesSync(paths.health.configFile, mtimeSec, mtimeSec);
};

test("with configEnv an edit between ticks reaches the engine's config object and the heartbeat", { timeout: 20_000 }, async () => {
	const base = { idleExitMs: 150_000 };
	const f = fixture({ onTick: (tick, paths) => tick === 1 && writeConfig(paths, { ...base, actions: { kill: false } }, 1_800_000_100) });
	writeConfig(f.paths, base, 1_800_000_000);
	const result = await runDaemon({ proc: fakeProc(), paths: f.paths, config: { ...DEFAULT_CONFIG }, clock: f.clock, overrides: f.overrides, configEnv: {} });
	assert.equal(result.reason, "idle-no-omo-hosts", "idleExitMs came from config.json");
	assert.deepEqual(f.seen.kills, [true, false, false]);
	assert.ok(f.seen.configs.every((c) => c === f.seen.config), "the engine keeps one config object");
	const hb = JSON.parse(fs.readFileSync(f.paths.health.daemonJson, "utf8"));
	assert.equal(hb.config.effective["actions.kill"], false);
	assert.equal(hb.config.source, "file");
	assert.equal(hb.config.fileMtimeMs, fs.statSync(f.paths.health.configFile).mtimeMs);
});

test("runDaemon attaches its process handlers to the injected proc and detaches them when it returns", { timeout: 20_000 }, async () => {
	const events = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];
	const counts = (target) => events.map((event) => target.listenerCount(event));
	const realBefore = counts(process);
	const proc = fakeProc();
	const attached = [];
	const f = fixture({ onTick: (tick) => tick === 1 && attached.push(counts(proc)) });
	await runDaemon({ paths: f.paths, config: { ...DEFAULT_CONFIG, idleExitMs: 90_000 }, clock: f.clock, overrides: f.overrides, proc });
	assert.deepEqual(attached, [[1, 1, 1, 1]], "the handlers are on the injected proc while the daemon runs");
	assert.deepEqual(counts(proc), [0, 0, 0, 0], "and gone once it returned");
	assert.deepEqual(counts(process), realBefore, "the real process is never touched");
});

test("without configEnv the daemon never reads config.json and the heartbeat has no config", { timeout: 20_000 }, async () => {
	const f = fixture();
	writeConfig(f.paths, { actions: { kill: false }, idleExitMs: 1 }, 1_800_000_000);
	const injected = { ...DEFAULT_CONFIG, idleExitMs: 90_000 };
	await runDaemon({ proc: fakeProc(), paths: f.paths, config: injected, clock: f.clock, overrides: f.overrides });
	assert.deepEqual(f.seen.kills, [true, true]);
	assert.equal(f.seen.config.idleExitMs, 90_000);
	const hb = JSON.parse(fs.readFileSync(f.paths.health.daemonJson, "utf8"));
	assert.equal("config" in hb, false);
});
