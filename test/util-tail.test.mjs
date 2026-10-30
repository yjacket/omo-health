import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JsonlTail } from "../src/util/tail.mjs";

function tmpFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-tail-"));
	return path.join(dir, "a.jsonl");
}

test("reads complete lines and buffers a partial trailing line", () => {
	const file = tmpFile();
	fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":');
	const tail = new JsonlTail(file);
	const first = tail.readNew();
	assert.deepEqual(first.entries, [{ a: 1 }, { a: 2 }]);
	assert.equal(first.badLines, 0);
	fs.appendFileSync(file, '3}\n{"a":4}\n');
	assert.deepEqual(tail.readNew().entries, [{ a: 3 }, { a: 4 }]);
	assert.deepEqual(tail.readNew().entries, []);
});

test("keeps multi-byte UTF-8 intact when a read splits a character", () => {
	const file = tmpFile();
	const line = JSON.stringify({ t: "헬스 확인" });
	const bytes = Buffer.from(`${line}\n`);
	fs.writeFileSync(file, bytes.subarray(0, 12));
	const tail = new JsonlTail(file);
	assert.deepEqual(tail.readNew().entries, []);
	fs.appendFileSync(file, bytes.subarray(12));
	assert.deepEqual(tail.readNew().entries, [{ t: "헬스 확인" }]);
});

test("counts malformed lines without throwing", () => {
	const file = tmpFile();
	fs.writeFileSync(file, '{"ok":1}\nnot json\n{"ok":2}\n');
	const tail = new JsonlTail(file);
	const result = tail.readNew();
	assert.equal(result.entries.length, 2);
	assert.equal(result.badLines, 1);
	assert.equal(tail.totalBadLines, 1);
});

test("restarts from the beginning after truncation", () => {
	const file = tmpFile();
	fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
	const tail = new JsonlTail(file);
	assert.equal(tail.readNew().entries.length, 3);
	fs.writeFileSync(file, '{"n":9}\n');
	const after = tail.readNew();
	assert.equal(after.reset, true);
	assert.deepEqual(after.entries, [{ n: 9 }]);
	assert.equal(tail.resets, 1);
});

test("startTailBytes skips the partial first line of a large file", () => {
	const file = tmpFile();
	const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(40) }));
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	const tail = new JsonlTail(file, { startTailBytes: 300 });
	const result = tail.readNew();
	assert.equal(result.badLines, 0);
	assert.ok(result.entries.length > 0 && result.entries.length < 50);
	assert.equal(result.entries.at(-1).i, 49);
});

test("missing file reports missing and recovers when it appears", () => {
	const file = tmpFile();
	const tail = new JsonlTail(file);
	assert.equal(tail.readNew().missing, true);
	fs.writeFileSync(file, '{"x":1}\n');
	assert.deepEqual(tail.readNew().entries, [{ x: 1 }]);
});
