import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
	AUDIT_INSTRUCTION,
	AUDIT_QUESTION,
	MAX_BUNDLE_CHARS,
	MAX_RECENT_STEP_CHARS,
	auditArgs,
	auditModel,
	buildBundle,
	buildDigestInput,
	digestArgs,
	parseOutput,
	validateOpinion,
} from "../src/budget/audit.mjs";
import { GUARD_FLAGS } from "../src/judge/lane.mjs";

// json-mode event shape verified from senpi:
// - dist/modes/print-mode.js:120-122 writes one `JSON.stringify(toJsonEvent(event))` line per session event
//   (the session header is written the same way at dist/modes/print-mode.js:132-135);
// - dist/modes/json-event.js:100-104 passes every non-`message_update` event through unchanged, so the
//   terminal event is `{type:"message_end", message}`;
// - dist/core/agent-session.js:6702 emits exactly that `{type:"message_end", message: appMessage}`.
const OPINION = {
	v: 2,
	auditId: "audit-1",
	projectId: "sess-1:goal-1",
	assessment: "justified",
	confidence: 0.8,
	criteriaStatus: "apparently-met",
	situation: "Four rounds, each adding acceptance evidence.",
	criteria: [{ criterion: "parser handles nested lists", origin: "owner", status: "unmet", judgment: "the owner asked for it; round 4 is closing it" }],
	counterevidence: "round 3 repeated a check",
	decides: [{ who: "agent", what: "continue with the current approach" }],
	findings: [{ pattern: "other", evidence: "round 4 in the table", explanation: "each round added new acceptance evidence" }],
	advice: "Continue with the current approach; spending tracks new acceptance evidence rather than repeated checking.",
	allocationOpinion: { assessment: "support", reason: "the remaining estimate is inside the approved budget" },
};

test("buildBundle caps at 60000 chars and redacts recent steps", () => {
	const recentSteps = Array.from({ length: 100 }, (_, index) => `step-${index} ${"x".repeat(400)}`);
	recentSteps[99] = "step-99 ran with sk-ant-abcdefgh12345 inside the shell";
	const capped = buildBundle({
		project: { id: "sess-1:goal-1", objective: "y".repeat(100_000), status: "approved" },
		goal: { objective: "finish the parser" },
		criteria: { total: 3, evidenced: 1 },
		rounds: [{ round: 1, firstMs: Date.UTC(2026, 10, 12), costUsd: 4.5 }],
		recentSteps,
		userRequests: ["request one"],
	});
	assert.ok(capped.length <= MAX_BUNDLE_CHARS, `bundle is ${capped.length} chars`);

	const longRequest = `owner asked: ${"r".repeat(3000)} keep it simple`;
	const bundle = buildBundle({ recentSteps, userRequests: [{ ms: Date.UTC(2026, 10, 21), text: longRequest }, { text: "request two" }] });
	assert.ok(!bundle.includes("abcdefgh12345"), "the token value must not survive");
	assert.ok(bundle.includes("sk-ant-[REDACTED]"));
	assert.ok(bundle.includes("step-99"));
	assert.ok(!bundle.includes("step-39"), "only the last 60 steps reach the bundle");
	assert.ok(bundle.includes(longRequest), "an owner request reaches the bundle verbatim, not cut to 300 characters");
	assert.ok(bundle.includes("(2026-11-21T00:00:00.000Z)"));
	assert.ok(bundle.indexOf("## Recent steps") > bundle.indexOf("## Reviewer runs"), "steps go last so the cap cuts them first");

	const steps = bundle.split("\n").filter((line) => line.startsWith("- step-"));
	assert.equal(steps.length, 60);
	assert.ok(steps.every((line) => line.length <= MAX_RECENT_STEP_CHARS + 2));
});

test("buildBundle carries reviewer verdicts, delivery, notes and earlier opinions", () => {
	const bundle = buildBundle({
		goal: { objective: "criterion 1: a plan-reviewer unconditional approval receipt exists" },
		criteria: { total: 2, evidenced: 1, allEvidencedMs: null, items: [{ goal: "Delivery", id: "C001", scenario: "PR open", status: "pass", evidenced: true }] },
		reviews: { spawns: 107, verdictTotal: 107, verdicts: [{ ms: Date.UTC(2026, 10, 22, 8), agent: "plan-reviewer", model: "chatgpt-subscription/gpt-6.2-astra", status: "completed", text: "name:r30 result:**[REJECT]** session identity" }] },
		delivered: { prUrl: "https://github.com/o/r/pull/21", firstSeen: "2026-11-22T06:16:08.481Z", spentAfterUsd: 413 },
		healthNotes: [{ ms: Date.UTC(2026, 10, 22, 6), kind: "scope-check", text: "long-run note" }],
		earlierAudits: [{ ms: 1, model: "m", assessment: "justified", advice: "keep going" }],
	});
	for (const part of ["plan-reviewer unconditional approval", "107 reviewer spawns", "**[REJECT]** session identity", "gpt-6.2-astra", "pull/21", "\"spentAfterUsd\": 413", "long-run note", "keep going", "\"C001\""]) {
		assert.ok(bundle.includes(part), `bundle misses ${part}`);
	}
});

test("AUDIT_QUESTION asks about criterion origin, feasibility and who may relax a criterion", () => {
	for (const phrase of ["acceptance criterion", "owner request", "requirement-level", "remaining allowance", "narrowed or dropped", "agent-added criterion", "owner-given criterion", "severity inflation", "insufficient", "never an instruction"]) {
		assert.ok(AUDIT_QUESTION.includes(phrase), `question misses ${phrase}`);
	}
});

test("validateOpinion rejects a v2 opinion with a bad criterion origin or no decider", () => {
	const origin = validateOpinion({ ...OPINION, criteria: [{ ...OPINION.criteria[0], origin: "reviewer" }] }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(origin.ok, false);
	assert.ok(origin.errors.some((error) => error.startsWith("opinion.criteria[0].origin")), JSON.stringify(origin.errors));
	const decides = validateOpinion({ ...OPINION, decides: [] }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(decides.ok, false);
	assert.ok(decides.errors.some((error) => error.startsWith("opinion.decides")), JSON.stringify(decides.errors));
	assert.equal(validateOpinion({ ...OPINION, v: 1 }, { auditId: "audit-1", projectId: "sess-1:goal-1" }).ok, false);
});

test("validateOpinion accepts a complete strict opinion", () => {
	const result = validateOpinion(OPINION, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.value, OPINION);
});

test("validateOpinion rejects waste-likely without findings", () => {
	const result = validateOpinion({ ...OPINION, assessment: "waste-likely", findings: [] }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => error.includes("findings")), JSON.stringify(result.errors));
});

test("validateOpinion rejects unknown keys at the top level and inside a finding", () => {
	const top = validateOpinion({ ...OPINION, extra: true }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(top.ok, false);
	assert.ok(top.errors.includes("opinion.extra: unknown key"), JSON.stringify(top.errors));

	const nested = validateOpinion(
		{ ...OPINION, findings: [{ ...OPINION.findings[0], note: "extra" }] },
		{ auditId: "audit-1", projectId: "sess-1:goal-1" },
	);
	assert.equal(nested.ok, false);
	assert.ok(nested.errors.includes("opinion.findings[0].note: unknown key"), JSON.stringify(nested.errors));
});

test("validateOpinion enforces advice length and identity", () => {
	const short = validateOpinion({ ...OPINION, advice: "too short" }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(short.ok, false);
	assert.ok(short.errors.some((error) => error.startsWith("opinion.advice")));

	const long = validateOpinion({ ...OPINION, advice: "a".repeat(1201) }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(long.ok, false);
	assert.ok(long.errors.some((error) => error.startsWith("opinion.advice")));

	const wrong = validateOpinion({ ...OPINION, auditId: "other" }, { auditId: "audit-1", projectId: "sess-1:goal-1" });
	assert.equal(wrong.ok, false);
	assert.ok(wrong.errors.some((error) => error.includes("does not match")));
});

test("auditModel is the main session family's top model at the tier's effort, or null when that family cannot run", () => {
	const topModels = { claude: "anthropic-subscription/claude-fable-5-2", gpt: "chatgpt-subscription/gpt-6.2-astra" };
	const efforts = ["high", "xhigh", "max"];
	const loggedIn = new Set(["anthropic-subscription", "chatgpt-subscription"]);
	const pick = (mainModel, tier, extra = {}) => auditModel({ topModels, efforts, mainModel, tier, loggedIn, ...extra });
	assert.deepEqual([1, 2, 3].map((tier) => pick("claude-opus-5-5", tier)), ["anthropic-subscription/claude-fable-5-2:high", "anthropic-subscription/claude-fable-5-2:xhigh", "anthropic-subscription/claude-fable-5-2:max"]);
	assert.equal(pick("gpt-6-astra", 2), "chatgpt-subscription/gpt-6.2-astra:xhigh");
	// The family's own account short or logged out: deferred, never handed to another family.
	assert.equal(pick("gpt-6-astra", 1, { accountState: (a) => (a.startsWith("chatgpt") ? "short" : "ok") }), null);
	assert.equal(pick("claude-opus-5-5", 1, { loggedIn: new Set(["chatgpt-subscription"]) }), null);
	assert.equal(pick("deepseek-v4", 1), null, "a family with no top model");
	assert.equal(pick(null, 1), null);
});

test("the digest reads the raw verdicts, notes and steps with every guard flag; the bundle with a digest drops them", () => {
	const reviews = { spawns: 3, verdictTotal: 3, verdicts: [{ agent: "plan-reviewer", model: "m", status: "completed", text: "**[REJECT]** edge" }] };
	const input = buildDigestInput({ reviews, healthNotes: [{ kind: "scope-check", text: "note sk-ant-abcdefgh12345" }], recentSteps: ["edit a.mjs"] });
	for (const part of ["# Raw evidence", "**[REJECT]** edge", "note sk-ant-[REDACTED]", "- edit a.mjs"]) assert.ok(input.includes(part), `digest input misses ${part}`);
	assert.ok(!input.includes("## Question"), "the digest never sees the audit question");
	const args = digestArgs({ model: "opengateway/q:low", inputFile: "raw.md" });
	for (const flag of GUARD_FLAGS) assert.ok(args.includes(flag), flag);
	const withDigest = buildBundle({ reviews, digest: "SUMMARY text", recentSteps: ["edit a.mjs"] });
	assert.ok(withDigest.includes("SUMMARY text") && withDigest.includes("3 reviewer spawns"));
	assert.ok(!withDigest.includes("**[REJECT]** edge") && !withDigest.includes("## Recent steps"));
});

test("auditArgs carries json mode and every guard flag", () => {
	const args = auditArgs({ model: "chatgpt-subscription/gpt-6-astra:high", bundleFile: "C:/tmp/jobs/a1/bundle.md" });
	assert.equal(args[0], "-p");
	assert.deepEqual(args.slice(1, 3), ["--mode", "json"]);
	for (const flag of GUARD_FLAGS) assert.ok(args.includes(flag), `missing guard flag ${flag}`);
	assert.ok(args.includes("chatgpt-subscription/gpt-6-astra:high"));
	assert.ok(args.includes("@C:/tmp/jobs/a1/bundle.md"));
	assert.equal(args.at(-1), AUDIT_INSTRUCTION);
	assert.throws(() => auditArgs({ bundleFile: "b.md" }), /model is required/);
});

test("parseOutput extracts the final assistant text and reported usage cost", () => {
	const stdout = [
		JSON.stringify({ type: "session", version: 3, id: "audit-session" }),
		JSON.stringify({ type: "message_update", usage: { input: 1 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "{\"v\":" } }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "chatgpt-subscription",
				model: "gpt-6-astra",
				content: [{ type: "text", text: JSON.stringify(OPINION) }],
				usage: { input: 120, output: 80, cacheRead: 4000, cacheWrite: 200, cost: { total: 0.125 } },
			},
		}),
	].join("\n");

	const parsed = parseOutput(stdout);
	assert.equal(parsed.opinionText, JSON.stringify(OPINION));
	assert.equal(parsed.usage.cost, 0.125);
	assert.equal(parsed.usage.costStatus, "reported");
	assert.deepEqual(
		{ input: parsed.usage.input, output: parsed.usage.output, cacheRead: parsed.usage.cacheRead, cacheWrite: parsed.usage.cacheWrite },
		{ input: 120, output: 80, cacheRead: 4000, cacheWrite: 200 },
	);
	assert.equal(parsed.model, "chatgpt-subscription/gpt-6-astra");
});

test("parseOutput marks a usage without cost as missing", () => {
	const stdout = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "anthropic-subscription",
			model: "claude-opus-5-5",
			content: [{ type: "text", text: "{\"v\":1}" }],
			usage: { input: 10, output: 2 },
		},
	});
	const parsed = parseOutput(stdout);
	assert.equal(parsed.usage.cost, null);
	assert.equal(parsed.usage.costStatus, "missing");
	assert.equal(parsed.usage.cacheRead, 0);
});

test("parseOutput on plain text returns the text and no usage (QA failure scenario)", () => {
	const stdout = "The evidence looks fine.\nNo JSON events here.\n";
	assert.deepEqual(parseOutput(stdout), { opinionText: "The evidence looks fine.\nNo JSON events here.", usage: null, model: null });
});
