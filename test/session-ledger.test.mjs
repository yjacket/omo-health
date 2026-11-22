import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, appendEndedLocated, ENDED_LOCATION, hasEnded, readEnded, readEndedCwd } from "../src/session-ledger.mjs";

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

test("appendEndedLocated reports the appended line's position and reads only that line", () => {
	const p = setup();
	const now = Date.now();
	const first = appendEndedLocated(p, rec("a", now - 1000));
	assert.equal(first.appended, true);
	const text = fs.readFileSync(first.location.file, "utf8");
	assert.equal(text.slice(first.location.offset, first.location.offset + first.location.length), text.split("\n")[0]);

	const row = readEnded(p, {})[0];
	row[ENDED_LOCATION] = first.location;
	let bytes = 0;
	const countingFs = {
		...fs,
		readSync(...args) {
			const read = fs.readSync(...args);
			bytes += read;
			return read;
		},
	};
	assert.equal(readEndedCwd(p, row, { fs: countingFs }), null, "the recorded cwd is null");
	assert.equal(bytes, first.location.length, "only the located line was read");

	assert.deepEqual(appendEndedLocated(p, rec("a", now)), { appended: false, location: null });
	assert.equal(appendEnded(p, rec("b", now)), true, "appendEnded still returns a boolean");
});
