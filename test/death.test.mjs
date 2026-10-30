import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { acquireLock, releaseLock } from "../src/daemon.mjs";
import { isOurDaemon } from "../src/death.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

function sandbox() {
	const root = tmpDir("omoh-death-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return paths;
}

function probe(commandLine, calls) {
	return (command, args) => {
		calls.push({ command, args });
		if (command === "powershell.exe") return commandLine;
		if (command === "taskkill.exe") return "SUCCESS";
		throw new Error(`unexpected executable: ${command}`);
	};
}

test("process identity requires the health entry point and daemon argument", () => {
	for (const line of ["node other-app.mjs daemon", "node omo-health.mjs care tick", "node unrelated/boot.mjs daemon"]) {
		assert.equal(isOurDaemon(42, probe(line, [])), false, line);
	}
	assert.equal(isOurDaemon(42, probe('node C:/app/omo-health/boot.mjs daemon', [])), true);
	// The pinned install (todo 6): boot.mjs under the health home, and the pinned release root it starts.
	for (const line of ['"C:\\Program Files\\nodejs\\node.exe" --max-semi-space-size=1 --max-old-space-size=96 "C:\\Users\\u\\.omo-health\\app\\boot.mjs" daemon', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.omo-health\\app\\releases\\0.5.0-abc1234\\bin\\omo-health.mjs" daemon --shadow']) {
		assert.equal(isOurDaemon(42, probe(line, [])), true, line);
	}
});

test("a confirmed hung health daemon is killed, recorded, and its lock taken", () => {
	const paths = sandbox();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: "ignore" });
	const now = Date.now();
	const ts = now - 4 * 60_000;
	const calls = [];
	try {
		fs.writeFileSync(paths.health.lockFile, JSON.stringify({ pid: child.pid, startedMs: now - 600_000 }));
		fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, ts, version: "1.2.3" }));
		const result = acquireLock(paths, now, { exec: probe('node C:/omo-health/app/boot.mjs daemon', calls), wait: (ms) => assert.equal(ms, 20_000) });
		assert.equal(result.ok, true);
		assert.equal(calls.filter((call) => call.command === "taskkill.exe").length, 1);
		assert.deepEqual(calls.find((call) => call.command === "taskkill.exe").args, ["/F", "/PID", String(child.pid)]);
		const names = fs.readdirSync(paths.health.deathsDir);
		assert.equal(names.length, 1);
		assert.match(names[0], /-hung\.json$/);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.health.deathsDir, names[0]))), { kind: "hung", pid: child.pid, lastTs: ts, version: "1.2.3" });
		assert.equal(JSON.parse(fs.readFileSync(paths.health.lockFile)).pid, process.pid);
	} finally {
		releaseLock(paths);
		child.kill();
	}
});

test("an unrelated live holder is never killed and retains its recent lock", () => {
	const paths = sandbox();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: "ignore" });
	const now = Date.now();
	const calls = [];
	try {
		fs.writeFileSync(paths.health.lockFile, JSON.stringify({ pid: child.pid, startedMs: now - 600_000 }));
		fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, ts: now - 4 * 60_000 }));
		assert.equal(acquireLock(paths, now, { exec: probe('node C:/other/service.mjs daemon', calls), wait: () => {} }).ok, false);
		assert.equal(calls.some((call) => call.command === "taskkill.exe"), false);
		assert.equal(fs.existsSync(paths.health.deathsDir), false);
		assert.equal(JSON.parse(fs.readFileSync(paths.health.lockFile)).pid, child.pid);
	} finally {
		child.kill();
	}
});

test("a heartbeat that advances during the confirmation window prevents a kill", () => {
	const paths = sandbox();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: "ignore" });
	const now = Date.now();
	const calls = [];
	try {
		fs.writeFileSync(paths.health.lockFile, JSON.stringify({ pid: child.pid, startedMs: now - 600_000 }));
		fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, ts: now - 4 * 60_000 }));
		const wait = () => fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, ts: now, version: "1.2.3" }));
		assert.equal(acquireLock(paths, now, { exec: probe('node C:/omo-health/boot.mjs daemon', calls), wait }).ok, false);
		assert.equal(calls.some((call) => call.command === "taskkill.exe"), false);
		assert.equal(fs.existsSync(paths.health.deathsDir), false);
	} finally {
		child.kill();
	}
});

/** A live holder of daemon.lock with the given heartbeat; returns what a new starter's acquireLock did to it. */
function takeover(heartbeat, { wait = () => {}, tickWaitMs = 90_000 } = {}) {
	const paths = sandbox();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: "ignore" });
	const now = Date.now();
	const calls = [];
	try {
		fs.writeFileSync(paths.health.lockFile, JSON.stringify({ pid: child.pid, startedMs: now - 600_000 }));
		fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, version: "1.2.3", ...heartbeat(now) }));
		const result = acquireLock(paths, now, { exec: probe('node C:/omo-health/app/boot.mjs daemon', calls), wait: () => wait(paths, child.pid, now), tickWaitMs });
		return { ok: result.ok, killed: calls.some((call) => call.command === "taskkill.exe"), deaths: fs.existsSync(paths.health.deathsDir) };
	} finally {
		releaseLock(paths);
		child.kill();
	}
}

test("a daemon inside a tick younger than analyst.timeoutMs + 30 s is not killed although its heartbeat is minutes old", () => {
	// Resumed from sleep: the heartbeat is from before the sleep and the tick that followed is still running.
	assert.deepEqual(takeover((now) => ({ ts: now - 4 * 60_000, tickStartedMs: now - 100_000 })), { ok: false, killed: false, deaths: false });
	// A tick stuck for longer than that is still a hang.
	assert.deepEqual(takeover((now) => ({ ts: now - 5 * 60_000, tickStartedMs: now - 121_000 })), { ok: true, killed: true, deaths: true });
	assert.deepEqual(takeover((now) => ({ ts: now - 5 * 60_000, tickStartedMs: now - 31_000 }), { tickWaitMs: 0 }), { ok: true, killed: true, deaths: true });
});

test("a tick that starts during the confirmation window prevents a kill even while the heartbeat stays old", () => {
	const startTick = (paths, pid, now) => fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid, version: "1.2.3", ts: now - 4 * 60_000, tickStartedMs: now }));
	assert.deepEqual(takeover((now) => ({ ts: now - 4 * 60_000, tickStartedMs: now - 4 * 60_000 - 1000 }), { wait: startTick }), { ok: false, killed: false, deaths: false });
});
