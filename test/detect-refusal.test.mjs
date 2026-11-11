import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeRows } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as refusal from "../src/detect/refusal.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const NOW = Date.parse("2026-11-10T04:20:00Z");
const REFUSED = NOW - 6 * 60_000;
const SID = "01a15cb2-c71a-708b-8019-ad5d63d6f8a2";
const CLAUDE = "Claude refused this request (cyber): This request was blocked by our usage policy.";

/** The agent-guard session of issue #10: the refused reply holds an eval and a task call that never got a result. */
function refused(over = {}) {
	const s = sessionState({
		id: SID,
		lastAssistant: { ms: REFUSED, stopReason: "toolUse", errorMessage: CLAUDE, provider: "anthropic-subscription", model: "claude-opus-5-5", entryId: "e9", toolCalls: 2 },
		lastMessage: { role: "assistant", ms: REFUSED, stopReason: "toolUse", errorMessage: CLAUDE },
		pendingCalls: [
			{ id: "c1", name: "eval", batchId: "e9", args: { summary: "probe the guard hook", code: "..." } },
			{ id: "c2", name: "task", batchId: "e9", index: 1, args: { task_summary: "review the hook" } },
		],
		...over,
	});
	return { ...s, title: "agent-guard", anchor: { source: "goal", status: "blocked", objective: "ship the guard" }, ...over };
}
const run = (sessions, { sensors = [{ sessionId: SID, pid: 4100, ts: NOW - 5_000, idle: true }], memory = {} } = {}) => refusal.detect(makeWorld({ now: NOW, sessions, sensors }), memory);

test("D24: a goal blocked by a policy refusal with calls left without a result is human-needed and asks for one resume", () => {
	const [finding, ...rest] = run([refused()]);
	assert.equal(rest.length, 0);
	assert.deepEqual([finding.detector, finding.kind, finding.severity, finding.humanNeeded], ["D24", "refusal-orphan", "warn", true]);
	assert.deepEqual(finding.data.remedy, { kind: "refusal-resume" });
	assert.deepEqual(finding.data.calls, [{ name: "eval", summary: "probe the guard hook" }, { name: "task", summary: "review the hook" }]);
	assert.match(finding.detailKo, /eval\(probe the guard hook\)/);
});

test("D24: the OpenAI cybersecurity flag counts too", () => {
	const text = "Your request was flagged for possible cybersecurity risk.";
	const s = refused({ lastAssistant: { ms: REFUSED, stopReason: "toolUse", errorMessage: text, entryId: "e9" }, lastMessage: { role: "assistant", ms: REFUSED } });
	assert.equal(run([s]).length, 1);
});

test("D24: nothing for an error reply without calls, answered calls, an active goal, a later message, a running turn or a child session", () => {
	const cases = {
		"stopReason error": refused({ lastAssistant: { ms: REFUSED, stopReason: "error", errorMessage: CLAUDE, entryId: "e9" } }),
		"results arrived": refused({ pendingCalls: [] }),
		"calls of an older reply": refused({ pendingCalls: [{ id: "c0", name: "eval", batchId: "e1" }] }),
		"another error": refused({ lastAssistant: { ms: REFUSED, stopReason: "toolUse", errorMessage: "overloaded_error", entryId: "e9" } }),
		"a person already answered": refused({ lastMessage: { role: "user", ms: REFUSED + 60_000 } }),
		"goal active": { ...refused(), anchor: { source: "goal", status: "active", objective: "x" } },
		"no goal": { ...refused(), anchor: null },
		"child session": { ...refused(), kind: "child" },
	};
	for (const [label, session] of Object.entries(cases)) assert.deepEqual(run([session]), [], label);
	assert.deepEqual(run([refused()], { sensors: [{ sessionId: SID, pid: 4100, ts: NOW, idle: false }] }), [], "a turn is running");
});

test("D24: after two resumes within an hour it only tells the human", () => {
	const memory = { resumes: { [SID]: [NOW - 50 * 60_000, NOW - 10 * 60_000] } };
	const [finding] = run([refused()], { memory });
	assert.equal(finding.humanNeeded, true);
	assert.equal(finding.data.remedy, undefined);
	assert.match(finding.detailKo, /직접 이어 가세요/);
	const old = { resumes: { [SID]: [NOW - 70 * 60_000, NOW - 61 * 60_000] } };
	assert.deepEqual(run([refused()], { memory: old })[0].data.remedy, { kind: "refusal-resume" }, "older resumes no longer count");
});

function engineHarness(config = DEFAULT_CONFIG) {
	const root = tmpDir("omoh-refusal-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	const clock = createFakeClock(NOW);
	const sent = [];
	const toasts = [];
	const decisions = [];
	const session = refused();
	// The session's own sensor, idle: delivery goes through its mailbox.
	fs.mkdirSync(paths.health.sensorsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.sensorsDir, `${SID}.json`), JSON.stringify({ v: 1, pid: 4100, sessionId: SID, cwd: "C:\\dev\\proj", kind: "interactive", idle: true, pending: false, executingTools: 0, hasUI: true, ts: NOW }));
	const engine = createEngine({
		paths,
		config,
		clock,
		mode: "auto",
		detectors: [{ name: "refusal", ...refusal }],
		sources: {
			procs: { async snapshot() { return { rows: normalizeRows([{ p: 1, pp: 0, n: "System", c: new Date(NOW - 1e7).toISOString() }, { p: 4100, pp: 1, n: "bun.exe", c: new Date(NOW - 3600_000).toISOString(), cl: "bun cli.js" }]), takenAtMs: clock.now() }; }, async os() { return {}; } },
			registry: { refresh: () => ({ sessions: new Map([[SID, session]]), tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
		},
		actors: { send: (message) => (sent.push(message), "inbox"), decide: (d) => decisions.push(d), notifier: { toast: (t) => (toasts.push(t), { ok: true }) } },
		options: { selfPid: 999999 },
	});
	return { engine, clock, sent, toasts, decisions };
}

test("D24 through the engine: one toast and one turn-starting resume message, never repeated for the same refusal", async () => {
	const h = engineHarness();
	await h.engine.tick();
	assert.equal(h.toasts.length, 1);
	assert.equal(h.sent.length, 1);
	assert.deepEqual([h.sent[0].sessionId, h.sent[0].deliverAs, h.sent[0].triggerTurn, h.sent[0].details.actionKind], [SID, "followUp", true, "refusal-resume"]);
	assert.match(h.sent[0].content, /Do not reissue the same calls verbatim/);
	assert.match(h.sent[0].content, /- eval: probe the guard hook/);
	for (let i = 0; i < 3; i++) {
		h.clock.advance(15_000);
		await h.engine.tick();
	}
	assert.equal(h.sent.length, 1, "one resume per refusal");
	assert.equal(h.toasts.length, 1);
});

test("D24 through the engine: actions.resume off keeps the toast and sends nothing", async () => {
	const h = engineHarness({ ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, resume: false } });
	await h.engine.tick();
	assert.equal(h.toasts.length, 1);
	assert.equal(h.sent.length, 0);
	assert.ok(h.decisions.some((d) => d.action?.kind === "refusal-resume" && d.result === "skipped:switch-off"));
});
