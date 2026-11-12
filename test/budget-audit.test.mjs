import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
	AUDIT_INSTRUCTION,
	AUDIT_QUESTION,
	MAX_BUNDLE_CHARS,
	MAX_RECENT_STEP_CHARS,
	auditArgs,
	buildBundle,
	chooseModel,
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
	v: 1,
	auditId: "audit-1",
	projectId: "sess-1:goal-1",
	assessment: "justified",
	confidence: 0.8,
	criteriaStatus: "apparently-met",
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

	const bundle = buildBundle({ recentSteps, userRequests: ["request one", "request two", "request three", "request four"] });
	assert.ok(!bundle.includes("abcdefgh12345"), "the token value must not survive");
	assert.ok(bundle.includes("sk-ant-[REDACTED]"));
	assert.ok(bundle.includes("step-99"));
	assert.ok(!bundle.includes("step-39"), "only the last 60 steps reach the bundle");
	assert.ok(!bundle.includes("request one"), "only the last three user requests reach the bundle");

	const steps = bundle.split("\n").filter((line) => line.startsWith("- step-"));
	assert.equal(steps.length, 60);
	assert.ok(steps.every((line) => line.length <= MAX_RECENT_STEP_CHARS + 2));
});

test("AUDIT_QUESTION names the required waste patterns and the cheaper-path ask", () => {
	for (const phrase of ["acceptance criteria", "new acceptance evidence", "severity inflation", "cheaper path", "insufficient"]) {
		assert.ok(AUDIT_QUESTION.includes(phrase), `question misses ${phrase}`);
	}
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

test("chooseModel skips not-logged-in and short accounts", () => {
	const models = ["anthropic-subscription/claude-opus-5-5:high", "chatgpt-subscription/gpt-6-astra:high"];
	const states = { "anthropic-subscription/default": "short", "chatgpt-subscription/default": "ok" };
	const chosen = chooseModel({
		models,
		loggedIn: new Set(["anthropic-subscription", "chatgpt-subscription"]),
		accountState: (account) => states[account],
	});
	assert.equal(chosen, "chatgpt-subscription/gpt-6-astra:high");

	assert.equal(chooseModel({ models, loggedIn: new Set(), accountState: () => "ok" }), null);
	assert.equal(
		chooseModel({ models: [models[0]], loggedIn: new Set(["anthropic-subscription"]), accountState: () => "short" }),
		null,
	);
	// A provider without a subscription account has no window that could be short.
	assert.equal(
		chooseModel({ models: ["opengateway/cheap"], loggedIn: new Set(["opengateway"]), accountState: () => "short" }),
		"opengateway/cheap",
	);
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
