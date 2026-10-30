import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { install, readRunValue, RUN_KEY, RUN_VALUE, runCommandValue, runValueName, STUB_NAME, markDaemonStopped, stubContent, stubCurrent, uninstall } from "../src/install.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { compareExpected } from "../src/replay.mjs";
import { VERSION } from "../src/version.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

function fakeReg() {
	const store = new Map();
	const calls = [];
	const runner = (args) => {
		calls.push(args);
		const [op, key, , name] = args;
		if (op === "query") {
			const value = store.get(`${key}|${name}`);
			return value === undefined ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${value}\r\n`, stderr: "" };
		}
		if (op === "add") {
			store.set(`${key}|${name}`, args[args.indexOf("/d") + 1]);
			return { status: 0, stdout: "", stderr: "" };
		}
		if (op === "delete") {
			store.delete(`${key}|${name}`);
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "?" };
	};
	return { runner, store, calls };
}

function temp() {
	const root = tmpDir("omoh-install-");
	return resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
}

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const read = (file) => fs.readFileSync(file, "utf8");

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function gitRunner(cwd, command, args, options = {}) {
	if (command === "git") return { status: 0, stdout: Buffer.from(git(cwd, ...args)), stderr: "" };
	return spawnSync(command, args, { cwd, ...options });
}

/** A real git checkout holding what install needs from a runtime: bootstrap, stub template, sensor files, an entry point. */
function checkout(version = "9.8.7", extra = {}) {
	const dir = tmpDir("omoh-install-repo-");
	git(dir, "init");
	for (const [file, text] of Object.entries(extra)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	}
	for (const file of ["bootstrap/boot.mjs", "extension/stub.ts.tpl", "extension/sensor.mjs", "extension/import-fresh.mjs", "src/launch.mjs"]) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.copyFileSync(path.join(REPO, file), path.join(dir, file));
	}
	fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(dir, "bin", "omo-health.mjs"), "export async function main() { return 0; }\n");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", version }));
	git(dir, "add", ".");
	git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
	const sha = git(dir, "rev-parse", "HEAD");
	return { dir, sha, short: sha.slice(0, 7), root: (paths) => path.join(paths.health.releasesDir, `${version}-${sha.slice(0, 7)}`) };
}

test("runValueName follows the injected environment override", () => {
	assert.equal(runValueName({ OMO_HEALTH_RUN_VALUE: "omo-health-test" }), "omo-health-test");
	assert.equal(runValueName({}), RUN_VALUE);
});

test("package install archives the source sha, reports dirty files, and removes the legacy stub", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	fs.mkdirSync(paths.extensionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.extensionsDir, STUB_NAME), "legacy");
	fs.appendFileSync(path.join(repo.dir, "package.json"), " ");
	const report = await install({ paths, fromPackage: true, regRunner: fakeReg().runner, startDaemon: () => 1 });
	assert.equal(report.channel, "package");
	assert.equal(report.dirty, true);
	assert.equal(report.sha, repo.sha);
	const current = json(paths.health.currentFile);
	assert.deepEqual({ ...current, installedMs: undefined }, { channel: "package", source: repo.dir, version: "9.8.7", sha: repo.sha, root: repo.root(paths), installedMs: undefined });
	assert.equal(typeof current.installedMs, "number");
	assert.equal(fs.existsSync(path.join(repo.root(paths), "bin", "omo-health.mjs")), true);
	assert.equal(report.stub, "removed");
});

test("package install skips dev and a live setup lock", async (t) => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	fs.mkdirSync(paths.health.appDir, { recursive: true });
	fs.writeFileSync(paths.health.currentFile, JSON.stringify({ channel: "dev" }));
	assert.deepEqual(await install({ paths, fromPackage: true }), { skipped: "dev" });
	fs.rmSync(paths.health.currentFile);
	fs.writeFileSync(path.join(paths.health.appDir, "setup.lock"), JSON.stringify({ pid: process.pid, startedMs: Date.now() }));
	assert.deepEqual(await install({ paths, fromPackage: true }), { skipped: "locked" });
});

test("package install takes over an expired setup lock", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	fs.mkdirSync(paths.health.appDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.appDir, "setup.lock"), JSON.stringify({ pid: process.pid, startedMs: 1 }));
	const report = await install({ paths, fromPackage: true, regRunner: fakeReg().runner, startDaemon: () => 1, now: () => 700_000 });
	assert.equal(report.channel, "package");
	assert.equal(fs.existsSync(path.join(paths.health.appDir, "setup.lock")), false);
	assert.equal(report.release, "written");
});

test("same-sha package setup rechecks under lock, re-enables after uninstall, and preserves disable on purge", async (t) => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	const reg = fakeReg();
	let starts = 0, kills = 0;
	await install({ paths, fromPackage: true, regRunner: reg.runner, startDaemon: () => ++starts });
	const daemon = fakeRunningDaemon(t, paths, repo.root(paths));
	const before = read(paths.health.currentFile);
	const callsBefore = reg.calls.filter((c) => c[0] === "add").length;
	const second = await install({ paths, fromPackage: true, regRunner: reg.runner, startDaemon: () => ++starts, killDaemon: () => ++kills });
	assert.equal(second.release, "current");
	assert.equal(read(paths.health.currentFile), before);
	assert.equal(starts, 1);
	assert.equal(kills, 0);
	assert.equal(reg.calls.filter((c) => c[0] === "add").length, callsBefore);
	uninstall({ paths, regRunner: reg.runner, stopDaemon: () => { daemon.kill(); return "stopped"; } });
	const enabled = await install({ paths, fromPackage: true, regRunner: reg.runner, startDaemon: () => ++starts });
	assert.equal(enabled.release, "current");
	assert.equal(fs.existsSync(paths.health.stoppedFile), false);
	assert.equal(starts, 2);
	uninstall({ paths, regRunner: reg.runner, purge: true });
	assert.deepEqual(fs.readdirSync(paths.healthHome), ["stopped"]);
});

test("package install records setup failure state", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	await assert.rejects(install({ paths, fromPackage: true, run: (command, args) => args[0] === "archive" ? ({ status: 1, stdout: Buffer.alloc(0), stderr: "archive failed" }) : gitRunner(repo.dir, command, args) }));
	const state = json(path.join(paths.health.appDir, "setup-state.json"));
	assert.equal(state.sha, repo.sha);
	assert.equal(typeof state.failedMs, "number");
	assert.match(state.error, /git archive/);
});

/** A process the test owns, registered as a live daemon of `root`: it holds the lock and heartbeats. */
function fakeRunningDaemon(t, paths, root) {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore", windowsHide: true });
	t.after(() => child.kill());
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.lockFile, JSON.stringify({ pid: child.pid, startedMs: Date.now() }));
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: child.pid, ts: Date.now(), version: "0.1.0", root }));
	return child;
}

test("install --dev points current.json at this checkout, copies boot, writes stub, launcher and Run value, and is idempotent", async () => {
	const paths = temp();
	const reg = fakeReg();
	let started = 0;
	const first = await install({ paths, dev: true, execPath: "C:\\node\\node.exe", regRunner: reg.runner, startDaemon: () => ++started });
	assert.equal(first.daemon, "started:1");
	assert.deepEqual([first.current, first.boot, first.stub, first.launcher, first.runKey], ["written", "written", "written", "written", "written"]);
	assert.deepEqual(json(paths.health.currentFile), { channel: "dev", version: VERSION, root: REPO, previous: null, lkg: { version: VERSION, root: REPO }, bad: [] });
	assert.equal(read(paths.health.bootFile), read(path.join(REPO, "bootstrap", "boot.mjs")));
	const stub = read(path.join(paths.extensionsDir, STUB_NAME));
	assert.equal(stub.split(/\r?\n/)[0], `// omo-health release ${VERSION}`);
	assert.ok(stub.includes(`"${REPO.replace(/\\/g, "/")}"`), "the checkout is the baked fallback root");
	assert.equal(/__[A-Z_]+__/.test(stub), false);
	const vbs = read(path.join(paths.healthHome, "launch-hidden.vbs"));
	assert.ok(vbs.includes(`sh.Run """C:\\node\\node.exe"" --max-semi-space-size=1 --max-old-space-size=96 ""${paths.health.bootFile}"" daemon", 0, False`), vbs);
	assert.equal(readRunValue(reg.runner), runCommandValue(paths));
	assert.equal(fs.statSync(paths.health.inboxDir).isDirectory(), true);
	assert.equal(fs.existsSync(paths.health.pauseFile), false, "the pause flag must not be created as a directory");
	assert.equal(fs.existsSync(paths.health.stoppedFile), false);
	assert.equal(fs.existsSync(path.join(paths.health.appDir, "repo.git")), false, "the dev channel fetches no releases");
	const writesBefore = reg.calls.filter((c) => c[0] === "add").length;
	const second = await install({ paths, dev: true, execPath: "C:\\node\\node.exe", regRunner: reg.runner, startDaemon: () => ++started });
	assert.deepEqual([second.current, second.boot, second.stub, second.launcher, second.runKey], ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
	assert.equal(reg.calls.filter((c) => c[0] === "add").length, writesBefore);
});

test("install creates a missing extensions folder", async () => {
	const paths = temp();
	assert.equal(fs.existsSync(paths.extensionsDir), false);
	await install({ paths, dev: true, regRunner: fakeReg().runner, startDaemon: () => 1 });
	assert.ok(fs.existsSync(path.join(paths.extensionsDir, STUB_NAME)));
});

test("install (pinned) copies HEAD into app/releases/<version>-<shortsha>, points everything at it and is idempotent", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	// A tracked-file-clean checkout may still hold untracked files: they are not part of HEAD and do not refuse.
	fs.writeFileSync(path.join(repo.dir, "scratch.txt"), "untracked");
	const reg = fakeReg();
	let started = 0;
	const report = await install({ paths, execPath: "C:\\node\\node.exe", regRunner: reg.runner, startDaemon: () => ++started, now: () => 4242 });

	const root = repo.root(paths);
	assert.equal(report.channel, "pinned");
	assert.equal(report.version, "9.8.7");
	assert.equal(report.archive, "written");
	assert.deepEqual(json(paths.health.currentFile), { channel: "pinned", version: "9.8.7", sha: repo.sha, root, installedMs: 4242 });
	assert.equal(fs.existsSync(path.join(root, "bin", "omo-health.mjs")), true);
	assert.equal(fs.existsSync(path.join(root, "scratch.txt")), false, "the copy is HEAD, not the working tree");
	assert.equal(fs.existsSync(`${root}.staging`), false);
	assert.equal(read(paths.health.bootFile), read(path.join(root, "bootstrap", "boot.mjs")));
	const stub = read(path.join(paths.extensionsDir, STUB_NAME));
	assert.equal(stub.split(/\r?\n/)[0], "// omo-health release 9.8.7");
	assert.ok(stub.includes(`"${root.replace(/\\/g, "/")}"`), "the pinned copy is the baked fallback root");
	assert.ok(read(path.join(paths.healthHome, "launch-hidden.vbs")).includes(`""${paths.health.bootFile}"" daemon", 0, False`));
	assert.equal(readRunValue(reg.runner), runCommandValue(paths));
	assert.equal(report.daemon, "started:1");
	assert.equal(fs.existsSync(paths.health.legacyCareDir), false, "a fresh install does not create the legacy care folders");

	const again = await install({ paths, execPath: "C:\\node\\node.exe", regRunner: reg.runner, startDaemon: () => ++started, now: () => 9999 });
	assert.deepEqual([again.archive, again.current, again.boot, again.stub, again.launcher, again.runKey], ["kept", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
	assert.equal(json(paths.health.currentFile).installedMs, 4242);
});

// `git archive HEAD` is the pinned install's copy: an export-ignore pattern without a leading slash matches at any depth
// and silently drops test fixtures (v0.2.0 lost test/fixtures/**/.omo and failed its own staging tests).
test("every export-ignore pattern in .gitattributes is anchored at the repository root", () => {
	const lines = read(path.join(REPO, ".gitattributes")).split(/\r?\n/).map((l) => l.trim()).filter((l) => /\bexport-ignore\b/.test(l));
	assert.ok(lines.length > 0);
	for (const line of lines) assert.match(line.split(/\s+/)[0], /^\//, line);
	assert.ok(lines.some((line) => line.startsWith("/.omo ")));
});

test("install (pinned) leaves the root .omo scratch out of the copy but keeps a nested .omo", async () => {
	const repo = checkout("9.8.7", { ".gitattributes": read(path.join(REPO, ".gitattributes")), ".omo/plans/p.md": "scratch", "test/fixtures/a/.omo/keep.json": "{}" });
	const paths = { ...temp(), repoRoot: repo.dir };
	await install({ paths, regRunner: fakeReg().runner, startDaemon: () => 1 });
	const root = repo.root(paths);
	assert.equal(fs.existsSync(path.join(root, ".omo")), false, "the root .omo is export-ignored");
	assert.equal(fs.existsSync(path.join(root, "test", "fixtures", "a", ".omo", "keep.json")), true, "a nested .omo fixture is shipped");
	assert.equal(fs.existsSync(path.join(root, "bin", "omo-health.mjs")), true);
});

test("install (pinned) replaces a daemon running another root, after marking the stop", async (t) => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	const old = fakeRunningDaemon(t, paths, "C:/dev/omo/omo-health");
	const killed = [];
	const killDaemon = (pid) => {
		killed.push({ pid, heartbeat: json(paths.health.daemonJson) });
		old.kill();
		return `stopped:${pid}`;
	};
	const report = await install({ paths, regRunner: fakeReg().runner, startDaemon: () => "boot", killDaemon });

	assert.equal(killed.length, 1);
	assert.equal(killed[0].pid, old.pid);
	assert.equal(killed[0].heartbeat.exitReason, "install", "daemon.json says why before the kill (G09)");
	assert.equal(typeof killed[0].heartbeat.stoppedMs, "number");
	assert.equal(report.daemon, "started:boot");
});

test("install (pinned) refuses a dirty tracked file before changing anything", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	fs.appendFileSync(path.join(repo.dir, "package.json"), " ");
	const reg = fakeReg();
	await assert.rejects(install({ paths, regRunner: reg.runner, startDaemon: () => 1 }), /commit first[\s\S]*package\.json/);
	assert.equal(fs.existsSync(paths.healthHome), false);
	assert.equal(fs.existsSync(path.join(paths.extensionsDir, STUB_NAME)), false);
	assert.equal(reg.calls.length, 0);
});

test("install (pinned) refuses a folder that is not a git checkout", async () => {
	const paths = { ...temp(), repoRoot: tmpDir("omoh-install-nogit-") };
	await assert.rejects(install({ paths, regRunner: fakeReg().runner, startDaemon: () => 1 }), /not a git checkout/);
	assert.equal(fs.existsSync(paths.healthHome), false);
});

test("install (pinned) migrates care/deaths and care/intake, then removes the care and release leftovers and logs each removal", async () => {
	const repo = checkout();
	const paths = { ...temp(), repoRoot: repo.dir };
	const h = paths.health;
	const seed = (file, text = "x") => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	seed(path.join(h.legacyCareDir, "deaths", "1-unclean-exit.json"), "{\"kind\":\"unclean-exit\"}");
	seed(path.join(h.legacyCareDir, "intake", "2-abc.json"), JSON.stringify({ v: 1, id: "abc", atMs: 2 }));
	seed(path.join(h.legacyCareDir, "incidents", "i.json"));
	seed(path.join(path.join(h.appDir, "repo.git"), "HEAD"));
	seed(path.join(h.releasesDir, "0.4.1", "bin", "omo-health.mjs"));
	const prevBoot = path.join(h.appDir, "boot.prev.mjs");
	seed(prevBoot);
	seed(path.join(h.appDir, "staged.json"));
	seed(path.join(h.appDir, "staged-1.json"));
	seed(path.join(h.appDir, "pending-rollback.json"));
	const kept = ["decisions/x.jsonl", "reports/r.md", "snapshots/s.json", "alignment/a.json", "receipts/r.json", "inbox/s1/m.json", "baseline.json", "omo-health.db", "state.json", "config.json", "lkg/settings.json"];
	for (const name of kept) seed(path.join(paths.healthHome, name));
	const report = await install({ paths, regRunner: fakeReg().runner, startDaemon: () => 1 });

	const root = repo.root(paths);
	assert.deepEqual(report.cleanup.migrated, { deaths: 1, intake: 1 });
	assert.deepEqual(report.cleanup.failed, []);
	assert.equal(read(path.join(h.deathsDir, "1-unclean-exit.json")), "{\"kind\":\"unclean-exit\"}");
	assert.equal(fs.existsSync(path.join(h.intakeDir, "2-abc.json")), true);
	for (const gone of [h.legacyCareDir, path.join(h.appDir, "repo.git"), prevBoot, path.join(h.appDir, "staged.json"), path.join(h.appDir, "staged-1.json"), path.join(h.appDir, "pending-rollback.json"), path.join(h.releasesDir, "0.4.1")]) assert.equal(fs.existsSync(gone), false, gone);
	for (const name of kept) assert.equal(fs.existsSync(path.join(paths.healthHome, name)), true, name);
	assert.deepEqual(fs.readdirSync(h.releasesDir), [path.basename(root)]);
	assert.equal(fs.existsSync(h.currentFile), true);
	const log = read(path.join(h.logsDir, "install.log"));
	for (const removed of [h.legacyCareDir, path.join(h.appDir, "repo.git"), prevBoot, path.join(h.appDir, "staged.json"), path.join(h.appDir, "pending-rollback.json"), path.join(h.releasesDir, "0.4.1")]) assert.ok(log.includes(`removed ${removed}`), `install.log lacks ${removed}`);
	assert.ok(log.includes("migrated"));
});

test("uninstall removes stub and Run value, sets the stop flag, and --purge deletes data", async () => {
	const paths = temp();
	const reg = fakeReg();
	await install({ paths, dev: true, regRunner: reg.runner, startDaemon: () => 1 });
	const report = uninstall({ paths, regRunner: reg.runner, stopDaemon: () => "stopped" });
	assert.equal(report.stub, "removed");
	assert.equal(report.runKey, "removed");
	assert.equal(report.launcher, "removed");
	assert.equal(fs.existsSync(path.join(paths.healthHome, "launch-hidden.vbs")), false);
	assert.equal(fs.existsSync(path.join(paths.extensionsDir, STUB_NAME)), false);
	assert.equal(reg.store.has(`${RUN_KEY}|${RUN_VALUE}`), false);
	assert.ok(fs.existsSync(paths.health.stoppedFile));
	uninstall({ paths, regRunner: reg.runner, purge: true });
	assert.equal(fs.existsSync(paths.healthHome), false);
});

test("a package purge run from inside healthHome still deletes it and keeps only the stop flag", (t) => {
	const paths = temp();
	const reg = fakeReg();
	fs.mkdirSync(paths.health.appDir, { recursive: true });
	fs.writeFileSync(paths.health.currentFile, JSON.stringify({ channel: "package", source: paths.repoRoot }));
	fs.writeFileSync(path.join(paths.healthHome, "omo-health.db"), "x");
	const before = process.cwd();
	t.after(() => process.chdir(before));
	process.chdir(paths.healthHome);
	const report = uninstall({ paths, regRunner: reg.runner, purge: true });
	assert.equal(report.purge, true);
	assert.deepEqual(fs.readdirSync(paths.healthHome), ["stopped"]);
});

test("a purge waits for the daemon's process worker to exit before deleting", () => {
	const paths = temp();
	const reg = fakeReg();
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: 4242, workerPid: 4343, ts: 0 }));
	const checks = [];
	const sleeps = [];
	const report = uninstall({ paths, regRunner: reg.runner, purge: true, alive: (pid) => (checks.push(pid), checks.length <= 3), sleep: (ms) => sleeps.push(ms) });
	assert.equal(report.purge, true);
	assert.deepEqual(checks, [4343, 4343, 4343, 4343]);
	assert.deepEqual(sleeps, [250, 250, 250]);
	assert.equal(fs.existsSync(paths.healthHome), false);
});

test("compareExpected reports missing, mistimed and forbidden items", () => {
	const result = {
		findings: [{ detector: "D1", kind: "stall", cls: "runaway-readonly", severity: "warn", maxSeverity: "warn", subject: { taskId: "st_x" }, firstAtMs: Date.parse("2026-09-23T15:47:05Z") }],
		actions: [{ kind: "kill-pids", atMs: Date.parse("2026-09-23T15:47:10Z"), targets: [55000] }],
	};
	assert.deepEqual(compareExpected(result, { findings: [{ detector: "D1", kind: "stall", cls: "runaway-readonly", subject: { taskId: "st_x" } }], actions: [{ kind: "kill-pids", targets: [55000], at: ["2026-09-23T15:47:00Z", "2026-09-23T15:47:30Z"] }] }), []);
	assert.equal(compareExpected(result, { actions: [{ kind: "kill-pids", at: ["2026-09-23T16:00:00Z", "2026-09-23T16:01:00Z"] }] }).length, 1);
	assert.equal(compareExpected(result, { forbiddenActions: ["kill-pids"] }).length, 1);
	assert.equal(compareExpected(result, { forbiddenFindings: [{ severity: "warn" }] }).length, 1);
});

test("a stub from an older release still counts as current while it loads the same sensor files", () => {
	const dir = tmpDir("omoh-stubcur-");
	const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health"), OMO_HEALTH_OMO_HOME: path.join(dir, "omo") });
	const template = fs.readFileSync(new URL("../extension/stub.ts.tpl", import.meta.url), "utf8");
	const rel = (version, sensor) => {
		const root = path.join(dir, "releases", version);
		for (const [file, text] of [["extension/sensor.mjs", sensor], ["extension/import-fresh.mjs", "// fresh\n"], ["extension/stub.ts.tpl", template], ["src/launch.mjs", "// launch\n"]]) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
		return { version, root };
	};
	const old = rel("1.0.0", "// sensor\n");
	const same = rel("1.1.0", "// sensor\n");
	const changed = rel("1.2.0", "// sensor 2\n");
	const stub = stubContent(paths, old);
	assert.equal(stubCurrent(paths, stub, old), true);
	assert.equal(stubCurrent(paths, stub, same), true);
	assert.equal(stubCurrent(paths, stub, changed), false);
});

test("a deliberate stop is recorded in daemon.json before the kill", () => {
	const dir = tmpDir("omoh-stopmark-");
	const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ pid: 4242, ts: 1000, version: "1.0.0" }));
	markDaemonStopped(paths, "cli-stop", 5000);
	assert.deepEqual(json(paths.health.daemonJson), { pid: 4242, ts: 1000, version: "1.0.0", stoppedMs: 5000, exitReason: "cli-stop" });
});
