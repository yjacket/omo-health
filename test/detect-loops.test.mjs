import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/loops.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;

const call = (i, ms, name = "read", argsHash = "h-read-a") => ({ id: `call${i}`, ms, name, argsHash, isError: false, errHead: undefined });
const calls = (n, stepMs, name, hash) => Array.from({ length: n }, (_, i) => call(i, NOW - (n - i) * stepMs, name, hash));
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

test("same-call-loop: 5 identical calls in a row within 10 min", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", toolHistory: [call(99, NOW - 30 * MIN, "bash", "other"), ...calls(5, MIN)] })] });
	const [finding] = ofKind(detect(world), "same-call-loop");
	assert.equal(finding.detector, "D10");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.ok(finding.titleKo.length > 0 && finding.detailKo.length > 0);
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.data.tool, "read");
	assert.equal(finding.data.argsHash, "h-read-a");
	assert.equal(finding.data.count, 5);
});

test("same-call-loop: 4 repeats is under the limit", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ toolHistory: calls(4, MIN) })] });
	assert.equal(ofKind(detect(world), "same-call-loop").length, 0);
});

test("same-call-loop: interleaved or spread-out repeats are not a loop", () => {
	const interleaved = [];
	for (let i = 0; i < 6; i += 1) interleaved.push(call(i, NOW - (12 - 2 * i) * MIN), call(i + 10, NOW - (11 - 2 * i) * MIN, "bash", "h-bash"));
	assert.equal(ofKind(detect(makeWorld({ now: NOW, sessions: [sessionState({ toolHistory: interleaved })] })), "same-call-loop").length, 0);
	const spread = calls(5, 3 * MIN); // 12 min span
	assert.equal(ofKind(detect(makeWorld({ now: NOW, sessions: [sessionState({ toolHistory: spread })] })), "same-call-loop").length, 0);
});

const ERR = "429 Too Many Requests: rate limit exceeded for organization, please retry after some time and reduce load";
const errors = (n, stepMs, text = ERR) => Array.from({ length: n }, (_, i) => ({ ms: NOW - (n - i) * stepMs, text: `${text} #${i}`, provider: "anthropic", model: "claude-opus" }));

test("error-storm: same error head 5 times within 60 s (assistant + tool errors)", () => {
	const toolErrors = [{ id: "t1", ms: NOW - 5000, name: "bash", argsHash: "x", isError: true, errHead: ERR }];
	const world = makeWorld({ now: NOW, sessions: [sessionState({ id: "s1", errors: errors(4, 10_000), toolHistory: toolErrors })] });
	const [finding] = ofKind(detect(world), "error-storm");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.subject.sessionId, "s1");
	assert.equal(finding.data.count, 5);
	assert.equal(finding.data.errorHead, ERR.slice(0, 80));
	assert.deepEqual(finding.data.sources.sort(), ["assistant", "tool:bash"]);
});

test("error-storm: 4 errors is under the limit", () => {
	const world = makeWorld({ now: NOW, sessions: [sessionState({ errors: errors(4, 10_000) })] });
	assert.equal(ofKind(detect(world), "error-storm").length, 0);
});

test("error-storm: errors spread over more than 60 s or with different heads do not count", () => {
	const spread = makeWorld({ now: NOW, sessions: [sessionState({ errors: errors(5, 20_000) })] });
	assert.equal(ofKind(detect(spread), "error-storm").length, 0);
	const different = errors(5, 5000).map((e, i) => ({ ...e, text: `error kind ${i}` }));
	assert.equal(ofKind(detect(makeWorld({ now: NOW, sessions: [sessionState({ errors: different })] })), "error-storm").length, 0);
});
