import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { ANALYST_SCHEMA, bundleDocument, createAnalyst, parseAnalystOutput, unavailableReason, validateAnalyst } from "../src/judge/analyst.mjs";
import { assertGuardFlags, laneArgs, resolveLaneModel } from "../src/judge/lane.mjs";
import { buildBundle } from "../src/judge/triage.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";

const T = Date.parse("2026-10-07T12:00:00Z");
const MODEL = DEFAULT_CONFIG.analyst.fallbackModel;
const CANDIDATES = [{ id: "release-shell", kind: "kill-pids", effect: "release the blocked call" }, { id: "wait", kind: "wait", effect: "keep waiting" }];

function sandbox(tweak = {}) {
	const root = tmpDir("omoh-analyst-");
	const env = { OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root };
	const paths = resolvePaths(env);
	fs.mkdirSync(paths.agentDir, { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	Object.assign(config.analyst, tweak);
	return { root, paths, config, clock: createFakeClock(T) };
}

function writeLane(paths, { models, providers }) {
	fs.writeFileSync(paths.omoJsonc, `// lanes\n{\n\t"[native]": { "categories": { "deep-low": { "models": ${JSON.stringify(models)}, }, }, },\n}\n`);
	fs.writeFileSync(paths.authFile, JSON.stringify(Object.fromEntries(providers.map((p) => [p, { secret: "do-not-read" }]))));
}

const finding = (n = 1) =>
	makeFinding({ detector: "D1", kind: "stall", cls: "quiet-hang", subject: { sessionId: "c1", toolCallId: `t${n}` }, evidence: ["pending:70m"], data: { sessionKind: "subagent", cwd: "C:/work" } });

const answer = (over = {}) => ({
	verdict: "stuck",
	cause: "blocked-input",
	evidence: ["python - waits on stdin for 70 min"],
	confidence: 0.9,
	diagnosis: "REPL waits for input.",
	mechanism: "python - was started with no script argument, so it opened an interactive REPL that reads stdin and never returns.",
	avoid: "Run the prepared script as `python script.py --input file` instead of an interactive REPL.",
	...over,
});

function setup(opts = {}) {
	const box = sandbox(opts.config);
	const runner = createFakeRunner({ outcomes: opts.outcomes });
	const analyst = createAnalyst({ config: box.config, paths: box.paths, clock: box.clock, runner, env: opts.env ?? {} });
	return { ...box, runner, analyst };
}

test("resolveLaneModel takes the first rung whose provider is logged in", () => {
	const { paths, config } = sandbox();
	writeLane(paths, { models: ["devin/swe-2-max", "anthropic-subscription/claude-opus-5-5:medium", "nvidia/x"], providers: ["anthropic-subscription", "nvidia"] });
	assert.equal(resolveLaneModel(paths, "deep-low", config), "anthropic-subscription/claude-opus-5-5:medium");
});

test("resolveLaneModel falls back when no rung is logged in, the lane is missing or the files are unreadable", () => {
	const { paths, config } = sandbox();
	assert.equal(resolveLaneModel(paths, "deep-low", config), MODEL);
	writeLane(paths, { models: ["devin/swe-2-max"], providers: ["nvidia"] });
	assert.equal(resolveLaneModel(paths, "deep-low", config), MODEL);
	assert.equal(resolveLaneModel(paths, "no-such-lane", config), MODEL);
	fs.writeFileSync(paths.omoJsonc, "{ not json");
	assert.equal(resolveLaneModel(paths, "deep-low", config), MODEL);
});

test("laneArgs carries every guard flag, the session id and the bundle as @file, and throws when a flag is missing", () => {
	const args = laneArgs({ model: "p/m", bundleFile: "C:/jobs/j1/bundle.md", sessionId: "11111111-2222-4333-8444-555555555555" });
	for (const flag of ["-p", "--no-session", "-ne", "-ns", "-nc", "--no-tools"]) assert.ok(args.includes(flag), flag);
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "p/m"]);
	assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", "11111111-2222-4333-8444-555555555555"]);
	assert.ok(args.includes("@C:/jobs/j1/bundle.md"));
	assert.throws(() => assertGuardFlags(args.filter((a) => a !== "--no-tools")), /--no-tools/);
	assert.throws(() => laneArgs({ model: "p/m" }), /bundleFile/);
});

test("parseAnalystOutput finds the verdict object after a preamble and inside a code fence", () => {
	const text = `> I read this as a judgment ask {not json}\n\n\`\`\`json\n${JSON.stringify(answer())}\n\`\`\`\n`;
	assert.equal(parseAnalystOutput(text).verdict, "stuck");
	assert.equal(parseAnalystOutput("no json here"), null);
});

test("validateAnalyst: a confident stuck verdict with evidence acts on release-shell", () => {
	const v = validateAnalyst(answer(), CANDIDATES, DEFAULT_CONFIG);
	assert.equal(v.verdict, "act");
	assert.equal(v.actionId, "release-shell");
	assert.equal(v.assessment, "abnormal");
	assert.equal(v.cause, "blocked-input");
	assert.deepEqual(v.evidence, ["python - waits on stdin for 70 min"]);
	assert.equal(validateAnalyst(JSON.stringify(answer()), CANDIDATES, DEFAULT_CONFIG).verdict, "act");
});

test("validateAnalyst: stuck below analyst.actConfidence, without evidence or without the candidate escalates", () => {
	const low = validateAnalyst(answer({ confidence: 0.79 }), CANDIDATES, DEFAULT_CONFIG);
	assert.equal(low.verdict, "escalate");
	assert.equal(low.belowFloor, true);
	assert.equal(low.actionId, undefined);
	const bare = validateAnalyst(answer({ evidence: [] }), CANDIDATES, DEFAULT_CONFIG);
	assert.deepEqual([bare.verdict, bare.reason], ["escalate", "no-evidence"]);
	const noCandidate = validateAnalyst(answer(), [{ id: "wait", kind: "wait" }], DEFAULT_CONFIG);
	assert.deepEqual([noCandidate.verdict, noCandidate.reason], ["escalate", "action-not-in-candidates"]);
});

test("validateAnalyst: progressing waits with a clamped recheck, unrecoverable escalates with the respawn text", () => {
	const wait = validateAnalyst(answer({ verdict: "progressing", cause: "external-wait", recheck_after_s: 5 }), CANDIDATES, DEFAULT_CONFIG);
	assert.deepEqual([wait.verdict, wait.recheckAfterS], ["wait", 300]);
	assert.equal(validateAnalyst(answer({ verdict: "progressing", cause: "external-wait", recheck_after_s: 99999 }), CANDIDATES, DEFAULT_CONFIG).recheckAfterS, 3600);
	const dead = validateAnalyst(answer({ verdict: "unrecoverable", cause: "unknown", respawn_text: "Cancel the task and respawn it with a fresh session." }), CANDIDATES, DEFAULT_CONFIG);
	assert.deepEqual([dead.verdict, dead.assessment, dead.advice], ["escalate", "abnormal", "Cancel the task and respawn it with a fresh session."]);
	assert.equal(dead.failed, undefined);
});

test("validateAnalyst: anything malformed is a failed bad-output escalation", () => {
	const bad = [null, "not json", "[]", answer({ verdict: "kill" }), answer({ cause: "because" }), answer({ confidence: 2 }), answer({ confidence: "high" }), answer({ evidence: "x" }), answer({ diagnosis: 7 }), answer({ verdict: "unrecoverable" })];
	for (const raw of bad) {
		const v = validateAnalyst(raw, CANDIDATES, DEFAULT_CONFIG);
		assert.deepEqual([v.verdict, v.reason, v.failed], ["escalate", "bad-output", true], JSON.stringify(raw));
	}
	assert.deepEqual(Object.keys(ANALYST_SCHEMA.properties), ["verdict", "cause", "evidence", "confidence", "diagnosis", "mechanism", "avoid", "respawn_text", "recheck_after_s"]);
});

test("validateAnalyst: a stuck answer keeps its mechanism and avoid", () => {
	const v = validateAnalyst(answer(), CANDIDATES, DEFAULT_CONFIG);
	assert.equal(v.verdict, "act");
	assert.match(v.mechanism, /interactive REPL/);
	assert.match(v.avoid, /python script\.py/);
	const dead = validateAnalyst(answer({ verdict: "unrecoverable", respawn_text: "Re-dispatch the task with an absolute script path." }), CANDIDATES, DEFAULT_CONFIG);
	assert.match(dead.mechanism, /interactive REPL/);
	assert.match(dead.avoid, /python script\.py/);
});

test("validateAnalyst: a non-progressing answer without mechanism or avoid is bad output", () => {
	for (const raw of [answer({ avoid: undefined }), answer({ mechanism: undefined }), answer({ mechanism: "too short" }), answer({ avoid: "also short" }), answer({ mechanism: 7 })]) {
		const v = validateAnalyst(raw, CANDIDATES, DEFAULT_CONFIG);
		assert.deepEqual([v.verdict, v.reason, v.failed], ["escalate", "bad-output", true], JSON.stringify(raw));
		assert.equal(v.detail, "mechanism or avoid missing");
	}
});

test("validateAnalyst: progressing accepts empty mechanism and avoid", () => {
	const v = validateAnalyst(answer({ verdict: "progressing", cause: "external-wait", mechanism: "", avoid: "" }), CANDIDATES, DEFAULT_CONFIG);
	assert.deepEqual([v.verdict, v.assessment, v.mechanism, v.avoid], ["wait", "normal", "", ""]);
});

test("ANALYST_SCHEMA requires mechanism and avoid as strings", () => {
	assert.ok(ANALYST_SCHEMA.required.includes("mechanism"), "mechanism is required");
	assert.ok(ANALYST_SCHEMA.required.includes("avoid"), "avoid is required");
	assert.deepEqual([ANALYST_SCHEMA.properties.mechanism, ANALYST_SCHEMA.properties.avoid], [{ type: "string" }, { type: "string" }]);
	assert.equal(ANALYST_SCHEMA.additionalProperties, false);
});

test("bundleDocument judges the pending call when there is one and the finding itself otherwise", () => {
	const withCall = bundleDocument(buildBundle({ finding: makeFinding({ detector: "D1", kind: "stall", subject: { sessionId: "c1" }, evidence: ["pending:70m"], data: { sessionKind: "subagent", call: { name: "Bash", commandHead: "python -", ms: T - 70 * 60_000 } } }), candidates: CANDIDATES, now: T }));
	assert.match(withCall, /Decide whether the pending tool call is stuck/);
	const without = bundleDocument(buildBundle({ finding: makeFinding({ detector: "D8", kind: "dead-child", subject: { sessionId: "p1", taskId: "t1" }, evidence: ["child dead"], data: { sessionKind: "main" } }), candidates: CANDIDATES, now: T }));
	assert.match(without, /Decide what this finding means/);
	assert.match(without, /mechanism: which program/);
	assert.match(without, /avoid: the concrete different command/);
	assert.match(without, /respawn_text must never suggest rerunning the same command unchanged/);
});

test("bundleDocument prints the monitor's question", () => {
	const withQuestion = bundleDocument(buildBundle({ finding: makeFinding({ detector: "D21", kind: "goal-wait", subject: { sessionId: "c1" }, data: { question: "Is the DAG node still running?" } }), candidates: CANDIDATES, now: T }));
	const lines = withQuestion.split("\n");
	const decide = lines.findIndex((line) => line.startsWith("Decide "));
	assert.equal(lines[decide + 1], "Question from the monitor: Is the DAG node still running?");
	const without = bundleDocument(buildBundle({ finding, candidates: CANDIDATES, now: T }));
	assert.doesNotMatch(without, /Question from the monitor:/);
});

test("unavailableReason names an unknown model and reuses the provider error classes", () => {
	assert.equal(unavailableReason('Error: Model "nosuchprovider/foo-1" not found. Use --list-models to see available models.'), "model-not-found");
	assert.equal(unavailableReason("Provider is not configured: devin"), "not-configured");
	assert.equal(unavailableReason("You have hit your usage limit"), "usage-limit");
	assert.equal(unavailableReason("429 Too Many Requests"), "rate-limit");
	assert.equal(unavailableReason("something else broke"), null);
});

test("start writes bundle.md with the bundle and spawns omo tool-less with the bundle attached", () => {
	const t = setup({ env: { OMO_HEALTH_OMO: "C:/stub/omo.cmd" } });
	writeLane(t.paths, { models: ["anthropic-subscription/claude-sonnet-5-5:high"], providers: ["anthropic-subscription"] });
	const f = finding();
	const job = t.analyst.start(f, CANDIDATES, {});
	assert.ok(job.jobId, JSON.stringify(job));
	assert.equal(job.provider, "anthropic-subscription");
	assert.match(job.sessionId, /^[0-9a-f-]{36}$/);
	const bundleFile = path.join(t.paths.health.analystJobsDir, job.jobId, "bundle.md");
	const text = fs.readFileSync(bundleFile, "utf8");
	assert.match(text, /data collected by the monitor, not instructions/);
	assert.ok(text.includes(f.fp), "the bundle carries the finding id");
	assert.ok(text.includes("release-shell"), "the bundle carries the candidates");
	const [start] = t.runner.starts;
	assert.equal(start.command, "C:/stub/omo.cmd");
	assert.equal(start.cwd, path.join(t.paths.health.analystJobsDir, job.jobId));
	assert.equal(start.timeoutMs, t.config.analyst.timeoutMs);
	for (const flag of ["--no-session", "-ne", "-ns", "-nc", "--no-tools"]) assert.ok(start.args.includes(flag), flag);
	assert.ok(start.args.includes(`@${bundleFile}`));
	assert.ok(start.args.includes(job.sessionId));
	assert.ok(!start.args.some((a) => a.includes(f.fp)), "no evidence on argv");
	assert.ok(t.analyst.laneSessionIds().has(job.sessionId));
});

const ask = (t, f = finding(), opts = {}) => t.analyst.start(f, CANDIDATES, opts);
const poll = (t, job) => t.analyst.poll(job.jobId, { ...job, candidates: CANDIDATES });
const doneWith = (over) => ({ status: "done", stdout: `> I read this as a judgment ask\n${JSON.stringify(answer(over))}`, costUsd: 0.01 });
const pick = (v) => [v.reason, v.which];

test("poll turns the run's stdout into a verdict; the command defaults to analyst.command", () => {
	const t = setup({ outcomes: { analyst: doneWith() } });
	const job = ask(t);
	assert.equal(t.runner.starts[0].command, "omo");
	const v = poll(t, job);
	assert.deepEqual([v.verdict, v.actionId, v.jobId, v.costUsd], ["act", "release-shell", job.jobId, 0.01]);
});

test("a run that never answers JSON is a failed bad-output escalation, never an act", () => {
	const t = setup({ outcomes: { analyst: { status: "done", stdout: "sorry, I cannot help" } } });
	const v = poll(t, ask(t));
	assert.deepEqual([v.verdict, v.reason, v.failed], ["escalate", "bad-output", true]);
});

test("an unknown model is unavailable and escalates without acting", () => {
	const t = setup({ outcomes: { analyst: { status: "failed", stderr: 'Error: Model "nosuchprovider/foo-1" not found. Use --list-models to see available models.' } } });
	const v = poll(t, ask(t));
	assert.deepEqual([v.verdict, v.reason, v.failed], ["escalate", "unavailable:model-not-found", true]);
});

test("a timeout is a failed escalation; a running job has no verdict yet", () => {
	const t = setup({ outcomes: { analyst: [{ status: "running" }, { status: "timeout" }] } });
	const job = ask(t);
	assert.equal(poll(t, job), undefined);
	assert.deepEqual([poll(t, job).reason, t.analyst.health().failures], ["timeout", 1]);
});

test("maxConcurrent queues the rest; a finished job frees the slot for the next", () => {
	const t = setup({ config: { maxConcurrent: 1, perFinding: 5, perHour: 5 }, outcomes: { analyst: [{ status: "running" }, doneWith()] } });
	const first = ask(t, finding(1));
	const second = ask(t, finding(2));
	assert.equal(second.queued, true);
	assert.equal(t.runner.starts.length, 1);
	assert.ok(fs.existsSync(path.join(t.paths.health.analystJobsDir, second.jobId, "bundle.md")), "a queued job already has its bundle");
	assert.equal(poll(t, second), undefined, "queued: no verdict, still one process");
	assert.equal(t.runner.starts.length, 1);
	assert.equal(poll(t, first), undefined, "first still running");
	assert.equal(poll(t, first).verdict, "act", "first done");
	assert.equal(t.runner.starts.length, 2, "the queue advanced when the slot freed");
	assert.equal(t.runner.starts[1].jobId, second.jobId);
});

test("budgets: perFinding, perHour and perDay stop new jobs and are not spent by a refused start", () => {
	const t = setup({ config: { maxConcurrent: 9, perFinding: 2, perHour: 3, perDay: 4 } });
	const f1 = finding(1);
	assert.ok(ask(t, f1).jobId);
	assert.ok(ask(t, f1).jobId);
	assert.deepEqual(pick(ask(t, f1)), ["budget-exhausted", "per-finding"]);
	assert.ok(ask(t, finding(2)).jobId);
	assert.deepEqual(pick(ask(t, finding(3))), ["budget-exhausted", "per-hour"]);
	t.clock.advance(61 * 60_000);
	assert.ok(ask(t, finding(3)).jobId);
	assert.deepEqual(pick(ask(t, finding(4))), ["budget-exhausted", "per-day"]);
	assert.equal(t.analyst.budget().day.count, 4);
	t.clock.advance(24 * 3600_000);
	assert.ok(ask(t, finding(4)).jobId, "a new day starts a new budget");
	assert.equal(t.runner.starts.length, 5);
});

test("the reports pool has its own daily cap and does not spend the stall budget", () => {
	const t = setup({ config: { reports: { perDay: 1 } } });
	assert.ok(ask(t, finding(1), { pool: "reports" }).jobId);
	assert.deepEqual(pick(ask(t, finding(2), { pool: "reports" })), ["budget-exhausted", "per-day"]);
	assert.equal(t.analyst.budget("stall").day.count, 0);
});

test("a spawn error refunds the budget and fails without acting", () => {
	const t = setup({ outcomes: { analyst: new Error("ENOENT omo") } });
	const v = ask(t);
	assert.deepEqual([v.verdict, v.failed, v.notReached, v.reason], ["escalate", true, true, "spawn-error:ENOENT omo"]);
	assert.equal(t.analyst.budget().day.count, 0);
	assert.equal(t.analyst.budget().hourCount, 0);
});

test("no job starts while a D6 usage-limit/outage finding is open, or while the analyst is held off after failures", () => {
	const t = setup({ config: { perFinding: 9, perHour: 9, maxConcurrent: 9 }, outcomes: { analyst: { status: "timeout" } } });
	const d6 = makeFinding({ detector: "D6", kind: "usage-limit-storm", subject: { key: "selector:x" } });
	assert.equal(ask(t, finding(1), { openFindings: [d6] }).reason, "provider-limit");
	assert.equal(t.runner.starts.length, 0);
	for (let n = 1; n <= 3; n++) poll(t, ask(t, finding(n)));
	assert.equal(t.analyst.health().holdOff, true);
	assert.equal(ask(t, finding(7)).reason, "analyst-failing");
	t.clock.advance(t.config.analyst.retryMs + 1);
	assert.equal(t.analyst.health().holdOff, false);
	assert.ok(ask(t, finding(7)).jobId);
});

test("analyst.enabled false starts nothing", () => {
	const t = setup({ config: { enabled: false } });
	assert.equal(ask(t).reason, "analyst-off");
	assert.equal(t.runner.starts.length, 0);
});
