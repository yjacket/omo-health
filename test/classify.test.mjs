import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitBoundMs, isUnboundedWait, redirectTargets } from "../src/detect/classify.mjs";
import * as runaway from "../src/detect/runaway.mjs";
import * as stall from "../src/detect/stall.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-23T15:37:04.874Z");
const iso = (ms) => new Date(ms).toISOString();
const HOST_PID = 25760;
const HOST = (cpu = 0) => raw(HOST_PID, 20000, "node.exe", "2026-09-23T09:00:00Z", cpu, 1e8, "node C:\\npm\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js");
const shellCmd = (cmd) => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd.replace(/"/g, '\\"')}"`;
const MB = 1024 * 1024;

function child(calls, extra = {}) {
	const task = taskRecord({ taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", backgroundMode: extra.background ?? "background" });
	return sessionState({ id: "c1", kind: "child", taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", task, pendingCalls: calls, cwd: "C:\\dev\\proj", lastEntryMs: extra.lastEntryMs });
}

/**
 * Build a world where each process in `tree` is sampled at `samples` snapshots 20 s apart ending at `now`.
 * tree rows: {p, pp, n, c, cl, cpuPerSnap (ms), pv0, pvPerSnap, wbPerSnap}
 */
function worldWith({ now, calls, tree, ports, os, background, extraSessions = [], intentFor, fileProbe, config, lastEntryMs, main = false }) {
	const snaps = [];
	const n = 16;
	for (let i = 0; i < n; i++) {
		const t = now - (n - 1 - i) * 20_000;
		const rows = [HOST(i * 10)];
		for (const r of tree) {
			if (r.bornMs && r.bornMs > t) continue;
			rows.push({ p: r.p, pp: r.pp, n: r.n, c: r.c, cpu: (r.cpuPerSnap ?? 0) * i, pv: (r.pv0 ?? 10 * MB) + (r.pvPerSnap ?? 0) * i, ws: 0, rb: 0, wb: (r.wbPerSnap ?? 0) * i, cl: r.cl });
		}
		snaps.push({ takenAtMs: t, rows });
	}
	const session = main ? sessionState({ id: "m1", kind: "main", hostPid: HOST_PID, pendingCalls: calls, lastEntryMs }) : child(calls, { background, lastEntryMs });
	return makeWorld({ now, sessions: [session, ...extraSessions], procSnapshots: snaps, ports, os, intentFor, fileProbe, config });
}

const call = (command, extra = {}) => ({ id: extra.id ?? "t1", name: "bash", args: { command, ...(extra.args ?? {}) }, ms: extra.ms ?? T, batchId: "b", index: 0, batchSize: 1 });
const find = (world) => stall.detect(world, {}).filter((f) => f.kind === "stall");

test("a detached server that still holds the call's pipe stays server-foreground so release-shell can reach it", () => {
	// Live 2026-09-24: an unredirected server keeps writing to the tool pipe after its shells were detached.
	const cmd = "node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(18097);setInterval(()=>console.log('tick'),50)\"";
	const now = T + 4 * 60_000;
	const serverCtime = iso(T + 300);
	const snaps = [0, 1, 2].map((i) => ({ takenAtMs: now - (2 - i) * 20_000, rows: [HOST(i * 10), raw(101, 100, "node.exe", serverCtime, i * 50, 30 * MB, cmd)] }));
	const world = (attributed) => makeWorld({ now, sessions: [child([call(cmd, { args: { run_in_background: true } })])], procSnapshots: snaps, ports: [{ port: 18097, pid: 101, address: "0.0.0.0" }], attributed });
	const memory = () => ({ matches: new Map([["t1", { pid: 100, ctime: iso(T + 5) }]]) });
	const held = stall.detect(world(new Map([[`101@${serverCtime}`, { toolCallId: "t1", role: "detached-server", sessionId: "c1" }]])), memory()).find((f) => f.kind === "stall");
	assert.equal(held.cls, "server-foreground");
	assert.deepEqual(held.data.match.tree.map((p) => p.pid), [101]);
	const plain = stall.detect(world(new Map()), memory()).find((f) => f.kind === "stall");
	assert.equal(plain.cls, "exited-no-result");
});

test("F3: CPU-bound grep (orphan) is runaway-readonly and targets only the grep", () => {
	const cmd = "grep -o '.\\{0,1800\\}h=function(e,t,n){let r=\\[' omo.js | head -1";
	const now = T + 600_000;
	const w = worldWith({
		now,
		calls: [call(cmd)],
		tree: [
			{ p: 60168, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
			{ p: 60170, pp: 60168, n: "bash.exe", c: iso(T + 30), cl: `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${cmd}"` },
			{ p: 60180, pp: 60170, n: "head.exe", c: iso(T + 60), cl: "head -1" },
			{ p: 55000, pp: 62120, n: "grep.exe", c: iso(T + 400), cpuPerSnap: 19_800, pv0: 500 * MB, pvPerSnap: 1 * MB, cl: '"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -o .\\{0,1800\\}h=function(e,t,n){let r=\\[ omo.js' },
		],
	});
	const [f] = find(w);
	assert.equal(f.cls, "runaway-readonly");
	assert.equal(f.data.classification.action.kind, "kill-pids");
	assert.deepEqual(f.data.classification.action.targets.map((t) => t.pid), [55000]);
	assert.equal(f.data.dueMs, T + 600_000);
	assert.equal(f.severity, "warn");
});

test("F3 variant: the same grep but idle is not a runaway", () => {
	const cmd = "grep -o 'x' omo.js | head -1";
	const now = T + 600_000;
	const w = worldWith({
		now,
		calls: [call(cmd)],
		tree: [
			{ p: 60168, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
			{ p: 60170, pp: 60168, n: "grep.exe", c: iso(T + 50), cpuPerSnap: 0, cl: "grep -o x omo.js" },
		],
	});
	const [f] = find(w);
	assert.notEqual(f.cls, "runaway-readonly");
	assert.equal(f.cls, "unknown");
});

test("yes | grep -c zzz canary: both busy read-only programs are targets", () => {
	const cmd = "yes | grep -c zzz";
	const now = T + 11 * 60_000;
	const w = worldWith({
		now,
		calls: [call(cmd)],
		tree: [
			{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
			{ p: 101, pp: 100, n: "yes.exe", c: iso(T + 40), cpuPerSnap: 9_000, wbPerSnap: 5e8, cl: "yes" },
			{ p: 102, pp: 100, n: "grep.exe", c: iso(T + 41), cpuPerSnap: 11_000, cl: "grep -c zzz" },
		],
	});
	const [f] = find(w);
	assert.equal(f.cls, "runaway-readonly");
	assert.deepEqual(f.data.classification.action.targets.map((t) => t.pid).sort(), [101, 102]);
});

test("commit pressure alone kills only a large tree: a 139 MB server at 91% commit is left alone", () => {
	// Real case 2026-09-24T18:03Z: st_01a0d044 uvicorn, treePrivMB 139, 0 MB/min, commit 91.3%.
	const cmd = "uv run --frozen uvicorn app:app --port 8032 > C:/tmp/server.log 2>&1";
	const now = T + 20 * 60_000;
	const treeOf = (pv) => [
		{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
		{ p: 101, pp: 100, n: "python.exe", c: iso(T + 50), pv0: pv, cl: "python -m uvicorn app:app --port 8032" },
	];
	const os = { commitFrac: 0.913, commitUsedBytes: 1, commitLimitBytes: 2 };
	const [small] = find(worldWith({ now, calls: [call(cmd)], tree: treeOf(139 * MB), os }));
	assert.notEqual(small.cls, "memory-runaway");
	const [large] = find(worldWith({ now, calls: [call(cmd)], tree: treeOf(1500 * MB), os }));
	assert.equal(large.cls, "memory-runaway");
	assert.deepEqual(large.data.classification.action.targets.map((t) => t.pid), [101]);
});

test("memory growth kills the growing process even before softMs; single snapshots never do", () => {
	const cmd = "node -e \"const a=[];setInterval(()=>a.push(Buffer.alloc(40e6,1)),10000)\"";
	const now = T + 5 * 60_000 + 30_000;
	const tree = [
		{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
		{ p: 101, pp: 100, n: "node.exe", c: iso(T + 50), pv0: 50 * MB, pvPerSnap: 80 * MB, cpuPerSnap: 100, cl: cmd },
	];
	const [f] = find(worldWith({ now, calls: [call(cmd)], tree }));
	assert.equal(f.cls, "memory-runaway");
	assert.equal(f.severity, "crit");
	assert.deepEqual(f.data.classification.action.targets.map((t) => t.pid), [101]);
	const single = makeWorld({ now, sessions: [child([call(cmd)])], procSnapshots: [{ takenAtMs: now, rows: [HOST(), raw(100, HOST_PID, "bash.exe", iso(T + 5), 0, 1, shellCmd(cmd)), raw(101, 100, "node.exe", iso(T + 50), 0, 9e9, cmd)] }] });
	assert.notEqual(find(single)[0]?.cls, "memory-runaway");
});

test("F2: server with a listening port and background intent is detached, server kept", () => {
	const cmd = "node mock-upstream.mjs > logs/mock.out 2>&1";
	const now = T + 3 * 60_000;
	const w = worldWith({
		now,
		calls: [call(cmd)],
		tree: [
			{ p: 25628, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
			{ p: 25630, pp: 25628, n: "bash.exe", c: iso(T + 20), cl: `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${cmd}"` },
			{ p: 60496, pp: 25630, n: "node.exe", c: iso(T + 40), cl: "node mock-upstream.mjs" },
		],
		ports: [{ port: 18080, pid: 60496, address: "127.0.0.1" }],
		intentFor: () => ({ runInBackground: true }),
		fileProbe: (file) => (file.endsWith("mock.out") ? { size: 40, mtimeMs: T, tail: "mock upstream listening on 127.0.0.1:18080" } : undefined),
	});
	const [f] = find(w);
	assert.equal(f.cls, "server-foreground");
	const action = f.data.classification.action;
	assert.equal(action.kind, "detach-server");
	assert.deepEqual(action.targets.map((t) => t.pid).sort(), [25628, 25630]);
	assert.deepEqual(action.serverPids.map((t) => t.pid), [60496]);
	assert.equal(f.data.dueMs, T + 120_000);
});

test("grep for the word server is not a server", () => {
	const cmd = "grep -rn server src";
	const now = T + 3 * 60_000;
	const w = worldWith({ now, calls: [call(cmd)], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "grep.exe", c: iso(T + 30), cl: "grep -rn server src" }] });
	const found = find(w);
	assert.ok(found.every((f) => f.cls !== "server-foreground"));
});

test("sleep 99999 is an unbounded wait released at 15 min; a timeout-wrapped wait is bounded", () => {
	const now = T + 6 * 60_000;
	const tree = (cmd) => [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "sleep.exe", c: iso(T + 30), cl: cmd }];
	const [a] = find(worldWith({ now, calls: [call("sleep 99999")], tree: tree("sleep 99999") }));
	assert.equal(a.cls, "unbounded-wait");
	assert.equal(a.data.classification.action.kind, "release-shell");
	assert.equal(a.data.dueMs, T + 15 * 60_000);
	const bounded = "timeout 600 tail -n 0 -F live.jsonl | grep -m1 done";
	const [b] = find(worldWith({ now, calls: [call(bounded)], tree: tree(bounded) }));
	assert.equal(b.cls, "bounded");
	assert.equal(b.data.classification.action, null);
	assert.equal(b.severity, "info");
});

test("progressing: a build with CPU and writes waits; a plain writer counts as progress", () => {
	const now = T + 12 * 60_000;
	const pytest = "uv run pytest -q";
	const [a] = find(worldWith({ now, calls: [call(pytest)], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(pytest) }, { p: 101, pp: 100, n: "python.exe", c: iso(T + 30), cpuPerSnap: 5000, wbPerSnap: 20_000, cl: "python -m pytest -q" }] }));
	assert.equal(a.cls, "progressing");
	assert.equal(a.data.classification.action, null);
	const writer = "node -e \"let i=0;setInterval(()=>require('fs').appendFileSync('p.log','x'.repeat(1000)),1000)\"";
	const [b] = find(worldWith({ now, calls: [call(writer)], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(writer) }, { p: 101, pp: 100, n: "node.exe", c: iso(T + 30), cpuPerSnap: 20, wbPerSnap: 20_000, cl: writer }] }));
	assert.equal(b.cls, "progressing");
});

test("idle node with nothing to go on is unknown -> analyze, never a clock release", () => {
	const cmd = "node -e \"setInterval(()=>{},1000)\"";
	const now = T + 11 * 60_000;
	const [f] = find(worldWith({ now, calls: [call(cmd)], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "node.exe", c: iso(T + 30), cl: cmd }] }));
	assert.equal(f.cls, "unknown");
	assert.equal(f.data.classification.action.kind, "analyze");
	assert.equal(f.data.classification.data.fallbackDueMs, undefined);
});

test("an idle interactive program is blocked-on-input", () => {
	const cmd = "git log | less";
	const now = T + 4 * 60_000;
	const [f] = find(worldWith({ now, calls: [call(cmd)], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "less.exe", c: iso(T + 30), cl: "less" }] }));
	assert.equal(f.cls, "blocked-on-input");
	assert.equal(f.data.dueMs, T + 180_000);
});

test("human waits, child waits and withheld results never get an action", () => {
	const now = T + 70 * 60_000;
	const ask = { id: "q", name: "ask_user_question", args: {}, ms: T, batchId: "a" };
	const task = { id: "k", name: "task", args: { prompt: "x" }, ms: T, batchId: "b" };
	const found = stall.detect(makeWorld({ now, sessions: [sessionState({ id: "m", kind: "main", hostPid: HOST_PID, pendingCalls: [ask, task] })], sensors: [{ sessionId: "m", pid: HOST_PID, ts: now }], procSnapshots: [{ takenAtMs: now, rows: [HOST()] }] }), {});
	assert.deepEqual(found.map((f) => f.cls), ["human-wait"]);
	assert.equal(found[0].data.classification.action, null);
});

test("in-process tools of a child are relayed after 20 min; the dead-session guard applies", () => {
	const now = T + 21 * 60_000;
	const read = { id: "r", name: "read", args: { path: "x" }, ms: T, batchId: "b" };
	const [f] = find(worldWith({ now, calls: [read], tree: [] }));
	assert.equal(f.cls, "inproc");
	assert.equal(f.data.classification.action.kind, "relay-cancel");
	const dead = makeWorld({ now, sessions: [child([read])], procSnapshots: [{ takenAtMs: now, rows: [] }] });
	assert.equal(find(dead).length, 0);
});

test("an in-process call held back by a running shell sibling is withheld with no action (#42 sample A)", () => {
	// senpi persists a batch's toolResults together once its slowest call ends, so a finished `write` waits for the bash.
	const cmd = "timeout 3600 sleep 3000";
	const now = T + 21 * 60_000;
	const write = { id: "w", name: "write", args: { path: "x" }, ms: T, batchId: "b", index: 0, batchSize: 2 };
	const tree = [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "sleep.exe", c: iso(T + 30), cl: "sleep 3000" }];
	const found = find(worldWith({ now, calls: [write, call(cmd, { id: "s" })], tree }));
	const w = found.find((f) => f.subject.toolCallId === "w");
	assert.equal(w.cls, "withheld");
	assert.equal(w.data.classification.action, null);
	assert.ok(w.data.classification.evidence.includes("sibling-pending:s"));
	assert.equal(w.severity, "info");
	// Two in-process calls: nothing that can run long is pending, so a stuck one is still an in-process stall.
	const read = (id) => ({ id, name: "read", args: { path: "x" }, ms: T, batchId: "b", index: 0, batchSize: 2 });
	const pair = find(worldWith({ now, calls: [read("r1"), read("r2")], tree: [] }));
	assert.deepEqual(pair.map((f) => f.cls), ["inproc", "inproc"]);
});

test("an unmatched shell call with a pending sibling is withheld; alone it keeps relay-cancel, due after its bound (#40)", () => {
	const now = T + 21 * 60_000;
	const gone = "git diff --cached | cmp - a.patch";
	const sibling = call("sleep 99999", { id: "long" });
	// The sibling still runs; a batch whose calls have all stopped is a quiet hang instead (R12, #63 review).
	const running = [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd("sleep 99999") }, { p: 101, pp: 100, n: "sleep.exe", c: iso(T + 30), cl: "sleep 99999" }];
	const withheld = find(worldWith({ now, calls: [call(gone), sibling], tree: running })).find((f) => f.subject.toolCallId === "t1");
	assert.equal(withheld.cls, "withheld");
	assert.equal(withheld.data.classification.action, null);
	assert.deepEqual(withheld.data.classification.evidence.filter((e) => /^(match|sibling)/.test(e)), ["match:unmatched:no-candidate-shell", "sibling-pending:long"]);
	const [alone] = find(worldWith({ now, calls: [call(gone)], tree: [] }));
	assert.equal(alone.cls, "unmatched");
	assert.equal(alone.data.classification.action.kind, "relay-cancel");
	assert.equal(alone.data.dueMs, T + 20 * 60_000);
	const [bounded] = find(worldWith({ now, calls: [call(gone, { args: { timeout: 3600 } })], tree: [] }));
	assert.equal(bounded.cls, "unmatched");
	assert.equal(bounded.data.dueMs, T + 3600_000 + 60_000, "relay-cancel waits for the explicit bound plus grace");
});

test("a command that finished within its first minute is exited, not no-candidate-shell (#40)", () => {
	const cmd = "git diff --cached | cmp - a.patch";
	const shell = [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }];
	const memory = { matches: new Map() };
	// 30 s in the shell is still running: too young to classify, but its match is remembered.
	assert.equal(stall.detect(worldWith({ now: T + 30_000, calls: [call(cmd)], tree: shell }), memory).length, 0);
	assert.equal(memory.matches.get("t1")?.pid, 100);
	// 90 s in the shell is gone and the result is still missing.
	const [f] = stall.detect(worldWith({ now: T + 90_000, calls: [call(cmd)], tree: [] }), memory).filter((x) => x.kind === "stall");
	assert.equal(f.cls, "exited-no-result");
});

test("a pending call older than its host process is left over from a previous host and is skipped (#42)", () => {
	const now = T + 30 * 60_000;
	const read = { id: "r", name: "read", args: { path: "x" }, ms: T, batchId: "b", index: 0, batchSize: 1 };
	const rows = (hostCtime) => [{ takenAtMs: now, rows: [{ ...HOST(), c: hostCtime }] }];
	const stale = makeWorld({ now, sessions: [child([read])], procSnapshots: rows(iso(T + 10 * 60_000)) });
	assert.equal(find(stale).length, 0, "the host started after the call was issued");
	const same = makeWorld({ now, sessions: [child([read])], procSnapshots: rows(iso(T - 10 * 60_000)) });
	assert.equal(find(same).length, 1);
});

test("a foreground child stall marks its parent as blocked", () => {
	const cmd = "sleep 99999";
	const now = T + 16 * 60_000;
	const w = worldWith({ now, calls: [call(cmd)], background: "foreground", tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) }, { p: 101, pp: 100, n: "sleep.exe", c: iso(T + 30), cl: cmd }] });
	const all = stall.detect(w, {});
	assert.ok(all.some((f) => f.kind === "parent-blocked" && f.subject.sessionId === "p1"));
});

test("helpers: bounds, redirects and unbounded patterns", () => {
	assert.equal(explicitBoundMs({ name: "bash", args: { command: "sleep 5", timeout: 30 } }), 30_000);
	assert.equal(explicitBoundMs({ name: "bash", args: { command: "timeout 2m curl x" } }), 120_000);
	assert.equal(explicitBoundMs({ name: "bash", args: { command: "sleep 5" } }, { timeoutMs: 9000 }), 9000);
	assert.deepEqual(redirectTargets("node s.mjs > logs/a.out 2>&1"), ["logs/a.out"]);
	assert.deepEqual(redirectTargets("cmd 2>&1 | tee run.log"), ["run.log"]);
	assert.deepEqual(redirectTargets(`node -e "require('http').createServer((q,s)=>s.end('ok')).listen(1)"`), [], "an arrow function inside quotes is not a redirect");
	assert.deepEqual(redirectTargets(`node -e "x=>x" > "C:/tmp dir/srv.log" 2>&1`), ["C:/tmp dir/srv.log"]);
	assert.equal(isUnboundedWait("tail -f app.log", 3600), "tail-follow");
	assert.equal(isUnboundedWait("until [ -f x ]; do sleep 5; done", 3600), "poll-loop");
	assert.equal(isUnboundedWait("for i in $(seq 1 15); do sleep 1; done", 3600), undefined);
	assert.equal(isUnboundedWait("sleep 30", 3600), undefined);
});

test("D2 reports unattributed runaways under a live host and never attributed ones", () => {
	const now = T + 12 * 60_000;
	const snaps = [];
	for (let i = 0; i < 40; i++) {
		const t = now - (39 - i) * 20_000;
		snaps.push({ takenAtMs: t, rows: [HOST(), raw(900, HOST_PID, "node.exe", iso(T - 3600_000), i * 19_000, 100 * MB, "node build.js"), raw(901, HOST_PID, "grep.exe", iso(T - 3600_000), i * 19_000, 10 * MB, "grep x")] });
	}
	const w = makeWorld({ now, procSnapshots: snaps, attributed: new Map([["901@" + iso(T - 3600_000), { toolCallId: "t" }]]) });
	const found = runaway.detect(w, {}).filter((f) => f.kind === "process-runaway");
	assert.deepEqual(found.map((f) => f.data.pid), [900]);
	// Evidence for the why-look: the process command line rides along, redacted before it is cut.
	assert.equal(found[0].data.cmdHead, "node build.js");
});

test("D2 process-runaway carries the process command line, redacted", () => {
	const now = T + 12 * 60_000;
	const secret = `sk-ant-${'B'.repeat(60)}`;
	const snaps = [];
	for (let i = 0; i < 40; i++) {
		const t = now - (39 - i) * 20_000;
		snaps.push({ takenAtMs: t, rows: [HOST(), raw(900, HOST_PID, "node.exe", iso(T - 3600_000), i * 19_000, 100 * MB, `node build.js --token ${secret}`)] });
	}
	const [finding] = runaway.detect(makeWorld({ now, procSnapshots: snaps }), {}).filter((f) => f.kind === "process-runaway");
	assert.match(finding.data.cmdHead, /node build\.js/);
	assert.doesNotMatch(finding.data.cmdHead, /sk-ant-[A-Za-z0-9]/);
});

/** An idle `node driver.mjs` whose headless Chrome only trickles IPC and profile bytes (#52, stall 2). */
const DRIVER = "cd C:/dev/qa/t11 && node driver.mjs";
const driverTree = (cmd, { chromeCpu = 20, chromeWrites = 3000, nodeCpu = 0, nodeWrites = 0 } = {}) => [
	{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd(cmd) },
	{ p: 101, pp: 100, n: "node.exe", c: iso(T + 30), cpuPerSnap: nodeCpu, wbPerSnap: nodeWrites, cl: "node driver.mjs" },
	{ p: 102, pp: 101, n: "chrome.exe", c: iso(T + 40), cpuPerSnap: chromeCpu, wbPerSnap: chromeWrites, cl: "chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=C:\\dev\\qa\\t11\\profile about:blank" },
];
/** D1 at T + `minutes`, with one memory across calls as the engine keeps it. */
const stallAt = (memory, minutes, options) => stall.detect(worldWith({ now: T + minutes * 60_000, ...options }), memory).filter((f) => f.kind === "stall");

test("a child call with no transcript event and no output for stall.quietMs is a quiet hang whatever its rule class (#52)", () => {
	const quiet = { calls: [call(DRIVER)], tree: driverTree(DRIVER) };
	const memory = {};
	assert.equal(stallAt(memory, 2, quiet)[0].cls, "progressing", "the browser's trickle reads as writes to R10");
	assert.equal(stallAt(memory, 14.5, quiet)[0].cls, "progressing");
	const [f] = stallAt(memory, 15.5, quiet);
	assert.equal(f.cls, "quiet-hang");
	assert.equal(f.severity, "warn");
	assert.equal(f.data.classification.rule.id, "R12");
	assert.ok(f.evidence.includes("was:progressing"));
	assert.equal(f.data.remedy, undefined, "no stall notice any more");
	assert.equal(f.data.classification.action.kind, "analyze", "only an analyst verdict releases the shell");
	assert.equal(f.data.dueMs, T + 15 * 60_000, "due at the quiet threshold itself, no grace");
	for (const [label, cmd, tree] of [
		["bounded", "timeout 3600 node driver.mjs", driverTree("timeout 3600 node driver.mjs")],
		["unknown", DRIVER, driverTree(DRIVER, { chromeWrites: 0 })],
	]) {
		const m = {};
		assert.equal(stallAt(m, 2, { calls: [call(cmd)], tree })[0].cls, label);
		assert.equal(stallAt(m, 15.5, { calls: [call(cmd)], tree })[0].cls, "quiet-hang", label);
	}
});

test("signs of life keep a child call out of the quiet rule, and main sessions never enter it", () => {
	const at16 = (options) => {
		const memory = {};
		stallAt(memory, 2, options);
		return stallAt(memory, 16, options)[0];
	};
	const busy = driverTree(DRIVER, { nodeCpu: 5000, nodeWrites: 20_000 });
	assert.equal(at16({ calls: [call(DRIVER)], tree: busy }).cls, "progressing", "CPU with writes is output");
	assert.equal(at16({ calls: [call(DRIVER)], tree: driverTree(DRIVER), lastEntryMs: T + 10 * 60_000 }).cls, "progressing", "a transcript event 6 min ago");
	const logged = `${DRIVER} > driver.log 2>&1`;
	let size = 0;
	const fileProbe = (file) => (file.endsWith("driver.log") ? { size: (size += 100), mtimeMs: T, tail: "" } : undefined);
	assert.equal(at16({ calls: [call(logged)], tree: driverTree(logged), fileProbe }).cls, "progressing", "the redirected log grows");
	assert.equal(at16({ calls: [call(DRIVER)], tree: driverTree(DRIVER), main: true }).cls, "progressing", "main sessions are the human's");
});

test("a task that stalled within the hour is looked at sooner (#52)", () => {
	const quiet = { calls: [call(DRIVER)], tree: driverTree(DRIVER) };
	assert.equal(stallAt({}, 2, quiet)[0].data.rechecks, undefined, "no rechecks any more");
	const again = { stalls: new Map([["st_c", { atMs: T - 20 * 60_000, toolCallId: "t0" }]]) };
	stallAt(again, 2, quiet);
	const [f] = stallAt(again, 5.5, quiet);
	assert.equal(f.cls, "quiet-hang");
	assert.ok(f.evidence.includes("restall"));
	assert.equal(f.data.dueMs, T + 5 * 60_000);
	const old = { stalls: new Map([["st_c", { atMs: T - 70 * 60_000, toolCallId: "t0" }]]) };
	stallAt(old, 2, quiet);
	assert.equal(stallAt(old, 5.5, quiet)[0].cls, "progressing", "an hour later the task is back to the normal thresholds");
});

test("R10x and R11 only open an investigation: action analyze, no clock fallback due (#55 A)", () => {
	const idle = find(worldWith({ now: T + 11 * 60_000, calls: [call(DRIVER)], tree: driverTree(DRIVER, { chromeWrites: 0 }) }))[0];
	assert.equal(idle.data.classification.rule.id, "R11");
	assert.equal(idle.data.classification.action.kind, "analyze");
	assert.equal(idle.data.classification.data.noJudgeDueMs, undefined);
	assert.equal(idle.data.classification.data.fallbackDueMs, undefined);
	const busy = driverTree(DRIVER, { nodeCpu: 5000, nodeWrites: 20_000 });
	const late = find(worldWith({ now: T + 61 * 60_000, calls: [call(DRIVER)], tree: busy }))[0];
	assert.equal(late.data.classification.rule.id, "R10x");
	assert.equal(late.data.classification.action.kind, "analyze");
	assert.equal(late.data.classification.data.noJudgeDueMs, undefined);
});

test("a withheld call whose batch has nothing left running is quiet: one relay-cancel per batch (#63 review)", () => {
	const read = { id: "r1", name: "read", args: { path: "x" }, ms: T, batchId: "b", index: 0, batchSize: 2 };
	const bash = { ...call("sleep 900", { id: "s1" }), index: 1, batchSize: 2 };
	const lost = { calls: [read, bash], tree: [] };
	const memory = {};
	assert.deepEqual(stallAt(memory, 2, lost).map((f) => f.cls), ["withheld", "withheld"], "mutual: each waits for the other");
	const [first, second] = stallAt(memory, 15.5, lost);
	assert.equal(first.cls, "quiet-hang");
	assert.equal(first.subject.toolCallId, "r1");
	assert.equal(first.data.classification.action.kind, "relay-cancel", "nothing to release: the parent cancels");
	assert.equal(first.data.remedy, undefined);
	assert.equal(second.cls, "withheld");
	const running = { calls: [read, bash], tree: [{ p: 100, pp: HOST_PID, n: "bash.exe", c: iso(T + 5), cl: shellCmd("sleep 900") }, { p: 101, pp: 100, n: "sleep.exe", c: iso(T + 30), cl: "sleep 900" }] };
	const m2 = {};
	stallAt(m2, 2, running);
	assert.equal(stallAt(m2, 15.5, running).find((f) => f.subject.toolCallId === "r1").cls, "withheld", "its holder still runs");
});
