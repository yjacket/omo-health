import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { analystCandidates, couldNotAnswer, gate, mayActIrreversibly, needsWhy, newRecord, planFinding, planReport, planWhy, REPORT_CANDIDATES, settle, skipsAnalyst, WHY_CANDIDATES } from "../src/judge/policy.mjs";
import { validateAnalyst } from "../src/judge/analyst.mjs";

const T = Date.parse("2026-09-23T15:37:04Z");
const MIN = 60_000;
const cfg = DEFAULT_CONFIG;

function stallFinding({ cls = "runaway-readonly", kind = "kill-pids", dueMs = T + 600_000, targets = [{ pid: 55000, ctime: "c", name: "grep.exe" }], sessionKind } = {}) {
	return makeFinding({
		detector: "D1",
		kind: "stall",
		subject: { sessionId: "c1", toolCallId: "t1" },
		cls,
		data: {
			classification: { cls, rule: { id: "R8", v: 2 }, confidence: 0.9, dueMs, action: kind ? { kind, targets } : null, evidence: [], data: {} },
			dueMs,
			match: { tree: [{ pid: 60168, ctime: "a", name: "bash.exe" }, { pid: 60180, ctime: "b", name: "head.exe" }], orphans: [{ pid: 55000, ctime: "c", name: "grep.exe" }] },
			call: { id: "t1", name: "bash", commandHead: "grep x" },
			ageMs: 600_000,
			...(sessionKind ? { sessionKind } : {}),
		},
	});
}

/** A quiet-hang / R11 suspicion: the analyst decides, never the clock. */
const suspicion = (extra = {}) => stallFinding({ cls: "unknown", kind: "analyze", dueMs: T + 600_000, ...extra });

/** The answer the analyst gives, validated the way the engine does. */
const answer = (f, fields) => validateAnalyst({ verdict: "stuck", cause: "blocked-input", evidence: ["the shell waits on a prompt"], confidence: 0.9, diagnosis: "npm waits on a prompt", mechanism: "npm ran without --yes under a non-interactive call, so it waits on a prompt nobody can answer", avoid: "rerun it with --yes, or set CI=1, so it never prompts", ...fields }, analystCandidates(f), cfg);

/** A decided analyst verdict as the policy reads it (C1/C10: mechanism and avoid travel with it). */
const decidedVerdict = ({ verdict = "escalate", assessment = "abnormal", cause = "unknown", advice, mechanism = "`grep -r` ran from the drive root, so it walks the whole disk and never finishes within the call", avoid = "run it inside the subdirectory you meant, or add --include to bound it", ...rest } = {}) => ({ tier: 2, verdict, assessment, confidence: 0.9, cause, evidence: ["bundle fact"], diagnosis: "d", mechanism, avoid, ...(advice ? { advice } : {}), ...rest });
/** A verdict that is not an answer: the analyst was off, out of budget, held off or failed. */
const noAnswer = (reason = "budget-exhausted") => ({ tier: 2, verdict: "escalate", reason, notReached: true });
const looked = (verdict, { nextLookMs = 0, ...rest } = {}) => Object.assign(newRecord("x", T), { looks: 1, nextLookMs, analyst: { step: "look0", candidates: analystCandidates(), verdict }, ...rest });
const withFp = (fp, record) => Object.assign(record, { fp });

test("nothing happens before the class due time", () => {
	const f = stallFinding();
	const plan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 599_000, config: cfg });
	assert.equal(plan.state, "waiting-due");
	assert.equal(plan.requests.length, 0);
});

test("the escalation ladder: kill-pids, verify, release-shell, relay-cancel, exhausted", () => {
	const f = stallFinding();
	const record = newRecord(f.fp, T);
	let now = T + 600_000;
	let plan = planFinding({ finding: f, record, now, config: cfg });
	assert.equal(plan.requests[0].kind, "kill-pids");
	assert.deepEqual(plan.requests[0].targets.map((t) => t.pid), [55000]);
	Object.assign(record, { step: 1, lastActionMs: now, lastActionKind: "kill-pids" });
	now += 60_000;
	assert.equal(planFinding({ finding: f, record, now, config: cfg }).state, "verifying");
	now += 31_000;
	plan = planFinding({ finding: f, record, now, config: cfg });
	assert.equal(plan.requests[0].kind, "release-shell");
	assert.deepEqual(plan.requests[0].targets.map((t) => t.pid).sort(), [55000, 60168, 60180]);
	Object.assign(record, { step: 2, lastActionMs: now, lastActionKind: "release-shell" });
	now += 91_000;
	assert.equal(planFinding({ finding: f, record, now, config: cfg }).requests[0].kind, "relay-cancel");
	Object.assign(record, { step: 3, lastActionMs: now, lastActionKind: "relay-cancel" });
	assert.equal(planFinding({ finding: f, record, now: now + 1, config: cfg }).state, "exhausted");
});

test("every process action on a child is quiet; the relay to the parent is not", () => {
	const f = stallFinding({ sessionKind: "child" });
	const record = newRecord(f.fp, T);
	const quietOf = (step, now) => planFinding({ finding: f, record: Object.assign(record, { step }), now, config: cfg }).requests[0];
	assert.deepEqual([quietOf(0, T + 600_000).kind, quietOf(0, T + 600_000).quiet], ["kill-pids", true]);
	// A child that was acted on owes its parent one explanation; once it was noticed the quiet rungs still run (C12/C13).
	Object.assign(record, { whyNoticed: true });
	assert.deepEqual([quietOf(1, T + 600_000).kind, quietOf(1, T + 600_000).quiet], ["release-shell", true]);
	const relayFinding = stallFinding({ cls: "inproc", kind: "relay-cancel", dueMs: T + 60_000, sessionKind: "child" });
	const relay = planFinding({ finding: relayFinding, record: Object.assign(newRecord(relayFinding.fp, T), { analyst: { step: "look0", why: true, verdict: decidedVerdict() } }), now: T + 600_000, config: cfg }).requests[0];
	assert.deepEqual([relay.kind, relay.quiet], ["relay-cancel", undefined]);
	const plain = planFinding({ finding: stallFinding(), record: newRecord(f.fp, T), now: T + 600_000, config: cfg }).requests[0];
	assert.equal(plain.quiet, undefined, "not a child: no quiet flag");
});

test("detach-server targets only the shell chain", () => {
	const f = stallFinding({ cls: "server-foreground", kind: "detach-server", dueMs: T + 120_000, targets: [{ pid: 25628, name: "bash.exe" }], sessionKind: "child" });
	f.data.classification.action.serverPids = [{ pid: 60496, name: "node.exe" }];
	const req = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 120_000, config: cfg }).requests[0];
	assert.equal(req.kind, "detach-server");
	assert.equal(req.quiet, true);
	assert.deepEqual(req.targets.map((t) => t.pid), [25628]);
	assert.deepEqual(req.serverPids.map((t) => t.pid), [60496]);
});

test("a stall suspicion asks the analyst at its due time and never releases on the clock", () => {
	const f = suspicion();
	assert.deepEqual(planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 599_000, config: cfg }), { requests: [], state: "waiting-due" });
	const plan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 600_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.key]), [["analyze", `analyze:${f.fp}:look0`]]);
	assert.deepEqual(plan.requests[0].candidates.map((c) => c.id), ["wait", "release-shell", "escalate"]);
	assert.equal(plan.state, "analyzing");
	const running = Object.assign(newRecord(f.fp, T), { looks: 1, analyst: { step: "look0", jobId: "job-1", candidates: analystCandidates() } });
	assert.deepEqual(planFinding({ finding: f, record: running, now: T + 24 * 3600_000, config: cfg }), { requests: [], state: "analyzing" }, "a running look waits for its answer, however long");
});

test("the analyst's stuck verdict releases the shell (quiet on a child, with the triage); after the release the parent gets its one explanation instead of the relay", () => {
	const f = suspicion({ sessionKind: "child" });
	const record = withFp(f.fp, looked(answer(f, { respawn_text: "Pass --yes to npm." })));
	let plan = planFinding({ finding: f, record, now: T + 610_000, config: cfg });
	const [req] = plan.requests;
	assert.deepEqual([req.kind, req.quiet, plan.state], ["release-shell", true, "acting"]);
	assert.deepEqual(req.targets.map((t) => t.pid).sort(), [55000, 60168, 60180]);
	assert.deepEqual([req.triage.tier, req.triage.cause, req.triage.evidence.length], [2, "blocked-input", 1]);
	Object.assign(record, { step: 1, lastActionMs: T + 610_000, lastActionKind: "release-shell" });
	assert.equal(planFinding({ finding: f, record, now: T + 620_000, config: cfg }).state, "verifying");
	// C13: the released child owes the parent its one explanation; that notice is what the ladder would have relayed.
	plan = planFinding({ finding: f, record, now: T + 610_000 + cfg.stall.verifyResultMs, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict.assessment]), [["why-notice", "abnormal"]]);
	assert.equal(plan.state, "noticed");
	Object.assign(record, { whyNoticed: true });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 800_000, config: cfg }), { requests: [], state: "noticed" }, "the one message was the notice: nothing is relayed again");
});

test("an act the analyst is not sure enough about releases nothing: it becomes an escalation without advice that looks again later", () => {
	const f = suspicion();
	const unsure = answer(f, { confidence: 0.5 });
	assert.deepEqual([unsure.verdict, unsure.belowFloor], ["escalate", true], "validateAnalyst itself refuses an unsure stuck");
	// An act that reaches the policy without meeting mayActIrreversibly is vetoed there.
	const act = { tier: 2, verdict: "act", actionId: "release-shell", assessment: "abnormal", confidence: 0.9, evidence: ["e"] };
	const refused = [{ ...act, confidence: 0.7 }, { ...act, assessment: "suspicious" }, { ...act, evidence: [] }];
	for (const verdict of refused) {
		assert.equal(mayActIrreversibly(verdict, cfg), false);
		const record = withFp(f.fp, looked(verdict, { nextLookMs: T + 20 * MIN }));
		assert.deepEqual(settle({ record, config: cfg }), { kind: "decided", verdict: { ...verdict, verdict: "escalate", vetoed: "release-shell", actionId: null } });
		assert.deepEqual(planFinding({ finding: f, record, now: T + 610_000, config: cfg }), { requests: [], state: "escalated" });
	}
	assert.equal(mayActIrreversibly(act, cfg), true);
	const record = withFp(f.fp, looked(unsure, { nextLookMs: T + 20 * MIN }));
	assert.deepEqual(planFinding({ finding: f, record, now: T + 610_000, config: cfg }), { requests: [], state: "escalated" });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 20 * MIN, config: cfg }).requests.map((r) => r.key), [`analyze:${f.fp}:look1`], "the next look starts at nextLookMs");
});

test("progressing waits until its recheck time, then looks again; unrecoverable tells the parent once, never quietly", () => {
	const f = suspicion({ sessionKind: "child" });
	const wait = answer(f, { verdict: "progressing", cause: "external-wait" });
	assert.equal(wait.verdict, "wait");
	const waiting = withFp(f.fp, looked(wait, { nextLookMs: T + 25 * MIN }));
	assert.deepEqual(planFinding({ finding: f, record: waiting, now: T + 24 * MIN, config: cfg }), { requests: [], state: "waiting-analyst" });
	assert.deepEqual(planFinding({ finding: f, record: waiting, now: T + 25 * MIN, config: cfg }).requests.map((r) => r.key), [`analyze:${f.fp}:look1`]);

	const lost = answer(f, { verdict: "unrecoverable", cause: "wrong-command", respawn_text: "Run the build with npm run build, not npm start." });
	const record = withFp(f.fp, looked(lost, { nextLookMs: T + 25 * MIN }));
	const plan = planFinding({ finding: f, record, now: T + 610_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.quiet, r.triage.advice]), [["relay-cancel", undefined, "Run the build with npm run build, not npm start."]]);
});

test("an analyst that cannot answer holds: no release, a state that says why, a retry at nextLookMs", () => {
	const f = suspicion();
	const cannot = [
		["a failed run", { tier: 2, verdict: "escalate", reason: "timeout", failed: true }, "analyst-failed"],
		["an unusable answer", validateAnalyst(null, [], cfg), "analyst-failed"],
		["a job that never started", { tier: 2, verdict: "escalate", reason: "analyst-failing", notReached: true }, "analyst-failed"],
		["out of budget", { tier: 2, verdict: "escalate", reason: "budget-exhausted", notReached: true }, "analyst-budget-spent"],
		["shadow mode", { tier: 2, verdict: "escalate", reason: "would", notReached: true }, "would-analyze"],
	];
	for (const [name, verdict, state] of cannot) {
		assert.equal(couldNotAnswer(verdict), true, name);
		const record = withFp(f.fp, looked(verdict, { nextLookMs: T + 15 * MIN }));
		assert.deepEqual(planFinding({ finding: f, record, now: T + 7 * 24 * 3600_000 - 1, config: cfg }).requests.length, 1, `${name}: far past the due time the only request is another look`);
		assert.deepEqual(planFinding({ finding: f, record, now: T + 610_000, config: cfg }), { requests: [], state }, name);
		assert.deepEqual(planFinding({ finding: f, record, now: T + 15 * MIN, config: cfg }).requests.map((r) => [r.kind, r.key]), [["analyze", `analyze:${f.fp}:look1`]], name);
	}
});

test("gate: actionScope limits every action but toasts to the listed session trees", () => {
	const scoped = { ...cfg, actionScope: ["canary-parent"] };
	const kill = { key: "kill-pids:x:0", kind: "kill-pids" };
	assert.equal(gate(kill, { mode: "auto", paused: false, config: scoped, executed: new Set(), subject: { sessionId: "c1", parentSessionId: "canary-parent", rootSessionId: "canary-parent" } }), "execute");
	assert.equal(gate(kill, { mode: "auto", paused: false, config: scoped, executed: new Set(), subject: { sessionId: "other", rootSessionId: "user-root" } }), "skipped:out-of-scope");
	assert.equal(gate({ key: "analyze:x:look0", kind: "analyze" }, { mode: "auto", paused: false, config: scoped, executed: new Set(), subject: { sessionId: "other" } }), "skipped:out-of-scope");
	assert.equal(gate({ key: "toast:x:0", kind: "toast" }, { mode: "auto", paused: false, config: scoped, executed: new Set(), subject: {} }), "execute");
	assert.equal(gate(kill, { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "other" } }), "execute", "empty scope = everything");
});

test("gate: a main-session subject gets the analyst's look, and a process action only as release-shell on an analyst-proven wrong command", () => {
	for (const kind of ["kill-pids", "release-shell", "detach-server", "kill-respawner", "relay-cancel", "nudge", "abort-continue"]) {
		assert.equal(gate({ key: `${kind}:x:0`, kind }, { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "m" }, subjectKind: "main" }), "skipped:main-session", kind);
	}
	for (const kind of ["toast", "notify", "main-notice", "wake-parent", "revert-settings", "analyze"]) {
		assert.equal(gate({ key: `${kind}:x:0`, kind }, { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "m" }, subjectKind: "main" }), "execute", kind);
	}
	assert.equal(gate({ key: "analyze:x:report", kind: "analyze", reportId: "r1" }, { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "m" }, subjectKind: "main" }), "execute", "someone asked for the report");

	// The release of a main call: wrong-command, confidence >= actConfidence, cited evidence, analyst on. Nothing else, whatever the user is doing.
	const main = { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "m" }, subjectKind: "main" };
	const proof = { cause: "wrong-command", confidence: cfg.analyst.actConfidence, evidence: ["wsl.exe under C:\\Windows\\System32\\bash.exe"] };
	const release = (triage) => gate({ key: "release-shell:x:0", kind: "release-shell", triage }, main);
	assert.equal(release(proof), "execute");
	assert.equal(release({ ...proof, confidence: cfg.analyst.actConfidence - 0.01 }), "skipped:main-session", "below the act confidence");
	assert.equal(release({ ...proof, evidence: [] }), "skipped:main-session", "no cited evidence");
	assert.equal(release({ ...proof, cause: "blocked-input" }), "skipped:main-session", "another cause");
	assert.equal(release(undefined), "skipped:main-session", "no analyst verdict at all");
	assert.equal(gate({ key: "release-shell:x:0", kind: "release-shell", triage: proof }, { ...main, config: { ...cfg, analyst: { ...cfg.analyst, enabled: false } } }), "skipped:main-session", "analyst off");
	assert.equal(gate({ key: "kill-pids:x:0", kind: "kill-pids", triage: proof }, main), "skipped:main-session", "the proof releases a shell, it kills nothing else");
	assert.equal(gate({ key: "abort-continue:x:0", kind: "abort-continue", triage: proof }, main), "skipped:main-session", "abort-continue stays blocked");
	assert.equal(gate({ key: "kill-pids:x:0", kind: "kill-pids" }, { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "c" }, subjectKind: "child" }), "execute");
});

test("gate honours shadow, pause, switches and idempotency", () => {
	const req = { key: "kill-pids:x:0", kind: "kill-pids" };
	assert.equal(gate(req, { mode: "auto", paused: false, config: cfg, executed: new Set() }), "execute");
	assert.equal(gate(req, { mode: "shadow", paused: false, config: cfg, executed: new Set() }), "would");
	assert.equal(gate(req, { mode: "auto", paused: true, config: cfg, executed: new Set() }), "skipped:paused");
	assert.equal(gate(req, { mode: "auto", paused: false, config: { ...cfg, actions: { ...cfg.actions, kill: false } }, executed: new Set() }), "skipped:switch-off");
	assert.equal(gate(req, { mode: "auto", paused: false, config: cfg, executed: new Set([req.key]) }), "skipped:done");
	assert.equal(gate({ key: "t", kind: "toast" }, { mode: "shadow", paused: true, config: cfg, executed: new Set() }), "execute");
	assert.equal(gate({ key: "w", kind: "wake-parent" }, { mode: "auto", paused: false, config: { ...cfg, actions: { ...cfg.actions, wake: false } }, executed: new Set() }), "skipped:switch-off", "the documented wake switch covers parent wakes");
});

test("gate: a goal wake reaches a main session while actions.wake is on (C8)", () => {
	const req = { kind: "goal-wake", key: "goal-liveness-probe" };
	const options = { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: {}, subjectKind: "main" };
	assert.equal(gate(req, options), "execute", "a main session may be woken by the goal-liveness detector");
	assert.equal(gate(req, { ...options, mode: "shadow" }), "would");
	assert.equal(gate(req, { ...options, paused: true }), "skipped:paused");
	assert.equal(gate(req, { ...options, config: { ...cfg, actions: { ...cfg.actions, wake: false } } }), "skipped:switch-off", "the documented wake switch covers the goal wake");
	assert.equal(gate(req, { ...options, executed: new Set([req.key]) }), "skipped:done");
	assert.equal(gate(req, { ...options, subjectKind: "child" }), "execute", "a child goal wake is not blocked either");
});

test("gate: an analyze look follows analyst.enabled, pause and shadow, not the action switches", () => {
	const req = { key: "analyze:x:look0", kind: "analyze" };
	const options = { mode: "auto", paused: false, config: cfg, executed: new Set() };
	assert.equal(gate(req, options), "execute");
	assert.equal(gate(req, { ...options, mode: "shadow" }), "would");
	assert.equal(gate(req, { ...options, paused: true }), "skipped:paused");
	assert.equal(gate(req, { ...options, config: { ...cfg, analyst: { ...cfg.analyst, enabled: false } } }), "skipped:switch-off");
	assert.equal(gate(req, { ...options, config: { ...cfg, actions: { ...cfg.actions, kill: false, release: false } } }), "execute");
});

test("D15 asks the analyst first; the scope check runs on main sessions and is only projected in shadow", () => {
	const f = makeFinding({ detector: "D15", kind: "drift", subject: { sessionId: "m" }, data: { remedy: { kind: "scope-check" } } });
	const look = planFinding({ finding: f, record: newRecord(f.fp, T), now: T, config: cfg }).requests[0];
	assert.equal(look.kind, "analyze", "with the analyst on, the nudge waits for a why look (IS-7)");
	const req = { key: `scope-check:${f.fp}:0`, kind: "scope-check", fp: f.fp, step: 0, remedy: { kind: "scope-check" } };
	const options = { paused: false, config: cfg, executed: new Set(), subject: f.subject, subjectKind: "main" };
	assert.equal(gate(req, { ...options, mode: "auto" }), "execute");
	assert.equal(gate(req, { ...options, mode: "shadow" }), "would");
});

test("remedies and human-needed toasts become requests", () => {
	const f = makeFinding({ detector: "D8", kind: "dead-child", subject: { sessionId: "c" }, humanNeeded: true, data: { remedy: { kind: "wake-parent" } } });
	const kinds = planFinding({ finding: f, record: newRecord(f.fp, T), now: T, config: cfg }).requests.map((r) => r.kind);
	assert.deepEqual(kinds, ["wake-parent", "toast", "analyze"], "the remedy and the toast come first, then the one why look (IS-1)");
});

test("a report gets one analyst look, then one notice: never a process action", () => {
	const finding = makeFinding({ detector: "report", kind: "report", subject: { sessionId: "c1" }, data: { report: { id: "r1" } } });
	const fresh = () => Object.assign(newRecord(finding.fp, T), { finding, snapshotFile: "snap.json" });
	let plan = planReport({ record: fresh(), config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.key, r.reportId, r.snapshotFile]), [["analyze", `analyze:${finding.fp}:report`, "r1", "snap.json"]]);
	assert.deepEqual(plan.requests[0].candidates, [...REPORT_CANDIDATES], "a report can only wait or escalate");
	assert.deepEqual(planReport({ record: Object.assign(fresh(), { analyst: { step: "report", jobId: "job-1" } }), config: cfg }), { requests: [], state: "analyzing" });
	const verdict = validateAnalyst({ verdict: "progressing", cause: "external-wait", evidence: ["e"], confidence: 0.8, diagnosis: "it still works" }, REPORT_CANDIDATES, cfg);
	plan = planReport({ record: Object.assign(fresh(), { analyst: { step: "report", verdict } }), config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict.verdict]), [["triage-notice", "wait"]]);
	// Analyst off: the notice goes out without a verdict.
	plan = planReport({ record: fresh(), config: { ...cfg, analyst: { ...cfg.analyst, enabled: false } } });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.verdict]), [["triage-notice", undefined]]);
});

test("the analyst's words are redacted before they are cut to the limit, so a cut token cannot slip under the pattern (#82)", () => {
	// Cut at the limit (max - 1 characters plus an ellipsis), only "sk-ant-ZZ" of the token would remain: too short to match.
	const leak = (max) => `${"a".repeat(max - 10)}sk-ant-${"Z".repeat(40)}`;
	const verdict = validateAnalyst({ verdict: "unrecoverable", cause: "unknown", evidence: [leak(300)], confidence: 0.9, diagnosis: leak(600), respawn_text: leak(300), mechanism: leak(600), avoid: "do the other thing entirely" }, [], cfg);
	for (const text of [verdict.diagnosis, verdict.advice, verdict.evidence[0]]) assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9]/);
});

// -- plan todo 2: why routing (C3, C5, C9, C10, C12, C13, C15, C16, C17, C18) --

const whyFinding = (detector, kind, data = {}, extra = {}) => makeFinding({ detector, kind, subject: { sessionId: "c1", key: `${detector}:${kind}` }, data, ...extra });

test("every footer problem whose cause is not obvious asks the analyst why, with the why candidates only", () => {
	const cases = [
		["D8", "dead-child", { remedy: { kind: "wake-parent" } }, ["wake-parent", "analyze"]],
		["D8", "child-error-unhandled", { remedy: { kind: "wake-parent" } }, ["wake-parent", "analyze"]],
		["D8", "hung-main-turn", { remedy: { kind: "abort-continue" } }, ["abort-continue", "analyze"]],
		["D5", "hung-turn-child", {}, ["analyze"]],
		["D5", "tps-collapse", {}, ["analyze"]],
		["D10", "same-call-loop", { tool: "bash", argsHash: "ab12" }, ["analyze"]],
		["D10", "error-storm", { errorHead: "TypeError: x is not a function" }, ["analyze"]],
		["D2", "process-runaway", { pid: 55000, name: "python.exe" }, ["analyze"]],
	];
	for (const [detector, kind, data, kinds] of cases) {
		const f = whyFinding(detector, kind, data);
		const plan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T, config: cfg });
		assert.deepEqual(plan.requests.map((r) => r.kind), kinds, `${detector}:${kind}: the remedy stays first`);
		const ask = plan.requests.at(-1);
		assert.deepEqual([ask.why, ask.step, ask.candidates], [true, "look0", WHY_CANDIDATES], `${detector}:${kind}: a why look`);
		assert.equal(plan.state, "remedy");
	}
});

test("the skip list: an obvious cause (limits, quota, auth, provider side, D8 stopped-on-errors) is never analysed", () => {
	const skipped = [
		["D10", "error-storm", { errorHead: "You've hit your session limit · resets 5am (rate_limit)" }, "provider-limit"],
		["D10", "error-storm", { errorHead: "429 Too many requests" }, "provider-limit"],
		["D8", "stopped-on-errors", {}, "provider-errors"],
		["D8", "dead-child", { errorText: "429 Too many requests" }, "provider-limit"],
		["D8", "child-error-unhandled", { errorText: "401 token revoked" }, "provider-limit"],
		["D8", "child-error-unhandled", { errorText: "provider is not configured: minimax" }, "provider-limit"],
		["D5", "tps-collapse", { providerSide: true }, "provider-side"],
	];
	for (const [detector, kind, data, reason] of skipped) {
		const f = whyFinding(detector, kind, data);
		assert.equal(skipsAnalyst(f), reason, `${detector}:${kind}`);
		assert.deepEqual(planFinding({ finding: f, record: newRecord(f.fp, T), now: T, config: cfg }).requests.map((r) => r.kind).filter((r) => r === "analyze"), [], `${detector}:${kind}: no analyst look`);
	}
	const revoked = whyFinding("D8", "child-error-unhandled", { remedy: { kind: "wake-parent" }, errorText: "401 token revoked" });
	assert.deepEqual(planFinding({ finding: revoked, record: newRecord(revoked.fp, T), now: T, config: cfg }).requests.map((r) => r.kind), ["wake-parent"], "the wake still goes out");
	const plain = whyFinding("D8", "child-error-unhandled", { errorText: "child exited with code 1" });
	assert.equal(skipsAnalyst(plain), undefined, "a plain error text is not obvious");
	assert.equal(needsWhy(plain, newRecord(plain.fp, T)), true);
	const d6 = whyFinding("D6", "accounts-blocked", {});
	assert.deepEqual(planFinding({ finding: d6, record: newRecord(d6.fp, T), now: T, config: cfg }), { requests: [], state: "observe" }, "D6 is not a why kind");
});

test("a decided why verdict plans one why-notice, and nothing once it was noticed (C12)", () => {
	const f = whyFinding("D10", "error-storm", { errorHead: "boom" });
	const verdict = decidedVerdict({ verdict: "escalate", assessment: "suspicious", reason: "belowFloor" });
	const record = Object.assign(newRecord(f.fp, T), { looks: 1, analyst: { step: "look0", why: true, verdict } });
	const plan = planFinding({ finding: f, record, now: T + 60_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.verdict]), [["why-notice", 0, verdict]]);
	assert.equal(plan.state, "remedy");
	assert.deepEqual(planFinding({ finding: f, record: Object.assign(record, { whyNoticed: true }), now: T + 120_000, config: cfg }), { requests: [], state: "observe" }, "one message per finding fp");
});

test("progressing notices nobody and looks again at nextLookMs; a gone finding is not looked at again", () => {
	const f = whyFinding("D5", "hung-turn-child", {});
	const wait = decidedVerdict({ verdict: "wait", assessment: "normal" });
	const record = Object.assign(newRecord(f.fp, T), { looks: 1, nextLookMs: T + 30 * MIN, analyst: { step: "look0", why: true, verdict: wait } });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 60_000, config: cfg }), { requests: [], state: "observe" });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 30 * MIN, config: cfg }).requests.map((r) => [r.kind, r.why]), [["analyze", true]]);
	const requests = [];
	assert.equal(planWhy({ finding: f, record, gone: true, now: T + 30 * MIN, config: cfg, requests }), "observe");
	assert.deepEqual(requests, [], "a gone finding is not looked at again");
});

test("an analyst that cannot answer is retried at nextLookMs and never notices anyone", () => {
	const f = whyFinding("D2", "process-runaway", { pid: 1, name: "python.exe" });
	const record = Object.assign(newRecord(f.fp, T), { looks: 1, nextLookMs: T + 15 * MIN, analyst: { step: "look0", why: true, verdict: noAnswer() } });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 60_000, config: cfg }), { requests: [], state: "observe" });
	assert.deepEqual(planFinding({ finding: f, record, now: T + 15 * MIN, config: cfg }).requests.map((r) => [r.kind, r.why]), [["analyze", true]]);
});

test("a child's relay rung asks the why look first, then carries its mechanism and avoid (C10, C15)", () => {
	const f = stallFinding({ cls: "inproc", kind: "relay-cancel", dueMs: T + 60_000, sessionKind: "child" });
	let plan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 60_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.why, r.candidates]), [["analyze", true, WHY_CANDIDATES]], "the why look runs first");
	const running = Object.assign(newRecord(f.fp, T), { looks: 1, analyst: { step: "look0", why: true, jobId: "job-1" } });
	assert.deepEqual(planFinding({ finding: f, record: running, now: T + 610_000, config: cfg }), { requests: [], state: "analyzing" }, "a job in flight holds the relay");
	const verdict = decidedVerdict({ mechanism: "the tool call is in-process and its sibling already returned, so no result can arrive", avoid: "dispatch the work again with the fix the analyst named" });
	// The analyst's own answer travels with it, mechanism and avoid included (C1, C10).
	const lost = validateAnalyst({ verdict: "unrecoverable", cause: "unknown", evidence: ["no process behind the call"], confidence: 0.9, diagnosis: "cannot continue", mechanism: "the shell died before the call wrote its result, so the call can never return", avoid: "re-dispatch the step with the build flag the analyst named", respawn_text: "Re-dispatch with --build." }, analystCandidates(f), cfg);
	const relayed = planFinding({ finding: f, record: withFp(f.fp, looked(lost)), now: T + 610_000, config: cfg }).requests[0];
	assert.deepEqual([relayed.kind, relayed.triage.mechanism, relayed.triage.avoid], ["relay-cancel", lost.mechanism, lost.avoid]);
	const answered = Object.assign(newRecord(f.fp, T), { looks: 1, analyst: { step: "look0", why: true, verdict } });
	plan = planFinding({ finding: f, record: answered, now: T + 610_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["relay-cancel"]);
	assert.deepEqual([plan.requests[0].triage.mechanism, plan.requests[0].triage.avoid], [verdict.mechanism, verdict.avoid]);
	const cannot = Object.assign(newRecord(f.fp, T), { looks: 1, nextLookMs: T + 20 * MIN, analyst: { step: "look0", why: true, verdict: noAnswer() } });
	assert.deepEqual(planFinding({ finding: f, record: cannot, now: T + 610_000, config: cfg }).requests.map((r) => [r.kind, r.triage]), [["relay-cancel", undefined]], "an analyst that could not answer relays as today");
	const off = { ...cfg, analyst: { ...cfg.analyst, enabled: false } };
	assert.deepEqual(planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 60_000, config: off }).requests.map((r) => r.kind), ["relay-cancel"], "the analyst off: the relay is planned exactly as before");
});

test("a main D1 stall without a signal keeps its notify and lets the why look explain it (C15, C17)", () => {
	const f = suspicion({ sessionKind: "main" });
	const fresh = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 600_000, config: cfg });
	assert.deepEqual(fresh.requests.map((r) => r.kind), ["notify", "analyze"]);
	assert.deepEqual([fresh.requests[1].why, fresh.requests[1].candidates], [true, WHY_CANDIDATES]);
	assert.equal(fresh.requests.some((r) => r.kind === "release-shell"), false, "nothing is released without a proven wrong command");
	const verdict = decidedVerdict({ verdict: "escalate", assessment: "suspicious", reason: "belowFloor" });
	const record = withFp(f.fp, looked(verdict));
	assert.deepEqual(planFinding({ finding: f, record, now: T + 610_000, config: cfg }).requests.map((r) => r.kind), ["notify", "why-notice"]);
	const off = { ...cfg, analyst: { ...cfg.analyst, enabled: false } };
	const offPlan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 600_000, config: off });
	assert.deepEqual([offPlan.requests.map((r) => r.kind), offPlan.state], [["notify"], "observe-main"], "the analyst off: the notify and an open investigation, as before");
});

test("a main session's D1 rule rung is emitted unchanged and analysed anyway (C18)", () => {
	const f = stallFinding({ cls: "blocked-on-input", kind: "release-shell", dueMs: T + 120_000, sessionKind: "main" });
	let plan = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 120_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["release-shell", "analyze"], "the rung stays first, unchanged");
	assert.equal(plan.requests[1].why, true);
	const record = withFp(f.fp, looked(decidedVerdict({ verdict: "escalate", assessment: "suspicious", reason: "belowFloor" })));
	plan = planFinding({ finding: f, record, now: T + 610_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["release-shell", "why-notice"]);
	const options = { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: f.subject, subjectKind: "main" };
	assert.equal(gate(plan.requests[0], options), "skipped:main-session", "only an analyst proof of a wrong command may release a main call");
	assert.equal(gate(plan.requests[1], options), "execute", "the explanation may reach the main session");
});

test("a D1 child that was acted on holds its ladder for the why look (C13)", () => {
	const f = stallFinding({ cls: "blocked-on-input", kind: "release-shell", dueMs: T + 120_000, sessionKind: "child" });
	const after = (extra) => withFp(f.fp, Object.assign(newRecord(f.fp, T), { step: 1, lastActionMs: T + 120_000, lastActionKind: "release-shell" }, extra));
	const now = T + 120_000 + cfg.stall.verifyResultMs;
	let plan = planFinding({ finding: f, record: after(), now, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.why]), [["analyze", true]], "the rule release starts one why look, the ladder waits");
	assert.deepEqual(planFinding({ finding: f, record: after({ looks: 1, analyst: { step: "look0", why: true, jobId: "job-1" } }), now, config: cfg }), { requests: [], state: "analyzing" }, "a job in flight holds it");
	const verdict = decidedVerdict({ verdict: "escalate", assessment: "suspicious", reason: "belowFloor" });
	plan = planFinding({ finding: f, record: after({ looks: 1, analyst: { step: "look0", why: true, verdict } }), now, config: cfg });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["why-notice"]);
	assert.equal(plan.state, "noticed");
	assert.deepEqual(planFinding({ finding: f, record: after({ whyNoticed: true }), now, config: cfg }), { requests: [], state: "noticed" }, "the notice was the one message: no relay follows");
	const r6 = stallFinding({ cls: "server-foreground", kind: "detach-server", dueMs: T + 120_000, targets: [{ pid: 25628, name: "bash.exe" }], sessionKind: "child" });
	r6.data.classification.action.serverPids = [];
	const r6record = withFp(r6.fp, Object.assign(newRecord(r6.fp, T), { step: 1, lastActionMs: T + 120_000, lastActionKind: "detach-server" }));
	const r6now = T + 120_000 + cfg.stall.verifyResultMs;
	const off = { ...cfg, analyst: { ...cfg.analyst, enabled: false } };
	assert.deepEqual(planFinding({ finding: r6, record: r6record, now: r6now, config: off }).requests.map((r) => r.kind), ["release-shell"], "the analyst off: the ladder runs exactly as before");
	assert.deepEqual(planFinding({ finding: r6, record: r6record, now: r6now, config: cfg }).requests.map((r) => [r.kind, r.why]), [["analyze", true]], "the analyst on: the why look comes first");
});

test("a main R2b notify still explains itself after the notify rung advanced the record (C15, C18)", () => {
	const f = stallFinding({ cls: "unmatched", kind: "notify", dueMs: T + 60_000, sessionKind: "main" });
	const fresh = planFinding({ finding: f, record: newRecord(f.fp, T), now: T + 60_000, config: cfg });
	assert.deepEqual(fresh.requests.map((r) => [r.kind, r.why]), [["notify", undefined], ["analyze", true]], "the notify rung keeps its why look");
	const verdict = decidedVerdict({ verdict: "escalate", assessment: "abnormal" });
	const record = withFp(f.fp, Object.assign(newRecord(f.fp, T), { step: 1, looks: 1, analyst: { step: "look0", why: true, verdict } }));
	const plan = planFinding({ finding: f, record, now: T + 120_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => [r.kind, r.step, r.verdict]), [["why-notice", 0, verdict]], "the answered verdict is not lost to the exhausted ladder");
	assert.equal(plan.state, "noticed");
	assert.deepEqual(planFinding({ finding: f, record: Object.assign(record, { whyNoticed: true }), now: T + 180_000, config: cfg }), { requests: [], state: "exhausted" }, "one message per finding fp");
});

test("a why look that could not answer never holds a child's concrete-evidence ladder (C13)", () => {
	const f = stallFinding({ sessionKind: "child" });
	const killMs = T + 600_000;
	const after = (analyst, nextLookMs = killMs) => withFp(f.fp, Object.assign(newRecord(f.fp, T), { step: 1, lastActionMs: killMs, lastActionKind: "kill-pids", looks: 1, nextLookMs, analyst }));
	const now = killMs + cfg.stall.verifyResultMs;
	const continued = planFinding({ finding: f, record: after({ step: "look0", why: true, verdict: noAnswer() }), now, config: cfg });
	assert.deepEqual(continued.requests.map((r) => r.kind), ["analyze", "release-shell"], "the retry is requested and the release-shell rung still runs");
	assert.equal(continued.state, "acting");
	assert.deepEqual(continued.requests[1].targets.map((t) => t.pid).sort(), [55000, 60168, 60180]);
	const wait = decidedVerdict({ verdict: "wait", assessment: "normal" });
	const normal = planFinding({ finding: f, record: after({ step: "look0", why: true, verdict: wait }, killMs + 30 * MIN), now, config: cfg });
	assert.deepEqual(normal.requests.map((r) => r.kind), ["release-shell"], "an answered wait holds nothing either");
});

test("a D1 child's answered verdict that starts no ladder notices the parent once (C17)", () => {
	const f = suspicion({ sessionKind: "child" });
	const verdict = decidedVerdict({ verdict: "escalate", assessment: "suspicious", belowFloor: true, modelVerdict: "stuck" });
	const record = withFp(f.fp, looked(verdict, { nextLookMs: T + 20 * MIN }));
	let plan = planFinding({ finding: f, record, now: T + 610_000, config: cfg });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["why-notice"], "an answered verdict that releases nothing still explains itself");
	assert.equal(plan.state, "noticed");
	plan = planFinding({ finding: f, record: Object.assign(record, { whyNoticed: true }), now: T + 620_000, config: cfg });
	assert.deepEqual(plan.requests, [], "nothing more once noticed");
});

test("needsWhy: a why-kind finding and an acted-on D1 owe one explanation until it is noticed (C9)", () => {
	const storm = whyFinding("D10", "error-storm", { errorHead: "boom" });
	assert.equal(needsWhy(storm, newRecord(storm.fp, T)), true);
	assert.equal(needsWhy(storm, Object.assign(newRecord(storm.fp, T), { whyNoticed: true })), false);
	const limited = whyFinding("D10", "error-storm", { errorHead: "429 Too many requests" });
	assert.equal(needsWhy(limited, newRecord(limited.fp, T)), false, "an obvious cause is never looked at");
	const d6 = whyFinding("D6", "accounts-blocked", {});
	assert.equal(needsWhy(d6, newRecord(d6.fp, T)), false);
	const stall = suspicion();
	assert.equal(needsWhy(stall, newRecord(stall.fp, T)), false, "a fresh suspicion owes nothing yet");
	assert.equal(needsWhy(stall, Object.assign(newRecord(stall.fp, T), { step: 1 })), true);
	assert.equal(needsWhy(stall, Object.assign(newRecord(stall.fp, T), { looks: 1 })), true);
});

test("gate: a why-notice is a relay - the switch, pause and shadow apply, and a main session may receive it", () => {
	const req = { key: "why-notice:x:0", kind: "why-notice" };
	const options = { mode: "auto", paused: false, config: cfg, executed: new Set(), subject: { sessionId: "m" }, subjectKind: "main" };
	assert.equal(gate(req, options), "execute");
	assert.equal(gate(req, { ...options, mode: "shadow" }), "would");
	assert.equal(gate(req, { ...options, paused: true }), "skipped:paused");
	assert.equal(gate(req, { ...options, config: { ...cfg, actions: { ...cfg.actions, relay: false } } }), "skipped:switch-off");
	assert.equal(gate(req, { ...options, executed: new Set([req.key]) }), "skipped:done");
});
