import "./helpers/tmp-root.mjs";
import { projectKeyOf, subjectOf } from "../src/session-subject.mjs";
const sub = (sessionId, cwd) => subjectOf({ sessionId, cwd });
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

function writeMain(paths, proj, id) {
	const file = path.join(paths.sessionsDir, projectKeyOf(proj), `${STAMP}_${id}.jsonl`);
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

test("projectKeyOf matches a real senpi Windows project directory", () => {
	assert.equal(projectKeyOf("C:/dev/omo/omo-health"), "--C--dev-omo-omo-health--");
});

test("mainFile finds a main session file by the id in its file name", (t) => {
	const { paths, locator, proj } = setup(t);
	const file = writeMain(paths, proj, "sess-main");
	assert.equal(locator.mainFile(sub("sess-main", proj)), file);
	assert.equal(locator.mainFile(sub("sess-unknown", proj)), undefined);
});

test("cwd-less mainFile lookup resumes bounded discovery and rejects two projects with the same id", (t) => {
	const { paths, locator, clock, proj } = setup(t);
	const id = "review.1";
	const query = sub(id);
	const dir = path.join(paths.sessionsDir, "probe");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-11-22_${id}.jsonl`);
	fs.writeFileSync(file, '{"type":"usage","usage":{"input":42}}\n');
	assert.deepEqual(locator.findMainFile(query, null, { maxBytes: 0 }), { file: undefined, pending: true, bytesRead: 0 });
	assert.equal(locator.mainFile(query), file);
	const duplicate = writeMain(paths, proj, id);
	clock.advance(RESCAN);
	assert.equal(locator.mainFile(query), undefined);
	assert.equal(locator.mainFile(sub(id, proj)), duplicate);
});

test("(IS-1, IS-4, IS-7) filename IDs strip only the senpi timestamp", () => {
	assert.deepEqual(["review.1", "run_review.1", "a_b"].map((id) => idFromFileName(`${STAMP}_${id}.jsonl`)),
		["review.1", "run_review.1", "a_b"]);
	for (const name of ["review.1.jsonl", "prefix_review.1.jsonl", `${STAMP}_a?.jsonl`, `${STAMP}_a_.jsonl`, `${STAMP}_a_b.txt`]) {
		assert.equal(idFromFileName(name), undefined, name);
	}
});

test("date-only session filenames resolve the whole ID without a header or suffix match", (t) => {
	const { paths, locator, proj } = setup(t);
	const child = writeChild(paths, proj, "st_review", "2026-11-22_run_review.1.jsonl");
	const main = path.join(paths.sessionsDir, projectKeyOf(proj), "2026-11-22_a_b.jsonl");
	fs.mkdirSync(path.dirname(main), { recursive: true });
	fs.writeFileSync(main, '{"type":"message"}\n');
	assert.equal(idFromFileName(main), "a_b");
	assert.equal(idFromFileName("2026-11-22_a?.jsonl"), undefined);
	assert.equal(locator.mainFile(sub("a_b", proj)), main);
	assert.equal(locator.mainFile(sub("b", proj)), undefined);
	assert.equal(locator.childFile({ taskId: "st_review", sessionId: "run_review.1", cwds: [proj] }), child);
	assert.equal(locator.childFile({ taskId: "st_review", sessionId: "review.1", cwds: [proj] }), undefined);
});

test("(IS-3) mainFile maps cold files by their headers, not a conflicting name", (t) => {
	const { paths, clock, locator, proj } = setup(t);
	const file = writeMain(paths, proj, "wrong-id");
	fs.writeFileSync(file, '{"type":"session","id":"header-id"}\n');
	const unnamed = path.join(path.dirname(file), `${STAMP}_.jsonl`);
	fs.writeFileSync(unnamed, '{"type":"session","id":"unnamed-id"}\n');

	assert.equal(locator.mainFile(sub("wrong-id", proj)), undefined, "a header for another session disproves the filename");
	assert.equal(locator.mainFile(sub("header-id", proj)), file);
	assert.equal(locator.mainFile(sub("unnamed-id", proj)), unnamed);
	fs.writeFileSync(unnamed, '{"type":"session","id":"new-id"}\n');
	assert.equal(locator.mainFile(sub("new-id", proj)), undefined, "a new header ID is not picked up inside the rescan interval");
	clock.advance(RESCAN);
	assert.equal(locator.mainFile(sub("new-id", proj)), unnamed);
	assert.equal(locator.mainFile(sub("unnamed-id", proj)), undefined);
});

test("(IS-4) a main header scan resumes from its cursor without rereading candidates", (t) => {
	const { paths, clock, locator, proj } = setup(t);
	const cap = 64 * 1024;
	const first = writeMain(paths, proj, "first");
	fs.writeFileSync(first, `${'{"type":"session","id":"other"}'.padEnd(cap - 1)}\n`);
	const review = path.join(path.dirname(first), "review.jsonl");
	fs.writeFileSync(review, `${'{"type":"session","id":"review"}'.padEnd(cap - 1)}\n`);

	assert.deepEqual(locator.findMainFile(sub("review", proj), null, { maxBytes: cap - 1 }),
		{ file: undefined, pending: true, bytesRead: 0 });
	assert.deepEqual(locator.findMainFile(sub("review", proj), null, { maxBytes: cap }),
		{ file: undefined, pending: true, bytesRead: cap });
	clock.advance(RESCAN + 1);
	assert.deepEqual(locator.findMainFile(sub("review", proj), null, { maxBytes: cap }),
		{ file: review, pending: false, bytesRead: cap });
	assert.deepEqual(locator.findMainFile(sub("other", proj), null, { maxBytes: 0 }),
		{ file: first, pending: false, bytesRead: 0 }, "results from the earlier call were retained");
	assert.deepEqual(locator.findMainFile(sub("first", proj), null, { maxBytes: 0 }),
		{ file: undefined, pending: false, bytesRead: 0 }, "a finished scan can conclusively rule out an id");
});

test("(plan 41) mainFile uses a saved custom path only while its first line matches", (t) => {
	const { paths, root, clock, proj } = setup(t);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const locator = createSessionFileLocator({ paths, clock, indexedEntry: (query) => index.getForSubject(query) });
	const id = "sess-review";
	const file = path.join(root, "review.jsonl");
	assert.equal(locator.mainFile(sub(id, proj)), undefined, "no index yet");
	fs.writeFileSync(file, `{"type":"session","id":"${id}"}\n`);
	index.update(sub(id, proj), file, { kind: "main" });
	assert.equal(index.save(), true);
	assert.equal(locator.mainFile(sub(id, proj)), file, "a saved custom path supersedes the cached filename miss");

	fs.writeFileSync(file, '{"type":"session","id":"replacement"}\n');
	assert.equal(locator.mainFile(sub(id, proj)), undefined, "a stale persisted path must not open a different session");

	const replacement = `${file}.new`;
	fs.writeFileSync(replacement, JSON.stringify({ type: "session", id }) + "\n");
	fs.renameSync(replacement, file);
	assert.equal(locator.mainFile(sub(id, proj)), undefined, "a replacement with the same ID but no cwd has no project proof");
	fs.writeFileSync(file, JSON.stringify({ type: "session", id, cwd: proj }) + "\n");
	assert.equal(locator.mainFile(sub(id, proj)), file, "a replacement with the matching ID and project is accepted");
});

test("(plan 117) cwd-less external ownership uses the loaded row without reopening the index", (t) => {
	const { paths, root, clock, proj } = setup(t);
	const subject = sub("review.1", proj);
	const file = path.join(root, "review.jsonl");
	const header = '{"type":"session","id":"review.1"}\n';
	fs.writeFileSync(file, header);
	const indexFile = paths.health.usageIndexFile;
	const seed = createUsageIndex({ file: indexFile, clock });
	seed.update(subject, file, { kind: "main" });
	assert.equal(seed.save(), true);
	const index = createUsageIndex({ file: indexFile, clock });
	const locator = createSessionFileLocator({ paths, clock, indexedEntry: (query) => index.getForSubject(query) });
	const indexReads = [];
	for (const method of ["readFileSync", "openSync"]) {
		const original = fs[method];
		t.mock.method(fs, method, (name, ...args) => {
			if (name === indexFile) {
				indexReads.push(method);
				throw new Error("the resident index has already been loaded");
			}
			return original(name, ...args);
		});
	}
	const unchanged = locator.mainFile(subject);
	const replacement = `${file}.new`;
	fs.writeFileSync(replacement, header);
	fs.renameSync(replacement, file);
	const replaced = locator.mainFile(subject);
	assert.deepEqual({ unchanged, replaced, indexReads }, { unchanged: file, replaced: undefined, indexReads: [] });
});

test("mainFile finds a file created after a miss only once the fake clock passes rescanMs", (t) => {
	const { paths, clock, locator, proj } = setup(t);
	assert.equal(locator.mainFile(sub("sess-late", proj)), undefined);
	const file = writeMain(paths, proj, "sess-late");
	assert.equal(locator.mainFile(sub("sess-late", proj)), undefined, "no rescan inside the interval");
	clock.advance(RESCAN - 1);
	assert.equal(locator.mainFile(sub("sess-late", proj)), undefined);
	clock.advance(1);
	assert.equal(locator.mainFile(sub("sess-late", proj)), file);
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

test("plan94 childFile prioritizes explicit store and parent, otherwise requires a unique store", (t) => {
	const { root, paths, locator, proj } = setup(t);
	const spawn = path.join(root, "spawn");
	const storeDir = path.join(root, "explicit-store");
	const taskId = "st_cross";
	const sessionId = "cross";
	const name = `${STAMP}_${sessionId}.jsonl`;
	const parentFile = writeChild(paths, proj, taskId, name);
	const spawnFile = writeChild(paths, spawn, taskId, name);
	const explicitFile = writeChild(paths, proj, taskId, name, storeDir);
	const query = { taskId, sessionId, cwds: [spawn, proj] };
	assert.deepEqual([
		locator.childFile({ ...query, parentCwd: proj, storeDir }),
		locator.childFile({ ...query, parentCwd: proj }),
		locator.childFile(query),
		locator.childCandidate(query),
	], [explicitFile, parentFile, undefined, null]);
	fs.rmSync(parentFile);
	assert.equal(locator.childFile({ ...query, parentCwd: proj }), undefined, "a known store must not fall through");
	assert.equal(locator.childFile(query), spawnFile, "ambiguity can clear without waiting for rescan");
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
