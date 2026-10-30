import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionSnapshot, detectEnded } from "../src/session-board.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const SENPI = "node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\omo-ai\\node_modules\\senpi\\dist\\bundle\\cli.js";
const host = (pid, ppid) => raw(pid, ppid, "node.exe", iso(NOW - 3_600_000), 0, 0, SENPI);

function tmpPaths() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
	return resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
}

function boardWorld(extra = {}) {
	const sessions = [
		sessionState({ id: "m1", startedMs: NOW - 5000, hostPid: 100 }),
		sessionState({ id: "m2", startedMs: NOW - 9000, hostPid: 200, pendingCalls: [{ id: "c1", name: "bash", ms: NOW - 3000 }] }),
		sessionState({ id: "m3", startedMs: NOW - 1000, hostPid: 300 }),
		sessionState({ id: "m4", startedMs: NOW - 2000, hostPid: 400, pendingCalls: [{ id: "q1", name: "ask_user_question", ms: NOW - 4000 }] }),
		sessionState({ id: "m5", startedMs: NOW - 3000, hostPid: 500 }),
	];
	Object.assign(sessions[0], { title: "Named session", todoState: { open: 2, total: 5 } });
	Object.assign(sessions[1], { anchor: { source: "goal", objective: "Ship the board", status: "active" } });
	Object.assign(sessions[2], { firstUserText: "fix the parser" });
	const tasks = [
		taskRecord({ taskId: "t1", childSessionId: "c1", parentSessionId: "m1", name: "child one", startedAtMs: NOW - 4000 }),
		taskRecord({ taskId: "t0", childSessionId: "c0", parentSessionId: "m1", name: "child zero", startedAtMs: NOW - 4500 }),
		taskRecord({ taskId: "t2", childSessionId: "c2", parentSessionId: "c1", name: "grandchild", startedAtMs: NOW - 3000 }),
		taskRecord({ taskId: "old", childSessionId: "co", parentSessionId: "m1", status: "completed", terminalAtMs: NOW - 3_600_000 }),
	];
	return makeWorld({
		now: NOW,
		sessions,
		tasks,
		procsFresh: true,
		procSnapshots: [{ takenAtMs: NOW, rows: [raw(50, 1, "Orca.exe", iso(NOW - 7_200_000)), host(100, 1), host(200, 50), host(300, 1), host(400, 1), host(500, 1)] }],
		sensors: [
			{ sessionId: "m1", pid: 100, ts: NOW - 1000, idle: true, executingTools: 0, terminal: { kind: "herdr" } },
			{ sessionId: "m2", pid: 200, ts: NOW - 1000, idle: false, executingTools: 1 },
			{ sessionId: "m3", pid: 300, ts: NOW - 60_000, idle: true },
			{ sessionId: "m4", pid: 400, ts: NOW - 1000, idle: false, executingTools: 1, lastInputAt: NOW - 8000 },
			{ sessionId: "m5", pid: 500, ts: NOW - 1000, idle: false, executingTools: 0, lastInputAt: NOW - 7000 },
		],
		hostExits: { heartbeats: [], crashRecords: [], liveMarkers: new Map([[100, { omoVersion: "5.1.19" }], [200, { omoVersion: "5.1.19" }], [400, { omoVersion: "5.10.0" }], [500, { omoVersion: "5.10.0" }]]) },
		...extra,
	});
}

const rowsOf = (snapshot) => new Map(snapshot.groups.flatMap((g) => g.sessions).map((row) => [row.sessionId, row]));

test("buildSessionSnapshot groups live main sessions by omo version (newest first, unknown last) sorted by start", () => {
	const snapshot = buildSessionSnapshot(boardWorld(), [], [], NOW);
	assert.equal(snapshot.v, 1);
	assert.equal(snapshot.ts, NOW);
	assert.deepEqual(snapshot.groups.map((g) => g.omoVersion), ["5.10.0", "5.1.19", null]);
	assert.deepEqual(snapshot.groups.map((g) => g.sessions.map((s) => s.sessionId)), [["m5", "m4"], ["m2", "m1"], ["m3"]]);
	const rows = rowsOf(snapshot);
	assert.equal(rows.get("m1").host.omoVersion, "5.1.19");
	assert.equal(rows.get("m1").host.pid, 100);
	assert.deepEqual(rows.get("m1").todo, { open: 2, total: 5 });
	assert.equal(rows.has("c1"), false, "children are not top-level rows");
});

test("buildSessionSnapshot picks the title from name, goal, first request, else 제목 없음", () => {
	const rows = rowsOf(buildSessionSnapshot(boardWorld(), [], [], NOW));
	assert.deepEqual([rows.get("m1").title, rows.get("m1").titleSource], ["Named session", "name"]);
	assert.deepEqual([rows.get("m2").title, rows.get("m2").titleSource], ["Ship the board", "goal"]);
	assert.deepEqual(rows.get("m2").goal, { status: "active", objective: "Ship the board" });
	assert.deepEqual([rows.get("m3").title, rows.get("m3").titleSource], ["fix the parser", "first-request"]);
	assert.deepEqual([rows.get("m4").title, rows.get("m4").titleSource], ["제목 없음", "none"]);
});

test("buildSessionSnapshot derives the state kind and the terminal from the heartbeat and the host ancestors", () => {
	const rows = rowsOf(buildSessionSnapshot(boardWorld(), [], [], NOW));
	assert.deepEqual(rows.get("m1").state, { kind: "idle", sinceMs: NOW - 1000, tool: null });
	assert.deepEqual(rows.get("m2").state, { kind: "tool", sinceMs: NOW - 3000, tool: "bash" });
	assert.equal(rows.get("m3").state.kind, "stale");
	assert.deepEqual(rows.get("m4").state, { kind: "waiting-user", sinceMs: NOW - 4000, tool: "ask_user_question" });
	assert.deepEqual(rows.get("m5").state, { kind: "busy", sinceMs: NOW - 7000, tool: null });
	assert.equal(rows.get("m5").lastInputMs, NOW - 7000);
	assert.deepEqual(rows.get("m1").terminal, { kind: "herdr" });
	assert.deepEqual(rows.get("m2").terminal, { kind: "orca" });
	assert.deepEqual(rows.get("m3").terminal, { kind: "other" });
});

test("an idle session with live work sources is waiting; non-work sources alone leave it idle", () => {
	const world = boardWorld();
	Object.assign(world.sensors.get("m1"), { idle: true, executingTools: 0, lastEventAt: NOW - 1500, wakeSources: { monitors: 2, "ask-user": 1 } });
	assert.deepEqual(rowsOf(buildSessionSnapshot(world, [], [], NOW)).get("m1").state, { kind: "waiting", sinceMs: NOW - 1500, tool: null, count: 2 });
	Object.assign(world.sensors.get("m1"), { wakeSources: { "ask-user": 1 } });
	assert.equal(rowsOf(buildSessionSnapshot(world, [], [], NOW)).get("m1").state.kind, "idle");
});

test("buildSessionSnapshot nests children by parent session and maps findings and investigations to their owner", () => {
	const findings = [
		{ fp: "f1", detector: "D1", kind: "stall", severity: "crit", titleKo: "멈춤", subject: { sessionId: "c1", taskId: "t1" } },
		{ fp: "f2", detector: "D2", kind: "loop", severity: "warn", titleKo: "반복", subject: { sessionId: "m1" } },
	];
	const investigations = [
		{ id: "f2", status: "analyzing", retryAtMs: NOW + 60_000, subject: { sessionId: "m1" } },
		{ id: "f9", status: "closed", subject: { sessionId: "m1" } },
	];
	const m1 = rowsOf(buildSessionSnapshot(boardWorld(), findings, investigations, NOW)).get("m1");
	assert.deepEqual(m1.children.map((c) => c.taskId), ["t0", "t1"], "running children by start; the long-finished one is gone");
	const t1 = m1.children[1];
	assert.deepEqual(t1.children.map((c) => c.taskId), ["t2"]);
	assert.equal(t1.sessionId, "c1");
	assert.equal(t1.name, "child one");
	assert.equal(t1.health.level, "crit");
	assert.deepEqual(t1.health.open, [{ fp: "f1", detector: "D1", kind: "stall", severity: "crit", titleKo: "멈춤", taskId: "t1" }]);
	assert.equal(m1.children[0].health.level, "ok");
	assert.equal(m1.health.level, "warn");
	assert.deepEqual(m1.health.open.map((f) => f.fp), ["f2"]);
	assert.deepEqual(m1.health.investigations, [{ fp: "f2", status: "analyzing", nextLookMs: NOW + 60_000 }]);
});

function mainRow(sessionId, extra = {}) {
	return { sessionId, title: `title ${sessionId}`, titleSource: "name", cwd: "C:\\dev\\proj", startedMs: NOW - 60_000, terminal: { kind: "orca" }, host: { pid: 100, ctimeMs: NOW - 3_600_000, omoVersion: "5.1.19" }, state: { kind: "idle", sinceMs: null, tool: null }, goal: null, todo: null, lastInputMs: null, health: { level: "ok", open: [], investigations: [] }, children: [], ...extra };
}

function childRow(taskId, extra = {}) {
	return { taskId, sessionId: `s_${taskId}`, name: `task ${taskId}`, category: null, model: null, status: "running", startedMs: NOW - 30_000, endedMs: null, health: { level: "ok", open: [], investigations: [] }, children: [], ...extra };
}

const snap = (ts, sessions) => ({ v: 1, ts, groups: [{ omoVersion: "5.1.19", sessions }] });

test("detectEnded records main sessions that left the board with goal-complete, crash, closed or unknown", () => {
	const prev = snap(NOW - 60_000, [
		mainRow("goal", { goal: { status: "complete", objective: "Done it" } }),
		mainRow("crashed", { children: [childRow("orphan")] }),
		mainRow("closed", { host: { pid: 101, ctimeMs: NOW - 100_000_000, omoVersion: null } }),
		mainRow("nohost", { host: null, terminal: null }),
	]);
	const world = makeWorld({ now: NOW, procsFresh: true, hostExits: { heartbeats: [], crashRecords: [{ atMs: NOW - 30_000, detection: "unclean_exit", startedMs: NOW - 3_600_000 + 500 }], liveMarkers: new Map() } });
	const records = new Map(detectEnded(prev, snap(NOW, []), world, NOW).map((r) => [r.sessionId, r]));
	assert.equal(records.get("goal").outcome, "goal-complete");
	assert.equal(records.get("goal").estimated, false);
	assert.equal(records.get("crashed").outcome, "crash");
	assert.equal(records.get("crashed").childCount, 1);
	assert.equal(records.get("crashed").omoVersion, "5.1.19");
	assert.deepEqual(records.get("crashed").terminal, { kind: "orca" });
	assert.equal(records.get("closed").outcome, "closed");
	assert.equal(records.get("closed").estimated, true);
	assert.equal(records.get("nohost").outcome, "unknown");
	assert.equal(records.get("nohost").estimated, true);
	assert.equal(records.get("s_orphan").outcome, "crash", "a running child of a crashed host ends with it");
	assert.equal(records.get("s_orphan").kind, "child");
	assert.equal(records.get("s_orphan").parentSessionId, "crashed");
	for (const record of records.values()) {
		assert.equal(record.source, "live");
		assert.equal(record.endedMs, NOW);
		assert.ok(record.reason.length > 0 && record.reason.length <= 300);
	}
});

test("detectEnded records children by task status: answered, cancelled, failed, released, unknown", () => {
	const paths = tmpPaths();
	fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.decisionsDir, "2026-09-23.jsonl"), `${JSON.stringify({ ts: iso(NOW - 10_000), action: { kind: "kill-pids" }, result: "execute", subject: { taskId: "rel" } })}\nnot json\n`);
	const ids = ["ans", "can", "fail", "rel", "gone", "still"];
	const prev = snap(NOW - 60_000, [mainRow("m", { children: ids.map((id) => childRow(id)) })]);
	const cur = snap(NOW, [mainRow("m", { children: [childRow("still"), childRow("can", { status: "cancelled" })] })]);
	const tasks = [
		taskRecord({ taskId: "ans", parentSessionId: "m", status: "completed", hasFinalResponse: true, terminalAtMs: NOW - 5000 }),
		taskRecord({ taskId: "can", parentSessionId: "m", status: "cancelled" }),
		taskRecord({ taskId: "fail", parentSessionId: "m", status: "error", errorMessage: "boom" }),
		taskRecord({ taskId: "rel", parentSessionId: "m", status: "error" }),
		taskRecord({ taskId: "still", parentSessionId: "m", status: "running" }),
	];
	const world = makeWorld({ now: NOW, paths, tasks, procsFresh: true });
	const records = new Map(detectEnded(prev, cur, world, NOW).map((r) => [r.taskId, r]));
	assert.deepEqual([...records.keys()].sort(), ["ans", "can", "fail", "gone", "rel"]);
	assert.equal(records.get("ans").outcome, "answered");
	assert.equal(records.get("ans").endedMs, NOW - 5000);
	assert.equal(records.get("can").outcome, "cancelled");
	assert.equal(records.get("fail").outcome, "failed");
	assert.match(records.get("fail").reason, /boom/);
	assert.equal(records.get("rel").outcome, "released");
	assert.equal(records.get("gone").outcome, "unknown");
	assert.equal(records.get("gone").estimated, true);
	assert.equal(records.get("ans").estimated, false);
	assert.equal(records.get("ans").sessionId, "s_ans");
	assert.equal(records.get("ans").parentSessionId, "m");
});

test("detectEnded decides nothing without a previous snapshot or a fresh process snapshot", () => {
	const prev = snap(NOW - 60_000, [mainRow("a")]);
	assert.deepEqual(detectEnded(undefined, snap(NOW, []), makeWorld({ now: NOW, procsFresh: true }), NOW), []);
	assert.deepEqual(detectEnded(prev, snap(NOW, []), makeWorld({ now: NOW, procsFresh: false }), NOW), []);
});

test("buildSessionSnapshot takes the name from omo's session list when the tracker never saw the session_info entry", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-names-"));
	const file = path.join(dir, "2026-09-23T15-00-00-000Z_m3.jsonl");
	fs.writeFileSync(path.join(dir, ".session-summaries.index"), [
		JSON.stringify({ file: path.basename(file), summary: { name: "Old name" } }),
		JSON.stringify({ file: "other.jsonl", summary: { name: "Someone else" } }),
		JSON.stringify({ file: path.basename(file), summary: { name: "Renamed session" } }),
		'{"file": "half-writ',
	].join("\n"));
	const world = boardWorld();
	Object.assign(world.sessions.get("m3"), { file });
	const rows = rowsOf(buildSessionSnapshot(world, [], [], NOW));
	assert.equal(rows.get("m3").title, "Renamed session");
	assert.equal(rows.get("m3").titleSource, "name");
	assert.equal(rows.get("m1").title, "Named session", "a name the tracker saw still wins");
});
