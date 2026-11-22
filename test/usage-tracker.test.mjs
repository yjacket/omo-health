import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { SessionRegistry } from "../src/collect/sessions.mjs";
import { readUsage, usageTimeline } from "../src/collect/usage.mjs";
import { E, iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";
import { compactUsage, createUsageIndex, readUsageIndex, USAGE_TICK_BYTES } from "../src/usage-index.mjs";
import * as usageIndex from "../src/usage-index.mjs";
import { endedRow } from "../src/ui/model.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { backfillOnce } from "../src/session-backfill.mjs";
import { appendEnded, appendEndedLocated, ENDED_LOCATION, streamEnded } from "../src/session-ledger.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionSnapshot, detectEnded } from "../src/session-board.mjs";

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const DAY = 86_400_000;
const HEADER_BYTES = 64 * 1024;

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

function singleRecordModelOracle(file) {
	const { message } = JSON.parse(fs.readFileSync(file, "utf8"));
	const { input, output, cacheRead, cacheWrite, cost } = message.usage;
	return { [`${message.provider}/${String(message.model)}`]: {
		input, output, cacheRead, cacheWrite, tokens: input + output + cacheRead + cacheWrite, cost: cost.total,
	} };
}

test("(IS-2, IS-12) four medium live fragments publish together after an eight-byte append", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const bytes = 10 * 1024 * 1024;
	const sessions = Array.from({ length: 4 }, (_, i) => {
		const id = `resume-${i}`;
		const file = mainFile(s.paths, id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, bigRecord(bytes + 1, usage(i + 1, 2, 3, 4, 0.5)).slice(0, -1));
		return sessionState({ id, file, cwd: s.cwd });
	});
	const world = makeWorld({ now: s.clock.now(), sessions });
	s.tracker.tick(world);
	s.tracker.tick(world);
	for (const { id, file } of sessions) {
		assert.equal(s.index.get(id).scanOffset, bytes);
		assert.equal(s.index.get(id).offset, 0);
		fs.appendFileSync(file, "}\n");
	}

	let actual = 0;
	const readSync = fs.readSync;
	const spy = t.mock.method(fs, "readSync", (...args) => {
		const n = readSync(...args);
		actual += n;
		return n;
	});
	const tick = s.tracker.tick(world);
	spy.mock.restore();
	t.diagnostic(`closing tick: ${actual} actual, ${tick.bytesRead} scan bytes`);
	const expected = sessions.map(({ file }) => singleRecordModelOracle(file));
	assert.deepEqual(sessions.map(({ id }) => s.tracker.tokensOf(id)?.tokens?.total), expected.map((models) => models["p/m"].tokens));
	assert.deepEqual(sessions.map(({ id }) => s.index.get(id).published.models), expected);
	assert.deepEqual(sessions.map(({ file }) => usageTimeline(file).totals.models), expected);
	assert.equal(tick.bytesRead, 8, "only the closing bytes are scanned");
	assert.ok(actual <= USAGE_TICK_BYTES, `actual reads: ${actual}`);
});

test("(IS-2, IS-12) an over-capture identity waits until the exact reread fits", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const bytes = 2 * 1024 * 1024;
	const id = "uncertain";
	const file = mainFile(s.paths, id);
	const busy = mainFile(s.paths, "busy");
	const world = makeWorld({ now: s.clock.now(), sessions: [sessionState({ id: "busy", file: busy }), sessionState({ id, file })] });
	const identity = `{"label":"${"m".repeat(128 * 1024)}"}`;
	const record = bigRecord(bytes + 1 - (identity.length - 3), usage(42)).replace('"m"', identity);
	assert.equal(Buffer.byteLength(record), bytes + 1);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, record.slice(0, -1));
	fs.writeFileSync(busy, "");
	s.tracker.tick(world);
	assert.equal(s.index.get(id).scanOffset, bytes);

	// Leave only 1 MiB of scan budget when the record completes.
	const busyLine = bigRecord(1023, usage(1)) + "\n";
	fs.writeFileSync(busy, busyLine.repeat((USAGE_TICK_BYTES - bytes / 2) / busyLine.length));
	fs.appendFileSync(file, "}\n");
	const tick = s.tracker.tick(world);
	assert.equal(s.tracker.tokensOf(id)?.pending, true);
	assert.equal(s.tracker.tokensOf(id)?.tokens, undefined);
	assert.equal(s.index.get(id).offset, 0, "inexact usage is not committed");
	assert.equal(tick.bytesRead, USAGE_TICK_BYTES - bytes / 2 + 2, "the reread is not partially attempted");

	assert.equal(s.tracker.tick(world).bytesRead, bytes + 1, "reread starts at the record and excludes the already scanned delimiter");
	const expected = singleRecordModelOracle(file);
	assert.deepEqual(s.index.get(id).published.models, expected);
	assert.deepEqual(usageTimeline(file).totals.models, expected);
	assert.equal(s.tracker.tokensOf(id).tokens.total, 42);
});

test("(IS-2) a deferred exact reread keeps the last published tokens on the board and in history", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const bytes = 2 * 1024 * 1024;
	const id = "published";
	const file = mainFile(s.paths, id);
	const busy = mainFile(s.paths, "busy");
	const world = makeWorld({
		now: s.clock.now(),
		sessions: [sessionState({ id: "busy", file: busy }), sessionState({ id, file })],
		sensors: [{ sessionId: id, pid: 100, ts: T0 }],
	});
	const board = () => buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf })
		.groups.flatMap((group) => group.sessions).find((row) => row.sessionId === id);
	const row = { sessionId: id, kind: "main", startedMs: T0 - 1000, endedMs: T0 };
	writeLines(file, [bigRecord(0, usage(10))]);
	fs.writeFileSync(busy, "");
	s.tracker.tick(world);
	assert.equal(s.tracker.tokensOf(id).tokens.total, 10);
	const start = s.index.get(id).offset;
	const before = structuredClone(s.index.get(id).published);

	const identity = `{"label":"${"m".repeat(128 * 1024)}"}`;
	const record = bigRecord(bytes + 1 - (identity.length - 3), usage(42)).replace('"m"', identity);
	assert.equal(Buffer.byteLength(record), bytes + 1);
	fs.appendFileSync(file, record.slice(0, -1));
	s.tracker.tick(world);
	assert.equal(s.index.get(id).scanOffset, start + bytes);

	const busyLine = bigRecord(1023, usage(1)) + "\n";
	const busyBytes = USAGE_TICK_BYTES - bytes / 2;
	fs.writeFileSync(busy, busyLine.repeat(busyBytes / busyLine.length));
	fs.appendFileSync(file, "}\n");
	assert.equal(s.tracker.tick(world).bytesRead, busyBytes + 2, "the exact reread does not fit this tick");
	const deferred = s.index.get(id);
	assert.equal(deferred.offset, start, "inexact usage is not committed");
	assert.equal(deferred.usage.total, 10);
	assert.equal(s.index.fresh(deferred), false, "the old publication is not audit-fresh");

	s.index.save();
	const saved = readUsageIndex(s.paths.health.usageIndexFile);
	const history = endedRow(row, 0, saved);
	const live = board();
	const lookup = s.tracker.tokensOf(id);
	assert.deepEqual(
		[lookup?.tokens?.total, lookup?.pending, live?.tokens?.total, live?.tokensPending, history.tokens?.total, history.tokensState],
		[10, true, 10, true, 10, "ok"],
	);
	assert.deepEqual(structuredClone(deferred.published), before);
	assert.deepEqual(structuredClone(saved.get(id).published), before);
	assert.equal(s.index.fresh(saved.get(id)), false);

	assert.equal(s.tracker.tick(world).bytesRead, bytes + 1);
	const models = {};
	let total = 0;
	for (const line of fs.readFileSync(file, "utf8").trimEnd().split("\n")) {
		const { message } = JSON.parse(line);
		const { input, output, cacheRead, cacheWrite, cost } = message.usage;
		const tokens = input + output + cacheRead + cacheWrite;
		models[`${message.provider}/${String(message.model)}`] = { input, output, cacheRead, cacheWrite, tokens, cost: cost.total };
		total += tokens;
	}
	assert.equal(total, 52);
	assert.deepEqual(s.index.get(id).published.models, models);
	assert.equal(s.tracker.tokensOf(id).tokens.total, total);
	assert.equal(board().tokensPending, false);
	assert.equal(s.index.fresh(s.index.get(id)), true);
	s.index.save();
	assert.equal(endedRow(row, 0, readUsageIndex(s.paths.health.usageIndexFile)).tokens.total, total);
});

test("tracker tokens resolve by session id or by a unique task id when the session id is absent", () => {
	const s = setup();
	const file = childFile(s.cwd, "st_x", "child-a");
	writeLines(file, [bigRecord(0, usage(42))]);
	s.index.update("child-a", file, { kind: "child", taskId: "st_x" });
	assert.equal(s.tracker.tokensOf("child-a").tokens.total, 42);
	assert.deepEqual([s.tracker.tokensOf("child-b", "st_x"), s.tracker.tokensOf("st_x")], [null, null]);
	assert.equal(s.tracker.tokensOf(null, "st_x").tokens.total, 42);
});

test("(plan 61) the next tick withdraws a task-only publication and recounts when uniqueness returns", (t) => {
	const reads = [];
	const s = setup(undefined, { read(file, from, options) {
		reads.push({ file, from });
		return readUsage(file, from, options);
	} });
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const taskId = "st_changing";
	const row = { sessionId: taskId, taskId, kind: "child", cwd: s.cwd, endedMs: T0, parentSessionId: "parent" };
	const first = childFile(s.cwd, taskId, "child-first");
	const second = childFile(s.cwd, taskId, "child-second");
	const parent = mainFile(s.paths, "parent");
	writeLines(parent, [bigRecord(0, usage(10))]);
	s.index.update("parent", parent, { kind: "main" });
	reads.length = 0;
	writeLines(first, [bigRecord(0, usage(42))]);
	s.tracker.queueLedger([row]);
	const world = emptyWorld(s.clock);
	s.tracker.tick(world);
	assert.deepEqual([s.tracker.tokensOf(null, taskId)?.tokens?.total, s.tracker.tokensOf("parent")?.treeTokens], [42, 52]);

	writeLines(second, [bigRecord(0, usage(99))]);
	s.tracker.tick(world);
	assert.deepEqual([
		s.tracker.tokensOf(null, taskId),
		s.tracker.tokensOf("parent").treeTokens,
		s.index.fresh(s.index.get(taskId)),
	], [null, null, false], "neither the old publication nor its contribution to the parent is safe");

	fs.rmSync(second);
	assert.ok(s.tracker.tick(world).bytesRead > 0, "restoration must read the transcript again");
	assert.deepEqual(reads, [{ file: first, from: undefined }, { file: first, from: undefined }]);
	assert.deepEqual([s.tracker.tokensOf(null, taskId)?.tokens?.total, s.tracker.tokensOf("parent")?.treeTokens], [42, 52]);
});

test("(IS-3) deleted task-only usage stays published until a new sole candidate is counted from scratch", (t) => {
	const reads = [];
	const s = setup(undefined, { read(file, from, options) {
		reads.push({ file, resumed: from !== undefined });
		return readUsage(file, from, options);
	} });
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const taskId = "st_deleted";
	const row = { sessionId: taskId, taskId, kind: "child", cwd: s.cwd, endedMs: T0 };
	const first = childFile(s.cwd, taskId, "child-first");
	const next = childFile(s.cwd, taskId, "child-next");
	const world = emptyWorld(s.clock);
	writeLines(first, [bigRecord(0, usage(42))]);
	s.tracker.queueLedger([row]);
	s.tracker.tick(world);
	assert.equal(s.tracker.tokensOf(null, taskId)?.tokens?.total, 42);

	fs.rmSync(first);
	assert.equal(s.tracker.tick(world).bytesRead, 0);
	const saved = readUsageIndex(s.paths.health.usageIndexFile).get(taskId);
	assert.deepEqual([s.tracker.tokensOf(null, taskId)?.tokens?.total, saved.gone, compactUsage(saved)?.total], [42, true, 42]);

	writeLines(next, [bigRecord(0, usage(99))]);
	assert.ok(s.tracker.tick(world).bytesRead > 0);
	assert.deepEqual(reads, [{ file: first, resumed: false }, { file: next, resumed: false }]);
	assert.deepEqual([s.index.get(taskId).gone, s.tracker.tokensOf(null, taskId)?.tokens?.total], [false, 99]);
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

test("(plan 34) visible task-only board rows compete even when only one is indexed", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const taskId = "st_shared";
	const tasks = ["a", "b"].map((id) => taskRecord({
		taskId, uid: `store-${id}/${taskId}`, spawnCwd: path.join(s.root, `store-${id}`),
		parentSessionId: `main-${id}`, childSessionId: null,
	}));
	function indexChild(i) {
		const id = `indexed-${i}`;
		const file = childFile(tasks[i].spawnCwd, taskId, id);
		writeLines(file, [bigRecord(0, usage(42 + i))]);
		s.index.update(id, file, { kind: "child", taskId });
	}
	function rowsFor(parents) {
		const world = makeWorld({
			now: T0,
			sessions: parents.map((id) => sessionState({ id, startedMs: T0 - 5000 })),
			tasks,
			sensors: parents.map((sessionId, i) => ({ sessionId, pid: 100 + i, ts: T0 - 1000 })),
			procsFresh: true,
		});
		s.tracker.tick(world);
		const snapshot = buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf });
		return snapshot.groups.flatMap((g) => g.sessions);
	}
	const childTokens = (rows) => rows.flatMap((r) => r.children.map((c) => [c.tokens?.total ?? null, c.tokensPending]));
	const trees = (rows) => rows.map((r) => [r.sessionId, r.treeTokens, r.treeTokensComplete]);
	for (const id of ["main-a", "main-b"]) {
		const file = mainFile(s.paths, id);
		writeLines(file, [bigRecord(0, usage(100))]);
		s.index.update(id, file, { kind: "main" });
		const child = `${id}-counted`;
		writeLines(childFile(s.cwd, `st_${child}`, child), [bigRecord(0, usage(20))]);
		s.index.update(child, childFile(s.cwd, `st_${child}`, child), { kind: "child", parentSessionId: id });
	}
	indexChild(0);
	const oneVisible = rowsFor(["main-a"]);
	const oneIndexed = rowsFor(["main-a", "main-b"]);
	assert.deepEqual(childTokens(oneVisible), [[42, false]], "a child outside the board does not compete");
	assert.deepEqual(childTokens(oneIndexed), [[null, false], [null, false]], "only one candidate is indexed");
	indexChild(1);
	const bothIndexed = rowsFor(["main-a", "main-b"]);
	assert.deepEqual(childTokens(bothIndexed), [[null, false], [null, false]], "both candidates are indexed");
	assert.deepEqual([trees(oneVisible), trees(oneIndexed), trees(bothIndexed)], [
		[["main-a", 162, true]],
		[["main-a", 120, false], ["main-b", 120, false]],
		[["main-a", 120, false], ["main-b", 120, false]],
	]);
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

test("(plan 41) a sensor-reported review.jsonl keeps the live token total in history", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const id = "review-session";
	const file = path.join(s.cwd, "review.jsonl");
	writeJsonl(file, [E.header(id, s.cwd, T0 - 5000), E.assistant({ ms: T0 - 1000, usage: usage(38, 4) })]);
	const sensor = { sessionId: id, sessionFile: file, cwd: s.cwd, pid: 100, ts: T0 - 1000 };
	const registry = new SessionRegistry({ paths: s.paths, clock: s.clock });
	const { sessions } = registry.refresh({ sensors: new Map([[id, sensor]]) });
	assert.equal(sessions.get(id)?.file, file, "the file is outside the normal sessions directory");
	const live = makeWorld({ now: T0, sessions: [...sessions.values()], sensors: [sensor], procsFresh: true });
	const board = (world) => buildSessionSnapshot(world, [], [], world.now, { tokensOf: s.tracker.tokensOf });
	s.tracker.tick(live);
	const snapshot = board(live);
	const liveRow = snapshot.groups.flatMap((g) => g.sessions).find((row) => row.sessionId === id);
	assert.equal(liveRow?.tokens?.total, 42);

	s.advance(1000);
	const ended = makeWorld({ now: s.clock.now(), procsFresh: true });
	const [row] = detectEnded(snapshot, board(ended), ended);
	assert.equal(row?.sessionId, id);
	assert.equal(appendEnded(s.paths, row, { nowMs: s.clock.now() }), true);
	// A non-usage append makes the ended row stale and forces a path lookup after restart.
	s.index.save();
	fs.appendFileSync(file, `${JSON.stringify(E.user("one last note", s.clock.now()))}\n`);
	const index = createUsageIndex({ file: s.paths.health.usageIndexFile, clock: s.clock });
	const locator = createSessionFileLocator({ paths: s.paths, clock: s.clock });
	const tracker = createUsageTracker({ paths: s.paths, index, locator, clock: s.clock });
	assert.equal(tracker.queueLedger(streamEnded(s.paths, { withLocation: true })), 1);
	assert.ok(tracker.tick(ended).bytesRead > 0, "reopens the custom path from the saved index");
	const saved = readUsageIndex(s.paths.health.usageIndexFile);
	const history = endedRow(row, 0, saved);
	assert.equal(saved.get(id)?.file, file);
	assert.equal(history.tokensGone, false);
	assert.equal(history.tokens?.total, liveRow.tokens.total);
});

test("(IS-3) cold backlog shows tokens in history for a backfilled review.jsonl", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const id = "review-session";
	const file = path.join(s.paths.sessionsDir, "proj", "review.jsonl");
	const endedMs = T0 - 60 * 60_000;
	writeJsonl(file, [E.header(id, s.cwd, endedMs - 5000), E.assistant({ ms: endedMs, usage: usage(38, 4) })]);
	fs.utimesSync(file, endedMs / 1000, endedMs / 1000);

	assert.equal(backfillOnce(s.paths, s.clock.now()).counts.written, 1);
	const rows = [...streamEnded(s.paths, { withLocation: true })];
	assert.deepEqual(rows.map((row) => row.sessionId), [id]);
	assert.equal(s.index.has(id), false);
	assert.equal(fs.existsSync(s.paths.health.usageIndexFile), false);
	assert.equal(s.tracker.queueLedger(rows.values()), 1);
	s.tracker.tick(emptyWorld(s.clock));

	const saved = readUsageIndex(s.paths.health.usageIndexFile);
	const history = endedRow(rows[0], 0, saved);
	assert.equal(history.tokensState, "ok");
	assert.equal(history.tokens?.total, 42);
	assert.equal(history.tokensGone, false);
	assert.equal(saved.get(id)?.file, file);
});

test("(plan 41) main file verification rejects wrong, missing, and oversized headers but trusts matching filenames", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const message = E.assistant({ ms: T0, usage: usage(42) });
	const cases = [
		["wrong-id", path.join(s.cwd, "wrong.jsonl"), [E.header("other", s.cwd, T0), message]],
		["no-header", path.join(s.cwd, "missing.jsonl"), [message, E.header("no-header", s.cwd, T0)]],
		["too-long", path.join(s.cwd, "long.jsonl"), [{ ...E.header("too-long", s.cwd, T0), cwd: "x".repeat(64 * 1024) }, message]],
		["named", mainFile(s.paths, "named"), [message]],
	];
	for (const [, file, records] of cases) writeJsonl(file, records);
	const world = makeWorld({
		now: T0,
		sessions: cases.map(([id, file]) => sessionState({ id, file, startedMs: T0 - 1000, cwd: s.cwd })),
		sensors: cases.map(([sessionId, sessionFile], i) => ({ sessionId, sessionFile, pid: 100 + i, ts: T0 })),
		procsFresh: true,
	});
	s.tracker.tick(world);
	const snapshot = buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf });
	const rows = new Map(snapshot.groups.flatMap((g) => g.sessions.map((row) => [row.sessionId, row])));
	for (const [id] of cases.slice(0, -1)) {
		assert.equal(rows.get(id).tokens, null, id);
		assert.equal(s.index.has(id), false, id);
	}
	assert.equal(rows.get("named").tokens?.total, 42);
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

test("(IS-4, IS-12) cold discovery shares the tick budget and keeps history pending", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const sessionId = "review-session";
	const file = path.join(path.dirname(mainFile(s.paths, sessionId)), "review.jsonl");
	writeJsonl(file, [E.header(sessionId, s.cwd, T0 - 1000), E.assistant({ ms: T0, usage: usage(42) })]);
	const reviewBytes = fs.statSync(file).size;
	const header = `${JSON.stringify({ type: "session", id: "unmatched" }).padEnd(HEADER_BYTES - 1)}\n`;
	for (let i = 0; i < 600; i += 1) fs.writeFileSync(mainFile(s.paths, `decoy-${i}`), header);
	const row = { sessionId, kind: "main", endedMs: T0 };
	assert.equal(s.tracker.queueLedger([row]), 1);

	let actual = 0;
	const readSync = fs.readSync;
	t.mock.method(fs, "readSync", (...args) => {
		const n = readSync(...args);
		actual += n;
		return n;
	});
	const tick = () => {
		actual = 0;
		const state = s.tracker.tick(emptyWorld(s.clock));
		assert.ok(actual <= USAGE_TICK_BYTES, `tick read ${actual} actual bytes (budget ${USAGE_TICK_BYTES})`);
		assert.ok(state.bytesRead <= USAGE_TICK_BYTES);
		assert.equal(state.missing, 0);
		return state.bytesRead;
	};
	const history = () => endedRow(row, 0, new Map(s.index.entries().map((entry) => [entry.id, entry])));
	const first = tick();
	assert.equal(first, actual, "all first-tick reads were charged for discovery");
	assert.equal(history().tokensState, "pending");
	assert.equal(s.events.some(({ event }) => event === "usage_backlog"), false);

	const second = tick();
	assert.equal(first + second, 600 * Buffer.byteLength(header) + 2 * reviewBytes, "charge each header once and count the review file");
	assert.equal(s.index.get(sessionId).file, file);
	assert.equal(history().tokensState, "ok");
	assert.equal(history().tokens.total, 42);
});

test("(IS-4, IS-12) live header probes share the tick budget and deferred sessions stay pending", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const custom = Array.from({ length: 600 }, (_, i) => {
		const id = `live-${i}`;
		const file = path.join(s.cwd, `custom-${i}.jsonl`);
		writeLines(file, [JSON.stringify({ type: "session", id }).padEnd(HEADER_BYTES - 1), bigRecord(0, usage(i + 1))]);
		return { id, file, total: i + 1 };
	});
	const named = { id: "named", file: mainFile(s.paths, "named"), total: 42 };
	writeLines(named.file, [bigRecord(0, usage(named.total))]);
	const namedBytes = fs.statSync(named.file).size;
	const cases = [named, ...custom];
	const world = makeWorld({
		now: s.clock.now(),
		sessions: cases.map(({ id, file }) => sessionState({ id, file, cwd: s.cwd, startedMs: T0 - 1000 })),
		sensors: cases.map(({ id: sessionId, file: sessionFile }, i) => ({ sessionId, sessionFile, pid: 100 + i, ts: T0 })),
		procsFresh: true,
	});

	const filesByFd = new Map();
	const bytesByFile = new Map();
	const probesByFile = new Map();
	let actual = 0;
	let filesCounted = 0;
	let fingerprints = 0;
	let counting = false;
	const { openSync, readSync } = fs;
	const { update } = s.index;
	t.mock.method(s.index, "update", (...args) => {
		counting = true;
		filesCounted += 1;
		const before = actual;
		try {
			const scanned = update(...args);
			fingerprints += actual - before - scanned;
			return scanned;
		} finally {
			counting = false;
		}
	});
	t.mock.method(fs, "openSync", (file, ...args) => {
		const fd = openSync(file, ...args);
		filesByFd.set(fd, file);
		return fd;
	});
	t.mock.method(fs, "readSync", (fd, ...args) => {
		const n = readSync(fd, ...args);
		const file = filesByFd.get(fd);
		actual += n;
		bytesByFile.set(file, (bytesByFile.get(file) ?? 0) + n);
		if (!counting) probesByFile.set(file, (probesByFile.get(file) ?? 0) + n);
		return n;
	});
	// The archive used for red proof lacks this export; use the same allowance there.
	const fingerprintMax = usageIndex.USAGE_FINGERPRINT_BYTES_MAX ?? 16_384;
	const tick = (i) => {
		actual = 0;
		filesCounted = 0;
		fingerprints = 0;
		bytesByFile.clear();
		probesByFile.clear();
		const state = s.tracker.tick(world);
		const ceiling = USAGE_TICK_BYTES + filesCounted * fingerprintMax;
		assert.ok(actual <= ceiling, `tick ${i} read ${actual} actual bytes (ceiling ${ceiling}, counting ${filesCounted} files)`);
		assert.ok(state.bytesRead <= USAGE_TICK_BYTES, `tick ${i} charged ${state.bytesRead} against ${USAGE_TICK_BYTES}`);
		assert.equal(state.bytesRead, actual - fingerprints, `tick ${i} charged scans and probes, excluding fingerprints`);
		t.diagnostic(`tick ${i}: ${actual} actual, ${state.bytesRead} charged, ${filesCounted} counted`);
		return state;
	};

	tick(1);
	assert.equal(bytesByFile.get(named.file), 3 * namedBytes, "matching filename needs only the scan and two short fingerprints");
	assert.equal(probesByFile.has(named.file), false);
	const waiting = custom.filter(({ file }) => !bytesByFile.has(file));
	assert.ok(waiting.length > 0, "some live header probes did not fit");
	const board = buildSessionSnapshot(world, [], [], world.now, { tokensOf: s.tracker.tokensOf });
	const rows = new Map(board.groups.flatMap((g) => g.sessions.map((row) => [row.sessionId, row])));
	for (const { id } of waiting) {
		assert.equal(s.index.has(id), false, id);
		assert.deepEqual(s.tracker.tokensOf(id), { pending: true }, id);
		assert.equal(rows.get(id)?.tokensPending, true, id);
		assert.equal(rows.get(id)?.tokens, null, id);
	}
	for (let i = 2; i <= 4 && cases.some(({ id }) => !s.tracker.tokensOf(id)?.tokens); i += 1) tick(i);
	const totals = () => cases.map(({ id }) => s.tracker.tokensOf(id)?.tokens?.total);
	const expected = cases.map(({ total }) => total);
	assert.deepEqual(totals(), expected);
	assert.equal(tick("unchanged").bytesRead, 0, "an unchanged world has no scan or probe bytes");
	assert.equal(probesByFile.size, 0, "unchanged custom-named files are not re-probed");
	assert.deepEqual(totals(), expected);
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

for (const [label, bytes] of [["40 MiB", 40 * 1024 * 1024], ["small", 512 * 1024]]) {
	test(`(IS-2, IS-12) a small append resumes a ${label} EOF record without rereading it`, (t) => {
		const s = setup();
		t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
		const id = "resume";
		const file = mainFile(s.paths, id);
		const world = makeWorld({ now: s.clock.now(), sessions: [sessionState({ id, file, cwd: s.cwd })] });
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const [head, tail] = bigRecord(0, usage(7)).split('""');
		const padding = Buffer.alloc(Math.min(bytes, 1024 * 1024), "x");
		const fd = fs.openSync(file, "w");
		try {
			fs.writeFileSync(fd, `${head}"`);
			for (let rest = bytes - head.length - tail.length - 2; rest > 0; rest -= padding.length) {
				fs.writeFileSync(fd, padding.subarray(0, rest));
			}
			fs.writeFileSync(fd, `"${tail}`);
		} finally {
			fs.closeSync(fd);
		}
		assert.equal(s.tracker.tick(world).bytesRead, Math.min(bytes, USAGE_TICK_BYTES));
		if (bytes > USAGE_TICK_BYTES) assert.equal(s.tracker.tick(world).bytesRead, bytes - USAGE_TICK_BYTES);
		assert.equal(s.tracker.tokensOf(id).tokens.total, 7);
		assert.equal(s.index.get(id).offset, 0, "the EOF overlay has not been committed");
		assert.equal(s.index.save(), true);

		const index = createUsageIndex({ file: s.index.file, clock: s.clock });
		const restarted = createUsageTracker({ paths: s.paths, index, clock: s.clock });
		assert.equal(restarted.tokensOf(id).tokens.total, 7);
		const append = `\n${bigRecord(0, usage(11))}\n`;
		const appendedBytes = Buffer.byteLength(append);
		fs.appendFileSync(file, append);

		assert.equal(s.tracker.tick(world).bytesRead, appendedBytes, "only the append spends the live tick budget");
		const live = s.tracker.tokensOf(id).tokens;
		assert.deepEqual([live.total, live.turns], [18, 2]);
		assert.equal(s.index.get(id).overlay.total, 0);
		assert.equal(s.tracker.tick(world).bytesRead, 0);
		assert.deepEqual(s.tracker.tokensOf(id).tokens, live);

		const coldBytes = bytes + appendedBytes;
		assert.equal(restarted.tick(world).bytesRead, Math.min(coldBytes, USAGE_TICK_BYTES), "restart reads from the persisted offset");
		if (coldBytes > USAGE_TICK_BYTES) assert.equal(restarted.tick(world).bytesRead, coldBytes - USAGE_TICK_BYTES);
		assert.deepEqual(restarted.tokensOf(id).tokens, live);
	});
}

test("a verified live session waiting for its first read is pending on the board", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const first = mainFile(s.paths, "first");
	const second = mainFile(s.paths, "second");
	writeJsonl(first, [E.assistant({ ms: T0, usage: usage(10) })]);
	fs.truncateSync(first, USAGE_TICK_BYTES + 1);
	writeJsonl(second, [E.assistant({ ms: T0, usage: usage(42) })]);
	const world = makeWorld({
		now: T0,
		sessions: [
			sessionState({ id: "first", file: first, kind: "main", cwd: s.cwd }),
			sessionState({ id: "second", file: second, kind: "main", cwd: s.cwd }),
		],
		sensors: [{ sessionId: "second", pid: 100, ts: T0 - 1000, idle: true, executingTools: 0 }],
		procsFresh: true,
	});
	const boardRow = () => buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf })
		.groups.flatMap((group) => group.sessions).find((row) => row.sessionId === "second");

	assert.equal(s.tracker.tick(world).bytesRead, USAGE_TICK_BYTES);
	assert.equal(s.index.has("second"), false);
	assert.deepEqual([s.tracker.tokensOf("second"), boardRow().tokensPending, boardRow().tokens], [{ pending: true }, true, null]);

	s.tracker.tick(world);
	assert.equal(s.tracker.tokensOf("second").tokens.total, 42);
	assert.deepEqual([boardRow().tokensPending, boardRow().tokens.total], [false, 42]);
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
	assert.equal(s.tracker.tick(world).bytesRead, HEADER_BYTES + size - Buffer.byteLength(record) - 1 - 2 * USAGE_TICK_BYTES);
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
	assert.equal(tick.bytesRead, HEADER_BYTES + fs.statSync(file).size - savedOffset,
		"after header discovery, counting reads only the bytes after the persisted offset");
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
			assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, 2 * fs.statSync(file).size, "discover and recount the file");
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
			const locator = createSessionFileLocator({ paths: s.paths, clock: s.clock });
			const tracker = createUsageTracker({ paths: s.paths, index, locator, clock: s.clock, log: s.log });
			assert.equal(endedRow(row, 0, loaded).tokensState, "pending");
			// A v3 line without its id cannot be attributed to a session, so it is dropped: the session is unindexed, not pending.
			assert.deepEqual(tracker.tokensOf(id), field.join(".") === "id" ? null : { pending: true });
			assert.equal(tracker.queueLedger([row]), 1);
			assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, 2 * fs.statSync(file).size, "discover and recount the file");
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
		assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, 2 * fs.statSync(file).size, "discover and recount the file");
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
	assert.equal(tracker.tick(emptyWorld(s.clock)).bytesRead, 2 * fs.statSync(file).size, "discover and recount the file");
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

test("tokensOf reports a raised tree total for a parent and no tree total for a leaf", () => {
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
	assert.deepEqual(s.tracker.tokensOf("p2"), { tokens: compactUsage(s.index.get("p2")), treeTokens: 16, treeTokensComplete: true });
	assert.deepEqual(s.tracker.tokensOf("c2"), { tokens: compactUsage(s.index.get("c2")), treeTokens: null, treeTokensComplete: true });
});

test("(plan 51) board marks a pending parent tree partial until its read finishes", () => {
	const s = setup();
	const file = mainFile(s.paths, "main");
	writeLines(file, [bigRecord(0, usage(100))]);
	s.index.update("main", file, { kind: "main" }, { maxBytes: 1 });
	const child = childFile(s.cwd, "st_child", "child");
	writeLines(child, [bigRecord(0, usage(20))]);
	s.index.update("child", child, { kind: "child", taskId: "st_child", parentSessionId: "main" });
	const world = makeWorld({
		now: T0,
		sessions: [sessionState({ id: "main", file, startedMs: T0 - 5000 })],
		sensors: [{ sessionId: "main", pid: 100, ts: T0 - 1000 }],
		procsFresh: true,
	});
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const treeTokenMark = runInNewContext(
		["tokenReading", "treeTokenMark"].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") + "\ntreeTokenMark",
		{ el: (_tag, attrs) => attrs, compactCount: String, fullCount: String },
	);
	const display = () => {
		const [row] = buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf }).groups[0].sessions;
		const mark = treeTokenMark(row);
		return [row.tokensPending, row.treeTokens, row.treeTokensComplete, mark.text, mark.title];
	};
	const pending = display();
	s.tracker.tick(world);
	assert.deepEqual([pending, display()], [
		[true, 20, false, "자식 포함 20+", "세지 못한 자식이 있어 일부만 더한 값입니다"],
		[false, 120, true, "자식 포함 120", "120"],
	]);
});

test("tree token completeness follows pending siblings and never counts a missing sibling as complete", () => {
	const s = setup();
	for (const parent of ["ready", "missing", "live"]) {
		const file = mainFile(s.paths, parent);
		const child = `${parent}-counted`;
		writeJsonl(file, [E.assistant({ ms: T0, usage: usage(100) })]);
		s.index.update(parent, file, { kind: "main" });
		const counted = childFile(s.cwd, `st_${child}`, child);
		writeJsonl(counted, [E.assistant({ ms: T0, usage: usage(20) })]);
		s.index.update(child, counted, { kind: "child", parentSessionId: parent });
	}
	const ready = { sessionId: "ready-sibling", taskId: "st_ready", kind: "child", parentSessionId: "ready", cwd: s.cwd, endedMs: T0 };
	const missing = { ...ready, sessionId: "missing-sibling", taskId: "st_missing", parentSessionId: "missing" };
	const transcript = childFile(s.cwd, ready.taskId, ready.sessionId);
	writeJsonl(transcript, [E.assistant({ ms: T0, usage: usage(5) })]);
	const world = makeWorld({
		now: T0,
		sessions: [
			sessionState({ id: "ready", startedMs: T0 - 5000 }),
			sessionState({ id: "live-sibling", kind: "child", parentSessionId: "live", file: null }),
		],
		sensors: [{ sessionId: "ready", pid: 100, ts: T0 - 1000, idle: true, executingTools: 0 }],
		procsFresh: true,
	});
	const tree = (id) => {
		const { treeTokens, treeTokensComplete } = s.tracker.tokensOf(id);
		return [treeTokens, treeTokensComplete];
	};
	s.tracker.queueLedger([ready, missing]);
	assert.equal(s.index.get(ready.sessionId), undefined);
	assert.deepEqual(tree("ready"), [120, false], "the queued sibling is known before entering the index");
	s.tracker.tick(world);
	assert.deepEqual(tree("ready"), [125, true], "the tree becomes complete after the sibling's read");
	assert.equal(s.index.get(missing.sessionId).state, "missing");
	assert.deepEqual(tree("missing"), [120, false]);
	assert.deepEqual(tree("live"), [120, false], "a live sibling with no index entry still makes the tree partial");
	s.tracker.tick(world);
	assert.deepEqual(tree("missing"), [120, false], "later ticks do not make a missing sibling complete");
	const [row] = buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf }).groups[0].sessions;
	assert.deepEqual([row.treeTokens, row.treeTokensComplete], [125, true]);
});

test("(IS-2) the board snapshot includes equal and lower tree totals, but not uncounted descendants", (t) => {
	const s = setup();
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
	const parents = ["equal", "lower", "pending", "missing", "overflow"];
	for (const id of parents) {
		const file = mainFile(s.paths, id);
		if (id === "overflow") writeLines(file, ['{"type":"usage","provider":"p","model":"m","usage":{"input":1e309}}']);
		else writeJsonl(file, [E.assistant({ ms: T0, usage: usage(10) })]);
		s.index.update(id, file, { kind: "main" });
		const childId = `${id}-child`;
		const meta = { kind: "child", parentSessionId: id, taskId: `st_${id}` };
		if (id === "missing") {
			s.index.markMissing(childId, meta);
			continue;
		}
		const child = childFile(s.cwd, meta.taskId, childId);
		writeJsonl(child, [E.assistant({ ms: T0, usage: usage(id === "lower" ? -3 : 0) })]);
		s.index.update(childId, child, meta, id === "pending" ? { maxBytes: 1 } : {});
	}
	assert.deepEqual([s.index.get("pending-child").state, s.index.get("pending-child").complete], ["ok", false]);
	const world = makeWorld({
		now: T0,
		sessions: parents.map((id) => sessionState({ id, startedMs: T0 - 5000 })),
		sensors: parents.map((sessionId) => ({ sessionId, pid: 100, ts: T0 - 1000, idle: true, executingTools: 0 })),
		procsFresh: true,
	});
	const snapshot = buildSessionSnapshot(world, [], [], T0, { tokensOf: s.tracker.tokensOf });
	const rows = new Map(snapshot.groups.flatMap((g) => g.sessions.map((row) => [row.sessionId, row])));
	assert.deepEqual(parents.map((id) => [rows.get(id).treeTokens, rows.get(id).treeTokensState ?? null]),
		[[10, null], [7, null], [null, null], [null, null], [null, "overflow"]]);
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
