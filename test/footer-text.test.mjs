import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { footerText, waitingText } from "../src/act/notify.mjs";

/**
 * The footer contract of analyst-why C8: while the top problem of a session is under investigation (a look running or a
 * why look pending), the word is `조사중` in the problem's own level color; everything else is unchanged.
 */
test("the footer says 조사중 while the top problem is under investigation (#56 C8/IS-7)", () => {
	assert.equal(footerText("warn", { detector: "D8", kind: "dead-child" }, 1, true), "👀 조사중");
	assert.equal(footerText("crit", { detector: "D1", kind: "stall" }, 3, true), "👀 조사중");
	assert.equal(footerText("warn", { detector: "D10", kind: "same-call-loop" }, 0, true), "👀 조사중");
	// The detector word comes back as soon as the investigation is not running.
	assert.equal(footerText("warn", { detector: "D8", kind: "dead-child" }, 1, false), "👀 작업정지");
	assert.equal(footerText("crit", { detector: "D1", kind: "stall" }, 1), "👀 멈춤", "the 3-argument call still means not investigating");
});

test("waitingText shows workflow progress or the live work count", () => {
	assert.equal(waitingText({ dag: { completed: 3, total: 7 }, count: 9 }), "👀 DAG3/7");
	assert.equal(waitingText({ dag: { completed: 0, total: 2 }, count: 0 }), "👀 DAG0/2");
	assert.equal(waitingText({ dag: { completed: 0, total: 0 }, count: 2 }), "👀 대기2");
	assert.equal(waitingText({ count: 1 }), "👀 대기1");
});

test("an investigation never changes an ok, info or finding-less footer (#56 C8)", () => {
	assert.equal(footerText("ok", undefined, 0, true), "👀 정상");
	assert.equal(footerText("ok", { detector: "D1", kind: "stall" }, 0, true), "👀 정상");
	assert.equal(footerText("info", { detector: "D4" }, 0, true), "👀 정상");
	assert.equal(footerText("info", { detector: "D1", kind: "stall" }, 2, true), "👀 관찰2", "an observation count is not a problem under investigation");
	assert.equal(footerText("warn", undefined, 0, true), "👀 정상");
});
