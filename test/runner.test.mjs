import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { childEnv, createRunner, findJobProcess, processIdentity } from "../src/runner.mjs";
import { laneArgs } from "../src/judge/lane.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { sha1 } from "../src/util/text.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner, createRecordingSpawn } from "./fakes/runner.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-09-28T10:00:00Z");
const DEAD_PID = () => false;
/** The job's own process: the same creation time and command line at every lookup. */
const SAME_PROCESS = () => ({ ctimeMs: T - 500, cmdSha1: "job-process" });

function setup({ env = { PATH: "C:/bin" }, onSpawn, isAlive, identify = SAME_PROCESS, contracts, home = tmpDir("omoh-runner-"), findProcess, spawnImpl: injectedSpawn, writeJson } = {}) {
	const paths = resolvePaths({ USERPROFILE: home, OMO_HEALTH_HOME: path.join(home, ".omo-health") });
	const clock = createFakeClock(T);
	const recording = createRecordingSpawn({ onSpawn });
	const spawnImpl = injectedSpawn ?? recording.spawnImpl;
	const runner = createRunner({ paths, spawnImpl, clock, env, isAlive, identify, contracts, ...(findProcess ? { findJobProcess: findProcess } : {}), ...(writeJson ? { writeJson } : {}) });
	return { runner, calls: recording.calls, clock, paths, home };
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

test("IS-9: only audit child processes disable senpi model fallback", () => {
	const { runner, calls } = setup({ env: { PATH: "C:/bin", SENPI_NO_FALLBACK: "0", OMO_NO_FALLBACK: "0", PI_NO_FALLBACK: "0" } });
	const args = laneArgs({ model: "p/reviewer", bundleFile: "C:/work/bundle.md" });
	runner.start({ ...baseJob, kind: "analyst", args });
	runner.start({ ...baseJob, kind: "audit", jobId: "j2", args });
	assert.deepEqual(calls.map((call) => call.args), [args, args]);
	assert.deepEqual(calls.map((call) => call.options.env), [
		{ PATH: "C:/bin" },
		{ PATH: "C:/bin", SENPI_NO_FALLBACK: "1" },
	]);
});

test("IS-9: a restarted runner rejects a fallback verdict already finalized by an older runner", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	runner.start({ ...baseJob, kind: "audit", args: laneArgs({ model: "p/reviewer", bundleFile: "C:/work/bundle.md" }) });
	writeJob(runner, "err.log", "Model fallback: p/reviewer -> p/audited (provider refused)\n");
	writeJob(runner, "meta.json", JSON.stringify({ ...readMeta(runner), final: { status: "done", result: { overall: "sound" }, exitCode: 0 } }));
	const rejected = { status: "failed", reason: "model-fallback", result: null, exitCode: 0 };
	assert.deepEqual(runner.poll("j1"), rejected);
	assert.deepEqual(readMeta(runner).final, rejected);
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

test("an error from a child with a pid is failed with spawn-error but is not a confirmed non-launch", () => {
	const { runner } = setup({ isAlive: DEAD_PID });
	runner.start({ ...baseJob, unavailableReason: (text) => (text.includes("not logged in") ? "auth" : null) });
	writeExit(runner, { code: null, error: "spawn C:/fake/tool.exe ENOENT" });
	const polled = runner.poll("j1");
	assert.deepEqual([polled.status, polled.reason, polled.exitCode], ["failed", "spawn-error:spawn C:/fake/tool.exe ENOENT", null]);
	assert.notEqual(polled.spawned, false);
});

test("(IS-10) a real missing executable is a confirmed non-launch, also on a restarted runner", async () => {
	let spawnError;
	const { runner, home } = setup({ identify: () => null, spawnImpl: (...args) => {
		const child = spawn(...args);
		spawnError = once(child, "error");
		return child;
	} });
	const command = path.join(home, "missing-tool.exe");
	const started = runner.start({ ...baseJob, command, cwd: undefined });
	assert.equal(started.pid, undefined);
	const [error] = await spawnError;
	assert.equal(error.code, "ENOENT");
	const polled = runner.poll("j1");
	assert.deepEqual(polled, { status: "failed", reason: `spawn-error:${error.message}`, spawned: false, detail: "", result: null, exitCode: null });
	assert.deepEqual(setup({ home }).runner.poll("j1"), polled);
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

test("a job from an older version (no recorded identity) whose argv is not found ends without a kill", () => {
	const { runner, calls, clock } = setup({ isAlive: () => true, findProcess: () => null });
	runner.start(baseJob);
	const metaFile = path.join(runner.jobDir("j1"), "meta.json");
	const { ctimeMs, cmdSha1, ...legacy } = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	fs.writeFileSync(metaFile, JSON.stringify(legacy));
	clock.advance(baseJob.timeoutMs);
	assert.equal(runner.poll("j1").status, "failed", "no process carries the job's argv");
	assert.equal(calls.some((call) => call.command === "taskkill"), false);
});

test("a failed identity lookup keeps a live job running and never kills; the next poll retries", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: (pid) => lookup(pid), findProcess: () => null });
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

	// A lookup that already fails at start leaves the job unverifiable; poll finds no process with its argv and ends it.
	lookup = () => {
		throw new Error("no powershell");
	};
	runner.start({ ...baseJob, jobId: "j2" });
	assert.match(readMeta(runner, "j2").identityError, /no powershell/);
	clock.advance(baseJob.timeoutMs + 1);
	const unverified = runner.poll("j2");
	assert.deepEqual([unverified.status, unverified.reason], ["failed", "no-result"]);
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

const laneArgsFor = (jobId, sessionId) => ["-p", "--no-session", "-ne", "-ns", "-nc", "--no-tools", "--session-id", sessionId, "@" + path.join("C:/h/jobs", jobId, "bundle.md")];
const cimLine = (pid, parentPid, ctimeMs, commandLine) => pid + "\t" + parentPid + "\t" + ctimeMs + "\t" + commandLine;

test("start refuses an audit argv missing a guard flag and spawns nothing", () => {
	const { runner, calls } = setup();
	const args = ["-p", "--no-session", "-ne", "-ns", "-nc", "@C:/h/jobs/j1/bundle.md"];
	assert.throws(
		() => runner.start({ ...baseJob, kind: "audit", args }),
		(error) => {
			assert.match(error.message, /--no-tools/);
			assert.equal(error.spawned, false);
			return true;
		},
	);
	assert.equal(calls.length, 0);
});

test("start writes meta.json with the child pid before the identity lookup", () => {
	let seen;
	const { runner } = setup({
		identify: () => {
			seen = JSON.parse(fs.readFileSync(path.join(runner.jobDir("j1"), "meta.json"), "utf8"));
			return SAME_PROCESS();
		},
	});
	runner.start(baseJob);
	assert.equal(seen.pid, 70000);
	assert.equal(seen.ctimeMs, null);
	assert.equal(seen.cmdSha1, null);
});

test("an identify failure at start leaves meta.json behind; poll adopts the process found through the job argv and kills its tree at the timeout", () => {
	let lookup = () => {
		throw new Error("no powershell");
	};
	const found = { pid: 70000, ctimeMs: T - 1000, cmdSha1: "job-process" };
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: () => lookup(), findProcess: () => found });
	runner.start(baseJob);
	assert.equal(readMeta(runner).ctimeMs, null);
	assert.match(readMeta(runner).identityError, /no powershell/);
	lookup = () => ({ ctimeMs: T - 1000, cmdSha1: "job-process" });
	assert.equal(runner.poll("j1").status, "running");
	assert.equal(readMeta(runner).ctimeMs, T - 1000, "the found identity is kept");
	clock.advance(baseJob.timeoutMs + 1);
	assert.deepEqual(runner.poll("j1"), { status: "timeout", result: null, exitCode: null });
	assert.deepEqual(calls.at(-1), { command: "taskkill", args: ["/F", "/T", "/PID", "70000"], options: { windowsHide: true, stdio: "ignore" } });
});

test("poll ends a job whose argv names no process, and stays running when the lookup throws", () => {
	let lookup = () => {
		throw new Error("no powershell");
	};
	let find = () => null;
	const { runner } = setup({ isAlive: () => true, identify: () => lookup(), findProcess: () => find() });
	runner.start(baseJob);
	lookup = () => ({ ctimeMs: T - 1000, cmdSha1: "job-process" });
	assert.deepEqual([runner.poll("j1").status, runner.poll("j1").reason], ["failed", "no-result"]);
	lookup = () => {
		throw new Error("no powershell");
	};
	runner.start({ ...baseJob, jobId: "j2" });
	find = () => {
		throw new Error("CIM timed out");
	};
	const running = runner.poll("j2");
	assert.equal(running.status, "running");
	assert.match(running.detail, /CIM timed out/);
});

test("without an initial identity, failed argv lookups past the deadline keep only the audit running", () => {
	const lookups = [];
	const { runner, calls, clock } = setup({
		isAlive: () => true,
		identify: () => null,
		findProcess: (jobId) => {
			lookups.push(jobId);
			throw new Error("CIM timed out");
		},
	});
	for (const kind of ["audit", "analyst"]) {
		runner.start({ ...baseJob, jobId: kind, kind, args: laneArgsFor(kind, `lane-${kind}`) });
		assert.equal(readMeta(runner, kind).ctimeMs, null);
		assert.equal(runner.poll(kind).status, "running");
	}

	clock.advance(baseJob.timeoutMs + 1);
	const timeout = { status: "timeout", reason: "unverified", result: null, exitCode: null };
	for (let i = 0; i < 6; i++) {
		assert.equal(runner.poll("audit").status, "running");
		assert.deepEqual(runner.poll("analyst"), timeout);
	}
	assert.deepEqual(readMeta(runner, "analyst").final, timeout);
	assert.equal(readMeta(runner, "audit").final, undefined);
	assert.equal(lookups.filter((id) => id === "audit").length, 7, "every audit poll retries");
	assert.equal(calls.length, 2, "neither unverified process is killed");
});

test("adoptJob writes meta.json from the found process, or reports absent", () => {
	const found = { pid: 72000, ctimeMs: T - 1000, cmdSha1: "job-process" };
	const args = laneArgsFor("j1", "lane-1");
	const { runner } = setup({ findProcess: () => found });
	assert.equal(runner.adoptJob("j1", { command: "omo", args, startedMs: T, timeoutMs: 900_000, kind: "audit" }), "running");
	assert.deepEqual(readMeta(runner), { pid: 72000, ctimeMs: T - 1000, cmdSha1: "job-process", startedMs: T, timeoutMs: 900_000, kind: "audit", command: "omo", args });
	const absent = setup({ findProcess: () => null });
	assert.equal(absent.runner.adoptJob("j1", { command: "omo", args }), "absent");
});

test("findJobProcess keeps only the process carrying the job's full argv and returns the root of its parent-child chain", () => {
	const jobsDir = "C:/h/jobs";
	const jobId = "j1";
	const bundle = path.join(jobsDir, jobId, "bundle.md");
	const args = laneArgsFor(jobId, "lane-1");
	const query = (rows) => () => rows.join("\n");
	const argv = "cmd.exe /c omo -p --no-tools --session-id lane-1 @" + bundle;
	assert.equal(findJobProcess({ jobsDir, jobId, args, exec: query([cimLine(9, 1, T, "notepad.exe " + bundle)]) }), null, "a bare bundle path is no job");
	const root = findJobProcess({
		jobsDir,
		jobId,
		args,
		exec: query([cimLine(10, 5, T, argv), cimLine(11, 10, T, "node.exe " + argv.slice(8))]),
	});
	assert.equal(root.pid, 10, "the chain root is the job tree");
	assert.equal(root.ctimeMs, T);
	const other = "omo -p --no-tools --session-id lane-1 @" + bundle;
	assert.throws(
		() => findJobProcess({ jobsDir, jobId, args, exec: query([cimLine(12, 5, T, argv), cimLine(13, 7, T, other)]) }),
		/ambiguous/,
		"two independent roots are never adopted",
	);
	assert.throws(
		() =>
			findJobProcess({
				jobsDir,
				jobId,
				args,
				exec: () => {
					throw new Error("winmgmt unavailable");
				},
			}),
		/winmgmt unavailable/,
	);
});

test("an audit job past its timeout stays running through failed identity lookups, then kills its verified tree on the first success", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: () => lookup() });
	runner.start({ ...baseJob, kind: "audit", args: laneArgsFor("j1", "lane-1") });
	clock.advance(baseJob.timeoutMs + 1);
	lookup = () => {
		throw new Error("ETIMEDOUT");
	};
	for (let i = 0; i < 5; i++) assert.equal(runner.poll("j1").status, "running");
	assert.equal(readMeta(runner).final, undefined, "nothing is finalized on a failed lookup");
	assert.equal(readMeta(runner).identityFailures, 5);
	lookup = SAME_PROCESS;
	assert.deepEqual(runner.poll("j1"), { status: "timeout", result: null, exitCode: null });
	assert.deepEqual(calls.at(-1).args, ["/F", "/T", "/PID", "70000"]);
});

test("start errors carry whether a process was spawned", () => {
	const refused = setup({ onSpawn: () => { throw new Error("spawn boom"); } });
	assert.throws(
		() => refused.runner.start(baseJob),
		(error) => {
			assert.equal(error.spawned, false);
			assert.match(error.message, /spawn boom/);
			return true;
		},
	);
	const metaWriteFailed = setup({ writeJson: () => { throw new Error("disk full"); } });
	assert.throws(
		() => metaWriteFailed.runner.start(baseJob),
		(error) => {
			assert.equal(error.spawned, true);
			assert.equal(error.pid, 70000);
			assert.match(error.message, /disk full/);
			return true;
		},
	);
	const noPid = setup({
		writeJson: () => { throw new Error("disk full"); },
		spawnImpl: () => {
			const child = new EventEmitter();
			child.unref = () => {};
			return child;
		},
	});
	assert.throws(
		() => noPid.runner.start(baseJob),
		(error) => {
			assert.equal(error.spawned, false, "a post-spawn failure with no pid never claims a process");
			return true;
		},
	);
});

test("alive and terminate re-verify pid, creation time and command hash", () => {
	let lookup = () => ({ ctimeMs: T - 500, cmdSha1: "job-process" });
	const { runner, calls } = setup({ identify: () => lookup() });
	runner.start(baseJob);
	assert.equal(runner.alive("j1"), true);
	assert.equal(runner.terminate("j1"), "sent");
	assert.deepEqual(calls.at(-1), { command: "taskkill", args: ["/F", "/T", "/PID", "70000"], options: { windowsHide: true, stdio: "ignore" } });
	lookup = () => ({ ctimeMs: T, cmdSha1: "job-process" });
	assert.equal(runner.alive("j1"), false);
	const before = calls.length;
	assert.equal(runner.terminate("j1"), "gone", "a reused pid is never killed");
	assert.equal(calls.length, before);
	lookup = () => {
		throw new Error("ETIMEDOUT");
	};
	assert.throws(() => runner.alive("j1"), /ETIMEDOUT/);
	assert.throws(() => runner.terminate("j1"), /ETIMEDOUT/);
});

test("a timed-out job stays ours while its verified process lives, and a failed kill is retried", () => {
	let lookup = SAME_PROCESS;
	const { runner, calls, clock } = setup({ isAlive: () => true, identify: () => lookup() });
	runner.start(baseJob);
	clock.advance(baseJob.timeoutMs + 1);
	assert.deepEqual(runner.poll("j1"), { status: "timeout", result: null, exitCode: null });
	assert.equal(readMeta(runner).final.status, "timeout");
	assert.equal(runner.alive("j1"), true, "a persisted timeout is not proof that the process exited");
	const kills = () => calls.filter((call) => call.command === "taskkill").length;
	assert.equal(kills(), 1);
	assert.equal(runner.terminate("j1"), "sent");
	assert.equal(kills(), 2, "the kill is retried while the verified process lives");
	lookup = () => null;
	assert.equal(runner.alive("j1"), false);
	assert.equal(runner.terminate("j1"), "gone");
});

test("IS-10: only audit liveness looks for a surviving model child after launcher exit", () => {
	let identify = SAME_PROCESS;
	let rows = "";
	let queryError;
	let queries = 0;
	const { runner, paths } = setup({
		identify: () => identify(),
		findProcess: (jobId, args) => findJobProcess({ jobsDir: paths.health.jobsDir, jobId, args, exec: () => {
			queries++;
			if (queryError) throw queryError;
			return rows;
		} }),
	});
	const argsFor = (jobId) => laneArgs({ model: "p/reviewer", bundleFile: path.join(runner.jobDir(jobId), "bundle.md"), sessionId: `lane-${jobId}` });
	const auditArgs = argsFor("j1");
	runner.start({ ...baseJob, kind: "audit", args: auditArgs });
	runner.start({ ...baseJob, jobId: "analyst", kind: "analyst", args: argsFor("analyst") });
	identify = () => null;
	const matching = cimLine(71000, 70000, T, `omo.exe ${auditArgs.join(" ")}`);
	const wrongSession = cimLine(71001, 70000, T, `omo.exe ${auditArgs.join(" ").replace("lane-j1", "lane-other")}`);
	const wrongBundle = cimLine(71002, 70000, T, `omo.exe ${auditArgs.join(" ").replace("bundle.md", "other.md")}`);
	rows = [matching, wrongSession, wrongBundle].join("\n");
	queryError = new Error("CIM unavailable");
	writeExit(runner, { code: 1 }, "analyst");
	assert.equal(runner.alive("analyst"), false);
	assert.equal(runner.poll("analyst").reason, "exit-1");
	assert.equal(queries, 0, "the analyst does not query argv on launcher exit");

	queryError = undefined;
	assert.equal(runner.alive("j1"), true, "the matching child keeps the audit alive");
	queryError = new Error("CIM unavailable");
	assert.throws(() => runner.alive("j1"), /CIM unavailable/);
	queryError = undefined;
	rows = [wrongSession, wrongBundle].join("\n");
	assert.equal(runner.alive("j1"), false, "neither a different bundle nor a different lane holds the slot");
});

test("IS-10 deadline: a verified surviving audit child is targeted each poll until disappearance", () => {
	const child = { pid: 71000, ctimeMs: T + 1, cmdSha1: "model-child" };
	let launcherAlive = true;
	let childAlive = true;
	let childLookups = 0;
	const { runner, calls, clock } = setup({
		isAlive: (pid) => pid === child.pid ? childAlive : launcherAlive,
		identify(pid) {
			if (pid !== child.pid) return launcherAlive ? SAME_PROCESS() : null;
			childLookups++;
			return childAlive ? child : null;
		},
		findProcess: () => childAlive ? child : null,
	});
	runner.start({ ...baseJob, kind: "audit", args: laneArgsFor("j1", "lane-1") });
	launcherAlive = false;
	writeExit(runner, { code: 0 });
	const kills = () => calls.filter(({ command }) => command === "taskkill").map(({ args }) => args);
	assert.equal(runner.poll("j1").status, "running");
	assert.deepEqual(kills(), []);
	const beforeDeadline = childLookups;

	clock.advance(baseJob.timeoutMs + 1);
	assert.equal(runner.poll("j1").status, "running", "a termination request is not proof of exit");
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "71000"]]);
	assert.ok(childLookups > beforeDeadline, "the kill uses a fresh identity lookup");
	const { pid, ctimeMs, cmdSha1, adopted, startedMs, timeoutMs, final } = readMeta(runner);
	assert.deepEqual({ pid, ctimeMs, cmdSha1, adopted, startedMs, timeoutMs, final },
		{ ...child, adopted: true, startedMs: T, timeoutMs: baseJob.timeoutMs, final: undefined });
	assert.equal(runner.poll("j1").status, "running");
	childAlive = false;
	assert.equal(runner.poll("j1").status, "timeout");
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "71000"], ["/F", "/T", "/PID", "71000"]]);
});

test("IS-10 retry: every attempt re-verifies the adopted identity and records the attempt", (t) => {
	const child = { pid: 71000, ctimeMs: T + 1, cmdSha1: "model-child" };
	let found = child;
	let seen = child;
	let ambiguous = false;
	let snapshot = 0;
	let verifiedAt = 0;
	const { runner, calls, clock, home } = setup({
		isAlive: DEAD_PID,
		identify(pid) {
			if (pid === 70000) return SAME_PROCESS();
			verifiedAt = snapshot;
			return seen?.pid === pid ? seen : null;
		},
		findProcess(_jobId, _args, options) {
			assert.equal(options.requireSingle, true);
			snapshot++;
			if (ambiguous) throw new Error("ambiguous job process lookup");
			return found;
		},
	});
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	runner.start({ ...baseJob, kind: "audit", args: laneArgsFor("j1", "lane-1") });
	clock.advance(baseJob.timeoutMs + 1);
	const kills = () => calls.filter(({ command }) => command === "taskkill").map(({ args }) => args);
	const ownTree = ["/F", "/T", "/PID", "71000"];
	for (let attempt = 1; attempt <= 2; attempt++) {
		assert.equal(runner.poll("j1").status, "running");
		assert.deepEqual(kills(), Array(attempt).fill(ownTree), `verified attempt ${attempt}`);
		assert.equal(verifiedAt, snapshot, "the attempt used a fresh PID identity snapshot");
	}

	ambiguous = true;
	assert.equal(runner.poll("j1").status, "running");
	ambiguous = false;
	for (const mismatch of [{ ctimeMs: T + 2 }, { cmdSha1: "different-command" }, { pid: 71001 }]) {
		seen = { ...child, ...mismatch };
		assert.equal(runner.poll("j1").status, "running");
		found = seen;
		assert.equal(runner.poll("j1").status, "running", "a different matching process must not replace the adopted child");
		found = child;
	}
	assert.deepEqual(kills(), [ownTree, ownTree], "ambiguity and mismatches do not send taskkill");
	assert.equal(readMeta(runner).adoptedTerminationAttempts, 2);

	found = seen = child;
	assert.equal(runner.poll("j1").status, "running");
	assert.deepEqual(kills(), [ownTree, ownTree, ownTree]);
	found = seen = null;
	assert.deepEqual(runner.poll("j1"), { status: "timeout", result: null, exitCode: null, exitConfirmed: true });
	assert.equal(readMeta(runner).adoptedTerminationAttempts, 3);
});

test("IS-10 deadline: multiple matches or failed verification hold the audit without killing", () => {
	let rows = [];
	let failQuery = false;
	let identity;
	const { runner, paths, calls, clock } = setup({
		isAlive: DEAD_PID,
		identify: (pid) => pid === 70000 ? SAME_PROCESS() : identity,
		findProcess: (jobId, args, options) => findJobProcess({ jobsDir: paths.health.jobsDir, jobId, args, ...options, exec: () => {
			if (failQuery) throw new Error("CIM unavailable");
			return rows.join("\n");
		} }),
	});
	const args = laneArgs({ model: "p/reviewer", bundleFile: path.join(runner.jobDir("j1"), "bundle.md"), sessionId: "lane-j1" });
	runner.start({ ...baseJob, kind: "audit", args });
	const argv = `omo.exe ${args.join(" ")}`;
	const child = cimLine(71000, 70000, T + 1, argv);
	clock.advance(baseJob.timeoutMs + 1);
	identity = { ctimeMs: T + 1, cmdSha1: sha1(argv) };
	for (const parentPid of [71000, 70000]) {
		rows = [child, cimLine(71001, parentPid, T + 2, argv)];
		assert.equal(runner.poll("j1").status, "running");
		assert.equal(readMeta(runner).pid, 70000);
		assert.equal(calls.length, 1);
	}
	rows = [child];
	failQuery = true;
	assert.equal(runner.poll("j1").status, "running");
	failQuery = false;
	identity.cmdSha1 = "reused-command";
	assert.equal(runner.poll("j1").status, "running");
	assert.equal(readMeta(runner).pid, 70000);
	assert.equal(calls.length, 1);
});

test("a process that only mentions the bundle path is not adopted and nothing is killed", () => {
	let box;
	const finder = (jobId, args) => findJobProcess({ jobsDir: box.paths.health.jobsDir, jobId, args, exec: () => cimLine(9, 1, T, "notepad.exe " + path.join(box.paths.health.jobsDir, jobId, "bundle.md")) });
	box = setup({ isAlive: () => true, identify: () => { throw new Error("no powershell"); }, findProcess: finder });
	box.runner.start(baseJob);
	const polled = box.runner.poll("j1");
	assert.deepEqual([polled.status, polled.reason], ["failed", "no-result"]);
	assert.deepEqual(box.calls.map((call) => call.command), ["C:/fake/tool.exe"], "no taskkill");
});

test("an ambiguous job lookup is not adopted and leaves no meta.json", () => {
	const { runner } = setup({
		findProcess: () => {
			const error = new Error("job process lookup is ambiguous: two independent roots");
			error.code = "ambiguous";
			throw error;
		},
	});
	assert.throws(() => runner.adoptJob("j1", { command: "omo", args: laneArgsFor("j1", "lane-1") }), /ambiguous/);
	assert.equal(fs.existsSync(path.join(runner.jobDir("j1"), "meta.json")), false);
});
