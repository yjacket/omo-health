import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProcessTable } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { elevationTarget, runDaemon } from "../src/daemon.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildWorld } from "../src/state.mjs";
import { fakeProc, guardProcessListeners } from "./helpers/fake-proc.mjs";

guardProcessListeners();

const MEDIUM = 0x2000;
const HIGH = 0x3000;
const HOST = "C:\\Users\\u\\.bun\\bin\\bun.exe C:\\Users\\u\\.bun\\install\\global\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js";

// Native-worker-shaped table: the daemon's own integrity plus one senpi host whose sensor heartbeats.
function world({ now = 1_000_000, own = MEDIUM, hostIl = HIGH, hbAgeMs = 0, cmd = HOST } = {}) {
	const procs = new ProcessTable([{ pid: 66540, ppid: 1, name: "bun.exe", cmd, ctime: "2026-09-29T09:20:00Z", ctimeMs: 1, ...(hostIl === null ? {} : { il: hostIl }) }], now, undefined, own);
	const sensors = new Map([["01a0ec77", { sessionId: "01a0ec77", pid: 66540, ts: now - hbAgeMs }]]);
	return buildWorld({ now, config: DEFAULT_CONFIG, procs, sensors });
}

test("a senpi host with a fresh sensor above the daemon's integrity is the handover target; nothing else is", () => {
	assert.deepEqual(elevationTarget(world()), { pid: 66540, sessionId: "01a0ec77", il: HIGH, own: MEDIUM });
	assert.equal(elevationTarget(world({ own: HIGH })), undefined, "an elevated daemon stays");
	assert.equal(elevationTarget(world({ own: null })), undefined, "PowerShell worker: integrity unknown");
	assert.equal(elevationTarget(world({ hostIl: null })), undefined);
	assert.equal(elevationTarget(world({ hbAgeMs: 60_000 })), undefined, "a stale sensor cannot respawn anything");
	assert.equal(elevationTarget(world({ cmd: "C:\\Windows\\system32\\svchost.exe -k netsvcs" })), undefined, "a reused heartbeat pid is not a host");
});

function daemonRun({ mode = "auto", elevateAtMs } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-elevate-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	if (elevateAtMs !== undefined) {
		fs.mkdirSync(paths.healthHome, { recursive: true });
		fs.writeFileSync(path.join(paths.healthHome, "elevate.json"), JSON.stringify({ atMs: elevateAtMs }));
	}
	let ticks = 0;
	const clock = { now: () => 1_000_000 + ticks * 60_000 };
	const engine = () => ({
		async tick() {
			ticks++;
			return { findings: [], world: world({ now: clock.now() }) };
		},
		table: { all: () => [], integrity: MEDIUM }, close() {},
	});
	const config = { ...DEFAULT_CONFIG, mode, idleExitMs: 60_000 };
	return runDaemon({ proc: fakeProc(), paths, config, clock, overrides: { procs: { kind: "fake" }, createEngine: engine, spawn: () => { throw new Error("no spawn"); } } }).then((result) => ({ result, paths, ticks }));
}

test("a non-elevated auto daemon hands over to an elevated start, at most once per 30 minutes", async () => {
	const { result, paths, ticks } = await daemonRun();
	assert.equal(result.reason, "elevate");
	assert.equal(ticks, 1);
	const hb = JSON.parse(fs.readFileSync(paths.health.daemonJson, "utf8"));
	assert.deepEqual([hb.exitReason, hb.integrity, Number.isFinite(hb.stoppedMs)], ["elevate", MEDIUM, true], "sensors see a stopped daemon and respawn it");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.healthHome, "elevate.json"), "utf8")), { atMs: 1_060_000, pid: process.pid, integrity: MEDIUM, host: 66540, hostIntegrity: HIGH, sessionId: "01a0ec77" });
	const again = await daemonRun({ elevateAtMs: 1_000_000 - 60_000 });
	assert.equal(again.result.reason, "idle-no-omo-hosts", "within the backoff the daemon keeps supervising");
	assert.equal((await daemonRun({ elevateAtMs: 1_000_000 - 30 * 60_000 })).result.reason, "elevate");
});

test("a shadow daemon never hands over: it kills nothing", async () => {
	assert.equal((await daemonRun({ mode: "shadow" })).result.reason, "idle-no-omo-hosts");
});
