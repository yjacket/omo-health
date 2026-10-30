import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeRows } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import * as orphans from "../src/detect/orphans.mjs";
import * as runaway from "../src/detect/runaway.mjs";
import * as stall from "../src/detect/stall.mjs";
import { createEngine } from "../src/engine.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { createAnalyst } from "../src/judge/analyst.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { guardProcessListeners } from "./helpers/fake-proc.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { raw, sessionState, taskRecord } from "./helpers/world.mjs";

guardProcessListeners();

/**
 * analyst-why todo 8 (end-to-end acceptance): every yellow footer problem routed to the analyst gets its one why message
 * for the supervising session, and the causes that are already obvious (limits, provider-side slowness, stopped-on-errors)
 * are skipped. Each case drives the real engine (`createEngine`) with the real analyst over a scripted runner and a fake
 * clock; the messages go through the real inbox (healthHome/inbox/<sessionId>/).
 */

const MIN = 60_000;
const CALL_MS = Date.parse("2026-09-23T15:37:04.874Z");
const START = CALL_MS + 9 * MIN;
const HOST = 25760;
const TASK = "st_01a0ced9";

/** The fake analyst's answer (>= 20 chars each, as the C1 contract requires) and its text the notice must carry. */
const MECHANISM = "the pending call was issued with no command text, so it waits for a model turn that never arrives and the batch never returns";
const AVOID = "re-dispatch the step with a bounded command such as `timeout 60 sleep 1` and read its output";
const STUCK = { verdict: "stuck", cause: "wrong-command", evidence: ["the call stayed pending for over ten minutes", "no process tree matches it"], confidence: 0.9, diagnosis: "The pending call cannot finish as it stands.", mechanism: MECHANISM, avoid: AVOID, respawn_text: "Restart the step with the bounded command." };
const answers = (result) => ({ status: "done", result, costUsd: 0.01 });

const DETECTORS = { stall, orphans, runaway };

/**
 * One parent p1 (main, sensor) and its child c1 (task st_01a0ced9) under host 25760, as test/engine-why.test.mjs builds
 * them. The analyst is the real one over a scripted runner; no message is captured in memory, so every delivery is a real
 * inbox file. `kill` records nothing and kills nothing: none of these cases may reach a process action.
 */
function harness({ detectors = [], extra = [], tasks, childLast, childPending = [], parentPending = [], procRows: extraProcs = [], sensors = ["p1"], outcomes, config: extraConfig = {} } = {}) {
	const root = tmpDir("omoh-analyst-why-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(START);
	const task = taskRecord({ taskId: TASK, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", childSessionId: "c1" });
	const child = sessionState({ id: "c1", kind: "child", taskId: TASK, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", task, pendingCalls: childPending, ...(childLast ? { lastMessage: childLast, lastEntryMs: childLast.ms } : {}) });
	const parent = sessionState({ id: "p1", kind: "main", hostPid: HOST, lastMessage: { role: "assistant", stopReason: "stop" }, pendingCalls: parentPending });
	const sessions = new Map([["c1", child], ["p1", parent]]);
	const procRows = new Map([[HOST, { p: HOST, pp: 1, n: "node.exe", c: "2026-09-23T09:00:00Z", cpu: 0, pv: 1e8, cl: "node C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" }]]);
	for (const row of extraProcs) procRows.set(row.p, row);
	const procs = {
		async snapshot() {
			for (const row of procRows.values()) if (row.n === "python.exe") row.cpu += 19_500;
			return { takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) };
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
	const runner = createFakeRunner({ outcomes: { analyst: outcomes ?? answers(STUCK) } });
	const decisions = [];
	const killed = [];
	const config = { ...DEFAULT_CONFIG, procSnapshotMs: 20_000, ...extraConfig, analyst: { ...DEFAULT_CONFIG.analyst, ...(extraConfig.analyst ?? {}) } };
	const engine = createEngine({
		paths,
		config,
		clock,
		detectors: [...detectors.map((name) => ({ name, ...DETECTORS[name] })), ...extra],
		sources: { procs, registry: { refresh: () => ({ sessions, tasks: tasks ?? [task] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: {
			kill: (args) => {
				killed.push(args);
				return { killed: [], survived: [], noop: [], errors: [] };
			},
			notifier: { toast: () => ({ ok: true }) },
			decide: (d) => decisions.push(d),
			sensors: () => new Map(sensors.map((id) => [id, { sessionId: id, pid: HOST, ts: clock.now(), idle: true }])),
			analyst: createAnalyst({ config, paths, clock, runner, env: {} }),
		},
		options: { selfPid: 1 },
	});
	return { engine, clock, child, parent, sessions, procRows, runner, decisions, killed, paths, config, investigations: createInvestigations({ paths, clock }) };
}

async function runUntil(h, untilMs, stepMs = 20_000) {
	const results = [];
	while (h.clock.now() <= untilMs) {
		results.push(await h.engine.tick());
		h.clock.advance(stepMs);
	}
	return results;
}

const invFile = (h, fp) => path.join(h.paths.health.investigationsDir, `${fp}.json`);
const invOf = (h, fp) => h.investigations.get(fp);

/** Every JSON message that reached an inbox (an undelivered one counts: it was still one message). */
function inboxMessages(h) {
	const out = [];
	const walk = (dir) => {
		for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".json")) out.push({ dir: path.basename(path.dirname(full)), message: JSON.parse(fs.readFileSync(full, "utf8")) });
		}
	};
	walk(h.paths.health.inboxDir);
	return out.sort((a, b) => a.message.createdMs - b.message.createdMs);
}
const messagesOf = (h, fp) => inboxMessages(h).filter((m) => m.message.details?.fp === fp || m.message.details?.incidentId === fp);
const whyOf = (h, fp) => messagesOf(h, fp).filter((m) => m.message.details?.why === true);

/** The one why look of a why-kind finding: open -> job -> one notice with mechanism, avoid and the fixed line. */
async function whyLook(h, fp) {
	await h.engine.tick();
	assert.ok(fs.existsSync(invFile(h, fp)), "the investigation file exists");
	assert.deepEqual([invOf(h, fp).trigger, invOf(h, fp).status], ["why", "analyzing"], "the why look opened the investigation and runs");
	assert.equal(h.runner.starts.length, 1, "one analyst job");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(invOf(h, fp).status, "advised");
	const why = whyOf(h, fp);
	assert.equal(why.length, 1, "exactly one details.why message for this fp");
	const msg = why[0].message;
	assert.ok(msg.content.includes(MECHANISM), "the notice carries the mechanism");
	assert.ok(msg.content.includes(AVOID), "the notice carries the avoid advice");
	assert.ok(msg.content.includes("Do not rerun the same command unchanged."), "the notice forbids rerunning unchanged");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(whyOf(h, fp).length, 1, "later ticks add no second why message");
	assert.equal(h.killed.length, 0, "an explanation is never a process action");
	return msg;
}

const fixed = (...factories) => ({ name: "fixed", detect: () => factories.map((make) => make()) });

/** The why-kind findings, shaped as their detectors emit them (subject/data/remedy), so the routing is the real one. */
const deadChild = () => makeFinding({ detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "p1", taskId: TASK, parentSessionId: "p1", key: "dead:c1@1" }, evidence: ["last:assistant:", "idleMs:2400000", "task:running"], titleKo: "서브에이전트 정지: st_01a0ced9 40분째 기록 없음", detailKo: "d", data: { idleMs: 40 * MIN, childSessionId: "c1", lastRole: "assistant", lastStopReason: "toolUse", taskStatus: "running", remedy: { kind: "wake-parent", reason: "dead-child" } } });
const hungMainTurn = () => makeFinding({ detector: "D8", kind: "hung-main-turn", severity: "warn", subject: { sessionId: "p1", key: "hung-main@1" }, evidence: ["idleMs:2400000", "executingTools:0", "idle:false"], titleKo: "메인 세션 모델 응답 정지: 40분째 응답 없음", detailKo: "d", data: { idleMs: 40 * MIN, lastEventAt: START - 40 * MIN, remedy: { kind: "abort-continue" } } });
const hungTurnChild = () => makeFinding({ detector: "D5", kind: "hung-turn-child", severity: "warn", subject: { sessionId: "c1", taskId: TASK, parentSessionId: "p1", hostPid: HOST, key: "hung@1" }, evidence: ["last:toolResult", "idleMs:2400000", "task:running"], titleKo: "서브에이전트 모델 응답 정지: 40분째 응답 없음", detailKo: "d", data: { idleMs: 40 * MIN, lastRole: "toolResult", lastEntryMs: START - 40 * MIN, taskStatus: "running", remedy: { kind: "wake-parent", reason: "hung-turn" } } });
const sameCallLoop = (argsHash) => makeFinding({ detector: "D10", kind: "same-call-loop", severity: "warn", subject: { sessionId: "c1", taskId: TASK, key: `call:bash:${argsHash}` }, evidence: ["tool:bash", `argsHash:${argsHash}`, "count:12"], titleKo: "도구 반복 루프: bash를 같은 인자로 12회 연속 호출", detailKo: "d", data: { tool: "bash", argsHash, count: 12, runLength: 12 } });
const errorStorm = (errorHead) => makeFinding({ detector: "D10", kind: "error-storm", severity: "warn", subject: { sessionId: "c1", taskId: TASK, key: `err:${errorHead.slice(0, 24)}` }, evidence: [`error:${errorHead.slice(0, 40)}`, "count:9"], titleKo: "오류 폭풍: 같은 오류 9회 반복", detailKo: "d", data: { errorHead, count: 9, total: 9 } });
const accountsBlocked = () => makeFinding({ detector: "D6", kind: "accounts-blocked", severity: "crit", humanNeeded: true, subject: { key: "machine" }, evidence: ["accounts:blocked"], titleKo: "계정 차단", detailKo: "d" });
const tpsCollapse = () => makeFinding({ detector: "D5", kind: "tps-collapse", severity: "warn", subject: { key: "lane:anthropic-subscription/claude-opus-4-6" }, evidence: ["medianTps:3.2", "sessions:2"], titleKo: "응답 속도 저하(공급자 측)", detailKo: "d", data: { providerSide: true, medianTps: 3.2, sessionIds: ["c1", "p1"] } });
const stoppedOnErrors = () => makeFinding({ detector: "D8", kind: "stopped-on-errors", severity: "warn", subject: { sessionId: "p1", key: "errstop:p1@1" }, evidence: ["errors:3", "class:other", "provider:anthropic"], titleKo: "오류로 멈춘 세션: 공급자 회복 후 재개 필요", detailKo: "d", data: { errorClass: "other", recoveredAt: START - MIN, lastErrorMs: START - 5 * MIN, remedy: { kind: "nudge" } } });

test("D8 dead-child: the parent gets the wake as before and exactly one why relay naming the mechanism", async () => {
	const finding = deadChild();
	const h = harness({ extra: [fixed(deadChild)], config: {} });
	const msg = await whyLook(h, finding.fp);
	assert.deepEqual([msg.kind, msg.sessionId], ["relay", "p1"]);
	const wake = messagesOf(h, finding.fp).filter((m) => m.message.kind === "wake");
	assert.equal(wake.length, 1, "the detector's own wake went out");
	assert.equal(wake[0].message.sessionId, "p1");
	assert.ok(wake[0].message.content.includes("do not relaunch it unchanged"));
});

test("D8 hung-main-turn: the main session itself gets one self why-notice", async () => {
	const finding = hungMainTurn();
	const h = harness({ extra: [fixed(hungMainTurn)] });
	const msg = await whyLook(h, finding.fp);
	assert.deepEqual([msg.kind, msg.sessionId], ["self-notice", "p1"]);
	assert.equal(invOf(h, finding.fp).subject.sessionId, "p1");
});

test("D5 hung-turn-child: the parent gets the wake as before and exactly one why relay", async () => {
	const finding = hungTurnChild();
	const h = harness({ extra: [fixed(hungTurnChild)] });
	const msg = await whyLook(h, finding.fp);
	assert.deepEqual([msg.kind, msg.sessionId], ["relay", "p1"]);
	const wake = messagesOf(h, finding.fp).filter((m) => m.message.kind === "wake");
	assert.equal(wake.length, 1);
	assert.ok(wake[0].message.content.includes("do not relaunch it unchanged"));
});

test("D10 same-call-loop: the parent gets exactly one why relay", async () => {
	const finding = sameCallLoop("aaaa");
	const h = harness({ extra: [fixed(() => sameCallLoop("aaaa"))] });
	const msg = await whyLook(h, finding.fp);
	assert.deepEqual([msg.kind, msg.sessionId], ["relay", "p1"]);
});

test("D10 error-storm with a code error (no limit wording): the parent gets exactly one why relay", async () => {
	const head = "TypeError: Cannot read properties of undefined (reading 'toolCallId')";
	const finding = errorStorm(head);
	const h = harness({ extra: [fixed(() => errorStorm(head))] });
	const msg = await whyLook(h, finding.fp);
	assert.deepEqual([msg.kind, msg.sessionId], ["relay", "p1"]);
});

test("D2 process-runaway from the real detector: a self why-notice and a bundle that names the runaway command", async () => {
	const cmd = "python -c \"import time; time.sleep(9999)\"";
	const h = harness({ detectors: ["runaway"], procRows: [raw(7700, HOST, "python.exe", "2026-09-23T09:30:00Z", 0, 5e8, cmd)] });
	await runUntil(h, START + 12 * MIN);
	const record = [...h.engine.records.values()].find((r) => r.finding.detector === "D2" && r.finding.kind === "process-runaway");
	assert.ok(record, "the runaway detector produced the finding");
	const fp = record.finding.fp;
	assert.equal(record.finding.data.cmdHead, cmd);
	assert.ok(fs.existsSync(invFile(h, fp)));
	assert.deepEqual([invOf(h, fp).trigger, invOf(h, fp).status], ["why", "advised"]);
	assert.equal(h.runner.starts.length, 1);
	const why = whyOf(h, fp);
	assert.equal(why.length, 1);
	assert.deepEqual([why[0].message.kind, why[0].message.sessionId], ["self-notice", "p1"], "the session whose sensor runs in the runaway's host process");
	// The analyst read the runaway's command line: the bundle the real analyst wrote carries it.
	const bundle = fs.readFileSync(path.join(h.paths.health.analystJobsDir, h.runner.starts[0].jobId, "bundle.md"), "utf8");
	assert.ok(bundle.includes("time.sleep(9999)"), "the bundle shows the runaway command line");
	assert.ok(bundle.includes("\"role\": \"runaway\"") || bundle.includes("runaway"), "the bundle shows the runaway process row");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(whyOf(h, fp).length, 1, "later ticks add no second why message");
});

test("skip: D10 error-storm on a 429 rate-limit text opens no investigation and starts no analyst job", async () => {
	const finding = errorStorm("429 Too many requests");
	const h = harness({ extra: [fixed(() => errorStorm("429 Too many requests"))] });
	const findings = (await h.engine.tick()).findings;
	assert.ok(findings.some((f) => f.fp === finding.fp && f.kind === "error-storm"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 0);
	assert.equal(fs.existsSync(invFile(h, finding.fp)), false);
	assert.deepEqual([...messagesOf(h, finding.fp)], []);
});

test("skip: D10 error-storm on a session-limit text opens no investigation", async () => {
	const head = "You've hit your session limit · resets 5am (rate_limit)";
	const finding = errorStorm(head);
	const h = harness({ extra: [fixed(() => errorStorm(head))] });
	assert.ok((await h.engine.tick()).findings.some((f) => f.fp === finding.fp), "the detector produced the finding");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 0);
	assert.equal(fs.existsSync(invFile(h, finding.fp)), false);
});

test("skip: D6 accounts-blocked and D5 tps-collapse provider-side open no investigation", async () => {
	const blocked = accountsBlocked();
	const collapse = tpsCollapse();
	const h = harness({ extra: [fixed(accountsBlocked, tpsCollapse)] });
	const findings = (await h.engine.tick()).findings;
	assert.ok([blocked, collapse].every((f) => findings.some((seen) => seen.fp === f.fp)), "the detectors produced both findings");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 0, "no analyst job for an obvious cause");
	for (const finding of [blocked, collapse]) {
		assert.equal(fs.existsSync(invFile(h, finding.fp)), false);
		assert.deepEqual([...messagesOf(h, finding.fp)], []);
	}
});

test("skip: D8 stopped-on-errors opens no investigation (the provider answered again, so the provider was the cause)", async () => {
	const finding = stoppedOnErrors();
	const h = harness({ extra: [fixed(stoppedOnErrors)] });
	assert.ok((await h.engine.tick()).findings.some((f) => f.fp === finding.fp), "the detector produced the finding");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 0);
	assert.equal(fs.existsSync(invFile(h, finding.fp)), false);
	assert.deepEqual([...messagesOf(h, finding.fp).filter((m) => m.message.details?.why === true)], []);
});

test("skip: a detector-produced D8 dead-child whose child ended on a 429 keeps its wake and gets no analyst look", async () => {
	const errored = { role: "assistant", ms: START - 40 * MIN, stopReason: "error", errorMessage: "429 Too many requests (rate limit reached)" };
	const h = harness({ detectors: ["orphans"], childLast: errored });
	const findings = (await h.engine.tick()).findings;
	const dead = findings.find((f) => f.kind === "dead-child");
	assert.ok(dead && /429/.test(dead.data.errorText));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 0, "the rate limit is the cause: no analyst job");
	assert.equal(fs.existsSync(invFile(h, dead.fp)), false);
	assert.equal(whyOf(h, dead.fp).length, 0);
	const wake = messagesOf(h, dead.fp).filter((m) => m.message.kind === "wake");
	assert.equal(wake.length, 1, "the detector's own wake still goes out");
	assert.ok(wake[0].message.content.includes("do not relaunch it unchanged"));
});

test("D1 R2 inproc child (real classify path): one why look first, then one relay-cancel carrying mechanism and avoid", async () => {
	const h = harness({ detectors: ["stall"], childPending: [{ id: "toolu_read", name: "read", args: { path: "src/x.mjs" }, ms: CALL_MS }], config: { stall: { ...DEFAULT_CONFIG.stall } } });
	const first = (await h.engine.tick()).findings.find((f) => f.detector === "D1" && f.kind === "stall");
	assert.ok(first && first.data.classification.rule.id === "R2" && first.data.classification.action.kind === "relay-cancel", "the real classify path planned the relay");
	const fp = first.fp;
	await runUntil(h, CALL_MS + 26 * MIN);
	const relays = messagesOf(h, fp).filter((m) => m.message.kind === "relay-cancel");
	assert.equal(relays.length, 1, "one relay-cancel per call");
	assert.equal(relays[0].message.sessionId, "p1", "the parent's inbox");
	assert.ok(relays[0].message.content.includes(MECHANISM) && relays[0].message.content.includes(AVOID), "the relay carries the verdict");
	assert.equal(whyOf(h, fp).length, 0, "the relay-cancel is the one message (C12)");
	assert.equal(h.runner.starts.length, 1, "one why look before the relay");
	const look = h.decisions.find((d) => d.fp === fp && d.action?.kind === "analyze" && d.result === "execute");
	const relay = h.decisions.find((d) => d.fp === fp && d.action?.kind === "relay-cancel" && d.result === "execute");
	assert.ok(look && relay && Date.parse(look.ts) < Date.parse(relay.ts), "the why look runs before the relay-cancel");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(messagesOf(h, fp).filter((m) => m.message.kind === "relay-cancel").length, 1, "no second relay");
});

test("D1 R2 main subject: the status notify stays and the session gets one self why-notice", async () => {
	const h = harness({ detectors: ["stall"], parentPending: [{ id: "toolu_mread", name: "read", args: { path: "src/x.mjs" }, ms: CALL_MS }], config: { stall: { ...DEFAULT_CONFIG.stall } } });
	const first = (await h.engine.tick()).findings.find((f) => f.detector === "D1" && f.kind === "stall");
	assert.ok(first && first.data.classification.rule.id === "R2" && first.data.classification.action.kind === "notify");
	const fp = first.fp;
	await runUntil(h, CALL_MS + 26 * MIN);
	assert.ok(h.decisions.some((d) => d.fp === fp && d.action?.kind === "notify" && d.result === "execute"), "the R2 status notify ran as before");
	const why = whyOf(h, fp);
	assert.equal(why.length, 1);
	assert.deepEqual([why[0].message.kind, why[0].message.sessionId], ["self-notice", "p1"]);
	assert.ok(why[0].message.content.includes(MECHANISM) && why[0].message.content.includes(AVOID));
	assert.equal(h.runner.starts.length, 1);
	assert.deepEqual(messagesOf(h, fp).filter((m) => ["relay-cancel", "nudge"].includes(m.message.kind)), [], "a main subject is never relayed to another session");
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(whyOf(h, fp).length, 1, "later ticks add no second why message");
});
