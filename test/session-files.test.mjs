import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { projectStoreName, senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createUsageIndex } from "../src/usage-index.mjs";
import { createFakeClock } from "../src/util/time.mjs";

const STAMP = "2026-11-21T09-00-00-000Z";
const RESCAN = 60_000;

function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-files-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const clock = createFakeClock(Date.UTC(2026, 10, 21, 9, 0, 0));
	const locator = createSessionFileLocator({ paths, clock, rescanMs: RESCAN });
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	return { root, paths, clock, locator, proj };
}

function writeMain(paths, id) {
	const file = path.join(paths.sessionsDir, "--proj--", `${STAMP}_${id}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{"type":"session"}\n');
	return file;
}

function writeChild(paths, cwd, taskId, name, storeDir) {
	const store = storeDir ?? senpiTaskStoreDir(cwd, paths.agentDir);
	const dir = path.join(store, "children", taskId, "sessions", taskId);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, '{"type":"session"}\n');
	return file;
}

test("mainFile finds a main session file by the id in its file name", (t) => {
	const { paths, locator } = setup(t);
	const file = writeMain(paths, "sess-main");
	assert.equal(locator.mainFile("sess-main"), file);
	assert.equal(locator.mainFile("sess-unknown"), undefined);
});

test("(plan 41) mainFile uses a saved custom path only while its first line matches", (t) => {
	const { paths, root, clock, locator } = setup(t);
	const id = "sess-review";
	const file = path.join(root, "review.jsonl");
	assert.equal(locator.mainFile(id), undefined, "no index yet");
	fs.writeFileSync(file, `{"type":"session","id":"${id}"}\n`);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	index.update(id, file, { kind: "main" });
	assert.equal(index.save(), true);
	assert.equal(locator.mainFile(id), file, "a saved custom path supersedes the cached filename miss");

	fs.writeFileSync(file, '{"type":"session","id":"replacement"}\n');
	assert.equal(locator.mainFile(id), undefined, "a stale persisted path must not open a different session");
});

test("mainFile finds a file created after a miss only once the fake clock passes rescanMs", (t) => {
	const { paths, clock, locator } = setup(t);
	assert.equal(locator.mainFile("sess-late"), undefined);
	const file = writeMain(paths, "sess-late");
	assert.equal(locator.mainFile("sess-late"), undefined, "no rescan inside the interval");
	clock.advance(RESCAN - 1);
	assert.equal(locator.mainFile("sess-late"), undefined);
	clock.advance(1);
	assert.equal(locator.mainFile("sess-late"), file);
});

test("childFile finds a child by its exact session id", (t) => {
	const { paths, locator, proj } = setup(t);
	const file = writeChild(paths, proj, "t-exact", `${STAMP}_child-exact.jsonl`);
	assert.equal(locator.childFile({ taskId: "t-exact", sessionId: "child-exact", cwds: [proj] }), file);
});

test("childFile with no id returns the only file, and treats the task id as no id", (t) => {
	const { paths, locator, proj } = setup(t);
	const file = writeChild(paths, proj, "t-single", `${STAMP}_child-single.jsonl`);
	assert.equal(locator.childFile({ taskId: "t-single", cwds: [proj] }), file);
	assert.equal(locator.childFile({ taskId: "t-single", sessionId: "t-single", cwds: [proj] }), file);
});

test("childFile with no id and two files returns undefined, never the newest file", (t) => {
	const { paths, locator, proj } = setup(t);
	const first = writeChild(paths, proj, "t-two", `${STAMP}_child-two-a.jsonl`);
	const second = writeChild(paths, proj, "t-two", `${STAMP}_child-two-b.jsonl`);
	assert.equal(locator.childFile({ taskId: "t-two", cwds: [proj] }), undefined);
	assert.equal(locator.childFile({ taskId: "t-two", sessionId: "child-two-a", cwds: [proj] }), first);
	assert.equal(locator.childFile({ taskId: "t-two", sessionId: "child-two-b", cwds: [proj] }), second);
});

test("childFile finds a child in the agentDir projects store", (t) => {
	const { paths, locator, proj } = setup(t);
	const storeDir = path.join(paths.agentDir, "projects", projectStoreName(proj), "senpi-task");
	assert.equal(fs.existsSync(path.join(proj, ".omo", "senpi-task")), false, "the local store does not exist");
	const file = writeChild(paths, proj, "t-agent", `${STAMP}_child-agent.jsonl`, storeDir);
	assert.equal(locator.childFile({ taskId: "t-agent", sessionId: "child-agent", cwds: [proj] }), file);
});

test("childFile finds a child only through the second cwd (the ancestor)", (t) => {
	const { root, paths, locator } = setup(t);
	const parent = path.join(root, "parent");
	const childCwd = path.join(parent, "nested");
	fs.mkdirSync(childCwd, { recursive: true });
	const file = writeChild(paths, parent, "t-ancestor", `${STAMP}_child-ancestor.jsonl`);
	assert.equal(locator.childFile({ taskId: "t-ancestor", sessionId: "child-ancestor", cwds: [childCwd, parent] }), file);
});

test("childFile retries a negative result after the fake clock passes rescanMs", (t) => {
	const { paths, clock, locator, proj } = setup(t);
	assert.equal(locator.childFile({ taskId: "t-late", cwds: [proj] }), undefined);
	const file = writeChild(paths, proj, "t-late", `${STAMP}_child-late.jsonl`);
	assert.equal(locator.childFile({ taskId: "t-late", cwds: [proj] }), undefined, "no rescan inside the interval");
	clock.advance(RESCAN - 1);
	assert.equal(locator.childFile({ taskId: "t-late", cwds: [proj] }), undefined);
	clock.advance(1);
	assert.equal(locator.childFile({ taskId: "t-late", cwds: [proj] }), file);
});
