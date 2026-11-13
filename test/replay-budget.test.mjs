import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { E, iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { compareExpected, runReplay } from "../src/replay.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Todo 22 part (1): the replay's budget seam. The fixture is built here, not under test/fixtures/ (todo 22 part (2)
// owns the F/N fixtures): one goal, four numbered rounds costing $3 each, so D26's heavy rounds trigger fires.
const MIN = 60_000;
const HOUR = 60 * MIN;
const CLOCK_START = Date.UTC(2026, 9, 20, 9, 0, 0);
const SID = "01a0e000-0022-7000-8000-000000000022";
const PROJECT_ID = `${SID}:goal-budget-22`;

const OPINION = {
	v: 1,
	auditId: "filled-by-the-replay",
	projectId: PROJECT_ID,
	assessment: "waste-likely",
	confidence: 0.85,
	criteriaStatus: "unknown",
	findings: [
		{
			pattern: "repeated-qa-without-acceptance-gain",
			evidence: "rounds 1-4 rerun the same check",
			explanation: "Four rounds spent $12 without new acceptance evidence.",
		},
	],
	advice: "Stop rerunning the same check; finish the remaining criterion and report once when it passes.",
	allocationOpinion: { assessment: "revise", reason: "The remaining work fits a smaller reservation." },
};

/**
 * A minimal fixture directory: one main session with a goal, `rounds` numbered assistant rounds, and a logged-in
 * chatgpt-subscription provider (the default audit model). `budgetEnabled` decides whether meta.config opts into the
 * office at all; `budgetAudit` is the fake audit job's answer.
 */
function makeFixture({ budgetEnabled, rounds = 4, budgetAudit = { result: OPINION, durationMs: 0 } } = {}) {
	const dir = tmpDir("omoh-budget-22-");
	const cwd = path.join(dir, "project");
	const sessionDir = path.join(dir, "omo", "agent", "sessions", "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const goalCreatedMs = CLOCK_START - 2 * HOUR;
	const entries = [E.header(SID, cwd, goalCreatedMs)];
	for (let round = 1; round <= rounds; round++) {
		entries.push(
			E.assistant({
				ms: goalCreatedMs + HOUR + round * 5 * MIN,
				text: `QA round ${round}: the same acceptance check ran again.`,
				usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } },
				provider: "chatgpt-subscription",
				model: "gpt-6-astra",
			}),
		);
	}
	writeJsonl(path.join(sessionDir, `${SID}.jsonl`), entries);
	const goalFile = path.join(sessionDir, "extensions", "goal", `${SID}.json`);
	fs.mkdirSync(path.dirname(goalFile), { recursive: true });
	fs.writeFileSync(
		goalFile,
		JSON.stringify({ id: "goal-budget-22", objective: "Ship the acceptance criterion", status: "active", createdAt: goalCreatedMs / 1000, updatedAt: goalCreatedMs / 1000, completedAt: null }),
	);
	// The audit model's provider must be logged in (auth.json KEYS only; the replay office never reads a value).
	fs.mkdirSync(path.join(dir, "omo", "agent"), { recursive: true });
	fs.writeFileSync(path.join(dir, "omo", "agent", "auth.json"), JSON.stringify({ "chatgpt-subscription": { mode: "oauth" } }));
	const meta = {
		clockStart: iso(CLOCK_START),
		clockEnd: iso(CLOCK_START + 10 * MIN),
		tickMs: MIN,
		// A sensor is what the inbox delivery needs; without one a self-notice is dropped (never toasted).
		sensors: [{ sessionId: SID, pid: 12_345 }],
		config: budgetEnabled ? { budget: { enabled: true } } : {},
		...(budgetAudit ? { budgetAudit } : {}),
	};
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
	return dir;
}

test("replay budget seam: the office starts an audit through the fake runner and the budget-request names its kind", async () => {
	const dir = makeFixture({ budgetEnabled: true });
	const previous = process.env.OMO_HEALTH_OMO;
	// No real model may be launched: the replay's office points at a command that does not exist and still works.
	process.env.OMO_HEALTH_OMO = path.join(dir, "no-such-omo-command.exe");
	try {
		const result = await runReplay(dir);
		const kinds = result.actions.map((a) => a.kind);
		assert.ok(kinds.includes("budget-audit-start"), `budget-audit-start missing from ${kinds.join(", ")}`);
		assert.ok(kinds.includes("budget-audit-end"), `budget-audit-end missing from ${kinds.join(", ")}`);
		assert.equal(result.budgetJobs.length, 1, "one audit job, answered by the fake runner");
		const start = result.actions.find((a) => a.kind === "budget-audit-start");
		assert.equal(start.jobId, result.budgetJobs[0].jobId);
		const args = result.budgetJobs[0].args;
		assert.ok(Array.isArray(args) && args.includes("--no-tools"), "the guarded argv reaches the runner");
		assert.ok(args.some((arg) => String(arg).startsWith("@")), "the bundle is attached as @<file>, never on argv");
		const request = result.actions.find((a) => a.kind === "message:self-notice" && a.actionKind === "budget-request");
		assert.ok(request, "a budget-request self-notice was delivered");
		assert.ok(
			result.sent.some((message) => message.kind === "self-notice" && message.details?.actionKind === "budget-request"),
			"the message really reached the send hook",
		);
		const opinion = result.actions.find((a) => a.kind === "message:self-notice" && a.actionKind === "budget-audit-opinion");
		assert.ok(opinion, "the parsed opinion came back as a message");
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_OMO;
		else process.env.OMO_HEALTH_OMO = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("replay budget seam: without the fixture's own budget.enabled no office exists (the default is true, the fixture opts in)", async () => {
	const dir = makeFixture({ budgetEnabled: false });
	try {
		const result = await runReplay(dir);
		// Rounds and spend are there (a heavy trigger would fire), but no office means no budget actor at all.
		const budgetActions = result.actions.filter((a) => String(a.kind).startsWith("budget-") || String(a.actionKind ?? "").startsWith("budget-"));
		assert.deepEqual(budgetActions, []);
		assert.deepEqual(result.budgetJobs, []);
		assert.equal(result.sent.length, 0, "no budget messages either");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("replay budget seam: an audit that fails ends with budget-audit-end and no opinion message", async () => {
	const dir = makeFixture({ budgetEnabled: true, budgetAudit: { durationMs: 0, status: "failed", reason: "exit-1" } });
	try {
		const result = await runReplay(dir);
		const kinds = result.actions.map((a) => a.kind);
		assert.ok(kinds.includes("budget-audit-start"));
		assert.ok(kinds.includes("budget-audit-end"));
		assert.equal(result.actions.some((a) => a.actionKind === "budget-audit-opinion"), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("replay F14-budget-rounds: its expected.json requires the message actionKind", async () => {
	const dir = path.join(FIXTURES, "F14-budget-rounds");
	const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
	const previous = process.env.OMO_HEALTH_OMO;
	process.env.OMO_HEALTH_OMO = path.join(dir, "no-such-omo-command.exe");
	try {
		const result = await runReplay(dir);
		assert.deepEqual(compareExpected(result, expected), [], "the shipped fixture passes as written");
		const wrongKind = { ...expected, actions: expected.actions.map((a) => (a.actionKind ? { ...a, actionKind: "wrong-kind" } : a)) };
		const problems = compareExpected(result, wrongKind);
		assert.ok(problems.length > 0, "a wrong actionKind must not match");
		assert.ok(problems.every((problem) => /^missing action .*wrong-kind/.test(problem)), JSON.stringify(problems));
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_OMO;
		else process.env.OMO_HEALTH_OMO = previous;
	}
});
