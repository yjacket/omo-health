import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createFixtureSource, createPowerShellSource, normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { createFakeClock } from "../src/util/time.mjs";

const T0 = Date.parse("2026-09-23T15:37:00Z");
const raw = (p, pp, n, c, cpu, pv, cl = "") => ({ p, pp, n, c, cpu, pv, ws: pv, cl });

test("cpu fraction and memory growth are computed across snapshots", () => {
	const tracker = new ProcessTracker();
	const c = "2026-09-23T15:37:05.0000000Z";
	tracker.update({ takenAtMs: T0, rows: normalizeRows([raw(55000, 62120, "grep.exe", c, 1_000, 100 * 2 ** 20)]) });
	tracker.update({ takenAtMs: T0 + 20_000, rows: normalizeRows([raw(55000, 62120, "grep.exe", c, 20_000, 150 * 2 ** 20)]) });
	const table = tracker.update({ takenAtMs: T0 + 40_000, rows: normalizeRows([raw(55000, 62120, "grep.exe", c, 39_500, 200 * 2 ** 20)]) });
	const proc = table.get(55000);
	const fracs = table.cpuFracs(proc, 2);
	assert.equal(fracs.length, 2);
	assert.ok(fracs.every((f) => f > 0.9 && f <= 1));
	assert.equal(Math.round(table.growthMBPerMin(proc, 300_000)), 150);
	assert.equal(table.isOrphan(proc), true);
});

test("a reused PID never inherits another process's history or children", () => {
	const tracker = new ProcessTracker();
	tracker.update({ takenAtMs: T0, rows: normalizeRows([raw(100, 1, "node.exe", "2026-09-23T15:00:00Z", 5_000, 0)]) });
	const table = tracker.update({
		takenAtMs: T0 + 20_000,
		rows: normalizeRows([
			raw(100, 1, "node.exe", "2026-09-23T15:36:59Z", 10, 0),
			// child older than the process now holding its parent's PID: orphan
			raw(200, 100, "grep.exe", "2026-09-23T15:30:00Z", 10, 0),
		]),
	});
	assert.deepEqual(table.cpuFracs(table.get(100), 2), []);
	assert.equal(table.isOrphan(table.get(200)), true);
	assert.deepEqual(table.children(100), []);
	assert.equal(table.isAlive(100, "2026-09-23T15:00:00Z"), false);
});

test("descendants and ancestors follow valid parent links", () => {
	const tracker = new ProcessTracker();
	const table = tracker.update({
		takenAtMs: T0,
		rows: normalizeRows([
			raw(10, 1, "node.exe", "2026-09-23T10:00:00Z", 0, 0, "node cli.js"),
			raw(11, 10, "bash.exe", "2026-09-23T15:00:00Z", 0, 0, 'bash -c "x"'),
			raw(12, 11, "bash.exe", "2026-09-23T15:00:01Z", 0, 0),
			raw(13, 12, "node.exe", "2026-09-23T15:00:02Z", 0, 0),
		]),
	});
	assert.deepEqual(table.descendants(10).map((p) => p.pid).sort(), [11, 12, 13]);
	assert.deepEqual(table.ancestors(13).map((p) => p.pid), [12, 11, 10]);
	assert.equal(table.isDescendantOf(13, 10), true);
});

test("normalizeRows maps window visibility and a redacted title, and omits them when the worker sent none", () => {
	const [shown, hidden, untitled, legacy] = normalizeRows([
		{ ...raw(1, 0, "notepad.exe", null, 0, 0), wv: true, wt: "export CLAUDE_CODE_OAUTH_TOKEN=sk-secret - Notepad" },
		{ ...raw(2, 0, "node.exe", null, 0, 0), wv: false },
		{ ...raw(3, 0, "explorer.exe", null, 0, 0), wv: true, wt: "" },
		raw(4, 0, "x.exe", null, 0, 0),
	]);
	assert.equal(shown.windowVisible, true);
	assert.equal(shown.windowTitle, "export CLAUDE_CODE_OAUTH_TOKEN=[REDACTED] - Notepad");
	assert.equal(hidden.windowVisible, false);
	assert.equal("windowTitle" in hidden, false);
	assert.equal(untitled.windowVisible, true);
	assert.equal("windowTitle" in untitled, false);
	assert.equal("windowVisible" in legacy, false);
});

test("fixture source replays the latest snapshot at or before the clock", async () => {
	const clock = createFakeClock(T0 + 5_000);
	const source = createFixtureSource({
		clock,
		records: [
			{ ts: "2026-09-23T15:37:00Z", procs: [raw(1, 0, "a.exe", "2026-09-23T10:00:00Z", 1, 1)], os: { totalVirtualKB: 100, freeVirtualKB: 5, totalVisibleKB: 50, freePhysicalKB: 1 } },
			{ ts: "2026-09-23T15:37:20Z", procs: [raw(2, 0, "b.exe", "2026-09-23T10:00:00Z", 1, 1)] },
		],
	});
	assert.equal((await source.snapshot()).rows[0].name, "a.exe");
	assert.equal((await source.os()).commitFrac, 0.95);
	clock.advance(20_000);
	assert.equal((await source.snapshot()).rows[0].name, "b.exe");
});

test("missing commit fields never read as exhausted commit", async () => {
	const { normalizeOs } = await import("../src/collect/procs.mjs");
	assert.equal(normalizeOs({ totalVirtualKB: 100, freeVirtualKB: null, totalVisibleKB: 1, freePhysicalKB: 1 }), undefined);
	assert.equal(normalizeOs({ totalVirtualKB: 0, freeVirtualKB: 0 }), undefined);
	assert.equal(normalizeOs({ totalVirtualKB: 100, freeVirtualKB: 25, totalVisibleKB: 1, freePhysicalKB: 1 }).commitFrac, 0.75);
});

function fakeWorkerSpawn(behaviour) {
	const spawned = [];
	const spawnImpl = () => {
		const child = new EventEmitter();
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.pid = 9000 + spawned.length;
		child.kill = () => child.emit("exit", 1);
		child.stdin.on("data", (buf) => {
			for (const cmd of String(buf).split("\n").filter(Boolean)) behaviour(cmd, child, spawned.length);
		});
		spawned.push(child);
		return child;
	};
	return { spawnImpl, spawned };
}

test("powershell source restarts the worker after it dies", async () => {
	const { spawnImpl, spawned } = fakeWorkerSpawn((cmd, child) => {
		if (cmd === "snap") child.stdout.write(`${JSON.stringify({ cmd, ok: true, ts: "2026-09-23T15:37:00Z", data: [raw(1, 0, "x.exe", null, 0, 0)] })}\n`);
		if (cmd === "ping") child.stdout.write(`${JSON.stringify({ cmd, ok: true, data: 1 })}\n`);
	});
	const source = createPowerShellSource({ spawnImpl, timeoutMs: 1000 });
	assert.equal((await source.snapshot()).rows.length, 1);
	spawned[0].emit("exit", 1);
	assert.equal((await source.snapshot()).rows[0].name, "x.exe");
	assert.equal(spawned.length, 2);
	assert.equal(source.restarts, 1);
});

test("the worker's integrity levels reach the rows and the table; without them nothing changes", async () => {
	const { spawnImpl } = fakeWorkerSpawn((cmd, child) => {
		if (cmd === "snap") child.stdout.write(`${JSON.stringify({ cmd, ok: true, ts: "2026-09-29T11:38:30Z", il: 8192, data: [{ ...raw(91088, 29648, "bash.exe", "2026-09-29T11:38:25.3398720Z", 0, 0, 'bash -c "tail"'), il: 12288 }, raw(2, 0, "x.exe", null, 0, 0)] })}\n`);
	});
	const table = new ProcessTracker().update(await createPowerShellSource({ spawnImpl, timeoutMs: 1000 }).snapshot());
	assert.equal(table.integrity, 8192);
	assert.equal(table.get(91088).il, 12288);
	assert.equal("il" in table.get(2), false);
	assert.equal(new ProcessTracker().update({ rows: normalizeRows([raw(1, 0, "x.exe", null, 0, 0)]), takenAtMs: T0 }).integrity, undefined);
});

test("powershell source times out a silent worker and recovers", async () => {
	let calls = 0;
	const { spawnImpl, spawned } = fakeWorkerSpawn((cmd, child) => {
		calls += 1;
		if (calls > 1) child.stdout.write(`${JSON.stringify({ cmd, ok: true, data: { totalVirtualKB: 10, freeVirtualKB: 5, totalVisibleKB: 1, freePhysicalKB: 1 } })}\n`);
	});
	const source = createPowerShellSource({ spawnImpl, timeoutMs: 50 });
	await assert.rejects(source.os(), /timeout/);
	assert.equal((await source.os()).commitFrac, 0.5);
	assert.equal(spawned.length, 2);
});
