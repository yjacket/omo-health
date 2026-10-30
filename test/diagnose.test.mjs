import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { main } from "../bin/omo-health.mjs";
import { run } from "../src/cli-extra.mjs";
import { normalizeRows } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { diagnose, formatDiagnosis } from "../src/diagnose.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { E, tmpDir, writeTask } from "./helpers/fixtures.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-29T12:48:01.000Z");
const MB = 1024 * 1024;
const HOST_PID = 25760;
const CHILD = "01a0ed19-4ea1-7c3c-925b-4971d4dd8ff9";
const iso = (ms) => new Date(ms).toISOString();
const host = () => raw(HOST_PID, 20000, "node.exe", "2026-09-29T09:00:00Z", 0, 1e8, "node C:\\npm\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js");
const shellCmd = (cmd) => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd.replace(/"/g, '\\"')}"`;
/** The shell running `cmd` for the call made at `callMs`, and the program it started (named after the command's first word). */
const tree = (cmd, callMs, cpuMs) => [raw(100, HOST_PID, "bash.exe", iso(callMs + 5), 0, 2 * MB, shellCmd(cmd)), raw(101, 100, `${cmd.split(" ")[0]}.exe`, iso(callMs + 40), cpuMs, 50 * MB, cmd)];

/** Subagent st_c whose one pending bash call runs `cmd` since `callMs`; `snapshots` process snapshots 20 s apart end at `now`. */
function subject({ cmd = "node driver.mjs", now = T + 12 * 60_000, callMs = T, cpuPerSnap = 0, hostAlive = true, task = {}, session = {}, snapshots = 3, config } = {}) {
	const record = taskRecord({ taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", childSessionId: CHILD, summary: "browser QA", ...task });
	const calls = cmd ? [{ id: "call1", name: "bash", args: { command: cmd }, ms: callMs }] : [];
	const child = sessionState({ id: CHILD, kind: "child", taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", task: record, lastActivityMs: callMs, lastMessage: { role: "assistant", ms: callMs, stopReason: "toolUse" }, pendingCalls: calls, ...session });
	const snaps = Array.from({ length: snapshots }, (_, i) => ({ takenAtMs: now - (snapshots - 1 - i) * 20_000, rows: [...(hostAlive ? [host()] : []), ...(cmd ? tree(cmd, callMs, cpuPerSnap * i) : [])] }));
	return makeWorld({ now, sessions: [child], procSnapshots: snaps, config });
}

test("a tool call whose processes sit idle past noProgressMs is stalled and the advice is to release the shell", () => {
	const r = diagnose(subject(), "st_c");
	assert.equal(r.found, true);
	assert.deepEqual([r.verdict, r.advice], ["stalled", "release-shell"]);
	assert.equal(r.subject.taskId, "st_c");
	assert.equal(r.subject.sessionId, CHILD);
	const [call] = r.waitingOn;
	assert.deepEqual([call.tool, call.command, call.elapsedMs, call.cls], ["bash", "node driver.mjs", 12 * 60_000, "unknown"]);
	assert.deepEqual(call.processes.map((p) => [p.pid, p.name, p.cpuPct]), [[100, "bash.exe", 0], [101, "node.exe", 0]]);
	assert.deepEqual([r.lastProgress.ms, r.lastProgress.ageMs], [T, 12 * 60_000]);
	assert.equal(diagnose(subject(), CHILD).subject.taskId, "st_c", "the child session id names the same subject");
	assert.equal(diagnose(subject(), CHILD.slice(0, 8)).subject.taskId, "st_c", "so does its 8-character prefix");
});

test("bounded, fresh and busy calls are progressing (wait); an unbounded wait is stalled (release the shell)", () => {
	const judged = (options) => {
		const r = diagnose(subject(options), "st_c");
		return [r.verdict, r.advice, r.waitingOn[0].cls];
	};
	assert.deepEqual(judged({ cmd: "timeout 1800 npm test" }), ["progressing", "wait", "bounded"]);
	assert.deepEqual(judged({ now: T + 90_000 }), ["progressing", "wait", "pending"]);
	assert.deepEqual(judged({ cpuPerSnap: 15_000 }), ["progressing", "wait", "unknown"]);
	assert.deepEqual(judged({ cmd: "tail -f server.log", now: T + 16 * 60_000 }), ["stalled", "release-shell", "unbounded-wait"]);
	const unsampled = diagnose(subject({ snapshots: 1 }), "st_c");
	assert.deepEqual([unsampled.verdict, unsampled.advice, unsampled.waitingOn[0].cls, unsampled.cpuPct], ["progressing", "wait", "unknown", null], "one snapshot holds no CPU sample: the tree is neither idle nor busy yet");
	assert.equal(diagnose(subject(), "st_c").cpuPct, 0, "a sampled idle tree reads 0");
	// R11 (#60 review): a tree that is not fully idle waits for the analyst, which alone can release it.
	const busy = diagnose(subject({ cpuPerSnap: 15_000 }), "st_c");
	assert.deepEqual([busy.judgePending, busy.heuristic, busy.waitingOn[0].plannedAction], [true, true, "analyze"]);
	assert.deepEqual(judged({ cpuPerSnap: 15_000, now: T + 31 * 60_000 }), ["progressing", "wait", "unknown"], "no clock releases a busy unknown call");
	const analystOff = diagnose(subject({ cpuPerSnap: 15_000, config: { analyst: { enabled: false } } }), "st_c");
		assert.deepEqual([analystOff.verdict, analystOff.advice, analystOff.judgePending, analystOff.waitingOn[0].plannedAction, analystOff.waitingOn[0].dueMs], ["progressing", "wait", false, null, null], "with the analyst off the call waits and is not released");
});

test("a child's call quiet for stall.quietMs is a quiet hang (R12) the analyst is asked about at the quiet threshold", () => {
	const quiet = diagnose(subject({ now: T + 16 * 60_000 }), "st_c");
	const [call] = quiet.waitingOn;
	assert.deepEqual([call.cls, call.rule, quiet.verdict, quiet.advice, quiet.heuristic], ["quiet-hang", "R12", "stalled", "release-shell", true]);
	assert.deepEqual([call.plannedAction, call.dueMs], ["analyze", T + 15 * 60_000], "the analyst is asked at 15 min; only its verdict releases the shell");
	assert.equal(diagnose(subject({ now: T + 16 * 60_000, cpuPerSnap: 15_000 }), "st_c").waitingOn[0].cls, "unknown", "a short sample cannot tell a busy tree between writes from a spinning one");
	const bounded = diagnose(subject({ cmd: "timeout 1800 npm test" }), "st_c").waitingOn[0];
	assert.equal(bounded.cls, "bounded");
		assert.equal("rechecks" in bounded, false, "no rechecks any more");
	assert.equal(diagnose(subject({ now: T + 16 * 60_000, config: { analyst: { enabled: false } } }), "st_c").waitingOn[0].plannedAction, null, "no analyst, nothing planned");
});

test("a finished task is idle, a task whose host is gone is stalled (cancel), and a same-call loop is looping (cancel)", () => {
	const done = diagnose(subject({ cmd: null, task: { status: "completed" } }), "st_c");
	assert.deepEqual([done.verdict, done.advice], ["idle", "none"]);
	const orphaned = diagnose(subject({ hostAlive: false }), "st_c");
	assert.deepEqual([orphaned.verdict, orphaned.advice], ["stalled", "cancel"]);
	const young = diagnose(subject({ hostAlive: false, now: T + 40_000 }), "st_c");
	assert.deepEqual([young.verdict, young.advice, ...young.waitingOn.map((w) => `${w.verdict}/${w.advice}`)], ["stalled", "cancel", "stalled/cancel"], "a call too young to classify still cannot progress without its host");
	const history = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, ms: T + 6 * 60_000 + i * 20_000, name: "bash", argsHash: "same", isError: false }));
	const loop = diagnose(subject({ now: T + 10 * 60_000, session: { toolHistory: history } }), "st_c");
	assert.deepEqual([loop.verdict, loop.advice], ["looping", "cancel"]);
	assert.match(loop.reasonKo, /반복/);
});

test("an id that names nothing lists the subagents that can be diagnosed", () => {
	const r = diagnose(subject(), "st_nope");
	assert.equal(r.found, false);
	assert.deepEqual(r.candidates.map((c) => c.id), ["st_c"]);
	assert.match(formatDiagnosis(r), /st_c/);
});

async function captured(fn) {
	const lines = [];
	const [log, error] = [console.log, console.error];
	console.log = (...args) => lines.push(args.join(" "));
	console.error = (...args) => lines.push(args.join(" "));
	try {
		const code = await fn();
		return { code, text: lines.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

test("`diagnose` reads a fresh world from two process snapshots, not the daemon's status files, and prints Korean text or JSON", async () => {
	const root = tmpDir("omoh-diagnose-");
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), OMO_HEALTH_CLAUDE_HOME: path.join(root, "c") });
	const project = path.join(root, "proj");
	const command = "node driver.mjs";
	writeTask(project, { task_id: "st_c", status: "running", host_pid: HOST_PID, parent_session_id: "p1", root_session_id: "p1", child_session_id: CHILD, execution_mode: "in-process", background_mode: "background", spawn_spec: { cwd: project }, task_summary: "browser QA" }, [
		E.header(CHILD, project, T - 60_000),
		E.user("QA the dashboard", T - 60_000),
		E.assistant({ ms: T, calls: [{ id: "call1", name: "bash", args: { command } }] }),
	]);
	const clock = createFakeClock(T + 12 * 60_000);
	fs.mkdirSync(paths.health.sensorsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.sensorsDir, "p1.json"), JSON.stringify({ sessionId: "p1", pid: HOST_PID, cwd: project, idle: true, ts: clock.now() }));
	// Left behind by a daemon that has stopped: it says "progressing", which is no longer true.
	fs.mkdirSync(paths.health.statusDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.statusDir, "_global.json"), JSON.stringify({ open: [{ taskId: "st_c", cls: "progressing", titleKo: "진행 중인 작업 대기" }] }));
	let cpuPerMs = 0;
	let closed = 0;
	const sleeps = [];
	const procs = {
		snapshot: async () => ({ takenAtMs: clock.now(), rows: normalizeRows([host(), ...tree(command, T, Math.round((clock.now() - T) * cpuPerMs))]) }),
		os: async () => undefined,
		ports: async () => [],
		close: () => closed++,
	};
	const deps = { procs, clock, sleep: async (ms) => (sleeps.push(ms), clock.advance(ms)) };
	const diagnoseCli = (args) => captured(() => run("diagnose", args, { paths, config: DEFAULT_CONFIG, diagnose: deps }));

	const quiet = await diagnoseCli(["st_c", "--json"]);
	assert.equal(quiet.code, 0);
	const report = JSON.parse(quiet.text);
	assert.deepEqual([report.verdict, report.advice], ["stalled", "release-shell"]);
	assert.equal(report.waitingOn[0].processes.find((p) => p.pid === 101).cpuPct, 0);
	assert.equal(report.daemon.running, false);
	assert.equal(report.source.world, "fresh");
	assert.deepEqual(sleeps, [3000], "one CPU sample window between the two snapshots");
	assert.equal(closed, 1, "the process worker is closed");

	cpuPerMs = 0.5;
	const busy = await diagnoseCli(["st_c"]);
	assert.equal(busy.code, 0);
	assert.match(busy.text, /판정: 진행 중/);
	assert.match(busy.text, /node driver\.mjs/);
	assert.match(busy.text, /CPU 50%/);

	assert.equal((await diagnoseCli(["st_nope"])).code, 1);
	assert.equal((await captured(() => main(["diagnose"], { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h") }))).code, 2, "an id is required");
});

test("diagnose applies the 5 min quiet limit to a task the daemon stalled on within the hour, as the daemon does (#82)", () => {
	const now = T + 7 * 60_000;
	const plain = diagnose(subject({ now }), "st_c").waitingOn[0];
	assert.notEqual(plain.cls, "quiet-hang", "without a restall record the 15 min limit holds");
	const stalledOn = (atMs, toolCallId) => new Map([["st_c", { atMs, toolCallId }]]);
	const again = diagnose(subject({ now }), "st_c", { stalls: stalledOn(T - 10 * 60_000, "earlier-call") }).waitingOn[0];
	assert.deepEqual([again.cls, again.rule, again.evidence.includes("restall")], ["quiet-hang", "R12", true]);
	assert.notEqual(diagnose(subject({ now }), "st_c", { stalls: stalledOn(T - 10 * 60_000, "call1") }).waitingOn[0].cls, "quiet-hang", "a call's own stall does not loosen its thresholds");
	assert.notEqual(diagnose(subject({ now }), "st_c", { stalls: stalledOn(T - 70 * 60_000, "earlier-call") }).waitingOn[0].cls, "quiet-hang", "a stall outside stall.restallWindowMs does not count");
});

test("`diagnose` reads the daemon's restall record from state.json (#82)", async () => {
	const root = tmpDir("omoh-diagnose-restall-");
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), OMO_HEALTH_CLAUDE_HOME: path.join(root, "c") });
	const project = path.join(root, "proj");
	const command = "node driver.mjs";
	writeTask(project, { task_id: "st_c", status: "running", host_pid: HOST_PID, parent_session_id: "p1", root_session_id: "p1", child_session_id: CHILD, execution_mode: "in-process", background_mode: "background", spawn_spec: { cwd: project }, task_summary: "browser QA" }, [
		E.header(CHILD, project, T - 60_000),
		E.user("QA the dashboard", T - 60_000),
		E.assistant({ ms: T, calls: [{ id: "call1", name: "bash", args: { command } }] }),
	]);
	const clock = createFakeClock(T + 7 * 60_000);
	fs.mkdirSync(paths.health.sensorsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.sensorsDir, "p1.json"), JSON.stringify({ sessionId: "p1", pid: HOST_PID, cwd: project, idle: true, ts: clock.now() }));
	const procs = { snapshot: async () => ({ takenAtMs: clock.now(), rows: normalizeRows([host(), ...tree(command, T, 0)]) }), os: async () => undefined, ports: async () => [], close() {} };
	const deps = { procs, clock, sleep: async (ms) => clock.advance(ms) };
	const call = async () => JSON.parse((await captured(() => run("diagnose", ["st_c", "--json"], { paths, config: DEFAULT_CONFIG, diagnose: deps }))).text).waitingOn[0];
	assert.notEqual((await call()).cls, "quiet-hang", "no record, no restall");
	fs.writeFileSync(paths.health.stateFile, JSON.stringify({ v: 1, records: [], memories: { stall: { stalls: { st_c: { atMs: T - 10 * 60_000, toolCallId: "earlier-call" } } } } }));
	const restalled = await call();
	assert.deepEqual([restalled.cls, restalled.evidence.includes("restall")], ["quiet-hang", true]);
});
