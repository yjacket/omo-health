import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareAudit } from "../src/audit-prepare-worker.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { auditBundle } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionSnapshot, detectEnded } from "../src/session-board.mjs";
import { appendEnded, appendEndedBatch, streamEnded } from "../src/session-ledger.mjs";
import { boardLiveOwners, subjectOf } from "../src/session-subject.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildEnded, loadUiInputs } from "../src/ui/model.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
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

const readDetail = (paths, row) => createDetailOperations({ paths, auditDetail: () => null })({
	kind: "detail", id: row.sessionId, row: expectedSelector(row), now, pagination: { list: null, offset: 0 },
}).record;

function bundleFor(paths, row, indexEntries = []) {
	const { loaded } = prepareAudit({
		subject: subjectOf(row), now, liveOwners: boardLiveOwners(paths), indexEntries,
		bounds: { messageScanMaxBytes: 4096, messageScanTotalBytes: 4096, preparationMaxBytes: 65536 },
	}, { paths });
	return auditBundle(loaded, null, { config: DEFAULT_CONFIG, now });
}

function writeUsage(file, tokens) {
	writeJsonl(file, [E.assistant({ ms: now - 50, usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
}

test("plan93 cross-project child belongs only to its actual parent after rebuilding the index", (t) => {
	const { paths, a, b } = setup(t);
	const alice = main("review.1", a);
	const bob = main("review.1", b);
	const child = { sessionId: "review.child", taskId: "st_cross", cwd: b, name: "cross", status: "running" };
	const snapshot = (sessions) => ({ v: 1, groups: [{ sessions }] });
	const world = { now, paths, sessions: new Map(), tasks: [], hostExits: {} };
	const ended = detectEnded(snapshot([{ ...alice, children: [child] }]), snapshot([]), world, now);
	assert.equal(appendEndedBatch(paths, ended, { nowMs: now }).filter(({ appended }) => appended).length, 2);
	assert.ok(appendEnded(paths, bob, { nowMs: now }));
	const legacy = { ...child, kind: "child", sessionId: "legacy.child", taskId: "st_legacy", parentSessionId: "review.1", endedMs: now };
	fs.appendFileSync(path.join(paths.health.sessionsDir, "ended-2026-10-10.jsonl"), `${JSON.stringify({ ...legacy, v: 1 })}\n`);
	for (const [row, tokens] of [[alice, 10], [bob, 20]]) {
		writeUsage(path.join(paths.sessionsDir, subjectOf(row).projectKey, `2026-10-10T12-00-00-000Z_${row.sessionId}.jsonl`), tokens);
	}
	for (const [row, tokens] of [[child, 6], [legacy, 9]]) {
		writeUsage(path.join(b, ".omo", "senpi-task", "children", row.taskId, "sessions", row.taskId, `2026-10-10T12-00-00-000Z_${row.sessionId}.jsonl`), tokens);
	}
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick(world);
	const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
	const forRow = (row) => ({
		trackerTree: tracker.tokensOf(subjectOf(row))?.treeTokens,
		historyTree: history.rows.find((r) => r.kind === "main" && r.rowSelector === expectedSelector(row))?.treeTokens,
		detail: readDetail(paths, row).children.map(({ sessionId }) => sessionId),
		audit: bundleFor(paths, row).children.map(({ sessionId }) => sessionId),
	});
	assert.deepEqual([forRow(alice), forRow(bob)], [
		{ trackerTree: 16, historyTree: 16, detail: [child.sessionId], audit: [child.sessionId] },
		{ trackerTree: null, historyTree: null, detail: [], audit: [] },
	]);
	const stored = [...streamEnded(paths)].find((row) => row.sessionId === child.sessionId);
	assert.equal(stored.parentProjectKey, subjectOf(alice).projectKey);
	assert.equal(stored.cwd, b);
	assert.equal(Object.hasOwn(stored, "tokens"), false);
});

test("plan93 an off-board process child with no ledger row blocks bare health attribution", (t) => {
	const { paths, a, b } = setup(t);
	const ended = main("review.1", a);
	assert.ok(appendEnded(paths, ended, { nowMs: now }));
	const parent = { id: "off-board", kind: "main", cwd: b };
	const child = { id: ended.sessionId, kind: "child", parentSessionId: parent.id, task: { executionMode: "process" } };
	const world = { now, sessions: new Map([[parent.id, parent], [child.id, child]]), tasks: [], isSessionLive: (s) => s === child };
	const board = buildSessionSnapshot(world);
	assert.deepEqual(board.groups, []);
	fs.mkdirSync(path.dirname(paths.health.sessionsSnapshotFile), { recursive: true });
	fs.writeFileSync(paths.health.sessionsSnapshotFile, JSON.stringify(board));
	writeJsonl(path.join(paths.health.decisionsDir, "2026-10-10.jsonl"), [{
		event: "opened", fp: "orphan-finding", detector: "D1", kind: "stalled", severity: "warn",
		ts: new Date(now - 10).toISOString(), subject: { sessionId: child.id },
	}]);
	const detail = readDetail(paths, ended);
	const bundle = bundleFor(paths, ended);
	assert.deepEqual({
		detail: detail.health.findings.map(({ fp }) => fp),
		audit: bundle.omo_health_record.findings.length,
		detailWithheld: detail.truncated?.unattributedHealth?.findings,
		auditWithheld: bundle.truncated.unattributedHealth?.findings,
	}, { detail: [], audit: 0, detailWithheld: 1, auditWithheld: 1 });
	assert.ok(boardLiveOwners(paths).some((owner) => owner.sessionId === child.id && owner.projectKey === subjectOf(parent).projectKey));
});
