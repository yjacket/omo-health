import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { executeKill } from "../src/act/kill.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { sha1 } from "../src/util/text.mjs";

const iso = (s) => `2026-09-23T15:${s}:00.0000000Z`;
const row = (p, n, c, cl = n, pp = 1) => ({ p, pp, n, c, cpu: 0, pv: 0, ws: 0, cl });

function fakeSnapshots(sequence) {
	let i = 0;
	return async () => {
		const rows = sequence[Math.min(i, sequence.length - 1)];
		i += 1;
		return new ProcessTracker().update({ takenAtMs: i, rows: normalizeRows(rows) });
	};
}

const guard = { protectedPids: new Set([1]), liveHostPids: new Set([10]), hosts: new Map() };

test("kills verified targets one PID at a time and reports survivors", async () => {
	const killed = [];
	const snapshot = fakeSnapshots([
		[row(100, "grep.exe", iso("40")), row(101, "yes.exe", iso("40"))],
		[row(101, "yes.exe", iso("40"))],
	]);
	const out = await executeKill({
		request: { kind: "kill-pids", targets: [{ pid: 100, ctime: iso("40") }, { pid: 101, ctime: iso("40") }] },
		snapshot,
		guard,
		runner: (pid) => (killed.push(pid), { status: 0 }),
		sleep: async () => {},
		attempts: 1,
	});
	assert.deepEqual(killed, [100, 101]);
	assert.deepEqual(out.killed.map((p) => p.pid), [100]);
	assert.deepEqual(out.survived.map((p) => p.pid), [101]);
});

test("a failed check after the kill reports the taskkill result instead of throwing", async () => {
	let calls = 0;
	const first = fakeSnapshots([[row(100, "grep.exe", iso("40")), row(101, "yes.exe", iso("40"))]]);
	const snapshot = async () => {
		calls += 1;
		if (calls > 1) throw new Error("ps worker exited (1)");
		return first();
	};
	const out = await executeKill({
		request: { kind: "kill-pids", targets: [{ pid: 100, ctime: iso("40") }, { pid: 101, ctime: iso("40") }] },
		snapshot,
		guard,
		runner: (pid) => (pid === 101 ? { status: 1, error: "access denied" } : { status: 0 }),
		sleep: async () => {},
	});
	assert.deepEqual(out.killed.map((p) => p.pid), [100]);
	assert.deepEqual(out.survived.map((p) => p.pid), [101]);
	assert.ok(out.unverified);
});

test("a reused PID, a changed command line, a vanished process and protected processes are no-ops", async () => {
	const killed = [];
	const snapshot = fakeSnapshots([[row(200, "grep.exe", iso("50")), row(201, "node.exe", iso("40"), "node other.js"), row(10, "node.exe", iso("00"), "senpi cli.js"), row(300, "claude.exe", iso("40"))]]);
	const out = await executeKill({
		request: {
			kind: "release-shell",
			targets: [
				{ pid: 200, ctime: iso("40") },
				{ pid: 201, ctime: iso("40"), cmdSha1: sha1("node mine.js") },
				{ pid: 202, ctime: iso("40") },
				{ pid: 10, ctime: iso("00") },
				{ pid: 300, ctime: iso("40") },
			],
		},
		snapshot,
		guard,
		runner: (pid) => (killed.push(pid), { status: 0 }),
		sleep: async () => {},
	});
	assert.deepEqual(killed, []);
	assert.deepEqual(out.noop.map((n) => n.reason), ["pid-reused", "command-changed", "gone", "protected", "protected"]);
});

test("detach-server never kills the server it keeps", async () => {
	const killed = [];
	const snapshot = fakeSnapshots([[row(25628, "bash.exe", iso("34")), row(60496, "node.exe", iso("34"))], [row(60496, "node.exe", iso("34"))]]);
	const out = await executeKill({
		request: { kind: "detach-server", targets: [{ pid: 25628, ctime: iso("34") }, { pid: 60496, ctime: iso("34") }], serverPids: [{ pid: 60496 }] },
		snapshot,
		guard,
		runner: (pid) => (killed.push(pid), { status: 0 }),
		sleep: async () => {},
	});
	assert.deepEqual(killed, [25628]);
	assert.deepEqual(out.noop, [{ pid: 60496, reason: "server-kept" }]);
});

test("live: a real idle node process is terminated through taskkill", { skip: process.platform !== "win32" }, async () => {
	const { createPowerShellSource, ProcessTracker: Tracker } = await import("../src/collect/procs.mjs");
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
	const source = createPowerShellSource();
	const tracker = new Tracker();
	const snapshot = async () => tracker.update(await source.snapshot());
	try {
		const first = await snapshot();
		const proc = first.get(child.pid);
		assert.ok(proc, "spawned process visible in snapshot");
		const out = await executeKill({ request: { kind: "kill-pids", targets: [{ pid: proc.pid, ctime: proc.ctime, cmdSha1: sha1(proc.cmd) }] }, snapshot, guard: { protectedPids: new Set([process.pid]), liveHostPids: new Set(), hosts: new Map() }, settleMs: 500 });
		assert.deepEqual(out.killed.map((p) => p.pid), [child.pid]);
	} finally {
		try {
			child.kill();
		} catch {
			// already dead
		}
		source.close();
	}
});
