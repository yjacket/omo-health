import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { idFromFileName } from "../src/collect/sessions.mjs";
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

test("(IS-1, IS-4, IS-7) filename IDs strip only the senpi timestamp", () => {
	assert.deepEqual(["review.1", "run_review.1", "a_b"].map((id) => idFromFileName(`${STAMP}_${id}.jsonl`)),
		["review.1", "run_review.1", "a_b"]);
	for (const name of ["review.1.jsonl", "prefix_review.1.jsonl", `${STAMP}_a?.jsonl`, `${STAMP}_a_.jsonl`, `${STAMP}_a_b.txt`]) {
		assert.equal(idFromFileName(name), undefined, name);
	}
});

test("(IS-3) mainFile maps cold files by their headers, not a conflicting name", (t) => {
	const { paths, clock, locator } = setup(t);
	const file = writeMain(paths, "wrong-id");
	fs.writeFileSync(file, '{"type":"session","id":"header-id"}\n');
	const unnamed = path.join(path.dirname(file), `${STAMP}_.jsonl`);
	fs.writeFileSync(unnamed, '{"type":"session","id":"unnamed-id"}\n');

	assert.equal(locator.mainFile("wrong-id"), undefined, "a header for another session disproves the filename");
	assert.equal(locator.mainFile("header-id"), file);
	assert.equal(locator.mainFile("unnamed-id"), unnamed);
	fs.writeFileSync(unnamed, '{"type":"session","id":"new-id"}\n');
	assert.equal(locator.mainFile("new-id"), undefined, "a new header ID is not picked up inside the rescan interval");
	clock.advance(RESCAN);
	assert.equal(locator.mainFile("new-id"), unnamed);
	assert.equal(locator.mainFile("unnamed-id"), undefined);
});

test("(IS-4) a main header scan resumes from its cursor without rereading candidates", (t) => {
	const { paths, clock, locator } = setup(t);
	const cap = 64 * 1024;
	const first = writeMain(paths, "first");
	fs.writeFileSync(first, `${'{"type":"session","id":"other"}'.padEnd(cap - 1)}\n`);
	const review = path.join(path.dirname(first), "review.jsonl");
	fs.writeFileSync(review, `${'{"type":"session","id":"review"}'.padEnd(cap - 1)}\n`);

	assert.deepEqual(locator.findMainFile("review", null, { maxBytes: cap - 1 }),
		{ file: undefined, pending: true, bytesRead: 0 });
	assert.deepEqual(locator.findMainFile("review", null, { maxBytes: cap }),
		{ file: undefined, pending: true, bytesRead: cap });
	clock.advance(RESCAN + 1);
	assert.deepEqual(locator.findMainFile("review", null, { maxBytes: cap }),
		{ file: review, pending: false, bytesRead: cap });
	assert.deepEqual(locator.findMainFile("other", null, { maxBytes: 0 }),
		{ file: first, pending: false, bytesRead: 0 }, "results from the earlier call were retained");
	assert.deepEqual(locator.findMainFile("first", null, { maxBytes: 0 }),
		{ file: undefined, pending: false, bytesRead: 0 }, "a finished scan can conclusively rule out an id");
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

test("(IS-1, IS-4, IS-7) childFile skips a suffix collision that sorts first", (t) => {
	const { paths, locator, proj } = setup(t);
	const taskId = "t-review";
	const other = writeChild(paths, proj, taskId, `${STAMP}_run_review.1.jsonl`);
	const own = writeChild(paths, proj, taskId, "2026-11-21T09-01-00-000Z_review.1.jsonl");
	assert.equal(locator.childFile({ taskId, sessionId: "review.1", cwds: [proj] }), own);
	assert.equal(locator.childFile({ taskId, sessionId: "run_review.1", cwds: [proj] }), other);
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

test("(plan 61) task-only lookup rechecks a warm candidate before the rescan interval", (t) => {
	const { paths, locator, proj } = setup(t);
	const taskId = "t-changing";
	const query = { taskId, sessionId: taskId, cwds: [proj] };
	const first = writeChild(paths, proj, taskId, `${STAMP}_child-first.jsonl`);
	assert.equal(locator.childFile(query), first);

	const second = writeChild(paths, proj, taskId, `${STAMP}_child-second.jsonl`);
	assert.equal(locator.childFile(query), undefined, "the cached file is no longer the sole candidate");
	assert.equal(locator.childFile({ ...query, sessionId: "child-first" }), first, "an exact ID still identifies its file");

	fs.rmSync(second);
	assert.equal(locator.childFile(query), first, "uniqueness can return without waiting for the negative rescan interval");
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
