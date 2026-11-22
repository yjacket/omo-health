import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { readUsage } from "../src/collect/usage.mjs";
import { E, iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";
import { compactUsage, createUsageIndex, readUsageIndex, USAGE_TICK_BYTES } from "../src/usage-index.mjs";
import { endedRow } from "../src/ui/model.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { appendEnded, appendEndedLocated, ENDED_LOCATION, streamEnded } from "../src/session-ledger.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionSnapshot } from "../src/session-board.mjs";

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const DAY = 86_400_000;

const usage = (input, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, cost: { total: cost } });
const indexRow = (text) => JSON.parse(text.split("\n")[1]);
const writeIndexRow = (file, original, row) => fs.writeFileSync(file, `${original.split("\n")[0]}\n${JSON.stringify(row)}\n`);

function makeClock(start = T0) {
	let now = start;
	return { clock: { now: () => now }, advance: (ms) => (now += ms) };
}

function setup(prefix = "usage-tracker-", indexOptions = {}) {
	const root = tmpDir(prefix);
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	const { clock, advance } = makeClock();
	const events = [];
	const log = {
		info: (event, data) => events.push({ level: "info", event, data }),
		error: (event, data) => events.push({ level: "error", event, data }),
		warn: (event, data) => events.push({ level: "warn", event, data }),
	};
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock, log, ...indexOptions });
	const locator = createSessionFileLocator({ paths, clock, rescanMs: 0 });
	const tracker = createUsageTracker({ paths, index, locator, clock, log });
	// Every cwd is under this test's temp root; a real project path would let a store leak between runs.
	return { root, paths, clock, advance, events, log, index, locator, tracker, cwd: path.join(root, "proj") };
}

/** `<sessionsDir>/<slug>/<ts>_<id>.jsonl`, the shape the live collector and the locator agree on. */
function mainFile(paths, id) {
	return path.join(paths.sessionsDir, "proj", `2026-09-28T12-00-00-000Z_${id}.jsonl`);
}

/** `<cwd>/.omo/senpi-task/children/<taskId>/sessions/<taskId>/<ts>_<sessionId>.jsonl`. */
function childFile(cwd, taskId, sessionId) {
	return path.join(cwd, ".omo", "senpi-task", "children", taskId, "sessions", taskId, `2026-09-28T12-00-00-000Z_${sessionId}.jsonl`);
}

/** One JSONL record of at least `bytes` bytes, its usage in the message. */
function bigRecord(bytes, totals) {
	const entry = { type: "message", timestamp: iso(T0), message: { role: "assistant", provider: "p", model: "m", usage: totals, stopReason: "stop", content: "" } };
	const base = JSON.stringify(entry).length;
	entry.message.content = "x".repeat(Math.max(0, bytes - base));
	return JSON.stringify(entry);
}

function writeLines(file, lines) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

const emptyWorld = (clock) => makeWorld({ now: clock.now(), sessions: [] });

test("tracker tokens resolve by session id or by a unique task id when the session id is absent", () => {
	const s = setup();
	const file = childFile(s.cwd, "st_x", "child-a");
	writeLines(file, [bigRecord(0, usage(42))]);
	s.index.update("child-a", file, { kind: "child", taskId: "st_x" });
	assert.equal(s.tracker.tokensOf("child-a").tokens.total, 42);
	assert.deepEqual([s.tracker.tokensOf("child-b", "st_x"), s.tracker.tokensOf("st_x")], [null, null]);
	assert.equal(s.tracker.tokensOf(null, "st_x").tokens.total, 42);
});

test("board uses a unique task-only token match but never an ambiguous or wrong-session match", () => {
	const s = setup();
	const task = { taskId: "st_shared", parentSessionId: "main" };
	const first = taskRecord({ ...task, uid: "store-a/st_shared", spawnCwd: s.cwd, childSessionId: null });
	const second = taskRecord({ ...task, uid: "store-b/st_shared", spawnCwd: path.join(s.root, "other"), childSessionId: null });
	function indexChild({ spawnCwd, taskId }, id, total) {
		const file = childFile(spawnCwd, taskId, id);
		writeLines(file, [bigRecord(0, usage(total))]);
		s.index.update(id, file, { kind: "child", taskId });
	}
	function totals(tasks) {
		const world = makeWorld({
			now: T0,
			sessions: [sessionState({ id: "main", startedMs: T0 - 5000 })],
			tasks,
			sensors: [{ sessionId: "main", pid: 100, ts: T0 - 1000, idle: true, executingTools: 0 }],
			procsFresh: true,
		});
		const snapshot = buildSessionSnapshot(world, [], [], T0, { tokensOf: (sessionId, taskId) => s.tracker.tokensOf(sessionId, taskId) });
		return snapshot.groups[0].sessions[0].children.map((child) => child.tokens?.total ?? null);
	}
	indexChild(first, "indexed-a", 42);
	assert.deepEqual(totals([first, { ...second, childSessionId: "not-indexed" }]), [42, null]);
	indexChild(second, "indexed-b", 73);
	assert.deepEqual(totals([first, second]), [null, null]);
});

test("(gate 16) saturation marks uncounted rows full, logs once, and prune lets the backlog count again", (t) => {
	const s = setup("usage-full-");
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const longPath = "C:/" + "작".repeat(3571);
	for (let i = 0; i < 16000; i++) s.index.markMissing(`old${i}`, { file: longPath });
	s.locator.mainFile = () => longPath + "/next.jsonl";
	const rows = ["next", "later"].map((sessionId) => ({ sessionId, kind: "main", endedMs: T0 }));
	s.tracker.queueLedger(rows);
	s.tracker.tick(emptyWorld(s.clock));
	assert.deepEqual(s.tracker.tokensOf("next"), { state: "full" });
	s.tracker.queueLedger(rows);
	s.tracker.tick(emptyWorld(s.clock));
	assert.deepEqual(s.tracker.tokensOf("later"), { state: "full" });
	assert.equal(s.events.filter(({ event }) => event === "usage_index_full").length, 1);
	s.advance(46 * DAY);
	assert.ok(s.index.prune(s.clock.now()) > 0);
	s.tracker.queueLedger(rows);
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(s.index.get("next")?.state, "missing");
	assert.equal(s.tracker.tokensOf("next"), null);
});

test("a complete live session reads only appended bytes each tick", () => {
	const s = setup();
	const file = mainFile(s.paths, "m1");
	writeJsonl(file, [E.assistant({ ms: T0, usage: usage(10, 5) })]);
	const world = () => makeWorld({ now: s.clock.now(), sessions: [sessionState({ id: "m1", file, kind: "main", cwd: s.cwd })] });
	const first = s.tracker.tick(world());
	assert.equal(first.bytesRead, fs.statSync(file).size, "the first tick reads the whole first record");
	assert.equal(s.index.get("m1").complete, true);
	assert.equal(compactUsage(s.index.get("m1")).total, 15);

	const appended = `${JSON.stringify(E.assistant({ ms: T0 + 1000, usage: usage(7, 3) }))}\n`;
	fs.appendFileSync(file, appended);
	const second = s.tracker.tick(world());
	assert.equal(second.bytesRead, Buffer.byteLength(appended), "the second tick reads only the appended bytes");
	assert.equal(compactUsage(s.index.get("m1")).total, 25);
	assert.equal(s.index.get("m1").published.total, 25);
});

test("a live child attached to another session's file gets no tokens, and its row ends missing", () => {
	const s = setup();
	const parent = mainFile(s.paths, "p1");
	writeJsonl(parent, [E.assistant({ ms: T0, usage: usage(100) })]);
	const other = childFile(s.cwd, "st_c", "other");
	writeJsonl(other, [E.assistant({ ms: T0, usage: usage(999) })]);
	const world = makeWorld({
		now: s.clock.now(),
		sessions: [
			sessionState({ id: "p1", file: parent, kind: "main", cwd: s.cwd }),
			// The live collector's newest-file fallback gave this child another session's file.
			sessionState({ id: "c1", file: other, kind: "child", taskId: "st_c", parentSessionId: "p1", cwd: s.cwd }),
		],
	});
	s.tracker.queueLedger([{ sessionId: "c1", kind: "child", taskId: "st_c", parentSessionId: "p1", cwd: s.cwd, endedMs: T0 }]);
	s.tracker.tick(world);
	assert.equal(s.index.get("c1").state, "missing", "the backlog found no exact child file");
	assert.equal(s.index.has("other"), false, "the other session's file was never indexed");
	assert.equal(compactUsage(s.index.get("p1")).total, 100);
	assert.equal(s.tracker.tokensOf("p1").treeTokens, null, "the parent's tree total excludes the mismatched child");
	assert.equal(s.tracker.tokensOf("c1"), null);
});

test("a tick never reads more than the byte budget: a 40 MiB live record waits while a backlog waits", () => {
	const s = setup();
	const live = mainFile(s.paths, "m1");
	writeJsonl(live, [E.assistant({ ms: T0, usage: usage(10) })]);
	const backlog = mainFile(s.paths, "b1");
	writeJsonl(backlog, [E.assistant({ ms: T0, usage: usage(5) })]);
	const world = makeWorld({ now: s.clock.now(), sessions: [sessionState({ id: "m1", file: live, kind: "main", cwd: s.cwd })] });
	s.tracker.tick(world);
	assert.equal(compactUsage(s.index.get("m1")).total, 10);

	fs.appendFileSync(live, `${bigRecord(40 * 1024 * 1024, usage(1000))}\n`);
	s.tracker.queueLedger([{ sessionId: "b1", kind: "main", cwd: s.cwd, endedMs: T0 }]);
	const first = s.tracker.tick(world);
	assert.equal(first.bytesRead, USAGE_TICK_BYTES, "the whole budget went to the live append");
	assert.equal(s.index.get("m1").complete, true);
	assert.equal(compactUsage(s.index.get("m1")).total, 10, "the previous total stays while the record is partial");
	assert.equal(s.index.has("b1"), false, "the backlog got nothing this tick");

	const second = s.tracker.tick(world);
	assert.ok(second.bytesRead <= USAGE_TICK_BYTES);
	assert.equal(compactUsage(s.index.get("m1")).total, 1010, "the full record counts once it completes");
	assert.equal(compactUsage(s.index.get("b1")).total, 5);
});

test("a 32 MiB budget drains three 20 MiB files in two ticks and logs usage_backlog once after saving", () => {
	const s = setup();
	const rows = [];
	for (let i = 1; i <= 3; i += 1) {
		writeLines(mainFile(s.paths, `f${i}`), [bigRecord(20 * 1024 * 1024, usage(100 * i))]);
		rows.push({ sessionId: `f${i}`, kind: "main", cwd: s.cwd, endedMs: T0 + i });
	}
	s.tracker.queueLedger(rows);
	const first = s.tracker.tick(emptyWorld(s.clock));
	assert.equal(first.bytesRead, USAGE_TICK_BYTES);
	assert.equal(s.events.filter((e) => e.event === "usage_backlog").length, 0, "the backlog is not empty yet");
	assert.equal(fs.existsSync(s.paths.health.usageIndexFile), false, "the index is not saved before the backlog empties");

	const second = s.tracker.tick(emptyWorld(s.clock));
	assert.ok(second.bytesRead <= USAGE_TICK_BYTES);
	assert.deepEqual([1, 2, 3].map((i) => compactUsage(s.index.get(`f${i}`)).total), [100, 200, 300]);
	const logged = s.events.filter((e) => e.event === "usage_backlog");
	assert.equal(logged.length, 1, "usage_backlog is logged once");
	assert.deepEqual(logged[0].data, { indexed: 3, missing: 0 });
	const saved = readUsageIndex(s.paths.health.usageIndexFile);
	assert.equal(saved.get("f3").complete, true, "the log came after the save");
});

test("a 96 MiB file shows pending for three ticks, then its full total", () => {
	const s = setup();
	const lines = [];
	for (let i = 0; i < 96; i += 1) lines.push(bigRecord(1024 * 1024, usage(10)));
	writeLines(mainFile(s.paths, "big"), lines);
	s.tracker.queueLedger([{ sessionId: "big", kind: "main", cwd: s.cwd, endedMs: T0 }]);
	for (let i = 0; i < 3; i += 1) {
		const tick = s.tracker.tick(emptyWorld(s.clock));
		assert.ok(tick.bytesRead <= USAGE_TICK_BYTES);
		assert.equal(compactUsage(s.index.get("big")), null, `tick ${i + 1} shows no partial total`);
		assert.deepEqual(s.tracker.tokensOf("big"), { pending: true });
	}
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(compactUsage(s.index.get("big")).total, 960);
	assert.equal(s.tracker.tokensOf("big").tokens.total, 960);
	assert.equal(s.tracker.tokensOf("big").treeTokens, null);
});

test("(gate 10) a previously published ended file stays queued through three reads", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const file = mainFile(s.paths, "ended");
	const record = '{"type":"usage","usage":{"input":1}}';
	const row = { sessionId: "ended", kind: "main", cwd: s.cwd, endedMs: T0 };
	writeLines(file, [record]);
	s.index.update(row.sessionId, file);
	const previous = s.tracker.tokensOf(row.sessionId).tokens;
	assert.equal(previous.total, 1);

	// The gate witness uses a million records; pad them so reaching EOF takes three byte budgets.
	const block = `${record.padEnd(74)}\n`.repeat(10_000);
	for (let i = 0; i < 100; i += 1) fs.appendFileSync(file, block);
	assert.equal(s.tracker.queueLedger([row]), 1);
	const size = fs.statSync(file).size;
	const world = emptyWorld(s.clock);
	for (let i = 1; i <= 2; i += 1) {
		assert.equal(s.tracker.tick(world).bytesRead, USAGE_TICK_BYTES, `tick ${i}`);
		assert.deepEqual(s.tracker.tokensOf(row.sessionId).tokens, previous);
		assert.equal(s.events.some(({ event }) => event === "usage_backlog"), false, `tick ${i} has not drained the queue`);
	}
	assert.equal(s.tracker.tick(world).bytesRead, size - Buffer.byteLength(record) - 1 - 2 * USAGE_TICK_BYTES);
	assert.equal(s.index.fresh(s.index.get(row.sessionId)), true);
	assert.equal(s.tracker.tokensOf(row.sessionId).tokens.total, 1_000_001);
	assert.equal(s.tracker.tokensOf(row.sessionId).tokens.total, readUsage(file).effective.total);
	assert.equal(s.events.filter(({ event }) => event === "usage_backlog").length, 1);
	assert.equal(s.tracker.tick(world).bytesRead, 0, "EOF drains the queue");
});

test("(gate 10) a queued file that grows after publication drains through its new end", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const file = mainFile(s.paths, "growing");
	const row = { sessionId: "growing", kind: "main", cwd: s.cwd, endedMs: T0 };
	const world = emptyWorld(s.clock);
	writeLines(file, [bigRecord(34 * 1024 * 1024, usage(7))]);
	assert.equal(s.tracker.queueLedger([row]), 1);
	assert.equal(s.tracker.tick(world).bytesRead, USAGE_TICK_BYTES);
	assert.equal(s.tracker.tokensOf(row.sessionId).pending, true);

	// A live read can publish the file while its ledger row is still queued.
	s.index.update(row.sessionId, file);
	assert.equal(s.tracker.tokensOf(row.sessionId).tokens.total, 7);
	const appended = `${bigRecord(34 * 1024 * 1024, usage(3))}\n`;
	fs.appendFileSync(file, appended);
	assert.equal(s.tracker.tick(world).bytesRead, USAGE_TICK_BYTES);
	assert.equal(s.tracker.tokensOf(row.sessionId).tokens.total, 7);
	assert.equal(s.tracker.tick(world).bytesRead, Buffer.byteLength(appended) - USAGE_TICK_BYTES);
	assert.equal(s.tracker.tokensOf(row.sessionId).tokens.total, 10);
	assert.equal(s.index.fresh(s.index.get(row.sessionId)), true);
	assert.equal(s.tracker.tick(world).bytesRead, 0);
});

test("a completed backlog file deleted after its read keeps the published total and marks the row gone", () => {
	const s = setup();
	const file = mainFile(s.paths, "d1");
	writeJsonl(file, [E.assistant({ ms: T0, usage: usage(42) })]);
	const row = { sessionId: "d1", kind: "main", cwd: s.cwd, endedMs: T0 };
	s.tracker.queueLedger([row]);
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(compactUsage(s.index.get("d1")).total, 42);

	// The locator now finds no path at all, the shape of a deleted file (not a null read).
	fs.rmSync(file);
	s.tracker.queueLedger([row]);
	assert.equal(s.tracker.tick(emptyWorld(s.clock)).bytesRead, 0);
	const entry = s.index.get("d1");
	assert.equal(entry.state, "ok");
	assert.equal(entry.complete, true);
	assert.equal(entry.gone, true);
	assert.equal(compactUsage(entry).total, 42);
	assert.equal(s.tracker.tokensOf("d1").tokens.total, 42);

	const dashboard = endedRow({ sessionId: "d1", kind: "main", startedMs: T0 - 1000, endedMs: T0 }, 0, new Map([["d1", entry]]));
	assert.equal(dashboard.tokensState, "ok");
	assert.equal(dashboard.tokens.total, 42);
	assert.equal(dashboard.tokensGone, true);
	assert.equal(s.tracker.queueLedger([row]), 0, "a gone row is not retried again the same day");

	// A row whose file was never found is the only one that reads missing.
	s.tracker.queueLedger([{ sessionId: "never", kind: "main", cwd: s.cwd, endedMs: T0 }]);
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(s.index.get("never").state, "missing");
	assert.equal(s.index.get("never").complete, false);
	assert.equal(s.tracker.tokensOf("never"), null);
	const neverRow = endedRow({ sessionId: "never", kind: "main", startedMs: T0 - 1000, endedMs: T0 }, 0, new Map([["never", s.index.get("never")]]));
	assert.equal(neverRow.tokensState, "missing");
	assert.equal(neverRow.tokens, null);
});

test("a missing child is retried after a day of fake clock on the next queueLedger", () => {
	const s = setup();
	const row = { sessionId: "c9", kind: "child", taskId: "st_9", parentSessionId: "p9", cwd: s.cwd, endedMs: T0 };
	appendEnded(s.paths, row, { nowMs: T0 });
	s.tracker.queueLedger([row]);
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(s.index.get("c9").state, "missing");
	const checked = s.index.get("c9").checkedMs;

	s.tracker.queueLedger([row]);
	assert.equal(s.tracker.tick(emptyWorld(s.clock)).bytesRead, 0, "too soon: the missing row is not retried");
	assert.equal(s.index.get("c9").checkedMs, checked);

	writeJsonl(childFile(s.cwd, "st_9", "c9"), [E.assistant({ ms: T0, usage: usage(42) })]);
	s.advance(DAY + 1);
	s.tracker.queueLedger(streamEnded(s.paths, { withLocation: true }));
	const tick = s.tracker.tick(emptyWorld(s.clock));
	assert.ok(tick.bytesRead > 0);
	assert.equal(compactUsage(s.index.get("c9")).total, 42);
	assert.ok(s.index.get("c9").checkedMs > checked);
});

test("an ended file that grew after a complete read is requeued and its tree total follows", () => {
	const s = setup();
	const parent = mainFile(s.paths, "p1");
	writeJsonl(parent, [E.assistant({ ms: T0, usage: usage(10) })]);
	writeJsonl(childFile(s.cwd, "st_c", "c1"), [E.assistant({ ms: T0, usage: usage(5) })]);
	const parentRow = { sessionId: "p1", kind: "main", cwd: s.cwd, endedMs: T0 + 10 };
	const childRow = { sessionId: "c1", kind: "child", taskId: "st_c", parentSessionId: "p1", endedMs: T0 + 20 };
	for (const row of [parentRow, childRow]) appendEnded(s.paths, row, { nowMs: T0 });
	s.tracker.queueLedger(streamEnded(s.paths, { withLocation: true }));
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(s.tracker.tokensOf("p1").treeTokens, 15);

	const appended = `${JSON.stringify(E.assistant({ ms: T0 + 1000, usage: usage(7) }))}\n`;
	fs.appendFileSync(parent, appended);
	s.tracker.queueLedger([parentRow]);
	const tick = s.tracker.tick(emptyWorld(s.clock));
	assert.equal(tick.bytesRead, Buffer.byteLength(appended));
	assert.equal(compactUsage(s.index.get("p1")).total, 17);
	assert.equal(s.tracker.tokensOf("p1").treeTokens, 22);
});

test("a restart resumes an interrupted file from the saved offset instead of recounting it", () => {
	const s = setup();
	const file = mainFile(s.paths, "r1");
	writeLines(file, [bigRecord(12 * 1024 * 1024, usage(100)), bigRecord(12 * 1024 * 1024, usage(200)), bigRecord(12 * 1024 * 1024, usage(300))]);
	const row = { sessionId: "r1", kind: "main", cwd: s.cwd, endedMs: T0 };
	s.tracker.queueLedger([row]);
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(s.index.get("r1").complete, false);
	s.index.save();
	const savedOffset = readUsageIndex(s.paths.health.usageIndexFile).get("r1").offset;
	assert.ok(savedOffset > 0, "the offset of the last complete record is persisted");

	const index = createUsageIndex({ file: s.paths.health.usageIndexFile, clock: s.clock, log: s.log });
	const locator = createSessionFileLocator({ paths: s.paths, clock: s.clock, rescanMs: 0 });
	const tracker = createUsageTracker({ paths: s.paths, index, locator, clock: s.clock, log: s.log });
	tracker.queueLedger([row]);
	const tick = tracker.tick(emptyWorld(s.clock));
	assert.equal(tick.bytesRead, fs.statSync(file).size - savedOffset, "only the bytes after the persisted offset are read");
	assert.equal(index.get("r1").complete, true);
	assert.equal(compactUsage(index.get("r1")).total, 600);
});

test("(gate 11) a previous-writer row with a null overflowed total is recounted from the session", (t) => {
	const s = setup();
	const id = "v1-overflow";
	const file = mainFile(s.paths, id);
	// 1e308 + 1e308 = Infinity; the previous writer's JSON.stringify stored it as null.
	writeLines(file, ['{"type":"usage","usage":{"input":1e308,"output":1e308}}']);
	s.index.update(id, file);
	s.index.save();
	const nullTags = (value) => {
		if (Array.isArray(value)) return value.map(nullTags);
		if (value && typeof value === "object") {
			if (Object.keys(value).length === 1 && typeof value.$n === "string") return null;
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullTags(item)]));
		}
		return value;
	};
	const previous = { v: 1, entries: { [id]: nullTags(indexRow(fs.readFileSync(s.paths.health.usageIndexFile, "utf8"))) } };
	fs.writeFileSync(s.paths.health.usageIndexFile, JSON.stringify(previous));

	const index = createUsageIndex({ file: s.paths.health.usageIndexFile, clock: s.clock, log: s.log });
	const locator = createSessionFileLocator({ paths: s.paths, clock: s.clock, rescanMs: 0 });
	const tracker = createUsageTracker({ paths: s.paths, index, locator, clock: s.clock, log: s.log });
	const row = { sessionId: id, kind: "main", cwd: s.cwd, endedMs: T0 };
	assert.deepEqual(index.entries(), [], "the legacy file starts empty");
	assert.equal(readUsageIndex(s.paths.health.usageIndexFile).size, 0);

	assert.equal(tracker.queueLedger([row]), 1, "the row needs a recount");
	tracker.tick(emptyWorld(s.clock));
	assert.equal(compactUsage(index.get(id)).total, readUsage(file).effective.total);
	assert.equal(compactUsage(index.get(id)).total, Infinity);

	fs.appendFileSync(file, '{"type":"usage","usage":{"input":3}}\n');
	assert.equal(tracker.queueLedger([row]), 1);
	tracker.tick(emptyWorld(s.clock));
	assert.equal(compactUsage(index.get(id)).total, Infinity, "an append keeps the overflowing total");
	assert.equal(index.save(), true);
	assert.equal(compactUsage(readUsageIndex(s.paths.health.usageIndexFile).get(id)).total, Infinity, "the repaired row reloads as Infinity");
});

test("(gate 12) malformed numeric fields keep a row pending until the tracker recounts it", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const id = "malformed";
	const file = mainFile(s.paths, id);
	writeJsonl(file, [E.assistant({ ms: T0, usage: usage(42) })]);
	s.index.update(id, file);
	s.index.save();
	const savedText = fs.readFileSync(s.paths.health.usageIndexFile, "utf8");
	const cases = [
		["published.total null", (entry) => { entry.published.total = null; }],
		["tag with an extra field", (entry) => { entry.published.total = { $n: "Infinity", extra: true }; }],
		["malformed tag", (entry) => { entry.published.total = { $n: "Bogus" }; }],
		["string numeric field", (entry) => { entry.published.input = "number:Infinity"; }],
	];
	const row = { sessionId: id, kind: "main", cwd: s.cwd, endedMs: T0 };
	for (const [name, mutate] of cases) {
		const data = indexRow(savedText);
		mutate(data);
		writeIndexRow(s.paths.health.usageIndexFile, savedText, data);
		const index = createUsageIndex({ file: s.paths.health.usageIndexFile, clock: s.clock, log: s.log });
		const loaded = index.get(id);
		assert.equal(loaded.offset, 0, name);
		assert.equal(loaded.complete, false, name);
		assert.equal(compactUsage(loaded), null, name);
		assert.equal(index.fresh(loaded), false, name);

		const locator = createSessionFileLocator({ paths: s.paths, clock: s.clock, rescanMs: 0 });
		const tracker = createUsageTracker({ paths: s.paths, index, locator, clock: s.clock, log: s.log });
		assert.equal(tracker.queueLedger([row]), 1, `${name} needs a recount`);
		tracker.tick(emptyWorld(s.clock));
		assert.equal(compactUsage(index.get(id)).total, readUsage(file).effective.total, name);
		assert.equal(compactUsage(index.get(id)).total, 42, name);
	}
});

for (const treeName of ["usage", "published"]) {
		test(`(gate 13) missing ${treeName}.total stays pending and recounts through an append`, (t) => {
			const s = setup();
			t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
			const id = "omitted";
			const file = mainFile(s.paths, id);
			const indexFile = s.paths.health.usageIndexFile;
			writeJsonl(file, [E.assistant({ ms: T0, usage: usage(42) })]);
			s.index.update(id, file);
			s.index.save();
			const saved = fs.readFileSync(indexFile, "utf8");
			const entry = indexRow(saved);
			delete entry[treeName].total;
			writeIndexRow(indexFile, saved, entry);

			const index = createUsageIndex({ file: indexFile, clock: s.clock, log: s.log });
			const tracker = createUsageTracker({ paths: s.paths, index, locator: s.locator, clock: s.clock, log: s.log });
			const row = { sessionId: id, kind: "main", cwd: s.cwd, endedMs: T0 };
			assert.equal(compactUsage(readUsageIndex(indexFile).get(id)), null);
			assert.deepEqual(tracker.tokensOf(id), { pending: true });
			assert.equal(tracker.queueLedger([row]), 1);
			assert.equal(endedRow(row, 0, readUsageIndex(indexFile)).tokensState, "pending");

			fs.appendFileSync(file, `${JSON.stringify(E.assistant({ ms: T0 + 1000, usage: usage(3) }))}\n`);
			assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, fs.statSync(file).size);
			assert.equal(tracker.tokensOf(id).tokens.total, 45);
			assert.equal(endedRow(row, 0, readUsageIndex(indexFile)).tokens.total, readUsage(file).effective.total);
		});
}

test("(gate 14) deletion of each written field unpublishes the row until a one-shot-equivalent recount", async (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const id = "omissions";
	const file = mainFile(s.paths, id);
	const indexFile = s.paths.health.usageIndexFile;
	const hit = JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(42) } });
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${hit}\n${hit}`); // Populate both committed usage and the EOF overlay.
	s.index.update(id, file, { kind: "main", taskId: "alias", parentSessionId: "parent", rootSessionId: "root" });
	s.index.save();
	const saved = fs.readFileSync(indexFile, "utf8");
	const fields = (node, prefix = []) => Object.entries(node).flatMap(([key, value]) => {
		const field = [...prefix, key];
		return [field, ...(key !== "usedModels" && value && typeof value === "object" ? fields(value, field) : [])];
	});
	const row = { sessionId: id, kind: "main", endedMs: T0 };
	const expected = readUsage(file).effective;
	assert.equal(expected.total, 84);
	// Deleting a whole model entry leaves a well-formed row with a wrong value, which the plan (IS-1) puts out of scope
	// since the sum check was dropped (floating-point order); its leaves are still covered below.
	for (const field of fields(indexRow(saved)).filter((path) => path.at(-2) !== "models")) {
		await t.test(field.join("."), () => {
			const data = indexRow(saved);
			const object = field.slice(0, -1).reduce((node, key) => node[key], data);
			delete object[field.at(-1)];
			writeIndexRow(indexFile, saved, data);
			const loaded = readUsageIndex(indexFile);
			const index = createUsageIndex({ file: indexFile, clock: s.clock, log: s.log });
			const tracker = createUsageTracker({ paths: s.paths, index, locator: s.locator, clock: s.clock, log: s.log });
			assert.equal(endedRow(row, 0, loaded).tokensState, "pending");
			// A v3 line without its id cannot be attributed to a session, so it is dropped: the session is unindexed, not pending.
			assert.deepEqual(tracker.tokensOf(id), field.join(".") === "id" ? null : { pending: true });
			assert.equal(tracker.queueLedger([row]), 1);
			assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, fs.statSync(file).size);
			assert.deepEqual(readUsageIndex(indexFile).get(id).published, expected);
		});
	}
});

for (const v of [1, 2]) {
	test(`(gate 15) a v${v} index starts empty and the tracker recounts`, (t) => {
		const s = setup();
		t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
		const id = "legacy";
		const file = mainFile(s.paths, id);
		const indexFile = s.paths.health.usageIndexFile;
		writeJsonl(file, [E.assistant({ ms: T0, usage: usage(42) })]);
		s.index.update(id, file);
		s.index.save();
		const entry = indexRow(fs.readFileSync(indexFile, "utf8"));
		fs.writeFileSync(indexFile, JSON.stringify({ v, entries: { [id]: entry } }));

		const index = createUsageIndex({ file: indexFile, clock: s.clock, log: s.log });
		const tracker = createUsageTracker({ paths: s.paths, index, locator: s.locator, clock: s.clock, log: s.log });
		assert.equal(readUsageIndex(indexFile).size, 0);
		assert.deepEqual(index.entries(), []);
		assert.equal(tracker.queueLedger([{ sessionId: id, kind: "main", endedMs: T0 }]), 1);
		assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, fs.statSync(file).size);
		assert.equal(compactUsage(readUsageIndex(indexFile).get(id)).total, readUsage(file).effective.total);
	});
}

test("(gate 15) fractional writer output is accepted and published after recount", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const id = "fraction";
	const file = mainFile(s.paths, id);
	const indexFile = s.paths.health.usageIndexFile;
	writeJsonl(file, [[2 ** 52, "a"], [0.5, "b"], [0.5, "b"]].map(([input, model]) =>
		({ type: "usage", provider: "p", model, usage: { input, cost: { total: 1 } } })));
	const index = createUsageIndex({ file: indexFile, clock: s.clock, log: s.log });
	const tracker = createUsageTracker({ paths: s.paths, index, locator: s.locator, clock: s.clock, log: s.log });
	const row = { sessionId: id, kind: "main", endedMs: T0 };
	assert.equal(tracker.queueLedger([row]), 1);
	assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, fs.statSync(file).size);
	const loaded = readUsageIndex(indexFile);
	assert.deepEqual(loaded.get(id).published, readUsage(file).effective);
	assert.equal(endedRow(row, 0, loaded).tokensState, "ok");
	assert.equal(endedRow(row, 0, loaded).tokens.total, 2 ** 52);
	assert.equal(loaded.get(id).published.models["p/b"].tokens, 1);
});

test("a child of a child is located through its grandparent's cwd", () => {
	const s = setup();
	writeJsonl(childFile(s.cwd, "st_mid", "mid1"), [E.assistant({ ms: T0, usage: usage(3) })]);
	writeJsonl(childFile(s.cwd, "st_deep", "deep1"), [E.assistant({ ms: T0, usage: usage(4) })]);
	for (const row of [
		{ sessionId: "root1", kind: "main", cwd: s.cwd, endedMs: T0 },
		{ sessionId: "mid1", kind: "child", taskId: "st_mid", parentSessionId: "root1", endedMs: T0 + 1 },
		{ sessionId: "deep1", kind: "child", taskId: "st_deep", parentSessionId: "mid1", cwd: null, endedMs: T0 + 2 },
	]) appendEnded(s.paths, row, { nowMs: T0 });
	s.tracker.queueLedger(streamEnded(s.paths, { withLocation: true }));
	s.tracker.tick(emptyWorld(s.clock));
	assert.equal(compactUsage(s.index.get("deep1")).total, 4);
	assert.equal(s.tracker.tokensOf("mid1").treeTokens, 7);
});

test("a read failure keeps tokensOf null with one log, and the next success restores the total", () => {
	let failingReads = 0;
	const s = setup("usage-tracker-busy-", {
		read: (file, from, options) => {
			if (failingReads > 0) {
				failingReads -= 1;
				const error = new Error("EBUSY: resource busy or locked, open");
				error.code = "EBUSY";
				throw error;
			}
			return readUsage(file, from, options);
		},
	});
	const file = mainFile(s.paths, "m1");
	writeJsonl(file, [E.assistant({ ms: T0, usage: usage(10, 5) })]);
	const world = () => makeWorld({ now: s.clock.now(), sessions: [sessionState({ id: "m1", file, kind: "main", cwd: s.cwd })] });
	s.tracker.tick(world());
	assert.equal(s.tracker.tokensOf("m1").tokens.total, 15);

	const appended = `${JSON.stringify(E.assistant({ ms: T0 + 1000, usage: usage(7, 3) }))}\n`;
	fs.appendFileSync(file, appended);
	failingReads = 2;
	assert.equal(s.tracker.tick(world()).bytesRead, 0);
	assert.equal(s.tracker.tokensOf("m1"), null, "a read failure shows no tokens (IS-12)");
	assert.equal(s.events.filter((event) => event.event === "usage_read_failed").length, 1);

	assert.equal(s.tracker.tick(world()).bytesRead, 0);
	assert.equal(s.tracker.tokensOf("m1"), null, "the second failure still shows no tokens");
	assert.equal(s.events.filter((event) => event.event === "usage_read_failed").length, 1, "one failure streak logs once");

	assert.equal(s.tracker.tick(world()).bytesRead, Buffer.byteLength(appended));
	assert.equal(s.tracker.tokensOf("m1").tokens.total, 25, "the next success restores the total");
	assert.equal(s.events.filter((event) => event.event === "usage_read_failed").length, 1);
});

test("tokensOf reports treeTokens only when a descendant pushes the tree above the session's own total", () => {
	const s = setup();
	writeLines(mainFile(s.paths, "p2"), [JSON.stringify(E.assistant({ ms: T0, usage: usage(10) }))]);
	writeJsonl(childFile(s.cwd, "st_x", "c2"), [E.assistant({ ms: T0, usage: usage(6) })]);
	for (const row of [
		{ sessionId: "p2", kind: "main", cwd: s.cwd, endedMs: T0 + 1 },
		{ sessionId: "c2", kind: "child", taskId: "st_x", parentSessionId: "p2", cwd: s.cwd, endedMs: T0 + 2 },
	]) {
		appendEnded(s.paths, row, { nowMs: T0 });
		s.tracker.queueLedger([row]);
	}
	s.tracker.tick(emptyWorld(s.clock));
	assert.deepEqual(s.tracker.tokensOf("p2"), { tokens: compactUsage(s.index.get("p2")), treeTokens: 16 });
	assert.deepEqual(s.tracker.tokensOf("c2"), { tokens: compactUsage(s.index.get("c2")), treeTokens: null });
});

test("sparse queued children recover ledger-only cwds in one pass per needed day", (t) => {
	const s = setup("usage-tracker-sparse-");
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const files = new Map();
	const reads = new Map();
	const positionedBytes = new Map();
	const tracker = createUsageTracker({ paths: s.paths, index: s.index, locator: s.locator, clock: s.clock, ledgerFs: {
		...fs,
		openSync(file, ...args) {
			const fd = fs.openSync(file, ...args);
			files.set(fd, file);
			return fd;
		},
		readSync(fd, ...args) {
			const n = fs.readSync(fd, ...args);
			const file = files.get(fd);
			const counts = args[3] === null ? reads : positionedBytes;
			counts.set(file, (counts.get(file) ?? 0) + n);
			return n;
		},
	} });
	const rows = [];
	const dayBytes = new Map();
	for (const [i, total] of [42, 7, null, 19].entries()) {
		const sessionId = `sparse-${i}`;
		const taskId = `st_sparse_${i}`;
		const cwd = path.join(s.cwd, `proj-${i}`);
		const row = { sessionId, taskId, kind: "child", endedMs: i === 3 ? T0 - DAY : T0 + i };
		const { location } = appendEndedLocated(s.paths, { ...row, cwd }, { nowMs: T0 });
		dayBytes.set(location.file, fs.statSync(location.file).size);
		if (total !== null) writeJsonl(childFile(cwd, taskId, sessionId), [E.assistant({ ms: T0, usage: usage(total) })]);
		rows.push(row);
	}
	appendEnded(s.paths, { sessionId: "unrelated", cwd: s.cwd, endedMs: T0 - 2 * DAY }, { nowMs: T0 });
	assert.equal(tracker.queueLedger(rows), 4);
	const tick = tracker.tick(emptyWorld(s.clock));
	const totals = rows.map(({ sessionId }) => tracker.tokensOf(sessionId)?.tokens?.total ?? null);
	t.diagnostic(`totals=${JSON.stringify(totals)}, ledger bytes by day=${JSON.stringify([...reads.values()])}`);
	assert.deepEqual(totals, [42, 7, null, 19]);
	assert.equal(tick.missing, 1);
	assert.deepEqual(reads, dayBytes);
	for (const [file, bytes] of positionedBytes) assert.ok(bytes < dayBytes.get(file));
});

test("sparse children queued once use only positioned ledger reads after the first tick", (t) => {
	const s = setup("usage-tracker-sparse-drain-");
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const rows = [];
	const positions = [];
	const seed = appendEndedLocated(s.paths, { sessionId: "seed", endedMs: T0, title: "x" }, { nowMs: T0 }).location;
	fs.appendFileSync(seed.file, `${JSON.stringify({ sessionId: "padding", endedMs: T0, reason: "x".repeat(128 * 1024) })}\n`);
	const fullLine = '{"x":"' + "x".repeat(65527) + '"}\n';
	const usageLine = '{"type":"usage","usage":{"input":42}}\n';
	for (let i = 0; i < 4; i++) {
		const row = { sessionId: `sparse-${i}`, taskId: `st_sparse_${i}`, kind: "child", endedMs: T0 - i };
		const cwd = path.join(s.cwd, `proj-${i}`);
		positions.push(appendEndedLocated(s.paths, { ...row, cwd }, { nowMs: T0 }).location);
		rows.push(row);
		writeLines(childFile(cwd, row.taskId, row.sessionId), [
			fullLine.repeat(511) + fullLine.slice(0, -usageLine.length - 3) + '"}\n' + usageLine.slice(0, -1),
		]);
	}
	rows.push({ sessionId: "absent", taskId: "st_absent", kind: "child", endedMs: T0 - 5 });
	const reads = [];
	const tracker = createUsageTracker({ paths: s.paths, index: s.index, locator: s.locator, clock: s.clock, ledgerFs: {
		...fs,
		readSync(fd, buffer, offset, length, position) {
			const n = fs.readSync(fd, buffer, offset, length, position);
			if (n) reads.push({ n, position });
			return n;
		},
	} });
	assert.equal(tracker.queueLedger(rows), 5);
	const ledgerSize = fs.statSync(seed.file).size;
	const ledgerReads = [];
	for (let i = 0; i < 5; i++) {
		reads.length = 0;
		const tick = tracker.tick(emptyWorld(s.clock));
		assert.equal(tick.indexed, Math.min(i + 1, 4));
		assert.equal(tick.bytesRead, i < 4 ? USAGE_TICK_BYTES : 0);
		ledgerReads.push([...reads]);
	}
	assert.deepEqual(rows.slice(0, 4).map(({ sessionId }) => tracker.tokensOf(sessionId)?.tokens?.total), [42, 42, 42, 42]);
	assert.deepEqual(ledgerReads.map((reads) => reads.filter(({ position }) => position === null).reduce((n, read) => n + read.n, 0)),
		[ledgerSize, 0, 0, 0, 0]);
	for (let i = 1; i < 4; i++) {
		assert.deepEqual(ledgerReads[i], [{ n: positions[i].length, position: positions[i].offset }]);
	}
	assert.deepEqual(ledgerReads[4], []);
});

test("(gate 20) a 128-child live burst reads each appended ledger line once, not the whole day", (t) => {
	const s = setup("usage-tracker-live128-");
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	// A populated day makes the old per-child day scan unmistakable.
	const dayFile = path.join(s.paths.sessionsDir, "ended-2026-09-28.jsonl");
	fs.mkdirSync(s.paths.sessionsDir, { recursive: true });
	fs.writeFileSync(dayFile, `${JSON.stringify({ sessionId: "seed", kind: "main", endedMs: T0 - 1000, cwd: s.cwd, reason: "x".repeat(128 * 1024) })}\n`);
	let ledgerBytes = 0;
	const countingFs = {
		...fs,
		readSync(...args) {
			const read = fs.readSync(...args);
			ledgerBytes += read;
			return read;
		},
	};
	const tracker = createUsageTracker({ paths: s.paths, index: s.index, locator: s.locator, clock: s.clock, log: s.log, ledgerFs: countingFs });
	const updates = new Map();
	const update = s.index.update.bind(s.index);
	s.index.update = (id, ...args) => {
		updates.set(id, (updates.get(id) ?? 0) + 1);
		return update(id, ...args);
	};

	const count = 128;
	const lineBytes = [];
	for (let i = 0; i < count; i += 1) {
		const sessionId = `child-${i}`;
		const taskId = `st_${i}`;
		const cwd = path.join(s.root, "proj", `case-${i}`);
		writeJsonl(childFile(cwd, taskId, sessionId), [E.assistant({ ms: T0, usage: usage(i + 1) })]);
		const record = { sessionId, kind: "child", taskId, parentSessionId: null, cwd, endedMs: T0 + i };
		const { appended, location } = appendEndedLocated(s.paths, record, { nowMs: T0 });
		assert.equal(appended, true, `child-${i} appended`);
		lineBytes.push(location.length);
		// The daemon's live shape: the record plus the position of the line it just wrote.
		tracker.queueLedger([{ ...record, [ENDED_LOCATION]: location }]);
	}
	const lineTotal = lineBytes.reduce((sum, bytes) => sum + bytes, 0);

	ledgerBytes = 0;
	const tick = tracker.tick(emptyWorld(s.clock));
	assert.ok(lineTotal > 0);
	assert.equal(ledgerBytes, lineTotal, `tracker read ${ledgerBytes} ledger bytes for ${lineTotal} located line bytes`);
	assert.equal(tick.missing, 0);
	for (let i = 0; i < count; i += 1) {
		const sessionId = `child-${i}`;
		const entry = s.index.get(sessionId);
		assert.equal(entry?.state, "ok", sessionId);
		assert.equal(compactUsage(entry).total, i + 1, sessionId);
		assert.equal(entry.file, childFile(path.join(s.root, "proj", `case-${i}`), `st_${i}`, sessionId), `${sessionId} resolved its own directory`);
		assert.equal(updates.get(sessionId), 1, `${sessionId} indexed exactly once`);
	}
});
