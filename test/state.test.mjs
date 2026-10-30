import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFinding } from "../src/detect/finding.mjs";
import { isOmoLauncher, isSenpiHost } from "../src/state.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const HOST = raw(32552, 28000, "node.exe", "2026-09-23T10:00:00Z", 1000, 1e8, '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js --extension x');

test("world links hosts, children and liveness", () => {
	const task = taskRecord({ taskId: "st_a", hostPid: 32552, parentSessionId: "p1" });
	const child = sessionState({ id: "c1", kind: "child", taskId: "st_a", hostPid: 32552, parentSessionId: "p1", task });
	const main = sessionState({ id: "p1", kind: "main" });
	const deadTask = taskRecord({ taskId: "st_dead", hostPid: 999 });
	const deadChild = sessionState({ id: "c9", kind: "child", taskId: "st_dead", hostPid: 999, task: deadTask });
	const world = makeWorld({
		now: NOW,
		sessions: [main, child, deadChild],
		sensors: [{ sessionId: "p1", pid: 32552, ts: NOW - 5000 }],
		procSnapshots: [{ takenAtMs: NOW, rows: [HOST] }],
	});
	assert.equal(world.liveHostPids.has(32552), true);
	assert.equal(world.hosts.get(32552).sessionIds.has("c1"), true);
	assert.equal(world.children.get("st_a").session.id, "c1");
	assert.equal(world.isSessionLive(child), true);
	assert.equal(world.isSessionLive(deadChild), false);
	assert.equal(world.isSessionLive(main), true, "fresh sensor heartbeat");
	assert.equal(world.parentOf(child).id, "p1");
});

test("bun-hosted senpi and omo launcher are recognized without classifying unrelated bun processes", () => {
	const host = raw(94520, 1, "bun.exe", "2026-09-27T00:00:00Z", 0, 1e8, 'bun.exe C:\\Users\\user\\.bun\\install\\global\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js --extension x');
	const launcher = raw(94521, 1, "bun.exe", "2026-09-27T00:00:00Z", 0, 1e8, 'bun.exe C:\\Users\\user\\.bun\\install\\global\\node_modules\\omo-ai\\bin\\omo.js');
	assert.equal(isSenpiHost({ name: host.n, cmd: host.cl }), true);
	assert.equal(isOmoLauncher({ name: launcher.n, cmd: launcher.cl }), true);
	assert.equal(isSenpiHost({ name: host.n, cmd: "bun.exe unrelated.js" }), false);
	assert.equal(isOmoLauncher({ name: "python.exe", cmd: launcher.cl }), false);
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "bun-main", kind: "main", hostPid: 94520 })], procSnapshots: [{ takenAtMs: NOW, rows: [host] }] });
	assert.equal(world.liveHostPids.has(94520), true);
	assert.equal(world.isSessionLive(world.sessions.get("bun-main")), true);
});

test("a stale sensor heartbeat without a known host means not live", () => {
	const main = sessionState({ id: "p2", kind: "main" });
	const world = makeWorld({ now: NOW, sessions: [main], sensors: [{ sessionId: "p2", pid: 5, ts: NOW - 120_000 }] });
	assert.equal(world.isSessionLive(main), false);
	assert.equal(world.sensorFor("p2"), undefined);
});

test("the daemon and its descendants are protected", () => {
	const world = makeWorld({
		now: NOW,
		self: { pid: 700 },
		procSnapshots: [{ takenAtMs: NOW, rows: [raw(700, 1, "node.exe", "2026-09-23T15:00:00Z"), raw(701, 700, "powershell.exe", "2026-09-23T15:00:01Z"), raw(702, 1, "grep.exe", "2026-09-23T15:30:00Z")] }],
	});
	assert.deepEqual([...world.protectedPids].sort(), [700, 701]);
});

test("finding fingerprints are stable per subject and class", () => {
	const a = makeFinding({ detector: "D1", kind: "stall", subject: { sessionId: "c1", toolCallId: "t1" }, cls: "runaway-readonly" });
	const b = makeFinding({ detector: "D1", kind: "stall", subject: { sessionId: "c1", toolCallId: "t1" }, cls: "runaway-readonly" });
	const c = makeFinding({ detector: "D1", kind: "stall", subject: { sessionId: "c1", toolCallId: "t2" }, cls: "runaway-readonly" });
	assert.equal(a.fp, b.fp);
	assert.notEqual(a.fp, c.fp);
	assert.equal(a.fp.length, 16);
});
