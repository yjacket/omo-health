import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { argvMatches, isProtectedProcess, matchPendingCall, processArgv, segmentArgv, splitSegments } from "../src/detect/match.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-23T15:37:04.874Z");
const iso = (ms) => new Date(ms).toISOString();
const HOST_PID = 25760;
const HOST = raw(HOST_PID, 20000, "node.exe", "2026-09-23T09:00:00Z", 1, 1, "node C:\\npm\\node_modules\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js --extension x");
const GREP_CMD = "grep -o '.\\{0,1800\\}h=function(e,t,n){let r=\\[' omo.js | head -1";
const shellCmd = (cmd) => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd.replace(/"/g, '\\"')}"`;

function childSession(calls, extra = {}) {
	const task = taskRecord({ taskId: "st_01a0ced9", hostPid: HOST_PID, parentSessionId: "01a0cd9e", childSessionId: "c1", ...extra.task });
	return sessionState({ id: "c1", kind: "child", taskId: task.taskId, hostPid: HOST_PID, parentSessionId: "01a0cd9e", task, pendingCalls: calls, ...extra.session });
}

const world = (sessions, rows, options = {}) => makeWorld({ now: T + 600_000, sessions, procSnapshots: [{ takenAtMs: T + 600_000, rows: [HOST, ...rows] }], ...options });

test("segments are quote-aware and redirections are stripped", () => {
	assert.deepEqual(splitSegments("node mock-upstream.mjs > logs/mock.out 2>&1"), ["node mock-upstream.mjs"]);
	assert.deepEqual(splitSegments("yes | grep -c zzz"), ["yes", "grep -c zzz"]);
	assert.deepEqual(splitSegments("echo 'a | b' && ls; cat x &> y"), ["echo 'a | b'", "ls", "cat x"]);
	assert.deepEqual(processArgv('"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -c "zzz"'), ["grep", "-c", "zzz"]);
	assert.ok(argvMatches(segmentArgv("grep -c 'zzz'"), ["grep", "-c", "zzz"]));
	assert.ok(!argvMatches(segmentArgv("grep -c 'zzz'"), ["grep", "-c", "zzz", "extra"]));
});

test("a quoted shell variable stands for exactly one argument of the running process", () => {
	const words = segmentArgv("grep -o 'x\\{0,1800\\}y' \"$f\"");
	assert.deepEqual(words.map((w) => w.variable), [false, false, false, true]);
	assert.ok(argvMatches(words, processArgv('"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -o x\\{0,1800\\}y /c/omo-ai/plugin/extensions/omo.js')));
	assert.ok(!argvMatches(words, processArgv('"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -o other /c/omo.js')));
	assert.ok(!argvMatches(segmentArgv("grep -o x '$f'"), ["grep", "-o", "x", "/c/omo.js"]), "a single-quoted $f is literal");
	assert.ok(argvMatches(segmentArgv('cat "$f" -'), processArgv("cat /c/Program Files/x.txt -")), "an expanded value may span several unquoted tokens");
});

test("full command match on the host's direct shell child, with descendants and a matching MSYS orphan", () => {
	const call = { id: "toolu_grep", name: "bash", args: { command: GREP_CMD }, ms: T };
	const rows = [
		raw(60168, HOST_PID, "bash.exe", iso(T + 5), 0, 1, shellCmd(GREP_CMD)),
		raw(60170, 60168, "bash.exe", iso(T + 30), 0, 1, `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${GREP_CMD}"`),
		raw(60180, 60170, "head.exe", iso(T + 60), 0, 1, "head -1"),
		// orphan grep: parent 62120 is gone
		raw(55000, 62120, "grep.exe", iso(T + 400), 3_188_700, 13e9, "\"C:\\Program Files\\Git\\usr\\bin\\grep.exe\" -o .\\{0,1800\\}h=function(e,t,n){let r=\\[ omo.js"),
	];
	const w = world([childSession([call])], rows);
	const m = matchPendingCall({ call, session: w.sessions.get("c1"), world: w, memory: { matches: new Map() } });
	assert.equal(m.state, "running");
	assert.equal(m.confidence, "high");
	assert.equal(m.root.pid, 60168);
	assert.deepEqual(m.tree.map((p) => p.pid).sort(), [60168, 60170, 60180]);
	assert.deepEqual(m.orphans.map((p) => p.pid), [55000]);
});

test("a foreign grep orphan with a rival shell elsewhere is rejected", () => {
	const call = { id: "toolu_grep", name: "bash", args: { command: "grep -rn foo ." }, ms: T };
	const rows = [
		raw(60168, HOST_PID, "bash.exe", iso(T + 5), 0, 1, shellCmd("grep -rn foo .")),
		raw(71000, 9999, "bash.exe", iso(T + 1000), 0, 1, shellCmd("grep -rn foo .")),
		raw(71001, 424242, "grep.exe", iso(T + 1500), 1, 1, "grep -rn foo ."),
	];
	const w = world([childSession([call])], rows);
	const m = matchPendingCall({ call, session: w.sessions.get("c1"), world: w, memory: { matches: new Map() } });
	assert.equal(m.orphans.length, 0);
	assert.match(m.orphanRejects[0].reason, /^rival-shell-71000$/);
});

test("orphans outside the 5 s window of the root are not ours", () => {
	const call = { id: "t", name: "bash", args: { command: "yes | grep -c zzz" }, ms: T };
	const rows = [raw(100, HOST_PID, "bash.exe", iso(T + 10), 0, 1, shellCmd("yes | grep -c zzz")), raw(200, 555, "yes.exe", iso(T + 9000), 1, 1, "yes")];
	const w = world([childSession([call])], rows);
	assert.equal(matchPendingCall({ call, session: w.sessions.get("c1"), world: w }).orphans.length, 0);
});

test("a monitor shell with the same command makes the match ambiguous (no kill)", () => {
	const cmd = "npm run dev";
	const call = { id: "t", name: "bash", args: { command: cmd }, ms: T };
	const rows = [raw(100, HOST_PID, "bash.exe", iso(T + 10), 0, 1, shellCmd(cmd)), raw(101, HOST_PID, "bash.exe", iso(T + 20), 0, 1, shellCmd(cmd))];
	const w = world([childSession([call])], rows);
	const m = matchPendingCall({ call, session: w.sessions.get("c1"), world: w });
	assert.equal(m.state, "ambiguous");
	assert.equal(m.confidence, "low");
});

test("two pending calls with the same command pair with shells in creation order", () => {
	const cmd = "sleep 99999";
	const a = { id: "a", name: "bash", args: { command: cmd }, ms: T, index: 0 };
	const b = { id: "b", name: "bash", args: { command: cmd }, ms: T, index: 1 };
	const rows = [raw(300, HOST_PID, "bash.exe", iso(T + 50), 0, 1, shellCmd(cmd)), raw(301, HOST_PID, "bash.exe", iso(T + 60), 0, 1, shellCmd(cmd))];
	const w = world([childSession([a, b])], rows);
	const s = w.sessions.get("c1");
	assert.equal(matchPendingCall({ call: a, session: s, world: w }).root.pid, 300);
	assert.equal(matchPendingCall({ call: b, session: s, world: w }).root.pid, 301);
});

test("a shell running a longer command that merely contains the call's command is not a full match", () => {
	const call = { id: "t", name: "bash", args: { command: "sleep 5" }, ms: T };
	const rows = [raw(500, HOST_PID, "bash.exe", iso(T + 5), 0, 1, shellCmd("sleep 50"))];
	const w = world([childSession([call])], rows);
	assert.notEqual(matchPendingCall({ call, session: w.sessions.get("c1"), world: w }).confidence, "high");
});

test("fewer matching shells than pending calls with that command is ambiguous (no kill)", () => {
	const cmd = "sleep 99999";
	const a = { id: "a", name: "bash", args: { command: cmd }, ms: T, index: 0 };
	const b = { id: "b", name: "bash", args: { command: cmd }, ms: T, index: 1 };
	const rows = [raw(300, HOST_PID, "bash.exe", iso(T + 50), 0, 1, shellCmd(cmd))];
	const w = world([childSession([a, b])], rows);
	for (const call of [a, b]) assert.equal(matchPendingCall({ call, session: w.sessions.get("c1"), world: w }).state, "ambiguous", call.id);
});

test("same-command calls a minute apart each pair with their own shell", () => {
	const cmd = "sleep 99999";
	const a = { id: "a", name: "bash", args: { command: cmd }, ms: T, index: 0 };
	const b = { id: "b", name: "bash", args: { command: cmd }, ms: T + 60_000, index: 0 };
	const rows = [raw(300, HOST_PID, "bash.exe", iso(T + 50), 0, 1, shellCmd(cmd)), raw(301, HOST_PID, "bash.exe", iso(T + 60_050), 0, 1, shellCmd(cmd))];
	const w = world([childSession([a, b])], rows);
	const s = w.sessions.get("c1");
	assert.equal(matchPendingCall({ call: a, session: s, world: w }).root?.pid, 300);
	assert.equal(matchPendingCall({ call: b, session: s, world: w }).root?.pid, 301);
});

test("shells outside the time window or under another parent never match", () => {
	const call = { id: "t", name: "bash", args: { command: "sleep 99999" }, ms: T };
	const rows = [raw(400, HOST_PID, "bash.exe", iso(T - 60_000), 0, 1, shellCmd("sleep 99999")), raw(401, 12345, "bash.exe", iso(T + 5), 0, 1, shellCmd("sleep 99999"))];
	const w = world([childSession([call])], rows);
	const m = matchPendingCall({ call, session: w.sessions.get("c1"), world: w });
	assert.equal(m.state, "unmatched");
	assert.equal(m.reason, "no-candidate-shell");
});

test("prefix-only matches are low confidence", () => {
	const long = `node -e "${"x".repeat(200)}"`;
	const call = { id: "t", name: "bash", args: { command: long }, ms: T };
	const rows = [raw(500, HOST_PID, "bash.exe", iso(T + 5), 0, 1, shellCmd(`node -e "${"x".repeat(120)}"`))];
	const w = world([childSession([call])], rows);
	const m = matchPendingCall({ call, session: w.sessions.get("c1"), world: w });
	assert.equal(m.confidence, "low");
});

test("a matched root that disappears reports exited; non-shell tools are unmatched", () => {
	const call = { id: "t", name: "bash", args: { command: "sleep 5" }, ms: T };
	const memory = { matches: new Map([["t", { pid: 600, ctime: "2026-09-23T15:37:05.000Z" }]]) };
	const w = world([childSession([call])], []);
	assert.equal(matchPendingCall({ call, session: w.sessions.get("c1"), world: w, memory }).state, "exited");
	assert.equal(matchPendingCall({ call: { id: "r", name: "read", args: { path: "x" }, ms: T }, session: w.sessions.get("c1"), world: w }).reason, "not-a-shell-call");
});

test("process-mode children match shells under task.pid", () => {
	const call = { id: "t", name: "bash", args: { command: "sleep 99999" }, ms: T };
	const s = childSession([call], { task: { executionMode: "process", pid: 7777 } });
	const rows = [raw(7777, HOST_PID, "node.exe", iso(T - 60_000), 0, 1, "node cli.js --mode rpc"), raw(800, 7777, "bash.exe", iso(T + 5), 0, 1, shellCmd("sleep 99999"))];
	const w = world([s], rows);
	assert.equal(matchPendingCall({ call, session: w.sessions.get("c1"), world: w }).root.pid, 800);
});

test("hosts, claude, orca and the daemon tree are protected", () => {
	const rows = [raw(900, 1, "claude.exe", iso(T), 0, 1, "claude"), raw(901, 1, "Orca.exe", iso(T), 0, 1, "Orca")];
	const w = world([], rows, { self: { pid: 1 } });
	assert.equal(isProtectedProcess(w.procs.get(HOST_PID), w), true);
	assert.equal(isProtectedProcess(w.procs.get(900), w), true);
	assert.equal(isProtectedProcess(w.procs.get(901), w), true);
});
