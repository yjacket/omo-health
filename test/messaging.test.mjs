import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pendingMessages, readReceipt, sendToSession, sweepUndelivered } from "../src/act/inbox.mjs";
import { composeActionNotice, composeBootGapNotice, composeGoalWake, composeMainStallNotice, composeNudge, composeRelayCancel, composeScopeCheck, composeWake, composeWhyNotice, composeWrongCommandRelease } from "../src/act/messages.mjs";
import { createNotifier, footerText, readStatus, writeSessionStatus } from "../src/act/notify.mjs";
import { REPORT_SECTIONS, renderReport, writeReport } from "../src/act/reports.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { appendDecision, readDecisions } from "../src/decisions.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { newRecord } from "../src/judge/policy.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-09-23T15:47:05Z");

function tempPaths() {
	const root = tmpDir("omoh-msg-");
	return resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
}

const stall = makeFinding({
	detector: "D1",
	kind: "stall",
	subject: { sessionId: "c1", taskId: "st_01a0ced9", parentSessionId: "p1", toolCallId: "toolu_grep" },
	cls: "runaway-readonly",
	evidence: ["busy:grep:55000", "treeCpu:1.00"],
	titleKo: "읽기 명령 폭주",
	detailKo: "설명",
	data: { call: { id: "toolu_grep", name: "bash", commandHead: "grep -o 'x' omo.js | head -1" }, ageMs: 600_000, background: "background", classification: { rule: { id: "R8", v: 2 }, confidence: 0.9 } },
});

test("relay to the parent: followUp, triggers only when the parent is idle and the child is background, carries forward text", () => {
	const outcome = { killed: [{ pid: 55000, name: "grep.exe" }] };
	const idle = composeActionNotice({ finding: stall, actionKind: "kill-pids", outcome, target: "parent", sessionId: "p1", now: T, parentIdle: true });
	assert.equal(idle.kind, "relay");
	assert.equal(idle.deliverAs, "followUp");
	assert.equal(idle.triggerTurn, true);
	assert.equal(idle.customType, "omo-health");
	assert.equal(idle.details.taskId, "st_01a0ced9");
	assert.deepEqual(idle.details.killed, outcome.killed);
	assert.ok(idle.details.forwardText.length > 20);
	assert.ok(idle.content.includes(idle.details.forwardText));
	const busy = composeActionNotice({ finding: stall, actionKind: "kill-pids", outcome, target: "parent", sessionId: "p1", now: T, parentIdle: false });
	assert.equal(busy.triggerTurn, false);
	const self = composeActionNotice({ finding: stall, actionKind: "kill-pids", outcome, target: "self", sessionId: "m", now: T });
	assert.equal(self.kind, "self-notice");
	assert.equal(self.deliverAs, "steer");
	const repeat = composeActionNotice({ finding: stall, actionKind: "kill-pids", outcome, target: "parent", sessionId: "p1", now: T, repeat: true });
	assert.equal(repeat.details.repeat, true);
	assert.notEqual(repeat.details.forwardText, idle.details.forwardText);
});

test("wake, nudge and relay-cancel always carry their machine fields", () => {
	assert.equal(composeWake({ finding: stall, sessionId: "p1", now: T }).triggerTurn, true);
	assert.equal(composeNudge({ finding: stall, sessionId: "s", now: T }).kind, "nudge");
	const cancel = composeRelayCancel({ finding: stall, sessionId: "p1", now: T, parentIdle: true });
	assert.equal(cancel.kind, "relay-cancel");
	assert.equal(cancel.details.toolCallId, "toolu_grep");
});

test("scope check is redacted, quiet and forwardable", () => {
	const finding = makeFinding({ detector: "D15", kind: "drift", cls: "overstep", subject: { sessionId: "c1", taskId: "st_1", key: "align:c1:overstep:0" }, data: { signal: "overstep", metric: 1, goal: "answer the question", lastUserText: "why sk-ant-oat01-abcdefghijklmnop?" } });
	const own = composeScopeCheck({ finding, sessionId: "c1", now: T });
	assert.match(own.content, /^\[omo-health 범위 점검\]/);
	assert.match(own.content, /Original goal: "answer the question"/);
	assert.equal(own.content.includes("abcdefghijklmnop"), false);
	assert.equal(own.triggerTurn, false);
	assert.equal(own.deliverAs, "steer");
	const forwarded = composeScopeCheck({ finding, sessionId: "p1", now: T, forward: true, deliverAs: "nextTurn" });
	assert.match(forwarded.content, /^Forward this to subagent st_1 with task_send:/);
	assert.equal(forwarded.deliverAs, "nextTurn");
	assert.equal(forwarded.triggerTurn, false);
});

test("goal wake lists its evidence and the analyst's answer, then the workflow advice", () => {
	const verdict = {
		cause: "unfolded-workflow",
		confidence: 0.8,
		mechanism: "node apply finished, but the run never consumed its result, so the run has nothing scheduled",
		avoid: "fold the run and re-dispatch only the node result it still owes",
	};
	const sources = [
		{ kind: "task", id: "st_apply", name: "apply", state: "completed", text: "task st_apply apply completed at 2026-10-19T01:00:00.000Z" },
		{ kind: "run", id: "run_1", name: "ship", state: "running", text: "run run_1 ship waiting on node apply" },
	];
	const message = composeGoalWake({ sessionId: "main1", reason: "unfolded-workflow", now: T, sources, verdict });
	assert.ok(message.content.includes("Evidence:"));
	for (const source of sources) assert.ok(message.content.includes(`- ${source.text}`));
	assert.ok(message.content.includes(`Analyst: ${verdict.mechanism}`));
	assert.ok(message.content.includes(`Do instead: ${verdict.avoid}`));
	assert.ok(message.content.includes("A run that cannot advance by itself never sends a completion"));
	assert.deepEqual(message.details.sources, ["st_apply", "run_1"]);
	assert.deepEqual(message.details.verdict, { cause: "unfolded-workflow", confidence: 0.8 });
	assert.equal(message.triggerTurn, true);
	assert.equal(message.details.expiresMs, T + 300_000);
});

test("scope check omits an empty request and ages an old one", () => {
	const finding = makeFinding({ detector: "D15", kind: "drift", cls: "overstep", subject: { sessionId: "c1", taskId: "st_1", key: "align:c1:overstep:0" }, data: { signal: "overstep", metric: 1, goal: "answer the question", lastUserText: null } });
	assert.equal(composeScopeCheck({ finding, sessionId: "c1", now: T }).content.includes("Latest user request"), false);
	const blank = { ...finding, data: { ...finding.data, lastUserText: "" } };
	assert.equal(composeScopeCheck({ finding: blank, sessionId: "c1", now: T }).content.includes("Latest user request"), false);
	const old = { ...finding, data: { ...finding.data, lastUserText: "finish the parser", lastUserMs: T - 5 * 60 * 60_000 } };
	assert.ok(composeScopeCheck({ finding: old, sessionId: "c1", now: T }).content.includes('Latest user request (5h ago): "finish the parser".'));
});

test("scope check prints the analyst's line and records its cause and confidence", () => {
	const finding = makeFinding({ detector: "D15", kind: "drift", cls: "overstep", subject: { sessionId: "c1", taskId: "st_1", key: "align:c1:overstep:0" }, data: { signal: "overstep", metric: 1, goal: "answer the question", lastUserText: null } });
	const verdict = { cause: "overstep", confidence: 0.7, mechanism: "the question asked for an explanation, but the session edited files", avoid: "answer the question first and ask before changing anything" };
	const note = composeScopeCheck({ finding, sessionId: "c1", now: T, verdict });
	assert.ok(note.content.includes(`Analyst: ${verdict.mechanism}`));
	assert.ok(note.content.includes(`Do instead: ${verdict.avoid}`));
	assert.equal(note.details.cause, "overstep");
	assert.equal(note.details.confidence, 0.7);
});

test("boot gap notice lists the lost work and only wakes an idle active goal", () => {
	const gap = { kind: "reboot", downSinceMs: T - 3 * 60 * 60_000, upAtMs: T };
	const tasks = [{ taskId: "st_a", name: "apply", status: "running", createdAtMs: T - 4 * 60 * 60_000, lastProgressMs: T - 3 * 60 * 60_000, hostPid: 4242 }];
	const runs = [{ runId: "run_1", name: "ship", status: "running", lastEventAtMs: T - 3 * 60 * 60_000, counts: { completed: 2, total: 5 }, nodes: [{ id: "publish", state: "running" }, { id: "verify", state: "pending" }] }];
	const idle = composeBootGapNotice({ sessionId: "main1", now: T, gap, tasks, runs, goalActive: true, idle: true });
	assert.equal(idle.kind, "self-notice");
	assert.equal(idle.deliverAs, "followUp");
	assert.equal(idle.triggerTurn, true);
	assert.match(idle.content, /^\[omo-health\] omo-health가 멈춰 있던 동안\(.+~.+\) 재부팅이 있었고 그 전에 실행 중이던 서브에이전트 1개와 워크플로 1개가 이어지지 않았습니다/);
	assert.ok(idle.content.includes("the machine rebooted"));
	assert.ok(idle.content.includes('- task st_a "apply" (running, created '));
	assert.ok(idle.content.includes("host pid 4242 is gone."));
	assert.ok(idle.content.includes('- workflow run run_1 "ship" (running, 2/5 nodes done'));
	assert.ok(idle.content.includes("publish=running, verify=pending"));
	assert.ok(idle.content.includes("Do not wait for these."));
	assert.deepEqual(idle.details, { actionKind: "boot-notice", gapKind: "reboot", downSinceMs: gap.downSinceMs, tasks: ["st_a"], runs: ["run_1"] });
	const working = composeBootGapNotice({ sessionId: "main1", now: T, gap, tasks, runs, goalActive: true, idle: false });
	assert.deepEqual([working.deliverAs, working.triggerTurn], ["nextTurn", false]);
	const noGoal = composeBootGapNotice({ sessionId: "main1", now: T, gap, tasks, runs, idle: true });
	assert.deepEqual([noGoal.deliverAs, noGoal.triggerTurn], ["nextTurn", false]);
});

test("boot gap notice prints unknown for a missing time instead of throwing", () => {
	const gap = { kind: "downtime", downSinceMs: T - 60_000, upAtMs: T };
	const tasks = [{ taskId: "st_a", name: "apply", status: "running", createdAtMs: T - 2 * 60_000, hostPid: 4242 }];
	const runs = [{ runId: "run_1", name: "ship", status: "running", counts: { completed: 1, total: 2 }, nodes: [{ id: "publish", state: "running" }] }];
	const note = composeBootGapNotice({ sessionId: "main1", now: T, gap, tasks, runs });
	assert.ok(note.content.includes("last progress unknown"));
	assert.ok(note.content.includes("last run event unknown"));
	const bare = composeBootGapNotice({ sessionId: "main1", now: T, gap: { kind: "downtime" } });
	assert.ok(bare.content.includes("unknown~unknown"));
});

test("scope check for step evidence quotes the evidence instead of a count", () => {
	const evidence = "12 steps on 'Fix X' since 14:02Z, most repeated: 'Rerun tests' x4";
	const finding = makeFinding({ detector: "D15", kind: "drift", cls: "stuck", subject: { sessionId: "c1", taskId: "st_1", key: "align:c1:stuck:3" }, data: { signal: "stuck", metric: 12, evidence, goal: "fix X", lastUserText: "fix X" } });
	const note = composeScopeCheck({ finding, sessionId: "c1", now: T });
	assert.match(note.content, /scope check \(stuck\): 12 steps on 'Fix X' since 14:02Z, most repeated: 'Rerun tests' x4\./);
	assert.match(note.content, /^\[omo-health 범위 점검\] [^\n]*\n/);
	assert.equal(note.details.signal, "stuck");
});

test("why notice: the parent learns cause, mechanism and what to do instead (kind relay, wakes only an idle parent)", () => {
	const verdict = {
		verdict: "stuck",
		assessment: "abnormal",
		confidence: 0.85,
		cause: "wrong-command",
		mechanism: "`dir /s C:\\` was run with /s from the drive root, so it walks the whole disk and never finishes within the call",
		avoid: "run `dir C:\\dev\\omo` without /s, or use `rg --files` with an explicit bounded path",
		evidence: ["busy:dir:55000", "treeCpu:1.00", "kept-third-line", "fourth-line-dropped"],
	};
	const parent = composeWhyNotice({ finding: stall, sessionId: "p1", now: T, verdict, target: "parent", parentIdle: true });
	assert.equal(parent.kind, "relay");
	assert.equal(parent.deliverAs, "followUp");
	assert.equal(parent.triggerTurn, true);
	assert.equal(parent.details.why, true);
	assert.equal(parent.details.fp, stall.fp);
	assert.equal(parent.details.detector, "D1");
	assert.equal(parent.details.kind, "stall");
	assert.equal(parent.details.confidence, 0.85);
	assert.ok(parent.content.includes(verdict.mechanism));
	assert.ok(parent.content.includes(verdict.avoid));
	assert.ok(parent.content.includes("Do not rerun the same command unchanged."));
	assert.equal(parent.content.includes("fourth-line-dropped"), false, "only the first three evidence lines are kept");
	const busy = composeWhyNotice({ finding: stall, sessionId: "p1", now: T, verdict, target: "parent", parentIdle: false });
	assert.equal(busy.triggerTurn, false);
	const self = composeWhyNotice({ finding: stall, sessionId: "m", now: T, verdict, target: "self", parentIdle: true });
	assert.equal(self.kind, "self-notice");
	assert.equal(self.triggerTurn, false);
});

test("why notice redacts a secret that appears in the mechanism", () => {
	const verdict = { verdict: "stuck", cause: "wrong-command", mechanism: "the token sk-ant-oat01-abcdefghijklmnop was passed on the argument, so the retry loop never ends", avoid: "read the token from the environment instead of the command line" };
	const msg = composeWhyNotice({ finding: stall, sessionId: "p1", now: T, verdict, target: "parent", parentIdle: true });
	assert.equal(msg.content.includes("abcdefghijklmnop"), false);
	assert.ok(msg.content.includes("sk-ant-[REDACTED]"));
});

test("relay-cancel carries the analyst mechanism and avoid and never advises re-running the same task unchanged", () => {
	const triage = { tier: 2, diagnosis: "the call never returns", mechanism: "grep runs from the drive root with no bound", avoid: "bound the search with an explicit path and --max-count", advice: "use rg -o --max-count 1" };
	const msg = composeRelayCancel({ finding: stall, sessionId: "p1", now: T, parentIdle: true, triage });
	assert.ok(msg.content.includes(triage.mechanism));
	assert.ok(msg.content.includes(triage.avoid));
	assert.equal(msg.content.includes("same task again"), false);
	assert.ok(msg.content.includes("다시 띄울 때는 위에 적힌 대로 바꿔서 지시하세요."), "the step line points at the change above only when there is one");
	const bare = composeRelayCancel({ finding: stall, sessionId: "p1", now: T, parentIdle: true });
	assert.ok(bare.content.includes("멈춰 있으면 task_cancel."), "without mechanism/avoid the step line is the plain Korean wording");
	assert.equal(bare.content.includes("위에 적힌"), false, "nothing above to point at");
	assert.equal(/다시 띄우/.test(bare.content), false, "no advice to relaunch the task unchanged");
});

test("wrong-command release and main stall notice carry mechanism and avoid", () => {
	const triage = { cause: "wrong-command", confidence: 0.9, diagnosis: "ran the WSL launcher", mechanism: "C:\\Windows\\System32\\bash.exe opened a WSL shell that waited on a prompt", avoid: "call Git bash directly", evidence: ["argv0=bash.exe"] };
	const released = composeWrongCommandRelease({ finding: stall, sessionId: "s1", now: T, outcome: { killed: [{ pid: 55000, name: "bash.exe" }] }, triage, idle: true });
	assert.ok(released.content.includes(triage.mechanism));
	assert.ok(released.content.includes(triage.avoid));
	const verdict = { verdict: "stuck", assessment: "suspicious", confidence: 0.6, diagnosis: "the call waits on a lock", mechanism: "another process holds the file lock, so the write blocks forever", avoid: "release the lock or write to a temp file first" };
	const main = composeMainStallNotice({ finding: stall, sessionId: "m", now: T, verdict });
	assert.ok(main.content.includes(verdict.mechanism));
	assert.ok(main.content.includes(verdict.avoid));
});

test("wake tells the parent not to relaunch the child unchanged and to wait for the why", () => {
	const wake = composeWake({ finding: stall, sessionId: "p1", now: T });
	assert.ok(wake.content.includes("do not relaunch it unchanged"));
	assert.equal(/다시 띄우/.test(wake.content), false);
	assert.ok(wake.content.includes("task_output(st_01a0ced9)"));
	const errored = makeFinding({ detector: "D8", kind: "dead-child", subject: { sessionId: "p1", taskId: "st_1" }, data: { remedy: { reason: "child-error" }, idleMs: 600_000 } });
	assert.ok(composeWake({ finding: errored, sessionId: "p1", now: T }).content.includes("do not relaunch it unchanged"));
});

test("inbox writes atomically, receipts are read back, stale undelivered messages move aside", () => {
	const paths = tempPaths();
	const msg = composeWake({ finding: stall, sessionId: "01a0cd9e-18be", now: T });
	const file = sendToSession(paths, msg);
	assert.ok(fs.existsSync(file));
	assert.equal(pendingMessages(paths, "01a0cd9e-18be")[0].message.id, msg.id);
	assert.equal(readReceipt(paths, msg.id), undefined);
	fs.mkdirSync(paths.health.receiptsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.receiptsDir, `${msg.id}.json`), JSON.stringify({ id: msg.id, deliveredMs: T + 3000 }));
	assert.equal(readReceipt(paths, msg.id).deliveredMs, T + 3000);
	const lost = composeNudge({ finding: stall, sessionId: "gone", now: T });
	sendToSession(paths, lost);
	assert.deepEqual(sweepUndelivered(paths, T + 10 * 60_000).map((m) => m.id), [lost.id]);
	assert.equal(pendingMessages(paths, "gone").length, 0);
});

test("footer text levels and status files", () => {
	assert.equal(footerText("ok"), "👀 정상");
	assert.equal(footerText("info", { detector: "D4" }), "👀 정상");
	assert.equal(footerText("info", { detector: "D1" }, 2), "👀 관찰2");
	assert.equal(footerText("warn", { detector: "D1", kind: "stall" }), "👀 멈춤");
	assert.equal(footerText("crit", { detector: "D6", kind: "accounts-blocked" }), "👀 로그인");
	assert.equal(footerText("warn", { detector: "D99" }), "👀 문제");
	const paths = tempPaths();
	writeSessionStatus(paths, "s1", { level: "warn", text: "헬스 ⚠ x" });
	assert.equal(readStatus(paths, "s1").level, "warn");
});

test("toasts obey the per-tag cooldown and do not record failures", () => {
	const paths = tempPaths();
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(T);
	const shown = [];
	const notifier = createNotifier({ paths, clock, config: DEFAULT_CONFIG, runner: (t) => (shown.push(t.tag), { ok: true }) });
	assert.equal(notifier.toast({ title: "a", body: "b", tag: "login" }).ok, true);
	assert.equal(notifier.toast({ title: "a", body: "b", tag: "login" }).skipped, "cooldown");
	clock.advance(DEFAULT_CONFIG.notify.toastCooldownMs + 1);
	assert.equal(notifier.toast({ title: "a", body: "b", tag: "login" }).ok, true);
	const failing = createNotifier({ paths, clock, config: DEFAULT_CONFIG, runner: () => ({ ok: false, status: 1 }) });
	assert.equal(failing.toast({ title: "a", body: "b", tag: "x" }).ok, false);
	assert.equal(failing.toast({ title: "a", body: "b", tag: "x" }).skipped, undefined, "a failed toast is retried, not cooled down");
	assert.deepEqual(shown, ["login", "login"]);
});

test("reports have the five sections and are redacted", () => {
	const paths = tempPaths();
	const record = newRecord(stall.fp, T);
	record.history = [{ atMs: T + 1, kind: "kill-pids", status: "execute", detail: "killed grep.exe(55000) sk-ant-oat01-abcdefghijklmnop" }];
	record.resolvedMs = T + 30_000;
	const text = renderReport(stall, record, T + 30_000);
	for (const section of REPORT_SECTIONS) assert.ok(text.includes(section), section);
	assert.equal(text.includes("abcdefghijklmnop"), false);
	const file = writeReport(paths, stall, record, T + 30_000);
	assert.ok(file.includes(path.join("reports", "2026-09-23")));
	assert.equal(writeReport(paths, stall, record, T + 40_000), file, "same incident keeps its report file");
});

test("decision log appends and reads back by time", () => {
	const paths = tempPaths();
	appendDecision(paths, { ts: "2026-09-23T15:47:05.000Z", fp: "a", action: { kind: "kill-pids" }, result: "execute" });
	appendDecision(paths, { ts: "2026-09-23T16:00:00.000Z", fp: "b", action: { kind: "judge" }, result: "would" });
	assert.deepEqual(readDecisions(paths, Date.parse("2026-09-23T15:50:00Z")).map((d) => d.fp), ["b"]);
});
