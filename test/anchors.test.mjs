import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readGoal, readUlwGoals } from "../src/collect/anchors.mjs";
import { SessionRegistry } from "../src/collect/sessions.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { E, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const NOW = Date.now();

test("goal extension timestamps and ulw goal list are read from their stores", () => {
	const cwd = tmpDir();
	const file = path.join(cwd, "sessions", "s.jsonl");
	const goal = path.join(cwd, "sessions", "extensions", "goal", "s.json");
	const ulw = path.join(cwd, ".omo", "ulw-loop", "s", "goals.json");
	fs.mkdirSync(path.dirname(goal), { recursive: true });
	fs.mkdirSync(path.dirname(ulw), { recursive: true });
	fs.writeFileSync(goal, JSON.stringify({ version: 1, goal: { objective: "Ship feature", status: "active", updatedAt: NOW / 1000 } }));
	fs.writeFileSync(ulw, JSON.stringify({ goals: [{ id: "a", title: "A", status: "complete", evidence: "ignored" }] }));
	assert.deepEqual(readGoal(file, "s"), { objective: "Ship feature", status: "active", updatedAtMs: NOW });
	assert.deepEqual(readUlwGoals(cwd, "s"), [{ id: "a", title: "A", status: "complete" }]);
	fs.writeFileSync(goal, JSON.stringify({ goal: { objective: "changed", status: "done" } }));
	assert.equal(readGoal(file, "s").objective, "Ship feature", "mtime checks are throttled to one per minute");
	assert.deepEqual(readUlwGoals(cwd, "missing"), []);
});

test("registry anchors child to task summary before the parent's goal", () => {
	const cwd = tmpDir();
	const sessionsDir = path.join(cwd, "sessions");
	const main = path.join(sessionsDir, "project", "main.jsonl");
	writeJsonl(main, [E.header("parent", cwd, NOW)]);
	const child = writeTask(cwd, { task_id: "t", status: "running", child_session_id: "child", parent_session_id: "parent", created_at: new Date(NOW).toISOString(), task_summary: "Implement the request", spawn_spec: { cwd } }, [E.header("child", cwd, NOW)]);
	const goal = path.join(path.dirname(main), "extensions", "goal", "parent.json");
	fs.mkdirSync(path.dirname(goal), { recursive: true });
	fs.writeFileSync(goal, JSON.stringify({ goal: { objective: "Parent objective", status: "active", updatedAt: NOW / 1000 } }));
	const registry = new SessionRegistry({ paths: { sessionsDir }, clock: createFakeClock(NOW), scanWindow: { fromMs: NOW - 1000, toMs: NOW + 1000 } });
	const snap = registry.refresh({ sensors: new Map() });
	assert.deepEqual(snap.sessions.get("parent").anchor, { objective: "Parent objective", status: "active", source: "goal" });
	assert.deepEqual(snap.sessions.get("child").anchor, { objective: "Implement the request", status: "running", source: "task" });
	assert.ok(child);
});
