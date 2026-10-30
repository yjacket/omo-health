import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { detect, isInformationAsk, latestRequest } from "../src/detect/align.mjs";
import { sha1 } from "../src/util/text.mjs";
import { cyclingSteps, makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-28T12:00:00Z");
const MIN = 60_000;
// Letters, not digits: summaries that differ only in numbers are the same step.
const alpha = (i) => String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));
const step = (minAgo, kind, text) => ({ ms: T - minAgo * MIN, tool: kind === "eval" ? "eval" : kind === "task" ? "task" : "todo", kind, text });
function setup() {
	const session = { id: "s1", kind: "main", firstUserText: "Investigate this", lastUser: { ms: T - 100_000, textHead: "Investigate this" },
		activity: { sinceMs: T - 100_000, mutations: 0, toolCalls: 0, files: new Map(), failingChecks: new Map(), taskSpawns: [] },
		anchor: { objective: "Investigate this", status: "active" }, healthMessages: [], writes: [] };
	const world = { now: T, config: DEFAULT_CONFIG, sessions: new Map([[session.id, session]]), isSessionLive: () => true };
	return { world, session, memory: {} };
}
test("churn requires separate edit rounds with failures between; F5 batch is not churn", () => {
	const { world, session, memory } = setup();
	session.activity.files.set("a", { edits: 13, rounds: 1, failsBetween: 0, firstMs: T - 30_000, lastMs: T - 30_000 });
	assert.deepEqual(detect(world, memory), []);
	session.activity.files.set("a", { edits: 8, rounds: 8, failsBetween: 1, firstMs: T - 30_000, lastMs: T });
	assert.deepEqual(detect(world, memory), []);
	session.activity.files.get("a").failsBetween = 2;
	assert.equal(detect(world, memory)[0].cls, "churn");
});
test("repeated failing check and review spawns independently indicate churn", () => {
	const { world, session } = setup();
	session.activity.failingChecks.set("npm test", 7);
	assert.deepEqual(detect(world, {}), []);
	session.activity.failingChecks.set("npm test", 8);
	assert.equal(detect(world, {})[0].data.metric, 8);
	session.activity.failingChecks.clear();
	session.activity.taskSpawns = ["review", "verify", "audit", "재작성"].map((summary) => ({ summary }));
	assert.equal(detect(world, {})[0].cls, "churn");
});
test("overstep only after an information ask followed by mutation", () => {
	const { world, session } = setup();
	assert.equal(isInformationAsk("왜 이러나요"), true);
	assert.equal(isInformationAsk("Why? Fix it"), false);
	session.lastUser.textHead = "왜 이러나요";
	assert.deepEqual(detect(world, {}), []);
	session.activity.mutations = 1;
	assert.equal(detect(world, {})[0].cls, "overstep");
	session.lastUser.textHead = "왜 이러나요 수정해줘";
	assert.deepEqual(detect(world, {}), []);
});
test("after-complete requires mutations newer than completion", () => {
	const { world, session } = setup();
	session.anchor = { objective: "Done", status: "complete", updatedAtMs: T - 10_000 };
	session.activity.mutations = 12;
	assert.deepEqual(detect(world, {}), [], "older mutations are not evidence after completion");
	session.writes = Array.from({ length: 9 }, (_, id) => ({ ms: T - 1_000, id: `write-${id}` }));
	session.commands = [{ id: "shell-1", ms: T - 1_000, tool: "bash", text: "mkdir tmp" }, { id: "shell-2", ms: T - 1_000, tool: "bash", text: "echo hello" }];
	assert.equal(detect(world, {})[0].cls, "after-complete");
	session.lastUser.ms = T;
	assert.deepEqual(detect(world, {}), [], "a new request ends the post-completion period");
});
test("child delivery recorded by its parent survives a detector restart", () => {
	const { world, session } = setup();
	session.kind = "child";
	session.parentSessionId = "p1";
	session.lastUser.textHead = "Why?";
	session.activity.mutations = 1;
	world.sessions.set("p1", { id: "p1", healthMessages: [{ ms: T, details: { kind: "scope-check", subjectSessionId: "s1", key: `align:s1:overstep:${sha1("Why?").slice(0, 12)}` } }] });
	assert.deepEqual(detect(world, {}), []);
});

test("overstep fires once per owner request; growing mutations and transcript replay do not repeat it", () => {
	const { world, session, memory } = setup();
	session.lastUser.textHead = "Why?";
	session.activity.mutations = 1;
	const first = detect(world, memory)[0];
	assert.equal(first.subject.key, `align:s1:overstep:${sha1("Why?").slice(0, 12)}`);
	assert.equal(first.severity, "info");
	assert.deepEqual(first.data.remedy, { kind: "scope-check" });
	// The engine records a delivered nudge; the detector does not spend the budget by itself.
	memory.s1.push({ ms: world.now, key: first.subject.key });
	assert.deepEqual(detect(world, memory), []);
	session.activity.mutations = 2;
	assert.deepEqual(detect(world, memory), [], "metric growth on the same request is the same incident");
	session.lastUser.textHead = "Why is it red?";
	world.now += DEFAULT_CONFIG.align.minGapMs - 1;
	assert.deepEqual(detect(world, memory), [], "the minimum gap still applies between requests");
	world.now += 1;
	const secondKey = `align:s1:overstep:${sha1("Why is it red?").slice(0, 12)}`;
	assert.equal(detect(world, memory)[0].subject.key, secondKey, "a new request is a new incident");
	session.healthMessages.push({ ms: world.now, details: { kind: "scope-check", subjectSessionId: "s1", key: secondKey } });
	assert.deepEqual(detect(world, {}), [], "transcript suppresses the delivered request after restart");
});

test("question plus request is not an information ask; a pure question still is", () => {
	assert.equal(isInformationAsk("패키지로 구성했나? 그 다음에 커밋하고 푸시해"), false, "imperative plus action words");
	assert.equal(isInformationAsk("mass-ulw를 $ 붙여서 써야 하는거 아닌가?"), false, "suggestion form");
	assert.equal(isInformationAsk("왜 이렇게 동작하나?"), true);
	const { world, session } = setup();
	session.activity.mutations = 3;
	session.lastUser.textHead = "패키지로 구성했나? 그 다음에 커밋하고 푸시해";
	assert.deepEqual(detect(world, {}), [], "the owner asked for the work");
	session.lastUser.textHead = "왜 이렇게 동작하나?";
	assert.equal(detect(world, {})[0].cls, "overstep", "a pure question with mutations still nudges");
});

test("a narrative ending in ~더라 is read as a request, which can only suppress a nudge", () => {
	assert.equal(isInformationAsk("이거 왜 이래? 어제는 잘 되더라"), false);
});

test("failures of one check count only inside the churn window", () => {
	const { world, session } = setup();
	const spread = Array.from({ length: 8 }, (_, i) => world.now - i * 25 * 60_000); // 8 failures over ~3 h
	session.activity.failingChecks.set("npm test", 8);
	session.activity.failTimes = new Map([["npm test", spread]]);
	assert.deepEqual(detect(world, {}), []);
	const burst = Array.from({ length: 8 }, (_, i) => world.now - i * 2 * 60_000); // 8 failures in 14 min
	session.activity.failTimes = new Map([["npm test", burst]]);
	assert.equal(detect(world, {})[0].data.metric, 8);
});

test("the nudge quotes the last user turn that has text, not an empty goal continuation", () => {
	const session = { userTurns: [{ ms: 1, text: "이슈를 등록해줘" }, { ms: 2, text: "" }, { ms: 3, text: "  " }], lastUser: { ms: 3, textHead: "" } };
	assert.equal(latestRequest(session), "이슈를 등록해줘");
	assert.equal(latestRequest({ userTurns: [], lastUser: { textHead: "only head" } }), "only head");
});

test("omo-health's own notes and shell syntax in code spans are not information asks", () => {
	const note = "omo-health: your command `echo \"rc=$? x\"; ls logs 2>&1` did not return for 21 min (unknown); its shell was terminated, so the tool call ended with an error. Find out what it waits on before retrying";
	assert.equal(isInformationAsk("run `echo $?` and report the exit"), false);
	assert.equal(isInformationAsk("what does `echo $?` print?"), true);
	const { world, session } = setup();
	session.userTurns = [{ text: "todo 29: run the sandboxed failure-path QA" }, { text: note }];
	session.lastUser.textHead = note;
	session.activity.mutations = 4;
	assert.equal(latestRequest(session), "todo 29: run the sandboxed failure-path QA");
	assert.deepEqual(detect(world, {}), []);
	session.userTurns = [];
	assert.equal(latestRequest(session), "");
	assert.deepEqual(detect(world, {}), []);
});

test("an overstep anchored on an auto-continuation turn is no finding; the anchor is the human turn before it", () => {
	const { world, session } = setup();
	const hb = { humanInputs: [T - 60_000 - 800] };
	world.sensorFor = (id) => (id === "s1" ? hb : undefined);
	session.activity.mutations = 3;
	session.userTurns = [{ ms: T - 60_000, text: "todo 13 구현해줘" }, { ms: T - 30_000, text: "Why did the build stop?" }];
	session.lastUser = { ms: T - 30_000, textHead: "Why did the build stop?" };
	assert.equal(latestRequest(session, hb.humanInputs), "todo 13 구현해줘", "the human turn, not the later auto turn");
	assert.deepEqual(detect(world, {}), [], "the question came from an extension, not the user");
	hb.humanInputs = [];
	assert.equal(latestRequest(session, hb.humanInputs), "");
	assert.deepEqual(detect(world, {}), [], "no human turn: no overstep");
});

test("a human information ask followed by an edit is still an overstep", () => {
	const { world, session } = setup();
	const hb = { humanInputs: [T - 60_000, T - 20_000 + 1500] };
	world.sensorFor = () => hb;
	session.activity.mutations = 1;
	session.userTurns = [{ ms: T - 60_000, text: "고쳐줘" }, { ms: T - 20_000, text: "왜 이러나요?" }, { ms: T - 10_000, text: "Continue working toward the active thread goal." }];
	const [finding] = detect(world, {});
	assert.equal(finding.cls, "overstep");
	assert.equal(finding.data.lastUserText, "왜 이러나요?");
});

test("mutations after an automatic continuation do not count against an earlier human question (#102)", () => {
	const { world, session } = setup();
	session.lastUser.textHead = "이거 30분마다 계속 이렇게 물어볼거야?";
	Object.assign(session.activity, { mutations: 2, mutationsBeforeAuto: 0 });
	assert.deepEqual(detect(world, {}), [], "the goal continuation drove the edits");
	session.activity.mutationsBeforeAuto = 1;
	assert.equal(detect(world, {})[0].data.metric, 1, "an edit before the continuation is still an overstep");
});

test("without humanInputs (an old sensor) turns starting with auto-continuation markers are skipped", () => {
	const { world, session } = setup();
	session.activity.mutations = 2;
	const human = { ms: T - 60_000, text: "README 갱신해줘" };
	for (const auto of ["Continue working toward the active thread goal", "<omo-senpi-task>why?</omo-senpi-task>", "[omo-desk] 답이 없습니다?", "task completion: what next?", "<system-reminder>why?", "[omo-health 범위 점검] 확인하세요?"]) {
		session.userTurns = [human, { ms: T - 1000, text: auto }];
		session.lastUser = { ms: T - 1000, textHead: auto };
		assert.equal(latestRequest(session), human.text, auto);
		assert.deepEqual(detect(world, {}), [], auto);
	}
	session.userTurns = [human, { ms: T - 1000, text: "Why is it red?" }];
	assert.equal(detect(world, {})[0].cls, "overstep", "a plain human question still counts");
});

test("a finished subagent gets no scope check", () => {
	const { world, session } = setup();
	Object.assign(session, { kind: "child", taskId: "st_1", parentSessionId: "p", task: { terminal: true, active: false } });
	session.steps = cyclingSteps(T);
	assert.deepEqual(detect(world, {}), []);
	session.task = { terminal: false, active: true };
	assert.equal(detect(world, {})[0].cls, "stuck");
});

test("a child whose host is gone gets no alignment finding even with churn evidence; the same child with a live host does", () => {
	const task = taskRecord({ taskId: "st_1", childSessionId: "c1", parentSessionId: "p1", hostPid: 4000, createdAtMs: T - 3600_000, status: "running" });
	const session = sessionState({ id: "c1", kind: "child", taskId: "st_1", parentSessionId: "p1", task });
	Object.assign(session, {
		lastUser: { ms: T - 10 * MIN, textHead: "Keep fixing" },
		healthMessages: [],
		activity: { sinceMs: T - 10 * MIN, mutations: 0, toolCalls: 0, files: new Map(), failingChecks: new Map([["npm test", DEFAULT_CONFIG.align.failRepeats]]), taskSpawns: [] },
	});
	const childWorld = (rows) => makeWorld({ now: T, sessions: [session], tasks: [task], procSnapshots: [{ takenAtMs: T, rows }] });
	assert.deepEqual(detect(childWorld([]), {}), [], "no live host: a days-old record stays backlog");
	const host = raw(4000, 0, "bun.exe", new Date(T - 3600_000).toISOString(), 0, 0, "bun C:/senpi/dist/bundle/cli.js");
	const [finding] = detect(childWorld([host]), {});
	assert.equal(finding?.cls, "churn", "the same churn evidence from a live child still nudges");
	assert.equal(finding.subject.sessionId, "c1");
});

test("age and tool-call count alone never nudge: a long goal that keeps finishing todos is left alone", () => {
	const { world, session } = setup();
	Object.assign(session.activity, { sinceMs: T - 6 * 3600_000, toolCalls: 129 });
	assert.deepEqual(detect(world, {}), []);
});

test("a session resumed after a 3 hour pause with advancing todos gets no nudge", () => {
	const { world, session } = setup();
	Object.assign(session.activity, { sinceMs: T - 5 * 3600_000, toolCalls: 80 });
	const rows = [[300, "start", "Todo A"], [296, "eval", "Read plan"], [290, "eval", "Run tests"], [285, "done", "Todo A"], [283, "start", "Todo B"], [280, "eval", "Fix B"], [276, "done", "Todo B"]];
	// Usage-limit wait: nothing for three hours, then work resumes and keeps finishing todos.
	for (let i = 0; i < 9; i++) rows.push([90 - i * 9, "eval", i % 2 ? "Rerun tests" : "Fix Todo C"], [86 - i * 9, "eval", `Check step ${alpha(i)}`]);
	rows.push([9, "done", "Todo C"], [8, "start", "Todo D"], [5, "eval", "Read D"], [2, "eval", "Fix D"]);
	session.steps = rows.map(([minAgo, kind, text]) => step(minAgo, kind, text)).sort((a, b) => a.ms - b.ms);
	assert.deepEqual(detect(world, {}), []);
});

test("one todo cycling fix, rerun and review gets one nudge that names the evidence", () => {
	const { world, session, memory } = setup();
	session.steps = cyclingSteps(T);
	const [finding, ...rest] = detect(world, memory);
	assert.equal(rest.length, 0);
	assert.equal(finding.cls, "stuck");
	assert.equal(finding.data.metric, 14);
	assert.match(finding.data.evidence, /^14 steps on 'Fix X' since 11:28Z, most repeated: '/);
	assert.match(finding.data.evidence, /'Fix X in the parser' x5/);
	memory.s1.push({ ms: world.now, key: finding.subject.key });
	assert.deepEqual(detect(world, memory), [], "the delivered nudge suppresses the same evidence");
});

test("the same todo in progress is not stuck while its steps do not cycle, are few, or are short", () => {
	const { world, session } = setup();
	session.steps = cyclingSteps(T).map((s, i) => (s.kind === "eval" ? { ...s, text: `Distinct step ${alpha(i)}` } : s));
	assert.deepEqual(detect(world, {}), [], "12+ different summaries are ordinary work");
	session.steps = cyclingSteps(T, { count: 8 });
	assert.deepEqual(detect(world, {}), [], "too few steps");
	session.steps = cyclingSteps(T, { gapMs: 20_000 });
	assert.deepEqual(detect(world, {}), [], "14 steps in five minutes is a burst, not a stall");
});

test("idle gaps do not count as active time: evidence spread over nights or usage-limit waits is dropped", () => {
	const { world, session } = setup();
	const texts = ["Fix X in the parser", "Rerun the parser tests", "Review the parser diff"];
	session.steps = [step(14 * 180, "start", "Fix X"), ...Array.from({ length: 14 }, (_, i) => step(2 + (13 - i) * 180, "eval", texts[i % 3]))];
	assert.deepEqual(detect(world, {}), [], "14 cycling steps, each hours after the last: no run of activity");
	const night = cyclingSteps(T - 10 * 3600_000);
	session.steps = [...night, step(1, "eval", "Rerun the parser tests"), step(0.5, "eval", "Review the parser diff")].sort((a, b) => a.ms - b.ms);
	assert.deepEqual(detect(world, {}), [], "the cycling ended before the pause");
	session.steps = cyclingSteps(T - 20 * MIN);
	assert.deepEqual(detect(world, {}), [], "a dormant session has nothing left to reconsider");
});

test("no done transition across many steps while a todo stays open is non-convergence", () => {
	const { world, session } = setup();
	const rows = [step(80, "start", "Big todo")];
	for (let i = 0; i < 40; i++) rows.push(step(78 - i * 1.9, "eval", `Distinct step ${alpha(i)}`));
	session.steps = rows;
	const [finding] = detect(world, {});
	assert.equal(finding.cls, "stuck");
	assert.match(finding.data.evidence, /^40 steps without a finished todo since 10:4\dZ \(open: 'Big todo'\)/);
	session.steps = [...rows, step(1, "done", "Big todo")];
	assert.deepEqual(detect(world, {}), []);
});

test("a reopened todo is evidence", () => {
	const { world, session } = setup();
	session.steps = [step(30, "start", "Todo A"), step(25, "eval", "Fix A"), step(20, "done", "Todo A"), step(10, "reopen", "Todo A"), step(5, "eval", "Fix A again")];
	const [finding] = detect(world, {});
	assert.equal(finding.cls, "reopened");
	assert.match(finding.data.evidence, /^'Todo A' was reopened after it was done \(1x since 11:50Z\)/);
});

test("near-identical summaries repeating with no todo finished nudge; a finished todo in between explains them", () => {
	const { world, session } = setup();
	session.steps = Array.from({ length: 6 }, (_, i) => step(20 - i * 3, "eval", `Run land_stage${23 + i}.py --check (no changes)`));
	const [finding] = detect(world, {});
	assert.equal(finding.cls, "repeat");
	assert.equal(finding.data.metric, 6);
	assert.match(finding.data.evidence, /^'Run land_stage23\.py --check \(no changes\)' repeated 6x since 11:40Z/);
	session.steps.splice(3, 0, step(11, "done", "Todo A"));
	assert.deepEqual(detect(world, {}), []);
});

test("review spawns count only when no todo transition separates them", () => {
	const { world, session } = setup();
	session.activity.taskSpawns = ["review", "verify", "audit", "re-write"].map((summary) => ({ summary }));
	const spawns = [40, 35, 30, 25].map((minAgo, i) => step(minAgo, "task", ["Review diff", "Verify fix", "Audit change", "Rewrite docs"][i]));
	session.steps = [step(45, "start", "Todo A"), spawns[0], spawns[1], step(32, "done", "Todo A"), step(31, "start", "Todo B"), spawns[2], spawns[3]];
	assert.deepEqual(detect(world, {}), [], "a review per finished todo is normal");
	session.steps = [step(45, "start", "Todo A"), ...spawns];
	assert.equal(detect(world, {})[0].cls, "churn");
});

test("a child completion inside the run is progress: the same todo is not stuck", () => {
	const { world, session } = setup();
	const steps = cyclingSteps(T);
	// A child completion lands inside the fix -> rerun -> review cycle; the todo has made progress since.
	steps.splice(8, 0, { ms: T - 6 * MIN, tool: "senpi-task.completion", kind: "progress", text: "child finished" });
	session.steps = steps;
	assert.deepEqual(detect(world, {}), []);
});

test("workflow run activity counts as progress", () => {
	const { world, session } = setup();
	session.steps = cyclingSteps(T);
	// The cycle itself is unchanged, but the session's DAG run showed activity one minute ago.
	world.workOf = () => ({ runs: [{ runId: "r1", lastProgressMs: T - MIN }] });
	assert.deepEqual(detect(world, {}), []);
});

test("plan-reviewer and gate-reviewer spawns are not review churn; plain review spawns still are", () => {
	const { world, session } = setup();
	const rows = [step(60, "start", "Todo A")];
	["plan-reviewer", "plan-consultant", "omo-native-code-reviewer", "omo-native-gate-reviewer"].forEach((agent, i) => {
		rows.push({ ...step(50 - i * 3, "task", `Review with ${agent}`), agent });
	});
	session.steps = rows;
	assert.deepEqual(detect(world, {}), [], "designed review agents are the workflow, not churn");
	rows.push(...[[30, "Review diff"], [25, "Verify fix"], [20, "Audit change"], [15, "Rewrite docs"]].map(([minAgo, text]) => step(minAgo, "task", text)));
	session.steps = rows;
	assert.equal(detect(world, {})[0].cls, "churn", "plain review spawns after progress still count");
});

test("without a todo transition, the spawn fallback ignores designed review agents but not plain reviews", () => {
	const { world, session } = setup();
	session.activity.taskSpawns = ["plan-reviewer", "plan-consultant", "omo-native-code-reviewer", "omo-native-gate-reviewer"].map((agent) => ({ summary: "Review diff", agent }));
	assert.deepEqual(detect(world, {}), [], "the fallback sees the workflow's review agents, not churn");
	session.activity.taskSpawns.push(...[[30, "Review diff"], [25, "Verify fix"], [20, "Audit change"], [15, "Rewrite docs"]].map(([, summary]) => ({ summary, agent: null })));
	assert.equal(detect(world, {})[0].cls, "churn", "plain review spawns still count when the ledger has no transition");
});

test("detect does not spend the cooldown: the same finding repeats until a delivery is recorded", () => {
	const { world, session, memory } = setup();
	session.lastUser.textHead = "Why?";
	session.activity.mutations = 1;
	const first = detect(world, memory)[0];
	assert.equal(first.cls, "overstep");
	const again = detect(world, memory)[0];
	assert.equal(again?.subject.key, first.subject.key, "an undelivered finding is retried");
	(memory.s1 ??= []).push({ ms: world.now, key: first.subject.key });
	assert.deepEqual(detect(world, memory), [], "a delivered finding spends the budget");
});

test("the finding carries the request age, the analyst question and a bounded ledger", () => {
	const { world, session } = setup();
	const askMs = T - 3 * 3600_000;
	session.userTurns = [
		{ ms: T - 6 * 3600_000, text: "older request" },
		{ ms: T - 5 * 3600_000, text: "first request" },
		{ ms: T - 4 * 3600_000, text: "second request" },
		{ ms: askMs, text: "이거 왜 이러나요?" },
	];
	session.lastUser = { ms: askMs, textHead: "이거 왜 이러나요?" };
	session.activity.mutations = 1;
	session.steps = [step(45, "start", "Big todo"), ...Array.from({ length: 40 }, (_, i) => step(44 - i, "eval", `Check ${i}`))];
	const findings = detect(world, {});
	const finding = findings.find((item) => item.cls === "overstep") ?? findings[0];
	assert.equal(finding.data.lastUserText, "이거 왜 이러나요?");
	assert.equal(finding.data.lastUserMs, askMs);
	assert.equal(finding.data.question, "Is this session still converging on its goal and the latest human request, or is it stuck in rounds that do not converge, or doing work nobody asked for? progressing = it is on track, leave it alone; stuck = it drifted: mechanism = what it keeps repeating and why that does not converge; avoid = the concrete next step it should take instead. Answer with verdict stuck or progressing and cause unknown unless one of the listed causes fits; mechanism and avoid must each be at least 20 characters.");
	assert.equal(finding.data.ledger.steps.length, 30);
	assert.deepEqual(finding.data.ledger.steps[0], { ms: T - 34 * MIN, kind: "eval", tool: "eval", text: "Check 10" });
	assert.equal(finding.data.ledger.openTodo, "Big todo");
	assert.deepEqual(finding.data.ledger.requests, ["first request", "second request", "이거 왜 이러나요?"]);
});

test("no request known means lastUserText null", () => {
	const { world, session } = setup();
	session.userTurns = [];
	session.lastUser = { ms: T - 100_000, textHead: "" };
	session.activity.failingChecks.set("npm test", 8);
	const [finding] = detect(world, {});
	assert.equal(finding.cls, "churn");
	assert.equal(finding.data.lastUserText, null);
	assert.equal(finding.data.lastUserMs, null);
	assert.deepEqual(finding.data.ledger.requests, []);
});

test("two children of one parent share the parent's nudge budget", () => {
	const { world, session, memory } = setup();
	session.id = "p1";
	world.sessions.clear();
	world.sessions.set("p1", session);
	for (const id of ["c1", "c2"]) {
		world.sessions.set(id, { ...session, id, kind: "child", parentSessionId: "p1", taskId: `st_${id}`, task: { active: true, terminal: false }, steps: cyclingSteps(T), healthMessages: [] });
	}
	const at = (now) => {
		for (const id of ["c1", "c2"]) world.sessions.get(id).steps = cyclingSteps(now);
		world.now = now;
	};
	const findings = detect(world, memory);
	assert.equal(findings.length, 1, "one nudge for the parent, not one per child");
	const [finding] = findings;
	assert.deepEqual(Object.keys(memory), ["p1"]);
	memory.p1.push({ ms: world.now, key: finding.subject.key });
	at(T + DEFAULT_CONFIG.align.minGapMs - 1);
	assert.deepEqual(detect(world, memory), [], "inside the parent's minimum gap");
	at(T);
	const day = { p1: Array.from({ length: DEFAULT_CONFIG.align.perDay }, (_, i) => ({ ms: T - i - 1, key: `old:${i}` })) };
	assert.deepEqual(detect(world, day), [], "the daily budget is the parent's too");
	world.sessions.get("p1").healthMessages = [{ ms: T - 1, details: { kind: "scope-check", subjectSessionId: "c2", key: "align:c2:stuck:3" } }];
	assert.deepEqual(detect(world, {}), [], "a note the parent received about a sibling counts after a restart");
});
