import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executeKill } from "../src/act/kill.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import * as orphans from "../src/detect/orphans.mjs";
import * as stall from "../src/detect/stall.mjs";
import { createEngine } from "../src/engine.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { createAnalyst } from "../src/judge/analyst.mjs";
import { triageSignature } from "../src/judge/triage.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { buildInvestigations } from "../src/ui/model.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { guardProcessListeners } from "./helpers/fake-proc.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState, taskRecord } from "./helpers/world.mjs";

guardProcessListeners();

/**
 * analyst-why todo 7: the engine wires the why looks (C9/C13/C15/C17/C18), the one why message per finding (C12), the
 * verdict reuse by triage signature (C14), the 조사중 footer (C8) and the restart state. Every case drives the real engine
 * with the real analyst over a scripted runner and a fake clock.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const CALL_MS = Date.parse("2026-09-23T15:37:04.874Z");
const HOST = 25760;
const TASK = "st_01a0ced9";
const iso = (ms) => new Date(ms).toISOString();

const STUCK = { verdict: "stuck", cause: "blocked-input", evidence: ["the shell tree has been idle for 10 minutes", "the worker uses no CPU and writes nothing"], confidence: 0.9, diagnosis: "Nothing in the tree can finish by itself.", mechanism: "`sleep 3000` was run in the foreground, so the call blocks for 50 minutes", avoid: "Use a bounded wait such as timeout 60 sleep 60 and poll instead", respawn_text: "Restart the step with a bounded wait." };
const UNRECOVERABLE = { verdict: "unrecoverable", cause: "unknown", evidence: ["the call has no live process behind it"], confidence: 0.85, diagnosis: "The task cannot continue after a release.", mechanism: "the call has no live process behind it, so no tool result can ever arrive", avoid: "Cancel the task and re-dispatch it with a bounded command instead", respawn_text: "Cancel the task and respawn it." };
const answers = (result) => ({ status: "done", result, costUsd: 0.01 });
const RUNNING = { status: "running" };

/**
 * One parent p1 (main) and its child c1 (task st_01a0ced9) under host 25760, as in test/engine.test.mjs. `call` sets the
 * child's pending bash call and its tree; `returnsOnRelease` makes a kill of the call's bash.exe return the tool call
 * (senpi's error result), so the stall finding disappears like it does live; `inbox` writes real inbox files.
 */
function harness({ outcomes, kind = "child", call, detectors = ["stall"], extra = [], tasks, childLast, parentLastEntryMs, sensors = ["p1"], inbox = false, returnsOnRelease = false, survivors = [], config: extraConfig = {} } = {}) {
	const root = tmpDir("omoh-engine-why-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(CALL_MS + 9 * MIN);
	const task = taskRecord({ taskId: TASK, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", childSessionId: "c1" });
	const child = sessionState({ id: "c1", kind, taskId: TASK, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", task, ...(childLast ? { lastMessage: childLast, lastEntryMs: childLast.ms } : {}) });
	const parent = sessionState({ id: "p1", kind: "main", hostPid: HOST, lastMessage: { role: "assistant", stopReason: "stop" }, ...(parentLastEntryMs ? { lastEntryMs: parentLastEntryMs } : {}) });
	const sessions = new Map([["c1", child], ["p1", parent]]);
	const procRows = new Map([[HOST, { p: HOST, pp: 1, n: "node.exe", c: "2026-09-23T09:00:00Z", cpu: 0, pv: 1e8, cl: "node C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" }]]);
	const procs = {
		async snapshot() {
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
	const killed = [];
	const sent = [];
	const decisions = [];
	const tracker = new ProcessTracker();
	const config = { ...DEFAULT_CONFIG, procSnapshotMs: 20_000, ...extraConfig, analyst: { ...DEFAULT_CONFIG.analyst, ...(extraConfig.analyst ?? {}) } };
	const loaded = { stall, orphans };
	const engine = createEngine({
		paths,
		config,
		clock,
		detectors: [...detectors.map((name) => ({ name, ...loaded[name] })), ...extra],
		sources: { procs, registry: { refresh: () => ({ sessions, tasks: tasks ?? [task] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: {
			kill: (args) =>
				executeKill({
					...args,
					snapshot: async () => tracker.update({ takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) }),
					runner: (pid) => {
						killed.push(pid);
						if (survivors.includes(pid)) return { status: 0 };
						if (returnsOnRelease && procRows.get(pid)?.n === "bash.exe") child.pending.clear();
						procRows.delete(pid);
						return { status: 0 };
					},
					sleep: async () => {},
				}),
			...(inbox ? {} : { send: (message) => (sent.push(message), "inbox-file") }),
			notifier: { toast: () => ({ ok: true }) },
			decide: (d) => decisions.push(d),
			sensors: () => new Map(sensors.map((id) => [id, { sessionId: id, pid: HOST, ts: clock.now(), idle: true }])),
			analyst: createAnalyst({ config, paths, clock, runner, env: {} }),
		},
		options: { selfPid: 1 },
	});
	const h = { engine, clock, child, sessions, procRows, runner, killed, sent, decisions, paths, config, investigations: createInvestigations({ paths, clock }) };
	if (call) setCall(h, call);
	return h;
}

/** The child's pending call becomes `cmd`, run by bash -> `worker` (no CPU, no writes); pids are per call. */
function setCall(h, { cmd, worker = "sleep.exe", workerCmd = cmd, id = "toolu_call", ms = CALL_MS, shell = 60168, workerPid = 60180 }) {
	h.child.pending.clear();
	h.child.pending.set(id, { id, name: "bash", args: { command: cmd }, ms, batchId: `b-${id}`, index: 0, batchSize: 1 });
	h.procRows.set(shell, { p: shell, pp: HOST, n: "bash.exe", c: iso(ms + 5), cpu: 0, pv: 1e6, cl: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd}"` });
	h.procRows.set(workerPid, { p: workerPid, pp: shell, n: worker, c: iso(ms + 50), cpu: 0, pv: 1e6, cl: workerCmd });
}
const IDLE_SLEEP = { cmd: "sleep 3000", workerCmd: "sleep 3000" };
const PYTHON = { cmd: "python", worker: "python.exe", workerCmd: "python" };
/** The quiet hang never replaces the R11 finding: its fingerprint stays the same for hours. */
const NO_QUIET_HANG = { stall: { ...DEFAULT_CONFIG.stall, quietMs: 24 * HOUR, restallMs: 24 * HOUR } };

async function runUntil(h, untilMs, stepMs = 20_000) {
	const results = [];
	while (h.clock.now() <= untilMs) {
		results.push(await h.engine.tick());
		h.clock.advance(stepMs);
	}
	return results;
}

const whySent = (h) => h.sent.filter((m) => m.details?.why === true);
/** Every message the engine wrote into the inbox (also the ones the sweep moved to _undelivered). */
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
const statusText = (h, id) => JSON.parse(fs.readFileSync(path.join(h.paths.health.statusDir, `${id}.json`), "utf8")).text;
const invOf = (h, fp) => h.investigations.get(fp);

/** A D10 same-call-loop of the child: the signature carries the tool and the argsHash (C11). */
const loop = (argsHash, key = argsHash) => makeFinding({ detector: "D10", kind: "same-call-loop", severity: "warn", subject: { sessionId: "c1", taskId: TASK, key: `call:bash:${key}` }, evidence: [`argsHash:${argsHash}`], titleKo: "같은 호출 반복", detailKo: "d", data: { tool: "bash", argsHash, count: 12 } });
/** Findings a test switches on and off: `list` is read every tick. */
function switchable() {
	const list = [];
	return { list, detector: { name: "switch", detect: () => list.map((make) => make()) } };
}
/** No pending call, so only injected findings exist. */
const NO_CALL = { detectors: [] };

test("(1) a child's R11 stall: the analyst's stuck verdict releases the tree and exactly one inbox file in inbox/<parent>/ explains it (details.why, mechanism); later ticks add none", async () => {
	const h = harness({ call: IDLE_SLEEP, inbox: true, returnsOnRelease: true });
	await runUntil(h, CALL_MS + 13 * MIN);
	assert.deepEqual(h.killed.sort(), [60168, 60180]);
	const why = inboxMessages(h).filter((m) => m.message.details?.why === true);
	assert.deepEqual(why.map((m) => [m.dir, m.message.kind, m.message.sessionId]), [["p1", "relay", "p1"]]);
	assert.ok(why[0].message.content.includes(STUCK.mechanism));
	assert.ok(why[0].message.content.includes(STUCK.avoid));
	await runUntil(h, CALL_MS + 20 * MIN);
	assert.equal(inboxMessages(h).length, 1, "nothing more, however many ticks follow");
	assert.equal(h.runner.starts.length, 1, "the release verdict is the explanation: no second look");
});

test("(2) reuse: a second finding with the same triage signature within 24 h starts no analyst job and still gets its own why message", async () => {
	const s = switchable();
	const h = harness({ ...NO_CALL, extra: [s.detector] });
	s.list.push(() => loop("aaaa", "first"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(whySent(h).length, 1);
	s.list.push(() => loop("aaaa", "second"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 1, "the answered verdict of the same signature is reused");
	const second = loop("aaaa", "second");
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId, m.details.fp]), [["relay", "p1", loop("aaaa", "first").fp], ["relay", "p1", second.fp]]);
	assert.deepEqual([invOf(h, second.fp).verdict.reused, invOf(h, second.fp).trigger], [true, "why"]);
	assert.ok(h.decisions.some((d) => d.fp === second.fp && d.action?.kind === "analyze" && d.outcome?.reused === loop("aaaa", "first").fp));
});

test("(3) footer: while the why job runs the parent's status reads 👀 조사중; after the verdict and its message it is the detector word again", async () => {
	const s = switchable();
	const h = harness({ ...NO_CALL, extra: [s.detector], outcomes: [RUNNING, RUNNING, answers(STUCK)] });
	s.list.push(() => loop("bbbb"));
	await h.engine.tick();
	assert.equal(h.runner.starts.length, 1);
	assert.equal(statusText(h, "p1"), "👀 조사중");
	assert.equal(statusText(h, "c1"), "👀 조사중");
	await runUntil(h, h.clock.now() + 3 * MIN);
	assert.equal(whySent(h).length, 1);
	assert.equal(statusText(h, "p1"), "👀 루프");
});

test("(4) a D2 runaway without a session goes to the session whose sensor runs in its host process, as a self-notice; a D8 dead-child goes to the parent as a relay, never a self-notice", async () => {
	const runaway = () => makeFinding({ detector: "D2", kind: "process-runaway", severity: "warn", subject: { pids: [{ pid: 7700, ctime: iso(CALL_MS) }], hostPid: HOST, key: "proc:7700" }, evidence: [], titleKo: "폭주", detailKo: "d", data: { pid: 7700, name: "python.exe", cmdHead: "python -c spin", avgCpu: 98 } });
	const dead = () => makeFinding({ detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: "p1", taskId: TASK, parentSessionId: "p1", key: "dead:c1" }, evidence: [], titleKo: "서브에이전트 멈춤", detailKo: "d", data: { idleMs: 31 * MIN, remedy: { kind: "wake-parent", reason: "dead-child" } } });
	const h = harness({ ...NO_CALL, extra: [{ name: "fake", detect: () => [runaway(), dead()] }] });
	await runUntil(h, h.clock.now() + 3 * MIN);
	const why = whySent(h);
	assert.deepEqual(why.find((m) => m.details.detector === "D2") && [why.find((m) => m.details.detector === "D2").kind, why.find((m) => m.details.detector === "D2").sessionId], ["self-notice", "p1"]);
	const d8 = why.filter((m) => m.details.detector === "D8");
	assert.deepEqual(d8.map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
	const wake = h.sent.findIndex((m) => m.kind === "wake");
	assert.ok(wake >= 0 && wake < h.sent.indexOf(d8[0]), "the wake goes first, the explanation after the look");
});

test("(5) a D1 child release whose finding disappears on the next tick still ends with one why message to the parent", async () => {
	const h = harness({ call: IDLE_SLEEP, returnsOnRelease: true });
	const results = await runUntil(h, CALL_MS + 14 * MIN);
	const releaseTick = results.findIndex((r) => r.results.some((x) => x.kind === "release-shell" && x.result === "execute"));
	assert.ok(releaseTick >= 0);
	const noticeTick = results.findIndex((r) => r.results.some((x) => x.kind === "why-notice"));
	assert.ok(noticeTick > releaseTick, "the notice comes after the release");
	assert.ok(!results[noticeTick].findings.some((f) => f.detector === "D1"), "the finding was gone when the notice went out");
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
});

test("(6) an R7 rule release whose finding disappears gets one why look (answered after the disappearance) and one message", async () => {
	const h = harness({ call: PYTHON, returnsOnRelease: true, outcomes: [RUNNING, RUNNING, answers(STUCK)] });
	await runUntil(h, CALL_MS + 15 * MIN);
	assert.deepEqual(h.killed.sort(), [60168, 60180]);
	assert.equal(h.runner.starts.length, 1, "one why look");
	const release = h.decisions.find((d) => d.action?.kind === "release-shell" && d.result === "execute");
	const look = h.decisions.find((d) => d.action?.kind === "analyze");
	assert.ok(Date.parse(look.ts) > Date.parse(release.ts), "the look follows the rule release");
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
	const [inv] = h.investigations.list();
	assert.deepEqual([inv.status, inv.why, inv.verdict.why], ["advised", true, true]);
});

test("(7) an unrecoverable child verdict: the actual relay-cancel inbox file carries the mechanism and avoid", async () => {
	const h = harness({ call: IDLE_SLEEP, inbox: true, outcomes: answers(UNRECOVERABLE) });
	await runUntil(h, CALL_MS + 13 * MIN);
	assert.deepEqual(h.killed, []);
	const relays = inboxMessages(h).filter((m) => m.message.kind === "relay-cancel");
	assert.equal(relays.length, 1);
	assert.ok(relays[0].message.content.includes(UNRECOVERABLE.mechanism) && relays[0].message.content.includes(UNRECOVERABLE.avoid));
	assert.equal(inboxMessages(h).length, 1, "the relay-cancel is the one message (C12)");
});

test("(9) distinct D10 loops (different argsHash) each start their own analyst job", async () => {
	const h = harness({ ...NO_CALL, extra: [{ name: "fake", detect: () => [loop("cccc"), loop("dddd")] }] });
	await runUntil(h, h.clock.now() + 5 * MIN);
	assert.equal(h.runner.starts.length, 2);
	assert.equal(whySent(h).length, 2);
	assert.equal(new Set(h.investigations.list().map((inv) => inv.signature)).size, 2);
});

test("(10) a why look the analyst never reached (budget spent) is not reused: the next same-signature finding starts a job once the budget allows", async () => {
	const s = switchable();
	const h = harness({ ...NO_CALL, extra: [s.detector], config: { analyst: { perDay: 0 } } });
	s.list.push(() => loop("eeee", "first"));
	await runUntil(h, h.clock.now() + MIN);
	const first = invOf(h, loop("eeee", "first").fp);
	assert.deepEqual([h.runner.starts.length, first.verdict.notReached], [0, true]);
	s.list.length = 0;
	h.config.analyst.perDay = 40;
	s.list.push(() => loop("eeee", "second"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 1, "a real job, no reuse of the unanswered look");
	assert.equal(invOf(h, loop("eeee", "second").fp).verdict.reused, false);
});

test("(11) a D1 child stall's release look is never reused, even when an answered why investigation of the same signature exists", async () => {
	const h = harness({ call: IDLE_SLEEP, outcomes: RUNNING });
	const [early] = (await h.engine.tick()).findings.filter((f) => f.detector === "D1");
	h.investigations.open({ id: "other-why", trigger: "why", subject: {}, detector: "D1", signature: triageSignature(early) });
	h.investigations.attach("other-why", { why: true, status: "advised", verdict: { atMs: h.clock.now(), verdict: "escalate", assessment: "abnormal", cause: "blocked-input", mechanism: STUCK.mechanism, avoid: STUCK.avoid, why: true, failed: false, notReached: false, reused: false } });
	await runUntil(h, CALL_MS + 11 * MIN);
	assert.equal(h.runner.starts.length, 1, "the release look runs");
	const inv = h.investigations.list().find((i) => i.id !== "other-why");
	assert.deepEqual([inv.trigger, inv.status], ["stall", "analyzing"]);
});

test("(13) restart: after a child's relay-cancel went out, a restored engine sends no second relay and no why message while the finding stays", async () => {
	const h = harness({ call: IDLE_SLEEP, outcomes: answers(UNRECOVERABLE), config: NO_QUIET_HANG });
	await runUntil(h, CALL_MS + 13 * MIN);
	assert.deepEqual(h.sent.map((m) => m.kind), ["relay-cancel"]);
	const saved = JSON.parse(JSON.stringify(h.engine.snapshotState()));
	assert.ok(saved.records.some((r) => r.whyNoticed === true));
	const restarted = harness({ call: IDLE_SLEEP, outcomes: answers(UNRECOVERABLE), config: NO_QUIET_HANG });
	restarted.clock.set?.(h.clock.now());
	while (restarted.clock.now() < h.clock.now()) restarted.clock.advance(20_000);
	restarted.engine.restoreState(saved, restarted.clock.now());
	await runUntil(restarted, restarted.clock.now() + 20 * MIN);
	assert.deepEqual(restarted.sent, [], "the one message per fp survives the restart");
});

test("(14)(17) R7 child release with the finding still present: the why job holds the ladder (no relay-cancel), the footer reads 👀 조사중 though the investigation is released, then one why message and 👀 멈춤", async () => {
	// An R7 finding whose fingerprint survives the release (the live detector would reclassify the call once its tree changed).
	let targets = [];
	const r7 = () => makeFinding({ detector: "D1", kind: "stall", cls: "blocked-on-input", severity: "warn", subject: { sessionId: "c1", taskId: TASK, parentSessionId: "p1", toolCallId: "toolu_call", key: "toolu_call" }, evidence: ["python waits for input"], titleKo: "멈춤", detailKo: "d", data: { sessionKind: "child", classification: { rule: { id: "R7", v: 1 }, confidence: 0.9, action: { kind: "release-shell" } }, match: { tree: targets } } });
	const h = harness({ ...NO_CALL, call: PYTHON, extra: [{ name: "r7", detect: () => (targets.length ? [r7()] : []) }], outcomes: [RUNNING, RUNNING, RUNNING, RUNNING, answers(STUCK)] });
	await h.engine.tick();
	targets = h.engine.table.all().filter((p) => [60168, 60180].includes(p.pid));
	assert.equal(targets.length, 2);
	const fp = r7().fp;
	let sawInvestigating = false;
	while (h.clock.now() <= CALL_MS + 20 * MIN) {
		await h.engine.tick();
		const job = h.engine.records.get(fp)?.analyst;
		if (invOf(h, fp)?.status === "released" && job?.jobId && !job.verdict) {
			assert.equal(statusText(h, "p1"), "👀 조사중");
			sawInvestigating = true;
		}
		h.clock.advance(20_000);
	}
	assert.deepEqual(h.killed.sort(), [60168, 60180]);
	assert.ok(sawInvestigating, "the why job ran after the release while the finding stayed");
	assert.deepEqual(h.decisions.filter((d) => d.action?.kind === "relay-cancel"), [], "no relay-cancel: the why message is the one message");
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
	assert.equal(h.sent.length, 1);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(statusText(h, "p1"), "👀 멈춤");
});

test("(15) a child's low-confidence stuck verdict releases nothing and sends the parent one why message", async () => {
	const h = harness({ call: IDLE_SLEEP, outcomes: answers({ ...STUCK, confidence: 0.5 }), config: NO_QUIET_HANG });
	await runUntil(h, CALL_MS + 30 * MIN);
	assert.deepEqual(h.killed, []);
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
	assert.equal(h.sent.length, 1);
});

test("(16) a detector-produced D8 child-error-unhandled with a revoked login: the wake goes out, no analyst job starts", async () => {
	const now = CALL_MS + 9 * MIN;
	const errored = taskRecord({ taskId: TASK, status: "error", hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", childSessionId: "c1", terminalAtMs: now - 20 * MIN });
	const h = harness({ detectors: ["orphans"], tasks: [errored], childLast: { role: "assistant", ms: now - 20 * MIN, stopReason: "error", errorMessage: "401 Unauthorized: OAuth access token has been revoked" }, parentLastEntryMs: now - 25 * MIN });
	const results = await runUntil(h, now + MIN);
	assert.ok(results.flatMap((r) => r.findings).some((f) => f.kind === "child-error-unhandled" && /401/.test(f.data.errorText)));
	assert.deepEqual(h.sent.filter((m) => m.kind === "wake").map((m) => m.sessionId), ["p1"]);
	assert.equal(h.runner.starts.length, 0);
	assert.deepEqual(whySent(h), []);
	assert.ok(!h.investigations.list().some((inv) => inv.trigger === "why"));
});

test("(18) reuse window: an answer at t0 is reused at t0+23 h; at t0+46 h (that reuse is no cache source) a new job runs", async () => {
	const s = switchable();
	const h = harness({ ...NO_CALL, extra: [s.detector] });
	const at = (key) => () => loop("ffff", key);
	s.list.push(at("t0"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 1);
	s.list.length = 0;
	h.clock.advance(23 * HOUR);
	s.list.push(at("t23"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 1, "reused");
	assert.equal(invOf(h, loop("ffff", "t23").fp).verdict.reused, true);
	s.list.length = 0;
	h.clock.advance(23 * HOUR);
	s.list.push(at("t46"));
	await runUntil(h, h.clock.now() + 2 * MIN);
	assert.equal(h.runner.starts.length, 2, "the t0 answer is too old and a reused answer is never a cache source");
	assert.equal(whySent(h).length, 3);
});

test("(19) a main session's R7 stall: the release stays blocked, one why investigation opens and the session gets one self why-notice; nothing further later", async () => {
	const h = harness({ kind: "main", call: PYTHON, sensors: ["p1", "c1"] });
	await runUntil(h, CALL_MS + 30 * MIN);
	assert.deepEqual(h.killed, []);
	assert.ok(h.decisions.some((d) => d.action?.kind === "release-shell" && d.result === "skipped:main-session"));
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["self-notice", "c1"]]);
	assert.equal(h.sent.length, 1);
	assert.equal(h.runner.starts.length, 1);
	const [inv] = h.investigations.list();
	assert.deepEqual([inv.trigger, inv.why, inv.rule.id], ["why", true, "R7"]);
});

test("(20) an R12 dead batch on a child (classify-produced): one why look before the relay-cancel, and the relay carries mechanism and avoid", async () => {
	const h = harness({ outcomes: answers(UNRECOVERABLE) });
	h.child.pending.set("r1", { id: "r1", name: "read", args: { path: "x" }, ms: CALL_MS, batchId: "b", index: 0, batchSize: 2 });
	h.child.pending.set("s1", { id: "s1", name: "bash", args: { command: "sleep 900" }, ms: CALL_MS, batchId: "b", index: 1, batchSize: 2 });
	await runUntil(h, CALL_MS + 18 * MIN);
	const relays = h.sent.filter((m) => m.kind === "relay-cancel");
	assert.equal(relays.length, 1, "one relay-cancel per batch");
	assert.ok(relays[0].content.includes(UNRECOVERABLE.mechanism) && relays[0].content.includes(UNRECOVERABLE.avoid));
	const look = h.decisions.find((d) => d.action?.kind === "analyze" && d.result === "execute");
	const relay = h.decisions.find((d) => d.action?.kind === "relay-cancel" && d.result === "execute");
	assert.ok(Date.parse(look.ts) < Date.parse(relay.ts), "the why look first");
	assert.equal(h.runner.starts.length, 1);
	assert.deepEqual(whySent(h), [], "the relay-cancel is the one message (C12)");
});

test("(21) disappearance before the answer: a main look (with a signal) and a child look at step 0 that vanish while the job runs each get exactly one explanation", async () => {
	const s = switchable();
	const h = harness({ ...NO_CALL, extra: [s.detector], outcomes: [RUNNING, RUNNING, RUNNING, answers(UNRECOVERABLE)] });
	const analyzeClass = { rule: { id: "R11", v: 1 }, confidence: 0.6, action: { kind: "analyze" } };
	const main = () => makeFinding({ detector: "D1", kind: "stall", cls: "unknown", severity: "warn", subject: { sessionId: "p1", toolCallId: "tm", key: "main-call" }, evidence: [], titleKo: "멈춤 의심", detailKo: "d", data: { sessionKind: "main", classification: analyzeClass, signals: [{ kind: "system32-bash" }] } });
	const kid = () => makeFinding({ detector: "D1", kind: "stall", cls: "unknown", severity: "warn", subject: { sessionId: "c1", taskId: TASK, parentSessionId: "p1", toolCallId: "tc", key: "child-call" }, evidence: [], titleKo: "멈춤 의심", detailKo: "d", data: { sessionKind: "child", classification: analyzeClass } });
	s.list.push(main, kid);
	await h.engine.tick();
	h.clock.advance(20_000);
	await h.engine.tick();
	assert.equal(h.decisions.filter((d) => d.action?.kind === "analyze" && d.result === "execute").length, 2, "both looks were asked (one may queue)");
	s.list.length = 0;
	await runUntil(h, h.clock.now() + 10 * MIN);
	assert.deepEqual(h.killed, []);
	const why = whySent(h);
	assert.deepEqual(why.filter((m) => m.details.fp === main().fp).map((m) => [m.kind, m.sessionId]), [["self-notice", "p1"]]);
	assert.deepEqual(why.filter((m) => m.details.fp === kid().fp).map((m) => [m.kind, m.sessionId]), [["relay", "p1"]]);
	assert.equal(h.sent.length, 2);
});

test("(22) R7 releases of one task: the first why look is answered and marked why, the second same-signature release reuses it (no second job); the dashboard reads 원인 조사", async () => {
	const h = harness({ call: PYTHON, returnsOnRelease: true });
	await runUntil(h, CALL_MS + 14 * MIN);
	assert.equal(h.runner.starts.length, 1);
	const [first] = h.investigations.list();
	assert.deepEqual([first.why, first.verdict.why, first.trigger], [true, true, "stall"]);
	assert.equal(buildInvestigations({ investigations: [first], now: h.clock.now() }).rows[0].triggerKo, "원인 조사");
	const again = h.clock.now();
	setCall(h, { ...PYTHON, id: "toolu_again", ms: again, shell: 61000, workerPid: 61010 });
	await runUntil(h, again + 14 * MIN);
	assert.deepEqual(h.killed.sort(), [60168, 60180, 61000, 61010]);
	assert.equal(h.runner.starts.length, 1, "the second why look reused the first answer");
	const second = h.investigations.list().find((inv) => inv.id !== first.id);
	assert.equal(second.signature, first.signature);
	assert.deepEqual([second.verdict.reused, second.why], [true, true]);
	assert.deepEqual(whySent(h).map((m) => [m.kind, m.sessionId]), [["relay", "p1"], ["relay", "p1"]]);
	assert.ok(h.investigations.list().every((inv) => inv.verdict?.why === true), "no release look was ever answered or reused here");
});
