import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sensor from "../extension/sensor.mjs";
import { statusReport } from "../bin/omo-health.mjs";
import { buildLedger, readLedgers, writeLedgers } from "../src/align/ledger.mjs";
import { SessionTracker } from "../src/collect/sessions.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { E, appendJsonl, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";

const SID = "01a0ce04-e7f2-74a4-bc28-c6b2c98fb442";
const T0 = Date.parse("2026-09-23T15:30:00.000Z");
const TODO_TEXT = "Overall: 1/3 done, 2 open\n- [x] read logs\n- [ ] draft issue\n- [ ] file issue";

function world(tracker, now) {
	tracker.read();
	tracker.advance(now);
	return { now, sessions: new Map([[tracker.state.id, tracker.state]]) };
}

function setup() {
	const dir = tmpDir("omoh-ledger-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(dir, "health"), OMO_HEALTH_OMO_HOME: path.join(dir, "omo"), USERPROFILE: dir, APPDATA: path.join(dir, "appdata") });
	const file = path.join(dir, "omo", "agent", "sessions", "p", `2026-09-23T15-30-00-000Z_${SID}.jsonl`);
	writeJsonl(file, [
		E.header(SID, "C:/dev/proj", T0),
		E.user("이슈 초안을 써라", T0 + 1000),
		E.assistant({ ms: T0 + 5000, calls: [{ id: "c1", name: "todo", args: {} }] }),
		E.toolResult("c1", T0 + 5100, { name: "todo", text: TODO_TEXT }),
		E.assistant({ ms: T0 + 8000, calls: [{ id: "c2", name: "edit", args: { path: "C:/dev/proj/draft.md" } }] }),
		E.toolResult("c2", T0 + 8100, { name: "edit" }),
		E.user("다른 세션에 영향은 없나?", T0 + 60_000),
		E.assistant({ ms: T0 + 65_000, calls: [{ id: "c3", name: "edit", args: { path: "C:/Users/u/.omo/agent/settings.json" } }] }),
	]);
	const tracker = new SessionTracker({ file, tailBytes: null });
	const cache = new Map();
	// A tick after the todo report and before the next user turn resets the activity.
	writeLedgers(paths, { world: world(tracker, T0 + 10_000) }, T0 + 10_000, cache);
	return { dir, paths, file, tracker, cache, ledgerFile: path.join(paths.health.alignmentDir, `${SID}.json`) };
}

test("writeLedgers writes goal, requests, open commitments and nudges only when they change", () => {
	const s = setup();
	const now = T0 + 70_000;
	const cache = s.cache;
	const finding = { detector: "D15", kind: "drift", cls: "overstep", subject: { sessionId: SID }, data: { signal: "overstep" } };
	assert.equal(writeLedgers(s.paths, { world: world(s.tracker, now), findings: [finding] }, now, cache), 1);
	const ledger = JSON.parse(fs.readFileSync(s.ledgerFile, "utf8"));
	assert.equal(ledger.sessionId, SID);
	assert.equal(ledger.cwd, "C:/dev/proj");
	assert.deepEqual(ledger.goal, { objective: "이슈 초안을 써라", status: null, source: "first-request" });
	assert.equal(ledger.firstRequest, "이슈 초안을 써라");
	assert.deepEqual(ledger.requests.map((r) => r.text), ["이슈 초안을 써라", "다른 세션에 영향은 없나?"]);
	// The todo was reported before the second user turn reset the activity; the ledger keeps it open.
	assert.deepEqual(ledger.openCommitments, { todoOpen: 2, todoItems: ["draft issue", "file issue"], goalActive: false });
	assert.deepEqual(ledger.nudges, [{ ms: now, signal: "overstep" }]);
	assert.equal(ledger.updatedMs, now);
	assert.equal(ledger.activity.mutations, 1);

	// Nothing changed: no write, the file keeps its first updatedMs.
	assert.equal(writeLedgers(s.paths, { world: world(s.tracker, now + 15_000), findings: [] }, now + 15_000, cache), 0);
	assert.equal(JSON.parse(fs.readFileSync(s.ledgerFile, "utf8")).updatedMs, now);
	// A fresh daemon (empty cache) reads the file and does not rewrite it either.
	assert.equal(writeLedgers(s.paths, { world: world(s.tracker, now + 30_000), findings: [] }, now + 30_000, new Map()), 0);

	appendJsonl(s.file, [E.user("그럼 이슈 등록해라", now + 40_000)]);
	assert.equal(writeLedgers(s.paths, { world: world(s.tracker, now + 45_000), findings: [] }, now + 45_000, cache), 1);
	const next = JSON.parse(fs.readFileSync(s.ledgerFile, "utf8"));
	assert.equal(next.requests.at(-1).text, "그럼 이슈 등록해라");
	assert.deepEqual(next.nudges, [{ ms: now, signal: "overstep" }]);
	assert.equal(next.openCommitments.todoOpen, 2);
});

test("the ledger seeds the activity counters of a tracker started from a tail read", () => {
	const s = setup();
	const now = T0 + 70_000;
	writeLedgers(s.paths, { world: world(s.tracker, now), findings: [] }, now, s.cache);
	const seeded = new SessionTracker({ file: s.file, tailBytes: 1024, alignmentDir: s.paths.health.alignmentDir });
	assert.equal(seeded.state.activity.sinceMs, T0 + 60_000);
	assert.equal(seeded.state.activity.mutations, 1);
	assert.equal(seeded.state.activity.files.get("C:/Users/u/.omo/agent/settings.json").rounds, 1);
});

test("a goal or task anchor wins over the first request and marks the goal active", () => {
	const session = { id: "x", firstUserText: "first", userTurns: [], anchor: { objective: "ship v2", status: "active", source: "goal" }, activity: null };
	const ledger = buildLedger(session);
	assert.deepEqual(ledger.goal, { objective: "ship v2", status: "active", source: "goal" });
	assert.equal(ledger.openCommitments.goalActive, true);
	assert.equal(buildLedger({ ...session, anchor: { objective: "sub", status: "running", source: "task" } }).openCommitments.goalActive, true);
	assert.equal(buildLedger({ ...session, anchor: { objective: "done", status: "complete", source: "ulw" } }).openCommitments.goalActive, false);
});

test("/health shows the original goal, recent requests, open commitments and the last scope check", async () => {
	const s = setup();
	const nudgeMs = T0 + 70_000;
	writeLedgers(s.paths, { world: world(s.tracker, nudgeMs), findings: [{ detector: "D15", subject: { sessionId: SID }, data: { signal: "overstep" } }] }, nudgeMs, s.cache);
	const ledgerPath = s.ledgerFile;
	const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
	ledger.openCommitments.goalActive = true;
	fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
	const commands = new Map();
	const pi = { on() {}, sendMessage() {}, registerCommand: (name, spec) => commands.set(name, spec) };
	sensor(pi, { healthHome: s.paths.healthHome, repoRoot: s.dir, now: () => nudgeMs, setInterval: () => ({ unref() {} }), clearInterval() {}, spawn: () => ({ unref() {} }), platform: "linux" });
	const widgets = [];
	const ctx = { cwd: "C:/dev/proj", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => SID, getSessionFile: () => s.file }, ui: { setStatus() {}, setWidget: (key, lines) => widgets.push(lines) } };
	await commands.get("health").handler("", ctx);
	const lines = widgets.at(-1);
	const at = lines.findIndex((l) => l.startsWith("원래 목표: "));
	const hhmm = new Date(nudgeMs + 9 * 3600_000).toISOString().slice(11, 16);
	assert.deepEqual(lines.slice(at, at + 4), [
		"원래 목표: 이슈 초안을 써라",
		"최근 요청: 이슈 초안을 써라 | 다른 세션에 영향은 없나?",
		"열린 약속: 할 일 2개 / 목표 진행 중",
		`범위 점검: ${hhmm} overstep`,
	]);
});

test("status --json lists recent ledgers under alignment", () => {
	const s = setup();
	const now = Date.now();
	writeLedgers(s.paths, { world: world(s.tracker, T0 + 70_000), findings: [{ detector: "D15", subject: { sessionId: SID }, data: { signal: "overstep" } }] }, now, s.cache);
	fs.mkdirSync(s.paths.health.alignmentDir, { recursive: true });
	fs.writeFileSync(path.join(s.paths.health.alignmentDir, "old.json"), JSON.stringify({ sessionId: "old", updatedMs: now - 2 * 24 * 3600_000 }));
	assert.deepEqual(readLedgers(s.paths, { now }).map((l) => l.sessionId), [SID]);
	const report = statusReport(s.paths, now);
	assert.deepEqual(report.alignment, [{
		sessionId: SID,
		goal: { objective: "이슈 초안을 써라", status: null, source: "first-request" },
		openCommitments: { todoOpen: 2, todoItems: ["draft issue", "file issue"], goalActive: false },
		lastNudge: { ms: now, signal: "overstep" },
	}]);
});

test("the ledger file keeps the newest 50 steps the detector judges from", () => {
	const steps = Array.from({ length: 60 }, (_, i) => ({ ms: T0 + i, tool: "eval", kind: "eval", text: `step ${i}` }));
	const ledger = buildLedger({ id: "x", firstUserText: "first", userTurns: [], steps, activity: null });
	assert.equal(ledger.steps.length, 50);
	assert.equal(ledger.steps[0].text, "step 10");
	assert.deepEqual(buildLedger({ id: "x", userTurns: [] }).steps, []);
});
