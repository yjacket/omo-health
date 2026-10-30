import "./helpers/tmp-root.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers/fixtures.mjs";
import { readDagRuns, readHostExits, removeHeartbeat } from "../src/collect/crashes.mjs";
import { senpiTaskStoreDir } from "../src/collect/tasks.mjs";

function setup() {
	const root = tmpDir("crash-collect-");
	const paths = { health: { sensorsDir: path.join(root, "sensors") }, agentDir: path.join(root, "agent") };
	fs.mkdirSync(paths.health.sensorsDir, { recursive: true });
	fs.mkdirSync(paths.agentDir, { recursive: true });
	return { root, paths };
}

function putJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

test("reads valid heartbeats, skips malformed entries, and limits to newest files", () => {
	const { paths } = setup();
	const dir = paths.health.sensorsDir;
	putJson(path.join(dir, "old.json"), { sessionId: "old", pid: 1, ts: 1 });
	putJson(path.join(dir, "new.json"), { sessionId: "new", pid: 2, ts: 2 });
	fs.writeFileSync(path.join(dir, "bad.json"), "{");
	putJson(path.join(dir, "no-session.json"), { pid: 3, ts: 3 });
	fs.utimesSync(path.join(dir, "old.json"), new Date(1000), new Date(1000));
	fs.utimesSync(path.join(dir, "new.json"), new Date(2000), new Date(2000));
	const result = readHostExits(paths, { maxFiles: 1 });
	assert.equal(result.heartbeats.length, 1);
	assert.equal(result.heartbeats[0].hb.sessionId, "new");
});

test("parses crash records and computes started timestamps", () => {
	const { paths } = setup();
	const file = path.join(paths.agentDir, "process-crashes", "crashes.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, [
		"garbage",
		JSON.stringify({ at: "2026-09-29T11:50:25.542Z", kind: "interactive", detection: "unclean_exit", uptimeMs: 600051 }),
		JSON.stringify({ at: "2026-09-29T12:03:20.610Z", kind: "interactive", detection: "unclean_exit", uptimeMs: 1080248 }),
	].join("\n"));
	const records = readHostExits(paths).crashRecords;
	assert.equal(records.length, 2);
	assert.equal(records[0].startedMs, Date.parse("2026-09-29T11:40:25.491Z"));
	assert.equal(records[1].startedMs, Date.parse("2026-09-29T11:45:20.362Z"));
});

test("reads digits-only live markers and ignores sweep files", () => {
	const { paths } = setup();
	const dir = path.join(paths.agentDir, "process-crashes", "live");
	putJson(path.join(dir, "115848.json"), { pid: 999, kind: "interactive", startedAt: 10, productVersion: "5.1.19", senpiVersion: "0.6.2" });
	putJson(path.join(dir, "115849.json.123.sweep"), { pid: 115849, kind: "interactive", startedAt: 11 });
	const markers = readHostExits(paths).liveMarkers;
	assert.equal(markers.size, 1);
	assert.deepEqual(markers.get(115848), { pid: 115848, kind: "interactive", startedAt: 10, mtimeMs: fs.statSync(path.join(dir, "115848.json")).mtimeMs, omoVersion: "5.1.19", senpiVersion: "0.6.2" });
});

test("a live marker without version fields still returns the marker", () => {
	const { paths } = setup();
	const dir = path.join(paths.agentDir, "process-crashes", "live");
	putJson(path.join(dir, "7.json"), { pid: 7, kind: "interactive", startedAt: 1 });
	const marker = readHostExits(paths).liveMarkers.get(7);
	assert.equal(marker.omoVersion, undefined);
	assert.equal(marker.senpiVersion, undefined);
});

test("filters DAG runs by mtime and returns status and session ids", () => {
	const { root } = setup();
	const dir = path.join(root, ".omo", "senpi-task", "dag", "runs");
	const oldFile = path.join(dir, "old.json");
	const newFile = path.join(dir, "new.json");
	putJson(oldFile, { runId: "old", status: "failed", rootSessionId: "r0", updatedAt: "2026-09-01T00:00:00Z" });
	putJson(newFile, { runId: "new", status: "running", rootSessionId: "r1", parentSessionId: "p1", updatedAt: "2026-09-29T00:00:00Z" });
	fs.utimesSync(oldFile, new Date(1000), new Date(1000));
	fs.utimesSync(newFile, new Date(2000), new Date(2000));
	const runs = readDagRuns(root, { sinceMs: 1500 });
	assert.equal(runs.length, 1);
	assert.equal(runs[0].status, "running");
	assert.equal(runs[0].rootSessionId, "r1");
});

test("readDagRuns reads the projects store when given the agent dir", () => {
	const { root, paths } = setup();
	const project = path.join(root, "proj");
	fs.mkdirSync(project, { recursive: true });
	const runsDir = path.join(senpiTaskStoreDir(project, paths.agentDir), "dag", "runs");
	putJson(path.join(runsDir, "r1.json"), { runId: "r1", status: "completed", rootSessionId: "s", updatedAt: "2026-09-29T00:00:00Z" });
	assert.equal(readDagRuns(project).length, 0, "the local store has no runs");
	const runs = readDagRuns(project, { agentDir: paths.agentDir });
	assert.equal(runs.length, 1);
	assert.equal(runs[0].runId, "r1");
});

test("removeHeartbeat deletes only a matching pid and timestamp", () => {
	const { paths } = setup();
	const file = path.join(paths.health.sensorsDir, "session.json");
	putJson(file, { sessionId: "session", pid: 1, ts: 2 });
	assert.equal(removeHeartbeat(paths, { sessionId: "session", pid: 1, ts: 2 }), true);
	assert.equal(fs.existsSync(file), false);
	putJson(file, { sessionId: "session", pid: 2, ts: 3 });
	assert.equal(removeHeartbeat(paths, { sessionId: "session", pid: 1, ts: 3 }), false);
	assert.equal(removeHeartbeat(paths, { sessionId: "session", pid: 2, ts: 2 }), false);
	assert.equal(fs.existsSync(file), true);
	assert.equal(removeHeartbeat(paths, { sessionId: "missing", pid: 1, ts: 2 }), false);
});
