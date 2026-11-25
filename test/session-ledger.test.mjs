import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, appendEndedBatch, appendEndedLocated, endedKey, endedSelector, ENDED_LOCATION, hasEnded, readEnded, readEndedCwd } from "../src/session-ledger.mjs";
import { projectKeyOf, subjectOf } from "../src/session-subject.mjs";

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
	return resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o") });
}

function compareAppends(t, seeds, rows, nowMs, decisions) {
	const run = (batched) => {
		const paths = setup();
		t.after(() => fs.rmSync(paths.health.sessionsDir, { recursive: true, force: true }));
		fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
		for (const [day, bytes] of Object.entries(seeds)) {
			fs.writeFileSync(path.join(paths.health.sessionsDir, `ended-${day}.jsonl`), bytes);
		}
		const results = batched ? appendEndedBatch(paths, rows, { nowMs }) : rows.map((row) => {
			try {
				return appendEndedLocated(paths, row, { nowMs });
			} catch (error) {
				return { appended: false, location: null, error };
			}
		});
		return {
			decisions: results.map(({ appended, error }) => error ? String(error) : appended),
			locations: results.map(({ location }) => location && { ...location, file: path.basename(location.file) }),
			files: fs.readdirSync(paths.health.sessionsDir).sort().map((file) => [file, fs.readFileSync(path.join(paths.health.sessionsDir, file))]),
		};
	};
	const sequential = run(false);
	if (decisions) assert.deepEqual(sequential.decisions, decisions);
	assert.deepEqual(run(true), sequential);
}

const batchNow = Date.UTC(2026, 10, 22, 20);
const batchDay = 86_400_000;
const batchDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const batchRow = (sessionId, endedMs = batchNow) => ({ sessionId, endedMs });

test("batch matches sequential append after a readable tail without LF", (t) => {
	compareAppends(t, { [batchDate(batchNow)]: JSON.stringify(batchRow("seed")) },
		[batchRow("a"), batchRow("a"), batchRow("seed")], batchNow, [true, true, true]);
});

test("batch isolates an invalid timestamp between two valid rows", (t) => {
	compareAppends(t, {}, [batchRow("good1"), batchRow("bad", 1e20), batchRow("good2")],
		batchNow, [true, "RangeError: Invalid time value", true]);
});

test("generated batches match sequential decisions, offsets and bytes across cutoff days", (t) => {
	let state = 22;
	const next = (n) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state >>> 16) % n;
	};
	for (let i = 0; i < 48; i++) {
		const cutoff = batchNow - 30 * batchDay;
		const tail = JSON.stringify(batchRow("tail", batchNow));
		const eol = i % 2 ? "\n" : "";
		const seeds = {
			[batchDate(cutoff - batchDay)]: `${JSON.stringify(batchRow("outside", cutoff - batchDay))}\n`,
			[batchDate(cutoff)]: `${JSON.stringify(batchRow("cutoff", cutoff - 1000))}\n`,
			[batchDate(batchNow)]: (i % 3 === 0 ? `${tail}\n` : "") + (i % 4 === 1 ? " \t\r" : tail + eol),
		};
		const ids = ["a", "가", "tail", "outside", "cutoff"];
		const days = [-31, -30, -5, 0, 1, 31];
		const rows = [batchRow("a"), batchRow("a"), batchRow("tail"), batchRow("cutoff"), batchRow("outside")];
		for (let j = 0; j < 12; j++) {
			rows.push(batchRow(ids[next(ids.length)], batchNow + days[next(days.length)] * batchDay));
		}
		if (i % 5 === 0) rows.splice(7, 0, batchRow("invalid", i % 2 ? NaN : 1e20));
		if (i % 7 === 0) rows.push(batchRow("outside", Date.UTC(10_000, 2, 1)));
		compareAppends(t, seeds, rows, batchNow);
	}
});

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

test("ended append dedupe scopes shared task IDs by parent or parentless cwd", (t) => {
	const child = (parentSessionId, cwd) => rec("st_x", batchNow, { kind: "child", taskId: "st_x", parentSessionId, cwd });
	const a = child("main-a", "project-a");
	const b = child("main-b", "project-b");
	const c = child(null, "project-a");
	const d = child(null, "project-b");
	compareAppends(t, {}, [a, b, c, d, a, b, c, d], batchNow,
		[true, true, true, true, false, false, false, false]);
});

test("batch persists a cwd-less child's project from batch, live, or retained parents", (t) => {
	const paths = setup();
	t.after(() => fs.rmSync(paths.health.sessionsDir, { recursive: true, force: true }));
	const parent = (id, cwd, endedMs = batchNow) => rec(id, endedMs, { cwd });
	const child = (parentSessionId, extra) => rec("check.1", batchNow, { parentSessionId, kind: "child", ...extra });
	const append = (rows, options) => appendEndedBatch(paths, rows, { nowMs: batchNow, ...options }).map(({ appended }) => appended);
	const a = "C:/project-a";
	const b = "C:/project-b";
	const c = "C:/project-c";
	assert.deepEqual(append([child("review.1"), parent("review.1", a)]), [true, true], "a later batch row supplies the parent");
	assert.deepEqual(append([child("review.1")], { liveRows: [{ id: "review.1", cwd: b }] }), [true], "a live parent takes precedence over retained rows");
	assert.deepEqual(append([child("review.1", { cwd: "C:\\project-a\\." })]), [false], "own cwd deduplicates against inherited project");
	assert.deepEqual(append([parent("older", c, batchNow - 31 * batchDay)]), [true]);
	assert.deepEqual(append([child("older")]), [true], "the retained parent may be outside the dedupe window");
	assert.deepEqual(append([child("older")]), [false], "the inherited repeat is skipped");
	assert.equal(hasEnded(paths, child("older"), { nowMs: batchNow }), true);
	const shared = readEnded(paths).filter((row) => row.parentSessionId === "review.1");
	assert.deepEqual(shared.map((row) => subjectOf(row).projectKey), [projectKeyOf(a), projectKeyOf(b)]);
	assert.notEqual(endedSelector(shared[0]), endedSelector(shared[1]), "same-tick rows have distinct selectors");
	const older = readEnded(paths).find((row) => row.parentSessionId === "older");
	assert.equal(older.cwd, null, "do not write an ancestor's cwd as the child's own cwd");
	assert.equal(subjectOf(older).projectKey, projectKeyOf(c));
});

test("batch leaves an ambiguous parent project on the legacy unresolved key", (t) => {
	const paths = setup();
	t.after(() => fs.rmSync(paths.health.sessionsDir, { recursive: true, force: true }));
	const child = rec("check.1", batchNow, { parentSessionId: "review.1", kind: "child" });
	const rows = ["C:/a", "C:/b"].map((cwd) => rec("review.1", batchNow, { cwd }));
	const appended = appendEndedBatch(paths, [...rows, child, child], { nowMs: batchNow });
	assert.deepEqual(appended.map((result) => result.appended), [true, true, true, false]);
	const stored = readEnded(paths).find((row) => row.sessionId === child.sessionId);
	assert.equal(subjectOf(stored).projectKey, null);
	assert.equal(endedKey(stored), JSON.stringify(["check.1", "review.1", null]));
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

test("bounded live batch preserves sequential duplicate decisions, ledger bytes, and locations", () => {
	const batch = setup();
	const sequential = setup();
	const now = Date.UTC(2026, 8, 28, 12);
	const day = 86_400_000;
	const seed = [
		rec("cutoff", now - 30.25 * day),
		rec("expired", now - 31 * day),
		rec("future-cutoff", now - 30 * day),
	];
	for (const paths of [batch, sequential]) {
		for (const row of seed) appendEnded(paths, row, { nowMs: now });
	}
	const rows = [
		rec("cutoff", now),
		rec("expired", now, { cwd: "C:/작업", reason: "가".repeat(400) }),
		rec("expired", now, { cwd: "C:/작업" }),
		rec("future-cutoff", now + day),
		rec("future-cutoff", now),
		rec("outside", now - 31 * day),
		rec("outside", now),
	];
	const expected = rows.map((row) => appendEnded(sequential, row, { nowMs: now }));
	assert.deepEqual(expected, [false, true, false, true, false, true, true]);
	const results = appendEndedBatch(batch, rows, { nowMs: now });
	assert.deepEqual(results.map(({ appended }) => appended), expected);
	for (const [i, { location }] of results.entries()) {
		if (!expected[i]) {
			assert.equal(location, null);
			continue;
		}
		const { file, offset, length } = location;
		const bytes = fs.readFileSync(file);
		assert.equal(JSON.parse(bytes.subarray(offset, offset + length)).sessionId, rows[i].sessionId);
		assert.equal(JSON.parse(bytes.subarray(offset, offset + length)).endedMs, rows[i].endedMs);
		assert.equal(bytes[offset + length], 10);
	}
	const names = fs.readdirSync(sequential.health.sessionsDir);
	assert.deepEqual(fs.readdirSync(batch.health.sessionsDir), names);
	for (const name of names) {
		assert.deepEqual(fs.readFileSync(path.join(batch.health.sessionsDir, name)), fs.readFileSync(path.join(sequential.health.sessionsDir, name)));
	}
});
