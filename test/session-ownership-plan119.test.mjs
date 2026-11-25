import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareAudit } from "../src/audit-prepare-worker.mjs";
import { auditsToday, createAuditor, readAuditState, requestAudit } from "../src/auditor.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { auditBundle } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, streamEnded } from "../src/session-ledger.mjs";
import { boardLiveOwners, subjectOf } from "../src/session-subject.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildEnded, loadUiInputs } from "../src/ui/model.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { taskStoreDir } from "../src/collect/tasks.mjs";
import { createUsageIndex, fresh, usageEntryFor } from "../src/usage-index.mjs";
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

function misplacedMain(t) {
	const { paths, a, b } = setup(t);
	const alice = main("review.1", a);
	const bob = main("review.1", b);
	const text = "Project B private review notice";
	const { index } = openTracker(paths);
	const files = [alice, bob].map((row) => {
		assert.ok(appendEnded(paths, row, { nowMs: now }));
		const file = path.join(paths.sessionsDir, subjectOf(row).projectKey, reviewName);
		writeJsonl(file, [
			E.header(bob.sessionId, b, now - 1000),
			{ ...E.custom("omo-health", now - 100), content: text },
			usageLine(17),
		]);
		// A prior publication may already have counted the misplaced file.
		index.update(subjectOf(row), file, { kind: "main" });
		return file;
	});
	return { paths, alice, bob, text, index, files };
}

test("plan120 history detail refuses a same-name main transcript owned by another project", (t) => {
	const { paths, alice, bob, text, index, files } = misplacedMain(t);
	const open = (operate, row) => {
		const detail = operate({ kind: "detail", id: row.sessionId, row: expectedSelector(row), now });
		assert.equal(detail.record.found, true);
		return {
			files: detail.files,
			messages: detail.record.health.messages.map((message) => message.text),
			tokens: detail.record.tokens?.total ?? null,
		};
	};
	const operate = createDetailOperations({ paths, auditDetail: () => null });
	const cold = open(operate, alice);
	assert.equal(index.save(), true);
	assert.deepEqual(open(operate, bob), { files: [files[1]], messages: [text], tokens: 17 });
	assert.deepEqual([cold, open(operate, alice)], [
		{ files: [], messages: [], tokens: null },
		{ files: [], messages: [], tokens: null },
	]);
});

test("plan122 an index-only queued audit refuses the misplaced main without launching or charging", async (t) => {
	await misplacedMainAudit(t, { timelineMaxBytes: 1 });
});

test("plan121 a queued audit refuses the misplaced main even though its index stamp matches", async (t) => {
	await misplacedMainAudit(t);
});

async function misplacedMainAudit(t, options) {
	await assertMisplacedAuditRefused(t, misplacedMain(t), options);
}

async function assertMisplacedAuditRefused(t, { paths, alice, index }, options) {
	const subject = subjectOf(alice);
	assert.equal(fresh(usageEntryFor(index, subject)), true);
	assert.equal(index.save(), true);
	fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["openai/gpt-5-5"] } } } }));
	fs.writeFileSync(paths.authFile, JSON.stringify({ openai: {} }));
	let launches = 0;
	const auditor = createAuditor({ paths, index, clock, config: DEFAULT_CONFIG, env: {}, ...options, runner: {
		start() { launches++; return { pid: 5001 }; },
	} });
	t.after(() => auditor.close());
	assert.equal(requestAudit(paths, subject, now).created, true);
	await auditor.tick(now);
	await auditor.preparing();
	await auditor.tick(now);
	const record = readAuditState(paths, subject);
	assert.deepEqual([record?.status, record?.reason, launches, auditsToday(paths, now)],
		["failed", "models-unknown", 0, 0]);
}

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

for (const conflict of ["session ID", "project"]) {
	test(`plan124 an in-place main recount refuses a foreign ${conflict} without another open`, async (t) => {
		const { paths, a, b } = setup(t);
		const alice = main("review.1", a);
		const foreign = conflict === "project" ? main(alice.sessionId, b) : main("review.2", a);
		const subject = subjectOf(alice);
		const file = path.join(paths.sessionsDir, subject.projectKey, reviewName);
		const { index, tracker } = openTracker(paths);
		const live = { ...world, sessions: new Map([[alice.sessionId, { ...alice, id: alice.sessionId, file }]]) };
		writeJsonl(file, [E.header(alice.sessionId, a, now - 1000), usageLine(17)]);
		tracker.tick(live);
		assert.equal(tracker.tokensOf(subject)?.tokens.total, 17);
		assert.ok(appendEnded(paths, alice, { nowMs: now }));
		const { ino, birthtimeMs } = fs.statSync(file);
		const foreignUsage = E.assistant({
			ms: now - 50, provider: "openai", model: "gpt-5-5", usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		writeJsonl(file, [E.header(foreign.sessionId, foreign.cwd, now - 1000), foreignUsage]);
		const rewritten = fs.statSync(file);
		assert.deepEqual([rewritten.ino, rewritten.birthtimeMs], [ino, birthtimeMs]);
		const open = fs.openSync;
		const spy = t.mock.method(fs, "openSync", (...args) => open(...args));
		tracker.tick(live);
		spy.mock.restore();
		assert.equal(spy.mock.calls.filter(({ arguments: [name] }) => name === file).length, 1);
		const display = tracker.tokensOf(subject);
		assert.deepEqual([display?.tokens.total, display?.pending, fresh(usageEntryFor(index, subject))], [17, true, false]);
		assert.equal(index.save(), true);
		fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["openai/gpt-5-5"] } } } }));
		fs.writeFileSync(paths.authFile, JSON.stringify({ openai: {} }));
		let launches = 0;
		const auditor = createAuditor({ paths, index, clock, config: DEFAULT_CONFIG, env: {}, runner: {
			start() { launches++; return { pid: 5001 }; },
		} });
		t.after(() => auditor.close());
		assert.equal(requestAudit(paths, subject, now).created, true);
		await auditor.tick(now);
		await auditor.preparing();
		await auditor.tick(now);
		assert.deepEqual([launches, auditsToday(paths, now)], [0, 0]);
	});
}

function paddedHeader(row, bytes = 96 * 1024 - 1) {
	const header = E.header(row.sessionId, row.cwd, now - 1000);
	const base = { type: header.type, metadata: "", id: header.id, cwd: header.cwd };
	return JSON.stringify({ ...base, metadata: "x".repeat(bytes - Buffer.byteLength(JSON.stringify(base))) });
}

for (const [label, foreign] of [["resolves its owner", false], ["refuses a foreign project at the exact filename", true]]) {
	test(`plan124 a 96 KiB header ${label}`, (t) => {
		const { paths, a, b } = setup(t);
		const alice = main("review.1", a);
		const subject = subjectOf(alice);
		const file = path.join(paths.sessionsDir, subject.projectKey, foreign ? reviewName : "custom.jsonl");
		const header = paddedHeader(foreign ? main(alice.sessionId, b) : alice);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${header}\n${JSON.stringify(usageLine(99))}\n`);
		const locator = createSessionFileLocator({ paths, clock });
		const clipped = locator.findMainFile(subject, null, { maxBytes: 80 * 1024 });
		const found = locator.findMainFile(subject);
		assert.deepEqual([clipped.file, clipped.pending, clipped.bytesRead, found.file, found.pending],
			[undefined, true, 80 * 1024, foreign ? undefined : file, false]);
	});
}

test("plan124 a session header at EOF without its newline is pending until it is finished", (t) => {
	const { paths, a } = setup(t);
	const alice = main("review.1", a);
	const subject = subjectOf(alice);
	const file = path.join(paths.sessionsDir, subject.projectKey, reviewName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, paddedHeader(alice));
	const locator = createSessionFileLocator({ paths, clock });
	const { tracker } = openTracker(paths);
	const live = { ...world, sessions: new Map([[alice.sessionId, { ...alice, id: alice.sessionId, file }]]) };
	const found = locator.findMainFile(subject);
	tracker.tick(live);
	const display = tracker.tokensOf(subject);
	assert.deepEqual([found.file, found.pending, display?.tokens?.total, display?.pending], [undefined, true, undefined, true]);
	fs.appendFileSync(file, `\n${JSON.stringify(usageLine(99))}\n`);
	assert.equal(locator.mainFile(subject), file);
	tracker.tick(live);
	assert.equal(tracker.tokensOf(subject)?.tokens.total, 99);
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

function misplacedChild(t) {
	const { paths, a, b } = setup(t);
	const alice = { ...main("review.1", a), kind: "child", taskId: "st_review" };
	const bob = { ...main("review.1", b), kind: "child", taskId: "st_review" };
	const text = "Project B private child notice";
	const files = [alice, bob].map((row) => {
		assert.ok(appendEnded(paths, row, { nowMs: now }));
		const file = path.join(taskStoreDir(row.cwd), "children", row.taskId, "sessions", row.taskId, reviewName);
		writeJsonl(file, [
			E.header(bob.sessionId, b, now - 1000),
			{ ...E.custom("omo-health", now - 100), content: text },
			usageLine(17),
		]);
		return file;
	});
	return { paths, alice, bob, text, files };
}

test("plan123 history detail refuses a same-name foreign child with no index entry", (t) => {
	const { paths, alice, bob, text, files } = misplacedChild(t);
	const operate = createDetailOperations({ paths, auditDetail: () => null });
	const detail = (row) => {
		const result = operate({ kind: "detail", id: row.sessionId, row: expectedSelector(row), now });
		assert.equal(result.record.found, true);
		return {
			files: result.files,
			messages: result.record.health.messages.map((message) => message.text),
			tokens: result.record.tokens?.total ?? null,
		};
	};
	assert.equal(fs.existsSync(paths.health.usageIndexFile), false);
	const cold = detail(alice);
	const { index, tracker } = openTracker(paths);
	assert.equal(tracker.queueLedger(streamEnded(paths, { withLocation: true })), 2);
	tracker.tick(world);
	assert.equal(index.save(), true);
	assert.deepEqual(detail(bob), { files: [files[1]], messages: [text], tokens: 17 });
	assert.deepEqual(cold, { files: [], messages: [], tokens: null });
});

for (const [mode, options] of [["timeline", {}], ["index-only", { timelineMaxBytes: 1 }]]) {
	test(`plan123 a ${mode} queued audit refuses a foreign child despite the matching index stamp`, async (t) => {
		const fixture = misplacedChild(t);
		fs.mkdirSync(path.dirname(fixture.paths.authFile), { recursive: true });
		const { index } = openTracker(fixture.paths);
		index.update(subjectOf(fixture.alice), fixture.files[0], { kind: "child" });
		await assertMisplacedAuditRefused(t, { ...fixture, index }, options);
	});
}

for (const route of ["live", "ledger"]) {
	test(`plan122 ${route} first child read refuses a same-name foreign transcript from a cold index`, (t) => {
		const { paths, a, b } = setup(t);
		const alice = { ...main("review.1", a), kind: "child", taskId: "st_review" };
		const bob = { ...main("review.1", b), kind: "child", taskId: "st_review" };
		const foreign = [E.header(bob.sessionId, b, now - 1000), E.assistant({
			ms: now - 50, provider: "openai", model: "gpt-5-5", usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
		})];
		const sessions = [alice, bob].map((row) => {
			assert.ok(appendEnded(paths, row, { nowMs: now }));
			const file = path.join(taskStoreDir(row.cwd), "children", row.taskId, "sessions", row.taskId, reviewName);
			writeJsonl(file, foreign);
			return { ...row, id: row.sessionId, file };
		});
		const { index, tracker } = openTracker(paths);
		assert.deepEqual([...index.values()], []);
		if (route === "ledger") {
			assert.equal(tracker.queueLedger(streamEnded(paths, { withLocation: true })), 2);
			tracker.tick(world);
		} else {
			tracker.tick({ ...world, sessions: new Map(sessions.map((row) => [row.cwd, row])) });
		}
		const publication = (row) => {
			const subject = subjectOf(row);
			return [tracker.tokensOf(subject)?.tokens?.total ?? null,
				Object.keys(usageEntryFor(index, subject)?.published?.usedModels ?? {})];
		};
		assert.deepEqual(publication(bob), [99, ["openai/gpt-5-5"]]);
		assert.deepEqual(publication(alice), [null, []]);
	});

	for (const change of ["replacement", "in-place rewrite"]) {
		test(`plan121 ${route} child recount refuses a cross-project ${change}`, (t) => {
			const { paths, a, b } = setup(t);
			const child = { ...main("review.1", a), kind: "child", taskId: "st_review" };
			const subject = subjectOf(child);
			const file = path.join(taskStoreDir(a), "children", child.taskId, "sessions", child.taskId, reviewName);
			writeJsonl(file, [E.header(child.sessionId, a, now - 1000), usageLine(17)]);
			const liveWorld = { ...world, sessions: new Map([[child.sessionId, { ...child, id: child.sessionId, file }]]) };
			let { index, tracker } = openTracker(paths);
			tracker.tick(liveWorld);
			assert.equal(tracker.tokensOf(subject)?.tokens.total, 17);
			const models = { ...usageEntryFor(index, subject).published.usedModels };
			assert.equal(index.save(), true);
			const foreign = [E.header(child.sessionId, b, now - 1000), E.assistant({
				ms: now - 50, provider: "openai", model: "gpt-5-5", usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
			})];
			if (change === "replacement") {
				writeJsonl(`${file}.new`, foreign);
				fs.renameSync(`${file}.new`, file);
			} else {
				writeJsonl(file, foreign);
			}
			if (route === "ledger") {
				assert.ok(appendEnded(paths, child, { nowMs: now }));
				({ index, tracker } = openTracker(paths));
				assert.equal(tracker.queueLedger(streamEnded(paths, { withLocation: true })), 1);
			}
			tracker.tick(route === "live" ? liveWorld : world);
			const entry = usageEntryFor(index, subject);
			const display = tracker.tokensOf(subject);
			assert.deepEqual([display?.tokens.total, entry.published.usedModels, display?.pending, fresh(entry)],
				[17, models, true, false]);
		});
	}
}
