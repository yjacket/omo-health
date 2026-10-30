import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createEngine } from "../src/engine.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";
import * as tokens from "../src/detect/tokens.mjs";

const T0 = Date.parse("2026-10-19T10:00:00Z");

function harness({ findings, sensors, sessions, config = {}, analyst, investigations, detectorName = "test-actions" }) {
	const root = tmpDir("omoh-actions-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	let now = T0;
	const clock = { now: () => now, advance: (ms) => (now += ms) };
	const sent = [];
	const toasts = [];
	const decisions = [];
	const sessionMap = new Map((sessions ?? [sessionState({ id: "p1", kind: "main" })]).map((session) => [session.id, session]));
	const inv = investigations ?? createInvestigations({ paths, clock });
	const engine = createEngine({
		paths,
		config: { ...DEFAULT_CONFIG, ...config },
		mode: "auto",
		clock,
		detectors: [{ name: detectorName, detect: (world, memory) => (typeof findings === "function" ? findings(world, memory) : findings) }],
		sources: {
			procs: { snapshot: async () => ({ takenAtMs: now, rows: [] }), os: async () => ({}), ports: async () => [], close() {} },
			registry: { refresh: () => ({ sessions: sessionMap, tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
			versions: () => ({ omoAi: "1.0.0", senpi: "1.0.0" }),
		},
		actors: {
			sensors: () => sensors,
			send: (message) => (sent.push(message), `inbox/${message.id}`),
			notifier: { toast: (toast) => (toasts.push(toast), { ok: true }) },
			decide: (entry) => decisions.push(entry),
			...(analyst ? { analyst } : {}),
		},
		options: { selfPid: 1, noStatus: true, investigations: inv },
	});
	return { engine, clock, sent, toasts, decisions, paths, investigations: inv };
}

test("a D4 burn spike's hold survives a daemon restart: a dip right after it is still the same open episode (IS-12)", async () => {
	const HOUR = 3600_000;
	const turn = (ms, input) => ({ ms, startMs: ms - 20_000, durMs: 20_000, provider: "anthropic", model: "claude-opus", input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, stopReason: "toolUse" });
	const burnWorld = (now, recent) => makeWorld({ now, sessions: [sessionState({ id: "s1", turns: [3, 2, 1].map((h) => turn(now - h * HOUR - 30 * 60_000, 500_000)).concat(turn(now - 10 * 60_000, recent)) })] });
	let level = 2_100_000;
	const d4 = (world, memory) => tokens.detect(burnWorld(world.now, level), memory).filter((f) => f.kind === "burn-spike");
	const h1 = harness({ findings: d4, detectorName: "tokens", sensors: new Map() });
	await h1.engine.tick();
	const [fp] = [...h1.engine.records.keys()];
	assert.equal(h1.engine.records.get(fp).finding.kind, "burn-spike");
	const snapshot = JSON.parse(JSON.stringify(h1.engine.snapshotState()));
	level = 1_900_000;
	const h2 = harness({ findings: d4, detectorName: "tokens", sensors: new Map() });
	h2.clock.advance(60_000);
	h2.engine.restoreState(snapshot, h2.clock.now());
	await h2.engine.tick();
	assert.notEqual(h2.engine.records.get(fp)?.state, "resolved", "the dip within burnHoldMs does not end the episode");
	assert.ok(!h2.decisions.some((d) => d.fp === fp && d.event === "resolved"), "no resolve row after the restart");
});

test("a goal wake carries its sources and the analyst verdict, and marks whyNoticed", async () => {
	const key = "silent:0";
	const finding = makeFinding({
		detector: "D21",
		kind: "goal-wait-idle",
		subject: { sessionId: "p1", key },
		titleKo: "goal 세션이 멈춘 monitor를 기다리고 있음",
		data: {
			remedy: { kind: "goal-wake", reason: "idle-monitor" },
			sources: [{ kind: "monitor", id: "m1", name: "build", state: "idle", text: "monitor build is idle for 40 min" }],
		},
	});
	let started = 0;
	const analyst = {
		start: () => {
			started += 1;
			return { tier: 2, verdict: "escalate", assessment: "abnormal", confidence: 0.9, diagnosis: "the monitor cannot advance", mechanism: "it waits on a run that never advances", avoid: "stop the monitor and continue the goal" };
		},
	};
	const h = harness({ findings: [finding], sensors: new Map([["p1", { sessionId: "p1", pid: 1, ts: T0, idle: true, sensorVersion: "0.8.0" }]]), analyst });
	await h.engine.tick();
	h.clock.advance(20_000);
	await h.engine.tick();
	assert.equal(started, 1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].details.actionKind, "goal-wake");
	assert.match(h.sent[0].content, /monitor build is idle for 40 min/);
	assert.match(h.sent[0].content, /Analyst: it waits on a run that never advances/);
	const record = h.engine.records.get(finding.fp);
	assert.equal(record.whyNoticed, true);
	assert.equal(h.investigations.get(finding.fp).status, "advised");
});

test("an incompatible sensor spends no nudge budget and leaves no align history", async () => {
	const key = "align:p1:churn:3";
	const finding = makeFinding({
		detector: "D15",
		kind: "drift",
		severity: "info",
		subject: { sessionId: "p1", key },
		titleKo: "작업 범위 점검: churn",
		data: { signal: "churn", metric: 9, evidence: "9 rounds", goal: "ship it", remedy: { kind: "scope-check" } },
	});
	const h = harness({ findings: [finding], sensors: new Map([["p1", { sessionId: "p1", pid: 1, ts: T0, idle: false, sensorVersion: "0.1.9" }]]) });
	await h.engine.tick();
	assert.equal(h.sent.length, 0);
	const record = h.engine.records.get(finding.fp);
	assert.equal(record.remedyDone, false);
	assert.equal(record.executed.has(`scope-check:${finding.fp}:0`), false);
	assert.equal(record.nextNudgeMs, T0 + 5 * 60_000);
	assert.deepEqual(h.engine.snapshotState().memories.align, {});
});

test("a delivered scope check records { ms, key } for the delivery target", async () => {
	const key = "align:p1:churn:4";
	const finding = makeFinding({
		detector: "D15",
		kind: "drift",
		severity: "info",
		subject: { sessionId: "p1", key },
		titleKo: "작업 범위 점검: churn",
		data: { signal: "churn", metric: 9, evidence: "9 rounds", goal: "ship it", lastUserText: "fix the parser", lastUserMs: T0 - 60_000, remedy: { kind: "scope-check" } },
	});
	const h = harness({ findings: [finding], sensors: new Map([["p1", { sessionId: "p1", pid: 1, ts: T0, idle: false, sensorVersion: "0.2.0" }]]) });
	await h.engine.tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].details.key, key);
	assert.equal(h.engine.records.get(finding.fp).remedyDone, true);
	assert.deepEqual(h.engine.snapshotState().memories.align, { p1: [{ ms: T0, key }] });
});

test("a boot notice is delivered once, recorded, and not sent again after a restart", async () => {
	const gap = { kind: "daemon-down", downSinceMs: T0 - 2 * 3600_000, upAtMs: T0 - 10 * 60_000 };
	const finding = makeFinding({
		detector: "D23",
		kind: "work-lost",
		severity: "info",
		subject: { sessionId: "p1", key: `gap:${gap.downSinceMs}` },
		titleKo: "중단 전 작업이 이어지지 않음",
		data: { gap, goalActive: false, idle: false, tasks: [], runs: [], remedy: { kind: "boot-notice" } },
	});
	const noticeKey = `p1@${gap.downSinceMs}`;
	const detectors = (world, memory) => (memory.noticed?.[noticeKey] ? [] : [finding]);
	const sessions = [sessionState({ id: "p1", kind: "main" })];
	const sensors = new Map([["p1", { sessionId: "p1", pid: 1, ts: T0, idle: false, sensorVersion: "0.8.0" }]]);
	const first = harness({ findings: detectors, sensors, sessions });
	await first.engine.tick();
	assert.equal(first.sent.length, 1);
	assert.equal(first.sent[0].details.actionKind, "boot-notice");
	assert.equal(first.engine.records.get(finding.fp).remedyDone, true);
	const snapshot = JSON.parse(JSON.stringify(first.engine.snapshotState()));
	assert.equal(snapshot.memories.bootGap.noticed[noticeKey], T0);

	const restarted = harness({ findings: detectors, sensors, sessions });
	assert.equal(restarted.engine.restoreState(snapshot, T0 + 60_000), 1);
	await restarted.engine.tick();
	assert.equal(restarted.sent.length, 0);
});
