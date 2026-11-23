import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareAudit } from "../src/audit-prepare-worker.mjs";
import { auditsToday, createAuditor } from "../src/auditor.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { auditBundle } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, streamEnded } from "../src/session-ledger.mjs";
import { boardLiveOwners, subjectOf } from "../src/session-subject.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildEnded, loadUiInputs } from "../src/ui/model.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { taskStoreDir } from "../src/collect/tasks.mjs";
import { createUsageIndex } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { E, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";

const now = Date.UTC(2026, 9, 10, 12);
const clock = { now: () => now };
const main = (sessionId, cwd) => ({ sessionId, cwd, kind: "main", startedMs: now - 1000, endedMs: now });

function setup(t) {
	const root = tmpDir("omoh-ownership-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { paths, a: path.join(root, "a"), b: path.join(root, "b") };
}

function bundleFor(paths, row, indexEntries = []) {
	const { loaded } = prepareAudit({
		subject: subjectOf(row), now, liveOwners: boardLiveOwners(paths), indexEntries,
		bounds: { messageScanMaxBytes: 4096, messageScanTotalBytes: 4096, preparationMaxBytes: 65536 },
	}, { paths });
	return auditBundle(loaded, null, { config: DEFAULT_CONFIG, now });
}

const reviewName = "2026-10-10_review.1.jsonl";
const world = { now, sessions: new Map(), tasks: [] };
const usageLine = (input) => E.assistant({ ms: now - 50, model: "claude-opus-5-5", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
function openTracker(paths) {
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	return { index, tracker: createUsageTracker({ paths, index, clock, locator: createSessionFileLocator({ paths, clock }) }) };
}

test("plan119 cold recount refuses a cross-project header and cannot launch or charge an audit", async (t) => {
	const { paths, a, b } = setup(t);
	const alice = main("review.1", a);
	const bob = main("review.1", b);
	for (const [row, total] of [[alice, 99], [bob, 17]]) {
		assert.ok(appendEnded(paths, row, { nowMs: now }));
		writeJsonl(path.join(paths.sessionsDir, subjectOf(row).projectKey, reviewName),
			[E.header(row.sessionId, b, now - 1000), usageLine(total)]);
	}
	let { index } = openTracker(paths);
	index.update(subjectOf(alice), path.join(paths.sessionsDir, subjectOf(alice).projectKey, reviewName), { kind: "main" });
	index.save();
	fs.unlinkSync(paths.health.usageIndexFile);
	const cold = openTracker(paths);
	index = cold.index;
	cold.tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	cold.tracker.tick(world);
	const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
	assert.equal(history.rows.find((row) => row.cwd === a)?.tokens?.total ?? null, null);
	assert.equal(history.rows.find((row) => row.cwd === b)?.tokens?.total, 17);
	assert.equal(bundleFor(paths, alice, [...index.values()]).tokens?.total ?? null, null);

	fs.writeFileSync(paths.health.daemonJson, JSON.stringify({ ts: now, pid: process.pid }));
	let launches = 0;
	const runner = { start() { launches++; throw new Error("unexpected audit launch"); } };
	const auditor = createAuditor({ paths, clock, config: DEFAULT_CONFIG, env: {}, runner });
	t.after(() => auditor.close());
	const operate = createDetailOperations({ paths, env: {}, resolveModel: () => ({ model: "openai/gpt-5-5" }) });
	const [status, body] = operate({ kind: "audit", id: alice.sessionId, row: expectedSelector(alice), now });
	assert.deepEqual([status, body.error], [409, "models-unknown"]);
	await auditor.tick(now);
	await auditor.preparing();
	await auditor.tick(now);
	assert.equal(launches, 0);
	assert.equal(auditsToday(paths, now), 0);
});

test("plan119 headerless external transcript keeps its final append after reload but refuses a foreign replacement", (t) => {
	const { paths, a, b } = setup(t);
	const row = main("review.1", a);
	const file = path.join(a, reviewName);
	writeJsonl(file, [usageLine(42)]);
	const live = openTracker(paths);
	live.tracker.tick({ ...world, sessions: new Map([[row.sessionId, { ...row, id: row.sessionId, file }]]) });
	assert.equal(live.tracker.tokensOf(subjectOf(row))?.tokens.total, 42);
	assert.ok(appendEnded(paths, row, { nowMs: now }));
	live.index.save();
	fs.appendFileSync(file, `${JSON.stringify(usageLine(10))}\n`);
	const reload = () => {
		const { tracker } = openTracker(paths);
		tracker.queueLedger(streamEnded(paths, { withLocation: true }));
		tracker.tick(world);
		return buildEnded(loadUiInputs({ paths, now, env: {} })).rows.find((entry) => entry.cwd === a);
	};
	const history = reload();
	assert.deepEqual([history?.tokens?.total, history?.tokensGone], [52, false]);
	writeJsonl(`${file}.new`, [E.header(row.sessionId, b, now - 1000), usageLine(99)]);
	fs.renameSync(`${file}.new`, file);
	const replaced = reload();
	assert.deepEqual([replaced?.tokens?.total, replaced?.tokensGone], [52, true]);
});

test("plan119 detail accepts an unchanged saved child but refuses a same-ID child replacement from another project", (t) => {
	const { paths, a, b } = setup(t);
	const child = { ...main("review.1", a), kind: "child", taskId: "st_review" };
	assert.ok(appendEnded(paths, child, { nowMs: now }));
	const { index } = openTracker(paths);
	const file = path.join(taskStoreDir(a), "children", child.taskId, "sessions", child.taskId, reviewName);
	writeJsonl(file, [usageLine(17)]);
	index.update(subjectOf(child), file, { kind: "child" });
	index.save();
	const detail = () => createDetailOperations({ paths, auditDetail: () => null })({
		kind: "detail", id: child.sessionId, row: expectedSelector(child), now,
	});
	const unchanged = detail();
	assert.deepEqual([unchanged.record.found, unchanged.files, unchanged.record.tokens?.total], [true, [file], 17]);
	writeJsonl(`${file}.new`, [E.header(child.sessionId, b, now - 1000), usageLine(99)]);
	fs.renameSync(`${file}.new`, file);
	const replaced = detail();
	assert.deepEqual([replaced.record.found, replaced.files, replaced.record.tokens?.total ?? null], [true, [], null]);
});
