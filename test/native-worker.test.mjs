import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ensureNativeWorker, findCsc } from "../src/collect/native-worker.mjs";
import { createProcessSource } from "../src/collect/procs.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

function fakeCsc(calls, status = 0) {
	return (command, args) => {
		calls.push(args);
		const out = args.find((a) => a.startsWith("/out:")).slice(5);
		if (status === 0) fs.writeFileSync(out, "MZ");
		return { status, stdout: status ? "error CS0001: boom" : "", stderr: "" };
	};
}

test("ensureNativeWorker builds once per source hash, reuses it, and removes older builds", () => {
	const binDir = tmpDir("omoh-bin-");
	const source = path.join(binDir, "w.cs");
	fs.writeFileSync(source, "class A {}");
	fs.writeFileSync(path.join(binDir, "omoh-procs-000000000000.exe"), "old");
	const calls = [];
	const exe = ensureNativeWorker({ binDir, source, csc: "csc.exe", spawnSyncImpl: fakeCsc(calls) });
	assert.match(path.basename(exe), /^omoh-procs-[0-9a-f]{12}\.exe$/);
	assert.ok(fs.existsSync(exe));
	assert.equal(calls.length, 1);
	assert.ok(calls[0].every((a) => !a.startsWith("/out:") || !a.includes("/", 5)), "csc gets Windows paths only");
	assert.ok(!fs.existsSync(path.join(binDir, "omoh-procs-000000000000.exe")));
	assert.equal(ensureNativeWorker({ binDir, source, csc: "csc.exe", spawnSyncImpl: fakeCsc(calls) }), exe);
	assert.equal(calls.length, 1, "second call reuses the build");
	fs.writeFileSync(source, "class B {}");
	assert.notEqual(ensureNativeWorker({ binDir, source, csc: "csc.exe", spawnSyncImpl: fakeCsc(calls) }), exe, "a source change rebuilds");
});

test("ensureNativeWorker returns undefined on a failed build or without csc, leaving no temp file", () => {
	const binDir = tmpDir("omoh-bin-");
	const source = path.join(binDir, "w.cs");
	fs.writeFileSync(source, "class A {}");
	assert.equal(ensureNativeWorker({ binDir, source, csc: "csc.exe", spawnSyncImpl: fakeCsc([], 1) }), undefined);
	assert.deepEqual(fs.readdirSync(binDir).filter((n) => n.endsWith(".exe")), []);
	assert.equal(ensureNativeWorker({ binDir, source, csc: undefined }), undefined);
});

test("createProcessSource uses the native worker when built and PowerShell otherwise", () => {
	const spawned = [];
	const spawnImpl = (command) => {
		spawned.push(command);
		throw new Error("not started in this test");
	};
	assert.equal(createProcessSource({ binDir: "C:\\x", ensureImpl: () => "C:\\x\\omoh-procs-1.exe", spawnImpl }).kind, "native");
	assert.equal(createProcessSource({ binDir: "C:\\x", ensureImpl: () => undefined, spawnImpl }).kind, "powershell");
	assert.equal(createProcessSource({ spawnImpl }).kind, "powershell");
});

test("live: the compiled worker answers snap, os and ports in the PowerShell worker's format", { skip: !findCsc() }, async () => {
	const binDir = tmpDir("omoh-bin-live-");
	const source = createProcessSource({ binDir });
	try {
		assert.equal(source.kind, "native");
		const snap = await source.snapshot();
		assert.ok(snap.rows.length > 20);
		const self = snap.rows.find((row) => row.pid === process.pid);
		assert.ok(self, "sees this node process");
		assert.equal(self.ppid, process.ppid);
		assert.ok(Number.isFinite(self.ctimeMs) && self.ctimeMs <= Date.now());
		assert.match(self.cmd, /node/i);
		// The worker and this node process share a token, so they report the same integrity level.
		assert.ok(Number.isInteger(snap.integrity) && snap.integrity >= 0x1000, `worker integrity ${snap.integrity}`);
		assert.equal(self.il, snap.integrity);
		// The fallback a non-elevated worker uses for elevated processes, where WMI returns no command line.
		const proc = JSON.parse(spawnSync(ensureNativeWorker({ binDir }), [], { input: `proc ${process.pid}\nexit\n`, encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.split(/\r?\n/)[0]);
		assert.deepEqual([proc.ok, proc.data.p, proc.data.cl, proc.data.il], [true, process.pid, self.cmd, self.il]);
		const os = await source.os();
		assert.ok(os.commitFrac > 0 && os.commitFrac < 1);
		assert.ok(Array.isArray(await source.ports()));
	} finally {
		source.close();
	}
});
