import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SessionRegistry, SessionTracker, writeTargets } from "../src/collect/sessions.mjs";
import { createTaskStoreReader, findChildSessionFile, senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { appendJsonl, E, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const T0 = Date.parse("2026-09-23T15:37:00Z");

test("pending calls track a parallel batch until each result arrives", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s1.jsonl");
	writeJsonl(file, [
		E.header("s1", "C:\\dev\\x", T0 - 60_000),
		E.user("go", T0 - 30_000),
		E.assistant({ ms: T0, calls: [{ id: "toolu_grep", name: "bash", args: { command: "grep -o x big" } }, { id: "toolu_git", name: "bash", args: { command: "git log" } }] }),
		E.toolResult("toolu_git", T0 + 500),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	const s = tracker.state;
	assert.equal(s.id, "s1");
	assert.equal(s.cwd, "C:\\dev\\x");
	assert.deepEqual([...s.pending.keys()], ["toolu_grep"]);
	assert.equal(s.pending.get("toolu_grep").batchSize, 2);
	assert.equal(s.resolved.has("toolu_git"), true);
	assert.equal(s.lastAssistant.stopReason, "toolUse");
});

test("senpi's todo-state entry gives the open todo count, and a later user turn does not reset it", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_todo.jsonl");
	const todo = (ms, statuses) => ({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [{ name: "P", tasks: statuses.map((status, i) => ({ content: `t${i}`, status })) }] }, timestamp: new Date(ms).toISOString() });
	writeJsonl(file, [E.header("todo", "C:\\dev\\x", T0), todo(T0 + 1000, ["completed", "in_progress", "pending"]), E.user("next", T0 + 2000)]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.todoState, { ms: T0 + 1000, total: 3, open: 2 });
	appendJsonl(file, [todo(T0 + 3000, ["completed", "completed", "completed"])]);
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.todoState.open, 0);
});

test("turn usage yields duration and tps; errors and writes are extracted", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s2.jsonl");
	writeJsonl(file, [
		E.header("s2", "C:\\dev\\x", T0),
		E.assistant({ ms: T0 + 10_000, startMs: T0, calls: [{ id: "t1", name: "edit", args: { path: "C:\\Users\\user\\.omo\\agent\\settings.json", edits: [] } }], usage: { input: 1, output: 500, cacheRead: 100, cacheWrite: 200_000, cost: { total: 4.3 } } }),
		E.toolResult("t1", T0 + 11_000, { name: "edit" }),
		E.assistant({ ms: T0 + 20_000, stopReason: "error", errorMessage: "Provider is not configured: anthropic-subscription" }),
		"not json at all",
	]);
	fs.appendFileSync(file, "{broken\n");
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	const s = tracker.state;
	assert.equal(s.turns[0].durMs, 10_000);
	assert.equal(s.turns[0].tps, 50);
	assert.equal(s.turns[0].cacheWrite, 200_000);
	assert.equal(s.writes[0].path, "C:\\Users\\user\\.omo\\agent\\settings.json");
	assert.equal(s.errors.length, 1);
	assert.equal(s.badLines, 1);
	assert.equal(s.pending.size, 0);
});

test("the last session_info name becomes the title, redacted and capped at 120 chars", () => {
	const file = path.join(tmpDir(), "2026_title.jsonl");
	const info = (name, ms) => ({ type: "session_info", id: "si", timestamp: new Date(ms).toISOString(), name });
	writeJsonl(file, [E.header("t", "C:/p", T0), info("first name", T0 + 1), info("renamed session", T0 + 2)]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.title, "renamed session");
	assert.equal(tracker.state.startedMs, T0);
	appendJsonl(file, [info(`leak sk-ant-${"A".repeat(20)} ${"x".repeat(200)}`, T0 + 3)]);
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.title, `leak sk-ant-[REDACTED] ${"x".repeat(200)}`.slice(0, 119) + "…");
});

test("advance applies only entries at or before the clock (replay path)", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s3.jsonl");
	writeJsonl(file, [E.header("s3", "C:\\x", T0), E.assistant({ ms: T0 + 1000, calls: [{ id: "a", name: "bash", args: { command: "sleep 9" } }] }), E.toolResult("a", T0 + 60_000)]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance(T0 + 30_000);
	assert.equal(tracker.state.pending.has("a"), true);
	tracker.advance(T0 + 61_000);
	assert.equal(tracker.state.pending.has("a"), false);
});

test("tool calls in an aborted or failed reply never run, so they are not pending, writes or commands", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s5.jsonl");
	writeJsonl(file, [
		E.header("s5", "C:\\x", T0),
		E.assistant({ ms: T0, stopReason: "aborted", calls: [{ id: "ab", name: "bash", args: { command: "grep -n x big" } }] }),
		E.assistant({ ms: T0 + 1000, stopReason: "error", errorMessage: "overloaded", calls: [{ id: "er", name: "edit", args: { path: "C:\\x\\a.txt", edits: [] } }] }),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 0);
	assert.equal(tracker.state.writes.length, 0);
	assert.equal(tracker.state.commands.length, 0);
	assert.equal(tracker.state.lastAssistant.stopReason, "error");
});

test("a new user or assistant message abandons unresolved calls", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s4.jsonl");
	writeJsonl(file, [E.header("s4", "C:\\x", T0), E.assistant({ ms: T0, calls: [{ id: "x", name: "bash", args: { command: "ls" } }] }), E.user("new direction", T0 + 5000)]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 0);
	assert.equal(tracker.state.abandoned, 1);
});

test("a resume scan entry abandons the calls a previous host left unmatched; a reload scan does not (#42)", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s6.jsonl");
	const scan = (reason, ms) => ({ type: "custom", customType: "pi-rules.scan", data: { cwd: "C:\\x", reason }, id: `scan-${reason}`, timestamp: new Date(ms).toISOString() });
	writeJsonl(file, [
		E.header("s6", "C:\\x", T0),
		E.assistant({ ms: T0, calls: [{ id: "w1", name: "write", args: { path: "a" } }, { id: "w2", name: "write", args: { path: "b" } }] }),
		scan("reload", T0 + 1000),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 2, "the same host reloading keeps its running batch");
	appendJsonl(file, [scan("resume", T0 + 66 * 60_000)]);
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 0);
	assert.equal(tracker.state.abandoned, 2);
});

test("incremental reads pick up appended entries", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_s5.jsonl");
	writeJsonl(file, [E.header("s5", "C:\\x", T0), E.assistant({ ms: T0, calls: [{ id: "y", name: "bash", args: { command: "sleep 1" } }] })]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 1);
	appendJsonl(file, [E.toolResult("y", T0 + 1000)]);
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.pending.size, 0);
});

test("writeTargets understands edit/write and apply_patch", () => {
	assert.deepEqual(writeTargets("write", { path: "a.txt" }), ["a.txt"]);
	assert.deepEqual(writeTargets("apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.mjs\n@@\n*** Add File: b.md\n" }), ["src/x.mjs", "b.md"]);
	assert.deepEqual(writeTargets("bash", { command: "ls" }), []);
});

test("activity tracks checks between edit rounds and resets on a user message", () => {
	const file = path.join(tmpDir(), "s.jsonl");
	writeJsonl(file, [E.header("s", "C:/p", T0), E.user("first request", T0 + 1),
		E.assistant({ ms: T0 + 2, calls: [{ id: "e1", name: "edit", args: { path: "a" } }, { id: "e2", name: "write", args: { path: "a" } }, { id: "c1", name: "bash", args: { command: "node --test test/1.mjs" } }] }),
		E.toolResult("c1", T0 + 3, { text: "1 failed" }),
		E.assistant({ ms: T0 + 4, calls: [{ id: "e3", name: "apply_patch", args: { input: "*** Update File: a\n" } }] }),
		E.assistant({ ms: T0 + 5, calls: [{ id: "c2", name: "bash", args: { command: "node --test test/2.mjs" } }] }),
		E.toolResult("c2", T0 + 6, { isError: true }), E.user("new direction", T0 + 7),
		E.assistant({ ms: T0 + 8, calls: [{ id: "e4", name: "edit", args: { path: "b" } }] })]);
	const tracker = new SessionTracker({ file });
	tracker.read(); tracker.advance(T0 + 6);
	const before = tracker.state.activity;
	assert.equal(before.toolCalls, 5);
	assert.equal(before.mutations, 3);
	assert.deepEqual([before.files.get("a").edits, before.files.get("a").rounds, before.files.get("a").failsBetween], [3, 2, 1]);
	assert.equal(before.failingChecks.get("node --test test/#.mjs"), 2);
	tracker.advance();
	assert.equal(tracker.state.firstUserText, "first request");
	assert.deepEqual(tracker.state.userTurns.map((t) => t.text), ["first request", "new direction"]);
	assert.equal(tracker.state.activity.sinceMs, T0 + 7);
	assert.equal(tracker.state.activity.toolCalls, 1);
	assert.deepEqual([...tracker.state.activity.files.keys()], ["b"]);
	assert.equal(tracker.state.activity.failingChecks.size, 0);
});

test("shell and eval mutations, task batches, and todo results", () => {
	const file = path.join(tmpDir(), "s.jsonl");
	writeJsonl(file, [E.header("s", "C:/p", T0), E.assistant({ ms: T0 + 1, calls: [
		{ id: "r", name: "bash", args: { command: "echo yes > output.txt" } },
		{ id: "m", name: "shell", args: { command: "mkdir stuff" } },
		{ id: "v", name: "eval", args: { code: "writeFile('a')", tool: { bash: "echo x > eval.txt" } } },
		{ id: "t1", name: "task", args: { task_summary: "one" } },
		{ id: "t2", name: "task", args: { tasks: [{ description: "two" }, { prompt: "three" }] } },
		{ id: "todo", name: "todo", args: {} },
	] }), E.toolResult("todo", T0 + 2, { text: "Overall: 1/3 done, 2 open\n- [ ] work A\n- work B [in_progress]" })]);
	const tracker = new SessionTracker({ file });
	tracker.read(); tracker.advance();
	const a = tracker.state.activity;
	assert.equal(a.toolCalls, 6);
	assert.equal(a.mutations, 3);
	assert.deepEqual([...a.files.keys()], ["output.txt", "eval.txt"]);
	assert.deepEqual(a.taskSpawns.map((v) => v.summary), ["one", "two", "three"]);
	assert.deepEqual(a.lastTodo, { open: 2, total: 3, openItems: ["work A", "work B"] });
});

test("the first automatic continuation after a user turn freezes the mutations that answered it", () => {
	const file = path.join(tmpDir(), "s.jsonl");
	const cm = (customType, ms) => ({ type: "custom_message", customType, content: "x", timestamp: new Date(ms).toISOString() });
	const edit = (id, ms) => E.assistant({ ms, calls: [{ id, name: "edit", args: { path: id } }] });
	writeJsonl(file, [E.header("s", "C:/p", T0), E.user("why?", T0), cm("environment-context", T0 + 500), cm("omo-memory:notice", T0 + 5000), edit("a", T0 + 6000),
		cm("goal-continuation", T0 + 60_000), edit("b", T0 + 61_000), cm("omo-senpi:wake", T0 + 90_000), edit("c", T0 + 91_000)]);
	const tracker = new SessionTracker({ file });
	tracker.read(); tracker.advance();
	assert.equal(tracker.state.activity.mutations, 3);
	assert.equal(tracker.state.activity.mutationsBeforeAuto, 1, "context entries do not count, the first continuation does");
	appendJsonl(file, [E.user("next", T0 + 120_000)]);
	tracker.read(); tracker.advance();
	assert.equal(tracker.state.activity.mutationsBeforeAuto, undefined, "a user turn starts over");
});

test("head read, capped lists, and persisted alignment seed", () => {
	const dir = tmpDir();
	const file = path.join(dir, "s.jsonl");
	const entries = [E.header("s", "C:/p", T0), E.user("x".repeat(1200), T0 + 1)];
	for (let i = 0; i < 55; i++) entries.push(E.assistant({ ms: T0 + 2 + i, calls: [{ id: `t${i}`, name: "task", args: { prompt: `job ${i}` } }] }));
	for (let i = 0; i < 205; i++) entries.push(E.assistant({ ms: T0 + 60 + i, calls: [{ id: `e${i}`, name: "edit", args: { path: `file${i}` } }] }));
	for (let i = 0; i < 25; i++) entries.push(E.user(`turn ${i}`, T0 + 300 + i));
	writeJsonl(file, entries);
	const align = path.join(dir, "alignment");
	fs.mkdirSync(align, { recursive: true });
	fs.writeFileSync(path.join(align, "s.json"), JSON.stringify({ activity: { sinceMs: T0, toolCalls: 17, mutations: 5 } }));
	const tail = new SessionTracker({ file, tailBytes: 400, alignmentDir: align });
	assert.equal(new SessionTracker({ file, tailBytes: 400 }).state.activity.toolCalls, 0, "no alignment dir -> no seed");
	assert.equal(tail.state.firstUserText.length, 1000);
	assert.equal(tail.state.activity.toolCalls, 17);
	const full = new SessionTracker({ file });
	full.read(); full.advance(T0 + 270);
	assert.equal(full.state.activity.files.size, 200);
	assert.equal(full.state.activity.taskSpawns.length, 50);
	full.advance();
	assert.equal(full.state.userTurns.length, 20);
	assert.equal(full.state.userTurns[0].text, "turn 5");
});

test("task store reader normalizes records, tolerates bad json, and links child files", () => {
	const cwd = tmpDir("omoh-proj-");
	const childFile = writeTask(
		cwd,
		{ task_id: "st_a", status: "running", residency_state: "resident", parent_session_id: "p1", root_session_id: "p1", execution_mode: "in-process", background_mode: "background", host_pid: 32552, child_session_id: "c1", created_at: "2026-09-23T14:20:50Z", spawn_spec: { version: 1, cwd, prompt: "x" } },
		[E.header("c1", cwd, T0)],
	);
	fs.writeFileSync(path.join(cwd, ".omo", "senpi-task", "tasks", "broken.json"), "{");
	const reader = createTaskStoreReader();
	const store = reader.read(cwd);
	assert.equal(store.tasks.length, 1);
	assert.equal(store.badRecords, 1);
	const task = store.tasks[0];
	assert.equal(task.hostPid, 32552);
	assert.equal(task.active, true);
	assert.equal(findChildSessionFile(task.storeDir, task.taskId, task.childSessionId), childFile);
	assert.equal(reader.read(cwd).tasks[0], task, "unchanged files are served from cache");
});

test("registry discovers main sessions and the children of their projects", () => {
	const root = tmpDir("omoh-reg-");
	const env = { OMO_HEALTH_OMO_HOME: path.join(root, "omo"), OMO_HEALTH_HOME: path.join(root, "health"), USERPROFILE: root };
	const paths = resolvePaths(env);
	const project = path.join(root, "proj");
	fs.mkdirSync(project);
	const mainFile = path.join(paths.sessionsDir, "--C--proj--", "2026-09-23T14-00-00-000Z_p1.jsonl");
	writeJsonl(mainFile, [E.header("p1", project, T0 - 3600_000), E.assistant({ ms: T0 - 60_000, calls: [{ id: "tk", name: "task", args: { prompt: "x" } }] })]);
	writeTask(
		project,
		{ task_id: "st_b", status: "running", parent_session_id: "p1", root_session_id: "p1", execution_mode: "in-process", background_mode: "foreground", host_pid: 4242, child_session_id: "c2", created_at: "2026-09-23T15:00:00Z", spawn_spec: { version: 1, cwd: project } },
		[E.header("c2", project, T0 - 1000), E.assistant({ ms: T0, calls: [{ id: "g", name: "bash", args: { command: "grep x" } }] })],
	);
	const clock = createFakeClock(Date.now());
	const registry = new SessionRegistry({ paths, config: DEFAULT_CONFIG, clock });
	const snap = registry.refresh({ sensors: new Map() });
	const main = snap.sessions.get("p1");
	const child = snap.sessions.get("c2");
	assert.equal(main.kind, "main");
	assert.equal(main.pending.get("tk").name, "task");
	assert.equal(child.kind, "child");
	assert.equal(child.taskId, "st_b");
	assert.equal(child.hostPid, 4242);
	assert.equal(child.parentSessionId, "p1");
	assert.equal(child.pending.get("g").args.command, "grep x");
});

test("registry discovers children in the agent projects store when the project has no local store", () => {
	const root = tmpDir("omoh-proj-store-");
	const env = { OMO_HEALTH_OMO_HOME: path.join(root, "omo"), OMO_HEALTH_HOME: path.join(root, "health"), USERPROFILE: root };
	const paths = resolvePaths(env);
	const project = path.join(root, "proj");
	fs.mkdirSync(project);
	writeJsonl(path.join(paths.sessionsDir, "--proj--", "2026_p1.jsonl"), [E.header("p1", project, T0)]);
	const projectStore = senpiTaskStoreDir(project, paths.agentDir);
	assert.equal(fs.existsSync(path.join(project, ".omo", "senpi-task")), false, "the project has no local store");
	writeTask(
		project,
		{ task_id: "st_proj", status: "running", parent_session_id: "p1", root_session_id: "p1", host_pid: 7, child_session_id: "cproj", created_at: "2026-09-23T15:00:00Z", spawn_spec: { version: 1, cwd: project } },
		[E.header("cproj", project, T0)],
		{ storeDir: projectStore },
	);
	const registry = new SessionRegistry({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(Date.now()) });
	const snap = registry.refresh({ sensors: new Map() });
	const child = snap.sessions.get("cproj");
	assert.equal(child.kind, "child");
	assert.equal(child.taskId, "st_proj");
	assert.equal(child.parentSessionId, "p1");
	assert.equal(child.task.storeDir, projectStore);
});

test("a local store with records still wins over the projects store", () => {
	const root = tmpDir("omoh-local-wins-");
	const env = { OMO_HEALTH_OMO_HOME: path.join(root, "omo"), OMO_HEALTH_HOME: path.join(root, "health"), USERPROFILE: root };
	const paths = resolvePaths(env);
	const project = path.join(root, "proj");
	fs.mkdirSync(project);
	writeJsonl(path.join(paths.sessionsDir, "--proj--", "2026_p1.jsonl"), [E.header("p1", project, T0)]);
	const localStore = path.join(project, ".omo", "senpi-task");
	const projectStore = senpiTaskStoreDir(project, paths.agentDir);
	writeTask(project, { task_id: "st_local", status: "running", parent_session_id: "p1", host_pid: 1, child_session_id: "clocal", created_at: "2026-09-23T15:00:00Z", spawn_spec: { cwd: project } }, [E.header("clocal", project, T0)]);
	writeTask(project, { task_id: "st_remote", status: "running", parent_session_id: "p1", host_pid: 2, child_session_id: "cremote", created_at: "2026-09-23T15:00:00Z", spawn_spec: { cwd: project } }, [E.header("cremote", project, T0)], { storeDir: projectStore });
	const inner = createTaskStoreReader();
	let requested;
	const taskReader = { read: (cwd, storeDir) => { requested = storeDir; return inner.read(cwd, storeDir); } };
	const registry = new SessionRegistry({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(Date.now()), taskReader });
	const snap = registry.refresh({ sensors: new Map() });
	assert.equal(requested, localStore, "records exist locally, so the local store is the one read");
	assert.equal(snap.sessions.get("clocal").kind, "child");
	assert.equal(snap.sessions.get("cremote"), undefined, "the projects store is not merged in when the local store holds records");
});

test("task ids that collide across project stores stay separate (keyed by store + id)", () => {
	const root = tmpDir("omoh-collide-");
	const env = { OMO_HEALTH_OMO_HOME: path.join(root, "omo"), OMO_HEALTH_HOME: path.join(root, "health"), USERPROFILE: root };
	const paths = resolvePaths(env);
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	writeJsonl(path.join(paths.sessionsDir, "--a--", "2026_pa.jsonl"), [E.header("pa", a, T0)]);
	writeJsonl(path.join(paths.sessionsDir, "--b--", "2026_pb.jsonl"), [E.header("pb", b, T0)]);
	writeTask(a, { task_id: "st_01a0d024", status: "running", parent_session_id: "pa", host_pid: 1, child_session_id: "ca", created_at: "2026-09-23T15:00:00Z", spawn_spec: { cwd: a } }, [E.header("ca", a, T0)]);
	writeTask(b, { task_id: "st_01a0d024", status: "running", parent_session_id: "pb", host_pid: 2, child_session_id: "cb", created_at: "2026-09-23T15:00:00Z", spawn_spec: { cwd: b } }, [E.header("cb", b, T0)]);
	const registry = new SessionRegistry({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(Date.now()) });
	const snap = registry.refresh({ sensors: new Map() });
	assert.equal(snap.sessions.get("ca").parentSessionId, "pa");
	assert.equal(snap.sessions.get("cb").parentSessionId, "pb");
	assert.equal(snap.sessions.get("ca").hostPid, 1);
	assert.equal(snap.sessions.get("cb").hostPid, 2);
});


test("extension state records move lastEntryMs but not lastActivityMs", () => {
	const file = path.join(tmpDir(), "s.jsonl");
	const t0 = Date.parse("2026-09-23T15:47:15.155Z");
	writeJsonl(file, [
		E.header("m", "C:/p", t0 - 60_000),
		E.custom("goal-continuation", t0 - 1),
		E.assistant({ ms: t0, stopReason: "error", errorMessage: "Provider is not configured: anthropic-subscription" }),
		{ type: "custom", customType: "senpi.hooks.stop-state", id: "h1", timestamp: new Date(t0 + 9).toISOString(), data: { count: 0 } },
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.lastActivityMs, t0);
	assert.equal(tracker.state.lastEntryMs, t0 + 9);
});

test("checks run inside eval cells count as failing by their reported exit code, keyed by the cell summary", () => {
	const file = path.join(tmpDir(), "s.jsonl");
	const run = (i, ms, out) => [
		E.assistant({ ms, calls: [{ id: `e${i}`, name: "edit", args: { path: "notes.txt" } }, { id: `c${i}`, name: "eval", args: { language: "js", summary: `${i}회차: node --test missing.test.mjs 실행`, code: "spawnSync('node', ['--test', 'missing.test.mjs'])" } }] }),
		E.toolResult(`c${i}`, ms + 1, { text: out }),
	];
	writeJsonl(file, [E.header("s", "C:/p", T0), E.user("go", T0 + 1),
		...run(1, T0 + 10, '{"exit":1,"out":"Could not find \'missing.test.mjs\'"}'),
		...run(2, T0 + 20, "tests failed\n\nCommand exited with code 1"),
		...run(3, T0 + 30, '{"exit":0,"out":"ℹ pass 3\\nℹ fail 0"}'),
		E.assistant({ ms: T0 + 40, calls: [{ id: "h1", name: "eval", args: { summary: "run npm test for the api", code: "await fetch(url)" } }] }),
		E.toolResult("h1", T0 + 41, { text: '{"status":404,"body":"not found"}' })]);
	const tracker = new SessionTracker({ file });
	tracker.read(); tracker.advance();
	const activity = tracker.state.activity;
	assert.equal(activity.failingChecks.get("#회차: node --test missing.test.mjs 실행"), 2);
	assert.equal(activity.failingChecks.has("run npm test for the api"), false);
	assert.equal(activity.files.get("notes.txt").failsBetween, 2);
});

test("child completions and monitor notifications become progress steps", () => {
	const file = path.join(tmpDir(), "2026_progress.jsonl");
	const completion = { ...E.custom("senpi-task.completion", T0 + 1000), content: "task completion name:worker id:st_x status:completed\nresult: done" };
	const notification = { ...E.custom("senpi-monitor:notification", T0 + 2000), content: "<system-reminder>Monitor event(watch): STARTED\nwatcher completed</system-reminder>" };
	const undated = { ...E.custom("senpi-monitor:notification", T0 + 2500), timestamp: undefined, content: "Monitor event(watch): STARTED" };
	writeJsonl(file, [E.header("progress", "C:/dev/x", T0), completion, notification, undated, E.custom("pi-rules.scan", T0 + 3000)]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.steps.filter((step) => step.kind === "progress").map(({ ms, tool, text }) => [ms - T0, tool, text]), [
		[1000, "senpi-task.completion", "task completion name:worker id:st_x status:completed"],
		[2000, "senpi-monitor:notification", "<system-reminder>Monitor event(watch): STARTED"],
	]);
	assert.equal(tracker.state.steps.filter((step) => step.kind === "progress" && !Number.isFinite(step.ms)).length, 0, "a custom entry without a timestamp adds no progress step");
});

test("omo-health and omo-desk notifications are not progress steps", () => {
	const file = path.join(tmpDir(), "2026_nudge-progress.jsonl");
	writeJsonl(file, [
		E.header("nudges", "C:/dev/x", T0),
		{ ...E.custom("omo-health:notification", T0 + 1000), content: "health inbox: session looks stuck" },
		{ ...E.custom("omo-desk:notification", T0 + 2000), content: "desk reply: please review" },
		{ ...E.custom("senpi-monitor:notification", T0 + 3000), content: "Monitor event(watch): STARTED" },
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.steps.filter((step) => step.kind === "progress").map(({ tool }) => tool), ["senpi-monitor:notification"]);
});

test("task spawn steps carry the subagent type", () => {
	const file = path.join(tmpDir(), "2026_task-agent.jsonl");
	writeJsonl(file, [E.header("agents", "C:/dev/x", T0), E.assistant({ ms: T0 + 1000, calls: [{ id: "t1", name: "task", args: { tasks: [{ task_summary: "Review the parser diff", subagent_type: "reviewer" }, { description: "Second reviewer" }] } }] })]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.steps.filter((step) => step.tool === "task").map(({ text, agent }) => [text, agent]), [
		["Review the parser diff", "reviewer"],
		["Second reviewer", null],
	]);
	assert.deepEqual(tracker.state.activity.taskSpawns.map(({ summary, agent }) => [summary, agent]), [
		["Review the parser diff", "reviewer"],
		["Second reviewer", null],
	]);
});

test("the step ledger keeps eval summaries, todo transitions, task summaries and goal text across user turns", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_steps.jsonl");
	const call = (id, name, args, ms) => E.assistant({ ms, calls: [{ id, name, args }] });
	writeJsonl(file, [
		E.header("steps", "C:\\dev\\x", T0),
		E.user("go", T0 + 1000),
		call("g", "create_goal", { objective: "Ship the parser fix" }, T0 + 2000),
		call("i", "todo", { op: "init", list: [{ phase: "P", items: ["Fix X", "Verify X"] }] }, T0 + 3000),
		call("s1", "todo", { op: "start", task: "Fix X" }, T0 + 4000),
		call("e1", "eval", { language: "js", summary: "Run node --test (3 failing)", code: "1" }, T0 + 5000),
		call("e0", "eval", { language: "js", code: "no summary, no step" }, T0 + 5500),
		E.user("", T0 + 6000),
		call("t1", "task", { tasks: [{ task_summary: "Review the parser diff" }, { description: "Second reviewer" }] }, T0 + 7000),
		call("d1", "todo", { op: "done" }, T0 + 8000),
		call("s2", "todo", { op: "start", task: "Fix X" }, T0 + 9000),
		call("d2", "todo", { op: "done", task: "Verify X" }, T0 + 10_000),
		call("v", "todo", { op: "view" }, T0 + 11_000),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.steps.map(({ ms, tool, kind, text }) => [ms - T0, tool, kind, text]), [
		[2000, "create_goal", "goal", "Ship the parser fix"],
		[3000, "todo", "plan", "Fix X; Verify X"],
		[4000, "todo", "start", "Fix X"],
		[5000, "eval", "eval", "Run node --test (3 failing)"],
		[7000, "task", "task", "Review the parser diff"],
		[7000, "task", "task", "Second reviewer"],
		[8000, "todo", "done", "Fix X"],
		[9000, "todo", "reopen", "Fix X"],
		[10_000, "todo", "done", "Verify X"],
	]);
	assert.equal(tracker.state.activity.toolCalls, 5, "the per-turn counters still reset on a user turn");
});

test("the step ledger is capped and skips entries without a timestamp", () => {
	const dir = tmpDir();
	const file = path.join(dir, "2026_cap.jsonl");
	const entries = [E.header("cap", "C:\\dev\\x", T0)];
	for (let i = 0; i < 260; i++) entries.push(E.assistant({ ms: T0 + i * 1000, calls: [{ id: `e${i}`, name: "eval", args: { summary: `step ${i}` } }] }));
	writeJsonl(file, entries);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.equal(tracker.state.steps.length, 200);
	assert.equal(tracker.state.steps[0].text, "step 60");
	assert.equal(tracker.state.steps.at(-1).text, "step 259");
});

test("a todo `done` whose result promotes the next task opens it in the step ledger without a `start` call (#82, D15)", () => {
	const file = path.join(tmpDir(), "2026_promote.jsonl");
	const call = (id, args, ms) => E.assistant({ ms, calls: [{ id, name: "todo", args }] });
	const result = (id, ms, text) => E.toolResult(id, ms, { name: "todo", text });
	// Result shapes as the todo tool writes them (session JSONL of 2026-09-24 and 2026-09-28).
	const promoting = (now, next, phase) => `Ask: check\nNow: ${next} (${phase})\nNext: Later (${phase})\n\nRemaining items (3):\n  - ${next} [in_progress] (${phase})\n  - Later [pending] (${phase})\nOverall: 1/3 done, 2 open\n  ${phase}:\n    - [X] ${now}\n    - [ ] ${next} (in progress)\n    - [ ] Later`;
	const lastDone = "Remaining items (0):\nOverall: 3/3 done, 0 open.\n  Phase:\n    - [X] Later (Phase)";
	writeJsonl(file, [
		E.header("promote", "C:/dev/x", T0),
		E.user("go", T0 + 1000),
		call("i", { op: "init", list: [{ phase: "P", items: ["Fix X", "Verify X (deep)", "Later"] }] }, T0 + 2000),
		result("i", T0 + 2100, "Overall: 0/3 done, 3 open"),
		call("s1", { op: "start", task: "Fix X" }, T0 + 3000),
		result("s1", T0 + 3100, "Now: Fix X (P)\nRemaining items (3):\n  - Fix X [in_progress] (P)"),
		call("d1", { op: "done", task: "Fix X" }, T0 + 4000),
		result("d1", T0 + 4100, promoting("Fix X", "Verify X (deep)", "P")),
		// A `done` of some other todo while the promoted one stays in progress opens nothing new.
		call("d2", { op: "done", task: "Later" }, T0 + 5000),
		result("d2", T0 + 5100, "Remaining items (1):\n  - Verify X (deep) [in_progress] (P)\nOverall: 2/3 done, 1 open."),
		call("d3", { op: "done", task: "Verify X (deep)" }, T0 + 6000),
		result("d3", T0 + 6100, lastDone),
		// A failed `done` records the call but opens nothing.
		call("d4", { op: "done", task: "Ghost" }, T0 + 7000),
		E.toolResult("d4", T0 + 7100, { name: "todo", text: "- Ghost [in_progress] (P)", isError: true }),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	assert.deepEqual(tracker.state.steps.filter((step) => step.tool === "todo").map(({ ms, kind, text }) => [ms - T0, kind, text]), [
		[2000, "plan", "Fix X; Verify X (deep); Later"],
		[3000, "start", "Fix X"],
		[4000, "done", "Fix X"],
		[4100, "start", "Verify X (deep)"],
		[5000, "done", "Later"],
		[6000, "done", "Verify X (deep)"],
		[7000, "done", "Ghost"],
	]);
});

test("collector head fields are redacted before they are cut, so a cut token cannot slip under the pattern (#82 round 2)", () => {
	const dir = tmpDir();
	const file = path.join(dir, "leak.jsonl");
	const leak = (max) => `${"a".repeat(max - 10)}sk-ant-${"Z".repeat(40)}`;
	writeJsonl(file, [
		E.header("leak", "C:/p", T0),
		E.user(leak(300), T0 + 1),
		E.assistant({ ms: T0 + 1.5, stopReason: "error", errorMessage: leak(300) }),
		E.assistant({ ms: T0 + 2, text: leak(600), calls: [{ id: "c1", name: "bash", args: { command: leak(4000) } }, { id: "c2", name: "eval", args: { summary: leak(160) } }, { id: "c3", name: "bash", args: { command: "true" } }] }),
		E.toolResult("c1", T0 + 3, { text: leak(120), isError: true }),
	]);
	const tracker = new SessionTracker({ file });
	tracker.read();
	tracker.advance();
	const s = tracker.state;
	const fields = {
		firstUserText: s.firstUserText,
		userTurn: s.userTurns[0].text,
		lastUser: s.lastUser.textHead,
		assistantHead: s.lastAssistant.textHead,
		command: s.commands[0].text,
		step: s.steps[0].text,
		resultHead: s.resolved.get("c1").textHead,
		errHead: s.toolHistory.find((h) => h.id === "c1").errHead,
		errorText: s.errors[0].text,
	};
	for (const [name, value] of Object.entries(fields)) {
		assert.ok(typeof value === "string" && value.startsWith("aaaa"), `${name} is collected`);
		assert.doesNotMatch(value, /sk-ant-[A-Za-z0-9]/, name);
	}
	// A live tail that starts mid-file reads the first request from the file head.
	assert.doesNotMatch(new SessionTracker({ file, tailBytes: 400 }).state.firstUserText, /sk-ant-[A-Za-z0-9]/, "head read");
});
