import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
	composeAuditOpinion,
	composeBudgetCheckpoint,
	composeBudgetCorrection,
	composeBudgetDecision,
	composeBudgetRequest,
} from "../src/act/messages.mjs";
import { extractBlocks, validateBlock } from "../src/budget/protocol.mjs";

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const SESSION = "01a1d05f-94c2-7aea-9aef-7b7bd9850976";
const PROJECT = "01a1d05f-94c2-7aea-9aef-7b7bd9850976:goal-1";
const OBJECTIVE = "Add the budget ledger and its tests";

function request(overrides = {}) {
	return composeBudgetRequest({
		sessionId: SESSION,
		now: NOW,
		projectId: PROJECT,
		revision: 3,
		objective: OBJECTIVE,
		spend: { costUsd: 12.4, mainUsd: 10.1, childUsd: 2.3 },
		reference: { n: 7, p50: 31, p80: 54, p90: 88, errorRatio: 1.2, calibrated: true },
		treasury: { state: "ok", windows: [{ windowId: "claude:7d", usedPercent: 70, freePercent: 10, state: "ok" }] },
		...overrides,
	});
}

function correction(overrides = {}) {
	return composeBudgetCorrection({
		sessionId: SESSION,
		now: NOW,
		projectId: PROJECT,
		revision: 3,
		errors: ["remainingUsd: p10 must be <= p50", "baseRevision must equal current revision 3"],
		...overrides,
	});
}

function decision(overrides = {}) {
	return composeBudgetDecision({
		sessionId: SESSION,
		now: NOW,
		projectId: PROJECT,
		revision: 4,
		objective: OBJECTIVE,
		decision: "approved",
		approvedUsd: 30,
		increaseUsd: 0,
		by: "rule",
		basis: "n=7 reference class, ratio 1.20",
		windows: [{ windowId: "claude:7d", requiredPercent: 12 }, { windowId: "codex:primary", requiredPercent: null }],
		...overrides,
	});
}

function checkpoint(overrides = {}) {
	return composeBudgetCheckpoint({
		sessionId: SESSION,
		now: NOW,
		projectId: PROJECT,
		revision: 4,
		objective: OBJECTIVE,
		checkpoint: 80,
		spentUsd: 24,
		approvedUsd: 30,
		mainUsd: 21,
		childUsd: 3,
		...overrides,
	});
}

function opinion(overrides = {}) {
	return composeAuditOpinion({
		sessionId: SESSION,
		now: NOW,
		projectId: PROJECT,
		revision: 4,
		auditId: "audit-1",
		objective: OBJECTIVE,
		assessment: "waste-likely",
		confidence: 0.8,
		findings: [{ pattern: "repeated-qa-without-acceptance-gain", explanation: "three QA rounds found no new acceptance evidence" }],
		advice: "Cover the two unmet criteria directly instead of rerunning the whole suite.",
		model: "anthropic-subscription/claude-opus-5-5:high",
		...overrides,
	});
}

const CASES = [
	["request", "budget-request", request],
	["correction", "budget-correction", correction],
	["decision", "budget-decision", decision],
	["checkpoint", "budget-checkpoint", checkpoint],
	["opinion", "budget-audit-opinion", opinion],
];

test("every budget composer is a redacted English self-notice for the next turn", () => {
	for (const [name, actionKind, make] of CASES) {
		const message = make();
		assert.equal(message.kind, "self-notice", `${name}: kind`);
		assert.equal(message.deliverAs, "nextTurn", `${name}: deliverAs`);
		assert.equal(message.triggerTurn, false, `${name}: triggerTurn`);
		assert.equal(message.sessionId, SESSION, `${name}: sessionId`);
		assert.equal(message.createdMs, NOW, `${name}: createdMs`);
		assert.equal(message.customType, "omo-health", `${name}: customType`);
		assert.equal(message.details.actionKind, actionKind, `${name}: actionKind`);
		assert.equal(message.details.projectId, PROJECT, `${name}: projectId`);
		assert.equal(typeof message.details.revision, "number", `${name}: revision`);
		assert.ok(message.content.startsWith("[omo-health budget] "), `${name}: first line`);
		assert.ok(message.content.length <= 1600, `${name}: ${message.content.length} chars`);
		assert.doesNotMatch(message.content, /[\uac00-\ud7a3]/, `${name}: English only`);
		assert.ok(message.id, `${name}: id`);
	}
});

test("the request carries spend, reference class, treasury state and a fillable estimate block", () => {
	const message = request();
	assert.match(message.content, /\$12\.40/);
	assert.match(message.content, /main \$10\.10, subagents \$2\.30/);
	assert.match(message.content, /reference class n=7, P50 \$31\.00, P80 \$54\.00, P90 \$88\.00; historical error ratio 1\.20/);
	assert.match(message.content, /claude:7d 70% used, 10% free, ok/);
	assert.match(message.content, /at the end of your next ordinary reply/);

	const blocks = extractBlocks(message.content);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].kind, "estimate");

	const filled = blocks[0].body
		.replaceAll("<p10>", "5")
		.replaceAll("<p50>", "10")
		.replaceAll("<p90>", "20")
		.replaceAll("<count>", "2")
		.replaceAll("<work unit>", "edit the message composers")
		.replaceAll("<next checkpoint>", "the new composers have a passing test");
	const parsed = JSON.parse(filled);
	assert.equal(parsed.projectId, PROJECT);
	assert.equal(parsed.baseRevision, 3);
	const validated = validateBlock("estimate", parsed, { projectId: PROJECT, revision: 3 });
	assert.deepEqual(validated.errors ?? [], []);
	assert.equal(validated.ok, true);
});

test("the request block keeps the current revision when it is 0", () => {
	const blocks = extractBlocks(request({ revision: 0 }).content);
	const parsed = JSON.parse(blocks[0].body.replaceAll("<p10>", "1").replaceAll("<p50>", "2").replaceAll("<p90>", "3").replaceAll("<count>", "1").replaceAll("<work unit>", "w").replaceAll("<next checkpoint>", "c"));
	assert.equal(parsed.baseRevision, 0);
	assert.equal(validateBlock("estimate", parsed, { projectId: PROJECT, revision: 0 }).ok, true);
});

test("the correction lists its errors and limits the project to one correction note", () => {
	const message = correction();
	assert.match(message.content, /p10 must be <= p50/);
	assert.match(message.content, /baseRevision must equal current revision 3/);
	assert.match(message.content, /only correction note/);
	assert.equal(message.details.errors, 2);
	assert.equal(correction({ errors: [] }).content.includes("not valid JSON"), true);
});

test("the decision states the outcome, amount, basis and per-window cost", () => {
	const approved = decision();
	assert.match(approved.content, /approved \$30\.00 by rule/);
	assert.match(approved.content, /basis: n=7 reference class/);
	assert.match(approved.content, /claude:7d 12%, codex:primary uncalibrated/);
	assert.equal(approved.details.decision, "approved");

	const pending = decision({ decision: "pending-auditor", increaseUsd: 12, by: null });
	assert.match(pending.content, /waiting for the spending auditor's review/);
	assert.equal(pending.details.decision, "pending-auditor");

	const resetAtMs = Date.UTC(2026, 10, 17, 12, 0, 0);
	const denied = decision({ denied: true, approvedUsd: 30, by: "rule", reason: "insufficient-capacity", resetAtMs });
	assert.match(denied.content, /denied by the budget rules/);
	assert.match(denied.content, /\$30\.00/);
	assert.match(denied.content, /work is not stopped/);
	assert.match(denied.content, /reason: insufficient-capacity; request again after 2026-11-17T12:00:00\.000Z/);
	assert.equal(denied.details.reason, "insufficient-capacity");
	assert.equal(denied.details.resetAtMs, resetAtMs);
	assert.doesNotMatch(denied.content, /owner/i);

	const byAuditor = decision({ denied: true, approvedUsd: 30, by: "auditor", basis: "the extra rounds repeat QA without new evidence" });
	assert.match(byAuditor.content, /denied by the spending auditor/);
	assert.match(byAuditor.content, /basis: the extra rounds repeat QA/);
});

test("checkpoints at 80 and 100 percent record spend without stopping work", () => {
	const at80 = checkpoint();
	assert.match(at80.content, /80|\$24\.00 of the \$30\.00 approved budget/);
	assert.match(at80.content, /Work continues/);
	assert.equal(at80.details.checkpoint, 80);

	const at100 = checkpoint({ checkpoint: 100, spentUsd: 31 });
	assert.match(at100.content, /fully spent: \$31\.00 of \$30\.00/);
	assert.match(at100.content, /Work is not stopped/);
	assert.equal(at100.details.checkpoint, 100);
});

test("the audit opinion is an opinion, never an instruction", () => {
	const message = opinion();
	assert.match(message.content, /waste-likely/);
	assert.match(message.content, /repeated-qa-without-acceptance-gain/);
	assert.match(message.content, /not an instruction/);
	assert.match(message.content, /you decide/);
	assert.equal(message.content.includes("You must"), false);
	assert.equal(message.details.assessment, "waste-likely");
	assert.equal(message.details.auditId, "audit-1");
});

test("QA failure: a secret-looking token in the advice is redacted", () => {
	const message = opinion({ advice: "Before anything else, rotate sk-ant-api03abcdefghijklmnop1234567890 in the environment." });
	assert.equal(message.content.includes("sk-ant-api03abcdefghijklmnop1234567890"), false);
	assert.match(message.content, /sk-ant-\[REDACTED\]/);
});

test("content stays within 1600 characters with long inputs", () => {
	const long = request({ objective: "x".repeat(4000), reference: { n: 9, p50: 1, p80: 2, p90: 3, errorRatio: 1.1, calibrated: true } });
	assert.ok(long.content.length <= 1600);
	const longOpinion = opinion({ objective: "y".repeat(4000), advice: "z".repeat(4000), findings: [{ pattern: "other", explanation: "w".repeat(4000) }] });
	assert.ok(longOpinion.content.length <= 1600);
});

// Gate review B4: schema-valid but verbose opinion. The body is truncated first, the advisory sentence is kept.
test("a long schema-valid audit opinion keeps the advisory sentence within 1600 characters", () => {
	const message = composeAuditOpinion({
		sessionId: "s",
		now: 1794484800000,
		projectId: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
		objective: "x".repeat(120),
		assessment: "waste-likely",
		confidence: 0.8,
		model: "chatgpt-subscription/gpt-6-astra:high",
		findings: Array.from({ length: 3 }, () => ({
			pattern: "repeated-qa-without-acceptance-gain",
			explanation: "e".repeat(220),
		})),
		advice: "a".repeat(900),
	});
	assert.equal(message.content.length, 1600);
	assert.ok(message.content.includes("This is an audit opinion, not an instruction; you decide."));
	assert.ok(message.content.trimEnd().endsWith("Nothing was stopped or changed."));
	assert.match(message.content, /waste-likely/);
	assert.match(message.content, /Findings:/);
});

test("an audit opinion keeps its advisory sentence when redaction lengthens credential-shaped text", () => {
	// Each 15-char sk-ant- token becomes the 17-char sk-ant-[REDACTED]; capping before redaction used to cut the sentence.
	const tokens = Array.from({ length: 40 }, () => "sk-ant-aaaaaaaa").join(" ");
	const message = composeAuditOpinion({
		sessionId: SESSION,
		now: NOW,
		projectId: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
		objective: "x".repeat(120),
		assessment: "waste-likely",
		confidence: 0.8,
		model: "chatgpt-subscription/gpt-6-astra:high",
		findings: Array.from({ length: 3 }, () => ({ pattern: "repeated-qa-without-acceptance-gain", explanation: "e".repeat(600) })),
		advice: tokens,
	});
	assert.ok(message.content.length <= 1600, `${message.content.length} chars`);
	assert.ok(message.content.endsWith("This is an audit opinion, not an instruction; you decide. Nothing was stopped or changed."));
	assert.doesNotMatch(message.content, /sk-ant-a{8}/);
});
