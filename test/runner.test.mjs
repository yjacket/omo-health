import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { childEnv, createRunner, processIdentity } from "../src/runner.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { sha1 } from "../src/util/text.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner, createRecordingSpawn } from "./fakes/runner.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-09-28T10:00:00Z");
const DEAD_PID = () => false;
/** The job's own process: the same creation time and command line at every lookup. */
const SAME_PROCESS = () => ({ ctimeMs: T - 500, cmdSha1: "job-process" });

function setup({ env = { PATH: "C:/bin" }, onSpawn, isAlive, identify = SAME_PROCESS, contracts, home = tmpDir("omoh-runner-") } = {}) {
	const paths = resolvePaths({ USERPROFILE: home, OMO_HEALTH_HOME: path.join(home, ".omo-health") });
	const clock = createFakeClock(T);
	const { spawnImpl, calls } = createRecordingSpawn({ onSpawn });
	const runner = createRunner({ paths, spawnImpl, clock, env, isAlive, identify, contracts });
	return { runner, calls, clock, paths, home };
}

const baseJob = { jobId: "j1", kind: "analyze", command: "C:/fake/tool.exe", args: ["-p", "two words", 'say "hi"'], cwd: "C:/work", timeoutMs: 600_000 };
const readMeta = (runner, jobId = "j1") => JSON.parse(fs.readFileSync(path.join(runner.jobDir(jobId), "meta.json"), "utf8"));
const writeJob = (runner, name, text, jobId = "j1") => fs.writeFileSync(path.join(runner.jobDir(jobId), name), text);
const writeExit = (runner, exit, jobId = "j1") => writeJob(runner, "exit.json", JSON.stringify(exit), jobId);

/** A child that is a real node process writing `script`'s output into the runner's file stdio. */
function realNode(script) {
	const children = [];
	const onSpawn = (_command, _args, options) => {
		const child = spawn(process.execPath, ["-e", script], { ...options, shell: false });
		children.push(child);
		return child;
	};
	return { onSpawn, closed: () => new Promise((resolve) => children[0].once("close", resolve)) };
}

test("start passes command and args through unchanged, detached with file stdio, and writes the job files", () => {
	const { runner, calls, clock, paths } = setup();
	const job = runner.start(baseJob);
	assert.equal(calls.length, 1);
	const { command, args, options } = calls[0];
	assert.equal(command, "C:/fake/tool.exe");
	assert.deepEqual(args, baseJob.args);
	assert.equal(options.detached, true);
	assert.equal(options.windowsHide, true);
	assert.equal(options.shell, false);
	assert.equal(options.cwd, "C:/work");
	assert.equal(options.stdio.length, 3);
	assert.equal(options.stdio[0], "ignore");
	for (const fd of options.stdio.slice(1)) assert.equal(typeof fd, "number");
	const dir = runner.jobDir("j1");
	assert.equal(dir, path.join(paths.health.jobsDir, "j1"));
	assert.equal(job.dir, dir);
	assert.ok(fs.existsSync(path.join(dir, "out.txt")));
	assert.ok(fs.existsSync(path.join(dir, "err.log")));
	assert.deepEqual(readMeta(runner), { pid: job.pid, ctimeMs: T - 500, cmdSha1: "job-process", startedMs: clock.now(), timeoutMs: 600_000, kind: "analyze", command: "C:/fake/tool.exe", args: baseJob.args });
});

test("the job directory is the default working directory", () => {
	const { runner, calls } = setup();
	runner.start({ ...baseJob, cwd: undefined });
	assert.equal(calls[0].options.cwd, runner.jobDir("j1"));
});

test("a .cmd shim runs through the shell on Windows as one quoted command line, attached; a bare name or an .exe is spawned directly", () => {
	const shim = setup();
	shim.runner.start({ ...baseJob, command: "C:/fake/omo.cmd", args: ["-p", "two words", 'say "hi"'] });
	const { command, args, options } = shim.calls[0];
	if (process.platform === "win32") {
		assert.equal(command, '"C:/fake/omo.cmd" "-p" "two words" "say \\"hi\\""');
		assert.deepEqual(args, []);
		assert.deepEqual([options.shell, options.detached], [true, false]);
	} else {
		assert.equal(command, "C:/fake/omo.cmd");
		assert.deepEqual([options.shell, options.detached], [false, true]);
	}
	const bare = setup();
	bare.runner.start({ ...baseJob, command: "omo" });
	assert.deepEqual([bare.calls[0].command, bare.calls[0].args, bare.calls[0].options.shell, bare.calls[0].options.detached], ["omo", baseJob.args, false, true]);
});

test("the child env drops agent, provider and GitHub credentials", () => {
	const env = {
		PATH: "C:/bin",
		APPDATA: "C:/Users/x/AppData/Roaming",
		OMO_HEALTH_HOME: "C:/h",
		CLAUDE_CODE_ENTRYPOINT: "cli",
		ANTHROPIC_API_KEY: "sk-ant-x",
		PI_MODEL: "m",
		SENPI_TASK: "t",
		GITHUB_TOKEN: "ghp_x",
		GH_TOKEN: "gho_x",
		CLAUDE_CONFIG_DIR: "C:/cfg",
	};
	const { runner, calls } = setup({ env });
	runner.start(baseJob);
	const expected = { PATH: "C:/bin", APPDATA: "C:/Users/x/AppData/Roaming", CLAUDE_CONFIG_DIR: "C:/cfg" };
	assert.deepEqual(calls[0].options.env, expected);
	assert.deepEqual(childEnv(env), expected);
});

test("a finished process's stdout and stderr land in out.txt and err.log and poll parses the stdout", { timeout: 15_000 }, async () => {
	const { onSpawn, closed } = realNode("process.stdout.write('{\"ok\":true}'); process.stderr.write('warn');");
	const { runner } = setup({ onSpawn, isAlive: DEAD_PID });
	runner.start({ ...baseJob, cwd: undefined, command: process.execPath, args: [], parse: (stdout) => JSON.parse(stdout) });
	await closed();
	assert.equal(fs.readFileSync(path.join(runner.jobDir("j1"), "out.txt"), "utf8"), '{"ok":true}');
	assert.equal(fs.readFileSync(path.join(runner.jobDir("j1"), "err.log"), "utf8"), "warn");
	assert.deepEqual(runner.poll("j1"), { status: "done", result: { ok: true }, exitCode: 0 });
});

test("the exit and error events of the child are recorded as exit.json", () => {
	const children = [];
	const onSpawn = () => {
		const child = Object.assign(new EventEmitter(), { pid: 91000 + children.length, unref() {} });
		children.push(child);
		return child;
	};
	const { runner } = setup({ onSpawn, isAlive: DEAD_PID });
	runner.start(baseJob);
	runner.start({ ...baseJob, jobId: "j2" });
	writeJob(runner, "out.txt", "answer");
	children[0].emit("exit", 0, null);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runner.jobDir("j1"), "exit.json"), "utf8")), { code: 0, signal: null });
	assert.deepEqual(runner.poll("j1"), { status: "done", result: "answer", exitCode: 0 });
	children[1].emit("error", new Error("spawn C:/fake/tool.exe ENOENT"));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runner.jobDir("j2"), "exit.json"), "utf8")), { code: null, error: "spawn C:/fake/tool.exe ENOENT" });
});

test("poll without a parse returns the raw stdout; the outcome is final and kept in meta", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	runner.start(baseJob);
	writeJob(runner, "out.txt", "plain text\n");
	writeExit(runner, { code: 0 });
	const polled = runner.poll("j1");
	assert.deepEqual(polled, { status: "done", result: "plain text\n", exitCode: 0 });
	assert.deepEqual(readMeta(runner).final, polled);
	writeJob(runner, "out.txt", "changed afterwards");
	assert.deepEqual(runner.poll("j1"), polled);
});

test("poll reports running while the process lives and no exit was recorded", () => {
	const { runner } = setup({ isAlive: () => true });
	runner.start(baseJob);
	assert.deepEqual(runner.poll("j1"), { status: "running", result: null, exitCode: null });
});

test("a job nobody started is failed with no-job", () => {
	const { runner } = setup();
	assert.deepEqual(runner.poll("never"), { status: "failed", reason: "no-job", result: null, exitCode: null });
});

test("a non-zero exit is unavailable when unavailableReason names a reason for stderr + stdout, else failed with the exit code", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	const seen = [];
	const unavailableReason = (text) => {
		seen.push(text);
		return /usage limit/i.test(text) ? "usage-limit" : null;
	};
	runner.start({ ...baseJob, unavailableReason });
	writeJob(runner, "err.log", "Usage limit reached|1790600000\n");
	writeJob(runner, "out.txt", "partial");
	writeExit(runner, { code: 1 });
	const unavailable = runner.poll("j1");
	assert.deepEqual([unavailable.status, unavailable.reason, unavailable.exitCode, unavailable.result], ["unavailable", "usage-limit", 1, null]);
	assert.match(unavailable.detail, /Usage limit reached/);
	assert.deepEqual(seen, ["Usage limit reached|1790600000\n\npartial"]);

	runner.start({ ...baseJob, jobId: "j2", unavailableReason });
	writeJob(runner, "err.log", "boom\n", "j2");
	writeExit(runner, { code: 2 }, "j2");
	const failed = runner.poll("j2");
	assert.deepEqual([failed.status, failed.reason, failed.exitCode, failed.result], ["failed", "exit-2", 2, null]);

	runner.start({ ...baseJob, jobId: "j3" });
	writeExit(runner, { code: 3 }, "j3");
	assert.equal(runner.poll("j3").reason, "exit-3", "no unavailableReason given: a plain failure");
});

test("a spawn error exit (the process never started) is failed with spawn-error", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	runner.start({ ...baseJob, unavailableReason: (text) => (text.includes("not logged in") ? "auth" : null) });
	writeExit(runner, { code: null, error: "spawn C:/fake/tool.exe ENOENT" });
	const polled = runner.poll("j1");
	assert.deepEqual([polled.status, polled.reason, polled.exitCode], ["failed", "spawn-error:spawn C:/fake/tool.exe ENOENT", null]);
});

test("a process that is gone without exit.json is done when the stdout parses, else unavailable or failed with no-result", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	const parse = (stdout) => (stdout.startsWith("{") ? JSON.parse(stdout) : null);
	runner.start({ ...baseJob, parse });
	writeJob(runner, "out.txt", '{"verdict":"wait"}');
	assert.deepEqual(runner.poll("j1"), { status: "done", result: { verdict: "wait" }, exitCode: null });

	runner.start({ ...baseJob, jobId: "j2", parse });
	writeJob(runner, "err.log", "boom\n", "j2");
	const failed = runner.poll("j2");
	assert.deepEqual([failed.status, failed.reason, failed.exitCode], ["failed", "no-result", null]);

	runner.start({ ...baseJob, jobId: "j3", parse, unavailableReason: (text) => (text.includes("not logged in") ? "auth" : null) });
	writeJob(runner, "err.log", "not logged in\n", "j3");
	const unavailable = runner.poll("j3");
	assert.deepEqual([unavailable.status, unavailable.reason], ["unavailable", "auth"]);
});

test("a job a previous daemon started is polled with its kind's contract; without one it returns the raw stdout", () => {
	const home = tmpDir("omoh-runner-");
	const first = setup({ home, isAlive: DEAD_PID });
	first.runner.start({ ...baseJob, parse: () => "the starting daemon's parse" });
	first.runner.start({ ...baseJob, jobId: "j2", kind: "other" });
	first.runner.start({ ...baseJob, jobId: "j3" });
	for (const jobId of ["j1", "j2", "j3"]) {
		writeJob(first.runner, "out.txt", '{"n":1}', jobId);
		writeJob(first.runner, "err.log", "Usage limit\n", jobId);
	}
	writeExit(first.runner, { code: 0 }, "j1");
	writeExit(first.runner, { code: 0 }, "j2");
	writeExit(first.runner, { code: 1 }, "j3");
	// A restarted daemon has a fresh runner: only `contracts` tells it how to read the files.
	const contracts = { analyze: { parse: (stdout) => JSON.parse(stdout), unavailableReason: (text) => (/usage limit/i.test(text) ? "usage-limit" : null) } };
	const restarted = setup({ home, isAlive: DEAD_PID, contracts });
	assert.deepEqual(restarted.runner.poll("j1"), { status: "done", result: { n: 1 }, exitCode: 0 });
	assert.equal(restarted.runner.poll("j3").reason, "usage-limit");
	assert.deepEqual(restarted.runner.poll("j2"), { status: "done", result: '{"n":1}', exitCode: 0 }, "kind without a contract");
});

test("a job whose own process (same creation time, looked up in CIM) runs past timeoutMs is killed with taskkill /F /T and reported as timeout", async () => {
	let stub;
	const onSpawn = (command, _args, options) => {
		if (command === "taskkill") {
			stub.kill();
			return null;
		}
		// Never-exiting stand-in for the job's process, spawned for real with the runner's detached file stdio.
		stub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { ...options, shell: false });
		return stub;
	};
	const { runner, calls, clock } = setup({ onSpawn, identify: processIdentity });
	const job = runner.start({ ...baseJob, cwd: undefined, timeoutMs: 1000 });
	assert.ok(Number.isFinite(readMeta(runner).ctimeMs), "creation time recorded at start");
	const exited = new Promise((resolve, reject) => {
		const guard = setTimeout(() => reject(new Error("stub did not exit within 10 s")), 10_000);
		stub.once("exit", () => resolve(clearTimeout(guard)));
	});
	clock.advance(1000);
	assert.equal(runner.poll("j1").status, "running");
	assert.equal(calls.length, 1);
	clock.advance(1);
	const polled = runner.poll("j1");
	assert.equal(polled.status, "timeout");
	assert.deepEqual(calls[1], { command: "taskkill", args: ["/F", "/T", "/PID", String(job.pid)], options: { windowsHide: true, stdio: "ignore" } });
	await exited;
	assert.equal(runner.poll("j1").status, "timeout");
	assert.equal(calls.length, 2);
});

test("a job pid that now names another process (reused after a reboot) is finished as pid-reused and nothing is killed", () => {
	let owner = SAME_PROCESS();
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: () => owner });
	runner.start({ ...baseJob, timeoutMs: 60 * 60_000 });
	assert.equal(runner.poll("j1").status, "running");
	// Overnight reboot: the job's process is long gone and its pid belongs to something else.
	clock.advance(8 * 60 * 60_000);
	owner = { ctimeMs: T + 7 * 60 * 60_000, cmdSha1: "explorer" };
	const polled = runner.poll("j1");
	assert.deepEqual(polled, { status: "failed", reason: "pid-reused", result: null, exitCode: null });
	assert.deepEqual(runner.poll("j1"), polled);
	assert.deepEqual(calls.map((call) => call.command), ["C:/fake/tool.exe"], "no taskkill");
});

test("a job from an older version (no recorded identity) counts as running until its timeout, then ends as timeout without a kill", () => {
	const { runner, calls, clock } = setup({ isAlive: () => true });
	runner.start(baseJob);
	const metaFile = path.join(runner.jobDir("j1"), "meta.json");
	const { ctimeMs, cmdSha1, ...legacy } = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	fs.writeFileSync(metaFile, JSON.stringify(legacy));
	clock.advance(baseJob.timeoutMs);
	assert.deepEqual(runner.poll("j1"), { status: "running", result: null, exitCode: null });
	clock.advance(1);
	assert.deepEqual(runner.poll("j1"), { status: "timeout", reason: "unverified", result: null, exitCode: null });
	assert.equal(calls.some((call) => call.command === "taskkill"), false);
});

test("a failed identity lookup keeps a live job running and never kills; the next poll retries", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: (pid) => lookup(pid) });
	const job = runner.start(baseJob);
	clock.advance(baseJob.timeoutMs + 1);
	lookup = () => {
		throw new Error("process identity lookup for pid 70000 failed: spawnSync powershell.exe ETIMEDOUT");
	};
	const polled = runner.poll("j1");
	assert.equal(polled.status, "running");
	assert.match(polled.detail, /ETIMEDOUT/);
	assert.equal(calls.some((call) => call.command === "taskkill"), false);
	lookup = SAME_PROCESS;
	assert.equal(runner.poll("j1").status, "timeout", "the next poll verifies the job and ends it");
	assert.deepEqual(calls.at(-1).args, ["/F", "/T", "/PID", String(job.pid)]);

	// A lookup that already fails at start leaves the job unverifiable: never killed, ended at its timeout.
	lookup = () => {
		throw new Error("no powershell");
	};
	runner.start({ ...baseJob, jobId: "j2" });
	assert.match(readMeta(runner, "j2").identityError, /no powershell/);
	lookup = SAME_PROCESS;
	clock.advance(baseJob.timeoutMs + 1);
	assert.deepEqual(runner.poll("j2"), { status: "timeout", reason: "unverified", result: null, exitCode: null });
	assert.equal(calls.filter((call) => call.command === "taskkill").length, 1);
});

test("after its timeout a job whose identity lookups keep failing ends as timeout/unverified without a kill", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: (pid) => lookup(pid) });
	runner.start(baseJob);
	lookup = () => {
		throw new Error("process identity lookup for pid 70000 failed: spawnSync powershell.exe ETIMEDOUT");
	};
	// Before the timeout a failing lookup is only "running", however often it fails.
	for (let i = 0; i < 10; i++) assert.equal(runner.poll("j1").status, "running");
	clock.advance(baseJob.timeoutMs + 1);
	for (let i = 0; i < 4; i++) assert.equal(runner.poll("j1").status, "running");
	assert.deepEqual(runner.poll("j1"), { status: "timeout", reason: "unverified", result: null, exitCode: null });
	assert.deepEqual(runner.poll("j1").reason, "unverified", "the outcome is final");
	assert.equal(calls.some((call) => call.command === "taskkill"), false);
});

test("a successful identity lookup after the timeout still verifies and kills, however many lookups failed before", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: (pid) => lookup(pid) });
	const job = runner.start(baseJob);
	clock.advance(baseJob.timeoutMs + 1);
	lookup = () => {
		throw new Error("ETIMEDOUT");
	};
	for (let i = 0; i < 4; i++) assert.equal(runner.poll("j1").status, "running");
	lookup = SAME_PROCESS;
	assert.deepEqual(runner.poll("j1"), { status: "timeout", result: null, exitCode: null });
	assert.deepEqual(calls.at(-1).args, ["/F", "/T", "/PID", String(job.pid)]);
});

test("a recorded job whose pid has no process behind it has ended", () => {
	let identity = SAME_PROCESS();
	const { runner } = setup({ isAlive: () => true, identify: () => identity });
	runner.start(baseJob);
	identity = null;
	assert.equal(runner.poll("j1").reason, "no-result");
});

test("processIdentity tells a missing process (null) from a failed lookup (throws)", () => {
	assert.deepEqual(processIdentity(42, () => "1790000000000\r\ntool.exe -p\r\n"), { ctimeMs: 1790000000000, cmdSha1: sha1("tool.exe -p") });
	assert.equal(processIdentity(42, () => ""), null);
	assert.throws(
		() =>
			processIdentity(42, () => {
				throw new Error("spawnSync powershell.exe ETIMEDOUT");
			}),
		/lookup for pid 42 failed: spawnSync powershell\.exe ETIMEDOUT/,
	);
});

test("the fake runner replays scripted outcomes by jobId or kind", () => {
	const fake = createFakeRunner({ outcomes: { analyze: [{ status: "running" }, { status: "done", result: { ok: true } }] } });
	fake.start({ jobId: "a", kind: "analyze" });
	assert.equal(fake.poll("a").status, "running");
	assert.deepEqual(fake.poll("a").result, { ok: true });
	assert.deepEqual(fake.poll("a").result, { ok: true });
	assert.equal(fake.starts.length, 1);
});

test("the fake runner applies the job's parse and unavailableReason to scripted stdout and stderr", () => {
	const fake = createFakeRunner({ outcomes: { ok: { status: "done", stdout: '{"n":2}' }, limit: { status: "failed", stderr: "usage limit" } } });
	fake.start({ jobId: "a", kind: "ok", parse: JSON.parse });
	assert.deepEqual(fake.poll("a").result, { n: 2 });
	fake.start({ jobId: "b", kind: "limit", unavailableReason: (text) => (text.includes("usage limit") ? "usage-limit" : null) });
	assert.deepEqual([fake.poll("b").status, fake.poll("b").reason], ["unavailable", "usage-limit"]);
});
