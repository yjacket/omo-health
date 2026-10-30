import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { gate, newRecord, planFinding, WHY_CANDIDATES } from "../src/judge/policy.mjs";

const T = Date.parse("2026-10-19T09:00:00Z");
const MIN = 60_000;
const cfg = DEFAULT_CONFIG;
const LIVENESS = cfg.goalLiveness.livenessMs;
const HOLD = cfg.goalLiveness.idleWakeHoldMs;

const idleFinding = () => makeFinding({
	detector: "D21",
	kind: "goal-wait-idle",
	severity: "warn",
	subject: { sessionId: "goal-1", key: "idle-monitor:0" },
	titleKo: "goal 세션이 멈춘 monitor를 기다리고 있음",
	detailKo: "monitor가 오래 멈춰 있습니다",
	data: {
		reason: "idle-monitor",
		sessionKind: "main",
		sources: [{ kind: "monitor", id: "m1", name: "watch", state: "running", idleMs: 38 * MIN, text: "watch build" }],
		remedy: { kind: "goal-wake", reason: "idle-monitor" },
	},
});

const driftFinding = () => makeFinding({
	detector: "D15",
	kind: "drift",
	severity: "info",
	subject: { sessionId: "main-1", key: "align:main-1:churn:3" },
	titleKo: "작업 범위 점검: churn",
	data: { signal: "churn", remedy: { kind: "scope-check" } },
});

const normal = { tier: 2, verdict: "wait", assessment: "normal", confidence: 0.9, cause: "unknown", evidence: ["e"], diagnosis: "d", mechanism: "it is still making progress on the same goal", avoid: "leave it alone and let the run finish" };
const abnormal = { tier: 2, verdict: "escalate", assessment: "abnormal", confidence: 0.9, cause: "unknown", evidence: ["e"], diagnosis: "d", mechanism: "it repeats a failing review round that cannot converge", avoid: "stop the round and apply the fix the review named" };
const noAnswer = { tier: 2, verdict: "escalate", reason: "budget-exhausted", notReached: true };

const recordFor = (finding, extra = {}) => Object.assign(newRecord(finding.fp, T), extra);
const looked = (finding, verdict, extra = {}) => recordFor(finding, { looks: 1, nextLookMs: 0, analyst: { step: "look0", candidates: WHY_CANDIDATES, verdict }, ...extra });

test("an idle goal wait asks the analyst why before any wake", () => {
	const f = idleFinding();
	const plan = planFinding({ finding: f, record: recordFor(f), now: T, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.why, r.candidates]), [["analyze", "look0", true, WHY_CANDIDATES]]);
	assert.equal(plan.state, "analyzing");
	assert.equal(plan.requests.some((r) => r.kind === "goal-wake"), false);
});

test("an analyst that is off never blocks the idle wake", () => {
	const f = idleFinding();
	const off = { ...cfg, analyst: { ...cfg.analyst, enabled: false } };
	const plan = planFinding({ finding: f, record: recordFor(f), now: T, config: off });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.remedy.kind]), [["goal-wake", 0, "goal-wake"]]);
	assert.equal(plan.state, "acting");
});

test("a pending look holds the wake only for idleWakeHoldMs, then wakes without a verdict", () => {
	const f = idleFinding();
	const running = recordFor(f, { looks: 1, analyst: { step: "look0", startedMs: T, candidates: WHY_CANDIDATES } });
	assert.deepEqual(planFinding({ finding: f, record: running, now: T + HOLD - 1, config: cfg }), { requests: [], state: "analyzing" });
	const plan = planFinding({ finding: f, record: running, now: T + HOLD, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict]), [["goal-wake", undefined]]);
	assert.equal(plan.state, "acting");
	// A look with no startedMs is held from the finding's first sight.
	const unknown = recordFor(f, { looks: 1, analyst: { step: "look0", candidates: WHY_CANDIDATES } });
	assert.deepEqual(planFinding({ finding: f, record: unknown, now: T + HOLD - 1, config: cfg }), { requests: [], state: "analyzing" });
	assert.equal(planFinding({ finding: f, record: unknown, now: T + HOLD, config: cfg }).requests[0].kind, "goal-wake");
});

test("a look that could not answer wakes by the rule, without a verdict", () => {
	const f = idleFinding();
	const plan = planFinding({ finding: f, record: looked(f, noAnswer), now: T + MIN, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict]), [["goal-wake", undefined]]);
});

test("an answered non-normal verdict wakes once and travels with the wake", () => {
	const f = idleFinding();
	const plan = planFinding({ finding: f, record: looked(f, abnormal), now: T + MIN, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict]), [["goal-wake", abnormal]]);
	assert.equal(plan.state, "acting");
});

test("a normal verdict defers the wake, allows one recheck while looks remain, then waits for livenessMs", () => {
	const f = idleFinding();
	const answered = looked(f, normal, { nextLookMs: T + 5 * MIN });
	assert.deepEqual(planFinding({ finding: f, record: answered, now: T + MIN, config: cfg }), { requests: [], state: "waiting-analyst" });
	const recheck = planFinding({ finding: f, record: answered, now: T + 5 * MIN, config: cfg });
	assert.deepEqual(recheck.requests.map((r) => [r.kind, r.step, r.why]), [["analyze", "look1", true]]);
	assert.equal(recheck.state, "analyzing");
	// perFinding looks were spent: no more rechecks, but livenessMs still wakes.
	const spent = looked(f, normal, { looks: cfg.analyst.perFinding, nextLookMs: T });
	assert.deepEqual(planFinding({ finding: f, record: spent, now: T + 10 * MIN, config: cfg }), { requests: [], state: "waiting-analyst" });
	assert.deepEqual(planFinding({ finding: f, record: spent, now: T + LIVENESS, config: cfg }).requests.map((r) => r.kind), ["goal-wake"]);
});

test("a normal verdict, then a recheck started 15 min after detection and still pending at 16 min -> no wake; the recheck still pending at 26 min -> wake without verdict; any state at livenessMs -> wake", () => {
	const f = idleFinding();
	// Detection at T, the normal answer at T+10m, the recheck started at T+15m.
	const recheck = looked(f, normal, { looks: 2, nextLookMs: T + 25 * MIN, analyst: { step: "look1", startedMs: T + 15 * MIN, candidates: WHY_CANDIDATES } });
	assert.deepEqual(planFinding({ finding: f, record: recheck, now: T + 16 * MIN, config: cfg }), { requests: [], state: "analyzing" }, "1 min pending is inside the hold");
	assert.deepEqual(planFinding({ finding: f, record: recheck, now: T + 26 * MIN, config: cfg }).requests.map((r) => [r.kind, r.verdict]), [["goal-wake", undefined]], "11 min pending reaches the hold");
	// Any state at livenessMs: a recheck pending only 1 min, an undecided look, and a decided normal.
	const freshRecheck = { ...recheck, analyst: { ...recheck.analyst, step: "look2", startedMs: T + LIVENESS - MIN } };
	assert.deepEqual(planFinding({ finding: f, record: freshRecheck, now: T + LIVENESS, config: cfg }).requests.map((r) => r.kind), ["goal-wake"]);
	const undecided = recordFor(f, { looks: 1, analyst: { step: "look0", startedMs: T + LIVENESS - MIN, candidates: WHY_CANDIDATES } });
	assert.deepEqual(planFinding({ finding: f, record: undecided, now: T + LIVENESS, config: cfg }).requests.map((r) => r.kind), ["goal-wake"]);
	const normalWaiting = looked(f, normal, { looks: cfg.analyst.perFinding, nextLookMs: T + LIVENESS + MIN });
	assert.deepEqual(planFinding({ finding: f, record: normalWaiting, now: T + LIVENESS, config: cfg }).requests.map((r) => r.kind), ["goal-wake"]);
});

test("a delivered wake without the verdict owes one why-notice when a later look answers non-normal", () => {
	const f = idleFinding();
	const later = looked(f, abnormal, { remedyDone: true });
	const plan = planFinding({ finding: f, record: later, now: T + MIN, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.verdict]), [["why-notice", 0, abnormal]]);
	assert.equal(plan.state, "noticed");
	assert.deepEqual(planFinding({ finding: f, record: { ...later, whyNoticed: true }, now: T + 2 * MIN, config: cfg }), { requests: [], state: "remedied" });
	assert.deepEqual(planFinding({ finding: f, record: recordFor(f, { remedyDone: true }), now: T + MIN, config: cfg }), { requests: [], state: "remedied" }, "no answer, nothing");
	assert.deepEqual(planFinding({ finding: f, record: looked(f, normal, { remedyDone: true }), now: T + MIN, config: cfg }), { requests: [], state: "remedied" }, "a normal answer notices nobody");
});

test("the idle wake never offers a process action", () => {
	const f = idleFinding();
	const plans = [
		planFinding({ finding: f, record: recordFor(f), now: T, config: cfg }),
		planFinding({ finding: f, record: looked(f, abnormal), now: T, config: cfg }),
		planFinding({ finding: f, record: looked(f, normal, { nextLookMs: T }), now: T, config: cfg }),
	];
	for (const plan of plans) {
		assert.deepEqual(plan.requests.map((r) => r.kind).filter((kind) => kind !== "goal-wake" && kind !== "analyze" && kind !== "why-notice"), []);
		for (const req of plan.requests) assert.equal([...req.candidates ?? []].some((candidate) => ["release-shell", "kill-pids", "kill-respawner"].includes(candidate.id)), false);
	}
});

test("an alignment nudge asks the analyst why before the scope check", () => {
	const f = driftFinding();
	const plan = planFinding({ finding: f, record: recordFor(f), now: T, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.why, r.candidates]), [["analyze", "look0", true, WHY_CANDIDATES]]);
	assert.equal(plan.state, "analyzing");
	// A look time in the future waits.
	const later = recordFor(f, { nextLookMs: T + 15 * MIN });
	assert.deepEqual(planFinding({ finding: f, record: later, now: T + MIN, config: cfg }), { requests: [], state: "waiting-analyst" });
	assert.deepEqual(planFinding({ finding: f, record: later, now: T + 15 * MIN, config: cfg }).requests.map((r) => r.kind), ["analyze"]);
});

test("the alignment rule's own nudge stays when the analyst is off or a verdict is not required", () => {
	const f = driftFinding();
	const off = { ...cfg, analyst: { ...cfg.analyst, enabled: false } };
	assert.deepEqual(planFinding({ finding: f, record: recordFor(f), now: T, config: off }).requests.map((r) => [r.kind, r.step]), [["scope-check", 0]]);
	const free = { ...cfg, align: { ...cfg.align, requireVerdict: false } };
	assert.deepEqual(planFinding({ finding: f, record: recordFor(f), now: T, config: free }).requests.map((r) => [r.kind, r.step]), [["scope-check", 0]]);
});

test("a pending alignment look waits; a normal verdict produces no scope check", () => {
	const f = driftFinding();
	const running = recordFor(f, { looks: 1, nextLookMs: T, analyst: { step: "look0", startedMs: T, candidates: WHY_CANDIDATES } });
	assert.deepEqual(planFinding({ finding: f, record: running, now: T + MIN, config: cfg }), { requests: [], state: "analyzing" });
	const normalAnswer = looked(f, normal);
	assert.deepEqual(planFinding({ finding: f, record: normalAnswer, now: T + MIN, config: cfg }), { requests: [], state: "drift-normal" });
});

test("an alignment look that cannot answer keeps the rule's nudge; a non-normal verdict travels with it", () => {
	const f = driftFinding();
	const failed = planFinding({ finding: f, record: looked(f, noAnswer), now: T + MIN, config: cfg });
	assert.deepEqual(failed.requests.map((r) => [r.kind, r.verdict]), [["scope-check", undefined]]);
	assert.equal(failed.state, "acting");
	const answered = planFinding({ finding: f, record: looked(f, abnormal), now: T + MIN, config: cfg });
	assert.deepEqual(answered.requests.map((r) => [r.kind, r.verdict]), [["scope-check", abnormal]]);
});

test("a delivered nudge is not repeated; an undelivered one retries after nextNudgeMs", () => {
	const f = driftFinding();
	assert.deepEqual(planFinding({ finding: f, record: recordFor(f, { remedyDone: true }), now: T + MIN, config: cfg }), { requests: [], state: "remedied" });
	const retrying = recordFor(f, { nextNudgeMs: T + 5 * MIN });
	assert.deepEqual(planFinding({ finding: f, record: retrying, now: T + MIN, config: cfg }), { requests: [], state: "waiting-analyst" });
	const due = planFinding({ finding: f, record: retrying, now: T + 5 * MIN, config: cfg });
	assert.deepEqual(due.requests.map((r) => r.kind), ["analyze"], "the look resumes after the retry time");
});

test("gate: boot-notice runs on a main session and follows actions.relay", () => {
	const req = { key: "boot-notice:x:0", kind: "boot-notice" };
	const options = { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "main-1" }, subjectKind: "main" };
	assert.equal(gate(req, options), "execute");
	assert.equal(gate(req, { ...options, config: { ...cfg, actions: { ...cfg.actions, relay: false } } }), "skipped:switch-off");
	assert.equal(gate(req, { ...options, mode: "shadow" }), "would");
});
