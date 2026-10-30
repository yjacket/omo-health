import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createWorkReader } from "../src/collect/work.mjs";
import { projectStoreName, readRunEvents } from "../src/collect/tasks.mjs";
import { iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";

const T0 = Date.parse("2026-10-10T10:00:00Z");

function setup() {
	const root = tmpDir("omoh-work-");
	const cwd = path.join(root, "proj");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".omo", "senpi-task", "tasks"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const session = { id: "s1", cwd, file: path.join(root, "sessions", "2026-10-10T09-00-00-000Z_s1.jsonl") };
	fs.mkdirSync(path.dirname(session.file), { recursive: true });
	return { root, cwd, agentDir, store: path.join(cwd, ".omo", "senpi-task"), session };
}

function writeTaskRecord(store, raw) {
	fs.mkdirSync(path.join(store, "tasks"), { recursive: true });
	fs.writeFileSync(path.join(store, "tasks", `${raw.task_id}.json`), JSON.stringify(raw));
}

function writeRun(store, run) {
	const dir = path.join(store, "dag", "runs");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run));
}

function writeEventsFile(store, runId, text) {
	const dir = path.join(store, "dag", "events");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${runId}.jsonl`);
	fs.writeFileSync(file, text);
	return file;
}

function setMtime(file, ms) {
	fs.utimesSync(file, new Date(ms), new Date(ms));
}

function writeArtifact(file, ms) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "log\n");
	setMtime(file, ms);
}

test("own tasks only, with child and eval-log progress for active tasks", () => {
	const ctx = setup();
	const { store, session } = ctx;
	writeTaskRecord(store, {
		task_id: "own",
		status: "running",
		residency_state: "resident",
		parent_session_id: "s1",
		root_session_id: "s1",
		child_session_id: "c1",
		name: "own task",
		task_summary: "the one we want",
		created_at: iso(T0),
		updated_at: iso(T0 + 20_000),
		host_pid: 111,
		pid: 222,
		owner: { kind: "dag", runId: "dag_1", nodeId: "n1", fingerprint: "f" },
	});
	writeTaskRecord(store, {
		task_id: "foreign",
		status: "running",
		parent_session_id: "other",
		child_session_id: "c9",
		updated_at: iso(T0 + 90_000),
	});
	writeTaskRecord(store, {
		task_id: "done",
		status: "completed",
		parent_session_id: "s1",
		child_session_id: "c2",
		created_at: iso(T0),
		updated_at: iso(T0 + 25_000),
		terminal_at: iso(T0 + 25_000),
	});

	const childFile = path.join(store, "children", "own", "sessions", "own", "2026-10-10T09-00-00-000Z_c1.jsonl");
	writeJsonl(childFile, [{ type: "session", id: "c1", cwd: "C:\\proj", timestamp: iso(T0) }]);
	setMtime(childFile, T0 + 30_000);
	const artifacts = childFile.replace(/\.jsonl$/, "") + "-artifacts";
	writeArtifact(path.join(artifacts, "eval-a.log"), T0 + 40_000);
	writeArtifact(path.join(artifacts, "local", "detached-eval-b.log"), T0 + 50_000);
	writeArtifact(path.join(artifacts, "local", "other.log"), T0 + 60_000);

	const doneChild = path.join(store, "children", "done", "sessions", "done", "2026-10-10T09-00-00-000Z_c2.jsonl");
	writeJsonl(doneChild, [{ type: "session", id: "c2", cwd: "C:\\proj", timestamp: iso(T0) }]);
	setMtime(doneChild, T0 + 80_000);

	fs.writeFileSync(session.file, "");
	writeArtifact(session.file.replace(/\.jsonl$/, "") + "-artifacts/eval-main.log", T0 + 55_000);

	const work = createWorkReader().read({ session, agentDir: ctx.agentDir, now: T0 + 60_000 });
	assert.equal(work.storeReadable, true);
	assert.equal(work.runsReadable, false);
	assert.deepEqual(work.runs, []);
	assert.deepEqual(work.tasks.map((task) => task.taskId).sort(), ["done", "own"]);

	const own = work.tasks.find((task) => task.taskId === "own");
	assert.equal(own.active, true);
	assert.equal(own.terminal, false);
	assert.equal(own.status, "running");
	assert.equal(own.residency, "resident");
	assert.equal(own.summary, "the one we want");
	assert.equal(own.hostPid, 111);
	assert.equal(own.pid, 222);
	assert.equal(own.childSessionId, "c1");
	assert.deepEqual(own.owner, { runId: "dag_1", nodeId: "n1" });
	assert.equal(own.childFile, childFile);
	assert.equal(own.childMtimeMs, T0 + 30_000);
	assert.equal(own.artifactsMtimeMs, T0 + 50_000);
	assert.equal(own.lastProgressMs, T0 + 50_000);

	const done = work.tasks.find((task) => task.taskId === "done");
	assert.equal(done.active, false);
	assert.equal(done.childFile, undefined);
	assert.equal(done.childMtimeMs, undefined);
	assert.equal(done.artifactsMtimeMs, undefined);
	assert.equal(done.owner ?? null, null);
	assert.equal(done.lastProgressMs, T0 + 25_000);

	assert.equal(work.evalLogs.dir, session.file.replace(/\.jsonl$/, "") + "-artifacts");
	assert.equal(work.evalLogs.newestMtimeMs, T0 + 55_000);
	assert.equal(work.evalLogs.count, 1);
});

test("runs carry node states, counts and the last event time from the events file", () => {
	const ctx = setup();
	const { store } = ctx;
	writeRun(store, {
		runId: "dag_own",
		name: "own run",
		status: "running",
		parentSessionId: "s1",
		rootSessionId: "root",
		createdAt: iso(T0),
		updatedAt: iso(T0 + 1000),
		nodes: [
			{ id: "a", state: "completed", attempt: 1, taskId: "st_a", startedAt: iso(T0 + 1000), completedAt: iso(T0 + 5000) },
			{ id: "b", state: "running", attempt: 2, taskId: "st_b", startedAt: iso(T0 + 2000), lastActivityAt: iso(T0 + 40_000) },
			{ id: "c", state: "scheduled", attempt: 1 },
			{ id: "d", state: "blocked", attempt: 1 },
			{ id: "e", state: "pending", attempt: 1 },
			{ id: "f", state: "failed", attempt: 1, completedAt: iso(T0 + 6000) },
			{ id: "g", state: "skipped", attempt: 1 },
			{ id: "h", state: "cancelled", attempt: 1 },
		],
	});
	writeEventsFile(store, "dag_own", [
		{ schemaVersion: 1, runId: "dag_own", seq: 1, at: iso(T0 + 10_000), type: "dag.wave.started" },
		{ schemaVersion: 1, runId: "dag_own", seq: 2, at: iso(T0 + 50_000), type: "dag.node.transitioned" },
	].map((event) => JSON.stringify(event)).join("\n") + "\n");

	writeRun(store, {
		runId: "dag_root",
		name: "root match",
		status: "completed",
		parentSessionId: "someone-else",
		rootSessionId: "s1",
		createdAt: iso(T0),
		updatedAt: iso(T0 + 7000),
		completedAt: iso(T0 + 7000),
		nodes: [{ id: "x", state: "completed", attempt: 1, startedAt: iso(T0), completedAt: iso(T0 + 7000) }],
	});
	writeRun(store, {
		runId: "dag_no_events",
		name: "no events yet",
		status: "pending",
		parentSessionId: "s1",
		rootSessionId: "s1",
		createdAt: iso(T0),
		updatedAt: iso(T0 + 1000),
		nodes: [{ id: "w", state: "pending", attempt: 1, startedAt: iso(T0 + 5000) }],
	});
	writeRun(store, {
		runId: "dag_foreign",
		name: "foreign",
		status: "running",
		parentSessionId: "other",
		rootSessionId: "other",
		nodes: [],
	});

	const work = createWorkReader().read({ session: ctx.session, agentDir: ctx.agentDir, now: T0 + 60_000 });
	assert.equal(work.runsReadable, true);
	assert.deepEqual(work.runs.map((run) => run.runId).sort(), ["dag_no_events", "dag_own", "dag_root"]);

	const own = work.runs.find((run) => run.runId === "dag_own");
	assert.equal(own.name, "own run");
	assert.equal(own.status, "running");
	assert.equal(own.settled, false);
	assert.equal(own.parentSessionId, "s1");
	assert.equal(own.rootSessionId, "root");
	assert.equal(own.createdAtMs, T0);
	assert.equal(own.updatedAtMs, T0 + 1000);
	assert.equal(own.lastEventAtMs, T0 + 50_000);
	assert.equal(own.lastEventType, "dag.node.transitioned");
	assert.equal(own.lastProgressMs, T0 + 50_000);
	assert.deepEqual(own.counts, { total: 8, completed: 1, running: 2, pending: 2, ended: 3 });
	assert.deepEqual(own.nodes[0], {
		id: "a",
		state: "completed",
		attempt: 1,
		taskId: "st_a",
		startedAtMs: T0 + 1000,
		completedAtMs: T0 + 5000,
		lastActivityAtMs: undefined,
	});
	assert.equal(own.nodes[1].lastActivityAtMs, T0 + 40_000);
	assert.equal(own.nodes[2].startedAtMs, undefined);

	const root = work.runs.find((run) => run.runId === "dag_root");
	assert.equal(root.settled, true);
	assert.equal(root.lastEventAtMs, T0 + 7000);
	assert.equal(root.lastEventType, undefined);

	const bare = work.runs.find((run) => run.runId === "dag_no_events");
	assert.equal(bare.lastEventAtMs, undefined);
	assert.equal(bare.lastEventType, undefined);
	assert.equal(bare.lastProgressMs, T0 + 5000);
});

test("a half-written last events line falls back to the previous complete line", () => {
	const ctx = setup();
	const partial = JSON.stringify({ at: iso(T0 + 30_000), type: "third" });
	writeEventsFile(ctx.store, "dag_half", [
		JSON.stringify({ at: iso(T0 + 10_000), type: "first" }),
		JSON.stringify({ at: iso(T0 + 20_000), type: "second" }),
	].join("\n") + "\n" + partial);

	const events = readRunEvents(ctx.store, "dag_half");
	assert.equal(events.lastEventAtMs, T0 + 20_000);
	assert.equal(events.lastEventType, "second");
});

test("settled runs read no events file", () => {
	const ctx = setup();
	writeRun(ctx.store, {
		runId: "dag_done",
		name: "finished",
		status: "completed",
		parentSessionId: "s1",
		rootSessionId: "s1",
		createdAt: iso(T0),
		updatedAt: iso(T0 + 10_000),
		completedAt: iso(T0 + 20_000),
		nodes: [{ id: "a", state: "completed", attempt: 1, startedAt: iso(T0), completedAt: iso(T0 + 20_000) }],
	});
	writeEventsFile(ctx.store, "dag_done", `${JSON.stringify({ at: iso(T0 + 900_000), type: "late.event" })}\n`);

	const work = createWorkReader().read({ session: ctx.session, agentDir: ctx.agentDir, now: T0 + 1_000_000 });
	assert.equal(work.runs.length, 1);
	assert.equal(work.runs[0].settled, true);
	assert.equal(work.runs[0].lastEventAtMs, T0 + 20_000);
	assert.equal(work.runs[0].lastEventType, undefined);
});

test("a run paused by the user's Stop carries its pause reason", () => {
	const ctx = setup();
	const base = { name: "w", parentSessionId: "s1", rootSessionId: "s1", createdAt: iso(T0), updatedAt: iso(T0), nodes: [{ id: "a", state: "paused", attempt: 1 }] };
	writeRun(ctx.store, { ...base, runId: "dag_stopped", status: "paused", pause: { reason: "user_stop", pauseSeq: 3 } });
	writeRun(ctx.store, { ...base, runId: "dag_old", status: "paused" });
	const work = createWorkReader().read({ session: ctx.session, agentDir: ctx.agentDir, now: T0 });
	const byId = Object.fromEntries(work.runs.map((run) => [run.runId, run]));
	assert.equal(byId.dag_stopped.pauseReason, "user_stop");
	assert.equal(byId.dag_old.pauseReason, undefined);
});

test("a missing store is unreadable and empty", () => {
	const ctx = setup();
	fs.rmSync(path.join(ctx.cwd, ".omo"), { recursive: true, force: true });
	const work = createWorkReader().read({ session: ctx.session, agentDir: ctx.agentDir, now: T0 });
	assert.equal(work.storeReadable, false);
	assert.equal(work.runsReadable, false);
	assert.deepEqual(work.tasks, []);
	assert.deepEqual(work.runs, []);
	assert.equal(work.storeDir, path.join(ctx.agentDir, "projects", projectStoreName(ctx.cwd), "senpi-task"));
	assert.equal(work.evalLogs.dir, ctx.session.file.replace(/\.jsonl$/, "") + "-artifacts");
	assert.equal(work.evalLogs.count, 0);
});

test("a malformed task record makes the store unreadable", () => {
	const ctx = setup();
	writeTaskRecord(ctx.store, { task_id: "good", status: "running", parent_session_id: "s1" });
	fs.writeFileSync(path.join(ctx.store, "tasks", "bad.json"), "{not json");
	const work = createWorkReader().read({ session: ctx.session, agentDir: ctx.agentDir, now: T0 });
	assert.equal(work.storeReadable, false);
	assert.deepEqual(work.tasks.map((task) => task.taskId), ["good"]);
});

test("event reads are cached until the events file changes", () => {
	const ctx = setup();
	const file = writeEventsFile(ctx.store, "dag_cache", `${JSON.stringify({ at: iso(T0 + 10_000), type: "one" })}\n`);
	setMtime(file, T0);
	assert.equal(readRunEvents(ctx.store, "dag_cache").lastEventType, "one");

	fs.writeFileSync(file, `${JSON.stringify({ at: iso(T0 + 10_000), type: "two" })}\n`);
	setMtime(file, T0);
	assert.equal(readRunEvents(ctx.store, "dag_cache").lastEventType, "one");

	fs.appendFileSync(file, `${JSON.stringify({ at: iso(T0 + 20_000), type: "three" })}\n`);
	assert.equal(readRunEvents(ctx.store, "dag_cache").lastEventType, "three");
});
