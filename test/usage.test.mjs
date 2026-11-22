import "./helpers/tmp-root.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/fixtures.mjs";
import { addUsage, createRecordScanner, emptyUsage, modelsOfEntry, readUsage, usageOfEntry, usageTimeline } from "../src/collect/usage.mjs";

const MiB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 28, 10, 5, 0);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(8, "0");

function setup(t) {
	const dir = tmpDir("omoh-usage-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return {
		dir,
		file(name = "session.jsonl") {
			return path.join(dir, name);
		},
	};
}

function use({ input = 1, output = 2, cacheRead = 3, cacheWrite = 4, cost = 0.1, totalTokens, costUnknown } = {}) {
	const usage = { input, output, cacheRead, cacheWrite, cost: { total: cost } };
	if (totalTokens !== undefined) usage.totalTokens = totalTokens;
	if (costUnknown !== undefined) usage.costUnknown = costUnknown;
	return usage;
}

const sumFour = (usage) => (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

function assistant({ ms = T0, usage, provider = "anthropic-subscription", model = "claude-opus-5-5", responseModel, stopReason = "stop", content = [], errorMessage } = {}) {
	const message = { role: "assistant", content, provider, model };
	if (responseModel !== undefined) message.responseModel = responseModel;
	if (usage !== undefined) message.usage = usage;
	message.stopReason = stopReason;
	if (errorMessage !== undefined) message.errorMessage = errorMessage;
	message.timestamp = ms;
	return { type: "message", id: nextId(), timestamp: iso(ms), message };
}

function usageEntry(usage, { ms = T0, provider = "openai", model = "gpt-5" } = {}) {
	return { type: "usage", timestamp: iso(ms), provider, model, usage };
}

function toolResult({ ms = T0, name = "bash", text = "ok", isError = false, usage } = {}) {
	const message = { role: "toolResult", toolCallId: nextId(), toolName: name, content: [{ type: "text", text }], isError, timestamp: ms };
	if (usage !== undefined) message.usage = usage;
	return { type: "message", id: nextId(), timestamp: iso(ms), message };
}

function prewarm(phase, { ms = T0, provider = "anthropic-subscription", model = "claude-opus-5-5", usage } = {}) {
	return {
		type: "custom",
		customType: "prompt-cache-prewarm",
		timestamp: iso(ms),
		data: { phase, provider, model, usage: usage ?? use({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.2 }) },
	};
}

function compaction(usage, { ms = T0, provider, model } = {}) {
	const entry = { type: "compaction", timestamp: iso(ms), usage };
	if (provider !== undefined) entry.provider = provider;
	if (model !== undefined) entry.model = model;
	return entry;
}

function branchSummary(usage, ms = T0) {
	return { type: "branch_summary", timestamp: iso(ms), usage };
}

function textRecord(text, ms = T0) {
	return { type: "message", id: nextId(), timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }], timestamp: ms } };
}

function userImages(count, ms = T0) {
	return {
		type: "message",
		id: nextId(),
		timestamp: iso(ms),
		message: {
			role: "user",
			content: Array.from({ length: count }, () => ({ type: "image", data: "AAAA" })),
			timestamp: ms,
		},
	};
}

function writeRecords(file, records, { crlf = false, bom = false, trailingNewline = true } = {}) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const separator = crlf ? "\r\n" : "\n";
	let text = records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join(separator);
	if (trailingNewline) text += separator;
	if (bom) text = `\uFEFF${text}`;
	fs.writeFileSync(file, text);
}

function appendRaw(file, text) {
	fs.appendFileSync(file, text);
}

/** Independent oracle: JSON.parse every line and apply IS-1 by hand. */
function oracleTotals(file) {
	const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, costUnknown: false, turns: 0 };
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		let usage;
		if (entry.type === "message" && entry.message?.role === "assistant") usage = entry.message.usage;
		else if (entry.type === "message" && entry.message?.role === "toolResult") usage = entry.message.usage;
		else if (entry.type === "usage") usage = entry.usage;
		else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) usage = entry.usage;
		else if (entry.type === "custom" && entry.customType === "prompt-cache-prewarm" && entry.data?.phase === "warmed") {
			const candidate = entry.data.usage;
			const valid =
				candidate &&
				["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(candidate[key])) &&
				candidate.cost &&
				Number.isFinite(candidate.cost.total);
			if (valid) usage = candidate;
		}
		if (!usage) continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
			totals[key] += Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
		}
		totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
		totals.cost += Number.isFinite(usage.cost?.total) ? usage.cost.total : 0;
		if (usage.costUnknown === true) totals.costUnknown = true;
		if (entry.type === "message" && entry.message?.role === "assistant") totals.turns += 1;
	}
	return totals;
}

const core = (usage) => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	total: usage.total,
	cost: usage.cost,
	costUnknown: usage.costUnknown,
	turns: usage.turns,
	models: usage.models,
	usedModels: usage.usedModels,
	modelsIncomplete: usage.modelsIncomplete,
});

function fixedLine(target) {
	const base = JSON.stringify(textRecord(""));
	const count = target - base.length - 1;
	assert.ok(count >= 0, `fixed line of ${target} bytes is too small`);
	const line = `${JSON.stringify(textRecord("a".repeat(count)))}\n`;
	assert.equal(Buffer.byteLength(line), target);
	return line;
}

function scanInChunks(buffer, chunkSize) {
	const scanner = createRecordScanner();
	for (let index = 0; index < buffer.length; index += chunkSize) scanner.push(buffer.subarray(index, index + chunkSize));
	const entry = scanner.finish();
	return { entry, malformed: scanner.malformed };
}

test("counts every usage carrier the way /session does", (t) => {
	const { file } = setup(t);
	const a = use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1 });
	const u = use({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.2 });
	const b = use({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5, cost: 0.01 });
	const c = use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0.02 });
	const p = use({ input: 2, output: 2, cacheRead: 2, cacheWrite: 2, cost: 0.03 });
	const tr = use({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3, cost: 0.04 });
	writeRecords(file(), [
		assistant({ usage: a }),
		usageEntry(u, { provider: "openai", model: "gpt-5" }),
		branchSummary(b),
		compaction(c),
		prewarm("warmed", { usage: p }),
		toolResult({ usage: tr }),
	]);
	const got = readUsage(file()).effective;
	assert.equal(got.input, 1 + 10 + 5 + 1 + 2 + 3);
	assert.equal(got.output, 2 + 20 + 5 + 1 + 2 + 3);
	assert.equal(got.cacheRead, 3 + 30 + 5 + 1 + 2 + 3);
	assert.equal(got.cacheWrite, 4 + 40 + 5 + 1 + 2 + 3);
	assert.equal(got.total, sumFour(a) + sumFour(u) + sumFour(b) + sumFour(c) + sumFour(p) + sumFour(tr));
	assert.ok(Math.abs(got.cost - (0.1 + 0.2 + 0.01 + 0.02 + 0.03 + 0.04)) < 1e-9);
	assert.equal(got.turns, 1);
	assert.equal(got.models["anthropic-subscription/claude-opus-5-5"].tokens, sumFour(a));
	assert.equal(got.models["openai/gpt-5"].tokens, sumFour(u));
	assert.equal(got.models["Tools/summaries"].tokens, sumFour(b) + sumFour(c) + sumFour(p) + sumFour(tr));
	assert.equal(got.total, oracleTotals(file()).total);
});

test("ignores a prewarm entry that is not warmed but still records its model", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [prewarm("skipped", { provider: "xai", model: "grok-5" }), prewarm("failed", { provider: "moonshot", model: "kimi-k3" })]);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 0);
	assert.deepEqual(got.usedModels, { "xai/grok-5": true, "moonshot/kimi-k3": true });
});

test("counts an aborted assistant reply", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), stopReason: "aborted" })]);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 1);
	assert.equal(got.turns, 1);
});

test("ignores totalTokens when it differs from the four counters", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 999_999 }) })]);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 10);
	assert.equal(got.total, oracleTotals(file()).total);
});

test("keeps costUnknown", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costUnknown: true }) })]);
	const got = readUsage(file()).effective;
	assert.equal(got.costUnknown, true);
	assert.equal(got.cost, 0);
});

test("keys an assistant reply by responseModel", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ model: "claude-opus-5-5", responseModel: "claude-sonnet-4-5", usage: use() })]);
	const got = readUsage(file()).effective;
	assert.ok(got.models["anthropic-subscription/claude-sonnet-4-5"]);
	assert.equal(got.models["anthropic-subscription/claude-opus-5-5"], undefined);
});

test("usedModels lists every processing model and flags an incomplete model list", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [
		assistant({ model: "claude-opus-5-5", responseModel: "claude-sonnet-4-5", usage: use() }),
		usageEntry(use(), { provider: "openai", model: "gpt-5" }),
		prewarm("warmed", { provider: "google", model: "gemini-3", usage: use() }),
		prewarm("skipped", { provider: "xai", model: "grok-5" }),
		prewarm("failed", { provider: "moonshot", model: "kimi-k3" }),
		compaction(use()),
	]);
	const got = readUsage(file()).effective;
	assert.deepEqual(got.usedModels, {
		"anthropic-subscription/claude-opus-5-5": true,
		"anthropic-subscription/claude-sonnet-4-5": true,
		"openai/gpt-5": true,
		"google/gemini-3": true,
		"xai/grok-5": true,
		"moonshot/kimi-k3": true,
	});
	assert.equal(got.modelsIncomplete, true);
});

test("an incremental append with a partial last line equals a one-shot read", (t) => {
	const { file } = setup(t);
	const records = [
		assistant({ usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }) }),
		assistant({ usage: use({ input: 2, output: 2, cacheRead: 2, cacheWrite: 2 }) }),
		assistant({ usage: use({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3 }) }),
	];
	const third = `${JSON.stringify(records[2])}\n`;
	const half = third.slice(0, Math.floor(third.length / 2));
	fs.writeFileSync(file(), `${JSON.stringify(records[0])}\n${JSON.stringify(records[1])}\n${half}`);
	const first = readUsage(file());
	assert.equal(first.effective.total, 12);
	assert.equal(first.offset, first.size - half.length);
	appendRaw(file(), third.slice(half.length));
	const second = readUsage(file(), first);
	const oneshot = readUsage(file());
	assert.equal(second.effective.total, 24);
	assert.equal(second.done, true);
	assert.deepEqual(core(second.effective), core(oneshot.effective));
});

test("handles CRLF line endings", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) }), assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) })], { crlf: true });
	const got = readUsage(file()).effective;
	assert.equal(got.total, 3);
	assert.equal(got.diagnostics.badLines, 0);
});

test("handles a UTF-8 BOM at the start", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) })], { bom: true });
	const got = readUsage(file()).effective;
	assert.equal(got.total, 1);
	assert.equal(got.diagnostics.badLines, 0);
});

test("counts an invalid line in badLines", (t) => {
	const { file } = setup(t);
	fs.writeFileSync(
		file(),
		`${JSON.stringify(assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) }))}\n{"broken":"usage"\n${JSON.stringify(assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) }))}\n`,
	);
	const got = readUsage(file());
	assert.equal(got.usage.diagnostics.badLines, 1);
	assert.equal(got.effective.total, 3);
});

test("recounts after the file shrinks", (t) => {
	const { file } = setup(t);
	const first = assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const second = assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	writeRecords(file(), [first, second]);
	const from = readUsage(file());
	assert.equal(from.effective.total, 3);
	writeRecords(file(), [first]);
	const got = readUsage(file(), from);
	assert.equal(got.effective.total, 1);
	assert.equal(got.effective.total, oracleTotals(file()).total);
});

test("recounts when the size is unchanged but the mtime differs", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) })]);
	const from = readUsage(file());
	assert.equal(from.effective.total, 1);
	writeRecords(file(), [assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) })]);
	assert.equal(fs.statSync(file()).size, from.size);
	fs.utimesSync(file(), new Date(from.mtimeMs + 5000), new Date(from.mtimeMs + 5000));
	const got = readUsage(file(), from);
	assert.equal(got.effective.total, 2);
});

test("recounts when the head changes", (t) => {
	const { file } = setup(t);
	const a = assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const aLine = `${JSON.stringify(a)}\n`;
	const head = aLine + fixedLine(4096 - Buffer.byteLength(aLine));
	const tail = fixedLine(4096);
	fs.writeFileSync(file(), head + tail);
	const from = readUsage(file());
	assert.equal(from.effective.total, 1);
	const changed = assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const changedLine = `${JSON.stringify(changed)}\n`;
	assert.equal(Buffer.byteLength(changedLine), Buffer.byteLength(aLine));
	fs.writeFileSync(file(), changedLine + fixedLine(4096 - Buffer.byteLength(changedLine)) + tail);
	// Keep the size and pretend the mtime did not move, so only the head hash can catch the rewrite.
	const forged = { ...from, mtimeMs: fs.statSync(file()).mtimeMs };
	const got = readUsage(file(), forged);
	assert.equal(got.effective.total, 2);
});

test("recounts when a rewritten prefix is caught by the tail hash", (t) => {
	const { file } = setup(t);
	const a = assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const aLine = `${JSON.stringify(a)}\n`;
	const head = aLine + fixedLine(4096 - Buffer.byteLength(aLine));
	const middle = fixedLine(4096);
	const z = assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const zLine = `${JSON.stringify(z)}\n`;
	const tail = zLine + fixedLine(4096 - Buffer.byteLength(zLine));
	fs.writeFileSync(file(), head + middle + tail);
	const from = readUsage(file());
	assert.equal(from.effective.total, 3);
	// Rewrite a record inside the last 4 KiB before the consumed offset and append more.
	const changed = assistant({ usage: use({ input: 222, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const changedLine = `${JSON.stringify(changed)}\n`;
	const newTail = changedLine + fixedLine(4096 - Buffer.byteLength(changedLine));
	const appended = assistant({ usage: use({ input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	fs.writeFileSync(file(), head + middle + newTail + `${JSON.stringify(appended)}\n`);
	const got = readUsage(file(), from);
	assert.equal(got.effective.total, oracleTotals(file()).total);
	assert.equal(got.effective.total, 1 + 222 + 9);
});

test("stops maxBytes at a line boundary and resumes to the one-shot total", (t) => {
	const { file } = setup(t);
	const lines = [
		`${JSON.stringify(assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) }))}\n`,
		`${JSON.stringify(assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) }))}\n`,
		`${JSON.stringify(assistant({ usage: use({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }) }))}\n`,
	];
	const boundary = Buffer.byteLength(lines[0] + lines[1]);
	fs.writeFileSync(file(), lines.join(""));
	const first = readUsage(file(), undefined, { maxBytes: boundary });
	assert.equal(first.bytesRead, boundary);
	assert.equal(first.effective.total, 3);
	assert.equal(first.done, false);
	const second = readUsage(file(), first);
	const oneshot = readUsage(file());
	assert.equal(second.done, true);
	assert.equal(second.effective.total, 6);
	assert.deepEqual(core(second.effective), core(oneshot.effective));
});

test("reads a 40 MiB record with usage at its end across a 32 MiB budget", (t) => {
	const { file } = setup(t);
	const record = assistant({ content: [{ type: "text", text: "a".repeat(40 * MiB) }], usage: use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) });
	fs.writeFileSync(file(), `${JSON.stringify(record)}\n`);
	const first = readUsage(file(), undefined, { maxBytes: 32 * MiB });
	assert.equal(first.bytesRead, 32 * MiB);
	assert.equal(first.offset, 0);
	assert.equal(first.effective.total, 0);
	assert.equal(first.done, false);
	const second = readUsage(file(), first, { maxBytes: 32 * MiB });
	assert.equal(second.done, true);
	assert.equal(second.effective.total, oracleTotals(file()).total);
	assert.equal(second.effective.total, 10);
	assert.equal(usageTimeline(file()).totals.total, 10);
});

test("sums a 70 MiB record with usage at its end or before content", (t) => {
	const { file } = setup(t);
	const usage = use({ input: 7, output: 8, cacheRead: 9, cacheWrite: 10 });
	const atEnd = {
		type: "message",
		id: nextId(),
		timestamp: iso(T0),
		message: { role: "assistant", content: [{ type: "text", text: "a".repeat(70 * MiB) }], provider: "p", model: "m", usage, stopReason: "stop", timestamp: T0 },
	};
	fs.writeFileSync(file("end.jsonl"), `${JSON.stringify(atEnd)}\n`);
	const gotEnd = readUsage(file("end.jsonl")).effective;
	assert.equal(gotEnd.total, 34);
	assert.equal(gotEnd.total, oracleTotals(file("end.jsonl")).total);

	const beforeContent = {
		type: "message",
		id: nextId(),
		timestamp: iso(T0),
		message: { role: "assistant", provider: "p", model: "m", usage, content: [{ type: "text", text: "b".repeat(70 * MiB) }], stopReason: "stop", timestamp: T0 },
	};
	fs.writeFileSync(file("start.jsonl"), `${JSON.stringify(beforeContent)}\n`);
	const gotStart = readUsage(file("start.jsonl")).effective;
	assert.equal(gotStart.total, 34);
	assert.equal(gotStart.total, oracleTotals(file("start.jsonl")).total);
});

test("ignores usage text inside a large record's content string", (t) => {
	const { file } = setup(t);
	const text = `${"x".repeat(17 * MiB)}"usage":{"input":999}${"y".repeat(16)}`;
	const record = assistant({ content: [{ type: "text", text }], usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }) });
	fs.writeFileSync(file(), `${JSON.stringify(record)}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 4);
	assert.equal(got.total, oracleTotals(file()).total);
});

test("the scanner captures the same fields in every chunk size", (t) => {
	const record = assistant({
		model: "claude-opus-5-5",
		responseModel: "claude-sonnet-4-5",
		usage: use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
		content: [{ type: "text", text: 'quote " slash \\ accent \u00e9' }],
	});
	const buffer = Buffer.from(JSON.stringify(record));
	const oneByte = scanInChunks(buffer, 1);
	const sevenBytes = scanInChunks(buffer, 7);
	const fourMiB = scanInChunks(buffer, 4 * MiB);
	assert.equal(oneByte.malformed, false);
	assert.deepEqual(oneByte, sevenBytes);
	assert.deepEqual(oneByte, fourMiB);
	assert.equal(oneByte.entry.type, "message");
	assert.equal(oneByte.entry.message.role, "assistant");
	assert.equal(oneByte.entry.message.provider, "anthropic-subscription");
	assert.equal(oneByte.entry.message.model, "claude-opus-5-5");
	assert.equal(oneByte.entry.message.responseModel, "claude-sonnet-4-5");
	assert.deepEqual(oneByte.entry.message.usage, use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));

	const usageLine = Buffer.from(JSON.stringify(usageEntry(use({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }), { provider: "openai", model: "gpt-5" })));
	const usageScan = scanInChunks(usageLine, 7);
	assert.equal(usageScan.malformed, false);
	assert.equal(usageScan.entry.type, "usage");
	assert.equal(usageScan.entry.provider, "openai");
	assert.equal(usageScan.entry.model, "gpt-5");
});

test("a resume from persisted fields without partial re-reads the cut record", (t) => {
	const { file } = setup(t);
	const record = assistant({ content: [{ type: "text", text: "a".repeat(MiB) }], usage: use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) });
	fs.writeFileSync(file(), `${JSON.stringify(record)}\n`);
	const first = readUsage(file(), undefined, { maxBytes: 512 * 1024 });
	assert.equal(first.effective.total, 0);
	assert.ok(first.partial);
	const persisted = { ...first };
	delete persisted.partial;
	const second = readUsage(file(), persisted);
	assert.equal(second.done, true);
	assert.equal(second.effective.total, oracleTotals(file()).total);
	assert.equal(second.effective.total, 10);
});

test("a 40 MiB record appended to a complete file honours maxBytes on every call", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) })]);
	const from = readUsage(file());
	assert.equal(from.effective.total, 1);
	const appended = assistant({ content: [{ type: "text", text: "c".repeat(40 * MiB) }], usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	appendRaw(file(), `${JSON.stringify(appended)}\n`);
	const first = readUsage(file(), from, { maxBytes: 32 * MiB });
	assert.equal(first.bytesRead, 32 * MiB);
	assert.equal(first.offset, from.offset);
	assert.equal(first.effective.total, 1);
	assert.equal(first.done, false);
	const second = readUsage(file(), first, { maxBytes: 32 * MiB });
	assert.ok(second.bytesRead <= 32 * MiB);
	assert.equal(second.done, true);
	assert.equal(second.effective.total, oracleTotals(file()).total);
	assert.equal(second.effective.total, 3);
});

test("recounts a replaced file with a new identity from zero", (t) => {
	const { file, dir } = setup(t);
	const a = assistant({ usage: use({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const headLine = `${JSON.stringify(a)}\n`;
	const head = headLine + fixedLine(4096 - Buffer.byteLength(headLine));
	const middle = fixedLine(4096);
	const z = assistant({ usage: use({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const tailLine = `${JSON.stringify(z)}\n`;
	const tail = tailLine + fixedLine(4096 - Buffer.byteLength(tailLine));
	fs.writeFileSync(file(), head + middle + tail);
	const from = readUsage(file());
	assert.equal(from.effective.total, 3);

	const changed = assistant({ usage: use({ input: 111, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const changedLine = `${JSON.stringify(changed)}\n`;
	const newMiddle = changedLine + fixedLine(Math.max(0, 4096 - Buffer.byteLength(changedLine)));
	const appended = assistant({ usage: use({ input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }) });
	const tmp = path.join(dir, "replacement.jsonl");
	fs.writeFileSync(tmp, head + newMiddle + tail + `${JSON.stringify(appended)}\n`);
	fs.rmSync(file(), { force: true });
	fs.renameSync(tmp, file());

	const got = readUsage(file(), from);
	assert.notEqual(got.ino, from.ino);
	assert.equal(got.effective.total, oracleTotals(file()).total);
	assert.equal(got.effective.total, 1 + 111 + 2 + 9);
});

test("10 committed tokens plus a 7-token final record count once across restart and newline", (t) => {
	const { file } = setup(t);
	const ten = usageEntry(use({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), { provider: "p", model: "m" });
	const seven = assistant({ usage: use({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) });
	fs.writeFileSync(file(), `${JSON.stringify(ten)}\n${JSON.stringify(seven)}`);
	const first = readUsage(file());
	assert.equal(first.usage.total, 10);
	assert.equal(first.effective.total, 17);
	assert.equal(usageTimeline(file()).totals.total, 17);

	const restarted = readUsage(file(), { ...first, partial: undefined });
	assert.equal(restarted.effective.total, 17);
	assert.equal(restarted.usage.total, 10);

	appendRaw(file(), "\n");
	const completed = readUsage(file(), { ...restarted, partial: undefined });
	assert.equal(completed.effective.total, 17);
	assert.equal(completed.usage.total, 17);
	assert.equal(usageTimeline(file()).totals.total, 17);
	assert.equal(completed.effective.models["anthropic-subscription/claude-opus-5-5"].tokens, 7);
});

test("counts a valid final fragment once and a torn fragment not at all", (t) => {
	const { file } = setup(t);
	const r1 = usageEntry(use({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), { provider: "p", model: "m" });
	const r2 = assistant({ usage: use({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) });
	fs.writeFileSync(file(), `${JSON.stringify(r1)}\n${JSON.stringify(r2)}`);
	const first = readUsage(file());
	assert.equal(first.effective.total, 12);
	assert.equal(first.effective.models["anthropic-subscription/claude-opus-5-5"].tokens, 7);
	const restarted = readUsage(file(), { ...first, partial: undefined });
	assert.equal(restarted.effective.total, 12);
	assert.equal(restarted.effective.models["anthropic-subscription/claude-opus-5-5"].tokens, 7);
	appendRaw(file(), "\n");
	const completed = readUsage(file(), { ...restarted, partial: undefined });
	assert.equal(completed.effective.total, 12);
	assert.equal(completed.effective.models["anthropic-subscription/claude-opus-5-5"].tokens, 7);

	const torn = setup(t);
	const tornR1 = usageEntry(use({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), { provider: "p", model: "m" });
	const tornR2 = assistant({ usage: use({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) });
	const full = JSON.stringify(tornR2);
	fs.writeFileSync(torn.file(), `${JSON.stringify(tornR1)}\n${full.slice(0, full.length - 4)}`);
	const tornRead = readUsage(torn.file()).effective;
	assert.equal(tornRead.total, 5);
	appendRaw(torn.file(), `${full.slice(full.length - 4)}\n`);
	const repaired = readUsage(torn.file()).effective;
	assert.equal(repaired.total, 12);
});

test("does not restart when a large record is appended to a 2 KiB file", (t) => {
	const { file } = setup(t);
	fs.writeFileSync(file(), fixedLine(2048));
	const from = readUsage(file());
	assert.equal(from.headLen, 2048);
	assert.equal(from.effective.total, 0);
	const marked = structuredClone(from);
	marked.usage.input += 1;
	marked.usage.total += 1;
	const big = assistant({ content: [{ type: "text", text: "d".repeat(40 * MiB) }], usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }) });
	appendRaw(file(), `${JSON.stringify(big)}\n`);
	const first = readUsage(file(), marked, { maxBytes: 32 * MiB });
	assert.equal(first.bytesRead, 32 * MiB);
	assert.equal(first.offset, from.offset);
	assert.equal(first.effective.total, 1);
	assert.equal(first.headLen, 4096);
	assert.equal(first.done, false);
	const second = readUsage(file(), first, { maxBytes: 32 * MiB });
	assert.equal(second.headLen, 4096);
	assert.equal(second.done, true);
	assert.equal(second.effective.total, oracleTotals(file()).total + 1);
});

test("a 20 MiB escaped ignored value streams under a 96 MB heap", (t) => {
	const { file } = setup(t);
	const usage = use({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0 });
	const escaped = "\\n".repeat(10 * MiB);
	const record = `{"type":"usage","provider":"openai","model":"gpt-5","pad":"${escaped}","usage":${JSON.stringify(usage)}}`;
	assert.ok(Buffer.byteLength(record) > 16 * MiB);
	fs.writeFileSync(file(), `${record}\n`);
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = [
		"const { readUsage } = await import(process.argv[1]);",
		"const result = readUsage(process.argv[2]);",
		"process.stdout.write(JSON.stringify({ total: result.effective.total, badLines: result.usage.diagnostics.badLines }));",
	].join("\n");
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, source, file()], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { total: 7, badLines: 0 });
});

test("a 40 MiB model id streams under a 96 MB heap and marks the model list incomplete", (t) => {
	const { file } = setup(t);
	const usage = use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
	const head = `{"type":"message","pad":"${"a".repeat(MiB)}","message":{"role":"assistant","provider":"openai","model":"`;
	const tail = `","usage":${JSON.stringify(usage)}}}\n`;
	const fd = fs.openSync(file(), "w");
	try {
		fs.writeSync(fd, head);
		const chunk = Buffer.alloc(MiB, 0x6d);
		for (let index = 0; index < 40; index += 1) fs.writeSync(fd, chunk);
		fs.writeSync(fd, tail);
	} finally {
		fs.closeSync(fd);
	}
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = [
		"const { readUsage } = await import(process.argv[1]);",
		"const result = readUsage(process.argv[2]);",
		"process.stdout.write(JSON.stringify({ total: result.effective.total, modelsIncomplete: result.effective.modelsIncomplete, models: Object.keys(result.effective.models) }));",
	].join("\n");
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, source, file()], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { total: 10, modelsIncomplete: true, models: ["openai/(model id too long)"] });
});

test("a 40 MiB note string is truncated while its usage still counts under a 96 MB heap", (t) => {
	const { file } = setup(t);
	const head = `{"type":"message","pad":"${"a".repeat(MiB)}","message":{"role":"assistant","provider":"openai","model":"m","usage":{"input":13,"note":"`;
	const tail = `"}}}\n`;
	const fd = fs.openSync(file(), "w");
	try {
		fs.writeSync(fd, head);
		const chunk = Buffer.alloc(MiB, 0x6e);
		for (let index = 0; index < 40; index += 1) fs.writeSync(fd, chunk);
		fs.writeSync(fd, tail);
	} finally {
		fs.closeSync(fd);
	}
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = [
		"const { readUsage } = await import(process.argv[1]);",
		"const result = readUsage(process.argv[2]);",
		"process.stdout.write(JSON.stringify({ total: result.effective.total, badLines: result.effective.diagnostics.badLines }));",
	].join("\n");
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, source, file()], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { total: 13, badLines: 0 });
});

test("(gate r4) legal whitespace is dropped without changing the usage or the winning duplicate", (t) => {
	const { file } = setup(t);
	const inner = " ".repeat(70 * 1024);
	const gap = " ".repeat(17 * MiB);
	const usage = `{"input":13,${inner}"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.125}}`;
	const cases = [
		`{"type":"usage","provider":"openai","model":"gpt-5",${gap}"usage":${usage}}`,
		`{"type":"usage","provider":"openai","model":"gpt-5","usage":{"input":999,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":9}},${gap}"usage":${usage}}`,
	];
	for (const [index, line] of cases.entries()) {
		const parsed = JSON.parse(line);
		fs.writeFileSync(file(`case-${index}.jsonl`), `${line}\n`);
		const got = readUsage(file(`case-${index}.jsonl`)).effective;
		assert.equal(got.total, 13);
		assert.equal(got.total, sumFour(parsed.usage));
		assert.equal(got.cost, 0.125);
		assert.equal(got.diagnostics.badLines, 0);
		assert.equal(got.total, oracleTotals(file(`case-${index}.jsonl`)).total);
	}
});

test("(gate r4) a dropped usage never removes the assistant provider and model from usedModels", (t) => {
	const { file } = setup(t);
	const note = "u".repeat(70 * 1024);
	const line = `{"type":"message","pad":"${"a".repeat(17 * MiB)}","message":{"role":"assistant","provider":"openai","model":"gpt-5","usage":{"input":999,"note":"${note}"},"usage":"${note}"}}`;
	const parsed = JSON.parse(line);
	assert.equal(typeof parsed.message.usage, "string");
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 0);
	assert.equal(got.diagnostics.badLines, 0);
	assert.deepEqual(got.usedModels, { "openai/gpt-5": true });
});

test("(gate r4) a truncated request model defers to a known responseModel, while data.model outside prewarm stays complete", (t) => {
	const { file } = setup(t);
	const model = "m".repeat(70 * 1024);
	const usage = use({ input: 13, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.125 });
	const assistantLine = `{"type":"message","pad":"${"a".repeat(17 * MiB)}","message":{"role":"assistant","provider":"openai","model":"${model}","responseModel":"claude-sonnet-4-5","usage":${JSON.stringify(usage)}}}`;
	fs.writeFileSync(file("assistant.jsonl"), `${assistantLine}\n`);
	const got = readUsage(file("assistant.jsonl")).effective;
	assert.equal(got.total, 13);
	assert.equal(got.models["openai/claude-sonnet-4-5"].tokens, 13);
	assert.equal(got.models["openai/(model id too long)"], undefined);
	assert.equal(got.modelsIncomplete, true);

	const otherLine = `{"type":"custom","customType":"other","pad":"${"a".repeat(17 * MiB)}","data":{"model":"${model}"}}`;
	fs.writeFileSync(file("other.jsonl"), `${otherLine}\n`);
	const otherGot = readUsage(file("other.jsonl")).effective;
	assert.equal(otherGot.total, 0);
	assert.equal(otherGot.modelsIncomplete, false);
	assert.deepEqual(otherGot.usedModels, {});
});

test("a 40 MiB string streams under a 96 MB heap with the JSON.parse-equal total", (t) => {
	const { file } = setup(t);
	const usage = use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.125 });
	const record = assistant({ content: [{ type: "text", text: "q".repeat(40 * MiB) }], usage });
	fs.writeFileSync(file(), `${JSON.stringify(record)}\n`);
	const expected = sumFour(JSON.parse(fs.readFileSync(file(), "utf8")).message.usage);
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = [
		"const { readUsage } = await import(process.argv[1]);",
		"const result = readUsage(process.argv[2]);",
		"process.stdout.write(JSON.stringify({ total: result.effective.total, badLines: result.usage.diagnostics.badLines, models: Object.keys(result.effective.models) }));",
	].join("\n");
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, source, file()], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { total: expected, badLines: 0, models: ["anthropic-subscription/claude-opus-5-5"] });
});

test("the scanner validates skipped literals and containers the way JSON.parse does", () => {
	for (const value of ["true", "false", "null", "0", "-0", "12", "-12", "1.5", "0.5", "1e3", "1E-4", "-1.25e+6"]) {
		const record = `{"type":"message","x":${value},"usage":{"input":1}}`;
		const scanned = scanInChunks(Buffer.from(record), 3);
		assert.equal(scanned.malformed, false, `valid literal ${value}`);
		assert.deepEqual(scanned.entry.usage, { input: 1 });
	}
	for (const value of ["broken", "True", "tru", "falsey", "nul", "01", "-", "-.5", "1.", ".5", "+1", "1e", "1e+", "NaN", "Infinity"]) {
		const record = `{"type":"message","x":${value},"usage":{"input":13}}`;
		assert.equal(scanInChunks(Buffer.from(record), 3).malformed, true, `invalid literal ${value}`);
	}
	for (const fragment of ["{}", "[]", "[1,2]", '{"x":[true,null,{"y":-1.5e+2}]}']) {
		const record = `{"type":"message","payload":${fragment},"usage":{"input":2}}`;
		assert.equal(scanInChunks(Buffer.from(record), 2).malformed, false, `valid container ${fragment}`);
	}
	for (const fragment of ['{"x":1,}', "[1,]", '{"x":1 "y":2}', "[1 2]"]) {
		const record = `{"type":"message","payload":${fragment},"usage":{"input":5}}`;
		assert.equal(scanInChunks(Buffer.from(record), 2).malformed, true, `invalid container ${fragment}`);
	}
});

test("a large record with an invalid string is rejected the way JSON.parse rejects it", (t) => {
	const cases = {
		"unknown escape": "\\q",
		"non-hex unicode escape": "\\u12zz",
		"raw control byte": "\t",
	};
	for (const [label, bad] of Object.entries(cases)) {
		const { file } = setup(t);
		const line = `{"type":"usage","provider":"openai","model":"gpt-5","pad":"${"a".repeat(17 * MiB)}${bad}","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}`;
		assert.throws(() => JSON.parse(line), undefined, label);
		fs.writeFileSync(file(), `${line}\n`);
		const got = readUsage(file());
		assert.equal(got.usage.diagnostics.badLines, 1, label);
		assert.equal(got.effective.total, 0, label);
	}
});

test("a large record keeps a captured model id longer than the key limit", (t) => {
	const { file } = setup(t);
	const model = "m".repeat(4097);
	const usage = use({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
	const line = `{"type":"message","pad":"${"a".repeat(17 * MiB)}","message":{"role":"assistant","provider":"openai","model":"${model}","usage":${JSON.stringify(usage)}}}`;
	assert.equal(JSON.parse(line).message.model.length, 4097);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, oracleTotals(file()).total);
	assert.equal(got.total, 10);
	assert.equal(got.models[`openai/${model}`]?.tokens, 10);
	assert.deepEqual(got.usedModels, { [`openai/${model}`]: true });
	assert.equal(got.modelsIncomplete, false);
});

test("a large record gives a repeated selected key its last value like JSON.parse", (t) => {
	const pad = "a".repeat(17 * MiB);
	const cases = [
		{
			label: "usage cleared by null",
			line: `{"type":"usage","pad":"${pad}","provider":"openai","model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}},"usage":null}`,
			check(got) {
				assert.equal(got.total, 0);
				assert.deepEqual(got.models, {});
			},
		},
		{
			label: "provider cleared by null",
			line: `{"type":"usage","pad":"${pad}","provider":"openai","provider":null,"model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}`,
			check(got, parsed) {
				assert.equal(got.total, 13);
				assert.deepEqual(Object.keys(got.models), [`${parsed.provider}/${parsed.model}`]);
			},
		},
		{
			label: "message cleared by null",
			line: `{"type":"message","pad":"${pad}","message":{"role":"assistant","provider":"openai","model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}},"message":null}`,
			check(got) {
				assert.equal(got.total, 0);
				assert.deepEqual(got.models, {});
			},
		},
		{
			label: "message replaced by an object without usage",
			line: `{"type":"message","pad":"${pad}","message":{"role":"assistant","provider":"openai","model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}},"message":{"role":"assistant","provider":"openai","model":"gpt-5"}}`,
			check(got) {
				assert.equal(got.total, 0);
				assert.deepEqual(got.models, {});
			},
		},
		{
			label: "data cleared by null",
			line: `{"type":"custom","customType":"prompt-cache-prewarm","pad":"${pad}","data":{"phase":"warmed","provider":"openai","model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}},"data":null}`,
			check(got) {
				assert.equal(got.total, 0);
				assert.deepEqual(got.models, {});
			},
		},
		{
			label: "data replaced by an object without usage",
			line: `{"type":"custom","customType":"prompt-cache-prewarm","pad":"${pad}","data":{"phase":"warmed","provider":"openai","model":"gpt-5","usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}},"data":{"phase":"warmed","provider":"openai","model":"gpt-5"}}`,
			check(got) {
				assert.equal(got.total, 0);
				assert.deepEqual(got.models, {});
			},
		},
	];
	for (const item of cases) {
		const { file } = setup(t);
		const parsed = JSON.parse(item.line);
		fs.writeFileSync(file(), `${item.line}\n`);
		const got = readUsage(file()).effective;
		assert.equal(got.diagnostics.badLines, 0, item.label);
		assert.equal(got.total, oracleTotals(file()).total, item.label);
		item.check(got, parsed);
	}
});

test("a large record with an invalid literal counts as bad and adds no usage", (t) => {
	const { file } = setup(t);
	const padding = "a".repeat(17 * MiB);
	const line = `{"type":"usage","pad":"${padding}","bad":broken,"usage":{"input":13,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}`;
	assert.throws(() => JSON.parse(line));
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file());
	assert.equal(got.usage.diagnostics.badLines, 1);
	assert.equal(got.effective.total, 0);
});

test("counts a malformed large record in badLines", (t) => {
	const { file } = setup(t);
	const malformed = `{"type":"usage","usage":{"input":1},"x":"${"a".repeat(17 * MiB)}"`;
	assert.throws(() => JSON.parse(malformed));
	fs.writeFileSync(file(), `${malformed}\n`);
	const got = readUsage(file());
	assert.equal(got.usage.diagnostics.badLines, 1);
	assert.equal(got.effective.total, 0);
});

function childUsageTotal(filePath) {
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = [
		"const { readUsage } = await import(process.argv[1]);",
		"const result = readUsage(process.argv[2]);",
		"process.stdout.write(JSON.stringify({ total: result.effective.total, badLines: result.usage.diagnostics.badLines }));",
	].join("\n");
	const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, source, filePath], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

const gate5Usage = () => ({ input: 7, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.125 }, costUnknown: true });

test("(gate 5) a 35 MiB reply made of 32 KiB text blocks counts like JSON.parse in readUsage and usageTimeline", (t) => {
	const { file } = setup(t);
	const usage = gate5Usage();
	const record = {
		type: "message",
		message: { role: "assistant", provider: "p", model: "alpha", usage, content: Array(1088).fill({ type: "text", text: "z".repeat(32768) }) },
	};
	fs.writeFileSync(file(), `${JSON.stringify(record)}\n`);
	assert.ok(fs.statSync(file()).size > 16 * MiB);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 13);
	assert.equal(got.total, oracleTotals(file()).total);
	assert.deepEqual(got.usedModels, { "p/alpha": true });
	assert.deepEqual(got.models, { "p/alpha": { tokens: 13, cost: 0.125 } });
	assert.equal(got.modelsIncomplete, false);
	assert.equal(usageTimeline(file()).totals.total, oracleTotals(file()).total);
});

test("(gate 5) a short literal \"\\u0000omoh-truncated\" model id counts as a normal model", (t) => {
	const { file } = setup(t);
	const line = `{${" ".repeat(17 * MiB)}"type":"message","message":${JSON.stringify({ role: "assistant", provider: "p", model: "\u0000omoh-truncated", usage: gate5Usage() })}}`;
	assert.ok(Buffer.byteLength(line) > 16 * MiB);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 13);
	assert.equal(got.total, oracleTotals(file()).total);
	assert.deepEqual(got.usedModels, { "p/\u0000omoh-truncated": true });
	assert.deepEqual(Object.keys(got.models), ["p/\u0000omoh-truncated"]);
	assert.equal(got.modelsIncomplete, false);
});

test("(gate 5) a long responseModel on a toolResult never marks the model list incomplete", (t) => {
	const { file } = setup(t);
	const line = `{${" ".repeat(17 * MiB)}"type":"message","message":${JSON.stringify({ role: "toolResult", content: [], responseModel: "r".repeat(65537) })}}`;
	assert.ok(Buffer.byteLength(line) > 16 * MiB);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 0);
	assert.equal(got.total, oracleTotals(file()).total);
	assert.deepEqual(got.usedModels, {});
	assert.equal(got.modelsIncomplete, false);
	assert.equal(got.diagnostics.badLines, 0);
});

test("(gate 5) a 22 MiB retained structure streams under a 96 MB heap with the JSON.parse-equal total", (t) => {
	const { file } = setup(t);
	const message = { role: "assistant", provider: "p", model: "alpha", usage: gate5Usage() };
	const line = `{${" ".repeat(17 * MiB)}"type":"message","message":${JSON.stringify(message)},"data":[${'{},'.repeat(1600000)}{}]}`;
	assert.ok(Buffer.byteLength(line) > 16 * MiB);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 13);
	assert.equal(got.total, oracleTotals(file()).total);
	assert.deepEqual(got.usedModels, { "p/alpha": true });
	assert.equal(got.modelsIncomplete, false);
	assert.equal(got.diagnostics.badLines, 0);
	const child = childUsageTotal(file());
	assert.equal(child.badLines, 0);
	assert.equal(child.total, oracleTotals(file()).total);
});

test("(gate 5) a 17 MiB duplicate message replacement is the JSON.parse total under a 96 MB heap", (t) => {
	const { file } = setup(t);
	const message = { role: "assistant", provider: "p", model: "alpha", usage: gate5Usage() };
	const line = `{"pad":"${'x'.repeat(17 * MiB)}","type":"message","message":${JSON.stringify(message)},"message":{"role":"assistant","provider":"p","model":"beta"}}`;
	assert.ok(Buffer.byteLength(line) > 16 * MiB);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 0);
	assert.equal(got.total, oracleTotals(file()).total);
	assert.deepEqual(got.usedModels, { "p/beta": true });
	assert.equal(got.modelsIncomplete, false);
	const child = childUsageTotal(file());
	assert.equal(child.badLines, 0);
	assert.equal(child.total, oracleTotals(file()).total);
});

const gate6Gap = " ".repeat(17 * MiB);
const gate6Long = "r".repeat(65537);
const gate6Message = { role: "assistant", provider: "p", model: "alpha", usage: gate5Usage() };

function gate6Oracle(line) {
	const entry = JSON.parse(line);
	const expected = emptyUsage();
	const hit = usageOfEntry(entry);
	if (hit) addUsage(expected, hit);
	const models = modelsOfEntry(entry);
	for (const id of models.ids) expected.usedModels[id] = true;
	expected.modelsIncomplete = models.incomplete;
	return expected;
}

function assertLargeRecordParity(t, line, { capped = false } = {}) {
	const { file } = setup(t);
	const expected = gate6Oracle(line);
	fs.writeFileSync(file(), `${line}\n`);
	assert.ok(fs.statSync(file()).size > 16 * MiB);
	if (!capped) {
		assert.deepEqual(readUsage(file()).effective, expected, "readUsage");
		assert.deepEqual(usageTimeline(file()).totals, expected, "usageTimeline");
		return expected;
	}
	const source = new URL("../src/collect/usage.mjs", import.meta.url).href;
	const script = `
		const { readUsage, usageTimeline } = await import(process.argv[1]);
		const file = process.argv[2];
		if (process.argv[3] === "usageTimeline") {
			console.log(JSON.stringify(usageTimeline(file).totals));
		} else {
			let state;
			do { state = readUsage(file, state, { maxBytes: 5 * 1024 * 1024 }); } while (!state.done);
			console.log(JSON.stringify(state.effective));
		}
	`;
	for (const reader of ["readUsage", "usageTimeline"]) {
		const child = spawnSync(process.execPath, [
			"--max-old-space-size=96", "--max-semi-space-size=1", "--input-type=module", "-e", script, source, file(), reader,
		], { encoding: "utf8" });
		assert.equal(child.status, 0, `${reader}: ${child.stderr || child.error || child.signal}`);
		assert.deepEqual(JSON.parse(child.stdout), expected, reader);
	}
	return expected;
}

test("(gate 6 row 5) ignored usage.details objects fit under a 96 MiB heap", (t) => {
	const message = JSON.stringify(gate6Message);
	const line = `{${gate6Gap}"type":"message","message":${message.slice(0, -2)},"details":[${'{},'.repeat(1600000)}{}]}}}`;
	assertLargeRecordParity(t, line, { capped: true });
});

test("(gate 6 row 6) ignored usage.details text blocks do not discard usage", (t) => {
	const details = Array(1088).fill({ text: "z".repeat(32768) });
	const line = JSON.stringify({ type: "message", message: { ...gate6Message, usage: { ...gate6Message.usage, details } } });
	assertLargeRecordParity(t, line, { capped: true });
});

test("(gate 6 row 7) ignored nesting at the old depth limit does not discard usage", (t) => {
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify(gate6Message)},"ignored":${"[".repeat(1024)}0${"]".repeat(1024)}}`;
	assertLargeRecordParity(t, line);
});

test("(gate 6 row 8) an overlong last role replaces assistant", (t) => {
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify(gate6Message).slice(0, -1)},"role":"${gate6Long}"}}`;
	assert.equal(assertLargeRecordParity(t, line).total, 0);
});

test("(gate 6 row 9) a tool result's long provider satisfies its presence check", (t) => {
	const message = { role: "toolResult", provider: gate6Long, usage: gate6Message.usage };
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify(message)}}`;
	assert.equal(assertLargeRecordParity(t, line).modelsIncomplete, false);
});

test("(gate 6 row 10) a compaction's long model satisfies its presence check", (t) => {
	const line = `{${gate6Gap}"type":"compaction","model":"${gate6Long}","usage":${JSON.stringify(gate6Message.usage)}}`;
	assert.equal(assertLargeRecordParity(t, line).modelsIncomplete, false);
});

test("(gate 6) a selected array identity preserves billing coercion", (t) => {
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify({ ...gate6Message, provider: ["p"] })}}`;
	assert.deepEqual(assertLargeRecordParity(t, line).models, { "p/alpha": { tokens: 13, cost: 0.125 } });
});

test("(gate 6) two million ignored levels validate under a 96 MiB heap", (t) => {
	const levels = 1000000;
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify(gate6Message)},"ignored":${'[{"x":'.repeat(levels)}0${"}]".repeat(levels)}}`;
	assertLargeRecordParity(t, line, { capped: true });

	const { file } = setup(t);
	fs.writeFileSync(file(), `${line.slice(0, -1)}!}\n`);
	for (const totals of [readUsage(file()).effective, usageTimeline(file()).totals]) {
		assert.equal(totals.total, 0);
		assert.deepEqual(totals.diagnostics, { badLines: 1, skippedLines: 0 });
	}
});

test("(gate 6) a 2 MiB counter rounds like JSON.parse even when a distant digit breaks a tie", (t) => {
	const midpoint = "1.00000000000000011102230246251565404236316680908203125";
	const literal = `${midpoint}${"0".repeat(2 * MiB - midpoint.length - 1)}1`;
	const line = `{${gate6Gap}"type":"usage","provider":"p","model":"alpha","usage":{"input":${literal}}}`;
	assert.equal(assertLargeRecordParity(t, line).input, 1 + Number.EPSILON);
});

test("(gate 6) an escaped duplicate role is compared after unescaping", (t) => {
	const line = `{${gate6Gap}"type":"message","message":${JSON.stringify(gate6Message).slice(0, -1)},"\\u0072ole":"user"}}`;
	assert.equal(assertLargeRecordParity(t, line).total, 0);
});

test("(gate 6) oversized non-string identities bill as too long without implying a lost model id", (t) => {
	const { file } = setup(t);
	const message = { ...gate6Message, provider: [gate6Long] };
	fs.writeFileSync(file(), `{${gate6Gap}"type":"message","message":${JSON.stringify(message)}}\n`);
	const got = readUsage(file()).effective;
	assert.deepEqual(got.models, { "(model id too long)/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.usedModels, {});
	assert.equal(got.modelsIncomplete, false);
});

test("(gate 6) only a winning oversized non-number usage leaf skips usage", (t) => {
	const { file } = setup(t);
	const prefix = `{${gate6Gap}"type":"usage","provider":"p","model":"alpha","usage":{"output":2,"input":"${gate6Long}"`;
	for (const [suffix, skipped, total] of [["}}\n", 1, 0], [',"input":7}}\n', 0, 9], ["}}", 1, 0]]) {
		fs.writeFileSync(file(), prefix + suffix);
		for (const got of [readUsage(file()).effective, usageTimeline(file()).totals]) {
			assert.equal(got.total, total);
			assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: skipped });
			assert.deepEqual(got.usedModels, { "p/alpha": true });
			assert.equal(got.modelsIncomplete, false);
		}
	}
});

const gate7Usage = { input: 7, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.125 } };
const gate7Message = { role: "assistant", provider: "p", model: "alpha", usage: gate7Usage };
const gate7Make = (attrs) => `{${gate6Gap}${JSON.stringify(attrs).slice(1)}`;

test("(gate 7) an oversized unused top-level usage keeps an assistant message's usage", (t) => {
	const line = gate7Make({ type: "message", usage: { input: gate6Long }, message: gate7Message });
	const got = assertLargeRecordParity(t, line);
	assert.equal(got.total, 13);
	assert.deepEqual(got.models, { "p/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: 0 });
});

test("(gate 7) an oversized unused data.usage keeps a type usage entry's usage", (t) => {
	const line = gate7Make({ data: { usage: { output: gate6Long } }, provider: "p", model: "alpha", usage: gate7Usage, type: "usage" });
	const got = assertLargeRecordParity(t, line);
	assert.equal(got.total, 13);
	assert.deepEqual(got.models, { "p/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: 0 });
});

test("(gate 7) an oversized costUnknown keeps its prefix and still bills the counters", (t) => {
	const line = gate7Make({ type: "message", message: { ...gate7Message, usage: { ...gate7Usage, costUnknown: gate6Long } } });
	const got = assertLargeRecordParity(t, line);
	assert.equal(got.total, 13);
	assert.equal(got.costUnknown, false);
	assert.deepEqual(got.models, { "p/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: 0 });
});

test("(gate 7) a non-coercible provider bills a small record under an unreadable model id", (t) => {
	const { file } = setup(t);
	const entry = { type: "usage", provider: { toString: "p" }, model: "alpha", usage: gate7Usage };
	writeRecords(file(), [entry]);
	assert.throws(() => `${JSON.parse(fs.readFileSync(file(), "utf8")).provider}`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 13);
	assert.equal(got.cost, 0.125);
	assert.deepEqual(got.models, { "(model id unreadable)/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: 0 });
	assert.deepEqual(usageTimeline(file()).totals, got);
});

test("(gate 7) a non-coercible provider bills a >16 MiB record under an unreadable model id", (t) => {
	const { file } = setup(t);
	const line = gate7Make({ type: "usage", provider: { toString: "p" }, model: "alpha", usage: gate7Usage });
	assert.ok(Buffer.byteLength(line) > 16 * MiB);
	fs.writeFileSync(file(), `${line}\n`);
	const got = readUsage(file()).effective;
	assert.equal(got.total, 13);
	assert.equal(got.cost, 0.125);
	assert.deepEqual(got.models, { "(model id unreadable)/alpha": { tokens: 13, cost: 0.125 } });
	assert.deepEqual(got.usedModels, {});
	assert.deepEqual(got.diagnostics, { badLines: 0, skippedLines: 0 });
	assert.deepEqual(usageTimeline(file()).totals, got);
});

const gate8Message = (message = {}, entry = {}) => JSON.stringify({
	type: "message", message: { ...gate7Message, ...message }, ...entry,
});

function gate8Parity(file, text) {
	fs.writeFileSync(file, text);
	const expected = emptyUsage();
	for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			expected.diagnostics.badLines += 1;
			continue;
		}
		const hit = usageOfEntry(entry);
		if (hit) addUsage(expected, hit);
		const models = modelsOfEntry(entry);
		expected.modelsIncomplete ||= models.incomplete;
		for (const id of models.ids) expected.usedModels[id] = true;
	}
	const got = readUsage(file).effective;
	const timeline = usageTimeline(file);
	for (const [reader, totals] of [["readUsage", got], ["usageTimeline", timeline.totals]]) {
		assert.deepEqual(core(totals), core(expected), reader);
		assert.equal(totals.diagnostics.badLines, expected.diagnostics.badLines, reader);
	}
	return timeline;
}

test("(gate 8) escaped usage bills the same as compact and large records", (t) => {
	const { file } = setup(t);
	const compact = gate8Message({ responseModel: { toString: "p" } });
	const escaped = compact.replace('"usage"', '"\\u0075sage"').replace('"role":"assistant"', '"role": "assistant"');
	for (const [line, projected] of [[compact, false], [`{${gate6Gap}${escaped.slice(1)}`, true], [escaped, false]]) {
		const timeline = gate8Parity(file(), `${line}\n`);
		assert.deepEqual(timeline.totals.models, { "p/(model id unreadable)": { tokens: 13, cost: 0.125 } });
		assert.deepEqual(timeline.totals.usedModels, { "p/alpha": true });
		assert.deepEqual(timeline.topTurns.map((turn) => turn.key), projected ? [] : ["p/(model id unreadable)"]);
	}
});

test("(gate 8) escaped usage at EOF is included in both readers", (t) => {
	const { file } = setup(t);
	const line = gate8Message({ role: "toolResult" }).replace('"usage"', '"\\u0075sage"');
	assert.equal(gate8Parity(file(), line).totals.total, 13);
	assert.equal(readUsage(file()).overlay.total, 13);
});

test("(gate 8) only a single BOM at byte zero can be stripped", (t) => {
	const { file } = setup(t);
	const line = gate8Message();
	assert.equal(gate8Parity(file(), `\uFEFF${line}\n`).totals.total, 13);
	assert.equal(gate8Parity(file(), `{}\n\uFEFF${line}\n`).totals.total, 0);
	assert.equal(gate8Parity(file(), `\uFEFF\uFEFF${line}\n`).totals.total, 0);
});

test("(gate 8) a non-coercible timestamp does not abort accounting", (t) => {
	const { file } = setup(t);
	const line = gate8Message({}, { timestamp: { toString: "p" } });
	const missing = gate8Parity(file(), `${line}\n`);
	assert.equal(missing.totals.total, 13);
	assert.deepEqual(missing.hours, []);
	assert.ok(Number.isNaN(missing.topTurns[0].ms));
	const fallback = gate8Parity(file(), gate8Message({ timestamp: T0 }, { timestamp: [iso(T0 + HOUR)] }));
	assert.equal(fallback.topTurns[0].ms, T0);
	assert.deepEqual(fallback.hours, [{ hourMs: Math.floor(T0 / HOUR) * HOUR, tokens: 13, turns: 1 }]);
	const numeric = gate8Parity(file(), gate8Message({}, { timestamp: 0 }));
	assert.equal(numeric.topTurns[0].ms, 0);
});

test("(gate 8) spaced assistant role still contributes a model without usage", (t) => {
	const { file } = setup(t);
	const line = gate8Message({ usage: undefined }).replace('"role":"assistant"', '"role"\t:\t"assistant"');
	assert.deepEqual(gate8Parity(file(), `${line}\n`).totals.usedModels, { "p/alpha": true });
});

test("(gate 8) timeline recognizes stats-only tool errors with separator whitespace", (t) => {
	const { file } = setup(t);
	const line = '{"type":"message","message":{"role":"toolResult","toolName":"bash","isError" : true}}';
	const timeline = gate8Parity(file(), `${line}\n`);
	assert.deepEqual(timeline.tools, [{ name: "bash", calls: 0, errors: 1 }]);
	assert.deepEqual(timeline.totals.diagnostics, readUsage(file()).effective.diagnostics);
});

test("(gate 8) timeline recognizes an escaped image type", (t) => {
	const { file } = setup(t);
	const image = '{"type":"message","message":{"role":"user","content":[{"type":"im\\u0061ge","bytes":1048576}]}}';
	assert.deepEqual(gate8Parity(file(), image).images, { peakCount: 1, peakMiB: 1 });
});

test("(gate 8) an error turn with non-text error detail is classified without coercion", (t) => {
	const { file } = setup(t);
	const line = gate8Message({ stopReason: "error", errorMessage: { toString: "usage limit" } });
	const timeline = gate8Parity(file(), `${line}\n`);
	assert.equal(timeline.totals.total, 13);
	assert.deepEqual(timeline.errors, { count: 1, byClass: { other: 1 } });
});

test("(gate 8) nonnumeric saved cursor fields trigger a recount without coercion", (t) => {
	const { file } = setup(t);
	const expected = gate8Parity(file(), `${gate8Message()}\n`).totals;
	const saved = readUsage(file());
	for (const key of ["size", "offset", "headLen"]) {
		const from = { ...saved, [key]: JSON.parse('{"toString":null,"valueOf":null}') };
		assert.deepEqual(readUsage(file(), from).effective, expected, key);
	}
});

test("(gate 8) corrupt parsed usage accumulators trigger a recount", (t) => {
	const { file } = setup(t);
	const expected = gate8Parity(file(), `${gate8Message()}\n`).totals;
	const saved = readUsage(file());
	for (const invalid of ['{"total":{"toString":null}}', '{"models":{"p/alpha":{"tokens":{"toString":null}}}}', '{"usedModels":{"__proto__":true}}']) {
		const from = { ...saved, usage: { ...saved.usage, ...JSON.parse(invalid) } };
		assert.deepEqual(readUsage(file(), from).effective, expected, invalid);
	}
});

test("(gate 8) only a live partial accumulator can resume mid-record", (t) => {
	const { file } = setup(t);
	const expected = gate8Parity(file(), `${gate8Message()}\n`).totals;
	const saved = readUsage(file(), undefined, { maxBytes: 8 });
	const from = { ...saved, partial: JSON.parse('{"start":0,"kind":"scanner","scanner":null}') };
	assert.deepEqual(readUsage(file(), from).effective, expected);
});

test("returns null for a missing file", (t) => {
	const { file } = setup(t);
	assert.equal(readUsage(file("absent.jsonl")), null);
	assert.equal(usageTimeline(file("absent.jsonl")), null);
});

test("ignores toolResult text that only mentions usage", (t) => {
	const { file } = setup(t);
	writeRecords(file(), [toolResult({ text: "usage limit reached; usage: 100" })]);
	const got = readUsage(file());
	assert.equal(got.effective.total, 0);
});

test("usageTimeline reports buckets, turns, cache, errors, tools and images equal to readUsage", (t) => {
	const { file } = setup(t);
	const a1 = assistant({
		ms: T0,
		usage: use({ input: 10, output: 90, cacheRead: 0, cacheWrite: 60, cost: 1 }),
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
	});
	const a2 = assistant({
		ms: T0 + 5 * MIN,
		usage: use({ input: 100, output: 100, cacheRead: 800, cacheWrite: 10, cost: 2 }),
		stopReason: "error",
		errorMessage: "usage limit reached",
	});
	const a3 = assistant({ ms: T0 + 2 * HOUR + 2 * MIN, usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0 }) });
	const a4 = assistant({ ms: T0 + 3 * HOUR, model: "claude-haiku-4", usage: undefined });
	writeRecords(file(), [
		a1,
		toolResult({ ms: T0 + 1000, name: "bash", isError: true }),
		a2,
		userImages(2, T0 + 30 * MIN),
		compaction(use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0 }), { ms: T0 + 40 * MIN }),
		a3,
		userImages(1, T0 + 2 * HOUR + 3 * MIN),
		prewarm("failed", { provider: "xai", model: "grok-5" }),
		a4,
	]);
	const timeline = usageTimeline(file(), { cacheStormWrite: 50, cacheStormReadFrac: 0.5 });
	const full = readUsage(file()).effective;
	assert.deepEqual(core(timeline.totals), core(full));
	assert.equal(timeline.totals.total, 1178);
	assert.equal(timeline.totals.turns, 3);
	assert.deepEqual(timeline.hours, [
		{ hourMs: Date.UTC(2026, 8, 28, 10), tokens: 1170, turns: 2 },
		{ hourMs: Date.UTC(2026, 8, 28, 12), tokens: 4, turns: 1 },
	]);
	assert.deepEqual(
		timeline.topTurns.map((turn) => [turn.total, turn.key, turn.stopReason]),
		[
			[1010, "anthropic-subscription/claude-opus-5-5", "error"],
			[160, "anthropic-subscription/claude-opus-5-5", "toolUse"],
			[4, "anthropic-subscription/claude-opus-5-5", "stop"],
		],
	);
	assert.equal(timeline.cache.stormTurns, 1);
	assert.ok(Math.abs(timeline.cache.hitRate - 802 / 986) < 1e-12);
	assert.deepEqual(timeline.errors, { count: 1, byClass: { "usage-limit": 1 } });
	assert.deepEqual(timeline.tools, [{ name: "bash", calls: 1, errors: 1 }]);
	assert.equal(timeline.images.peakCount, 2);
	assert.ok(Math.abs(timeline.images.peakMiB - 6 / MiB) < 1e-12);
	assert.equal(typeof timeline.prepMs, "number");
});

test("usageTimeline returns null above maxFileBytes", (t) => {
	const { file } = setup(t);
	fs.writeFileSync(file(), fixedLine(2 * MiB));
	assert.equal(usageTimeline(file(), { maxFileBytes: MiB }), null);
});
