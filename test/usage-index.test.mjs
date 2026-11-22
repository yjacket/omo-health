import "./helpers/tmp-root.mjs";
import { SubjectMap, subjectOf, subjectKey } from "../src/session-subject.mjs";
const sub = (sessionId, cwd) => subjectOf({ sessionId, cwd });
const key = (sessionId, cwd) => subjectKey(sub(sessionId, cwd));
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers/fixtures.mjs";
import { readUsage, RECORD_STRUCTURE_LIMIT, usageTimeline } from "../src/collect/usage.mjs";
import { DAEMON_NODE_ARGS } from "../src/launch.mjs";
import { createFakeClock, iso } from "../src/util/time.mjs";
import {
	USAGE_INDEX_VERSION,
	USAGE_TICK_BYTES,
	INDEX_BYTE_BUDGET,
	compactUsage,
	createUsageIndex,
	fresh,
	readUsageIndex,
	treeTotals,
} from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";

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
function parseIndex(text) {
	const [header, ...lines] = text.trimEnd().split("\n");
	return { ...JSON.parse(header), entries: Object.fromEntries(lines.map((line) => {
		const entry = JSON.parse(line);
		return [entry.id, entry];
	})) };
}

function indexText({ v, entries }) {
	return [JSON.stringify({ v }), ...Object.values(entries).map((entry) => JSON.stringify(entry))].join("\n") + "\n";
}

test("(IS-1, IS-12) a dense 15 MiB tool result publishes under the daemon heap cap", (t) => {
	const { dir, fileOf } = setup(t);
	const file = fileOf();
	const next = fileOf("next.jsonl");
	const item = '{"x":[{}],"y":0},';
	fs.writeFileSync(file, `{"type":"message","message":{"role":"toolResult","provider":"p","model":"m","content":[${item.repeat(980_000)}{}],"usage":{"input":40,"output":2}}}\n`);
	assert.ok(fs.statSync(file).size > 14 * MiB && fs.statSync(file).size < 16 * MiB);
	fs.writeFileSync(next, '{"type":"usage","provider":"p","model":"m","usage":{"input":7}}\n');
	const oracle = (path) => {
		const entry = JSON.parse(fs.readFileSync(path, "utf8"));
		const { input, output = 0, cacheRead = 0, cacheWrite = 0 } = entry.message?.usage ?? entry.usage;
		return input + output + cacheRead + cacheWrite;
	};
	const expected = oracle(file);
	assert.equal(expected, 42);

	const program = `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { usageTimeline } from ${JSON.stringify(new URL("../src/collect/usage.mjs", import.meta.url).href)};
		import { createUsageIndex, USAGE_TICK_BYTES } from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
		import { createFakeClock } from ${JSON.stringify(new URL("../src/util/time.mjs", import.meta.url).href)};
		const [reader, file, next, indexFile] = process.argv.slice(1);
		if (reader === "timeline") {
			console.log(JSON.stringify(usageTimeline(file).totals));
		} else {
			const clock = createFakeClock(${T0});
			const index = createUsageIndex({ file: indexFile, clock });
			const update = () => index.update(sub("dense"), file, {}, { maxBytes: USAGE_TICK_BYTES });
			update();
			assert.equal(index.get(key("dense")).complete, true);
			const first = index.get(key("dense")).published;
			fs.appendFileSync(file, fs.readFileSync(next));
			clock.advance(10_000);
			update();
			assert.equal(index.get(key("dense")).complete, true);
			console.log(JSON.stringify({ first, next: index.get(key("dense")).published }));
		}
	`;
	const results = {};
	const errors = [];
	// Run the timeline first: the index subprocess appends a second record.
	for (const reader of ["timeline", "index"]) {
		const child = spawnSync(process.execPath, [
			...DAEMON_NODE_ARGS, "--input-type=module", "-e", program, reader, file, next, fileOf("usage.json"),
		], { cwd: dir, encoding: "utf8" });
		if (child.status !== 0) {
			errors.push(`${reader}: exit ${child.status}, signal ${child.signal}\n${child.stderr || child.error}`);
		} else results[reader] = JSON.parse(child.stdout);
	}
	assert.equal(errors.join("\n"), "");
	assert.equal(results.index.first.total, expected);
	assert.deepEqual(results.timeline, results.index.first);
	assert.deepEqual(results.index.first.diagnostics, { badLines: 0, skippedLines: 0 });
	assert.equal(results.index.next.total, expected + oracle(next));
});

test("(IS-1) a 2 MiB EOF record keeps its JSON.parse billing row across newline and index reload", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const id = "medium-eof";
	const model = { label: "m".repeat(128 * 1024) };
	const record = assistant({ model });
	record.message.content[0].text = "x".repeat(2 * MiB - Buffer.byteLength(JSON.stringify(record)));
	writeText(file, JSON.stringify(record));
	assert.equal(fs.statSync(file).size, 2 * MiB);

	const oracle = () => {
		const { message } = JSON.parse(fs.readFileSync(file, "utf8"));
		const { input, output, cacheRead, cacheWrite, cost } = message.usage;
		return [[`${message.provider}/${String(message.model)}`, {
			input, output, cacheRead, cacheWrite, tokens: input + output + cacheRead + cacheWrite, cost: cost.total,
		}]];
	};
	const models = ({ models }) => Object.entries(models);
	const budget = { maxBytes: USAGE_TICK_BYTES };
	const live = indexOf();
	const observations = {};
	const expected = {};
	const observe = (label, usage) => {
		observations[label] = models(usage);
		expected[label] = oracle();
	};
	live.update(sub(id), file, {}, budget);
	observe("live EOF", live.get(key(id)).published);
	observe("timeline EOF", usageTimeline(file).totals);
	assert.equal(live.save(), true);
	const reloaded = indexOf();
	observe("reloaded EOF", reloaded.get(key(id)).published);

	fs.appendFileSync(file, "\n");
	live.update(sub(id), file, {}, budget);
	reloaded.update(sub(id), file, {}, budget);
	observe("live newline", live.get(key(id)).published);
	observe("reloaded newline", reloaded.get(key(id)).published);
	observe("timeline newline", usageTimeline(file).totals);
	assert.deepEqual(observations, expected);
});

test("(IS-1, IS-12) resumed records reread at the structural limit but stream one token above it", (t) => {
	const { fileOf } = setup(t);
	const file = fileOf();
	const model = JSON.stringify({ label: "m".repeat(128 * 1024) });
	// Cut immediately after the backslash of an escaped quote, inside a string
	// full of punctuation. Neither the punctuation nor the quote is structural.
	const prefix = `{"type":"usage","provider":"p","model":${model},"usage":{"input":42},"padding":"${"x".repeat(MiB)}\\`;
	for (const extra of [0, 1]) {
		// Four container openers and five commas before the array elements.
		const suffix = `"${",[{".repeat(RECORD_STRUCTURE_LIMIT)}","ignored":[${"0,".repeat(RECORD_STRUCTURE_LIMIT - 9 + extra)}0]}\n`;
		fs.writeFileSync(file, prefix + suffix);
		const partial = readUsage(file, undefined, { maxBytes: Buffer.byteLength(prefix) });
		assert.equal(partial.done, false);
		const delimited = readUsage(file, partial, { maxBytes: Buffer.byteLength(suffix) });
		assert.equal(delimited.pending, extra === 0);
		assert.equal(delimited.done, extra === 1);
		const resumed = extra ? delimited : readUsage(file, delimited);
		assert.equal(resumed.done, true);
		assert.equal(resumed.bytesRead, extra ? suffix.length : prefix.length + suffix.length - 1);
		assert.deepEqual(resumed.effective, usageTimeline(file).totals);
		assert.equal(resumed.effective.total, 42);
		assert.deepEqual(resumed.effective.diagnostics, { badLines: 0, skippedLines: 0 });
		assert.deepEqual(Object.keys(resumed.effective.models), [extra ? "p/(model id too long)" : "p/[object Object]"]);
		assert.equal(resumed.effective.modelsIncomplete, true);
	}
});

test("(gate 17) saturated index save, daemon reload, and audit preparation fit in 66 MiB", (t) => {
	const { dir } = setup(t);
	const program = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getHeapSpaceStatistics } from "node:v8";
import { createUsageIndex, INDEX_BYTE_BUDGET, INDEX_ENTRY_OVERHEAD } from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
import { resolvePaths } from ${JSON.stringify(new URL("../src/paths.mjs", import.meta.url).href)};
import { createAuditor, requestAudit, readAuditState } from ${JSON.stringify(new URL("../src/auditor.mjs", import.meta.url).href)};
import { appendEnded } from ${JSON.stringify(new URL("../src/session-ledger.mjs", import.meta.url).href)};
import { DEFAULT_CONFIG } from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)};

const [stage, shape, dir] = process.argv.slice(1);
const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health"), OMO_HEALTH_OMO_HOME: path.join(dir, ".omo") });
const file = paths.health.usageIndexFile;
const now = ${T0};
let checked = now;
const clock = { now: () => checked };
const transcript = path.join(dir, "session.jsonl");
const oldSpace = () => getHeapSpaceStatistics()
	.filter(({ space_name }) => !space_name.startsWith("new") && !space_name.startsWith("read_only"))
	.reduce((sum, space) => sum + space.space_used_size, 0);
global.gc();
const base = oldSpace();
const index = createUsageIndex({ file, clock });
let peak = oldSpace();
const sample = () => { peak = Math.max(peak, oldSpace()); };
if (stage === "write") {
	fs.writeFileSync(transcript, '{"type":"usage","provider":"openai","model":"gpt-5-5","usage":{"input":42,"cost":{"total":0.0001}}}\\n');
	index.update(sub("reviewed"), transcript, { kind: "main" });
	for (let i = 0; i < 200000 && !index.full; i++) {
		checked--;
		const id = "01aaa000-0000-7000-8000-" + String(i).padStart(12, "0");
		const parentSessionId = "group" + (i % 100);
		if (shape === "models") {
			index.update(sub(id), transcript, { kind: "main", parentSessionId });
		} else {
			const file = shape === "mixed" ? "C:/작업/" + ("a".repeat(194) + "/").repeat(24) + id + ".jsonl"
				: shape === "korean" ? "C:/" + ("작".repeat(195) + "/").repeat(18) + "업".repeat(7) + id : null;
			index.markMissing(sub(id), { kind: "main", parentSessionId: shape === "dense" ? parentSessionId : null, file });
		}
		if (i % 1000 === 0) sample();
	}
	assert.ok(index.full);
	sample();
	assert.ok(index.save());
} else if (stage === "audit") {
	fs.mkdirSync(path.dirname(paths.omoJsonc), { recursive: true });
	fs.mkdirSync(path.dirname(paths.authFile), { recursive: true });
	fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["google/gemini-3-pro"] } } } }));
	fs.writeFileSync(paths.authFile, JSON.stringify({ google: {} }));
	appendEnded(paths, { sessionId: "reviewed", kind: "main", startedMs: now - 120000, endedMs: now - 60000, outcome: "completed" });
	requestAudit(paths, sub("reviewed"), now);
	let starts = 0;
	const auditor = createAuditor({ paths, index, config: DEFAULT_CONFIG, clock, env: {}, timelineMaxBytes: 0, runner: {
		start() { starts++; sample(); return { pid: 1 }; },
	} });
	auditor.tick(now + 1);
	await auditor.preparing();
	auditor.tick(now + 1);
	assert.equal(starts, 1);
	assert.equal(readAuditState(paths, sub("reviewed")).status, "running");
}
assert.equal(index.full, true);
assert.equal(index.get(key("reviewed"))?.published?.total, 42);
sample();
global.gc();
let rows = 0;
for (const row of index.values()) rows++;
console.log(JSON.stringify({ stage, shape, rows, disk: fs.statSync(file).size, peak, retained: oldSpace() - base, budget: INDEX_BYTE_BUDGET, overhead: INDEX_ENTRY_OVERHEAD }));
`;
	const errors = [];
	for (const shape of ["mixed", "korean", "dense", "models"]) {
		const home = path.join(dir, shape);
		fs.mkdirSync(home);
		let rows;
		for (const stage of ["write", "daemon", "audit"]) {
			const result = spawnSync(process.execPath, ["--max-old-space-size=66", "--expose-gc", "--input-type=module", "--eval", program, stage, shape, home], { encoding: "utf8" });
			if (result.status !== 0) {
				errors.push(`${shape} ${stage}, exit ${result.status}:\n${result.stderr}\n${result.error ?? ""}`);
				if (stage === "write") break;
				continue;
			}
			t.diagnostic(result.stdout.trim());
			const measurement = JSON.parse(result.stdout);
			assert.ok(measurement.rows > 1);
			if (stage === "write") rows = measurement.rows;
			else assert.equal(measurement.rows, rows, `${shape} ${stage} must retain every saved row`);
		}
	}
	assert.deepEqual(errors, []);
});

test("(gate 17) corrupt lines do not hide the next intact publication in a saturated index", (t) => {
	const { dir, fileOf, indexOf, clock } = setup(t);
	const index = indexOf();
	const transcript = fileOf();
	writeText(transcript, `${line()}\n`);
	index.update(sub("oldest"), transcript);
	clock.advance(1);
	for (let i = 0; !index.full; i++) index.markMissing(sub(`missing-${i}`));
	index.save();
	const clean = fs.readFileSync(path.join(dir, "usage.json"));
	const last = clean.lastIndexOf(10, clean.length - 2) + 1;
	const damaged = fileOf("damaged.jsonl");
	const junk = Buffer.alloc(64 * 1024, "!");
	assert.equal(compactUsage(readUsageIndex(path.join(dir, "usage.json")).get(key("oldest")))?.total, 10);
	const results = [];
	for (const size of [1, 8192, junk.length + 9, Math.ceil(INDEX_BYTE_BUDGET * 1.5) + junk.length]) {
		const fd = fs.openSync(damaged, "w");
		try {
			fs.writeSync(fd, clean.subarray(0, last));
			for (let left = size; left > 0; left -= junk.length) fs.writeSync(fd, junk.subarray(0, left));
			fs.writeSync(fd, "\n");
			fs.writeSync(fd, clean.subarray(last));
		} finally {
			fs.closeSync(fd);
		}
		results.push([size, compactUsage(readUsageIndex(damaged).get(key("oldest")))?.total]);
	}
	assert.deepEqual(results, results.map(([size]) => [size, 10]));
});

test("(gate 18) an identifiable invalid line cannot displace an intact 42-token publication", (t) => {
	const { fileOf, indexOf, clock } = setup(t);
	const index = indexOf();
	const transcript = fileOf();
	writeText(transcript, '{"type":"usage","provider":"p","model":"id","usage":{"input":42}}\n');
	index.update(sub("oldest"), transcript);
	clock.advance(1);
	for (let i = 0; !index.full; i++) index.markMissing(sub(`m${i}`));
	assert.ok(index.save());
	const clean = fs.readFileSync(fileOf("usage.json"));
	const last = clean.lastIndexOf(10, clean.length - 2) + 1;
	const bad = Buffer.from('{"id":"identifiable-invalid","checkedMs":"not a number"}\n');
	assert.equal(bad.length, 57);
	assert.equal(compactUsage(readUsageIndex(fileOf("usage.json")).get(key("oldest")))?.total, 42);
	const damaged = fileOf("damaged.jsonl");
	writeText(damaged, Buffer.concat([clean.subarray(0, last), bad, clean.subarray(last)]));
	const loaded = indexOf("damaged.jsonl");
	assert.equal(compactUsage(loaded.get(key("oldest")))?.total, 42);
	assert.equal(compactUsage(readUsageIndex(damaged).get(key("oldest")))?.total, 42);
	const recount = loaded.get(key("identifiable-invalid"));
	assert.equal(recount?.state, "ok");
	assert.equal(recount.complete, false);
	assert.equal(recount.offset, 0);
});

test("(gate 18) retention and audit preparation with a saturated index and the long-path ledger fit in 66 MiB", async (t) => {
	const { dir } = setup(t);
	const program = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createUsageIndex } from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
import { createUsageTracker } from ${JSON.stringify(new URL("../src/usage-tracker.mjs", import.meta.url).href)};
import { resolvePaths } from ${JSON.stringify(new URL("../src/paths.mjs", import.meta.url).href)};
import * as ledger from ${JSON.stringify(new URL("../src/session-ledger.mjs", import.meta.url).href)};
import { createAuditor, requestAudit, readAuditState } from ${JSON.stringify(new URL("../src/auditor.mjs", import.meta.url).href)};
import { DEFAULT_CONFIG } from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)};
import { loadSessionRecord } from ${JSON.stringify(new URL("../src/session-record.mjs", import.meta.url).href)};
const [stage, dir] = process.argv.slice(1);
const paths = resolvePaths({ USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health"), OMO_HEALTH_OMO_HOME: path.join(dir, ".omo") });
const now = ${T0};
const clock = { now: () => now };
const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
const cwd = "C:/작업/" + ("a".repeat(194) + "/").repeat(100).slice(0, -1);
const id = (i) => "01aaa000-0000-7000-8000-" + String(i).padStart(12, "0");
const put = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
};
if (stage === "fixture") {
	const transcript = path.join(dir, "seed.jsonl");
	put(transcript, '{"type":"usage","provider":"p","model":"id","usage":{"input":42}}\\n');
	index.update(sub("seed"), transcript, { kind: "main" });
	for (let i = 0; !index.full; i++) index.markMissing({ ...sub(id(i)), projectKey: projectKeyOf(cwd) }, { kind: "main", file: cwd + "/" + id(i) });
	assert.ok(index.save());
	const day = new Date(now).toISOString().slice(0, 10);
	const name = "ended-" + day + ".jsonl";
	ledger.appendEnded(paths, { sessionId: "seed", kind: "main", startedMs: now - 120000, endedMs: now - 1000 });
	const file = path.join(paths.health.sessionsDir, name);
	for (let i = 0; i < 1030; i++) fs.appendFileSync(file, JSON.stringify({
		v: 1, sessionId: id(i), kind: "main", cwd, startedMs: now - 20000, endedMs: now - 2000, outcome: "completed",
	}) + "\\n");
	ledger.appendEnded(paths, { sessionId: "child", taskId: "st_child", parentSessionId: "seed", kind: "child", endedMs: now - 2000 });
	ledger.appendEnded(paths, { sessionId: "grand", taskId: "st_grand", parentSessionId: "st_child", kind: "child", endedMs: now - 3000 });
	put(path.join(paths.health.decisionsDir, day + ".jsonl"), [
		{ fp: "grand-finding", event: "opened", subject: { sessionId: "grand" } },
		{ fp: "machine-finding", event: "opened", subject: {} },
	].map((row) => JSON.stringify({ ts: new Date(now - 10000).toISOString(), ...row })).join("\\n") + "\\n");
	put(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["other/reviewer"] } } } }));
	put(paths.authFile, JSON.stringify({ other: {} }));
} else {
	assert.ok(index.full);
	assert.equal(index.get(key("seed")).published.total, 42);
	if (stage === "retention") {
		assert.equal(index.prune(now), 0);
		const tracker = createUsageTracker({ paths, index, clock });
		// Queue positioned rows, like the daemon's daily retention path.
		const read = ledger.streamEnded ?? ledger.readEnded;
		const missing = 1030 - (index.entries().length - 1);
		assert.equal(tracker.queueLedger(read(paths, { sinceMs: now - 30 * ${DAY}, withLocation: true })), Math.max(0, missing) + 2);
	} else {
		const record = loadSessionRecord({ paths, id: "seed", now, index, messageScanMaxBytes: 0 });
		assert.deepEqual(record.children.map(({ sessionId, depth }) => [sessionId, depth]), [["child", 1], ["grand", 2]]);
		assert.deepEqual(record.health.findings.map(({ fp, scope }) => [fp, scope]), [["grand-finding", "session"], ["machine-finding", "machine"]]);
		requestAudit(paths, sub("seed"), now);
		let starts = 0;
		const auditor = createAuditor({ paths, index, config: DEFAULT_CONFIG, clock, env: {}, timelineMaxBytes: 0, runner: {
			start() { starts++; return { pid: 1 }; },
		} });
		auditor.tick(now + 1);
		await auditor.preparing();
		auditor.tick(now + 1);
		assert.equal(starts, 1);
		assert.equal(readAuditState(paths, sub("seed")).status, "running");
	}
}
`;
	const run = (stage) => {
		const result = spawnSync(process.execPath, ["--max-old-space-size=66", "--max-semi-space-size=1", "--input-type=module", "--eval", program, stage, dir], { encoding: "utf8", timeout: 60_000 });
		assert.equal(result.status, 0, `${stage} exit ${result.status}, ${result.signal ?? ""}:\n${result.stderr}\n${result.error ?? ""}`);
	};
	run("fixture");
	await t.test("daily retention queues only the rows that need reads", () => run("retention"));
	await t.test("audit starts and the record joins grandchildren and machine findings", () => run("audit"));
});

const longPathProgram = `
import assert from "node:assert/strict";
import fs from "node:fs";
import * as usage from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
import { subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (sessionId) => subjectKey(sub(sessionId));
const [mode, file] = process.argv.slice(1);
const N = 16000;
const id = (i) => "01aaa000-0000-7000-8000-" + String(i).padStart(12, "0");
const prefix = "C:/" + ("작".repeat(195) + "/").repeat(18);
const pathOf = (i) => prefix + "업".repeat(7) + id(i);
assert.equal(pathOf(0).length, 3574);
let now = N;
const open = () => mode === "dashboard" ? usage.readUsageIndex(file) : usage.createUsageIndex({ file, clock: { now: () => now } });
if (mode === "fixture") {
	const index = open();
	const row = index.markMissing(sub(id(0)), { file: pathOf(0), kind: "main" });
	const fd = fs.openSync(file, "w");
	try {
		fs.writeSync(fd, JSON.stringify({ v: usage.USAGE_INDEX_VERSION }) + "\\n");
		for (let i = 0; i < N; ++i) fs.writeSync(fd, JSON.stringify({ ...row, id: id(i), file: pathOf(i), checkedMs: N - i }) + "\\n");
	} finally { fs.closeSync(fd); }
} else {
	const index = open();
	if (mode === "write") {
		for (let n = 0; n < N; ++n) {
			const i = n < 2 ? 1 - n : n; // The first two are deliberately out of checked-time order.
			now = N - i;
			index.markMissing(sub(id(i)), { file: pathOf(i), kind: "main" });
		}
		assert.equal(index.save(), true);
	} else {
		const rows = [...index.values()];
		const bytes = (row) => JSON.stringify(row).length + 18 * 195 + 7 + usage.INDEX_ENTRY_OVERHEAD;
		assert.ok(rows.length > 0 && rows.length < N);
		const total = rows.reduce((sum, row) => sum + bytes(row), 0);
		assert.ok(total <= usage.INDEX_BYTE_BUDGET && total + bytes(rows.at(-1)) - 1 > usage.INDEX_BYTE_BUDGET);
		assert.deepEqual(rows.map((row) => row.id), Array.from({ length: rows.length }, (_, i) => id(i)));
		assert.equal(index.full, true);
		if (mode === "read") assert.equal(index.get(key(id(N - 1)))?.state, "full");
	}
}
`;

function runLongPath(mode, file) {
	const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "--eval", longPathProgram, mode, file], { encoding: "utf8" });
	assert.equal(result.status, 0, `${mode}:\n${result.stderr}\n${result.error ?? ""}`);
}

test("(gate 16) 16000 long Korean paths save within 96 MiB, preserving the newest rows in order", (t) => {
	const { fileOf } = setup(t);
	const file = fileOf("usage.json");
	runLongPath("write", file);
	runLongPath("read", file);
});

test("(gate 16) fresh 96 MiB reader stops at the byte budget in an oversized valid file", (t) => {
	const { fileOf } = setup(t);
	const file = fileOf("usage.json");
	runLongPath("fixture", file);
	runLongPath("read", file);
	runLongPath("dashboard", file);
});

test("12000 one-model sessions saturate the 16 MiB budget and every admitted row saves and resaves at 96 MiB", (t) => {
	const { dir, fileOf } = setup(t);
	const file = fileOf("usage.json");
	const program = `
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createUsageIndex, INDEX_BYTE_BUDGET } from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
const [mode, file, root] = process.argv.slice(1);
const index = createUsageIndex({ file, clock: { now: () => 1 } });
if (mode === "write") {
	const project = path.join(root, "작업");
	fs.mkdirSync(project);
	for (let i = 0; i < 12000; i++) {
		const id = "01aaa000-0000-7000-8000-" + String(i).padStart(12, "0");
		const transcript = path.join(project, "2026-11-22_" + id + ".jsonl");
		fs.writeFileSync(transcript, '{"type":"usage","model":"m","provider":"p","usage":{"input":1,"cost":{"total":0.25}}}\\n');
		index.update(sub(id), transcript, { kind: "main" });
	}
}
const rows = index.entries();
assert.equal(INDEX_BYTE_BUDGET, 16 * 1024 * 1024);
assert.equal(index.full, true);
assert.ok(rows.length >= 4000 && rows.length < 12000);
assert.deepEqual(index.get(key("01aaa000-0000-7000-8000-000000011999")), { state: "full" });
const hash = crypto.createHash("sha256");
for (const row of rows) {
	assert.equal(row.published.total, 1);
	assert.equal(row.published.cost, 0.25);
	hash.update(JSON.stringify([row.id, row.published]));
}
if (mode === "reload") index.update(sub(rows[0].id), rows[0].file, { kind: "main" });
console.error(mode, "before save", rows.length, "rows", process.memoryUsage().heapUsed, "heap bytes");
assert.equal(index.save(), true);
console.error(mode, "after save", fs.statSync(file).size, "file bytes", process.memoryUsage().heapUsed, "heap bytes", process.resourceUsage().maxRSS, "KiB peak RSS");
console.log(hash.digest("hex"));
`;
	const digests = [];
	for (const mode of ["write", "reload"]) {
		const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "--eval", program, mode, file, dir], { encoding: "utf8" });
		assert.equal(result.status, 0, `${mode}:\n${result.stderr}\n${result.error ?? ""}`);
		t.diagnostic(result.stderr.trim());
		digests.push(result.stdout.trim());
	}
	assert.equal(digests[0], digests[1], "every published tree survived the round trip");
});

test("(gate 14) 138 sessions with 1000 overflowing models save and reload in capped children", (t) => {
	const { fileOf } = setup(t);
	const file = fileOf("usage.json");
	const transcript = fileOf("session.jsonl");
	writeText(transcript, Array.from({ length: 1000 }, (_, i) =>
		JSON.stringify({ type: "usage", provider: "p", model: `m${i}`, usage: use({ input: 1e308, output: 1e308, cost: 0.25 }) }),
	).join("\n") + "\n");
	const program = `
import assert from "node:assert/strict";
import { createUsageIndex, readUsageIndex } from ${JSON.stringify(new URL("../src/usage-index.mjs", import.meta.url).href)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
const [mode, file, transcript] = process.argv.slice(1);
const clock = { now: () => 1 };
if (mode === "write") {
	const index = createUsageIndex({ file, clock });
	for (let i = 0; i < 138; i++) index.update(sub("s" + i), transcript);
	assert.equal(index.save(), true);
} else {
	const rows = mode === "dashboard" ? [...readUsageIndex(file).values()] : createUsageIndex({ file, clock }).entries();
	assert.equal(rows.length, 138);
	assert.equal(rows.at(-1).published.total, Infinity);
	assert.equal(rows.at(-1).published.cost, 250);
	assert.equal(rows.at(-1).published.models["(other models)"].tokens, Infinity);
	assert.equal(rows.at(-1).published.modelsIncomplete, true);
}
`;
	for (const mode of ["write", "dashboard", "daemon"]) {
		const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "--eval", program, mode, file, transcript], { encoding: "utf8" });
		assert.equal(result.status, 0, `${mode}:\n${result.stderr}`);
	}
});

test("(gate 14) exact budget, spill, and a previously oversized persisted row", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const saved = fileOf("usage.json");
	const records = Array.from({ length: 512 }, (_, i) => JSON.stringify(assistant({ model: `m${i}` }))).join("\n") + "\n";
	writeText(file, records);
	const index = indexOf();
	for (let i = 0; i < 3; i++) index.update(sub(`s${i}`), file);
	const beforeSave = index.get(key("s2")).published;
	assert.deepEqual(beforeSave.models, {
		"(other models)": { input: 512, output: 1024, cacheRead: 1536, cacheWrite: 2048, tokens: 5120, cost: beforeSave.cost },
	});
	assert.equal(beforeSave.modelsIncomplete, true);
	index.save();
	const data = parseIndex(fs.readFileSync(saved, "utf8"));
	const rows = Object.values(data.entries);
	const slots = rows.flatMap((row) => [row.usage, row.overlay, row.published]).flatMap((tree) =>
		[...Object.keys(tree.models), ...Object.keys(tree.usedModels)]).filter((key) => !key.startsWith("("));
	assert.equal(slots.length, 4096);
	assert.equal(readUsageIndex(saved).get(key("s1")).published.modelsIncomplete, false);
	assert.equal(readUsageIndex(saved).get(key("s2")).published.total, 5120);
	data.entries.s2 = { ...data.entries.s0, id: "s2" };
	writeText(saved, indexText(data));
	const loaded = readUsageIndex(saved);
	assert.equal(compactUsage(loaded.get(key("s1"))).total, 5120);
	assert.equal(compactUsage(loaded.get(key("s2"))), null);
	const reopened = indexOf();
	assert.equal(reopened.update(sub("s2"), file), fs.statSync(file).size);
	assert.equal(reopened.get(key("s2")).published.modelsIncomplete, true);
	const tail = `${line()}\n`;
	fs.appendFileSync(file, tail);
	assert.equal(reopened.update(sub("s2"), file), Buffer.byteLength(tail));
	assert.equal(reopened.get(key("s2")).published.total, 5130);
});

test("(gate 14) regrouped model cost need not reconcile in floating point", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, [
		assistant({ model: "m1", usage: use({ cost: 1e308 }) }),
		assistant({ model: "m2", usage: use({ cost: 1 }) }),
		assistant({ model: "m1", usage: use({ cost: -1e308 }) }),
	].map((item) => JSON.stringify(item)).join("\n") + "\n");
	const index = indexOf();
	index.update(sub("s"), file);
	index.save();
	const entry = indexOf().get(key("s"));
	assert.equal(compactUsage(entry).cost, 0);
	assert.equal(Object.values(entry.published.models).reduce((sum, model) => sum + model.cost, 0), 1);
	assert.equal(fresh(entry), true);
});

test("scoped maps distinguish long common-prefix projects and preserve insertion order", () => {
	const projects = ["A", "B"].map((suffix) => `--작업-${"common-".repeat(500)}${suffix}--`);
	const first = { projectKey: projects[0], sessionId: "review.1" };
	const second = { projectKey: projects[1], sessionId: "review.1" };
	const third = { projectKey: projects[0], sessionId: "review.2" };
	const map = new SubjectMap({ ordered: true, packed: true });
	map.set(first, "first").set(second, "second").set(third, "third");
	assert.deepEqual([...map], [[subjectKey(first), "first"], [subjectKey(second), "second"], [subjectKey(third), "third"]]);
	assert.equal(map.delete(subjectKey(second)), true);
	assert.equal(map.get(subjectKey(first)), "first");
	assert.equal(map.has(second), false);
});

test("save and load round-trip the entries without the in-memory fields", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const first = fileOf("a.jsonl");
	const second = fileOf("b.jsonl");
	writeText(first, `${line()}\n`);
	writeText(second, `${line()}\n${line()}`);
	assert.equal(index.update(sub("s1"), first, { kind: "main", rootSessionId: "s1" }, { maxBytes: 1 * MiB }), fs.statSync(first).size);
	assert.equal(index.update(sub("s2"), second, { kind: "child", taskId: "st_2", parentSessionId: "s1" }), fs.statSync(second).size);
	assert.equal(index.save(), true);
	assert.equal(index.save(), false);
	const raw = parseIndex(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
	assert.equal(raw.v, USAGE_INDEX_VERSION);
	for (const entry of Object.values(raw.entries)) {
		assert.equal("scanOffset" in entry, false);
		assert.equal("partial" in entry, false);
		assert.equal("readError" in entry, false);
	}
	const loaded = readUsageIndex(path.join(dir, "usage.json"));
	assert.equal(loaded instanceof SubjectMap, true);
	assert.equal(loaded.size, 2);
	assert.equal(compactUsage(loaded.get(key("s1"))).total, 10);
	assert.equal(compactUsage(loaded.get(key("s2"))).total, 20);
	assert.equal(loaded.get(key("s2")).taskId, "st_2");
	assert.equal(loaded.get(key("s2")).parentSessionId, "s1");
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
			index.update(sub("s"), file);
			index.save();
			const saved = fs.readFileSync(savedFile, "utf8");
			const corrupt = saved.replace(new RegExp(`("${field}"\\s*:\\s*)[^,\\s}]+`), (_, key) => key + value);
			assert.notEqual(corrupt, saved);
			writeText(savedFile, corrupt);
			const reloaded = indexOf(indexName);
			const wasFresh = fresh(reloaded.get(key("s")));
			fs.appendFileSync(file, second);
			assert.equal(reloaded.update(sub("s"), file), Buffer.byteLength(original + second), value);
			assert.equal(compactUsage(reloaded.get(key("s"))).total, 20);
			assert.equal(reloaded.save(), true);
			assert.equal(compactUsage(indexOf(indexName).get(key("s"))).total, 20);
			assert.equal(wasFresh, false, value);
		}
		assert.deepEqual(logged, []);
	});
}

test("a different index version or a corrupt file reads as empty", (t) => {
	const { dir } = setup(t);
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(file, JSON.stringify({ v: USAGE_INDEX_VERSION + 1, entries: { s1: { id: "s1" } } }));
	assert.equal(readUsageIndex(file).size, 0);
	fs.writeFileSync(file, "{not json");
	assert.equal(readUsageIndex(file).size, 0);
	assert.equal(readUsageIndex(path.join(dir, "absent.json")).size, 0);
});

test("constructing an index over a corrupt, different-version or absent file starts empty", (t) => {
	const { dir, clock, log } = setup(t);
	const file = path.join(dir, "usage.json");
	for (const text of [JSON.stringify({ v: USAGE_INDEX_VERSION + 1, entries: { s1: { id: "s1", state: "ok", complete: true } } }), "{not json", ""]) {
		fs.writeFileSync(file, text);
		const index = createUsageIndex({ file, clock, log });
		assert.deepEqual(index.entries(), []);
		assert.equal(index.has(key("s1")), false);
		assert.equal(index.save(), false, "nothing was loaded, so nothing is written");
	}
	fs.rmSync(file);
	assert.deepEqual(createUsageIndex({ file, clock, log }).entries(), []);

	const session = path.join(dir, "cursor.jsonl");
	writeText(session, "{}\n".repeat(4));
	const writer = createUsageIndex({ file, clock, log });
	writer.update(sub("s1"), session);
	writer.save();
	const saved = parseIndex(fs.readFileSync(file, "utf8"));
	Object.assign(saved.entries.s1, { scanOffset: 5, partial: { start: 0 }, readError: true });
	writeText(file, indexText(saved));
	const loaded = createUsageIndex({ file, clock, log });
	assert.equal(loaded.get(key("s1")).state, "ok");
	assert.equal(loaded.get(key("s1")).offset, 12);
	assert.equal("scanOffset" in loaded.get(key("s1")), false, "scanOffset is memory-only");
	assert.equal("partial" in loaded.get(key("s1")), false, "partial is memory-only");
	assert.equal("readError" in loaded.get(key("s1")), false, "readError is memory-only");
});

test("an index over the same file resumes an appended entry at its saved offset", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const first = indexOf();
	assert.equal(first.update(sub("s1"), file), fs.statSync(file).size);
	assert.equal(compactUsage(first.get(key("s1"))).total, 10);

	const appended = `${line()}\n${line()}\n`;
	const lineBytes = Buffer.byteLength(`${line()}\n`);
	fs.appendFileSync(file, appended);
	assert.equal(first.update(sub("s1"), file, {}, { maxBytes: lineBytes }), lineBytes, "the first instance read one of the two appended records");
	assert.equal(first.save(), true);
	const savedOffset = readUsageIndex(path.join(dir, "usage.json")).get(key("s1")).offset;
	assert.equal(savedOffset, fs.statSync(file).size - lineBytes);

	const restarted = indexOf();
	assert.equal(restarted.get(key("s1")).offset, savedOffset, "the new instance loaded the persisted cursor");
	const bytesRead = restarted.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(bytesRead, lineBytes, "only the bytes not yet read are read");
	assert.equal(compactUsage(restarted.get(key("s1"))).total, 30);
	assert.equal(restarted.fresh(restarted.get(key("s1"))), true);

	const oracle = indexOf("oracle.json");
	oracle.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(compactUsage(oracle.get(key("s1"))).total, 30, "the resumed total equals a one-shot read");
});

test("(IS-1) index save, reload and append preserve fractional per-model tokens", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const fractional = (input, output) => JSON.stringify(assistant({
		usage: use({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0.125 }),
	}));
	// Keep an EOF overlay too, so all three saved trees contain this model.
	const first = fractional(0.1, 0.2);
	const second = fractional(0, 0);
	writeText(file, `${first}\n${second}`);
	const index = indexOf();
	index.update(sub("s"), file);
	assert.equal(index.save(), true);

	const reloaded = indexOf();
	const modelKey = "anthropic-subscription/claude-opus-5-5";
	assert.equal(reloaded.get(key("s")).offset, Buffer.byteLength(`${first}\n`));
	const appended = `\n${fractional(0, 0.3)}\n`;
	fs.appendFileSync(file, appended);
	assert.equal(reloaded.update(sub("s"), file), Buffer.byteLength(second + appended));
	const resumed = reloaded.get(key("s")).published.models[modelKey];
	const once = readUsage(file).effective.models[modelKey];
	assert.equal(once.tokens, 0.1 + (0 + 0.2 + 0.3) + 0 + 0, "senpi sums by counter before summing the key");
	assert.equal(resumed.tokens, once.tokens);
	assert.deepEqual(resumed, { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0, tokens: 0.6, cost: 0.375 });

	const saved = parseIndex(fs.readFileSync(fileOf("usage.json"), "utf8")).entries.s;
	for (const [tree, input, output] of [["usage", 0.1, 0.2], ["overlay", 0, 0], ["published", 0.1, 0.2]]) {
		assert.deepEqual(saved[tree].models[modelKey], {
			input, output, cacheRead: 0, cacheWrite: 0, tokens: input + output,
			cost: tree === "published" ? 0.25 : 0.125,
		}, tree);
	}
});

test("(IS-1) a v3 row without model counters starts empty and is recounted", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const savedFile = fileOf("usage.json");
	writeText(file, `${line()}\n`);
	const writer = indexOf();
	writer.update(sub("s"), file);
	assert.equal(writer.save(), true);
	const old = parseIndex(fs.readFileSync(savedFile, "utf8"));
	old.v = 3;
	for (const name of ["usage", "overlay", "published"]) {
		for (const model of Object.values(old.entries.s[name].models)) {
			for (const field of ["input", "output", "cacheRead", "cacheWrite"]) delete model[field];
		}
	}
	writeText(savedFile, indexText(old));
	assert.equal(readUsageIndex(savedFile).has(key("s")), false, "the dashboard must not publish a v3 total");
	const restarted = indexOf();
	assert.equal(restarted.has(key("s")), false, "there is no trusted v3 cursor");
	assert.equal(restarted.update(sub("s"), file), fs.statSync(file).size);
	assert.equal(restarted.get(key("s")).complete, true);
	assert.deepEqual(restarted.get(key("s")).published.models, readUsage(file).effective.models);
	assert.equal(restarted.save(), true);
	assert.equal(readUsageIndex(savedFile).get(key("s")).complete, true);
});

test("a resumable append reads only the appended bytes", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(compactUsage(index.get(key("s1"))).total, 10);
	const appended = `${line()}\n${line()}\n`;
	fs.appendFileSync(file, appended);
	assert.equal(index.fresh(index.get(key("s1"))), false);
	const bytesRead = index.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(bytesRead, Buffer.byteLength(appended));
	assert.equal(compactUsage(index.get(key("s1"))).total, 30);
	assert.equal(index.fresh(index.get(key("s1"))), true);
});

test("a file replaced with the same size and mtime is not fresh and is recounted", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const text = `${line()}\n`;
	writeText(file, text);
	fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(index.fresh(index.get(key("s1"))), true);
	const replacement = `${file}.new`;
	writeText(replacement, text);
	fs.utimesSync(replacement, 1_700_000_000, 1_700_000_000);
	fs.renameSync(replacement, file);
	const stat = fs.statSync(file);
	assert.equal(stat.size, index.get(key("s1")).size);
	assert.equal(stat.mtimeMs, index.get(key("s1")).mtimeMs);
	assert.equal(index.fresh(index.get(key("s1"))), false, "a new file identity is a replacement");
	assert.equal(index.update(sub("s1"), file), Buffer.byteLength(text), "the replacement is read from the start");
	assert.equal(compactUsage(index.get(key("s1"))).total, 10);
	assert.equal(index.fresh(index.get(key("s1"))), true);
});

test("inode changes above 2^53 invalidate freshness and restart the reader", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const indexFile = fileOf("usage.json");
	const text = `${line()}\n`;
	writeText(file, text);
	const first = 2n ** 60n + 1n;
	const second = first + 1n;
	assert.equal(Number(first), Number(second), "numeric stat cannot distinguish these IDs");
	let ino = first;
	const { statSync, fstatSync } = fs;
	const realIno = statSync(file, { bigint: true }).ino;
	t.mock.method(fs, "statSync", (path, options) => {
		const stat = statSync(path, options);
		if (path === file) stat.ino = options?.bigint ? ino : Number(ino);
		return stat;
	});
	t.mock.method(fs, "fstatSync", (fd, options) => {
		const stat = fstatSync(fd, options);
		if (stat.ino === (options?.bigint ? realIno : Number(realIno))) stat.ino = options?.bigint ? ino : Number(ino);
		return stat;
	});
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(index.fresh(index.get(key("s1"))), true);
	index.save();

	const reopened = indexOf();
	const entry = reopened.get(key("s1"));
	assert.equal(reopened.fresh(entry), true, "an exact ID survives reload");
	ino = second; // Keep size and both timestamps unchanged.
	const wasFresh = reopened.fresh(entry);
	const scanned = reopened.update(sub("s1"), file);
	assert.deepEqual([wasFresh, scanned], [false, Buffer.byteLength(text)]);
	assert.equal(parseIndex(fs.readFileSync(indexFile, "utf8")).entries.s1.ino, first.toString());
	assert.equal(reopened.get(key("s1")).ino, second.toString());
	assert.equal(reopened.fresh(reopened.get(key("s1"))), true);
});

test("a persisted inode must be an exact decimal string or be recounted once", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const indexFile = fileOf("usage.json");
	const text = `${line()}\n`;
	writeText(file, text);
	const index = indexOf();
	index.update(sub("s1"), file);
	index.save();
	const original = fs.readFileSync(indexFile, "utf8");
	const exact = fs.statSync(file, { bigint: true }).ino.toString();
	for (const invalid of [Number(exact), `+${exact}`, `${exact}.0`]) {
		const data = parseIndex(original);
		data.entries.s1.ino = invalid;
		writeText(indexFile, indexText(data));
		const reopened = indexOf();
		const entry = reopened.get(key("s1"));
		assert.equal(reopened.fresh(entry), false);
		assert.equal(compactUsage(entry), null);
		assert.equal(reopened.update(sub("s1"), file), Buffer.byteLength(text));
		assert.equal(reopened.save(), true);
		const repaired = indexOf();
		assert.equal(repaired.get(key("s1")).ino, exact);
		assert.equal(repaired.fresh(repaired.get(key("s1"))), true);
		assert.equal(repaired.update(sub("s1"), file), 0);
	}
});

test("a valid final record without a newline is published and stays published through reload and its newline", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const fragment = JSON.stringify(assistant({ usage: use({ cacheWrite: 1 }) }));
	writeText(file, `${line()}\n${fragment}`);
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(compactUsage(index.get(key("s1"))).total, 17);
	assert.equal(index.save(), true);
	assert.equal(compactUsage(readUsageIndex(fileOf("usage.json")).get(key("s1"))).total, 17, "dashboard reload");
	const restarted = indexOf();
	assert.equal(compactUsage(restarted.get(key("s1"))).total, 17, "daemon restart");
	fs.appendFileSync(file, "\n");
	restarted.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(compactUsage(restarted.get(key("s1"))).total, 17, "the fragment is counted once, now as a committed record");
});

test("(gate 10) finite records that overflow survive a reload and a resumable append", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const overflowing = JSON.stringify(assistant({ usage: use({ input: 1e308, output: 1e308, cost: 1e308 }) }));
	writeText(file, `${overflowing}\n${overflowing}\n${overflowing}`);
	const index = indexOf();
	index.update(sub("s1"), file);
	const { usage, overlay, published } = index.get(key("s1"));
	assert.equal(usage.cost, Infinity);
	assert.equal(overlay.total, Infinity, "the unterminated record has its own overflow");
	assert.equal(published.models["anthropic-subscription/claude-opus-5-5"].tokens, Infinity);
	const before = compactUsage(index.get(key("s1")));
	assert.equal(before.total, Infinity);
	assert.equal(index.save(), true);
	assert.deepEqual(compactUsage(readUsageIndex(fileOf("usage.json")).get(key("s1"))), before, "dashboard reload");

	const reloaded = indexOf();
	assert.equal(reloaded.fresh(reloaded.get(key("s1"))), true);
	assert.deepEqual(reloaded.get(key("s1")).usage, usage);
	assert.deepEqual(reloaded.get(key("s1")).overlay, overlay);
	assert.deepEqual(reloaded.get(key("s1")).published, published);
	const append = `\n${line()}\n`;
	fs.appendFileSync(file, append);
	assert.equal(reloaded.update(sub("s1"), file), Buffer.byteLength(overflowing + append), "re-read only the previous EOF fragment and new bytes");
	assert.deepEqual(reloaded.get(key("s1")).published, readUsage(file).effective);
	assert.equal(compactUsage(reloaded.get(key("s1"))).total, Infinity);
});

const tagNumber = (value) => (Number.isFinite(value) ? value : { $n: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity" });

for (const [expected, taggedCounters, appendUsage] of [[-Infinity, { input: -Infinity }, use()], [NaN, { input: -Infinity, output: Infinity }, use({ input: 1e308, output: 1e308 })]]) {
	test(`(gate 10) ${expected} from a tagged index survives save, reload and append`, (t) => {
		const { fileOf, indexOf } = setup(t);
		const file = fileOf();
		const savedFile = fileOf("usage.json");
		writeText(file, `${line()}\n`);
		const index = indexOf();
		index.update(sub("s1"), file);
		index.save();
		const tagged = parseIndex(fs.readFileSync(savedFile, "utf8"));
		// A total is now recomputed from the four counters, so tag the counters that produce it.
		for (const name of ["usage", "published"]) {
			for (const [key, value] of Object.entries(taggedCounters)) tagged.entries.s1[name][key] = tagNumber(value);
			tagged.entries.s1[name].total = tagNumber(expected);
		}
		writeText(savedFile, indexText(tagged));
		const migrated = indexOf();
		assert.equal(migrated.get(key("s1")).usage.total, expected);
		const appended = `${JSON.stringify(assistant({ usage: appendUsage }))}\n`;
		fs.appendFileSync(file, appended);
		assert.equal(migrated.update(sub("s1"), file), Buffer.byteLength(appended), "resume the tagged cursor");
		assert.equal(compactUsage(migrated.get(key("s1"))).total, expected);
		assert.equal(migrated.save(), true);

		const reloaded = indexOf();
		assert.deepEqual(compactUsage(reloaded.get(key("s1"))), compactUsage(migrated.get(key("s1"))));
		const last = `${line()}\n`;
		fs.appendFileSync(file, last);
		assert.equal(reloaded.update(sub("s1"), file), Buffer.byteLength(last));
		assert.equal(compactUsage(reloaded.get(key("s1"))).total, expected);
	});
}

test("(gate 11) a 105,000-model entry saves and reloads under a 96 MiB heap", (t) => {
	const { dir } = setup(t);
	const script = path.join(dir, "heap-save.mjs");
	const indexUrl = new URL("../src/usage-index.mjs", import.meta.url).href;
	const child = [
		'import fs from "node:fs";',
		`import { createUsageIndex, readUsageIndex } from ${JSON.stringify(indexUrl)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};`,
		"const dir = process.argv[2];",
		'const session = dir + "/session.jsonl";',
		'const indexFile = dir + "/usage.json";',
		'const fd = fs.openSync(session, "w");',
		"for (let i = 0; i < 105000; i += 1000) {",
		'\tlet chunk = "";',
		'\tfor (let j = i; j < Math.min(i + 1000, 105000); j += 1) chunk += JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "model-" + j, usage: { input: 1 } } }) + "\\n";',
		"\tfs.writeSync(fd, chunk);",
		"}",
		"fs.closeSync(fd);",
		"const index = createUsageIndex({ file: indexFile, clock: Date });",
		'index.update(sub("s1"), session);',
		'const total = index.get(key("s1")).published.total;',
		'if (total !== 105000) throw new Error("read total " + total);',
		"index.save();",
		'const reloaded = readUsageIndex(indexFile).get(key("s1"));',
		"const models = Object.keys(reloaded.published.models).length;",
		'console.log("ok " + total + " " + models);',
	];
	fs.writeFileSync(script, `${child.join("\n")}\n`);
	const result = spawnSync(process.execPath, ["--max-old-space-size=96", script, dir], { encoding: "utf8", timeout: 180_000 });
	assert.equal(result.status, 0, `child exit ${result.status}: ${result.stderr}`);
	assert.match(result.stdout, /^ok 105000 (?:[1-9]\d{0,2}|1000)$/m);
	const reloaded = readUsageIndex(path.join(dir, "usage.json")).get(key("s1"));
	assert.equal(reloaded.published.total, 105000);
	assert.equal(reloaded.usage.total, 105000);
	assert.ok(Object.keys(reloaded.published.models).length <= 1000);
	assert.equal(reloaded.published.models["(other models)"].tokens, 105000 - (Object.keys(reloaded.published.models).length - 1));
	assert.equal(reloaded.published.modelsIncomplete, true);
});

test("(gate 12) a 105,000-model entry with one overflow record loads and saves under a 96 MiB heap", (t) => {
	const { dir } = setup(t);
	const script = path.join(dir, "heap-reload.mjs");
	const indexUrl = new URL("../src/usage-index.mjs", import.meta.url).href;
	const child = [
		'import fs from "node:fs";',
		`import { createUsageIndex } from ${JSON.stringify(indexUrl)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};`,
		"const dir = process.argv[2];",
		'const session = dir + "/session.jsonl";',
		'const indexFile = dir + "/usage.json";',
		"if (!fs.existsSync(indexFile)) {",
		'\tconst fd = fs.openSync(session, "w");',
		"\tfor (let i = 0; i < 105000; i += 1000) {",
		'\t\tlet chunk = "";',
		'\t\tfor (let j = i; j < Math.min(i + 1000, 105000); j += 1) chunk += JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "model-" + j, usage: { input: 1 } } }) + "\\n";',
		"\t\tfs.writeSync(fd, chunk);",
		"\t}",
		'\tfs.writeSync(fd, JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "model-0", usage: { input: 1e308, output: 1e308 } } }) + "\\n");',
		"\tfs.closeSync(fd);",
		"}",
		'const index = createUsageIndex({ file: indexFile, clock: Date });',
		'index.update(sub("s1"), session);',
		'const published = index.get(key("s1")).published;',
		'console.log("ok " + published.total + " " + Object.keys(published.models).length);',
		"index.save();",
	];
	fs.writeFileSync(script, `${child.join("\n")}\n`);
	const run = () => spawnSync(process.execPath, ["--max-old-space-size=96", script, dir], { encoding: "utf8", timeout: 180_000 });
	const saved = run();
	assert.equal(saved.status, 0, `save child exit ${saved.status}: ${saved.stderr}`);
	assert.match(saved.stdout, /^ok Infinity (?:[1-9]\d{0,2}|1000)$/m);
	const reloadedRun = run();
	assert.equal(reloadedRun.status, 0, `reload child exit ${reloadedRun.status}: ${reloadedRun.stderr}`);
	assert.match(reloadedRun.stdout, /^ok Infinity (?:[1-9]\d{0,2}|1000)$/m);
	assert.equal(reloadedRun.stdout.split("\n")[0], saved.stdout.split("\n")[0], "the reloaded published totals equal the saved ones");
	const reloaded = readUsageIndex(path.join(dir, "usage.json")).get(key("s1"));
	assert.equal(reloaded.published.total, Infinity);
	assert.equal(reloaded.usage.total, Infinity);
	assert.ok(Object.keys(reloaded.published.models).length <= 1000);
	assert.equal(reloaded.published.models["(other models)"].tokens, 105000 - (Object.keys(reloaded.published.models).length - 1));
	assert.equal(reloaded.published.modelsIncomplete, true);
	assert.equal(reloaded.published.models["p/model-0"].tokens, Infinity);
});

test("(gate 13) a capped reader and fresh daemon constructor handle 135,000 overflowing model records", (t) => {
	const { dir } = setup(t);
	const script = path.join(dir, "dense-heap.mjs");
	const indexUrl = new URL("../src/usage-index.mjs", import.meta.url).href;
	const usageUrl = new URL("../src/collect/usage.mjs", import.meta.url).href;
	fs.writeFileSync(script, `
import fs from "node:fs";
import { createUsageIndex, readUsageIndex } from ${JSON.stringify(indexUrl)};
const sub = (sessionId) => ({ sessionId, projectKey: null });
const key = (id) => subjectKey(sub(id));
import { projectKeyOf, subjectKey } from ${JSON.stringify(new URL("../src/session-subject.mjs", import.meta.url).href)};
import { readUsage } from ${JSON.stringify(usageUrl)};
const dir = process.argv[2];
const session = dir + "/dense.jsonl";
const file = dir + "/dense.json";
const clock = { now: () => ${T0} };
const describe = (usage) => [usage.total, usage.cost, Object.keys(usage.models).length, Object.keys(usage.usedModels).length,
	usage.modelsIncomplete, usage.models["(other models)"]?.tokens, usage.models["(other models)"]?.cost].join(" ");
if (process.argv[3] === "save") {
	const fd = fs.openSync(session, "w");
	for (let i = 0; i < 135000; i += 1000) {
		let chunk = "";
		for (let j = i; j < i + 1000; j += 1) {
			chunk += JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "model-" + j,
				usage: { input: 1e308, output: 1e308, cost: { total: 0.25 } } } }) + "\\n";
		}
		fs.writeSync(fd, chunk);
	}
	fs.closeSync(fd);
	const index = createUsageIndex({ file, clock, read(...args) {
		const result = readUsage(...args);
		console.log(describe(result.effective));
		return result;
	} });
	index.update(sub("s"), session);
	if (!index.save()) throw new Error("no index saved");
} else if (process.argv[3] === "dashboard") {
	console.log(describe(readUsageIndex(file).get(key("s")).published));
} else {
	console.log(describe(createUsageIndex({ file, clock }).get(key("s")).published));
}
`);
	const run = (mode) => spawnSync(process.execPath, ["--max-old-space-size=96", script, dir, mode], { encoding: "utf8", timeout: 180_000 });
	const saved = run("save");
	assert.equal(saved.status, 0, saved.stderr);
	const dashboard = run("dashboard");
	const daemon = run("daemon");
	assert.equal(dashboard.status, 0, dashboard.stderr);
	assert.equal(daemon.status, 0, daemon.stderr);
	for (const result of [saved, dashboard, daemon]) {
		assert.equal(result.stdout.trim(), "Infinity 33750 1000 1000 true Infinity 33500.25");
	}
});

test("(gate 13) a markMissing row keeps all its writer fields", (t) => {
	const { clock, fileOf, indexOf } = setup(t);
	const file = fileOf("usage.json");
	const meta = { kind: "child", taskId: "st_missing", file: fileOf("not-found.jsonl") };
	const index = indexOf();
	index.markMissing(sub("s"), meta);
	index.save();
	const original = fs.readFileSync(file, "utf8");
	const loaded = readUsageIndex(file).get(key("s"));
	assert.equal(JSON.stringify(loaded), JSON.stringify(parseIndex(original).entries.s));
	const restarted = indexOf();
	assert.deepEqual(restarted.get(key("s")), loaded);
	// Dirty the index without rewriting the missing row itself.
	restarted.markMissing(sub("other"));
	assert.equal(restarted.save(), true);
	const saved = fs.readFileSync(file, "utf8");
	assert.equal(saved.slice(0, original.length), original);
	assert.equal(loaded.checkedMs, clock.now());
});

for (const treeName of ["usage", "overlay", "published"]) {
	test(`(gate 13) reload rejects oversized model maps in ${treeName}`, (t) => {
		const { fileOf, indexOf } = setup(t);
		const file = fileOf();
		const indexFile = fileOf("usage.json");
		// The unterminated record populates overlay; the terminated one populates usage.
		writeText(file, `${line()}\n${line()}`);
		const index = indexOf();
		index.update(sub("s"), file);
		index.save();
		const original = fs.readFileSync(indexFile, "utf8");
		for (const mapName of ["models", "usedModels"]) {
			for (const failure of ["count", "length"]) {
				const data = parseIndex(original);
				const map = data.entries.s[treeName][mapName];
				const sample = Object.values(map)[0];
				if (failure === "count") {
					for (let i = 0; i < 1000; i += 1) map[`p/${i}`] = sample;
				} else map[`p/${"x".repeat(255)}`] = sample;
				writeText(indexFile, indexText(data));
				const loaded = readUsageIndex(indexFile).get(key("s"));
				const label = `${treeName}.${mapName}: ${failure}`;
				assert.equal(loaded.offset, 0, label);
				assert.equal(compactUsage(loaded), null, label);
				assert.equal(loaded.usage, undefined, label);
				assert.equal(loaded.overlay, undefined, label);
			}
		}
	});
}

for (const treeName of ["usage", "overlay", "published"]) {
	test(`(gate 13) reload rejects missing or malformed numeric leaves in ${treeName}`, (t) => {
		const { fileOf, indexOf } = setup(t);
		const file = fileOf();
		const indexFile = fileOf("usage.json");
		writeText(file, `${line()}\n${line()}`);
		const index = indexOf();
		index.update(sub("s"), file);
		index.save();
		const original = fs.readFileSync(indexFile, "utf8");
		for (const leaf of [
			"total", "input", "output", "cacheRead", "cacheWrite", "cost", "turns",
			"models.input", "models.output", "models.cacheRead", "models.cacheWrite", "models.tokens", "models.cost",
		]) {
			for (const malformed of [false, true]) {
				const data = parseIndex(original);
				const tree = data.entries.s[treeName];
				const [head, tail] = leaf.split(".");
				const node = tail ? Object.values(tree.models)[0] : tree;
				if (malformed) node[tail ?? head] = null;
				else delete node[tail ?? head];
				writeText(indexFile, indexText(data));
				const loaded = readUsageIndex(indexFile).get(key("s"));
				const label = `${treeName}.${leaf}: ${malformed ? "null" : "absent"}`;
				assert.equal(loaded.offset, 0, label);
				assert.equal(compactUsage(loaded), null, label);
			}
		}
	});
}

test("(gate 12) malformed numeric fields invalidate a row at load: null, malformed tags, string", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	index.save();
	const savedFile = path.join(dir, "usage.json");
	const template = fs.readFileSync(savedFile, "utf8");
	const cases = [
		["published.total null", (data) => { data.entries.s1.published.total = null; }],
		["tag with an extra field", (data) => { data.entries.s1.published.total = { $n: "Infinity", extra: true }; }],
		["malformed tag", (data) => { data.entries.s1.published.total = { $n: "Bogus" }; }],
		["string numeric field", (data) => { data.entries.s1.published.input = "number:Infinity"; }],
		["model tokens disagree with counters", (data) => { Object.values(data.entries.s1.published.models)[0].tokens += 1; }],
	];
	for (const [name, mutate] of cases) {
		const data = parseIndex(template);
		mutate(data);
		writeText(savedFile, indexText(data));
		const loaded = readUsageIndex(savedFile).get(key("s1"));
		assert.equal(loaded.offset, 0, name);
		assert.equal(loaded.complete, false, name);
		assert.equal("published" in loaded, false, name);
		assert.equal(compactUsage(loaded), null, name);
		assert.equal(fresh(loaded), false, name);
	}
});

test("(gate 12) a valid current file loads and legacy files start empty", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	index.save();
	const savedFile = path.join(dir, "usage.json");
	const current = readUsageIndex(savedFile).get(key("s1"));
	assert.equal(compactUsage(current).total, 10);
	assert.equal(fresh(current), true);
	const { entries } = parseIndex(fs.readFileSync(savedFile, "utf8"));
	for (const v of [1, 2]) {
		writeText(savedFile, JSON.stringify({ v, entries }));
		assert.equal(readUsageIndex(savedFile).size, 0);
		assert.deepEqual(indexOf().entries(), []);
	}
});

test("a three-call first read shows nothing until the file is read to the end", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${JSON.stringify(assistant({ text: "x".repeat(900) }))}\n${JSON.stringify(assistant({ text: "y".repeat(900) }))}\n${JSON.stringify(assistant({ text: "z".repeat(900) }))}\n`);
	const maxBytes = Math.ceil(fs.statSync(file).size / 3) + 1;
	const index = indexOf();
	const entry = () => index.get(key("s1"));
	assert.equal(index.update(sub("s1"), file, {}, { maxBytes }), maxBytes);
	assert.equal(entry().complete, false);
	assert.equal(compactUsage(entry()), null);
	assert.ok(index.update(sub("s1"), file, {}, { maxBytes }) > 0);
	assert.equal(entry().complete, false);
	assert.equal(compactUsage(entry()), null);
	assert.ok(index.update(sub("s1"), file, {}, { maxBytes }) > 0);
	assert.equal(entry().complete, true);
	assert.equal(index.fresh(entry()), true);
	assert.equal(compactUsage(entry()).total, 30);
});

test("an append to a complete entry keeps it complete", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(index.get(key("s1")).complete, true);
	fs.appendFileSync(file, `${line()}\n`);
	index.update(sub("s1"), file);
	assert.equal(index.get(key("s1")).complete, true);
	assert.equal(compactUsage(index.get(key("s1"))).total, 20);
});

test("ten 4 MiB records appended to a complete entry are counted eight per 32 MiB update", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const oldEnd = fs.statSync(file).size;
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(compactUsage(index.get(key("s1"))).total, 10);

	const record = assistant();
	const target = 4 * MiB - 1;
	const skeleton = JSON.stringify(record);
	record.message.content[0].text = "x".repeat(target - skeleton.length);
	const bigLine = JSON.stringify(record);
	assert.equal(Buffer.byteLength(bigLine) + 1, 4 * MiB);
	fs.appendFileSync(file, `${bigLine}\n`.repeat(10));

	const entry = index.get(key("s1"));
	assert.equal(index.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES }), 8 * 4 * MiB);
	assert.equal(entry.usage.total, 90);
	assert.equal(entry.offset, oldEnd + 8 * 4 * MiB);
	assert.equal(entry.complete, true);
	assert.equal(entry.evaluatedTo < entry.size, true);
	assert.equal(compactUsage(entry).total, 10);

	assert.equal(index.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES }), 2 * 4 * MiB);
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
	index.update(sub("s1"), file);
	assert.equal(compactUsage(index.get(key("s1"))).total, 10);

	const record = assistant({ usage: use({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0 }) });
	const target = 40 * MiB;
	const skeleton = JSON.stringify(record);
	record.message.content[0].text = "x".repeat(target - skeleton.length);
	const bigLine = JSON.stringify(record);
	assert.equal(Buffer.byteLength(bigLine), target);
	fs.appendFileSync(file, `${bigLine}\n`);

	const entry = index.get(key("s1"));
	index.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(entry.complete, true);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(entry.offset, oldEnd);
	assert.equal(entry.evaluatedTo, oldEnd + USAGE_TICK_BYTES);
	assert.equal(index.fresh(entry), false);

	index.update(sub("s1"), file, {}, { maxBytes: USAGE_TICK_BYTES });
	assert.equal(entry.complete, true);
	assert.equal(compactUsage(entry).total, 14);
	assert.equal(entry.evaluatedTo, entry.size);
	assert.equal(index.fresh(entry), true);
});

test("a missing file marks the entry missing", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const file = fileOf("never.jsonl");
	assert.equal(index.update(sub("s1"), file, { kind: "main" }), 0);
	const entry = index.get(key("s1"));
	assert.equal(entry.state, "missing");
	assert.equal(entry.complete, false);
	assert.equal(compactUsage(entry), null);
	index.save();
	assert.equal(readUsageIndex(path.join(dir, "usage.json")).get(key("s1")).state, "missing");
});

test("deleting a complete file marks it gone and keeps its total", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	fs.rmSync(file);
	assert.equal(index.update(sub("s1"), file), 0);
	const entry = index.get(key("s1"));
	assert.equal(entry.state, "ok");
	assert.equal(entry.gone, true);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(index.fresh(entry), false);
});

test("(IS-3) deleted task-only usage survives zero candidates, not a competing file", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	const id = "st_deleted";
	const index = indexOf();
	writeText(file, `${line()}\n`);
	index.update(sub(id), file, { kind: "child", taskId: id });
	assert.equal(compactUsage(index.get(key(id)))?.total, 10);

	fs.rmSync(file);
	assert.equal(compactUsage(index.get(key(id)))?.total, 10, "unlink alone must not blank the verified total");
	index.markMissing(sub(id));
	index.save();
	const saved = readUsageIndex(path.join(dir, "usage.json")).get(key(id));
	assert.deepEqual([saved.state, saved.complete, saved.gone, compactUsage(saved)?.total, fresh(saved)], ["ok", true, true, 10, false]);

	writeText(fileOf("replacement.jsonl"), `${line()}\n`);
	// Publish the daemon's revocation before a replacement can be counted.
	index.markMissing(sub(id), {}, { withdraw: true });
	index.save();
	assert.equal(compactUsage(readUsageIndex(path.join(dir, "usage.json")).get(key(id))), null,
		"a different candidate cannot inherit the deleted file's total");
});

test("markMissing keeps a complete entry's published total and marks it gone, while a never-found row stays missing", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const file = fileOf();
	writeText(file, `${line()}\n`);
	index.update(sub("s1"), file);

	const gone = index.markMissing(sub("s1"));
	assert.equal(gone.state, "ok");
	assert.equal(gone.complete, true);
	assert.equal(gone.gone, true);
	assert.equal(compactUsage(gone).total, 10, "the last published total survives the deletion");

	const never = index.markMissing(sub("s2"));
	assert.equal(never.state, "missing");
	assert.equal(never.complete, false);
	assert.equal(never.gone, false);
	assert.equal(compactUsage(never), null);

	index.save();
	const saved = readUsageIndex(path.join(dir, "usage.json"));
	assert.equal(saved.get(key("s1")).gone, true);
	assert.equal(saved.get(key("s1")).state, "ok");
	assert.equal(saved.get(key("s1")).published.total, 10);
});

test("get and has resolve only an explicit, unique taskId alias without a session id", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file, { kind: "child", taskId: "st_01a2" });
	assert.equal(index.get(sub(undefined), "st_01a2"), index.get(key("s1")));
	assert.equal(index.has(sub(undefined), "st_01a2"), true);
	assert.equal(index.has(sub(undefined), "st_absent"), false);
});

test("get and has never cross session identities or resolve ambiguous task ids", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("child-a"), file, { kind: "child", taskId: "st_x" });
	assert.deepEqual([index.get(sub("child-b"), "st_x"), index.get(key("st_x")), index.has(key("st_x"))], [undefined, undefined, false]);
	index.update(sub("child-b"), file, { kind: "child", taskId: "st_x" });
	assert.deepEqual([index.get(sub(null), "st_x"), index.has(sub(null), "st_x")], [undefined, false]);
	assert.equal(index.get(sub("child-b"), "st_x").id, "child-b");
});

test("prune drops entries by checkedMs against the injected clock", (t) => {
	const { clock, fileOf, indexOf } = setup(t);
	const index = indexOf();
	const a = fileOf("a.jsonl");
	const b = fileOf("b.jsonl");
	writeText(a, `${line()}\n`);
	writeText(b, `${line()}\n`);
	index.update(sub("a"), a);
	clock.advance(44 * DAY);
	index.update(sub("b"), b);
	clock.advance(2 * DAY);
	assert.equal(index.prune(clock.now()), 1);
	assert.equal(index.has(key("a")), false);
	assert.equal(index.has(key("b")), true);
	assert.equal(index.prune(clock.now() + 45 * DAY), 1);
	assert.equal(index.has(key("b")), false);
});

test("treeTotals sums descendants, survives a cycle, and skips an incomplete child", () => {
	const entry = (id, parentSessionId, total, complete = true) => ({
		id,
		parentKey: key(parentSessionId),
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
	assert.equal(totals.get(key("main")), 125);
	assert.equal(totals.get(key("child")), 25);
	assert.equal(totals.get(key("grandchild")), null);
	assert.equal(totals.get(key("x")), 16);
	assert.equal(totals.get(key("y")), 16);
	assert.equal(totals.get(key("main2")), null);
	assert.equal(totals.get(key("child2")), null);

	const index = createUsageIndex({ file: "unused.json", clock: createFakeClock(T0) });
	const map = treeTotals(new Map([[key("main"), { id: "main", state: "ok", complete: true, published: { total: 3 } }]]));
	assert.equal(map.get(key("main")), null);
});

test("(IS-1) a negative total and cost save and reload through the index", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const negative = JSON.stringify({
		type: "message",
		id: nextId(),
		timestamp: iso(T0),
		message: {
			role: "assistant",
			content: [],
			provider: "p",
			model: "m",
			usage: { input: -5, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: -0.5 } },
			stopReason: "stop",
			timestamp: T0,
		},
	});
	writeText(file, `${negative}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	assert.equal(compactUsage(index.get(key("s1"))).total, -2);
	assert.equal(compactUsage(index.get(key("s1"))).cost, -0.5);
	assert.deepEqual(index.get(key("s1")).published.models["p/m"], { input: -5, output: 3, cacheRead: 0, cacheWrite: 0, tokens: -2, cost: -0.5 });
	assert.equal(index.save(), true);
	const saved = fileOf("usage.json");
	assert.equal(compactUsage(readUsageIndex(saved).get(key("s1"))).total, -2);
	const reloaded = indexOf();
	assert.equal(compactUsage(reloaded.get(key("s1"))).total, -2);
	assert.equal(compactUsage(reloaded.get(key("s1"))).cost, -0.5);
	fs.appendFileSync(file, `${line()}\n`);
	reloaded.update(sub("s1"), file);
	assert.equal(compactUsage(reloaded.get(key("s1"))).total, 8);
	assert.equal(reloaded.save(), true);
	assert.equal(compactUsage(indexOf().get(key("s1"))).total, 8);
});

test("(IS-4, IS-12) a failed usage read still spends the tick's scan budget", (t) => {
	const { clock, fileOf, indexOf } = setup(t);
	const files = new Map([["broken", fileOf("broken.jsonl")], ["next", fileOf("next.jsonl")]]);
	const record = `${line()}\n`;
	for (const file of files.values()) writeText(file, record);
	const index = indexOf();
	const tracker = createUsageTracker({
		index, clock, locator: {
			findMainFile({ sessionId }) { return { file: files.get(sessionId), bytesRead: 0 }; },
		},
	});
	assert.equal(tracker.queueLedger([
		{ sessionId: "broken", kind: "main", endedMs: T0 - 1 },
		{ sessionId: "next", kind: "main", endedMs: T0 - 2 },
	]), 2);

	// Extend both tiny fixtures virtually, counting scan traffic independently
	// of the bounded head/tail fingerprint reads.
	const scanBytes = new Map([["broken", 0], ["next", 0]]);
	const descriptors = new Map();
	const { openSync, fstatSync, readSync } = fs;
	t.mock.method(fs, "openSync", (file, ...args) => {
		const fd = openSync(file, ...args);
		descriptors.set(fd, file === files.get("broken") ? "broken" : file === files.get("next") ? "next" : undefined);
		return fd;
	});
	t.mock.method(fs, "fstatSync", (fd, options) => {
		const stat = fstatSync(fd, options);
		return descriptors.get(fd) ? { ...stat, size: options?.bigint ? BigInt(USAGE_TICK_BYTES) : USAGE_TICK_BYTES } : stat;
	});
	let brokenScanReads = 0;
	t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
		const id = descriptors.get(fd);
		if (!id || length <= 4096) return readSync(fd, buffer, offset, length, position);
		if (id === "broken" && ++brokenScanReads === 4) {
			throw Object.assign(new Error("injected read failure"), { code: "EIO" });
		}
		// Two whole scan chunks, then a short successful read in the range
		// whose next underlying read throws.
		const n = id === "broken" && brokenScanReads === 3 ? 17 : length;
		buffer.fill(0x20, offset, offset + n);
		if (position === 0) readSync(fd, buffer, offset, Buffer.byteLength(record), 0);
		buffer[offset + n - 1] = 0x0a;
		scanBytes.set(id, scanBytes.get(id) + n);
		return n;
	});

	const tick = tracker.tick({});
	const failed = index.get(key("broken"));
	assert.equal(brokenScanReads, 4);
	assert.equal(failed.readError, true);
	assert.equal(failed.published, null);
	assert.equal(compactUsage(failed), null);
	assert.ok(scanBytes.get("next") > 0, "the second queued file used the remaining budget");
	const actual = scanBytes.get("broken") + scanBytes.get("next");
	assert.ok(actual <= USAGE_TICK_BYTES, `scanned ${actual} bytes with a ${USAGE_TICK_BYTES}-byte tick budget`);
	assert.equal(tick.bytesRead, actual);
});

test("usage_read_failed is logged once for a directory path and the next successful read clears it", (t) => {
	const { logged, clock, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update(sub("s1"), file);
	const entry = index.get(key("s1"));
	assert.equal(compactUsage(entry).total, 10);

	fs.rmSync(file);
	fs.mkdirSync(file);
	assert.equal(index.update(sub("s1"), file), 0);
	assert.equal(entry.readError, true);
	assert.equal(compactUsage(entry), null);
	assert.equal(entry.complete, true);
	assert.equal(logged.length, 1);
	assert.equal(logged[0].event, "usage_read_failed");
	assert.equal(logged[0].detail.file, "session.jsonl");
	assert.match(logged[0].detail.error, /EISDIR|EPERM|EACCES/);

	clock.advance(1000);
	assert.equal(index.update(sub("s1"), file), 0);
	assert.equal(logged.length, 1);

	fs.rmdirSync(file);
	writeText(file, `${line()}\n`);
	fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
	assert.equal(index.update(sub("s1"), file), fs.statSync(file).size);
	assert.equal(entry.readError, false);
	assert.equal(compactUsage(entry).total, 10);
	assert.equal(logged.length, 1);
	assert.equal(fresh(entry), true);
});
