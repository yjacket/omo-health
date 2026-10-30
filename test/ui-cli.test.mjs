import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { defaultOpenBrowser, runUiCli } from "../src/ui/cli.mjs";

const TIMEOUT = { timeout: 20_000 };
const BIN = "/fake/bin/omo-health.mjs";

function sink() {
	const chunks = [];
	return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

/** A child that announces { type: "listening", port } once spawned, unless silent. */
function fakeSpawn({ port, silent = false }) {
	const calls = [];
	const child = Object.assign(new EventEmitter(), { pid: 4242, disconnected: false, unrefd: false, killed: false });
	child.disconnect = () => {
		child.disconnected = true;
	};
	child.unref = () => {
		child.unrefd = true;
	};
	child.kill = () => {
		child.killed = true;
	};
	const spawnImpl = (cmd, argv, opts) => {
		calls.push({ cmd, argv, opts });
		if (!silent) setImmediate(() => child.emit("message", { type: "listening", port }));
		return child;
	};
	return { spawnImpl, child, calls };
}

function launch(args, { env = {}, spawnParts, startTimeoutMs = 5_000, openResult = { ok: true } } = {}) {
	const stdout = sink();
	const stderr = sink();
	const opened = [];
	const run = runUiCli(args, {
		paths: null,
		env,
		config: {},
		openBrowser: async (url) => {
			opened.push(url);
			return openResult;
		},
		spawnImpl: spawnParts.spawnImpl,
		execPath: "node-exec",
		binPath: BIN,
		stdout,
		stderr,
		startTimeoutMs,
	});
	return { run, stdout, stderr, opened };
}

test("launcher prints one JSON line and detaches the child when the server reports its port", TIMEOUT, async () => {
	// Given a child that reports port 1234
	const spawnParts = fakeSpawn({ port: 1234 });
	// When the launcher runs with --json
	const { run, stdout, stderr } = launch(["--json", "--no-open"], { spawnParts });
	const code = await run;
	// Then a single JSON line names the url, port, server pid and idle window, and the child is detached
	assert.equal(code, 0);
	const lines = stdout.text().trimEnd().split("\n");
	assert.equal(lines.length, 1);
	const out = JSON.parse(lines[0]);
	assert.equal(out.port, 1234);
	assert.equal(out.pid, 4242);
	assert.equal(out.idleMs, 30 * 60_000);
	assert.ok(out.url.startsWith("http://127.0.0.1:1234/#t="));
	const token = out.url.slice("http://127.0.0.1:1234/#t=".length);
	assert.match(token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(stderr.text(), "");
	assert.equal(spawnParts.child.disconnected, true);
	assert.equal(spawnParts.child.unrefd, true);
	assert.deepEqual(spawnParts.calls[0].argv, [BIN, "ui", "--serve", "--idle-minutes", "30"]);
	assert.equal(spawnParts.calls[0].opts.env.OMO_HEALTH_UI_TOKEN, token);
	assert.equal(spawnParts.calls[0].opts.detached, true);
});

test("launcher kills the child and returns 1 when the server never reports", TIMEOUT, async () => {
	// Given a child that stays silent
	const spawnParts = fakeSpawn({ port: 0, silent: true });
	// When the start timeout passes
	const { run, stderr } = launch(["--no-open"], { spawnParts, startTimeoutMs: 200 });
	// Then the child is killed and the launcher fails
	assert.equal(await run, 1);
	assert.equal(spawnParts.child.killed, true);
	assert.ok(stderr.text().startsWith("대시보드 서버가 시작되지 않았습니다: "));
});

test("launcher rejects a non-positive or non-numeric --idle-minutes with 2", TIMEOUT, async () => {
	for (const bad of ["0", "abc"]) {
		// Given an invalid option value
		const spawnParts = fakeSpawn({ port: 1 });
		// When the launcher parses it
		const { run } = launch(["--idle-minutes", bad], { spawnParts });
		// Then it exits 2 without spawning
		assert.equal(await run, 2);
		assert.equal(spawnParts.calls.length, 0);
	}
});

test("launcher passes a fractional --idle-minutes to the server and reports it in idleMs", TIMEOUT, async () => {
	const spawnParts = fakeSpawn({ port: 9 });
	const { run, stdout } = launch(["--json", "--no-open", "--idle-minutes", "0.5"], { spawnParts });
	await run;
	assert.deepEqual(spawnParts.calls[0].argv.slice(-2), ["--idle-minutes", "0.5"]);
	assert.equal(JSON.parse(stdout.text()).idleMs, 30_000);
});

test("browser opens once for a plain env and never for --no-open or a sandbox env", TIMEOUT, async () => {
	// Given a plain env
	const plain = launch([], { spawnParts: fakeSpawn({ port: 7 }) });
	assert.equal(await plain.run, 0);
	// Then the browser is opened once with the url
	assert.equal(plain.opened.length, 1);
	assert.ok(plain.opened[0].startsWith("http://127.0.0.1:7/#t="));
	// Given --no-open
	const noOpen = launch(["--no-open"], { spawnParts: fakeSpawn({ port: 7 }) });
	await noOpen.run;
	assert.deepEqual(noOpen.opened, []);
	// Given a sandbox env
	const sandbox = launch([], { env: { OMO_HEALTH_HOME: "x" }, spawnParts: fakeSpawn({ port: 7 }) });
	assert.equal(await sandbox.run, 0);
	assert.deepEqual(sandbox.opened, []);
	assert.ok(sandbox.stderr.text().includes("샌드박스 환경이라 브라우저를 열지 않았습니다."));
});

test("ui --json reports opened true only when the browser open succeeded", TIMEOUT, async () => {
	// Given a fake opener that succeeds
	const ok = launch(["--json"], { spawnParts: fakeSpawn({ port: 7 }) });
	assert.equal(await ok.run, 0);
	// Then the single JSON line says opened: true
	assert.equal(ok.stdout.text().trimEnd().split("\n").length, 1);
	assert.equal(JSON.parse(ok.stdout.text()).opened, true);
	// Given a fake opener that fails
	const failed = launch(["--json"], { spawnParts: fakeSpawn({ port: 7 }), openResult: { ok: false, error: "no browser" } });
	assert.equal(await failed.run, 0);
	// Then opened is false and the failure still reaches stderr
	assert.equal(JSON.parse(failed.stdout.text()).opened, false);
	assert.ok(failed.stderr.text().includes("브라우저를 열지 못했습니다. 위 주소를 직접 여세요: no browser"));
	// Given --no-open or a sandbox env, nothing is opened
	const noOpen = launch(["--json", "--no-open"], { spawnParts: fakeSpawn({ port: 7 }) });
	await noOpen.run;
	assert.equal(JSON.parse(noOpen.stdout.text()).opened, false);
	const sandbox = launch(["--json"], { env: { OMO_HEALTH_HOME: "x" }, spawnParts: fakeSpawn({ port: 7 }) });
	await sandbox.run;
	assert.equal(JSON.parse(sandbox.stdout.text()).opened, false);
});

test("OMO_HEALTH_CONFIG alone still opens the browser, and each sandbox marker suppresses it", TIMEOUT, async () => {
	// Given the documented extra-config variable and an unrelated one
	const config = launch([], { env: { OMO_HEALTH_CONFIG: "C:/x/extra.json", OMO_HEALTH_FOO: "1" }, spawnParts: fakeSpawn({ port: 7 }) });
	assert.equal(await config.run, 0);
	// Then the browser is opened and nothing is said about a sandbox
	assert.equal(config.opened.length, 1);
	assert.equal(config.stderr.text(), "");
	// Given each sandbox marker (matched case-insensitively, like Windows env keys)
	for (const key of ["OMO_HEALTH_HOME", "OMO_HEALTH_OMO_HOME", "OMO_HEALTH_CLAUDE_HOME", "NODE_TEST_CONTEXT", "omo_health_home"]) {
		const sandbox = launch([], { env: { [key]: "x" }, spawnParts: fakeSpawn({ port: 7 }) });
		assert.equal(await sandbox.run, 0);
		// Then the browser stays closed and stderr says why
		assert.deepEqual(sandbox.opened, [], key);
		assert.ok(sandbox.stderr.text().includes("샌드박스 환경이라 브라우저를 열지 않았습니다."), key);
	}
	// Given OMO_HEALTH_CONFIG with --no-open
	const noOpen = launch(["--no-open"], { env: { OMO_HEALTH_CONFIG: "C:/x/extra.json" }, spawnParts: fakeSpawn({ port: 7 }) });
	await noOpen.run;
	// Then --no-open still wins
	assert.deepEqual(noOpen.opened, []);
});

function fakeProc() {
	const proc = Object.assign(new EventEmitter(), { sent: [], disconnected: false });
	proc.send = (msg, cb) => {
		proc.sent.push(msg);
		cb?.();
	};
	proc.disconnect = () => {
		proc.disconnected = true;
	};
	return proc;
}

async function listeningPort(proc) {
	while (proc.sent.length === 0) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(proc.sent[0].type, "listening");
	return proc.sent[0].port;
}

function serverHome() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-health-ui-cli-"));
	const env = { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_UI_TOKEN: "test-token" };
	return { root, env, paths: resolvePaths(env) };
}

test("server mode serves state with the env token, stops on SIGTERM with 0, refuses later connections and releases proc listeners", TIMEOUT, async () => {
	// Given a temp home and a fake proc carrying the token in env
	const { root, env, paths } = serverHome();
	const proc = fakeProc();
	const before = [proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")];
	try {
		// When the server starts with an idle window far longer than the test
		const done = runUiCli(["--serve", "--idle-minutes", "30"], { paths, env, config: {}, proc });
		const port = await listeningPort(proc);
		assert.equal(proc.disconnected, true);
		// Then the state endpoint answers with the token from env
		const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-omo-health-token": "test-token" } });
		assert.equal(res.status, 200);
		assert.ok("overview" in (await res.json()));
		// And SIGTERM ends it with 0, closing the port and freeing the handlers
		proc.emit("SIGTERM");
		assert.equal(await done, 0);
		await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`), (error) => error.cause?.code === "ECONNREFUSED");
		assert.deepEqual([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")], before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("server mode exits 0 by itself after the idle window and releases proc listeners", TIMEOUT, async () => {
	// Given a server with a 300 ms idle window and no requests at all
	const { root, env, paths } = serverHome();
	const proc = fakeProc();
	const before = [proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")];
	try {
		const done = runUiCli(["--serve", "--idle-minutes", "0.005"], { paths, env, config: {}, proc });
		const port = await listeningPort(proc);
		// When nothing talks to it, it resolves 0 on its own (the test timeout bounds the wait)
		assert.equal(await done, 0);
		// Then the port is closed and the handlers are gone
		await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`), (error) => error.cause?.code === "ECONNREFUSED");
		assert.deepEqual([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")], before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("server mode returns 2 without a token", TIMEOUT, async () => {
	const proc = new EventEmitter();
	assert.equal(await runUiCli(["--serve"], { paths: null, env: {}, config: {}, proc }), 2);
});

test("defaultOpenBrowser starts cmd.exe with a verbatim start command on win32", TIMEOUT, async () => {
	// Given a fake spawn that reports a successful start
	const calls = [];
	const spawnImpl = (cmd, argv, opts) => {
		calls.push({ cmd, argv, opts });
		const child = new EventEmitter();
		child.unref = () => {};
		setImmediate(() => child.emit("spawn"));
		return child;
	};
	// When opening a url on win32
	const result = await defaultOpenBrowser("http://127.0.0.1:5/#t=abc", { platform: "win32", spawnImpl });
	// Then cmd.exe gets the exact start command
	assert.deepEqual(result, { ok: true });
	assert.equal(calls[0].cmd, "cmd.exe");
	assert.deepEqual(calls[0].argv, ["/d", "/s", "/c", 'start "" "http://127.0.0.1:5/#t=abc"']);
	assert.equal(calls[0].opts.windowsVerbatimArguments, true);
});

test("defaultOpenBrowser reports a spawn error instead of throwing", TIMEOUT, async () => {
	const spawnImpl = () => {
		const child = new EventEmitter();
		child.unref = () => {};
		setImmediate(() => child.emit("error", new Error("boom")));
		return child;
	};
	assert.deepEqual(await defaultOpenBrowser("http://x", { platform: "linux", spawnImpl }), { ok: false, error: "boom" });
});
