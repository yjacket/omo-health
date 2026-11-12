import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { extractBlocks, validateBlock } from "../src/budget/protocol.mjs";

const PROJECT = "sess-1:goal-1";
const REVISION = 3;
const CTX = { projectId: PROJECT, revision: REVISION };

function estimate(over = {}) {
	return {
		v: 1,
		requestId: "req-001",
		projectId: PROJECT,
		baseRevision: REVISION,
		remainingUsd: { p10: 4, p50: 6, p90: 9 },
		workClass: "implementation",
		basis: {
			workUnits: [{ description: "port the parser", count: 2 }],
			assumptions: ["no new dependencies"],
		},
		nextCheckpoint: "after the parser test passes",
		...over,
	};
}

function change(over = {}) {
	return {
		...estimate({ requestId: "req-002" }),
		reason: "new-evidence",
		justification: "the last QA round exposed a second entry point that must be handled too",
		alternatives: [
			{ description: "skip the second entry point", remainingUsd: { p10: 2, p50: 3, p90: 5 }, tradeoff: "fails QA" },
		],
		...over,
	};
}

function body(kind, obj) {
	return `<omo-budget kind="${kind}">\n${JSON.stringify(obj, null, 2)}\n</omo-budget>`;
}

function assertOk(result) {
	assert.equal(result.ok, true, JSON.stringify(result.errors));
}

function assertErrors(result, pattern) {
	assert.equal(result.ok, false);
	assert.ok(result.errors.length > 0, "at least one error");
	assert.ok(
		result.errors.some((error) => pattern.test(error)),
		`no error matching ${pattern}: ${JSON.stringify(result.errors)}`,
	);
}

test("valid estimate passes and the value is the parsed block", () => {
	const result = validateBlock("estimate", estimate(), CTX);
	assertOk(result);
	assert.equal(result.value.projectId, PROJECT);
	assert.deepEqual(result.value.remainingUsd, { p10: 4, p50: 6, p90: 9 });
});

test("valid change passes", () => {
	assertOk(validateBlock("change", change(), CTX));
});

test("unknown keys are rejected at the root and at every nested level", () => {
	assertErrors(validateBlock("estimate", { ...estimate(), extra: 1 }, CTX), /unknown key "extra"/);
	assertErrors(
		validateBlock("estimate", estimate({ basis: { ...estimate().basis, extra: 1 } }), CTX),
		/basis: unknown key "extra"/,
	);
	assertErrors(
		validateBlock("estimate", estimate({ remainingUsd: { p10: 4, p50: 6, p90: 9, p95: 12 } }), CTX),
		/remainingUsd: unknown key "p95"/,
	);
	assertErrors(
		validateBlock("change", change({ alternatives: [{ ...change().alternatives[0], extra: 1 }] }), CTX),
		/alternatives\[0\]: unknown key "extra"/,
	);
});

test("blocks inside a fenced example are ignored", () => {
	const text = [
		"Here is the shape of the block:",
		"```json",
		body("estimate", estimate()),
		"```",
		"Nothing to send this turn.",
	].join("\n");
	assert.deepEqual(extractBlocks(text), []);
});

test("wrong projectId is rejected", () => {
	assertErrors(
		validateBlock("estimate", estimate({ projectId: "sess-other:goal-9" }), CTX),
		/projectId must equal/,
	);
});

test("wrong revision is rejected", () => {
	assertErrors(validateBlock("estimate", estimate({ baseRevision: REVISION + 1 }), CTX), /baseRevision must equal current revision/);
	assertErrors(validateBlock("change", change({ baseRevision: 0 }), CTX), /baseRevision must equal current revision 3/);
});

test("a body over 8192 characters is not a block", () => {
	const text = body("estimate", estimate({ basis: { workUnits: [{ description: "x".repeat(9000), count: 1 }], assumptions: [] } }));
	assert.ok(text.length > 8192);
	assert.deepEqual(extractBlocks(text), []);
});

test("an oversized object is rejected by the validator too", () => {
	assertErrors(validateBlock("estimate", estimate({ padding: "x".repeat(9000) }), CTX), /8192/);
});

test("quantiles must be finite and ordered p10 <= p50 <= p90", () => {
	assertErrors(
		validateBlock("estimate", estimate({ remainingUsd: { p10: 5, p50: 3, p90: 9 } }), CTX),
		/remainingUsd: p10 must be <= p50/,
	);
	assertErrors(
		validateBlock("estimate", estimate({ remainingUsd: { p10: 4, p50: 6, p90: 100001 } }), CTX),
		/remainingUsd\.p90/,
	);
	assertErrors(
		validateBlock("change", change({ alternatives: [{ description: "a", remainingUsd: { p10: 9, p50: 2, p90: 3 }, tradeoff: "b" }] }), CTX),
		/alternatives\[0\]\.remainingUsd/,
	);
});

test("reason must be one of the five enum values", () => {
	assertErrors(validateBlock("change", change({ reason: "because" }), CTX), /reason must be one of/);
	for (const reason of ["estimate-error", "new-evidence", "external-blocker", "owner-scope-change", "model-mix-change"]) {
		assertOk(validateBlock("change", change({ reason }), CTX));
	}
});

test("two blocks in one text are both extracted", () => {
	const text = [
		"First reply.",
		body("estimate", estimate()),
		"Middle prose that is not part of either block.",
		body("change", change()),
		"Last line.",
	].join("\n");
	const blocks = extractBlocks(text);
	assert.equal(blocks.length, 2);
	assert.deepEqual(blocks.map((block) => block.kind), ["estimate", "change"]);
	assert.equal(JSON.parse(blocks[0].body).requestId, "req-001");
	assert.equal(JSON.parse(blocks[1].body).reason, "new-evidence");
});

test("QA failure: p10 5 > p50 3 returns ok:false naming remainingUsd", () => {
	const blocks = extractBlocks(body("estimate", estimate({ remainingUsd: { p10: 5, p50: 3, p90: 9 } })));
	assert.equal(blocks.length, 1);
	const result = validateBlock(blocks[0].kind, JSON.parse(blocks[0].body), CTX);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => error.includes("remainingUsd")), JSON.stringify(result.errors));
});
