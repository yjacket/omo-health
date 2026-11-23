import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareAudit } from "../src/audit-prepare-worker.mjs";
import { auditModelFacts, createAuditor, requestAudit } from "../src/auditor.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { auditBundle, resolveAuditModel } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildSessionSnapshot, detectEnded } from "../src/session-board.mjs";
import { appendEnded, appendEndedBatch, streamEnded } from "../src/session-ledger.mjs";
import { loadSessionRecord, usageEntryOf } from "../src/session-record.mjs";
import { boardLiveOwners, subjectOf } from "../src/session-subject.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildEnded, loadUiInputs } from "../src/ui/model.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { SessionRegistry } from "../src/collect/sessions.mjs";
import { normalizeTask, projectStoreName, taskStoreDir } from "../src/collect/tasks.mjs";
import { buildWorld } from "../src/state.mjs";
import { createUsageIndex, parentSubject, readUsageIndex } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { E, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

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

function writeUsage(file, tokens, model) {
	writeJsonl(file, [E.assistant({ ms: now - 50, model, usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
}

test("plan94 a cross-project child bills and excludes the model from its spawning store", (t) => {
	const { paths, a, b } = setup(t);
	const parent = main("review.1", a);
	const child = { ...main("review.child", b), kind: "child", taskId: "st_cross", parentSessionId: parent.sessionId, parentProjectKey: subjectOf(parent).projectKey };
	assert.ok(appendEnded(paths, parent, { nowMs: now }));
	assert.ok(appendEnded(paths, child, { nowMs: now }));
	for (const cwd of [a, b]) writeTask(cwd, {
		task_id: child.taskId, child_session_id: child.sessionId,
		parent_session_id: parent.sessionId, spawn_spec: { cwd: b }, status: "completed",
	});
	const transcript = (cwd) => path.join(cwd, ".omo", "senpi-task", "children", child.taskId, "sessions", child.taskId, `2026-10-10T12-00-00-000Z_${child.sessionId}.jsonl`);
	writeUsage(transcript(a), 17, "parent-model");
	writeUsage(transcript(b), 99, "spawn-cwd-model");

	const lookup = { paths, id: child.sessionId, row: expectedSelector(child), now };
	const direct = loadSessionRecord(lookup);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	const world = { now, sessions: new Map(), tasks: [] };
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick(world);
	const indexEntries = [...index.values()];
	const prepared = prepareAudit({
		subject: subjectOf(child), now, indexEntries,
		bounds: { messageScanMaxBytes: 4096, messageScanTotalBytes: 4096, preparationMaxBytes: 65536 },
	}, { paths });
	let modelFacts;
	const detail = createDetailOperations({ paths, resolveModel: (_paths, _config, facts) => { modelFacts = facts; } })({
		kind: "detail", id: child.sessionId, row: expectedSelector(child), now,
	});
	assert.deepEqual({
		directFiles: direct.transcriptFiles,
		detailFiles: detail.files,
		trackerTokens: tracker.tokensOf(subjectOf(child))?.tokens.total,
		detailTokens: detail.record.tokens.total,
		excluded: modelFacts?.sessionModels,
		modelsKnown: modelFacts?.sessionModelsKnown,
		auditTimeline: prepared.timelineSource?.file,
	}, {
		directFiles: [transcript(a)],
		detailFiles: [transcript(a)],
		trackerTokens: 17,
		detailTokens: 17,
		excluded: ["anthropic-subscription/parent-model"],
		modelsKnown: true,
		auditTimeline: transcript(a),
	});

	const liveIndex = createUsageIndex({ file: path.join(paths.healthHome, "live-usage.json"), clock });
	const liveTracker = createUsageTracker({ paths, clock, index: liveIndex, locator: createSessionFileLocator({ paths, clock }) });
	const liveChild = { ...child, id: child.sessionId, file: transcript(b), task: { storeDir: path.join(a, ".omo", "senpi-task"), spawnCwd: b } };
	liveTracker.tick({ ...world, sessions: new Map([[parent.sessionId, { id: parent.sessionId, kind: "main", cwd: b }], [liveChild.id, liveChild]]) });
	assert.equal(liveTracker.tokensOf(subjectOf(child))?.tokens.total, 17, "live task storeDir wins even against the parent cwd and attached file");
});

test("plan94 an unknown spawning store with two matches has no usage or audit model coverage", (t) => {
	const { paths, a, b } = setup(t);
	const grandparent = main("root", a);
	const parent = { ...main("parent", null), kind: "child", taskId: "st_parent", parentSessionId: grandparent.sessionId };
	const child = { ...main("review.child", b), kind: "child", taskId: "st_nested", parentSessionId: parent.sessionId };
	for (const row of [grandparent, parent, child]) assert.ok(appendEnded(paths, row, { nowMs: now }));
	for (const [cwd, total, model] of [[a, 17, "a-model"], [b, 99, "b-model"]]) {
		writeUsage(path.join(cwd, ".omo", "senpi-task", "children", child.taskId, "sessions", child.taskId, `2026-10-10T12-00-00-000Z_${child.sessionId}.jsonl`), total, model);
	}
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick({ now, sessions: new Map(), tasks: [] });
	const detail = readDetail(paths, child);
	const indexEntries = [...index.values()];
	const prepared = prepareAudit({
		subject: subjectOf(child), now, indexEntries,
		bounds: { messageScanMaxBytes: 4096, messageScanTotalBytes: 4096, preparationMaxBytes: 65536 },
	}, { paths });
	assert.equal(tracker.tokensOf(subjectOf(child)), null);
	assert.equal(detail.found, true);
	assert.equal(detail.tokens?.total ?? null, null);
	assert.equal(prepared.loaded?.found, true);
	assert.deepEqual(auditModelFacts(usageEntryOf(index, prepared.loaded.session), prepared.full), { sessionModels: [], sessionModelsKnown: false });
});

test("plan94 a same-named main enters history only for the project that ended", (t) => {
	const { paths, a, b } = setup(t);
	const alice = { ...main("review.1", a), children: [] };
	const bob = { ...main("review.1", b), children: [] };
	const snapshot = (ts, sessions) => ({ v: 1, ts, groups: [{ sessions }] });
	const current = snapshot(now, [bob]);
	const world = { now, paths, sessions: new Map(), tasks: [], hostExits: {} };
	const ended = detectEnded(snapshot(now - 1, [alice]), current, world, now);
	assert.equal(appendEndedBatch(paths, ended, { nowMs: now }).filter(({ appended }) => appended).length, 1);
	const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
	assert.deepEqual(history.rows.map(({ sessionId, cwd }) => [sessionId, cwd]), [["review.1", a]]);
	assert.deepEqual(current.groups.flatMap(({ sessions }) => sessions.map(({ sessionId, cwd }) => [sessionId, cwd])), [["review.1", b]]);
});

test("plan109 a main and task transcript with the same project and ID keep their own tokens and models", async (t) => {
	const { paths, a } = setup(t);
	const later = main("review.shared", a);
	const earlier = {
		...later, kind: "child", taskId: "st_shared", parentSessionId: "review.parent",
		parentProjectKey: subjectOf(later).projectKey, startedMs: now - 4000, endedMs: now - 2000,
	};
	const name = `2026-10-10T12-00-00-000Z_${later.sessionId}.jsonl`;
	writeUsage(path.join(paths.sessionsDir, subjectOf(later).projectKey, name), 43, "claude-opus-5-5");
	const childFile = path.join(taskStoreDir(a), "children", earlier.taskId, "sessions", earlier.taskId, name);
	writeJsonl(childFile, [E.assistant({
		ms: now - 3500, provider: "openai", model: "gpt-5-5", usage: { input: 17, output: 0, cacheRead: 0, cacheWrite: 0 },
	})]);
	fs.mkdirSync(paths.agentDir, { recursive: true });
	fs.writeFileSync(paths.authFile, JSON.stringify({ openai: {}, "anthropic-subscription": {} }));
	fs.mkdirSync(path.dirname(paths.omoJsonc), { recursive: true });
	fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: {
		ultrabrain: { models: ["anthropic-subscription/claude-opus-5-5"] },
		architect: { models: ["openai/gpt-5-5"] },
	} } }));
	for (const row of [earlier, later]) assert.ok(appendEnded(paths, row, { nowMs: now }));
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick({ now, sessions: new Map(), tasks: [] });
	index.save();

	const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
	const actual = [later, earlier].map((row) => {
		const shown = history.rows.find(({ rowSelector }) => rowSelector === expectedSelector(row));
		let facts;
		const { record, audit } = createDetailOperations({ paths, env: {}, resolveModel: (paths, config, input) => {
			facts = input;
			return resolveAuditModel(paths, config, input);
		} })({
			kind: "detail", id: row.sessionId, row: expectedSelector(row), now,
		});
		return [shown?.tokens?.total, record?.tokens?.total, facts?.sessionModels, facts?.sessionModelsKnown, audit?.planned?.model];
	});
	assert.deepEqual(actual, [
		[43, 43, ["anthropic-subscription/claude-opus-5-5"], true, "openai/gpt-5-5"],
		[17, 17, ["openai/gpt-5-5"], true, "anthropic-subscription/claude-opus-5-5"],
	]);
	assert.equal(loadSessionRecord({ paths, id: later.sessionId, now }).error, "ambiguous-session");
	let at = now;
	const auditClock = { now: () => at };
	const summaries = ["메인 세션의 사용량은 적절했습니다.", "자식 세션의 점검 결과는 정상이었습니다."];
	const starts = [];
	const runner = {
		start(job) { starts.push(job.jobId); return { pid: 5000, jobId: job.jobId }; },
		adoptJob: () => "running",
		poll(jobId) {
			return { status: "done", exitCode: 0, result: {
				overall: "sound", summary: summaries[starts.indexOf(jobId)],
				tokens: { judgment: "normal", explanation: "정상 범위입니다." },
				checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
				recommendations: [], confidence: 0.8,
			} };
		},
	};
	const boot = () => createAuditor({ paths, clock: auditClock, config: DEFAULT_CONFIG, env: {}, runner });
	let auditor = boot();
	t.after(() => auditor.close());
	for (const [i, row] of [later, earlier].entries()) {
		const claim = requestAudit(paths, subjectOf(row), now + i);
		assert.equal(claim.created, true);
		assert.equal(claim.request.taskId, row.taskId ?? null);
	}
	for (let i = 0; i < 2; i++) {
		at += 31_000;
		auditor.tick(at);
		await auditor.preparing();
		auditor.tick(at);
		assert.equal(starts.length, i + 1);
		await auditor.close();
		auditor = boot();
		at += 31_000;
		auditor.tick(at);
	}
	const restartedDetail = createDetailOperations({ paths, env: {} });
	assert.deepEqual([later, earlier].map((row) => {
		const { audit } = restartedDetail({ kind: "detail", id: row.sessionId, row: expectedSelector(row), now: at });
		return [audit?.state?.taskId, audit?.state?.status, audit?.state?.result?.summary];
	}), [[null, "done", summaries[0]], [earlier.taskId, "done", summaries[1]]]);
});

test("plan110 a persisted grandchild belongs only to its task parent when a main reuses the parent's ID", (t) => {
	const { paths, a } = setup(t);
	const sharedId = "review.shared";
	const root = main("review.root", a);
	const grandchild = { sessionId: "review.grandchild", taskId: "st_grandchild", cwd: a, status: "running" };
	const parent = { sessionId: sharedId, taskId: "st_parent", cwd: a, status: "running", children: [grandchild] };
	const later = main(sharedId, a);
	const projectKey = subjectOf(later).projectKey;
	const snapshot = (sessions) => ({ v: 1, groups: [{ sessions }] });
	const world = { now, paths, sessions: new Map(), tasks: [] };
	const ended = detectEnded(snapshot([{ ...root, children: [parent] }]), snapshot([]), world, now - 2000);
	assert.equal(appendEndedBatch(paths, ended, { nowMs: now }).filter(({ appended }) => appended).length, 3);
	assert.ok(appendEnded(paths, later, { nowMs: now }));
	const filename = (row) => `2026-10-10T12-00-00-000Z_${row.sessionId}.jsonl`;
	writeUsage(path.join(paths.sessionsDir, projectKey, filename(later)), 43);
	for (const [row, tokens] of [[parent, 17], [grandchild, 6]]) {
		writeUsage(path.join(taskStoreDir(a), "children", row.taskId, "sessions", row.taskId, filename(row)), tokens);
	}

	const rows = [...streamEnded(paths, { withLocation: true })];
	const stored = rows.find((row) => row.taskId === grandchild.taskId);
	assert.deepEqual([stored.parentProjectKey, stored.parentSessionId, stored.parentTaskId], [projectKey, sharedId, parent.taskId]);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
	tracker.queueLedger(rows);
	tracker.tick(world);
	index.save();
	const reloaded = readUsageIndex(paths.health.usageIndexFile);
	assert.deepEqual(parentSubject(reloaded.getForSubject(subjectOf(grandchild))), subjectOf(parent));
	const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
	const storedParent = rows.find((row) => row.taskId === parent.taskId);
	assert.deepEqual([storedParent, later].map((row) => {
		const usage = tracker.tokensOf(subjectOf(row));
		const shown = history.rows.find(({ rowSelector }) => rowSelector === expectedSelector(row));
		const detail = readDetail(paths, row);
		assert.equal(detail.found, true);
		return [usage?.treeTokens, shown?.tokens?.total, shown?.treeTokens,
			detail.children.map(({ sessionId, taskId }) => [sessionId, taskId])];
	}), [
		[23, 17, 23, [[grandchild.sessionId, grandchild.taskId]]],
		[null, 43, null, []],
	]);
});

test("plan99 a fresh heartbeat owns the live file despite a raw-ID registry collision", async (t) => {
	for (const last of ["A", "B"]) await t.test(`registry enumerates ${last} last`, (t) => {
		const { paths, a, b } = setup(t);
		const sessionId = "review.1";
		const transcript = (dir, cwd, total) => {
			const file = path.join(paths.sessionsDir, dir, `2026-10-10T12-00-00-000Z_${sessionId}.jsonl`);
			writeJsonl(file, [E.header(sessionId, cwd, now - 1000), E.assistant({
				ms: now - 50, usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0 },
			})]);
			return file;
		};
		// Use an explicit path outside A's default project subdirectory: no locator fallback can find it.
		const fileA = transcript("explicit-session-dir", a, 17);
		const fileB = transcript(subjectOf({ cwd: b }).projectKey, b, 99);
		const sensors = new Map([[sessionId, { ts: now, sessionId, cwd: a, sessionFile: fileA }]]);
		const registry = new SessionRegistry({ paths, config: DEFAULT_CONFIG, clock });
		registry.refresh({ sensors });
		const order = last === "A" ? [fileB, fileA] : [fileA, fileB];
		registry.trackers = new Map(order.map((file) => [file, registry.trackers.get(file)]));
		const world = buildWorld({ now, paths, sensors, registry: registry.snapshot() });
		assert.equal(world.sessions.get(sessionId).file, order.at(-1));
		assert.ok(appendEnded(paths, main(sessionId, b), { nowMs: now }));

		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
		const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
		tracker.queueLedger(streamEnded(paths, { withLocation: true }));
		tracker.tick(world);
		index.save();
		const board = buildSessionSnapshot(world, [], [], now, { tokensOf: tracker.tokensOf });
		const live = board.groups[0].sessions[0];
		const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
		assert.deepEqual({
			live: [live.sessionId, live.cwd, live.tokens?.total],
			liveOwners: board.liveOwners,
			history: history.rows.map(({ sessionId, cwd, tokens }) => [sessionId, cwd, tokens?.total]),
			indexedLiveFile: [...index.values()].find((entry) => entry.projectKey === subjectOf({ cwd: a }).projectKey)?.file,
		}, {
			live: [sessionId, a, 17],
			liveOwners: [subjectOf({ cwd: a, sessionId })],
			history: [[sessionId, b, 99]],
			indexedLiveFile: fileA,
		});
		if (last === "B") {
			sensors.set(sessionId, { ts: now, sessionId, cwd: a });
			tracker.tick(world);
			const fallback = buildSessionSnapshot(world, [], [], now, { tokensOf: tracker.tokensOf }).groups[0].sessions[0];
			assert.deepEqual([fallback.cwd, fallback.tokens.total], [b, 99], "a heartbeat without a file preserves registry attribution");
		}
	});
});

test("plan99 ended child details take outcome and reason from their parent project store", async (t) => {
	for (const first of ["A", "B"]) await t.test(`task store ${first} first`, (t) => {
		const { paths, a, b } = setup(t);
		const parentId = "review.1";
		const childId = "review.child";
		const taskId = "st_shared";
		const parent = (cwd, children) => ({ ...main(parentId, cwd), children });
		const child = { sessionId: childId, taskId, status: "running", name: "shared child" };
		const snapshot = (ts, sessions) => ({ v: 1, ts, groups: [{ sessions }] });
		const prev = snapshot(now - 1, [parent(a, [child]), parent(b, [child])]);
		const current = snapshot(now, [parent(a, []), parent(b, [])]);
		const task = (storeDir, status, fields) => normalizeTask({
			task_id: taskId, parent_session_id: parentId, child_session_id: childId,
			status, terminal_at: new Date(now).toISOString(), ...fields,
		}, storeDir);
		const failed = task(taskStoreDir(a), "error", { error_message: "failure from A only" });
		const answered = task(path.join(paths.agentDir, "projects", projectStoreName(b), "senpi-task"), "completed", { final_response: "ok" });
		const tasks = first === "A" ? [failed, answered] : [answered, failed];
		const world = { now, paths, tasks };
		const records = detectEnded(prev, current, world);
		assert.equal(appendEndedBatch(paths, records, { nowMs: now }).filter(({ appended }) => appended).length, 2);
		const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
		const facts = history.rows.map((row) => {
			const { outcome, reason } = readDetail(paths, row).session;
			return [row.cwd, outcome, reason];
		}).sort(([left], [right]) => left.localeCompare(right));
		assert.deepEqual(facts, [
			[a, "failed", "작업이 오류로 끝났습니다: failure from A only"],
			[b, "answered", "작업이 최종 응답과 함께 완료되었습니다."],
		]);
	});
});

test("plan99 an unresolved child store does not lend task or release evidence to an end", (t) => {
	const { paths, a, b } = setup(t);
	const cwd = path.join(path.dirname(a), "unmatched");
	const parentId = "review.1";
	const child = { sessionId: "review.child", taskId: "st_shared", status: "running" };
	const snapshot = (children) => ({ v: 1, ts: now, groups: [{ sessions: [{ ...main(parentId, cwd), children }] }] });
	const tasks = [a, b].map((project) => normalizeTask({
		task_id: child.taskId, parent_session_id: parentId, status: "error", error_message: "foreign failure",
	}, taskStoreDir(project)));
	fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.decisionsDir, "2026-10-10.jsonl"), `${JSON.stringify({
		action: { kind: "kill-pids" }, result: "execute", subject: { taskId: child.taskId, sessionId: child.sessionId },
	})}\n`);
	const world = { now, paths, tasks };
	const [gone] = detectEnded(snapshot([child]), snapshot([]), world);
	const [cancelled] = detectEnded(snapshot([child]), snapshot([{ ...child, status: "cancelled" }]), world);
	assert.deepEqual([gone.outcome, gone.reason], ["unknown", "작업 상태가 없음이고 끝난 이유를 알려 줄 기록이 없습니다."]);
	assert.deepEqual([cancelled.outcome, cancelled.reason], ["cancelled", "작업이 취소되었습니다."]);
});

test("plan98 recent child stays with the ended project when a live main reuses its parent ID", async (t) => {
	for (const store of ["local", "per-user"]) await t.test(store, (t) => {
		const { paths, a, b } = setup(t);
		const parentId = "review.1";
		const childId = "review.child";
		const taskId = "st_recent";
		const storeDir = store === "local" ? taskStoreDir(a) : path.join(paths.agentDir, "projects", projectStoreName(a), "senpi-task");
		const task = normalizeTask({
			task_id: taskId, parent_session_id: parentId, child_session_id: childId,
			status: "running", spawn_spec: { cwd: b },
		}, storeDir);
		const file = path.join(storeDir, "children", taskId, "sessions", taskId, `2026-10-10T12-00-00-000Z_${childId}.jsonl`);
		const child = { id: childId, file, cwd: b, kind: "child", taskId, parentSessionId: parentId, task };
		writeUsage(file, 6);
		const liveMain = (cwd, tokens) => {
			const file = path.join(paths.sessionsDir, subjectOf({ cwd }).projectKey, `2026-10-10T12-00-00-000Z_${parentId}.jsonl`);
			writeUsage(file, tokens);
			return { id: parentId, cwd, file, kind: "main" };
		};
		const alice = liveMain(a, 10);
		const bob = liveMain(b, 20);
		const world = (now, sessions) => ({
			now, paths, tasks: [task], sessions: new Map(sessions.map((row) => [row.id, row])),
			isSessionLive: () => true,
		});
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
		const tracker = createUsageTracker({ paths, clock, index, locator: createSessionFileLocator({ paths, clock }) });
		const snapshot = (state) => {
			tracker.tick(state);
			return buildSessionSnapshot(state, [], [], state.now, { tokensOf: tracker.tokensOf });
		};
		const before = snapshot(world(now - 1, [alice, child]));
		const prior = before.groups[0].sessions[0];
		assert.deepEqual([prior.children.map(({ sessionId }) => sessionId), prior.treeTokens], [[childId], 16]);

		Object.assign(task, { status: "completed", active: false, terminal: true, terminalAtMs: now });
		const current = world(now, [bob, child]);
		const after = snapshot(current);
		const records = detectEnded(before, after, current, now);
		assert.equal(appendEndedBatch(paths, records, { nowMs: now }).filter(({ appended }) => appended).length, 2);
		tracker.queueLedger(streamEnded(paths, { withLocation: true }));
		const withoutChildRegistry = snapshot(world(now, [bob]));
		index.save();
		const history = buildEnded(loadUiInputs({ paths, now, env: {} }));
		const endedAlice = history.rows.find((row) => row.kind === "main");
		const liveFacts = ({ groups: [{ sessions: [row] }] }) => ({
			cwd: row.cwd, own: row.tokens.total, children: row.children.map(({ sessionId }) => sessionId), tree: row.treeTokens,
		});
		assert.deepEqual({
			withRegistryChild: liveFacts(after),
			withoutRegistryChild: liveFacts(withoutChildRegistry),
			ended: { cwd: endedAlice.cwd, tree: endedAlice.treeTokens, children: readDetail(paths, endedAlice).children.map(({ sessionId }) => sessionId) },
		}, {
			withRegistryChild: { cwd: b, own: 20, children: [], tree: null },
			withoutRegistryChild: { cwd: b, own: 20, children: [], tree: null },
			ended: { cwd: a, tree: 16, children: [childId] },
		});
	});
});

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
	for (const [row, cwd, tokens] of [[child, a, 6], [legacy, b, 9]]) {
		writeUsage(path.join(cwd, ".omo", "senpi-task", "children", row.taskId, "sessions", row.taskId, `2026-10-10T12-00-00-000Z_${row.sessionId}.jsonl`), tokens);
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
