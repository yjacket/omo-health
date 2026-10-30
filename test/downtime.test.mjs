import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { currentDowntime, latestBootGap, readDowntime } from "../src/collect/downtime.mjs";
import { resolvePaths } from "../src/paths.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function setup(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-downtime-"));
	const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") });
	const config = { bootGap: { enabled: true, minGapMs: 10 * MIN, windowMs: DAY, keepDays: 7 } };
	return { dir, paths, config };
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

function gaps(paths) {
	try {
		return fs.readdirSync(paths.health.bootGapsDir).sort();
	} catch {
		return [];
	}
}

test("no previous heartbeat or state means no downtime", (t) => {
	const { paths, config } = setup(t);
	assert.deepEqual(readDowntime({ paths, now: NOW, uptimeMs: HOUR, config }), { kind: "none" });
	assert.deepEqual(gaps(paths), []);
});

test("a 90 s gap is below minGapMs and records nothing", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 90_000, pid: 7 });
	assert.deepEqual(readDowntime({ paths, now: NOW, uptimeMs: 5 * HOUR, config }), { kind: "none", gapMs: 90_000 });
	assert.deepEqual(gaps(paths), []);
});

test("an idle-exit gap yields none", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 3 * HOUR, pid: 7, exitReason: "idle-no-omo-hosts" });
	assert.deepEqual(readDowntime({ paths, now: NOW, uptimeMs: HOUR, config }), {
		kind: "none",
		gapMs: 3 * HOUR,
		exitReason: "idle-no-omo-hosts",
	});
	assert.deepEqual(gaps(paths), []);
});

test("a 3 h gap on a machine up 1 h is a reboot, down since the newest previous mark", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 3 * HOUR, pid: 7, exitReason: "crash" });
	writeJson(paths.health.stateFile, { v: 1, savedMs: NOW - 2.5 * HOUR });
	const record = readDowntime({ paths, now: NOW, uptimeMs: HOUR, config });
	assert.deepEqual(record, {
		v: 1,
		kind: "reboot",
		downSinceMs: NOW - 2.5 * HOUR,
		upAtMs: NOW,
		gapMs: 2.5 * HOUR,
		bootMs: NOW - HOUR,
		prevPid: 7,
		exitReason: "crash",
	});
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.health.bootGapsDir, `${NOW - 2.5 * HOUR}.json`), "utf8")), record);
});

test("a 3 h gap on a machine up 5 h is daemon-down", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 3 * HOUR, pid: 8 });
	const record = readDowntime({ paths, now: NOW, uptimeMs: 5 * HOUR, config });
	assert.equal(record.kind, "daemon-down");
	assert.equal(record.downSinceMs, NOW - 3 * HOUR);
	assert.equal(record.bootMs, NOW - 5 * HOUR);
});

test("stoppedMs counts as the previous daemon mark", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 4 * HOUR, stoppedMs: NOW - 2 * HOUR, pid: 9 });
	const record = readDowntime({ paths, now: NOW, uptimeMs: 5 * HOUR, config });
	assert.equal(record.downSinceMs, NOW - 2 * HOUR);
	assert.equal(record.gapMs, 2 * HOUR);
});

test("a recorded gap stays visible to currentDowntime while a fresh start reports none", (t) => {
	const { paths, config } = setup(t);
	writeJson(paths.health.daemonJson, { ts: NOW - 3 * HOUR, pid: 7 });
	const recorded = currentDowntime({ paths, now: NOW, uptimeMs: HOUR, config });
	assert.equal(recorded.kind, "reboot");
	writeJson(paths.health.daemonJson, { ts: NOW + HOUR - 30_000, pid: 10 });
	writeJson(paths.health.stateFile, { v: 1, savedMs: NOW + HOUR - 30_000 });
	const later = currentDowntime({ paths, now: NOW + HOUR, uptimeMs: HOUR, config });
	assert.equal(later.kind, "reboot");
	assert.equal(later.upAtMs, NOW);
	assert.equal(latestBootGap({ paths, now: NOW + HOUR, windowMs: HOUR / 2 }), undefined, "outside the window it is not returned");
});

test("gap files older than keepDays are pruned", (t) => {
	const { paths, config } = setup(t);
	const oldDown = NOW - 9 * DAY;
	const oldFile = path.join(paths.health.bootGapsDir, `${oldDown}.json`);
	writeJson(oldFile, { v: 1, kind: "daemon-down", downSinceMs: oldDown, upAtMs: NOW - 8 * DAY, gapMs: DAY });
	writeJson(paths.health.daemonJson, { ts: NOW - 3 * HOUR, pid: 7 });
	readDowntime({ paths, now: NOW, uptimeMs: HOUR, config });
	assert.deepEqual(gaps(paths), [`${NOW - 3 * HOUR}.json`]);
});
