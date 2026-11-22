import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeSubjectId } from "../src/session-id.mjs";

test("plan77: subject IDs match Senpi syntax within the dashboard cap", () => {
	for (const id of ["a", "m1", "review.1", "abc-1.2_x", "a..b", "console", "COM10", "x".repeat(80),
		"con", "cOn.txt", "PRN", "aux", "nul.json", "com1", "COM9.audit", "lpt1", "LPT9.trace.v1",
		"x".repeat(81), "x".repeat(300), "x".repeat(1024)]) {
		assert.equal(safeSubjectId(id), id);
	}
	for (const id of [
		null, undefined, 123, "", ".", "..", "../x", "a/b", "a\\b", "%2e%2e", "_budget",
		".review", "-review", "review_", "x.", "x ", "a b", "a:b", "a\0b", "x\t", "x\n",
		"x\r", "x\u007f", "COM¹", "x".repeat(1025),
	]) {
		assert.equal(safeSubjectId(id), null, JSON.stringify(id));
	}
});
