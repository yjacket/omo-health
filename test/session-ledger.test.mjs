import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, hasEnded, readEnded } from "../src/session-ledger.mjs";

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
	return resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o") });
}

const rec = (sessionId, endedMs, extra = {}) => ({ sessionId, kind: "main", parentSessionId: null, taskId: null, title: "t", cwd: null, terminal: null, omoVersion: null, startedMs: null, endedMs, outcome: "closed", reason: "x", childCount: 0, estimated: false, source: "live", ...extra });

test("append and read back newest first", () => {
	const p = setup();
	const now = Date.now();
	assert.equal(appendEnded(p, rec("a", now - 2000)), true);
	assert.equal(appendEnded(p, rec("b", now - 1000)), true);
	assert.deepEqual(readEnded(p, { sinceMs: now - 10_000 }).map((r) => r.sessionId), ["b", "a"]);
	assert.equal(readEnded(p, { sinceMs: now - 1500 }).length, 1);
});

test("duplicate sessionId within 30 days is skipped", () => {
	const p = setup();
	const now = Date.now();
	assert.equal(appendEnded(p, rec("a", now - 1000)), true);
	assert.equal(appendEnded(p, rec("a", now)), false);
	assert.equal(readEnded(p, {}).length, 1);
});

test("corrupt line is skipped and hasEnded works", () => {
	const p = setup();
	const now = Date.now();
	appendEnded(p, rec("a", now));
	const file = fs.readdirSync(p.health.sessionsDir).map((f) => path.join(p.health.sessionsDir, f))[0];
	fs.appendFileSync(file, "{not json\n");
	appendEnded(p, rec("b", now - 5));
	assert.deepEqual(readEnded(p, {}).map((r) => r.sessionId), ["a", "b"]);
	assert.equal(hasEnded(p, "b"), true);
	assert.equal(hasEnded(p, "zzz"), false);
});

test("day file uses UTC date of endedMs and reason is bounded", () => {
	const p = setup();
	const ended = Date.UTC(2026, 0, 2, 23, 59, 59);
	appendEnded(p, rec("a", ended, { reason: "가".repeat(1000) }));
	assert.deepEqual(fs.readdirSync(p.health.sessionsDir), ["ended-2026-01-02.jsonl"]);
	assert.ok(readEnded(p, {})[0].reason.length <= 300);
});
