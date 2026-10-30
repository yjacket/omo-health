import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeRows } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createEngine } from "../src/engine.mjs";
import * as orphans from "../src/detect/orphans.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

/** An engine tick with only D8 and two dead-host tasks: one untouched for two days, one updated 10 min ago. */
function harness() {
	const root = tmpDir("omoh-engine-stale-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(NOW);
	const staleTask = taskRecord({ taskId: "st_stale", status: "running", hostPid: 4999, childSessionId: "c1", parentSessionId: "p1", updatedAtMs: NOW - 2 * DAY });
	const recentTask = taskRecord({ taskId: "st_recent", status: "running", hostPid: 4998, childSessionId: "c2", parentSessionId: "p1", updatedAtMs: NOW - 10 * MIN });
	const sessions = new Map([
		["p1", sessionState({ id: "p1", kind: "main" })],
		["c1", sessionState({ id: "c1", kind: "child", taskId: "st_stale", parentSessionId: "p1", task: staleTask })],
		["c2", sessionState({ id: "c2", kind: "child", taskId: "st_recent", parentSessionId: "p1", task: recentTask })],
	]);
	const tasks = [staleTask, recentTask];
	const procs = {
		async snapshot() {
			return { takenAtMs: clock.now(), rows: normalizeRows([raw(777, 1, "explorer.exe", iso(NOW - 5 * 3600_000))]) };
		},
		async os() {
			return { commitFrac: 0.5, commitUsedBytes: 1, commitLimitBytes: 2 };
		},
		async ports() {
			return [];
		},
		restarts: 0,
		close() {},
	};
	const engine = createEngine({
		paths,
		config: { ...DEFAULT_CONFIG, procSnapshotMs: 20_000 },
		clock,
		mode: "shadow",
		detectors: [{ name: "orphans", ...orphans }],
		sources: { procs, registry: { refresh: () => ({ sessions, tasks }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: { send: () => "inbox-file", notifier: { toast: () => ({ ok: true }) }, decide: () => {}, sensors: () => new Map() },
		options: { selfPid: 1 },
	});
	return { engine, paths };
}

test("a dead-host task record older than sessions.recentMs stays out of the parent's footer status", async () => {
	const { engine, paths } = await harness();
	const { findings } = await engine.tick();
	const hostGone = findings.filter((f) => f.kind === "task-host-gone" || f.kind === "task-host-gone-after-resume");
	assert.deepEqual(hostGone.map((f) => f.subject.taskId), ["st_recent"]);
	const parent = JSON.parse(fs.readFileSync(path.join(paths.health.statusDir, "p1.json"), "utf8"));
	assert.deepEqual([parent.level, parent.text], ["info", "👀 관찰1"]);
	assert.equal(parent.open.length, 1);
	assert.match(parent.open[0].titleKo, /st_recent/);
});
