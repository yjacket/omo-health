import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers/fixtures.mjs";
import { createFakeClock, iso } from "../src/util/time.mjs";
import {
	USAGE_INDEX_VERSION,
	USAGE_TICK_BYTES,
	compactUsage,
	createUsageIndex,
	fresh,
	readUsageIndex,
	treeTotals,
} from "../src/usage-index.mjs";

const MiB = 1024 * 1024;
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(8, "0");

const use = ({ input = 1, output = 2, cacheRead = 3, cacheWrite = 4, cost = 0.1 } = {}) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	cost: { total: cost },
});

function assistant({ text = "", usage = use(), model = "claude-opus-5-5" } = {}) {
	return {
		type: "message",
		id: nextId(),
		timestamp: iso(T0),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "anthropic-subscription",
			model,
			usage,
			stopReason: "stop",
			timestamp: T0,
		},
	};
}

/** 10 tokens per record. */
const line = () => JSON.stringify(assistant());

function setup(t) {
	const dir = tmpDir("omoh-usage-index-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const clock = createFakeClock(T0);
	const logged = [];
	const log = {
		error(event, detail) {
			logged.push({ event, detail });
		},
	};
	const fileOf = (name = "session.jsonl") => path.join(dir, name);
	const indexOf = (name = "usage.json") => createUsageIndex({ file: path.join(dir, name), clock, log });
	return { dir, clock, logged, log, fileOf, indexOf };
}

const writeText = (file, text) => fs.writeFileSync(file, text);

test("save and load round-trip the entries without the in-memory fields", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const first = fileOf("a.jsonl");
	const second = fileOf("b.jsonl");
	writeText(first, `${line()}\n`);
	writeText(second, `${line()}\n${line()}`);
	assert.equal(index.update("s1", first, { kind: "main", rootSessionId: "s1" }, { maxBytes: 1 * MiB }), fs.statSync(first).size);
	assert.equal(index.update("s2", second, { kind: "child", taskId: "st_2", parentSessionId: "s1" }), fs.statSync(second).size);
	assert.equal(index.save(), true);
	assert.equal(index.save(), false);
	const raw = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
	assert.equal(raw.v, USAGE_INDEX_VERSION);
	for (const entry of Object.values(raw.entries)) {
		assert.equal("scanOffset" in entry, false);
		assert.equal("partial" in entry, false);
		assert.equal("readError" in entry, false);
	}
	const loaded = readUsageIndex(path.join(dir, "usage.json"));
	assert.equal(loaded instanceof Map, true);
	assert.equal(loaded.size, 2);
	assert.equal(compactUsage(loaded.get("s1")).total, 10);
	assert.equal(compactUsage(loaded.get("s2")).total, 20);
	assert.equal(loaded.get("s2").taskId, "st_2");
	assert.equal(loaded.get("s2").parentSessionId, "s1");
	assert.equal(index.prune(T0), 0);
});

for (const field of ["size", "offset", "evaluatedTo", "mtimeMs", "ino", "birthtimeMs", "headLen"]) {
	test(`(gate 9) reloaded index recounts and publishes with malformed ${field}`, (t) => {
		const { fileOf, indexOf, logged } = setup(t);
		const file = fileOf();
		const original = `${line()}\n`;
		const second = `${line()}\n`;
		for (const [name, value] of [["object", '{"toString":null,"valueOf":null}'], ["overflow", "1e999"]]) {
			const indexName = `${name}.json`;
			const savedFile = fileOf(indexName);
			writeText(file, original);
			const index = indexOf(indexName);
			index.update("s", file);
			index.save();
			const saved = fs.readFileSync(savedFile, "utf8");
			const corrupt = saved.replace(new RegExp(`("${field}"\\s*:\\s*)[^,\\s}]+`), (_, key) => key + value);
			assert.notEqual(corrupt, saved);
			writeText(savedFile, corrupt);
			const reloaded = indexOf(indexName);
			const wasFresh = fresh(reloaded.get("s"));
			fs.appendFileSync(file, second);
			assert.equal(reloaded.update("s", file), Buffer.byteLength(original + second), value);
			assert.equal(compactUsage(reloaded.get("s")).total, 20);
			assert.equal(reloaded.save(), true);
			assert.equal(compactUsage(indexOf(indexName).get("s")).total, 20);
			assert.equal(wasFresh, false, value);
		}
		assert.deepEqual(logged, []);
	});
}

test("a different index version or a corrupt file reads as empty", (t) => {
	const { dir } = setup(t);
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(file, JSON.stringify({ v: 2, entries: { s1: { id: "s1" } } }));
	assert.equal(readUsageIndex(file).size, 0);
	fs.writeFileSync(file, "{not json");
	assert.equal(readUsageIndex(file).size, 0);
	assert.equal(readUsageIndex(path.join(dir, "absent.json")).size, 0);
});

test("constructing an index over a corrupt, different-version or absent file starts empty", (t) => {
	const { dir, clock, log } = setup(t);
	const file = path.join(dir, "usage.json");
	for (const text of [JSON.stringify({ v: 2, entries: { s1: { id: "s1", state: "ok", complete: true } } }), "{not json", ""]) {
		fs.writeFileSync(file, text);
		const index = createUsageIndex({ file, clock, log });
		assert.deepEqual(index.entries(), []);
		assert.equal(index.has("s1"), false);
		assert.equal(index.save(), false, "nothing was loaded, so nothing is written");
	}
	fs.rmSync(file);
	assert.deepEqual(createUsageIndex({ file, clock, log }).entries(), []);

	fs.writeFileSync(
		file,
		JSON.stringify({ v: USAGE_INDEX_VERSION, entries: { s1: { id: "s1", state: "ok", complete: true, offset: 12, scanOffset: 5, partial: { start: 0 }, readError: true } } }),
	);
	const loaded = createUsageIndex({ file, clock, log });
	assert.equal(loaded.get("s1").state, "ok");
	assert.equal(loaded.get("s1").offset, 12);
	assert.equal("scanOffset" in loaded.get("s1"), false, "scanOffset is memory-only");
	assert.equal("partial" in loaded.get("s1"), false, "partial is memory-only");
	assert.equal("readError" in loaded.get("s1"), false, "readError is memory-only");
});

test("an index over the same file resumes an appended entry at its saved offset", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const first = indexOf();
	assert.equal(first.update("s1", file), fs.statSync(file).size);
	assert.equal(compactUsage(first.get("s1")).total, 10);

	const appended = `${line()}\n${line()}\n`;
	const lineBytes = Buffer.byteLength(`${line()}\n`);
	fs.appendFileSync(file, appended);
	assert.equal(first.update("s1", file, {}, { maxBytes: lineBytes }), lineBytes, "the first instance read one of the two appended records");
	assert.equal(first.save(), true);
	const savedOffset = readUsageIndex(path.join(dir, "usage.json")).get("s1").offset;
	assert.equal(savedOffset, fs.statSync(file).size - lineBytes);

	const restarted = indexOf();
	assert.equal(restarted.get("s1").offset, savedOffset, "the new instance loaded the persisted cursor");
	const bytesRead = restarted.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(bytesRead, lineBytes, "only the bytes not yet read are read");
	assert.equal(compactUsage(restarted.get("s1")).total, 30);
	assert.equal(restarted.fresh(restarted.get("s1")), true);

	const oracle = indexOf("oracle.json");
	oracle.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(compactUsage(oracle.get("s1")).total, 30, "the resumed total equals a one-shot read");
});

test("a resumable append reads only the appended bytes", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	assert.equal(compactUsage(index.get("s1")).total, 10);
	const appended = `${line()}\n${line()}\n`;
	fs.appendFileSync(file, appended);
	assert.equal(index.fresh(index.get("s1")), false);
	const bytesRead = index.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(bytesRead, Buffer.byteLength(appended));
	assert.equal(compactUsage(index.get("s1")).total, 30);
	assert.equal(index.fresh(index.get("s1")), true);
});

test("a three-call first read shows nothing until the file is read to the end", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${JSON.stringify(assistant({ text: "x".repeat(900) }))}\n${JSON.stringify(assistant({ text: "y".repeat(900) }))}\n${JSON.stringify(assistant({ text: "z".repeat(900) }))}\n`);
	const maxBytes = Math.ceil(fs.statSync(file).size / 3) + 1;
	const index = indexOf();
	const entry = () => index.get("s1");
	assert.equal(index.update("s1", file, {}, { maxBytes }), maxBytes);
	assert.equal(entry().complete, false);
	assert.equal(compactUsage(entry()), null);
	assert.ok(index.update("s1", file, {}, { maxBytes }) > 0);
	assert.equal(entry().complete, false);
	assert.equal(compactUsage(entry()), null);
	assert.ok(index.update("s1", file, {}, { maxBytes }) > 0);
	assert.equal(entry().complete, true);
	assert.equal(index.fresh(entry()), true);
	assert.equal(compactUsage(entry()).total, 30);
});

test("an append to a complete entry keeps it complete", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	assert.equal(index.get("s1").complete, true);
	fs.appendFileSync(file, `${line()}\n`);
	index.update("s1", file);
	assert.equal(index.get("s1").complete, true);
	assert.equal(compactUsage(index.get("s1")).total, 20);
});

test("ten 4 MiB records appended to a complete entry are counted eight per 32 MiB update", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const oldEnd = fs.statSync(file).size;
	const index = indexOf();
	index.update("s1", file);
	assert.equal(compactUsage(index.get("s1")).total, 10);

	const record = assistant();
	const target = 4 * MiB - 1;
	const skeleton = JSON.stringify(record);
	record.message.content[0].text = "x".repeat(target - skeleton.length);
	const bigLine = JSON.stringify(record);
	assert.equal(Buffer.byteLength(bigLine) + 1, 4 * MiB);
	fs.appendFileSync(file, `${bigLine}\n`.repeat(10));

	const entry = index.get("s1");
	assert.equal(index.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES }), 8 * 4 * MiB);
	assert.equal(entry.usage.total, 90);
	assert.equal(entry.offset, oldEnd + 8 * 4 * MiB);
	assert.equal(entry.complete, true);
	assert.equal(entry.evaluatedTo < entry.size, true);
	assert.equal(compactUsage(entry).total, 10);

	assert.equal(index.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES }), 2 * 4 * MiB);
	assert.equal(entry.complete, true);
	assert.equal(entry.evaluatedTo, entry.size);
	assert.equal(compactUsage(entry).total, 110);
	assert.equal(index.fresh(entry), true);
});

test("a 40 MiB record appended to a complete entry keeps the previous total until it completes", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const oldEnd = fs.statSync(file).size;
	const index = indexOf();
	index.update("s1", file);
	assert.equal(compactUsage(index.get("s1")).total, 10);

	const record = assistant({ usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0 }) });
	const target = 40 * MiB;
	const skeleton = JSON.stringify(record);
	record.message.content[0].text = "x".repeat(target - skeleton.length);
	const bigLine = JSON.stringify(record);
	assert.equal(Buffer.byteLength(bigLine), target);
	fs.appendFileSync(file, `${bigLine}\n`);

	const entry = index.get("s1");
	index.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(entry.complete, true);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(entry.offset, oldEnd);
	assert.equal(entry.evaluatedTo, oldEnd + USAGE_TICK_BYTES);
	assert.equal(index.fresh(entry), false);

	index.update("s1", file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(entry.complete, true);
	assert.equal(compactUsage(entry).total, 14);
	assert.equal(entry.evaluatedTo, entry.size);
	assert.equal(index.fresh(entry), true);
});

test("a missing file marks the entry missing", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const file = fileOf("never.jsonl");
	assert.equal(index.update("s1", file, { kind: "main" }), 0);
	const entry = index.get("s1");
	assert.equal(entry.state, "missing");
	assert.equal(entry.complete, false);
	assert.equal(compactUsage(entry), null);
	index.save();
	assert.equal(readUsageIndex(path.join(dir, "usage.json")).get("s1").state, "missing");
});

test("deleting a complete file marks it gone and keeps its total", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	fs.rmSync(file);
	assert.equal(index.update("s1", file), 0);
	const entry = index.get("s1");
	assert.equal(entry.state, "ok");
	assert.equal(entry.gone, true);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(index.fresh(entry), false);
});

test("markMissing keeps a complete entry's published total and marks it gone, while a never-found row stays missing", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const file = fileOf();
	writeText(file, `${line()}\n`);
	index.update("s1", file);

	const gone = index.markMissing("s1");
	assert.equal(gone.state, "ok");
	assert.equal(gone.complete, true);
	assert.equal(gone.gone, true);
	assert.equal(compactUsage(gone).total, 10, "the last published total survives the deletion");

	const never = index.markMissing("s2");
	assert.equal(never.state, "missing");
	assert.equal(never.complete, false);
	assert.equal(never.gone, false);
	assert.equal(compactUsage(never), null);

	index.save();
	const saved = readUsageIndex(path.join(dir, "usage.json"));
	assert.equal(saved.get("s1").gone, true);
	assert.equal(saved.get("s1").state, "ok");
	assert.equal(saved.get("s1").published.total, 10);
});

test("get and has resolve the taskId alias", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file, { kind: "child", taskId: "st_01a2" });
	assert.equal(index.get("st_01a2"), index.get("s1"));
	assert.equal(index.has("st_01a2"), true);
	assert.equal(index.has("st_absent"), false);
});

test("prune drops entries by checkedMs against the injected clock", (t) => {
	const { clock, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const a = fileOf("a.jsonl");
	const b = fileOf("b.jsonl");
	writeText(a, `${line()}\n`);
	writeText(b, `${line()}\n`);
	index.update("a", a);
	clock.advance(44 * DAY);
	index.update("b", b);
	clock.advance(2 * DAY);
	assert.equal(index.prune(clock.now()), 1);
	assert.equal(index.has("a"), false);
	assert.equal(index.has("b"), true);
	assert.equal(index.prune(clock.now() + 45 * DAY), 1);
	assert.equal(index.has("b"), false);
});

test("treeTotals sums descendants, survives a cycle, and skips an incomplete child", () => {
	const entry = (id, parentSessionId, total, complete = true) => ({
		id,
		parentSessionId,
		state: "ok",
		complete,
		published: { total, input: total, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costUnknown: false, turns: 0 },
	});
	const totals = treeTotals([
		entry("main", null, 100),
		entry("child", "main", 20),
		entry("grandchild", "child", 5),
		entry("x", "y", 7),
		entry("y", "x", 9),
		entry("main2", null, 50),
		entry("child2", "main2", 999, false),
	]);
	assert.equal(totals.get("main"), 125);
	assert.equal(totals.get("child"), 25);
	assert.equal(totals.get("grandchild"), 5);
	assert.equal(totals.get("x"), 16);
	assert.equal(totals.get("y"), 16);
	assert.equal(totals.get("main2"), 50);
	assert.equal(totals.get("child2"), 0);

	const index = createUsageIndex({ file: "unused.json", clock: createFakeClock(T0) });
	const map = treeTotals(new Map([["main", { id: "main", state: "ok", complete: true, published: { total: 3 } }]]));
	assert.equal(map.get("main"), 3);
});

test("usage_read_failed is logged once for a directory path and the next successful read clears it", (t) => {
	const { logged, clock, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	const entry = index.get("s1");
	assert.equal(compactUsage(entry).total, 10);

	fs.rmSync(file);
	fs.mkdirSync(file);
	assert.equal(index.update("s1", file), 0);
	assert.equal(entry.readError, true);
	assert.equal(compactUsage(entry), null);
	assert.equal(entry.complete, true);
	assert.equal(logged.length, 1);
	assert.equal(logged[0].event, "usage_read_failed");
	assert.equal(logged[0].detail.file, "session.jsonl");
	assert.match(logged[0].detail.error, /EISDIR|EPERM|EACCES/);

	clock.advance(1000);
	assert.equal(index.update("s1", file), 0);
	assert.equal(logged.length, 1);

	fs.rmdirSync(file);
	writeText(file, `${line()}\n`);
	fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
	assert.equal(index.update("s1", file), fs.statSync(file).size);
	assert.equal(entry.readError, false);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(logged.length, 1);
	assert.equal(fresh(entry), true);
});
