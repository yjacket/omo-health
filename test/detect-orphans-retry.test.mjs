import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/orphans.mjs";
import { retryWaitOf } from "../src/detect/provider.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

// Issue #93 (senpi retry sleep after an error record) and the #82 item (dead-child right after a revive).

const NOW = Date.parse("2026-09-29T18:31:39Z");
const MIN = 60_000;
const HOST_PID = 4000;
const iso = (ms) => new Date(ms).toISOString();
const HOST = () => raw(HOST_PID, 1, "node.exe", iso(NOW - 5 * 3600_000), 0, 0, "node C:\\Users\\u\\senpi\\dist\\bundle\\cli.js");
const world = (sessions) => makeWorld({ now: NOW, sessions: [sessionState({ id: "p1", lastEntryMs: NOW - 200 * MIN }), ...sessions], procSnapshots: [{ takenAtMs: NOW, rows: [HOST()] }] });
const deadChildren = (w) => detect(w, {}).filter((f) => f.kind === "dead-child");

const USAGE_LIMIT = "Codex error: The usage limit has been reached";
const SESSION_LIMIT = "You've hit your session limit · resets 8:50am (Asia/Seoul) (rate_limit)";
const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked. (authentication_failed)";

/** A running child whose last record is an assistant message stopped with `stopReason`, `idleMin` minutes ago. */
function child({ idleMin, errorMessage, stopReason = "error", updatedMinAgo }) {
	const lastMs = NOW - idleMin * MIN;
	const task = taskRecord({
		taskId: "st_r",
		parentSessionId: "p1",
		hostPid: HOST_PID,
		childSessionId: "c1",
		status: "running",
		updatedAtMs: updatedMinAgo === undefined ? lastMs - 10 * MIN : NOW - updatedMinAgo * MIN,
	});
	return sessionState({
		id: "c1",
		kind: "child",
		taskId: "st_r",
		parentSessionId: "p1",
		task,
		lastEntryMs: lastMs,
		lastMessage: { role: "assistant", ms: lastMs, stopReason, errorMessage },
	});
}

test("retryWaitOf: usage/rate limits and accounts blocked with a stated retry time are retry waits, the rest are not", () => {
	assert.deepEqual(retryWaitOf(USAGE_LIMIT), { cls: "usage-limit" });
	assert.deepEqual(retryWaitOf(SESSION_LIMIT), { cls: "usage-limit" });
	assert.deepEqual(retryWaitOf('429 {"type":"error","error":{"message":"Too many requests, please wait before trying again."}}'), { cls: "rate-limit" });
	const blocked = "All Claude accounts for claude-sdk-oauth are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: 2026-09-22T18:54:28.730Z.\n  /claude-account list";
	assert.deepEqual(retryWaitOf(blocked), { cls: "accounts-blocked", resetAtMs: Date.parse("2026-09-22T18:54:28.730Z") });
	assert.equal(retryWaitOf("All Claude accounts for claude-sdk-oauth are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: after re-login."), undefined);
	assert.equal(retryWaitOf(REVOKED), undefined);
	assert.equal(retryWaitOf("Provider is not configured: anthropic-subscription"), undefined);
	assert.equal(retryWaitOf("WebSocket error"), undefined);
	assert.equal(retryWaitOf(undefined), undefined);
});

test("retry wait: a usage-limit error record is not a dead child inside the bounded wait, and is one once the bound passes", () => {
	assert.equal(deadChildren(world([child({ idleMin: 31, errorMessage: USAGE_LIMIT })])).length, 0);
	assert.equal(deadChildren(world([child({ idleMin: 34, errorMessage: SESSION_LIMIT })])).length, 0);
	const [finding] = deadChildren(world([child({ idleMin: 36, errorMessage: USAGE_LIMIT })]));
	assert.equal(finding.subject.sessionId, "p1");
	assert.deepEqual(finding.data.remedy, { kind: "wake-parent", reason: "dead-child" });
	assert.equal(finding.data.idleMs, 36 * MIN);
});

test("dead-child carries the child's final error text, redacted and truncated to 300 chars", () => {
	const secret = `sk-ant-${'A'.repeat(60)}`;
	const [finding] = deadChildren(world([child({ idleMin: 36, errorMessage: `429 Too many requests ${secret}` })]));
	assert.match(finding.data.errorText, /429 Too many requests/);
	assert.doesNotMatch(finding.data.errorText, /sk-ant-[A-Za-z0-9]/);
	assert.ok(finding.data.errorText.length <= 300, "truncated to the 300-char evidence limit");
	// A child whose final record is not an assistant error carries no error text at all.
	const [clean] = deadChildren(world([child({ idleMin: 36, errorMessage: secret, stopReason: "aborted" })]));
	assert.equal(clean.data.errorText, undefined);
});

test("retry wait: errors senpi does not park and retry (revoked login, transient socket error) are dead at the plain deadline", () => {
	for (const errorMessage of [REVOKED, "WebSocket error", undefined]) {
		const [finding] = deadChildren(world([child({ idleMin: 31, errorMessage })]));
		assert.deepEqual(finding?.data.remedy, { kind: "wake-parent", reason: "dead-child" }, String(errorMessage));
	}
});

test("retry wait: a provider retry time extends the wait to reset + margin, capped at retryWaitMaxMs", () => {
	const errorAt = (idleMin) => NOW - idleMin * MIN;
	const blockedUntil = (idleMin, resetInMin) =>
		`All Claude accounts for claude-sdk-oauth are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: ${iso(errorAt(idleMin) + resetInMin * MIN)}.\n  /claude-account list`;
	// reset 90 min after the error: still waiting at 60 and 94 min, dead past 95 min
	assert.equal(deadChildren(world([child({ idleMin: 60, errorMessage: blockedUntil(60, 90) })])).length, 0);
	assert.equal(deadChildren(world([child({ idleMin: 94, errorMessage: blockedUntil(94, 90) })])).length, 0);
	assert.equal(deadChildren(world([child({ idleMin: 96, errorMessage: blockedUntil(96, 90) })])).length, 1);
	// reset 10 h out: not suppressed past the 2 h cap
	assert.equal(deadChildren(world([child({ idleMin: 119, errorMessage: blockedUntil(119, 600) })])).length, 0);
	assert.equal(deadChildren(world([child({ idleMin: 121, errorMessage: blockedUntil(121, 600) })])).length, 1);
	// no stated retry time ("after re-login") is not a wait at all
	const noTime = "All Claude accounts for claude-sdk-oauth are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: after re-login.";
	assert.equal(deadChildren(world([child({ idleMin: 31, errorMessage: noTime })])).length, 1);
});

test("revive grace: a task rewritten to running a moment ago is not a dead child, five minutes later it is", () => {
	// last record is the old rate-limit error (an hour ago), the task record was rewritten 15 s / 2 min / 6 min ago
	const old = { idleMin: 60, errorMessage: SESSION_LIMIT };
	assert.equal(deadChildren(world([child({ ...old, updatedMinAgo: 0.25 })])).length, 0);
	assert.equal(deadChildren(world([child({ ...old, updatedMinAgo: 2 })])).length, 0);
	const [finding] = deadChildren(world([child({ ...old, updatedMinAgo: 6 })]));
	assert.deepEqual(finding.data.remedy, { kind: "wake-parent", reason: "dead-child" });
	// the grace is not error-specific: a revived task whose child was aborted is covered too
	assert.equal(deadChildren(world([child({ idleMin: 60, stopReason: "aborted", updatedMinAgo: 1 })])).length, 0);
});

test("revive grace: a record older than the child's last entry is not a revive", () => {
	// updated_at (61 min ago) predates the last child record (60 min ago): the record was written for the start, not a revive
	const c = child({ idleMin: 60, errorMessage: REVOKED, updatedMinAgo: 61 });
	assert.equal(deadChildren(world([c])).length, 1);
});
