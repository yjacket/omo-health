import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { AUDIT_LIST_CAPS, auditBundle } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { buildSessionRecord, loadSessionRecord, scanOmoHealthMessages } from "../src/session-record.mjs";
import * as sessionRecord from "../src/session-record.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildSessionView } from "../src/ui/session-view.mjs";
import { fresh } from "../src/usage-index.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";
import { indexLiveParentTranscript } from "./helpers/live-parent-transcript.mjs";
import { relayDecisions } from "./helpers/relay-decisions.mjs";

const T0 = Date.parse("2026-10-10T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

test("plan38 decision inventory covers all writer event literals", () => {
	const src = new URL("../src/", import.meta.url);
	const table = sessionRecord.DECISION_EVENT_SHAPES ?? {};
	const missing = new Set();
	const checked = new Set();
	for (const file of fs.readdirSync(src, { recursive: true }).filter((name) => name.endsWith(".mjs"))) {
		const text = fs.readFileSync(new URL(file.replaceAll("\\", "/"), src), "utf8");
		for (const [, body] of text.matchAll(/\b(?:appendDecision(?:Impl)?\([^,]+,|decision\(|ctx\.decide\?\.\()\s*\{([\s\S]*?)\}\s*\);/g)) {
			const event = /\bevent:\s*["']([\w-]+)["']/.exec(body)?.[1] ?? "(no event)";
			checked.add(event);
			if (!Object.hasOwn(table, event)) missing.add(`${file}: ${event}`);
		}
	}
	assert.deepEqual([...missing], []);
	assert.deepEqual([...checked].sort(), Object.keys(table).sort());
});

test("plan38 action producer shapes survive record, detail and audit projection", () => {
	const sessionId = "s-actions";
	const subject = { sessionId };
	const ts = iso(T0 + MIN);
	const row = { sessionId, kind: "main", startedMs: T0, endedMs: T0 + HOUR };
	const inv = { fp: "fp-action", detector: "D1", kind: "stall", cls: "quiet-hang", event: "investigation", status: "open" };
	const ordinary = { fp: inv.fp, detector: inv.detector, kind: inv.kind, cls: inv.cls, rule: undefined, action: { key: "r", kind: "release-shell", params: {} }, subject, evidence: [] };
	const park = { detector: "D20", kind: "park-resume", subject, parkId: "park-1" };
	const cases = [
		// src/engine.mjs:1191,1216 (gate and execution).
		[{ ...ordinary, result: "would" }, "release-shell", "would", "기다리던 셸 해제"],
		[{ ...ordinary, result: "execute", outcome: { killed: ["proc:5"], survived: [], noop: [], quiet: true } }, "release-shell", "execute", "기다리던 셸 해제", { killed: 1 }],
		// src/engine.mjs:327.
		...[["shown", true, false], ["cooldown", false, false], ["failed", false, true]].map(([toast, delivered, error]) =>
			[{ ...inv, result: "hold-toast", toast }, "hold-toast", toast, "조사 지연 알림", { delivered, error }]),
		// src/engine.mjs:462.
		...["expired", "restored"].map((reason) => [{ detector: "D16", kind: "orphan-monitor", event: "notice-withdrawn", result: `withdrawn:${reason}`, subject, messageId: "notice-private", monitors: ["monitor-private"] }, "notice-withdrawn", `withdrawn:${reason}`, "대기 중인 안내 철회"]),
		// src/engine.mjs:209 wrapping 570,576,632/643/742 and 669/719.
		[{ ...inv, trigger: "stall", status: "released", result: "released", acted: { key: "r", kind: "release-shell", quiet: true }, killed: ["proc(5)"] }, "release-shell", "released", "기다리던 셸 해제", { killed: 1 }],
		[{ ...inv, trigger: "stall", result: "no-effect", acted: { key: "r", kind: "release-shell" }, killed: [] }, "release-shell", "no-effect", "기다리던 셸 해제", { killed: 0 }],
		...[["relay-cancel", "부모 세션에 취소 권고"], ["why-notice", "원인 알림"], ["goal-wake", "goal 세션 깨우기"]].map(([kind, ko]) =>
			[{ ...inv, trigger: "stall", status: "advised", result: "advised", acted: { key: "r", kind }, delivered: false }, kind, "advised", ko, { delivered: false }]),
		[{ ...inv, trigger: "stall", status: "noticed", result: "noticed", acted: { key: "r", kind: "main-notice" }, delivered: true }, "main-notice", "noticed", "메인 세션 정지 의심 안내", { delivered: true }],
		[{ ...inv, detector: "report", kind: "report", trigger: "report", status: "noticed", result: "noticed", acted: { key: "r", kind: "triage-notice" }, delivered: true }, "triage-notice", "noticed", "보고에 대한 판정 알림", { delivered: true }],
		// src/act/park-resume.mjs:154–155,259,284,287.
		[{ ...park, event: "park-gated", result: "skipped:paused" }, "relaunch", "skipped:paused", "한도 대기 세션 다시 열기"],
		[{ ...park, event: "park-transition", sessionId, from: "claimed", to: "launched", why: "launched" }, "relaunch", "launched", "한도 대기 세션 다시 열기"],
		[{ ...park, event: "park-transition", sessionId, from: "claimed", to: "pending", why: "launch-failed" }, "relaunch", "launch-failed", "한도 대기 세션 다시 열기", { error: true }],
	];
	for (const [decision, kind, result, actionKo, facts = {}] of cases) {
		const decisions = [
			{ fp: inv.fp, detector: inv.detector, kind: inv.kind, cls: inv.cls, severity: "warn", event: "opened", subject, evidence: [], ts },
			{ ...park, event: "park-transition", sessionId, from: "pending", to: "claimed", why: "claim", ts },
			{ ...decision, ts },
		];
		const record = buildSessionRecord({ row, decisions });
		assert.equal(record.health.actions.length, 1, `${result} (${kind})`);
		const [action] = record.health.actions;
		assert.deepEqual([action.kind, action.result, action.ts, action.subject], [kind, result, ts, subject]);
		if (!decision.action) assert.equal(action.detail, "");
		const [view] = buildSessionView(record).health.actions;
		assert.deepEqual([view.kind, view.result, view.ts, view.actionKo], [kind, result, ts, actionKo]);
		const bundle = auditBundle(record, null, { config: DEFAULT_CONFIG, now: T0 + HOUR });
		assert.equal(bundle.omo_health_record.actions.length, 1);
		const [audited] = bundle.omo_health_record.actions;
		assert.deepEqual([audited.kind, audited.result, audited.ts], [kind, result, ts]);
		for (const [key, value] of Object.entries(facts)) {
			assert.deepEqual([action.facts[key], view.facts[key], audited[key]], [value, value, value]);
		}
		assert.doesNotMatch(JSON.stringify([action, view, audited]), /notice-private|monitor-private/);
	}
});

function setup() {
	const root = tmpDir("omoh-record-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return { root, paths };
}

function writeLedger(paths, rows) {
	fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
	const byDay = new Map();
	for (const row of rows) {
		const day = iso(row.endedMs).slice(0, 10);
		byDay.set(day, [...(byDay.get(day) ?? []), { v: 1, outcome: "answered", reason: "done", source: "live", ...row }]);
	}
	for (const [day, list] of byDay) fs.appendFileSync(path.join(paths.health.sessionsDir, `ended-${day}.jsonl`), `${list.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function writeDecisions(paths, entries) {
	fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
	const byDay = new Map();
	for (const entry of entries) {
		const ts = entry.ts ?? iso(T0);
		const day = ts.slice(0, 10);
		byDay.set(day, [...(byDay.get(day) ?? []), { ...entry, ts }]);
	}
	for (const [day, list] of byDay) fs.appendFileSync(path.join(paths.health.decisionsDir, `${day}.jsonl`), `${list.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function writeInvestigation(paths, record) {
	fs.mkdirSync(paths.health.investigationsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.investigationsDir, `${record.id}.json`), JSON.stringify({ openedMs: T0, updatedMs: T0, status: "open", evidence: [], signals: [], ...record }));
}

function mainSessionFile(paths, id, entries = []) {
	const file = path.join(paths.sessionsDir, "slug", `2026-10-10T00-00-00-000Z_${id}.jsonl`);
	writeJsonl(file, entries.length ? entries : [{ type: "session", id }]);
	return file;
}

function childSessionFile(cwd, taskId, childId, entries = []) {
	return writeTask(cwd, { task_id: taskId, child_session_id: childId, status: "completed" }, entries.length ? entries : [{ type: "session", id: childId }]);
}

let messageSeq = 0;
const ohealth = (ms, text) => ({ type: "custom_message", customType: "omo-health", id: `oh-${++messageSeq}`, timestamp: iso(ms), content: text, details: { kind: "self-notice" } });
const mainRow = (extra = {}) => ({ sessionId: "s-main", kind: "main", parentSessionId: null, taskId: null, title: "main", cwd: "C:/work/a", terminal: { kind: "wt" }, omoVersion: "0.8.0", startedMs: T0, endedMs: T0 + 2 * HOUR, childCount: 2, ...extra });
const childRow = (sessionId, taskId, parentSessionId, extra = {}) => ({ sessionId, kind: "child", parentSessionId, taskId, title: sessionId, cwd: "C:/work/a", terminal: null, omoVersion: null, startedMs: T0 + 10 * MIN, endedMs: T0 + 70 * MIN, ...extra });

test("IS-7 indexed transcript: detail shows messages for a child and descendant located through a live parent", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const { index, child, grandchild } = indexLiveParentTranscript(paths, root, T0, { descendant: true });
	for (const { id, file } of [child, grandchild]) {
		assert.equal(index.get(id)?.file, file);
		assert.equal(fresh(index.get(id)), true);
	}
	const detail = createDetailOperations({ paths, auditDetail: () => null });
	const job = { kind: "detail", id: child.id, now: T0 };
	const result = detail(job);
	assert.equal(result.record.tokens.total, 51_302);
	assert.deepEqual(result.record.health.messages, [grandchild, child].map(({ id, ms, kind, text }) => ({ ms, kind, recipient: id, text })));
	assert.deepEqual(result.files, [child.file, grandchild.file]);

	fs.appendFileSync(child.file, "\n");
	assert.equal(fresh(index.get(child.id)), false);
	const afterAppend = detail(job);
	assert.deepEqual(afterAppend.record.health.messages.map(({ recipient }) => recipient), [grandchild.id]);
	assert.deepEqual(afterAppend.files, [grandchild.file]);
});

test("IS-7 indexed transcript: an ambiguous task-only path is not used by detail", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const { index, child } = indexLiveParentTranscript(paths, root, T0, { taskOnly: true });
	assert.equal(fresh(index.get(child.id)), true);
	writeJsonl(path.join(path.dirname(child.file), "second-session.jsonl"), [ohealth(child.ms, "Another owner")]);
	const detail = createDetailOperations({ paths, auditDetail: () => null });
	const result = detail({ kind: "detail", id: child.id, now: T0 });
	assert.ok(result.record.found);
	assert.equal(result.record.tokens, null);
	assert.deepEqual(result.record.health.messages, []);
	assert.deepEqual(result.files, []);
});

test("IS-8: records retain only config decision times and hashes, including reloads after session end", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const row = mainRow();
	const times = [T0 + MIN, row.endedMs + MIN, row.endedMs + 2 * MIN];
	const thresholdsHash = "a".repeat(64);
	const decisions = [
		{ ts: iso(times[0]), event: "config", result: "applied", thresholdsHash, changed: ["tokens.cacheStormWrite"] },
		{ ts: iso(times[0] + 1), event: "coverage", infoFindings: true },
		{ ts: iso(times[1]), event: "config", result: "applied", thresholdsHash: "b".repeat(64) },
		{ ts: iso(times[2]), event: "config", result: "rejected", message: "config detail" },
	];
	writeLedger(paths, [row]);
	writeDecisions(paths, decisions);
	const now = times[2] + MIN;
	for (const record of [
		buildSessionRecord({ row, decisions, now }),
		loadSessionRecord({ paths, id: row.sessionId, now }),
		loadSessionRecord({ paths, id: row.sessionId, now, auditRetention: true }),
	]) {
		assert.deepEqual(record.configDecisions, [{ ms: times[0], thresholdsHash }, { ms: times[1], thresholdsHash: "b".repeat(64) }, { ms: times[2], thresholdsHash: null }]);
		assert.deepEqual(record.health.findings, []);
		assert.doesNotMatch(JSON.stringify(record), /cacheStormWrite|config detail/);
	}
});

test("IS-7: each relay delivery has one action in the record and detail", () => {
	const row = mainRow();
	const first = relayDecisions(T0 + MIN, row.sessionId, "s-child-1");
	const second = relayDecisions(T0 + MIN + 10, row.sessionId, "s-child-2");
	for (const relays of [[first], [first, second]]) {
		const record = buildSessionRecord({ row, decisions: relays.flat() });
		const view = buildSessionView(record);
		assert.deepEqual([record.health.actions.length, record.health.counts.actions, view.health.actions.length], Array(3).fill(relays.length));
		for (const [index, action] of view.health.actions.entries()) {
			assert.deepEqual([action.ts, action.kind, action.result, action.recipient, action.facts.delivered, action.facts.via],
				[relays.at(-1 - index)[2].ts, "relay-cancel", "execute", row.sessionId, true, "inbox"]);
			assert.match(action.detail, /advised/);
		}
	}
});

test("IS-7: ancestor detail retains both task-only descendants with the same task id", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = mainRow({ cwd: root });
	const taskId = "st_x";
	const parents = [1, 2].map((i) => childRow(`s-parent-${i}`, `st_parent_${i}`, main.sessionId, { cwd: path.join(root, `project-${i}`) }));
	const children = parents.map(({ sessionId, cwd }) => childRow(taskId, taskId, sessionId, { cwd }));
	const messages = children.map(({ cwd }, i) => {
		const message = ohealth(T0 + (i + 1) * MIN, `notice from project ${i + 1}`);
		childSessionFile(cwd, taskId, `s-transcript-${i + 1}`, [message]);
		return message;
	});
	writeLedger(paths, [main, ...parents, ...children]);
	const fallback = { id: "s-transcript-1", taskId, state: "ok", published: { total: 42 } };
	const index = new Map([
		...parents.map(({ sessionId, taskId, parentSessionId }) => [sessionId, { id: sessionId, taskId, parentSessionId }]),
		[fallback.id, fallback],
	]);
	assert.equal(sessionRecord.usageEntryOf(index, children[0])?.published.total, 42);
	const options = { paths, id: main.sessionId, now: main.endedMs, index };
	const full = buildSessionView(loadSessionRecord(options));
	const bounded = loadSessionRecord({ ...options, auditRetention: true });
	const pure = buildSessionRecord({ row: main, ledger: [main, ...parents, ...children], usage: index });
	const childDetails = (record) => record.children
		.map(({ sessionId, parentSessionId, tokens }) => [sessionId, parentSessionId, tokens])
		.sort();
	const expectedChildren = [...parents, ...children].map(({ sessionId, parentSessionId }) => [sessionId, parentSessionId, null]).sort();
	assert.deepEqual({
		children: childDetails(full),
		messages: full.health.messages.map(({ recipient, text }) => [recipient, text]),
		boundedCount: bounded.health.counts.messages,
		boundedMessages: bounded.health.messages.map(({ ms, kind }) => [ms, kind]),
		pureChildren: childDetails(pure),
	}, {
		children: expectedChildren,
		messages: messages.toReversed().map(({ content }) => [taskId, content]),
		boundedCount: 2,
		boundedMessages: messages.toReversed().map(({ timestamp, details }) => [Date.parse(timestamp), details.kind]),
		pureChildren: expectedChildren,
	});
});

for (const auditRetention of [false, true]) {
	test(`IS-8: the ${auditRetention ? "bounded" : "full"} record keeps only valid delivered message kinds`, () => {
		const { paths } = setup();
		const row = mainRow();
		writeLedger(paths, [row]);
		mainSessionFile(paths, row.sessionId, [
			{ ...ohealth(T0 + MIN, "SECRET-TEXT"), details: { kind: "scope-check", reason: "SECRET-DETAIL" } },
			{ ...ohealth(T0, "invalid kind"), details: { kind: "a".repeat(42) } },
		]);
		const record = loadSessionRecord({ paths, id: row.sessionId, now: row.endedMs, auditRetention });
		assert.deepEqual(record.health.messages.map(({ kind }) => kind), ["scope-check", null]);
	});
}

test("(IS-9 launch refresh) full and bounded records retain the exact join keys outside the row caps", () => {
	const { paths } = setup();
	const row = mainRow();
	const subject = { sessionId: row.sessionId };
	writeLedger(paths, [row]);
	const findings = Array.from({ length: AUDIT_LIST_CAPS.findings + 1 }, (_, i) => ({
		ts: iso(T0 + i), fp: `decision-${i}`, event: "opened", detector: "D1", subject, evidence: ["private evidence"],
	}));
	writeDecisions(paths, [...findings, { fp: "machine-only", event: "opened", detector: "D2" }]);
	const investigations = Array.from({ length: AUDIT_LIST_CAPS.investigations + 1 }, (_, i) => ({
		id: `file-${i}`, subject, openedMs: T0 + i, evidence: ["private evidence"],
	}));
	for (const investigation of investigations) writeInvestigation(paths, investigation);
	const expected = [...findings.map(({ fp }) => fp), ...investigations.map(({ id }) => id)].sort();
	for (const auditRetention of [true, false]) {
		const record = loadSessionRecord({ paths, id: row.sessionId, now: row.endedMs, auditRetention });
		if (auditRetention) {
			assert.ok(!record.health.findings.some(({ fp }) => fp === "decision-0"));
			assert.ok(!record.health.investigations.some(({ id }) => id === "file-0"));
		}
		assert.ok(Array.isArray(record.selectedFps), "the record must expose the selected investigation fingerprints");
		assert.deepEqual(record.selectedFps.toSorted(), expected);
		assert.doesNotMatch(JSON.stringify(auditBundle(record, null, { config: DEFAULT_CONFIG, now: row.endedMs })), /selectedFps|decision-0"|file-0"/);
	}
});

test("IS-10: bounded normal session produces the same bundle without dashboard prose", () => {
	const { paths } = setup();
	const subject = { sessionId: "s-main" };
	writeLedger(paths, [mainRow()]);
	writeDecisions(paths, [
		{ fp: "inv", event: "opened", detector: "D1", subject, evidence: ["quiet:10ms", "private evidence", "quiet:20ms"] },
		{ fp: "inv", event: "investigation", model: "p/old", analyst: { verdict: "wait", reason: "timeout: analyst notes", diagnosis: "private diagnosis" } },
		{ ts: iso(T0 + MIN), outcome: { sessionId: subject.sessionId }, action: { kind: "notify" }, result: "would" },
		{ ts: iso(T0 + MIN), subject, action: { kind: "nudge" }, result: "would" },
		{ ts: iso(T0 - MIN), fp: "machine", event: "opened", detector: "D2", evidence: ["commit:90%", "machine prose"] },
	]);
	writeInvestigation(paths, { id: "inv", subject, model: "p/current", evidence: ["private evidence"], verdict: { verdict: "wait", reason: "timeout: notes", diagnosis: "private diagnosis" }, actions: [{ kind: "nudge", delivered: false, advice: "private advice" }] });
	mainSessionFile(paths, subject.sessionId, [ohealth(T0, "private message")]);
	const options = { paths, id: subject.sessionId, now: T0 + 2 * HOUR };
	const full = loadSessionRecord(options);
	const bounded = loadSessionRecord({ ...options, auditRetention: true });
	const bundle = (record) => auditBundle(record, null, { config: DEFAULT_CONFIG, now: options.now });
	const unrestricted = bundle(full);
	assert.deepEqual(bundle(bounded), unrestricted);
	assert.deepEqual(Object.fromEntries(Object.entries(unrestricted.omo_health_record).map(([key, rows]) => [key, rows.length])), full.health.counts);
	assert.deepEqual(unrestricted.truncated, { messagesSkipped: 0, hours: false, topTurns: false, findings: false, actions: false, messages: false, investigations: false });
	assert.deepEqual(bounded.health.counts, { findings: 2, actions: 2, investigations: 1, messages: 1 });
	assert.deepEqual(bounded.analystModels, ["p/current", "p/old"]);
	assert.doesNotMatch(JSON.stringify(bounded.health), /private|machine prose/);
	assert.match(JSON.stringify(full.health), /private message/);
});

test("IS-8/IS-10: QA-3's 56 messages yield the same 50 audit refs and flags on both paths", () => {
	const { paths } = setup();
	const rows = baseRows().filter(({ sessionId }) => ["s-main", "s-child", "s-grand"].includes(sessionId))
		.map((row) => ({ ...row, cwd: paths.repoRoot }));
	const [main, child, grandchild] = rows;
	writeLedger(paths, rows);
	const mainMessages = Array.from({ length: 55 }, (_, i) => ohealth(T0 + (i + 1) * 2 * MIN, `QA-MSG-${i + 1}`));
	const grandchildMessage = ohealth(T0 + 51 * MIN, "QA-MSG-grandchild");
	mainSessionFile(paths, main.sessionId, mainMessages);
	childSessionFile(child.cwd, child.taskId, child.sessionId);
	childSessionFile(grandchild.cwd, grandchild.taskId, grandchild.sessionId, [grandchildMessage]);
	const options = { paths, id: main.sessionId, now: main.endedMs };
	const full = loadSessionRecord(options);
	const bounded = loadSessionRecord({ ...options, auditRetention: true });
	assert.equal(full.health.messages.length, 56);
	assert.equal(bounded.health.counts.messages, 56);
	const bundle = (record) => auditBundle(record, null, { config: DEFAULT_CONFIG, now: options.now });
	const retainedBundle = bundle(bounded);
	const unrestricted = bundle(full);
	assert.deepEqual(
		{ count: unrestricted.omo_health_record.messages.length, truncated: unrestricted.truncated.messages },
		{ count: 50, truncated: true },
	);
	assert.deepEqual(retainedBundle, unrestricted);
	const newest = [...mainMessages, grandchildMessage].map(({ timestamp }) => Date.parse(timestamp)).sort((a, b) => b - a).slice(0, 50);
	assert.deepEqual(retainedBundle.omo_health_record.messages.map(({ ref, ms }) => [ref, ms]), newest.map((ms, i) => [`M${i + 1}`, ms]));
	assert.deepEqual(retainedBundle.truncated, { messagesSkipped: 0, hours: false, topTurns: false, findings: false, actions: false, messages: true, investigations: false });
});

test("IS-10: bounded scan keeps oldest detector representatives and exact history counts", () => {
	const { paths } = setup();
	const subject = { sessionId: "s-main" };
	writeLedger(paths, [mainRow()]);
	writeDecisions(paths, [
		{ fp: "oldest", event: "opened", detector: "D25", subject },
		{ fp: "old-machine", event: "opened", detector: "D24" },
		...Array.from({ length: 60 }, (_, i) => {
			const ts = iso(T0 + (60 - i) * MIN);
			return [
				{ ts, fp: `f-${i}`, event: "opened", detector: "D1", subject },
				{ ts, fp: `machine-${i}`, event: "opened", detector: "D2" },
				{ ts, subject, action: { kind: "nudge" }, result: "would" },
			];
		}).flat(),
		{ fp: "inv-0", event: "investigation", model: "p/old" },
		{ fp: "inv-0", event: "notice-withdrawn", result: "withdrawn" },
	]);
	for (let i = 0; i < 35; i++) writeInvestigation(paths, { id: `inv-${i}`, subject, openedMs: T0 + i, model: i === 0 ? "p/old-file" : "p/current" });
	mainSessionFile(paths, subject.sessionId, Array.from({ length: 60 }, (_, i) => ohealth(T0 + (60 - i) * MIN, "private message")));
	const options = { paths, id: subject.sessionId, now: T0 + 2 * HOUR };
	const bounded = loadSessionRecord({ ...options, auditRetention: true });
	const full = loadSessionRecord(options);
	const { health } = bounded;
	assert.deepEqual(health.counts, full.health.counts);
	assert.deepEqual(health.counts, { findings: 122, actions: 61, investigations: 35, messages: 60 });
	assert.equal(health.findings.filter(({ scope }) => scope === "session").length, 51);
	assert.equal(health.findings.filter(({ scope }) => scope === "machine").length, 21);
	assert.deepEqual(health.findings.slice(-2).map(({ fp }) => fp), ["oldest", "old-machine"]);
	assert.deepEqual(health.firedDetectors, ["D1", "D2", "D25", "D24"]);
	assert.deepEqual(bounded.analystModels, full.analystModels);
	assert.deepEqual(health.actions.map(({ ts }) => ts), full.health.actions.slice(0, 50).map(({ ts }) => ts));
	assert.deepEqual(health.investigations.map(({ id }) => id), full.health.investigations.slice(0, 30).map(({ id }) => id));
	assert.deepEqual(health.messages.map(({ ms }) => ms), full.health.messages.slice(0, 50).map(({ ms }) => ms));
	const bundle = auditBundle(bounded, null, { config: DEFAULT_CONFIG, now: options.now });
	assert.equal(bundle.omo_health_record.findings.length, 50);
	assert.equal(bundle.omo_health_record.findings.filter(({ scope }) => scope === "machine").length, 20);
	assert.deepEqual(bundle.omo_health_record.findings.slice(-2).map(({ detector }) => detector), ["D25", "D24"]);
	assert.ok(["findings", "actions", "messages", "investigations"].every((key) => bundle.truncated[key]));
});

test("(plan 35) loadSessionRecord selects the exact ledger session ID and row selector", () => {
	const { paths } = setup();
	const id = "st_shared";
	const a = childRow(id, id, "parent-a", { title: "older" });
	const b = childRow(id, id, "parent-b", { title: "newer", endedMs: a.endedMs + 1 });
	const c = childRow("child-c", "st_c", "parent-c");
	writeLedger(paths, [a, b, c]);
	const options = { paths, id, now: T0 + 2 * HOUR };
	const selected = (overrides) => loadSessionRecord({ ...options, ...overrides });
	assert.deepEqual([a, b].map((row) => {
		const { session, tokens } = selected({ row: expectedSelector(row) });
		return [session.title, session.parentSessionId, session.endedMs, tokens, session.usageTaskIdAmbiguous];
	}), [
		[a.title, a.parentSessionId, a.endedMs, null, true],
		[b.title, b.parentSessionId, b.endedMs, null, true],
	]);
	assert.equal(selected().session.title, b.title);
	assert.deepEqual(selected({ row: expectedSelector({ ...b, endedMs: b.endedMs + 1 }) }), { found: false, id });
	assert.deepEqual(selected({ id: c.taskId, row: expectedSelector(c) }), { found: false, id: c.taskId });
});

function baseRows() {
	return [
		mainRow(),
		mainRow({ sessionId: "s-unrelated", title: "unrelated", startedMs: T0 + MIN, endedMs: T0 + 3 * HOUR }),
		childRow("s-child", "st_a", "s-main"),
		childRow("s-grand", "st_c", "s-child", { startedMs: T0 + 20 * MIN, endedMs: T0 + 80 * MIN }),
		childRow("s-u-child", "st_u", "s-unrelated"),
	];
}

/** The rich selection corpus: every acceptance join gets one decision family. */
function corpus() {
	return {
		rows: baseRows(),
		decisions: [
			{ fp: "fp-direct", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main", taskId: null }, evidence: ["direct"] },
			{ fp: "fp-direct", event: "resolved", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main", taskId: null }, afterMs: 1000 },
			{ fp: "fp-fp", action: { key: "nudge:fp-fp", kind: "nudge" }, result: "execute", outcome: { delivered: true, sessionId: "s-main", via: "fp-join" }, detector: "D8", kind: "dead-child" },
			{ fp: "fp-wake", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-main" } },
			{ fp: "fp-wake", action: { key: "wake-parent:fp-wake", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-main", via: "wake" }, detector: "D1", kind: "stall" },
			{ fp: "fp-child", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-child", taskId: "st_a", parentSessionId: null } },
			{ fp: "fp-grand", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-grand", taskId: "st_c" } },
			{ fp: "fp-deliver", action: { key: "notify:fp-deliver", kind: "notify" }, result: "execute", outcome: { delivered: true, sessionId: "s-main" }, detector: "D2", kind: "machine-commit" },
			{ fp: "fp-grand-deliver", action: { key: "wake-parent:fp-grand", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-grand" }, detector: "D1", kind: "stall" },
			{ fp: "fp-unrelated", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-unrelated", taskId: null } },
			{ fp: "fp-unrelated", action: { key: "nudge:fp-unrelated", kind: "nudge" }, result: "execute", outcome: { delivered: true, sessionId: "s-unrelated" }, detector: "D8", kind: "dead-child" },
			{ fp: "fp-u-child", event: "opened", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "s-u-child", taskId: "st_u" } },
			{ fp: "fp-direct", event: "investigation", ts: iso(T0 + 30 * MIN), analyst: { verdict: "escalate", assessment: "abnormal", cause: "stuck", confidence: 0.8, diagnosis: "first" } },
			{ fp: "fp-direct", event: "investigation", ts: iso(T0 + 40 * MIN), analyst: { verdict: "wait", assessment: "normal", confidence: 0.6, diagnosis: "second" } },
			{ fp: "fp-child", event: "investigation", ts: iso(T0 + 4 * HOUR), analyst: { verdict: "act", assessment: "abnormal", confidence: 0.9, diagnosis: "after parent end" } },
			{ fp: "fp-unrelated", event: "investigation", ts: iso(T0 + 4 * HOUR), analyst: { verdict: "act", assessment: "abnormal", confidence: 0.9, diagnosis: "unrelated" } },
			{ event: "coverage", infoFindings: true, ts: iso(T0 - HOUR) },
		],
		investigations: [
			{ id: "fp-direct", subject: { sessionId: "s-main", taskId: null, toolCallId: null, parentSessionId: null }, detector: "D1", kind: "stall" },
			{ id: "fp-fp", subject: { sessionId: "s-main" }, detector: "D8", kind: "dead-child" },
			{ id: "fp-child", subject: { sessionId: "s-child", taskId: "st_a", parentSessionId: null }, detector: "D8", kind: "dead-child" },
			{ id: "fp-grand", subject: { sessionId: "s-grand", taskId: "st_c" }, detector: "D8", kind: "dead-child" },
			{ id: "fp-unrelated", subject: { sessionId: "s-unrelated", taskId: null }, detector: "D1", kind: "stall" },
			{ id: "fp-u-child", subject: { sessionId: "s-u-child", taskId: "st_u" }, detector: "D8", kind: "dead-child" },
		],
	};
}

function recordForMain(extra = {}) {
	const fixture = corpus();
	const row = fixture.rows[0];
	return buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations, messages: [], ...extra });
}

function fprs(record, list = "findings") {
	return record.health[list].map((item) => item.fp);
}

test("a direct-subject finding is listed with its investigation", () => {
	const record = recordForMain();
	assert.equal(record.found, true);
	assert.ok(fprs(record, "findings").includes("fp-direct"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-direct"));
});

test("an fp-joined action whose investigation exists is listed", () => {
	const record = recordForMain();
	assert.ok(record.health.actions.some((item) => item.facts.via === "fp-join" && item.facts.delivered === true));
});

test("a wake-parent action with no investigation joins through its finding's opened entry", () => {
	const record = recordForMain();
	assert.ok(record.health.actions.some((item) => item.facts.via === "wake" && item.facts.delivered === true));
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-wake"), false);
	assert.ok(record.health.findings.some((item) => item.fp === "fp-wake" && item.event === "opened"));
});

test("IS-7: the child record includes D8 findings and wake-parent decisions addressed to its parent", () => {
	const { paths } = setup();
	const parent = mainRow();
	const child = childRow("s-child", "st_shared", parent.sessionId);
	const otherParent = mainRow({ sessionId: "s-other-parent" });
	const otherChild = childRow("s-other-child", child.taskId, otherParent.sessionId);
	const sibling = childRow("s-sibling", "st_sibling", parent.sessionId);
	writeLedger(paths, [parent, child, otherParent, otherChild, sibling]);
	const subject = { sessionId: parent.sessionId, taskId: child.taskId, parentSessionId: parent.sessionId };
	const incident = { fp: "fp-dead", detector: "D8", kind: "dead-child", subject, ts: iso(T0 + 20 * MIN) };
	const wake = { ...incident, action: { key: "wake-parent:fp-dead", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: parent.sessionId } };
	// An action with no retained lifecycle or investigation entry must also join by subject.
	writeDecisions(paths, [
		{ ...incident, event: "opened", severity: "warn" },
		wake,
		{ ...wake, fp: "fp-action-only", action: { ...wake.action, key: "wake-parent:fp-action-only" }, result: "would-execute", outcome: undefined },
	]);
	writeInvestigation(paths, { id: "fp-investigation-only", detector: "D8", kind: "child-error-unhandled", subject });

	const joined = (row) => {
		const { health } = loadSessionRecord({ paths, id: row.sessionId, now: parent.endedMs });
		return [
			health.findings.map(({ fp, detector, kind }) => [fp, detector, kind]),
			health.actions.map(({ kind, recipient, result }) => [kind, recipient, result]),
			health.investigations.map(({ id }) => id),
		];
	};
	const expected = [
		[["fp-dead", "D8", "dead-child"]],
		[["wake-parent", parent.sessionId, "execute"], ["wake-parent", parent.sessionId, "would-execute"]],
		["fp-investigation-only"],
	];
	assert.deepEqual(joined(child), expected);
	assert.deepEqual(joined(parent), expected);
	assert.deepEqual(joined(otherChild), [[], [], []]);
	assert.deepEqual(joined(sibling), [[], [], []]);
});

test("IS-7: D20 relaunch attempts and gate decisions join the session and its parent, not unrelated sessions", () => {
	const { paths } = setup();
	const parent = mainRow();
	const child = childRow("s-parked", "st_parked", parent.sessionId);
	const other = mainRow({ sessionId: "s-other" });
	writeLedger(paths, [parent, child, other]);
	const { sessionId } = child;
	const subject = { sessionId };
	const parkId = `${sessionId}.${T0}`;
	const common = { detector: "D20", kind: "park-resume", subject, parkId };
	// Producer shapes: src/act/park-resume.mjs:154-155,259,272,284,287.
	writeDecisions(paths, [
		{ ...common, event: "park-gated", result: "skipped:paused", ts: iso(T0 + MIN) },
		{ ...common, event: "park-transition", sessionId, from: "pending", to: "claimed", why: "claim", ts: iso(T0 + 2 * MIN) },
		{ ...common, event: "park-transition", sessionId, from: "claimed", to: "pending", why: "launch-failed", ts: iso(T0 + 3 * MIN) },
		{ ...common, event: "park-transition", sessionId, from: "claimed", to: "launched", why: "launched", ts: iso(T0 + 4 * MIN) },
	]);
	const actions = (id) => loadSessionRecord({ paths, id, now: parent.endedMs }).health.actions;
	assert.deepEqual(actions(other.sessionId), []);
	for (const id of [sessionId, parent.sessionId]) {
		assert.deepEqual(actions(id).map(({ detector, kind, findingKind, result, ts, recipient, subject }) => [detector, kind, findingKind, result, ts, recipient, subject]), [
			["D20", "relaunch", "park-resume", "launched", iso(T0 + 4 * MIN), sessionId, subject],
			["D20", "relaunch", "park-resume", "launch-failed", iso(T0 + 3 * MIN), sessionId, subject],
			["D20", "relaunch", "park-resume", "skipped:paused", iso(T0 + MIN), sessionId, subject],
		]);
	}
});

test("an engine action decision is listed by its action kind, not the finding kind", () => {
	const { paths } = setup();
	writeLedger(paths, [{ sessionId: "s-kind", kind: "main", startedMs: T0, endedMs: T0 + HOUR }]);
	// The shape src/engine.mjs writes for an executed action: the finding's kind at top level, the action's under `action`.
	writeDecisions(paths, [
		{ ts: iso(T0 + MIN), fp: "fp-kind", detector: "D1", kind: "stall", cls: "pending-call", action: { key: "k", kind: "kill-pids", params: {} }, result: "execute", outcome: { killed: [{ pid: 1 }], survived: [] }, subject: { sessionId: "s-kind", taskId: null, parentSessionId: null, rootSessionId: null } },
	]);
	const record = loadSessionRecord({ paths, id: "s-kind", now: T0 + 2 * HOUR });
	assert.equal(record.health.actions.length, 1);
	assert.equal(record.health.actions[0].kind, "kill-pids");
	assert.equal(record.health.actions[0].findingKind, "stall");
});

test("a child finding with parentSessionId null is caught through the descendant set", () => {
	const record = recordForMain();
	assert.ok(fprs(record, "findings").includes("fp-child"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-child"));
});

test("a grandchild finding is listed", () => {
	const record = recordForMain();
	assert.ok(fprs(record, "findings").includes("fp-grand"));
	assert.ok(record.health.investigations.some((inv) => inv.id === "fp-grand"));
});

test("a delivery to the session is listed", () => {
	const record = recordForMain();
	const delivery = record.health.actions.find((item) => item.recipient === "s-main" && item.detail === "delivered true" && Object.keys(item.subject).length === 0);
	assert.ok(delivery, "the notify decision has no subject but its outcome names the session");
});

test("a message delivered only to the grandchild appears in the parent record with recipient C", () => {
	const { paths } = setup();
	const rows = baseRows().map((row) => ({ ...row, cwd: paths.repoRoot }));
	writeLedger(paths, rows);
	childSessionFile(paths.repoRoot, "st_a", "s-child", [{ type: "session", id: "s-child" }]);
	childSessionFile(paths.repoRoot, "st_c", "s-grand", [{ type: "session", id: "s-grand" }, ohealth(T0 + 50 * MIN, "only the grandchild")]);
	writeDecisions(paths, [{ action: { key: "wake-parent:g", kind: "wake-parent" }, result: "execute", outcome: { delivered: true, sessionId: "s-grand" }, detector: "D1", kind: "stall", ts: iso(T0 + 50 * MIN) }]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.found, true);
	const message = record.health.messages.find((item) => item.text === "only the grandchild");
	assert.equal(message?.recipient, "s-grand");
	assert.ok(record.health.actions.some((item) => item.recipient === "s-grand" && item.facts.delivered === true));
});

test("an unrelated session is excluded even when it shares a cwd", () => {
	const record = recordForMain();
	assert.equal(record.health.findings.some((item) => item.fp === "fp-unrelated" || item.fp === "fp-u-child"), false);
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-unrelated" || inv.id === "fp-u-child"), false);
	assert.equal(record.health.actions.some((item) => item.recipient === "s-unrelated"), false);
});

test("an unindexed main session does not inherit another main's tokens through a null task id", () => {
	const fixture = corpus();
	const indexed = fixture.rows[0];
	const unindexed = fixture.rows[1];
	const usage = new Map([
		[
			indexed.sessionId,
			{
				id: indexed.sessionId,
				taskId: null,
				state: "ok",
				complete: true,
				published: { total: 157, input: 100, output: 20, cacheRead: 30, cacheWrite: 7, cost: 0, costUnknown: false, turns: 2, models: { "anthropic/claude-x": { tokens: 157, cost: 0 } }, usedModels: {} },
			},
		],
	]);
	const indexedRecord = buildSessionRecord({ id: indexed.sessionId, row: indexed, ledger: fixture.rows, decisions: [], investigations: [], usage });
	assert.equal(indexedRecord.tokens.total, 157);
	const unindexedRecord = buildSessionRecord({ id: unindexed.sessionId, row: unindexed, ledger: fixture.rows, decisions: [], investigations: [], usage });
	assert.equal(unindexedRecord.tokens, null, "a null task id is not an alias for another main session");
});

test("a non-finite per-model value stays non-finite instead of becoming 0", () => {
	const fixture = corpus();
	const row = fixture.rows[0];
	const models = { "a/finite": { tokens: 10, cost: 0.5 }, "b/huge": { tokens: Infinity, cost: Infinity }, "c/nan": { tokens: NaN, cost: 1 } };
	const published = { total: Infinity, input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0, cost: Infinity, costUnknown: false, turns: 2, models };
	const usage = new Map([[row.sessionId, { id: row.sessionId, taskId: null, state: "ok", complete: true, published }]]);
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: [], investigations: [], usage });
	const rows = record.tokens.models;
	assert.deepEqual(rows.map((m) => m.key), ["b/huge", "c/nan", "a/finite"], "non-finite rows sort first, then by key");
	assert.equal(rows[0].tokens, Infinity);
	assert.ok(Number.isNaN(rows[1].tokens));
	assert.equal(rows[2].tokens, 10);
	assert.deepEqual(JSON.parse(JSON.stringify(rows)).map((m) => m.tokens), [null, null, 10], "the dashboard receives null and shows -");
});

test("task-only record rows join one decision subject, not two subjects sharing a task id", () => {
	const row = childRow(null, "st_x", "s-main");
	const a = { fp: "a", event: "opened", subject: { sessionId: "child-a", taskId: row.taskId }, ts: iso(T0 + MIN) };
	const resolved = { ...a, event: "resolved", ts: iso(T0 + 2 * MIN) };
	const b = { ...a, fp: "b", subject: { sessionId: "child-b", taskId: row.taskId } };
	const record = (decisions) => buildSessionRecord({ id: row.taskId, row, decisions });
	assert.deepEqual(fprs(record([a, resolved]), "findings"), ["a", "a"]);
	assert.deepEqual(fprs(record([a, resolved, b]), "findings"), []);
});

test("two main sessions whose records all carry taskId null do not leak into each other", () => {
	const fixture = corpus();
	const main = fixture.rows[0];
	const other = fixture.rows[1];
	const mainRecord = buildSessionRecord({ id: main.sessionId, row: main, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const otherRecord = buildSessionRecord({ id: other.sessionId, row: other, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(fprs(mainRecord, "findings").some((fp) => fp === "fp-unrelated"), false);
	assert.equal(fprs(otherRecord, "findings").some((fp) => fp === "fp-direct"), false);
	assert.equal(otherRecord.health.investigations.some((inv) => inv.id === "fp-direct"), false);
	assert.equal(mainRecord.health.investigations.some((inv) => inv.id === "fp-unrelated"), false);
});

test("a child's verdict logged 2 h after the parent ended is in the parent's record; an unrelated one is not", () => {
	const record = recordForMain();
	const child = record.health.investigations.find((inv) => inv.id === "fp-child");
	assert.deepEqual(child.verdictHistory.map((v) => v.diagnosis), ["after parent end"]);
	assert.equal(record.health.investigations.some((inv) => inv.id === "fp-unrelated"), false);
});

test("a machine-wide finding inside the window is included with scope machine, one outside excluded", () => {
	const fixture = corpus();
	fixture.decisions.push(
		{ fp: "fp-machine-in", subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR) },
		{ fp: "fp-machine-in", subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + 1.5 * HOUR) },
		{ fp: "fp-machine-out", subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 - 10 * HOUR) },
		{ fp: "fp-machine-out", subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 - 9 * HOUR) },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine");
	assert.deepEqual(machine.map((item) => item.fp), ["fp-machine-in"]);
	assert.equal(machine[0].ts, iso(T0 + HOUR));
});

test("IS-7: a parent's machine incidents include the child's active interval, not the gap", () => {
	const { paths } = setup();
	const parent = mainRow();
	const child = childRow("s-late-child", "st_late", parent.sessionId, { startedMs: T0 + 3 * HOUR, endedMs: T0 + 4 * HOUR });
	const now = T0 + 5 * HOUR;
	const decisions = [["gap", T0 + 2.5 * HOUR], ["during-child", T0 + 3.5 * HOUR], ["after", T0 + 4.5 * HOUR]].flatMap(([fp, at]) => {
		const incident = { fp, subject: { key: "machine" }, detector: "D6", kind: "provider-down", severity: "warn" };
		return [{ ...incident, event: "opened", ts: iso(at) }, { ...incident, event: "resolved", ts: iso(at + MIN) }];
	});
	const ledger = [parent, child];
	writeLedger(paths, ledger);
	writeDecisions(paths, decisions);
	for (const row of [child, parent]) {
		const input = { paths, id: row.sessionId, now };
		const machine = (record) => record.health.findings.filter(({ scope }) => scope === "machine").map(({ fp }) => fp);
		const pure = buildSessionRecord({ row, ledger, decisions, now });
		const full = loadSessionRecord(input);
		const audit = loadSessionRecord({ ...input, auditRetention: true });
		assert.deepEqual([machine(pure), machine(buildSessionView(full)), machine(audit)], Array.from({ length: 3 }, () => ["during-child"]), row.sessionId);
	}
});

test("IS-7: a live child extends its parent's machine overlap window through now", () => {
	const { root, paths } = setup();
	const parent = mainRow({ cwd: root });
	const childId = "s-live-child";
	const taskId = "st_live";
	const startedMs = parent.endedMs - MIN;
	const now = T0 + 4 * HOUR;
	const file = childSessionFile(root, taskId, childId, [{ type: "session", id: childId, timestamp: iso(startedMs) }]);
	const index = new Map([[childId, { id: childId, taskId, parentSessionId: parent.sessionId, file, checkedMs: startedMs + MIN, complete: false }]]);
	writeLedger(paths, [parent]);
	const incident = { subject: { key: "machine" }, detector: "D6", kind: "provider-down", severity: "warn" };
	writeDecisions(paths, [
		{ ...incident, fp: "gap", event: "opened", ts: iso(parent.startedMs - 2 * MIN) },
		{ ...incident, fp: "gap", event: "resolved", ts: iso(parent.startedMs - MIN) },
		{ ...incident, fp: "live", event: "opened", ts: iso(startedMs + 2 * MIN) },
		{ ...incident, fp: "future", event: "opened", ts: iso(now + MIN) },
	]);
	const results = [false, true].map((auditRetention) => loadSessionRecord({ paths, id: parent.sessionId, now, index, auditRetention }).health.findings.map(({ fp }) => fp));
	assert.deepEqual(results, [["live"], ["live"]]);
});

test("IS-10: bounded preparation stays within the session-file allowance with 55 index-only descendants", (t) => {
	const { paths } = setup();
	const parent = mainRow();
	const now = parent.endedMs + HOUR;
	const parentFile = mainSessionFile(paths, parent.sessionId);
	const index = new Map();
	const sessionFiles = new Set([parentFile]);
	writeLedger(paths, [parent]);
	for (let i = 0; i < 55; i += 1) {
		const id = `s-live-${i}`;
		const startedMs = T0 + (i + 1) * MIN;
		const file = mainSessionFile(paths, id, [{ type: "session", id, timestamp: iso(startedMs), padding: "x".repeat(63 * 1024) }]);
		sessionFiles.add(file);
		index.set(id, { id, parentSessionId: parent.sessionId, file, checkedMs: startedMs + MIN, complete: false });
	}
	writeDecisions(paths, [
		{ fp: "during-latest", subject: { key: "machine" }, detector: "D6", kind: "provider-down", severity: "warn", event: "opened", ts: iso(parent.endedMs + MIN) },
	]);

	const sessionFds = new Set();
	const { openSync, closeSync, readSync } = fs;
	let sessionBytesRead = 0;
	t.mock.method(fs, "openSync", (...args) => {
		const fd = openSync(...args);
		if (sessionFiles.has(args[0])) sessionFds.add(fd);
		return fd;
	});
	t.mock.method(fs, "closeSync", (fd) => {
		sessionFds.delete(fd);
		return closeSync(fd);
	});
	t.mock.method(fs, "readSync", (fd, ...args) => {
		const bytes = readSync(fd, ...args);
		if (sessionFds.has(fd)) sessionBytesRead += bytes;
		return bytes;
	});

	const messageScanTotalBytes = 128 * 1024;
	const record = loadSessionRecord({
		paths, id: parent.sessionId, now, index, auditRetention: true,
		descendantScanMax: 50, messageScanTotalBytes, messageScanMaxBytes: messageScanTotalBytes,
	});
	assert.equal(record.children.length, 55);
	assert.deepEqual(record.health.findings.filter(({ scope }) => scope === "machine").map(({ fp }) => fp), ["during-latest"]);
	assert.ok(sessionBytesRead >= 63 * 1024, `the spy should observe a real message scan (${sessionBytesRead} bytes)`);
	assert.ok(sessionBytesRead <= messageScanTotalBytes, `read ${sessionBytesRead} session-file bytes with a ${messageScanTotalBytes}-byte allowance`);
});

test("IS-7: a severity rise is a finding row with its own evidence, not a new incident", () => {
	const row = mainRow();
	const cases = [
		{ subject: { sessionId: row.sessionId }, scope: "session" },
		{ subject: { key: "machine" }, scope: "machine" },
	];
	for (const { subject, scope } of cases) {
		const base = { fp: "fp-rise", detector: "D1", kind: "stall", subject };
		const opened = { ...base, event: "opened", severity: "info", ts: iso(T0 - MIN), titleKo: "관찰", evidence: ["count:1"] };
		const promoted = { ...base, event: "severity", severity: "warn", ts: iso(T0 + MIN), titleKo: "멈춤 경고", evidence: ["count:6", "The stall persisted."] };
		const resolved = { ...base, event: "resolved", ts: iso(T0 + 2 * MIN) };
		const { findings } = buildSessionRecord({ row, decisions: [opened, promoted, resolved] }).health;
		assert.deepEqual(findings.filter((f) => f.event !== "resolved"), [
			{ ...promoted, scope },
			{ ...opened, scope },
		], scope);
	}
});

test("a machine outage opened before the session and resolved during it is included; one resolved before the start is not", () => {
	const fixture = corpus();
	fixture.decisions.push(
		{ fp: "fp-outage-open", subject: { key: "machine" }, event: "opened", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 5 * HOUR) },
		{ fp: "fp-outage-open", subject: { key: "machine" }, event: "resolved", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 + 30 * MIN) },
		{ fp: "fp-outage-old", subject: { key: "machine" }, event: "opened", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 12 * HOUR) },
		{ fp: "fp-outage-old", subject: { key: "machine" }, event: "resolved", detector: "D6", kind: "provider-down", severity: "warn", ts: iso(T0 - 2 * HOUR) },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine").map((item) => item.fp);
	assert.deepEqual(machine, ["fp-outage-open"]);
});

test("the loader includes overlapping machine incidents opened 31 days before the session", () => {
	const { paths } = setup();
	const openedMs = T0 - 31 * 24 * HOUR;
	const incident = { subject: { key: "machine" }, detector: "D6", kind: "provider-down", severity: "warn" };
	writeLedger(paths, [mainRow()]);
	writeDecisions(paths, [
		{ ...incident, fp: "fp-open", event: "opened", ts: iso(openedMs) },
		{ ...incident, fp: "fp-during", event: "opened", ts: iso(openedMs + MIN) },
		{ ...incident, fp: "fp-closed", event: "opened", ts: iso(openedMs + 2 * MIN) },
		{ ...incident, fp: "fp-closed", event: "resolved", ts: iso(T0 - MIN) },
		{ ...incident, fp: "fp-during", event: "resolved", ts: iso(T0 + MIN) },
	]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	const machine = record.health.findings.filter(({ scope }) => scope === "machine");
	assert.deepEqual(machine.map(({ fp, ts, event }) => [fp, ts, event]), [
		["fp-during", iso(openedMs + MIN), "opened"],
		["fp-open", iso(openedMs), "opened"],
	]);
});

test("the loader includes every overlapping interval of a repeated machine fingerprint", () => {
	const { paths } = setup();
	const row = mainRow();
	const incident = { fp: "fp-machine", subject: { key: "machine" }, detector: "D2", kind: "machine-commit" };
	writeLedger(paths, [row]);
	writeDecisions(paths, [
		{ ...incident, event: "opened", ts: iso(T0 - 2 * MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 - MIN) },
		{ ...incident, event: "opened", ts: iso(T0 + MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 + 2 * MIN) },
		{ ...incident, event: "reopened", ts: iso(T0 + 3 * MIN) },
		{ ...incident, event: "resolved", ts: iso(T0 + 4 * MIN) },
		{ ...incident, event: "reopened", ts: iso(row.endedMs + MIN) },
	]);
	const record = loadSessionRecord({ paths, id: row.sessionId, now: row.endedMs + HOUR });
	const machine = record.health.findings.filter(({ scope }) => scope === "machine");
	assert.deepEqual(machine.map(({ fp, ts, event }) => [fp, ts, event]), [
		[incident.fp, iso(T0 + 3 * MIN), "reopened"],
		[incident.fp, iso(T0 + MIN), "opened"],
	]);
});

test("transcript omo-health entries are collected; other custom types and a tool result quoting the string are ignored", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [
		{ type: "session", id: "s-main" },
		ohealth(T0 + 10 * MIN, "first notice"),
		{ type: "custom_message", customType: "other-tool", id: "x1", timestamp: iso(T0 + 11 * MIN), content: "not ours" },
		{ type: "message", id: "x2", timestamp: iso(T0 + 12 * MIN), message: { role: "toolResult", content: [{ type: "text", text: 'grep "customType":"omo-health" src' }] } },
		{ type: "custom", customType: "omo-health", id: "x3", timestamp: iso(T0 + 13 * MIN), content: "second notice" },
	]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.health.counts.messages, 2);
	assert.deepEqual(record.health.messages.map((m) => m.text), ["second notice", "first notice"]);
	assert.ok(record.health.messages.every((m) => m.recipient === "s-main"));
});

test("(plan 37) keeps a delivered 900-character message and redacts its final sentence", () => {
	const { paths } = setup();
	const row = mainRow();
	const secret = "sk-ant-0123456789ABCDEF";
	const finalSentence = `The final sentence contains ${secret}.`;
	const prefix = `${"x".repeat(899 - finalSentence.length)}\n`;
	writeLedger(paths, [row]);
	mainSessionFile(paths, row.sessionId, [ohealth(T0 + MIN, prefix + finalSentence)]);
	const { messages } = loadSessionRecord({ paths, id: row.sessionId, now: row.endedMs }).health;
	assert.equal(messages[0].text, prefix + finalSentence.replace(secret, "sk-ant-[REDACTED]"));
});

test("(plan 37) caps a 30,000-character item at 20,000 characters including the ellipsis", () => {
	const row = mainRow();
	const { messages } = buildSessionRecord({ row, messages: [{ text: "x".repeat(30_000) }] }).health;
	assert.equal(messages[0].text.length, 20_000);
	assert.ok(messages[0].text.endsWith("…"));
});

test("(plan 37) keeps redacted evidence, signals, verdict explanations and action details", () => {
	const row = mainRow();
	const subject = { sessionId: row.sessionId };
	const text = `${"x".repeat(2200)} Bearer abcdef0123456789 Final sentence.`;
	const safe = text.replace("abcdef0123456789", "[REDACTED]");
	const lines = [...Array.from({ length: 12 }, (_, i) => `line ${i}`), text];
	const verdict = { verdict: "escalate", reason: text, diagnosis: text, mechanism: text, avoid: text, advice: text, evidence: lines };
	const { findings, investigations, actions } = buildSessionRecord({
		row,
		decisions: [
			{ fp: "session", event: "opened", subject, evidence: lines },
			{ fp: "machine", ts: iso(T0), event: "opened", evidence: lines },
			{ fp: "session", event: "investigation", analyst: verdict },
			{ fp: "session", action: { kind: "deliver-message" }, outcome: { delivered: false, error: text } },
		],
		investigations: [{ id: "session", subject, evidence: lines, signals: lines, verdict, actions: [{ kind: "release-shell", killed: [text], advice: text }] }],
	}).health;
	assert.equal(findings.length, 2);
	const [investigation] = investigations;
	for (const evidence of [...findings.map((f) => f.evidence), investigation.evidence, investigation.signals, investigation.verdict.evidence, investigation.verdictHistory[0].evidence]) {
		assert.deepEqual(evidence, [...lines.slice(0, -1), safe]);
	}
	for (const v of [investigation.verdict, investigation.verdictHistory[0]]) {
		for (const field of ["reason", "diagnosis", "mechanism", "avoid", "advice"]) assert.equal(v[field], safe);
	}
	assert.equal(actions[0].detail, `delivered false; error ${safe}`);
	assert.equal(investigation.actions[0].detail, `killed ${safe}`);
	assert.equal(investigation.actions[0].advice, safe);
});

test("60 messages are all in the record", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	const entries = [{ type: "session", id: "s-main" }];
	for (let i = 0; i < 60; i += 1) entries.push(ohealth(T0 + MIN + i, `notice ${i}`));
	mainSessionFile(paths, "s-main", entries);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(record.health.counts.messages, 60);
	assert.equal(record.health.messages[0].text, "notice 59");
});

test("two different verdicts for one fp keep their order", () => {
	const record = recordForMain();
	const direct = record.health.investigations.find((inv) => inv.id === "fp-direct");
	assert.deepEqual(direct.verdictHistory.map((v) => v.verdict), ["escalate", "wait"]);
});

function descendantMessageFixture(count) {
	const { root: cwd, paths } = setup();
	const rows = [mainRow({ cwd, childCount: count })];
	for (let i = 0; i < count; i += 1) {
		rows.push(childRow(`s-d${i}`, `st_d${i}`, "s-main", { cwd, startedMs: T0 + MIN, endedMs: T0 + 10 * MIN - i * 1000 }));
		childSessionFile(cwd, `st_d${i}`, `s-d${i}`, [{ type: "session", id: `s-d${i}` }, ...(i === count - 1 ? [ohealth(T0 + 20 * MIN, count === 51 ? "in the 51st" : "in the 50th")] : [])]);
	}
	writeLedger(paths, rows);
	return { paths, id: "s-main", now: T0 + 24 * HOUR };
}

test("with 51 descendants, a message in the 51st descendant file is in the record under the default scan", () => {
	const record = loadSessionRecord(descendantMessageFixture(51));
	assert.equal(record.children.length, 51);
	assert.ok(record.health.messages.some((m) => m.text === "in the 51st" && m.recipient === "s-d50"));
});

const daemonMessageScanBounds = {
	descendantScanMax: 50,
	messageScanMaxBytes: 256 * 1024 * 1024,
	messageScanTotalBytes: 64 * 1024 * 1024,
	auditRetention: true,
};

test("plan64: the bounded audit bundle marks messages incomplete when a descendant is omitted", () => {
	const options = descendantMessageFixture(51);
	const bundleOf = (record) => auditBundle(record, null, { config: DEFAULT_CONFIG, now: options.now });
	const bounded = bundleOf(loadSessionRecord({ ...options, ...daemonMessageScanBounds }));
	const unbounded = bundleOf(loadSessionRecord(options));
	assert.equal(bounded.children.length, 51);
	assert.deepEqual(bounded.omo_health_record.messages, []);
	assert.equal(unbounded.omo_health_record.messages.length, 1);
	assert.equal(unbounded.truncated.messages, false);
	assert.deepEqual(
		{ messages: bounded.truncated.messages, descendantsSkipped: bounded.truncated.descendantsSkipped, messagesSkipped: bounded.truncated.messagesSkipped },
		{ messages: true, descendantsSkipped: 1, messagesSkipped: 0 },
	);
});

test("plan64: bounded and unbounded audit bundles agree at the descendant cap", () => {
	const options = descendantMessageFixture(50);
	const bundleOf = (record) => auditBundle(record, null, { config: DEFAULT_CONFIG, now: options.now });
	const bounded = bundleOf(loadSessionRecord({ ...options, ...daemonMessageScanBounds }));
	const unbounded = bundleOf(loadSessionRecord(options));
	assert.equal(bounded.children.length, 50);
	assert.equal(bounded.omo_health_record.messages.length, 1);
	assert.equal(bounded.truncated.messages, false);
	assert.deepEqual(bounded, unbounded);
});

test("with 21 overlapping machine findings, the 21st is in the record and reachable by offset", () => {
	const fixture = corpus();
	for (let i = 0; i < 21; i += 1) {
		fixture.decisions.push(
			{ fp: `fp-m${i}`, subject: { key: "machine" }, event: "opened", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR + i) },
			{ fp: `fp-m${i}`, subject: { key: "machine" }, event: "resolved", detector: "D2", kind: "machine-commit", severity: "info", ts: iso(T0 + HOUR + i + 1) },
		);
	}
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const machine = record.health.findings.filter((item) => item.scope === "machine");
	assert.equal(machine.length, 21);
	assert.ok(machine.some((item) => item.fp === "fp-m20"));
	assert.equal(machine.at(-1).fp, "fp-m0", "the oldest machine finding is still in the record, reachable by offset");
});

test("a file larger than an injected messageScanMaxBytes yields its message through the dashboard default", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "large but readable")]);
	const bounded = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR, messageScanMaxBytes: 16 });
	assert.equal(bounded.health.counts.messages, 0);
	const unbounded = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	assert.equal(unbounded.health.messages[0].text, "large but readable");
});

test("a ghp_ token in stored text is redacted", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "use ghp_abcdefgh12345678 now")]);
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR });
	const text = record.health.messages[0].text;
	assert.equal(text.includes("ghp_abcdefgh12345678"), false);
	assert.ok(text.includes("ghp_[REDACTED]"));
});

test("an unknown id returns {found:false}", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	assert.deepEqual(loadSessionRecord({ paths, id: "s-missing", now: T0 + 24 * HOUR }), { found: false, id: "s-missing" });
});

test("a session file larger than messageScanMaxBytes is never scanned and is listed as skipped", () => {
	const { paths } = setup();
	writeLedger(paths, baseRows());
	const file = mainSessionFile(paths, "s-main", [{ type: "session", id: "s-main" }, ohealth(T0 + MIN, "never read")]);
	const calls = [];
	const record = loadSessionRecord({ paths, id: "s-main", now: T0 + 24 * HOUR, messageScanMaxBytes: 16, scanMessages: (target) => (calls.push(target), []) });
	assert.equal(calls.length, 0);
	assert.deepEqual(record.truncated.messagesSkipped, [file]);
	assert.equal(record.health.counts.messages, 0);
});

test("the total message scan budget admits the own file and only the newest descendant", (t) => {
	const { root, paths } = setup();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const mib = 1024 * 1024;
	const budget = 64 * mib;
	const own = mainSessionFile(paths, "s-main", [ohealth(T0, "own")]);
	fs.truncateSync(own, 40 * mib);
	const children = [1, 2, 3].map((n) => childRow(`s-${n}`, `st_${n}`, "s-main", { cwd: root, endedMs: T0 + n * MIN }));
	const files = children.map(({ sessionId, taskId }) => {
		const file = childSessionFile(root, taskId, sessionId, [ohealth(T0, sessionId)]);
		fs.truncateSync(file, 20 * mib);
		return file;
	});
	writeLedger(paths, [mainRow({ cwd: root }), ...children]);

	const calls = [];
	let bytes = 0;
	const record = loadSessionRecord({
		paths, id: "s-main", now: T0 + 24 * HOUR, messageScanTotalBytes: budget,
		scanMessages(file) {
			calls.push(file);
			bytes += fs.statSync(file).size;
			return [];
		},
	});
	assert.deepEqual(calls, [own, files[2]]);
	assert.deepEqual(record.truncated.messagesSkipped, [files[1], files[0]]);
	assert.ok(bytes <= budget);
});

test("action facts carry the structured outcome and a reason code", () => {
	const fixture = corpus();
	fixture.decisions.push({
		fp: "fp-direct",
		action: { key: "nudge:fp-direct", kind: "nudge" },
		result: "skipped:main-session",
		outcome: { killed: [{ pid: 1 }, { pid: 2 }], survived: [{ pid: 3 }], delivered: false, via: "inbox", error: "boom" },
		subject: { sessionId: "s-main" },
		detector: "D1",
		kind: "stall",
	});
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	const action = record.health.actions.find((item) => item.result === "skipped:main-session");
	assert.deepEqual(action.facts, { delivered: false, via: "inbox", killed: 2, survived: 1, error: true, reasonCode: "skipped" });
	assert.equal(action.recipient, "s-main");
});

test("coverage.infoFindings is true only for a coverage event that precedes the session start", () => {
	const fixture = corpus();
	const row = fixture.rows[0];
	const before = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(before.coverage.infoFindings, true);
	const late = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: [{ event: "coverage", infoFindings: true, ts: iso(T0 + HOUR) }], investigations: [] });
	assert.equal(late.coverage.infoFindings, false);
});

test("analystModels collects decision-only fps' analyzing models plus the investigation file's model", () => {
	const fixture = corpus();
	fixture.investigations.find((record) => record.id === "fp-fp").model = "openai/file-review";
	fixture.decisions.push(
		{ fp: "fp-decision-only", event: "opened", detector: "D1", kind: "stall", severity: "warn", subject: { sessionId: "s-child", taskId: "st_a" } },
		{ fp: "fp-decision-only", event: "investigation", status: "analyzing", model: "openai/first-review" },
		{ fp: "fp-decision-only", event: "investigation", status: "analyzing", model: "openai/second-review" },
		{ fp: "fp-unrelated", event: "investigation", status: "analyzing", model: "openai/unrelated-review" },
	);
	const row = fixture.rows[0];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: fixture.rows, decisions: fixture.decisions, investigations: fixture.investigations });
	assert.equal(record.health.investigations.some((investigation) => investigation.id === "fp-decision-only"), false, "no investigation file exists for the fp");
	assert.deepEqual(record.analystModels, ["openai/file-review", "openai/first-review", "openai/second-review"], "the unrelated fp's model stays out");
});

test("IS-9 provenance: analystModels includes all related terminal decisions but not unrelated ones", () => {
	const row = corpus().rows[0];
	const subject = { sessionId: row.sessionId };
	const decisions = [
		{ event: "investigation", status: "analyzing", fp: "same", subject, model: "p/a" },
		{ event: "investigation", status: "verdict", fp: "same", analyst: { verdict: "act" }, usedModels: ["p/a", "p/b"] },
		{ event: "investigation", status: "failed", fp: "same", analyst: { verdict: "escalate" }, usedModels: ["p/a", "p/c"] },
		{ event: "investigation", status: "verdict", fp: "other", subject: { sessionId: "unrelated" }, analyst: { verdict: "act" }, usedModels: ["p/unrelated"] },
	];
	const record = buildSessionRecord({ id: row.sessionId, row, ledger: [row], decisions });
	assert.deepEqual(record.analystModels, ["p/a", "p/b", "p/c"]);
});

const MIB = 1024 * 1024;

test("IS-9 unfinished analyst run: only its later terminal decision or retained exit evidence establishes models", (t) => {
	const dir = tmpDir("omoh-analyst-models-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") });
	const ts = iso(T0);
	const run = { event: "investigation", ts, fp: "same", jobId: "analyst-current" };
	const file = path.join(paths.health.decisionsDir, `${ts.slice(0, 10)}.jsonl`);
	const jobs = path.join(paths.health.jobsDir, run.jobId);
	fs.mkdirSync(jobs, { recursive: true });
	fs.writeFileSync(path.join(jobs, "err.log"), "Model fallback: p/a -> p/b\n");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	appendEnded(paths, { sessionId: "s-run", kind: "main", startedMs: T0 - 1_000, endedMs: T0, outcome: "answered" });
	const terminal = { ...run, status: "verdict", analyst: { verdict: "act" }, usedModels: ["p/a", "p/b"] };
	const start = { ...run, status: "analyzing", subject: { sessionId: "s-run" }, model: "p/a" };
	const load = () => loadSessionRecord({ paths, id: "s-run", now: T0 });
	fs.writeFileSync(file, jsonl([terminal, start, { ...terminal, jobId: "analyst-other", usedModels: ["p/c"] }]));
	assert.equal(load().session.analystModelsUnknown, true, "an earlier result or another job cannot finalize the current run");
	fs.writeFileSync(file, jsonl([start]));
	assert.equal(load().session.analystModelsUnknown, true);
	fs.writeFileSync(path.join(jobs, "exit.json"), JSON.stringify({ code: 0, signal: null }));
	assert.deepEqual([load().session.analystModelsUnknown, load().analystModels], [undefined, ["p/a", "p/b"]]);
	fs.rmSync(path.join(jobs, "err.log"));
	assert.equal(load().session.analystModelsUnknown, true, "an exit without stderr cannot certify fallback history");
	fs.appendFileSync(file, jsonl([{ ...terminal, status: "closed" }]));
	assert.deepEqual([load().session.analystModelsUnknown, load().analystModels], [undefined, ["p/a", "p/b"]]);
});

const FILLER_LINE = '{"type":"message","id":"f"}\n';
const FILLER_BLOCK = Buffer.from(FILLER_LINE.repeat(Math.floor(MIB / FILLER_LINE.length)));
const scanFile = (dir, name = "session.jsonl") => path.join(dir, name);

function jsonl(entries) {
	return entries.map((entry) => `${typeof entry === "string" ? entry : JSON.stringify(entry)}\n`).join("");
}

test("an omo-health message line that straddles the 4 MiB read boundary is found", (t) => {
	const dir = tmpDir("omoh-scan-edge-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const line = Buffer.from('{"t":1}\n');
	// 4 MiB - 24 is an exact multiple of the 8-byte filler, so the message starts 24 bytes before the first chunk ends.
	const prefix = Buffer.alloc(4 * MIB - 24, line);
	const message = ohealth(T0 + MIN, "across the boundary");
	fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from(jsonl([message, { type: "session", id: "s-edge" }]))]));
	assert.ok(Buffer.from(jsonl([message])).length > 24, "the message line crosses the boundary");
	assert.deepEqual(scanOmoHealthMessages(file), [{ ms: T0 + MIN, kind: "self-notice", text: "across the boundary" }]);
});

test("a 70 MiB file with 3 omo-health messages scans under a 96 MiB heap in a child node process", (t) => {
	const dir = tmpDir("omoh-scan-big-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir, "big-session.jsonl");
	const messages = [ohealth(T0 + MIN, "first"), ohealth(T0 + 2 * MIN, "second"), ohealth(T0 + 3 * MIN, "third")];
	const expected = [
		{ ms: T0 + MIN, kind: "self-notice", text: "first" },
		{ ms: T0 + 2 * MIN, kind: "self-notice", text: "second" },
		{ ms: T0 + 3 * MIN, kind: "self-notice", text: "third" },
	];
	const fd = fs.openSync(file, "w");
	try {
		fs.writeSync(fd, jsonl([{ type: "session", id: "s-big" }]));
		for (let i = 0; i < 70; i += 1) {
			if (i === 5) fs.writeSync(fd, jsonl([messages[0]]));
			if (i === 35) fs.writeSync(fd, jsonl([messages[1]]));
			if (i === 65) fs.writeSync(fd, jsonl([messages[2]]));
			fs.writeSync(fd, FILLER_BLOCK);
		}
	} finally {
		fs.closeSync(fd);
	}
	assert.ok(fs.statSync(file).size > 70 * MIB, "the fixture is larger than 70 MiB");
	const moduleUrl = new URL("../src/session-record.mjs", import.meta.url).href;
	const script = path.join(dir, "scan-child.mjs");
	fs.writeFileSync(script, `import { scanOmoHealthMessages } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(scanOmoHealthMessages(process.argv[2])));\n`);
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", script, file], { encoding: "utf8", maxBuffer: 8 * MIB });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), expected);
});

test("a 2 MiB tool-result line quoting the marker is dropped and the next message line is returned", (t) => {
	const dir = tmpDir("omoh-scan-overlong-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const toolResult = {
		type: "message",
		id: "big",
		timestamp: iso(T0),
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: `${"x".repeat(2 * MIB)} "customType":"omo-health"` }] },
	};
	const message = ohealth(T0 + MIN, "after the giant line");
	fs.writeFileSync(file, jsonl([{ type: "session", id: "s-big-line" }, toolResult, message]));
	assert.ok(fs.statSync(file).size > 2 * MIB);
	assert.deepEqual(scanOmoHealthMessages(file), [{ ms: T0 + MIN, kind: "self-notice", text: "after the giant line" }]);
});

test("CRLF lines and a final line without a newline are both read", (t) => {
	const dir = tmpDir("omoh-scan-crlf-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = scanFile(dir);
	const first = ohealth(T0 + MIN, "crlf line");
	const last = ohealth(T0 + 2 * MIN, "no trailing newline");
	fs.writeFileSync(file, `${JSON.stringify(first)}\r\n${JSON.stringify(last)}`);
	assert.deepEqual(scanOmoHealthMessages(file), [
		{ ms: T0 + MIN, kind: "self-notice", text: "crlf line" },
		{ ms: T0 + 2 * MIN, kind: "self-notice", text: "no trailing newline" },
	]);
});
