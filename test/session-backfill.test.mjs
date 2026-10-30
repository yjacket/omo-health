import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { BACKFILL_MARKER, backfillOnce } from "../src/session-backfill.mjs";
import { readEnded } from "../src/session-ledger.mjs";

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
	assert.equal(JSON.parse(fs.readFileSync(markerFile, "utf8")).v, 2);
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

test("a v2 marker skips", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-v2-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, ".omo-health"), OMO_HEALTH_OMO_HOME: path.join(root, ".omo") });
	fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.sessionsDir, BACKFILL_MARKER), JSON.stringify({ v: 2 }));
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
