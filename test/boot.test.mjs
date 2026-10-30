import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BOOT = fileURLToPath(new URL("../bootstrap/boot.mjs", import.meta.url));
const MIN = 60_000;

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** The pid of a process that has already exited. */
function deadPid() {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

/**
 * A fake runtime entry point. `main` records its call and then behaves per `behavior`:
 * healthy (clean stop), update/restart (stops with that exitReason), throw.
 */
function releaseSource(version, behavior) {
	return `import fs from "node:fs";
import path from "node:path";

const VERSION = ${JSON.stringify(version)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const home = process.env.OMO_HEALTH_HOME;

export async function main(argv) {
	fs.appendFileSync(path.join(home, "main-calls.jsonl"), JSON.stringify({ version: VERSION, argv, viaBoot: process.env.OMO_HEALTH_VIA_BOOT ?? null }) + "\\n");
	if (argv[0] !== "daemon") return 0;
	if (BEHAVIOR === "throw") throw new Error("fake release " + VERSION + " fails to start");
	const exitReason = ["update", "restart"].includes(BEHAVIOR) ? BEHAVIOR : "idle-no-omo-hosts";
	fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, ts: Date.now(), version: VERSION, stoppedMs: Date.now(), exitReason }));
	return 0;
}
`;
}

/**
 * Stands in for powershell.exe (OMO_HEALTH_POWERSHELL): boot's process-start lookup must not depend on how long the
 * real one takes to start. Logs the pids it was asked about; prints `<pid> <startMs>` for each, or fails.
 */
function fakePowerShellSource(logFile, { startMs, fail }) {
	return `import fs from "node:fs";
const script = process.argv.at(-1);
const pids = /@\\(([^)]*)\\)/.exec(script)[1].split(",").map(Number);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ pids }) + "\\n");
if (${Boolean(fail)}) {
	process.stderr.write("powershell unavailable\\n");
	process.exit(1);
}
for (const pid of pids) process.stdout.write(pid + " " + ${Number(startMs)} + "\\n");
`;
}

function runBoot(env, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BOOT, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`boot did not exit within 60 s; stderr: ${stderr}`));
		}, 60_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** Resolves once `file` exists: subscribe to its directory first, then check, so an earlier write is not missed. */
function waitForFile(file, timeoutMs = 20_000) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	return new Promise((resolve, reject) => {
		const watcher = fs.watch(dir);
		const finish = (fn) => {
			clearTimeout(timer);
			watcher.close();
			fn();
		};
		const check = () => {
			if (fs.existsSync(file)) finish(resolve);
		};
		const timer = setTimeout(() => finish(() => reject(new Error(`timed out waiting for ${file}`))), timeoutMs);
		watcher.on("change", check);
		watcher.on("error", (error) => finish(() => reject(error)));
		check();
	});
}

function makeSandbox(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-boot-"));
	// Async: a synchronous retry loop would block the close of a just-closed fs.watch handle on this directory.
	t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const home = path.join(dir, "home");
	const omo = path.join(dir, "omo");
	const app = path.join(home, "app");
	fs.mkdirSync(app, { recursive: true });
	const stubFile = path.join(omo, "agent", "extensions", "omo-health-sensor.ts");
	const env = { ...process.env, OMO_HEALTH_HOME: home, OMO_HEALTH_OMO_HOME: omo };
	for (const key of ["OMO_HEALTH_CONFIG", "OMO_HEALTH_VIA_BOOT", "NODE_TEST_CONTEXT"]) delete env[key];
	return {
		dir,
		home,
		app,
		stubFile,
		files: {
			current: path.join(app, "current.json"),
			bootState: path.join(app, "boot-state.json"),
			daemonJson: path.join(home, "daemon.json"),
			daemonLog: path.join(home, "logs", "daemon.log"),
		},
		release(version, behavior = "healthy", root = path.join(dir, "releases", version)) {
			fs.mkdirSync(path.join(root, "bin"), { recursive: true });
			fs.mkdirSync(path.join(root, "extension"), { recursive: true });
			fs.writeFileSync(path.join(root, "bin", "omo-health.mjs"), releaseSource(version, behavior));
			fs.writeFileSync(path.join(root, "extension", "stub.ts.tpl"), "// omo-health release __VERSION__\n// fallback __FALLBACK_ROOT__\nexport default function stub() {}\n");
			return { version, root };
		},
		setCurrent(value) {
			writeJson(path.join(app, "current.json"), { channel: "pinned", ...value });
		},
		current: () => readJson(path.join(app, "current.json")),
		writeStub(version) {
			fs.mkdirSync(path.dirname(stubFile), { recursive: true });
			fs.writeFileSync(stubFile, `// omo-health release ${version}\n// installed stub\n`);
		},
		stub: () => fs.readFileSync(stubFile, "utf8"),
		setDaemonJson: (value) => writeJson(path.join(home, "daemon.json"), value),
		writeSensor: (name, value) => writeJson(path.join(home, "sensors", `${name}.json`), { v: 1, sessionId: name, ...value }),
		/** A hidden launcher whose only effect is a marker file, so the real wscript relaunch path is observable. */
		addLauncher() {
			const marker = path.join(dir, "relaunched.txt");
			fs.writeFileSync(path.join(home, "launch-hidden.vbs"), [`Set fso = CreateObject("Scripting.FileSystemObject")`, `Set f = fso.CreateTextFile("${marker}", True)`, `f.WriteLine "relaunched"`, `f.Close`, ""].join("\r\n"));
			return marker;
		},
		/** Replaces PowerShell for the process-start lookup: every pid started at `startMs`, or the lookup fails. */
		fakePowerShell(options) {
			const script = path.join(dir, "fake-powershell.mjs");
			fs.writeFileSync(script, fakePowerShellSource(path.join(dir, "powershell-calls.jsonl"), options));
			env.OMO_HEALTH_POWERSHELL = script;
		},
		powershellCalls: () => readJsonl(path.join(dir, "powershell-calls.jsonl")),
		run: (args = ["daemon"]) => runBoot(env, args),
		mainCalls: () => readJsonl(path.join(home, "main-calls.jsonl")),
		bootEvents: () => readJsonl(path.join(home, "logs", "boot.log")).map((entry) => entry.event),
		deaths(kind) {
			const deathsDir = path.join(home, "deaths");
			if (!fs.existsSync(deathsDir)) return [];
			return fs
				.readdirSync(deathsDir)
				.filter((name) => name.endsWith(`-${kind}.json`))
				.sort()
				.map((name) => readJson(path.join(deathsDir, name)));
		},
	};
}

test("a daemon start imports the current root's main() with OMO_HEALTH_VIA_BOOT and leaves current.json alone", async (t) => {
	const box = makeSandbox(t);
	const pinned = box.release("1.0.0");
	box.setCurrent({ version: "1.0.0", sha: "abc1234", root: pinned.root });
	const before = fs.readFileSync(box.files.current, "utf8");

	const result = await box.run();

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(box.mainCalls(), [{ version: "1.0.0", argv: ["daemon"], viaBoot: "1" }]);
	assert.equal(fs.readFileSync(box.files.current, "utf8"), before);
	assert.equal(box.deaths("start-failed").length, 0);
});

test("a start that throws is recorded as a death and exits 1: no rollback, no halt, no retry state", async (t) => {
	const box = makeSandbox(t);
	const broken = box.release("2.0.0", "throw");
	box.setCurrent({ version: "2.0.0", root: broken.root });

	for (let i = 1; i <= 4; i++) {
		const result = await box.run();
		assert.equal(result.code, 1, `start ${i}: ${result.stderr}`);
	}

	const deaths = box.deaths("start-failed");
	assert.equal(deaths.length, 4);
	assert.ok(deaths.every((d) => d.version === "2.0.0" && d.error.includes("fails to start")));
	assert.equal(box.current().version, "2.0.0");
	assert.equal(box.mainCalls().length, 4, "boot keeps trying the pinned root; nothing is abandoned");
	assert.equal(fs.existsSync(path.join(box.app, "halt.json")), false);
	assert.deepEqual(Object.keys(readJson(box.files.bootState)).sort(), ["deathCheckedTs", "v"]);
});

test("a missing current.json is a recorded start failure", async (t) => {
	const box = makeSandbox(t);

	const result = await box.run();

	assert.equal(result.code, 1);
	assert.match(result.stderr, /missing or invalid/);
	assert.equal(box.deaths("start-failed").length, 1);
	assert.equal(box.mainCalls().length, 0);
});

test("an unclean exit that a live omo session outlived is recorded once, with the daemon log tail", async (t) => {
	const box = makeSandbox(t);
	const broken = box.release("1.0.0", "throw");
	box.setCurrent({ channel: "dev", version: "1.0.0", root: broken.root, lkg: broken });
	// This test process plays the omo session: it started before the daemon's last heartbeat and is alive.
	const lastTs = Date.now();
	// The process-start lookup is a fake PowerShell: the real one's start-up time varies (issue #90).
	box.fakePowerShell({ startMs: lastTs - 5 * MIN });
	box.setDaemonJson({ pid: deadPid(), version: "1.0.0", ts: lastTs, startedMs: lastTs - 10 * MIN });
	box.writeSensor("s1", { pid: process.pid, ts: Date.now() });
	fs.mkdirSync(path.dirname(box.files.daemonLog), { recursive: true });
	fs.writeFileSync(box.files.daemonLog, `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);

	for (let i = 0; i < 2; i++) {
		const result = await box.run();
		assert.equal(result.code, 1, result.stderr);
	}

	const deaths = box.deaths("unclean-exit");
	assert.equal(deaths.length, 1);
	assert.equal(deaths[0].kind, "unclean-exit");
	assert.equal(deaths[0].version, "1.0.0");
	assert.equal(deaths[0].lastTs, lastTs);
	assert.equal(deaths[0].logTail.length, 40);
	assert.equal(deaths[0].logTail[0], "line 11");
	assert.equal(deaths[0].logTail.at(-1), "line 50");
	assert.equal(box.deaths("start-failed").length, 2);
	// One lookup for the one death check, answered by the fake.
	assert.deepEqual(box.powershellCalls(), [{ pids: [process.pid] }]);
});

test("an unavailable PowerShell records no death and logs the failed lookup", async (t) => {
	const box = makeSandbox(t);
	const broken = box.release("1.0.0", "throw");
	box.setCurrent({ channel: "dev", version: "1.0.0", root: broken.root, lkg: broken });
	const lastTs = Date.now();
	box.fakePowerShell({ fail: true });
	box.setDaemonJson({ pid: deadPid(), version: "1.0.0", ts: lastTs, startedMs: lastTs - 10 * MIN });
	box.writeSensor("s1", { pid: process.pid, ts: Date.now() });

	const result = await box.run();
	assert.equal(result.code, 1, result.stderr);

	assert.equal(box.deaths("unclean-exit").length, 0);
	assert.deepEqual(box.powershellCalls(), [{ pids: [process.pid] }]);
	const events = box.bootEvents();
	assert.ok(events.includes("process_start_lookup_failed"), events.join(","));
	assert.ok(events.includes("previous_run_not_a_death"), events.join(","));
});

test("no death is recorded after a reboot or logoff, when no omo session survived, or after a clean stop", async (t) => {
	const box = makeSandbox(t);
	const good = box.release("1.0.0");
	box.setCurrent({ channel: "dev", version: "1.0.0", root: good.root, lkg: good });
	// The one live session started now, after every daemon heartbeat below.
	box.fakePowerShell({ startMs: Date.now() });
	const cases = [
		// The only live session started after the daemon's last heartbeat: the machine rebooted or the user logged off.
		{ name: "reboot", daemon: { pid: deadPid(), version: "1.0.0", ts: Date.now() - 24 * 60 * MIN }, sensor: { pid: process.pid, ts: Date.now() } },
		{ name: "no surviving session", daemon: { pid: deadPid(), version: "1.0.0", ts: Date.now() }, sensor: { pid: deadPid(), ts: Date.now() } },
		{ name: "clean stop", daemon: { pid: deadPid(), version: "1.0.0", ts: Date.now(), stoppedMs: Date.now(), exitReason: "cli-stop" }, sensor: { pid: process.pid, ts: Date.now() } },
	];
	for (const { name, daemon, sensor } of cases) {
		box.setDaemonJson(daemon);
		box.writeSensor("s1", sensor);
		const result = await box.run();
		assert.equal(result.code, 0, `${name}: ${result.stderr}`);
		assert.equal(box.deaths("unclean-exit").length, 0, name);
	}
	assert.equal(box.mainCalls().length, cases.length);
});

test("a non-daemon command passes straight to main() of the current root", async (t) => {
	const box = makeSandbox(t);
	const installed = box.release("1.0.0");
	box.setCurrent({ version: "1.0.0", root: installed.root });

	const result = await box.run(["status", "--json"]);

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(box.mainCalls(), [{ version: "1.0.0", argv: ["status", "--json"], viaBoot: null }]);
	assert.equal(fs.existsSync(box.files.bootState), false);
});

test("a daemon that exits for an update is relaunched through the hidden launcher", async (t) => {
	const box = makeSandbox(t);
	const installed = box.release("1.0.0", "update");
	box.setCurrent({ version: "1.0.0", root: installed.root });
	const marker = box.addLauncher();

	const result = await box.run();

	assert.equal(result.code, 0, result.stderr);
	assert.ok(box.bootEvents().includes("relaunched"));
	await waitForFile(marker);
});

test("a daemon that exits for a restart is relaunched through the hidden launcher", async (t) => {
	const box = makeSandbox(t);
	const installed = box.release("1.0.0", "restart");
	box.setCurrent({ version: "1.0.0", root: installed.root });
	const marker = box.addLauncher();

	const result = await box.run();

	assert.equal(result.code, 0, result.stderr);
	assert.ok(box.bootEvents().includes("relaunched"));
	await waitForFile(marker);
});

test("an existing stub that loads a different sensor is rewritten to the current root", async (t) => {
	const box = makeSandbox(t);
	const pinned = box.release("1.0.0");
	box.setCurrent({ version: "1.0.0", root: pinned.root });
	box.writeStub("0.9.0");

	const result = await box.run();

	assert.equal(result.code, 0, result.stderr);
	assert.equal(box.stub(), `// omo-health release 1.0.0\n// fallback ${pinned.root.replace(/\\/g, "/")}\nexport default function stub() {}\n`);
});

test("a stub that already loads the same sensor files is left alone, so open sessions do not reload", async (t) => {
	const box = makeSandbox(t);
	const older = box.release("0.9.0");
	const pinned = box.release("1.0.0");
	for (const { root } of [older, pinned]) {
		for (const [file, text] of [["extension/sensor.mjs", "// sensor\n"], ["extension/import-fresh.mjs", "// fresh\n"], ["src/launch.mjs", "// launch\n"]]) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
	}
	box.setCurrent({ version: "1.0.0", root: pinned.root });
	const stub = `// omo-health release 0.9.0\nconst FALLBACK_ROOT = "${older.root.replace(/\\/g, "/")}";\n`;
	fs.mkdirSync(path.dirname(box.stubFile), { recursive: true });
	fs.writeFileSync(box.stubFile, stub);

	assert.equal((await box.run()).code, 0);
	assert.equal(box.stub(), stub);

	fs.writeFileSync(path.join(pinned.root, "extension", "sensor.mjs"), "// sensor changed\n");
	assert.equal((await box.run()).code, 0);
	assert.equal(box.stub().split("\n")[0], "// omo-health release 1.0.0");
});

test("boot never creates a sensor stub that is not installed", async (t) => {
	const box = makeSandbox(t);
	const pinned = box.release("1.0.0");
	box.setCurrent({ version: "1.0.0", root: pinned.root });

	const result = await box.run();

	assert.equal(result.code, 0, result.stderr);
	assert.equal(fs.existsSync(box.stubFile), false);
});
