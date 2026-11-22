import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { BACKFILL_MARKER, backfillOnce } from "../src/session-backfill.mjs";
import { appendEnded, readEnded, streamEnded } from "../src/session-ledger.mjs";
import { projectKeyOf, subjectOf } from "../src/session-subject.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { createUsageIndex } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { E } from "./helpers/fixtures.mjs";

test("eight backfill appends read the seed day only for the window and shared dedupe", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-batch-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const now = Date.UTC(2026, 10, 22, 20);
	const ledger = path.join(paths.health.sessionsDir, "ended-2026-11-22.jsonl");
	writeJsonl(ledger, [{ sessionId: "seed", endedMs: now, reason: "x".repeat(128 * 1024) }]);
	const size = fs.statSync(ledger).size;
	for (let i = 0; i < 8; i++) {
		const file = writeSession(paths, "proj", `backfill-${i}`, root, now - 2 * HOUR, now - HOUR);
		fs.utimesSync(file, (now - i * 1000) / 1000, (now - i * 1000) / 1000);
	}
	const { openSync, readSync, closeSync } = fs;
	const fds = new Set();
	let opens = 0;
	let bytes = 0;
	t.mock.method(Date, "now", () => now);
	t.mock.method(fs, "openSync", (file, flags, ...args) => {
		const fd = openSync(file, flags, ...args);
		if (file === ledger && flags === "r") {
			opens++;
			fds.add(fd);
		}
		return fd;
	});
	t.mock.method(fs, "readSync", (fd, ...args) => {
		const n = readSync(fd, ...args);
		if (fds.has(fd)) bytes += n;
		return n;
	});
	t.mock.method(fs, "closeSync", (fd) => {
		fds.delete(fd);
		return closeSync(fd);
	});
	const result = backfillOnce(paths, now);
	t.mock.restoreAll();
	assert.deepEqual(result.errors, []);
	assert.equal(result.counts.written, 8);
	assert.equal(result.counts.duplicate, 0);
	assert.deepEqual(readEnded(paths).map(({ sessionId }) => sessionId),
		["seed", ...Array.from({ length: 8 }, (_, i) => `backfill-${i}`)]);
	assert.ok(opens <= 2 && bytes <= 2 * size, `seed size=${size}, opens=${opens}, bytes=${bytes}`);
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

function writeJsonl(file, entries) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
}

function writeSession(paths, slug, id, cwd, startMs, lastMs, extra = []) {
	const file = path.join(paths.sessionsDir, slug, `${iso(startMs).replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeJsonl(file, [
		{ type: "session", version: 3, id, timestamp: iso(startMs), cwd },
		...extra,
		{ type: "message", id: "m1", timestamp: iso(startMs + MIN), message: { role: "user" } },
		{ type: "message", id: "m2", timestamp: iso(lastMs), message: { role: "assistant" } },
	]);
	return file;
}

function writeTask(cwd, raw, storeDir) {
	const file = path.join(storeDir ?? path.join(cwd, ".omo", "senpi-task"), "tasks", `${raw.task_id}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(raw));
}

function setupProjectPair(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-project-pair-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const now = Date.now();
	const startedMs = now - 2 * HOUR;
	const endedMs = now - HOUR;
	const sessionId = "review.1";
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	const assistant = (input) => E.assistant({ ms: endedMs, usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
	for (const [cwd, input] of [[a, 10], [b, 20]]) {
		writeSession(paths, projectKeyOf(cwd), sessionId, cwd, startedMs, endedMs, [assistant(input)]);
	}
	return { paths, now, startedMs, endedMs, sessionId, a, b, assistant };
}

function processBackfilledRows(paths, now) {
	const clock = { now: () => now };
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick({ now, sessions: new Map(), tasks: [] });
	return tracker;
}

test("a v2 upgrade respects the transcript byte allowance each tick and resumes after restart", (t) => {
	const a = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-resume-"));
	t.after(() => fs.rmSync(a, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: a, OMO_HEALTH_HOME: path.join(a, "health"), OMO_HEALTH_OMO_HOME: path.join(a, ".omo") });
	const now = Date.now();
	const endedMs = now - HOUR;
	const startedMs = endedMs - HOUR;
	const marker = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	const ledger = path.join(paths.health.sessionsDir, `ended-${iso(endedMs).slice(0, 10)}.jsonl`);
	const seed = { sessionId: "seed", kind: "main", cwd: a, endedMs };
	assert.ok(appendEnded(paths, seed, { nowMs: now }));
	fs.writeFileSync(marker, JSON.stringify({ v: 2 }));
	const files = new Set();
	const ids = Array.from({ length: 6 }, (_, i) => `old-${i}`);
	const headTailBytes = 320 * 1024;
	for (const [i, id] of ids.entries()) {
		const file = writeSession(paths, projectKeyOf(a), id, a, startedMs, endedMs,
			[" ".repeat(i === ids.length - 1 ? headTailBytes : 2800)]);
		fs.utimesSync(file, now / 1000, (now - (i + 1) * 1000) / 1000);
		files.add(file);
	}
	const { openSync, readSync, closeSync, appendFileSync } = fs;
	const fds = new Set();
	let bytes = 0;
	let reads = new Map();
	t.mock.method(fs, "openSync", (file, flags, ...args) => {
		const fd = openSync(file, flags, ...args);
		if (flags === "r" && files.has(file)) {
			fds.add(fd);
			reads.set(file, (reads.get(file) ?? 0) + 1);
		}
		return fd;
	});
	t.mock.method(fs, "readSync", (fd, ...args) => {
		const n = readSync(fd, ...args);
		if (fds.has(fd)) bytes += n;
		return n;
	});
	t.mock.method(fs, "closeSync", (fd) => {
		fds.delete(fd);
		return closeSync(fd);
	});
	// Small real files exercise the same daemonic allowance without writing tens of MiB.
	const tick = (progress, at = now, maxBytes = 4096) => {
		bytes = 0;
		const summary = backfillOnce(paths, at, { maxBytes, progress });
		assert.ok(bytes <= maxBytes, `tick read ${bytes} transcript bytes with a ${maxBytes}-byte allowance`);
		return JSON.parse(fs.readFileSync(marker, "utf8")).v;
	};
	assert.equal(tick({}), 2, "no v3 marker before the first restart");
	assert.deepEqual(readEnded(paths).map((r) => r.sessionId), ["seed"], "a partial scan leaves the ledger unchanged");

	// Model an interruption during the append batch: only its first append reaches disk.
	let partialWrites = 0;
	const interrupted = t.mock.method(fs, "appendFileSync", (file, ...args) => {
		if (file === ledger && partialWrites++ > 0) throw new Error("interrupted append batch");
		return appendFileSync(file, ...args);
	});
	let progress = {};
	for (let i = 0; i < ids.length - 1; i++) assert.equal(tick(progress, now + (i + 1) * MIN), 2);
	assert.equal(tick(progress, now + ids.length * MIN, headTailBytes), 2, "a failed append leaves the v2 marker");
	interrupted.mock.restore();
	const prefix = readEnded(paths);
	assert.equal(prefix.length, 2, "one backfill row was durable before the restart");
	const prefixBytes = fs.readFileSync(ledger);

	progress = {};
	reads = new Map();
	for (let i = 0; i < ids.length - 1; i++) assert.equal(tick(progress, now + (i + 1) * MIN), 2, `marker after tick ${i + 1}`);
	assert.equal(tick(progress, now + ids.length * MIN, headTailBytes), 3, "marker after the final tick");
	assert.equal(bytes, headTailBytes, "the large transcript spends its allowance on both the head and tail");
	assert.deepEqual([...reads.values()], ids.map(() => 1), "the in-memory cursor visits each transcript only once per run");
	assert.deepEqual(fs.readFileSync(ledger).subarray(0, prefixBytes.length), prefixBytes);
	assert.deepEqual(readEnded(paths).map((r) => [r.sessionId, r.cwd]).sort(),
		[["seed", a], ...ids.map((id) => [id, a])].sort());
});

test("a v2 upgrade leaves the unique cwd-less child untouched without suppressing conflicting projects", (t) => {
	const { paths, now, startedMs, endedMs, sessionId, a, b } = setupProjectPair(t);
	const original = { kind: "main", sessionId, cwd: a, endedMs };
	assert.ok(appendEnded(paths, original, { nowMs: now }));
	const marker = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	fs.writeFileSync(marker, JSON.stringify({ v: 2 }));
	const ledger = path.join(paths.health.sessionsDir, `ended-${iso(endedMs).slice(0, 10)}.jsonl`);
	const child = (id, fields = {}) => ({
		v: 1, kind: "child", sessionId: id, parentSessionId: sessionId, taskId: `st_${id}`, cwd: null, endedMs, ...fields,
	});
	const legacy = child("legacy");
	const otherProject = child("other-project", { parentProjectKey: projectKeyOf(b) });
	const otherChildCwd = child("other-child-cwd", { cwd: b });
	const ambiguous = child("ambiguous");
	const originalChildren = [legacy, otherProject, otherChildCwd, ambiguous, { ...ambiguous, cwd: b }];
	fs.appendFileSync(ledger, originalChildren.map((row) => `${JSON.stringify(row)}\n`).join(""));
	const originalBytes = fs.readFileSync(ledger);
	for (const row of [legacy, otherProject, otherChildCwd, ambiguous]) {
		writeTask(a, {
			task_id: row.taskId, parent_session_id: row.parentSessionId, child_session_id: row.sessionId,
			status: "completed", final_response: "done", created_at: iso(startedMs), terminal_at: iso(endedMs),
		});
	}

	backfillOnce(paths, now);
	const children = readEnded(paths).filter((row) => row.kind === "child");
	assert.deepEqual(children.filter((row) => row.sessionId === "legacy"), [legacy]);
	assert.deepEqual(children.filter((row) => row.sessionId === "other-project").map((row) => [row.cwd, row.parentProjectKey]),
		[[null, projectKeyOf(b)], [a, projectKeyOf(a)]]);
	assert.deepEqual(children.filter((row) => row.sessionId === "other-child-cwd").map((row) => row.cwd), [b, a]);
	assert.deepEqual(children.filter((row) => row.sessionId === "ambiguous").map((row) => row.cwd), [null, b, a]);
	assert.deepEqual(fs.readFileSync(ledger).subarray(0, originalBytes.length), originalBytes);
	assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).v, 3);
});

test("a v2 upgrade restores a missing project ranked 2,001st before marking v3", (t) => {
	const { paths, now, startedMs, endedMs, sessionId, a, b } = setupProjectPair(t);
	assert.ok(appendEnded(paths, { kind: "main", sessionId, cwd: a, endedMs }, { nowMs: now }));
	const marker = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	fs.writeFileSync(marker, JSON.stringify({ v: 2 }));
	const version = () => JSON.parse(fs.readFileSync(marker, "utf8")).v;
	const projects = () => readEnded(paths).filter((row) => row.sessionId === sessionId).map((row) => row.cwd);
	const transcript = (cwd) => path.join(paths.sessionsDir, projectKeyOf(cwd),
		`${iso(startedMs).replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	fs.utimesSync(transcript(a), now / 1000, now / 1000);
	fs.utimesSync(transcript(b), now / 1000, (now - HOUR) / 1000);
	let firstBatchBytes = fs.statSync(transcript(a)).size;
	for (let i = 0; i < 1999; i++) {
		const file = writeSession(paths, projectKeyOf(a), `filler-${i}`, a, startedMs, i < 2 ? endedMs : now);
		fs.utimesSync(file, now / 1000, now / 1000);
		firstBatchBytes += fs.statSync(file).size;
	}
	// Only the oldest project's header reveals the store for this cross-project child.
	writeTask(b, {
		task_id: "st_cross_batch", parent_session_id: sessionId, child_session_id: "filler-1",
		spawn_spec: { cwd: a }, status: "completed", final_response: "done",
		created_at: iso(startedMs), terminal_at: iso(endedMs),
	});

	let progress = {};
	backfillOnce(paths, now, { maxBytes: firstBatchBytes, progress });
	assert.equal(version(), 2, "the first 2,000 transcripts do not cover the whole window");
	assert.deepEqual(projects(), [a]);
	progress = {}; // Restart before the final batch.
	backfillOnce(paths, now, { maxBytes: firstBatchBytes, progress });
	assert.equal(version(), 2, "replaying the first batch after restart is not completion");
	backfillOnce(paths, now, { maxBytes: firstBatchBytes + fs.statSync(transcript(b)).size, progress });
	assert.equal(version(), 2, "even after a batch appends, the marker waits for the oldest transcript");
	assert.deepEqual(projects(), [a]);
	assert.ok(readEnded(paths).some((row) => row.sessionId === "filler-0"), "the first batch already reached disk");
	assert.ok(!readEnded(paths).some((row) => row.sessionId === "filler-1"), "no false main row for a cross-batch child");
	backfillOnce(paths, now, { progress });
	assert.deepEqual(projects(), [a, b], "the oldest qualifying project gets its own row");
	assert.deepEqual(readEnded(paths).filter((row) => row.sessionId === "filler-1")
		.map((row) => [row.kind, row.cwd, row.parentProjectKey]), [["child", a, projectKeyOf(b)]]);
	assert.equal(version(), 3, "only the completed reconciliation writes v3");
	assert.deepEqual(backfillOnce(paths, now), { skipped: true });
	assert.deepEqual(projects(), [a, b], "a restart leaves both rows and adds no duplicates");
});

test("a v2 upgrade restores the missing project for an ended ID and never rewrites the original", (t) => {
	const { paths, now, startedMs, endedMs, sessionId, a, b } = setupProjectPair(t);
	const original = { sessionId, kind: "main", cwd: a, startedMs, endedMs, outcome: "closed", reason: "original row" };
	assert.ok(appendEnded(paths, original, { nowMs: now }));
	const markerFile = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	fs.writeFileSync(markerFile, JSON.stringify({ v: 2, ts: now - HOUR, days: 30, counts: { written: 1 } }));
	const ledgerFile = path.join(paths.health.sessionsDir, `ended-${iso(endedMs).slice(0, 10)}.jsonl`);
	const originalBytes = fs.readFileSync(ledgerFile);

	backfillOnce(paths, now);
	const rows = readEnded(paths);
	assert.deepEqual(rows.map((row) => [row.sessionId, row.cwd]), [[sessionId, a], [sessionId, b]]);
	const tracker = processBackfilledRows(paths, now);
	assert.deepEqual(rows.map((row) => tracker.tokensOf(subjectOf(row))?.tokens.total), [10, 20]);
	assert.equal(JSON.parse(fs.readFileSync(markerFile, "utf8")).v, 3);
	const reconciledBytes = fs.readFileSync(ledgerFile);
	assert.deepEqual(reconciledBytes.subarray(0, originalBytes.length), originalBytes);
	assert.deepEqual(backfillOnce(paths, now), { skipped: true });
	assert.deepEqual(fs.readFileSync(ledgerFile), reconciledBytes);
});

test("cold backfill links a cross-project child only to the same-named parent in its spawning project", (t) => {
	const { paths, now, startedMs, endedMs, sessionId, a, b, assistant } = setupProjectPair(t);
	const taskId = "st_cross";
	const childId = "review.child";
	writeTask(a, {
		task_id: taskId, parent_session_id: sessionId, child_session_id: childId,
		spawn_spec: { cwd: b }, status: "completed", final_response: "done",
		created_at: iso(startedMs), terminal_at: iso(endedMs),
	});
	writeJsonl(path.join(a, ".omo", "senpi-task", "children", taskId, "sessions", taskId,
		`${iso(startedMs).replace(/[:.]/g, "-")}_${childId}.jsonl`), [assistant(6)]);

	const summary = backfillOnce(paths, now);
	assert.deepEqual(summary.errors, []);
	assert.equal(summary.counts.written, 3);
	const rows = readEnded(paths);
	const child = rows.find((row) => row.sessionId === childId);
	const tracker = processBackfilledRows(paths, now);
	const readDetail = createDetailOperations({ paths, auditDetail: () => null });
	const parentResult = (cwd) => {
		const row = rows.find((entry) => entry.sessionId === sessionId && entry.cwd === cwd);
		const record = readDetail({ kind: "detail", id: sessionId, row: expectedSelector(row), now }).record;
		const usage = tracker.tokensOf(subjectOf(row));
		return { total: usage?.tokens.total, tree: usage?.treeTokens, children: record.children.map(({ sessionId }) => sessionId) };
	};
	assert.deepEqual({
		childCwd: child.cwd,
		parentProjectKey: child.parentProjectKey,
		a: parentResult(a),
		b: parentResult(b),
	}, {
		childCwd: b,
		parentProjectKey: projectKeyOf(a),
		a: { total: 10, tree: 16, children: [childId] },
		b: { total: 20, tree: null, children: [] },
	});
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const now = Date.now();
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const slug = "--proj--";

	// A: goal complete, named by session_info.
	writeSession(paths, slug, "sess-goal", proj, now - 5 * HOUR, now - 2 * HOUR, [{ type: "session_info", name: "목표 세션", timestamp: iso(now - 5 * HOUR) }]);
	fs.mkdirSync(path.join(paths.sessionsDir, slug, "extensions", "goal"), { recursive: true });
	fs.writeFileSync(path.join(paths.sessionsDir, slug, "extensions", "goal", "sess-goal.json"), JSON.stringify({ version: 1, goal: { status: "complete", objective: "ship it" } }));
	// B: unclean exit 60s after the last entry.
	writeSession(paths, slug, "sess-crash", proj, now - 6 * HOUR, now - 3 * HOUR);
	writeJsonl(path.join(paths.agentDir, "process-crashes", "crashes.jsonl"), [
		{ at: iso(now - 3 * HOUR + MIN), kind: "interactive", detection: "unclean_exit", uptimeMs: 1000, productVersion: "5.1.19" },
		"{not json",
	]);
	// C: closed, named by the summaries index.
	writeSession(paths, slug, "sess-closed", proj, now - 7 * HOUR, now - 4 * HOUR);
	writeJsonl(path.join(paths.sessionsDir, slug, ".session-summaries.index"), [
		{ version: 2 },
		{ file: "x_sess-closed.jsonl", summary: { header: { id: "sess-closed" }, name: "인덱스 제목", firstUserMessage: "hi", lastActivityTime: now - 4 * HOUR } },
	]);
	// D: still live (last entry 5 minutes ago).
	writeSession(paths, slug, "sess-live", proj, now - HOUR, now - 5 * MIN);
	// E: malformed file.
	const bad = path.join(paths.sessionsDir, slug, "2026-01-01T00-00-00-000Z_sess-bad.jsonl");
	fs.writeFileSync(bad, "garbage{{{\nmore garbage\n");

	const task = (id, status, extra = {}) => ({ task_id: id, parent_session_id: "sess-goal", child_session_id: `child-${id}`, status, created_at: iso(now - 3 * HOUR), terminal_at: iso(now - 150 * MIN), name: `task ${id}`, category: "quick", ...extra });
	writeTask(proj, task("t-answer", "completed", { final_response: "done" }));
	writeTask(proj, task("t-cancel", "cancelled"));
	writeTask(proj, task("t-fail", "error", { error_message: "boom" }));
	writeTask(proj, task("t-release", "interrupted"));
	writeTask(proj, task("t-unknown", "interrupted"));
	writeTask(proj, task("t-recent", "completed", { final_response: "x", terminal_at: iso(now - 2 * MIN) }));
	writeTask(proj, task("t-running", "running", { terminal_at: undefined }));
	fs.writeFileSync(path.join(proj, ".omo", "senpi-task", "tasks", "broken.json"), "{oops");

	writeJsonl(path.join(paths.health.decisionsDir, `${iso(now).slice(0, 10)}.jsonl`), [
		{ ts: iso(now - 160 * MIN), action: { kind: "release-shell" }, result: "execute", subject: { sessionId: "child-t-release", taskId: "t-release" } },
		{ ts: iso(now - 160 * MIN), action: { kind: "kill-pids" }, result: "would-execute", subject: { taskId: "t-unknown" } },
	]);
	return { paths, now, bad };
}

test("backfillOnce reconstructs every outcome, skips live and bad files, and runs once", () => {
	const { paths, now, bad } = setup();
	const summary = backfillOnce(paths, now);
	assert.equal(summary.skipped, false);
	assert.ok(summary.errors.some((e) => e.includes(path.basename(bad))), "malformed session reported");
	assert.ok(summary.errors.some((e) => e.includes("broken.json")), "malformed task reported");

	const rows = readEnded(paths, { sinceMs: now - 31 * 86_400_000 });
	const by = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
	assert.equal(by["sess-goal"].outcome, "goal-complete");
	assert.equal(by["sess-goal"].title, "목표 세션");
	assert.equal(by["sess-goal"].childCount, 7);
	assert.equal(by["sess-crash"].outcome, "crash");
	assert.equal(by["sess-crash"].omoVersion, "5.1.19");
	assert.equal(by["sess-closed"].outcome, "closed");
	assert.equal(by["sess-closed"].title, "인덱스 제목");
	assert.equal(by["child-t-answer"].outcome, "answered");
	assert.equal(by["child-t-answer"].kind, "child");
	assert.equal(by["child-t-answer"].parentSessionId, "sess-goal");
	assert.equal(by["child-t-answer"].taskId, "t-answer");
	assert.equal(by["child-t-cancel"].outcome, "cancelled");
	assert.equal(by["child-t-fail"].outcome, "failed");
	assert.match(by["child-t-fail"].reason, /boom/);
	assert.equal(by["child-t-release"].outcome, "released");
	assert.equal(by["child-t-unknown"].outcome, "unknown");
	for (const id of ["sess-live", "sess-bad", "child-t-recent", "child-t-running"]) assert.equal(by[id], undefined, id);
	assert.equal(rows.length, 8);
	for (const r of rows) {
		assert.equal(r.estimated, true);
		assert.equal(r.source, "backfill");
		assert.equal(r.v, 1);
		assert.ok(r.reason.length > 0 && r.reason.length <= 300);
	}

	const marker = JSON.parse(fs.readFileSync(path.join(paths.health.sessionsDir, ".backfilled"), "utf8"));
	assert.equal(marker.counts.written, 8);
	assert.deepEqual(backfillOnce(paths, now), { skipped: true });
	assert.equal(readEnded(paths, { sinceMs: now - 31 * 86_400_000 }).length, 8);
});

test("backfillOnce counts a child whose task record lives in the agent projects store", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-store-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const now = Date.now();
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	writeSession(paths, "--proj--", "sess-parent", proj, now - 5 * HOUR, now - 2 * HOUR);
	const storeDir = senpiTaskStoreDir(proj, paths.agentDir);
	writeTask(proj, { task_id: "t-proj", parent_session_id: "sess-parent", child_session_id: "child-proj", status: "completed", created_at: iso(now - 3 * HOUR), terminal_at: iso(now - 2 * HOUR), final_response: "done" }, storeDir);
	assert.equal(fs.existsSync(path.join(proj, ".omo", "senpi-task")), false, "the task is not in the local store");
	const summary = backfillOnce(paths, now);
	assert.deepEqual(summary.errors, []);
	const by = Object.fromEntries(readEnded(paths, { sinceMs: now - 31 * 86_400_000 }).map((row) => [row.sessionId, row]));
	assert.equal(by["child-proj"].kind, "child");
	assert.equal(by["child-proj"].parentSessionId, "sess-parent");
	assert.equal(by["sess-parent"].childCount, 1);
});

test("an install with a v1 marker runs the backfill once more and picks up children from the projects store", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-v1-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const now = Date.now();
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	writeSession(paths, "--proj--", "sess-parent", proj, now - 5 * HOUR, now - 2 * HOUR);
	writeTask(proj, { task_id: "t-v1", parent_session_id: "sess-parent", child_session_id: "child-v1", status: "completed", created_at: iso(now - 3 * HOUR), terminal_at: iso(now - 2 * HOUR), final_response: "done" }, senpiTaskStoreDir(proj, paths.agentDir));
	const markerFile = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
	fs.writeFileSync(markerFile, JSON.stringify({ v: 1, ts: now - HOUR, days: 30, counts: { written: 0 } }));

	const summary = backfillOnce(paths, now);
	assert.equal(summary.skipped, false);
	const by = Object.fromEntries(readEnded(paths, { sinceMs: now - 31 * 86_400_000 }).map((row) => [row.sessionId, row]));
	assert.equal(by["child-v1"].kind, "child");
	assert.equal(by["child-v1"].parentSessionId, "sess-parent");
	assert.equal(JSON.parse(fs.readFileSync(markerFile, "utf8")).v, 3);
});

test("a second run writes no duplicate ledger entries", () => {
	const { paths, now } = setup();
	const first = backfillOnce(paths, now);
	assert.equal(first.counts.written, 8);
	const before = readEnded(paths, { sinceMs: now - 31 * 86_400_000 });
	fs.writeFileSync(path.join(paths.health.sessionsDir, BACKFILL_MARKER), JSON.stringify({ v: 1 }));

	const second = backfillOnce(paths, now);
	assert.equal(second.skipped, false);
	assert.equal(second.counts.written, 0);
	assert.equal(second.counts.duplicate, 8);
	assert.equal(readEnded(paths, { sinceMs: now - 31 * 86_400_000 }).length, before.length);
});

test("a v3 marker skips", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-v3-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.sessionsDir, BACKFILL_MARKER), JSON.stringify({ v: 3 }));
	assert.deepEqual(backfillOnce(paths, Date.now()), { skipped: true });
	assert.equal(readEnded(paths, { sinceMs: Date.now() - 31 * 86_400_000 }).length, 0);
});

test("backfillOnce on an empty omo home writes the marker and nothing else", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-empty-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	const summary = backfillOnce(paths, Date.now());
	assert.equal(summary.skipped, false);
	assert.deepEqual(summary.errors, []);
	assert.equal(summary.counts.written, 0);
	assert.ok(fs.existsSync(path.join(paths.health.sessionsDir, ".backfilled")));
});
