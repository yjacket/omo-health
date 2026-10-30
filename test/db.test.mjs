import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBaseline } from "../src/baseline.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { closeDb, createMaintainer, migrate, openDb, retention, SCHEMA_VERSION } from "../src/db/db.mjs";
import { lineageOf, lineageSeen, recordCompletion, recordLineage, shapeStats } from "../src/db/toolcalls.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-10-07T00:00:00Z");
const DAY = 24 * 3600_000;

function sandbox() {
	const root = tmpDir("omoh-db-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { root, paths };
}

/** A writable DB on the sandbox file, closed when the test ends so the temp root is removable on Windows. */
function open(t, paths) {
	const db = openDb({ file: paths.health.dbFile });
	t.after(() => closeDb(db));
	return db;
}

const version = (db) => db.prepare("PRAGMA user_version").get().user_version;

test("migrate is idempotent and leaves the schema at the latest version", (t) => {
	const { paths } = sandbox();
	const db = open(t, paths);
	assert.equal(version(db), SCHEMA_VERSION);
	assert.equal(migrate(db), SCHEMA_VERSION);
	assert.equal(migrate(db), SCHEMA_VERSION);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
	assert.deepEqual(tables, ["baseline_samples", "lineages", "tool_calls"]);
	assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
	closeDb(db);
	const again = open(t, paths);
	assert.equal(version(again), SCHEMA_VERSION, "reopening an existing file migrates nothing twice");
});

test("recordCompletion upserts by id and shapeStats summarizes a shape's natural durations", (t) => {
	const { paths } = sandbox();
	const db = open(t, paths);
	const call = (id, durMs, extra = {}) => ({ id, sessionId: "s1", kind: "child", tool: "bash", shapeKey: "node #.mjs", startMs: T, endMs: T + durMs, isError: false, endedBy: "result", ...extra });
	for (let i = 1; i <= 9; i++) recordCompletion(db, call(`c${i}`, i * 1000));
	recordCompletion(db, call("c10", 100_000));
	recordCompletion(db, call("other", 5, { shapeKey: "git status" }));
	// A call someone stopped waiting for is censored: its duration is not the shape's.
	recordCompletion(db, call("killed", 900_000, { endedBy: "omo-health" }));
	// The same id again replaces the row.
	recordCompletion(db, call("c10", 10_000, { isError: true, windowSeen: true }));
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 12);
	assert.deepEqual({ ...db.prepare("SELECT dur_ms, is_error, window_seen FROM tool_calls WHERE id = 'c10'").get() }, { dur_ms: 10_000, is_error: 1, window_seen: 1 });
	const stats = shapeStats(db, "node #.mjs", 0);
	assert.deepEqual([stats.n, stats.median, stats.p99, stats.mad], [10, 5500, 9910, 2500]);
	assert.equal(shapeStats(db, "node #.mjs", T + 5000 + 1).n, 5, "sinceMs filters on end time: c5.. ended at T+5000 or later");
	assert.deepEqual(shapeStats(db, "never seen", 0), { n: 0, median: undefined, p99: undefined, mad: undefined });
});

test("lineages count sightings, and a lineage fingerprint follows the process tree's programs", (t) => {
	const { paths } = sandbox();
	const db = open(t, paths);
	const tree = [{ name: "bash.exe", ctime: new Date(T).toISOString() }, { name: "Node.exe", ctime: new Date(T + 1000).toISOString() }, { name: "chrome.exe", ctime: new Date(T + 600_000).toISOString() }];
	const { lineage, fp } = lineageOf(tree, T);
	assert.equal(lineage, "bash.exe>node.exe", "a child that starts long after the call is its work, not the call");
	assert.equal(lineageOf([...tree].reverse(), T).fp === fp, false, "order is part of the lineage");
	assert.equal(lineageSeen(db, fp), false);
	recordLineage(db, fp, lineage, T);
	recordLineage(db, fp, lineage, T + 5);
	assert.equal(lineageSeen(db, fp), true);
	assert.deepEqual({ ...db.prepare("SELECT first_ms, last_ms, count FROM lineages WHERE fp = ?").get(fp) }, { first_ms: T, last_ms: T + 5, count: 2 });
});

test("retention deletes rows older than the retention window and keeps newer ones", (t) => {
	const { paths } = sandbox();
	const db = open(t, paths);
	recordCompletion(db, { id: "old", shapeKey: "x", startMs: T - 100 * DAY, endMs: T - 100 * DAY + 10, endedBy: "result" });
	recordCompletion(db, { id: "new", shapeKey: "x", startMs: T - DAY, endMs: T - DAY + 10, endedBy: "result" });
	recordLineage(db, "oldfp", "a", T - 100 * DAY);
	recordLineage(db, "newfp", "b", T - DAY);
	db.prepare("INSERT INTO baseline_samples (metric, t, value) VALUES ('cpu', ?, 1), ('cpu', ?, 1)").run(T - 100 * DAY, T - DAY);
	assert.deepEqual(retention(db, T, 90), { toolCalls: 1, lineages: 1, baselineSamples: 1 });
	assert.deepEqual(db.prepare("SELECT id FROM tool_calls").all().map((row) => row.id), ["new"]);
	assert.deepEqual([lineageSeen(db, "oldfp"), lineageSeen(db, "newfp")], [false, true]);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM baseline_samples").get().n, 1);
});

test("the maintainer runs retention once a day and checkpoints on its interval", (t) => {
	const { paths } = sandbox();
	const db = open(t, paths);
	const clock = createFakeClock(T);
	const config = structuredClone(DEFAULT_CONFIG);
	const maintainer = createMaintainer({ db, config, clock, log: undefined });
	recordCompletion(db, { id: "old", shapeKey: "x", startMs: T - 100 * DAY, endMs: T - 100 * DAY, endedBy: "result" });
	maintainer.tick(T);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 0, "the first tick applies retention");
	recordCompletion(db, { id: "old2", shapeKey: "x", startMs: T - 100 * DAY, endMs: T - 100 * DAY, endedBy: "result" });
	maintainer.tick(T + config.history.checkpointMs);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 1, "retention does not run again within the day");
	maintainer.tick(T + DAY);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 0);
});

test("baseline.json is imported into an empty table once and renamed, never deleted", (t) => {
	const { paths } = sandbox();
	const samples = { births: [[T - 2 * DAY, 1], [T - DAY, 2]], cpu: [[T - DAY, 0.5]], mem: [], writes: [], temp: [[T - DAY, 7]] };
	fs.writeFileSync(paths.health.baselineFile, JSON.stringify({ v: 1, firstMs: T - 2 * DAY, samples }));
	const db = open(t, paths);
	const baseline = createBaseline({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(T), db });
	assert.deepEqual(Object.fromEntries(Object.entries(baseline.status(T)).map(([metric, s]) => [metric, s.samples])), { births: 2, cpu: 1, mem: 0, writes: 0, temp: 1 });
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM baseline_samples").get().n, 4);
	assert.equal(fs.existsSync(paths.health.baselineFile), false);
	assert.equal(fs.existsSync(`${paths.health.baselineFile}.imported`), true);
	// A second start reads the table; a new baseline.json (e.g. restored by hand) is not imported over existing rows.
	fs.writeFileSync(paths.health.baselineFile, JSON.stringify({ v: 1, samples: { births: [[T, 9]] } }));
	const second = createBaseline({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(T), db });
	assert.equal(second.status(T).births.samples, 2);
	assert.equal(fs.existsSync(paths.health.baselineFile), true);
});

test("a baseline without an openable DB runs in memory, logs baseline_db_failed, and keeps its legacy file", (t) => {
	const { paths } = sandbox();
	fs.writeFileSync(paths.health.baselineFile, JSON.stringify({ v: 1, samples: { births: [[T - DAY, 1]], cpu: [], mem: [], writes: [], temp: [] } }));
	fs.mkdirSync(paths.health.dbFile);
	let failure;
	try {
		openDb({ file: paths.health.dbFile });
	} catch (error) {
		failure = error;
	}
	assert.ok(failure, "a directory in the DB's place cannot be opened");
	const logs = [];
	const log = { warn: (event, data) => logs.push([event, data]), info: () => {}, error: () => {} };
	const baseline = createBaseline({ paths, config: DEFAULT_CONFIG, clock: createFakeClock(T), log, db: null, dbError: failure });
	assert.deepEqual(logs.map(([event]) => event), ["baseline_db_failed"]);
	assert.equal(baseline.status(T).births.samples, 1);
	baseline.flush();
	assert.equal(fs.existsSync(paths.health.baselineFile), true);
});

test("a read-only connection reads but cannot write", (t) => {
	const { paths } = sandbox();
	const writer = open(t, paths);
	recordCompletion(writer, { id: "a", shapeKey: "x", startMs: T, endMs: T + 1, endedBy: "result" });
	const reader = openDb({ file: paths.health.dbFile, readOnly: true });
	t.after(() => closeDb(reader));
	assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 1);
	assert.throws(() => recordCompletion(reader, { id: "b", startMs: T }), /readonly/i);
	assert.throws(() => reader.exec("DELETE FROM tool_calls"), /readonly/i);
	assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, 1);
});

test("closeDb is safe to repeat and on nothing", () => {
	const db = openDb({ file: ":memory:" });
	closeDb(db);
	closeDb(db);
	closeDb(undefined);
	closeDb(null);
});
