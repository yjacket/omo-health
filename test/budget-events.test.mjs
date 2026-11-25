import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { extractEvents } from "../src/budget/events.mjs";
import { E, iso } from "./helpers/fixtures.mjs";

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const BLOCK = '<omo-budget kind="estimate">\n{"v":1,"requestId":"r1"}\n</omo-budget>';

function ctx(over = {}) {
	return {
		sessionId: "s1",
		rootSessionId: "s1",
		taskId: "t1",
		source: "main",
		provider: "anthropic-subscription",
		lineNo: 4,
		projectOf: (ms) => (ms === T0 ? "s1:g1" : null),
		...over,
	};
}

test("audit evidence: reviewer spawns (with their round), verdicts, owner requests, PR links and health notes", () => {
	const spawn = extractEvents(E.assistant({ ms: T0, calls: [
		{ id: "c1", name: "task", args: { subagent_type: "plan-reviewer", name: "plan-review-r19", task_summary: "Plan review r19: ledger fixes" } },
		{ id: "c2", name: "task", args: { subagent_type: "explore", task_summary: "find callers" } },
		{ id: "c3", name: "task", args: { tasks: [{ subagent_type: "omo-native-gate-reviewer", task_summary: "gate review" }] } },
	] }), ctx());
	assert.deepEqual(spawn.evidence.map((e) => [e.kind, e.data.agent, e.data.summary]), [
		["review-spawn", "plan-reviewer", "Plan review r19: ledger fixes"],
		["review-spawn", "omo-native-gate-reviewer", "gate review"],
	]);
	assert.deepEqual(spawn.rounds, [19]);

	const wake = extractEvents({
		type: "custom_message", customType: "omo-senpi:wake", timestamp: iso(T0),
		content: "task completion name:other id:x\ntask completion name:plan-review-r19 id:st_1 agent:plan-reviewer\nresult:\"**[REJECT]** identity\"",
		details: { producerDetails: [{ customType: "senpi-task.completion", details: [
			{ name: "other", agent_type: "explore" },
			{ name: "plan-review-r19", agent_type: "plan-reviewer", model: "chatgpt-subscription/gpt-6.2-astra", status: "completed" },
		] }] },
	}, ctx());
	assert.equal(wake.evidence.length, 1);
	assert.equal(wake.evidence[0].data.model, "chatgpt-subscription/gpt-6.2-astra");
	assert.match(wake.evidence[0].data.text, /^name:plan-review-r19 .*\*\*\[REJECT\]\*\* identity/s);

	const long = `${"skill wrapper ".repeat(500)}OWNER: plan approval is granted`;
	const request = extractEvents(E.user(long, T0), ctx()).evidence[0];
	assert.equal(request.kind, "request");
	assert.ok(request.data.text.length <= 4000);
	assert.ok(request.data.text.endsWith("OWNER: plan approval is granted"), "the tail, where a skill wrapper leaves the owner's words, is kept");

	assert.deepEqual(extractEvents(E.toolResult("c", T0, { text: "pr 0 https://github.com/o/r/pull/21 | ok" }), ctx()).evidence, [{ kind: "pr", data: { url: "https://github.com/o/r/pull/21" } }]);
	assert.deepEqual(extractEvents(E.toolResult("c", T0, { text: "no link" }), ctx()).evidence, []);
	const note = extractEvents({ type: "custom_message", customType: "omo-health", timestamp: iso(T0), content: "[omo-health 범위 점검] long run", details: { kind: "scope-check" } }, ctx()).evidence[0];
	assert.deepEqual(note, { kind: "health-note", data: { kind: "scope-check", text: "[omo-health 범위 점검] long run" } });
});

test("usage id is <session>:<entry.id> when the entry has an id", () => {
	const entry = E.assistant({ ms: T0, id: "e42", text: "ok" });
	const out = extractEvents(entry, ctx());
	assert.equal(out.usage.id, "s1:e42");
	assert.equal(out.usage.ms, T0);
	assert.equal(out.usage.projectId, "s1:g1");
	assert.equal(out.usage.rootSessionId, "s1");
	assert.equal(out.usage.taskId, "t1");
	assert.equal(out.usage.source, "main");
	assert.equal(out.usage.costStatus, "reported");
	assert.equal(out.usage.cost, 0.03);
});

test("usage id falls back to <session>:<ms>:<lineNo> without an entry id", () => {
	const entry = {
		type: "message",
		timestamp: iso(T0),
		message: { role: "assistant", content: [], usage: { input: 1, output: 2, cost: { total: 0.01 } } },
	};
	const out = extractEvents(entry, ctx({ lineNo: 12 }));
	assert.equal(out.usage.id, `s1:${T0}:12`);
	assert.equal(out.usage.input, 1);
	assert.equal(out.usage.output, 2);
});

test("provider comes from model_change and from ctx until then", () => {
	const change = extractEvents({ type: "model_change", provider: "chatgpt-subscription", modelId: "gpt-6-astra" }, ctx());
	assert.equal(change.modelProvider, "chatgpt-subscription");
	assert.deepEqual(change.blocks, []);
	assert.deepEqual(change.rounds, []);
	assert.equal(change.usage, undefined);

	const entry = E.assistant({ ms: T0, text: "hi" });
	delete entry.message.provider;
	const out = extractEvents(entry, ctx({ provider: "chatgpt-subscription" }));
	assert.equal(out.usage.provider, "chatgpt-subscription");

	const own = extractEvents(E.assistant({ ms: T0, text: "hi", provider: "anthropic-subscription" }), ctx());
	assert.equal(own.usage.provider, "anthropic-subscription");
});

test("missing cost => costStatus missing and cost null; zero cost is reported", () => {
	const missing = extractEvents(E.assistant({ ms: T0, usage: { input: 5, output: 6 } }), ctx());
	assert.equal(missing.usage.costStatus, "missing");
	assert.equal(missing.usage.cost, null);
	assert.equal(missing.usage.cacheRead, 0);
	assert.equal(missing.usage.cacheWrite, 0);

	const zero = extractEvents(E.assistant({ ms: T0, usage: { input: 1, output: 1, cost: { total: 0 } } }), ctx());
	assert.equal(zero.usage.costStatus, "reported");
	assert.equal(zero.usage.cost, 0);
});

test("blocks come only from assistant text and not after an error stop", () => {
	const ok = extractEvents(E.assistant({ ms: T0, text: `done\n${BLOCK}` }), ctx());
	assert.deepEqual(ok.blocks, [{ kind: "estimate", body: '{"v":1,"requestId":"r1"}' }]);

	const failed = extractEvents(E.assistant({ ms: T0, text: BLOCK, stopReason: "error" }), ctx());
	assert.deepEqual(failed.blocks, []);

	const aborted = extractEvents(E.assistant({ ms: T0, text: BLOCK, stopReason: "aborted" }), ctx());
	assert.deepEqual(aborted.blocks, []);

	const toolResult = extractEvents(E.toolResult("c1", T0, { text: BLOCK }), ctx());
	assert.deepEqual(toolResult.blocks, []);
});

test("a user message with an <omo-budget> block yields no block and no usage", () => {
	const out = extractEvents(E.user(`please approve\n${BLOCK}`, T0), ctx());
	assert.deepEqual(out.blocks, []);
	assert.deepEqual(out.rounds, []);
	assert.equal(out.usage, undefined);
});

test("rounds come from assistant text and from todo tool-call arguments", () => {
	const text = extractEvents(E.assistant({ ms: T0, text: "26차 QA 결과 확인, 회귀 점검 25 통과, QA round 7 기록" }), ctx());
	assert.deepEqual(text.rounds, [26, 25, 7]);

	const todos = extractEvents(
		E.assistant({
			ms: T0,
			calls: [{ id: "c1", name: "todo", args: { op: "init", list: [{ phase: "QA 2차", items: ["4차 검증"] }] } }],
		}),
		ctx(),
	);
	assert.deepEqual(todos.rounds, [2, 4]);

	const otherTool = extractEvents(
		E.assistant({ ms: T0, calls: [{ id: "c2", name: "eval", args: { summary: "9차 재검증" } }] }),
		ctx(),
	);
	assert.deepEqual(otherTool.rounds, []);
});

test("3차원 is not a round", () => {
	const out = extractEvents(E.assistant({ ms: T0, text: "3차원 벡터와 3차원 좌표를 계산했다" }), ctx());
	assert.deepEqual(out.rounds, []);
});
