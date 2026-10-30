import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createEvidence, SNAPSHOT_KEEP_FILES } from "../src/evidence.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { E, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-29T12:48:01.000Z");
const HOST_PID = 25760;
const iso = (ms) => new Date(ms).toISOString();
const shellCmd = (cmd) => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd.replace(/"/g, '\\"')}"`;
const probe = (file) => {
	const st = fs.statSync(file, { throwIfNoEntry: false });
	return st && { size: st.size, mtimeMs: st.mtimeMs, tail: "" };
};

/** Subagent st_c (session c1) of p1, blocked in `node driver.mjs > driver.log`; its session file and log are real files. */
function setup() {
	const root = tmpDir("omoh-evidence-");
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h") });
	const out = path.join(root, "driver.log");
	fs.writeFileSync(out, "ready\n");
	const cmd = `node driver.mjs > ${out.replace(/\\/g, "/")} 2>&1`;
	const file = path.join(root, "child.jsonl");
	writeJsonl(file, [E.header("c1", root, T - 60_000), E.user("QA the dashboard", T - 60_000), E.assistant({ ms: T, calls: [{ id: "call1", name: "bash", args: { command: cmd } }] })]);
	const rows = [
		raw(20000, 1, "node.exe", "2026-09-29T08:59:00Z", 0, 1e7, "node C:\\npm\\omo-ai\\bin\\omo.js"),
		raw(HOST_PID, 20000, "node.exe", "2026-09-29T09:00:00Z", 0, 1e8, "node C:\\npm\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js"),
		raw(100, HOST_PID, "bash.exe", iso(T + 5), 0, 2e6, shellCmd(cmd)),
		raw(101, 100, "node.exe", iso(T + 40), 0, 5e7, "node driver.mjs"),
	];
	const world = (now) => {
		const task = taskRecord({ taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1" });
		const child = sessionState({ id: "c1", kind: "child", file, taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", task, cwd: root, lastActivityMs: T, pendingCalls: [{ id: "call1", name: "bash", args: { command: cmd }, ms: T }] });
		return makeWorld({ now, sessions: [child], procSnapshots: [0, 1, 2].map((i) => ({ takenAtMs: now - (2 - i) * 20_000, rows })), fileProbe: probe });
	};
	return { paths, out, file, world, dir: paths.health.snapshotsDir };
}

test("a snapshot keeps the diagnosis, process lineage, recent events and output sizes, then follows the outputs for a minute", () => {
	const s = setup();
	const evidence = createEvidence({ paths: s.paths });
	const now = T + 12 * 60_000;
	const file = evidence.capture(s.world(now), "st_c", { kind: "report", reportId: "r1", text: "stuck?" });
	assert.equal(path.dirname(file), s.dir);
	const snap = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual([snap.atMs, snap.reason.kind, snap.subject, snap.diagnosis.verdict], [now, "report", "st_c", "stalled"]);
	assert.deepEqual(snap.lineage.map((p) => [p.role, p.pid]), [["ancestor", 20000], ["host", HOST_PID], ["descendant", 100], ["descendant", 101]]);
	assert.deepEqual(snap.diagnosis.waitingOn[0].processes.map((p) => p.pid), [100, 101]);
	assert.deepEqual(snap.recentEvents.map((e) => [e.type, e.role]), [["message", "user"], ["message", "assistant"]], "the session header is not an event");
	const last = snap.recentEvents.at(-1);
	assert.deepEqual([last.role, last.calls[0].name], ["assistant", "bash"]);
	assert.match(last.calls[0].command, /node driver\.mjs/);
	assert.deepEqual(snap.outputs.map((o) => [path.basename(o.file), o.samples.map((x) => x.size)]), [["child.jsonl", [fs.statSync(s.file).size]], ["driver.log", [6]]]);

	fs.appendFileSync(s.out, "still alive\n");
	evidence.tick({ world: s.world(now + 15_000), opened: [] });
	evidence.tick({ world: s.world(now + 90_000), opened: [] });
	evidence.tick({ world: s.world(now + 120_000), opened: [] });
	const log = JSON.parse(fs.readFileSync(file, "utf8")).outputs.find((o) => path.basename(o.file) === "driver.log");
	assert.deepEqual(log.samples.map((x) => [x.atMs - now, x.size]), [[0, 6], [15_000, 18], [90_000, 18]], "sampled every tick for a minute, then left alone");
});

test("an opened subagent finding takes one snapshot per fp per ten minutes, other detectors none, and old snapshots are pruned", () => {
	const s = setup();
	const evidence = createEvidence({ paths: s.paths });
	const now = T + 12 * 60_000;
	fs.mkdirSync(s.dir, { recursive: true });
	fs.writeFileSync(path.join(s.dir, `${now - 8 * 24 * 3600_000}-finding-old.json`), "{}");
	for (let i = 0; i < SNAPSHOT_KEEP_FILES; i++) fs.writeFileSync(path.join(s.dir, `${now - 60_000 - i}-finding-f${i}.json`), "{}");
	const stall = { fp: "fp1stall", detector: "D1", kind: "stall", cls: "unknown", severity: "warn", subject: { sessionId: "c1", taskId: "st_c" }, titleKo: "원인을 알 수 없는 멈춤" };
	const tokens = { fp: "fp2token", detector: "D4", kind: "burn-spike", severity: "warn", subject: { sessionId: "c1" } };
	const ours = () => fs.readdirSync(s.dir).filter((name) => name.includes("-finding-st_c"));

	evidence.tick({ world: s.world(now), opened: [stall, tokens] });
	evidence.tick({ world: s.world(now + 5 * 60_000), opened: [stall] });
	assert.deepEqual(ours(), [`${now}-finding-st_c-fp1stall.json`], "D1 once within ten minutes; D4 never");
	assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, ours()[0]), "utf8")).reason.detector, "D1");
	const names = fs.readdirSync(s.dir);
	assert.equal(names.length, SNAPSHOT_KEEP_FILES);
	assert.ok(!names.some((name) => name.includes("-old")), "a week-old snapshot is gone");
	assert.ok(!names.includes(`${now - 60_000 - (SNAPSHOT_KEEP_FILES - 1)}-finding-f${SNAPSHOT_KEEP_FILES - 1}.json`), "the oldest beyond the cap is gone");

	evidence.tick({ world: s.world(now + 11 * 60_000), opened: [stall] });
	assert.equal(ours().length, 2, "after ten minutes the same finding may snapshot again");
	assert.equal(fs.readdirSync(s.dir).length, SNAPSHOT_KEEP_FILES);
});

const hexFp = "a1b2c3d4e5f60718";
const stallFinding = { fp: hexFp, detector: "D1", kind: "stall", cls: "unknown", severity: "warn", subject: { sessionId: "c1", taskId: "st_c" }, titleKo: "원인을 알 수 없는 멈춤" };

test("a restarted daemon does not snapshot a finding again within ten minutes (#82)", () => {
	const s = setup();
	const now = T + 12 * 60_000;
	const ours = () => fs.readdirSync(s.dir).filter((name) => name.includes("-finding-st_c"));
	createEvidence({ paths: s.paths }).tick({ world: s.world(now), opened: [stallFinding] });
	assert.equal(ours().length, 1);
	createEvidence({ paths: s.paths }).tick({ world: s.world(now + 60_000), opened: [stallFinding] });
	assert.equal(ours().length, 1, "the snapshot on disk remembers it across the restart");
	createEvidence({ paths: s.paths }).tick({ world: s.world(now + 11 * 60_000), opened: [stallFinding] });
	assert.equal(ours().length, 2, "after ten minutes it may snapshot again");
});

test("snapshots are pruned at startup and on a schedule, not only when a new one is taken (#82)", () => {
	const s = setup();
	const now = T + 12 * 60_000;
	const week = 8 * 24 * 3600_000;
	fs.mkdirSync(s.dir, { recursive: true });
	const old = (n) => path.join(s.dir, `${now - week - n}-finding-old.json`);
	fs.writeFileSync(old(1), "{}");
	const evidence = createEvidence({ paths: s.paths });
	evidence.tick({ world: s.world(now), opened: [] });
	assert.equal(fs.existsSync(old(1)), false, "a stale snapshot goes at startup");
	fs.writeFileSync(old(2), "{}");
	evidence.tick({ world: s.world(now + 5 * 60_000), opened: [] });
	assert.equal(fs.existsSync(old(2)), true, "pruning is scheduled, not every tick");
	evidence.tick({ world: s.world(now + 10 * 60_000), opened: [] });
	assert.equal(fs.existsSync(old(2)), false, "and it runs when the interval has passed");
});

test("a pending eval call's artifact logs are captured newest first, at most maxFiles, tail only, secret lines dropped and redacted", () => {
	const s = setup();
	const dir = `${s.file.replace(/\.jsonl$/i, "")}-artifacts`;
	fs.mkdirSync(path.join(dir, "local"), { recursive: true });
	const write = (file, text, mtimeMs) => {
		fs.writeFileSync(file, text);
		fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	};
	const detached = path.join(dir, "local", "detached-eval-call1.log");
	const other = path.join(dir, "local", "detached-eval-other.log");
	const newest = path.join(dir, "eval-b.log");
	const token = path.join(dir, "eval-a.log");
	const capped = path.join(dir, "eval-c.log");
	const stale = path.join(dir, "eval-old.log");
	write(detached, "detached-start\nAPI_KEY=abc123\nkeep-detached\n", T - 1000);
	write(other, "not-a-pending-call\n", T - 200);
	write(newest, `EVAL-HEADER-MARK\n${"b".repeat(500)}\nbravo-visible\n`, T - 300);
	write(token, `HEADER-START\n${"x".repeat(500)}\nkeep-tail\nsk-ant-${"Z".repeat(24)}\n`, T - 2000);
	write(capped, "beyond-max-files\n", T - 4000);
	write(stale, "before-the-window\n", T - 6000);
	const world = s.world(T + 12 * 60_000);
	world.config = { ...world.config, evalLogs: { maxFiles: 3, tailBytes: 200, windowMs: 3600_000 } };
	const file = createEvidence({ paths: s.paths }).capture(world, "st_c", { kind: "report", reportId: "r1", text: "stuck?" });
	const snap = JSON.parse(fs.readFileSync(file, "utf8"));
	const logs = snap.artifacts.evalLogs;
	assert.deepEqual(logs.map((log) => path.basename(log.file)), ["eval-b.log", "detached-eval-call1.log", "eval-a.log"], "newest first, pending detached log before eval-*.log, at most maxFiles");
	assert.equal(logs.find((log) => log.file === newest).sizeBytes, fs.statSync(newest).size);
	assert.match(logs.find((log) => log.file === detached).tail, /keep-detached/);
	assert.match(logs.find((log) => log.file === newest).tail, /bravo-visible/);
	assert.doesNotMatch(logs.find((log) => log.file === newest).tail, /EVAL-HEADER-MARK/, "tail only, not the head");
	assert.doesNotMatch(logs.find((log) => log.file === token).tail, /HEADER-START/, "tail only, not the head");
	assert.match(logs.find((log) => log.file === token).tail, /sk-ant-\[REDACTED\]/, "redact runs after the tail is cut");
	assert.doesNotMatch(JSON.stringify(snap), /abc123/, "a secret-looking line is dropped whole");
	assert.ok(!logs.some((log) => log.file === other), "a detached log for a non-pending call is not captured");
	assert.ok(!logs.some((log) => log.file === stale), "a log older than the pending call's window is not captured");
	assert.ok(!logs.some((log) => log.file === capped), "beyond maxFiles");
});

test("capture reads eval log limits from the world config and drops a partial first line", () => {
	const s = setup();
	const dir = `${s.file.replace(/\.jsonl$/i, "")}-artifacts`;
	fs.mkdirSync(dir, { recursive: true });
	const write = (file, text, mtimeMs) => {
		fs.writeFileSync(file, text);
		fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	};
	// The tail begins inside the secret value, after the API_KEY= that the line filter looks for.
	const cut = path.join(dir, "eval-cut.log");
	write(cut, `API_KEY=SECRETVALUE999\n${"Z".repeat(192)}`, T - 2000);
	write(path.join(dir, "eval-a.log"), "a\n", T);
	write(path.join(dir, "eval-b.log"), "b\n", T - 1000);
	write(path.join(dir, "eval-c.log"), "c\n", T - 3000);
	const world = s.world(T + 12 * 60_000);
	world.config = { ...world.config, evalLogs: { maxFiles: 4, tailBytes: 200, windowMs: 3600_000 } };
	// No config option: the live world's reloadable config supplies the limits.
	const file = createEvidence({ paths: s.paths }).capture(world, "st_c", { kind: "report", reportId: "r1", text: "stuck?" });
	const snap = JSON.parse(fs.readFileSync(file, "utf8"));
	const logs = snap.artifacts.evalLogs;
	assert.equal(logs.length, 4, "maxFiles comes from the world config, not the default");
	const cutLog = logs.find((log) => log.file === cut);
	assert.ok(cutLog, "the cut log is captured");
	assert.ok(cutLog.tail.startsWith("Z"), "the partial first line is dropped");
	assert.doesNotMatch(JSON.stringify(snap), /VALUE999/, "no fragment of the cut secret line reaches the snapshot");
});

test("snapshot text is redacted before it is cut, so a token cut at the limit cannot slip under the pattern (#82)", () => {
	const s = setup();
	writeJsonl(s.file, [E.header("c1", "C:/x", T - 60_000), E.user(`${"a".repeat(290)}sk-ant-${"Z".repeat(40)}`, T)]);
	const file = createEvidence({ paths: s.paths }).capture(s.world(T + 12 * 60_000), "st_c", { kind: "report", reportId: "r1", text: "stuck?" });
	const text = fs.readFileSync(file, "utf8");
	assert.ok(text.includes("aaaa"), "the event text is in the snapshot");
	assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9]/, "no part of the token reaches disk");
});
