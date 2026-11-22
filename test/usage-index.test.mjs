import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers/fixtures.mjs";
import { readUsage } from "../src/collect/usage.mjs";
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

test("(gate 10) finite records that overflow survive a reload and a resumable append", (t) => {
	const { fileOf, indexOf } = setup(t);
	const file = fileOf();
	const overflowing = JSON.stringify(assistant({ usage: use({ input: 1e308, output: 1e308, cost: 1e308 }) }));
	writeText(file, `${overflowing}\n${overflowing}\n${overflowing}`);
	const index = indexOf();
	index.update("s1", file);
	const { usage, overlay, published } = index.get("s1");
	assert.equal(usage.cost, Infinity);
	assert.equal(overlay.total, Infinity, "the unterminated record has its own overflow");
	assert.equal(published.models["anthropic-subscription/claude-opus-5-5"].tokens, Infinity);
	const before = compactUsage(index.get("s1"));
	assert.equal(before.total, Infinity);
	assert.equal(index.save(), true);
	assert.deepEqual(compactUsage(readUsageIndex(fileOf("usage.json")).get("s1")), before, "dashboard reload");

	const reloaded = indexOf();
	assert.equal(reloaded.fresh(reloaded.get("s1")), true);
	assert.deepEqual(reloaded.get("s1").usage, usage);
	assert.deepEqual(reloaded.get("s1").overlay, overlay);
	assert.deepEqual(reloaded.get("s1").published, published);
	const append = `\n${line()}\n`;
	fs.appendFileSync(file, append);
	assert.equal(reloaded.update("s1", file), Buffer.byteLength(overflowing + append), "re-read only the previous EOF fragment and new bytes");
	assert.deepEqual(reloaded.get("s1").published, readUsage(file).effective);
	assert.equal(compactUsage(reloaded.get("s1")).total, Infinity);
});

for (const [expected, appendUsage] of [[-Infinity, use()], [NaN, use({ input: 1e308, output: 1e308 })]]) {
	test(`(gate 10) ${expected} from a legacy index survives save, reload and append`, (t) => {
		const { fileOf, indexOf } = setup(t);
		const file = fileOf();
		const savedFile = fileOf("usage.json");
		writeText(file, `${line()}\n`);
		const index = indexOf();
		index.update("s1", file);
		index.save();
		const legacy = JSON.parse(fs.readFileSync(savedFile, "utf8"));
		legacy.v = 1;
		// A legacy file may contain an exponent that JSON.parse converts to -Infinity.
		writeText(savedFile, JSON.stringify(legacy).replaceAll('"total":10', '"total":-1e999'));
		const migrated = indexOf();
		assert.equal(migrated.get("s1").usage.total, -Infinity);
		const appended = `${JSON.stringify(assistant({ usage: appendUsage }))}\n`;
		fs.appendFileSync(file, appended);
		assert.equal(migrated.update("s1", file), Buffer.byteLength(appended), "resume the v1 cursor");
		assert.equal(compactUsage(migrated.get("s1")).total, expected);
		assert.equal(migrated.save(), true);

		const reloaded = indexOf();
		assert.deepEqual(compactUsage(reloaded.get("s1")), compactUsage(migrated.get("s1")));
		const last = `${line()}\n`;
		fs.appendFileSync(file, last);
		assert.equal(reloaded.update("s1", file), Buffer.byteLength(last));
		assert.equal(compactUsage(reloaded.get("s1")).total, expected);
	});
}

test("(gate 11) a 105,000-model entry saves and reloads under a 96 MiB heap", (t) => {
	const { dir } = setup(t);
	const script = path.join(dir, "heap-save.mjs");
	const indexUrl = new URL("../src/usage-index.mjs", import.meta.url).href;
	const child = [
		'import fs from "node:fs";',
		`import { createUsageIndex, readUsageIndex } from ${JSON.stringify(indexUrl)};`,
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
		'index.update("s1", session);',
		'const total = index.get("s1").published.total;',
		'if (total !== 105000) throw new Error("read total " + total);',
		"index.save();",
		'const reloaded = readUsageIndex(indexFile).get("s1");',
		"const models = Object.keys(reloaded.published.models).length;",
		'console.log("ok " + total + " " + models);',
	];
	fs.writeFileSync(script, `${child.join("\n")}\n`);
	const result = spawnSync(process.execPath, ["--max-old-space-size=96", script, dir], { encoding: "utf8", timeout: 180_000 });
	assert.equal(result.status, 0, `child exit ${result.status}: ${result.stderr}`);
	assert.match(result.stdout, /^ok 105000 (?:[1-9]\d{0,2}|1000)$/m);
	const reloaded = readUsageIndex(path.join(dir, "usage.json")).get("s1");
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
		`import { createUsageIndex } from ${JSON.stringify(indexUrl)};`,
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
		'index.update("s1", session);',
		'const published = index.get("s1").published;',
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
	const reloaded = readUsageIndex(path.join(dir, "usage.json")).get("s1");
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
	index.update("s", session);
	if (!index.save()) throw new Error("no index saved");
} else if (process.argv[3] === "dashboard") {
	console.log(describe(readUsageIndex(file).get("s").published));
} else {
	console.log(describe(createUsageIndex({ file, clock }).get("s").published));
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

for (const version of [1, 2]) {
	test(`(gate 13) a v${version} markMissing row keeps all its writer fields`, (t) => {
		const { clock, fileOf, indexOf } = setup(t);
		const file = fileOf("usage.json");
		const meta = { kind: "child", taskId: "st_missing", file: fileOf("not-found.jsonl") };
		const index = indexOf();
		index.markMissing("s", meta);
		index.save();
		const original = fs.readFileSync(file, "utf8");
		if (version === 1) writeText(file, original.replace('"v": 2', '"v": 1'));
		const loaded = readUsageIndex(file).get("s");
		assert.equal(JSON.stringify(loaded), JSON.stringify(JSON.parse(original).entries.s));
		const restarted = indexOf();
		assert.deepEqual(restarted.get("s"), loaded);
		// Dirty the index without rewriting the missing row itself.
		restarted.markMissing("other");
		assert.equal(restarted.save(), true);
		const saved = fs.readFileSync(file, "utf8");
		assert.equal(saved.slice(0, saved.indexOf(',\n    "other"')), original.slice(0, original.lastIndexOf("\n  }")));
		assert.equal(loaded.checkedMs, clock.now());
	});
}

for (const treeName of ["usage", "overlay", "published"]) {
	test(`(gate 13) reload rejects oversized model maps in ${treeName}`, (t) => {
		const { fileOf, indexOf } = setup(t);
		const file = fileOf();
		const indexFile = fileOf("usage.json");
		// The unterminated record populates overlay; the terminated one populates usage.
		writeText(file, `${line()}\n${line()}`);
		const index = indexOf();
		index.update("s", file);
		index.save();
		const original = fs.readFileSync(indexFile, "utf8");
		for (const mapName of ["models", "usedModels"]) {
			for (const failure of ["count", "length"]) {
				const data = JSON.parse(original);
				const map = data.entries.s[treeName][mapName];
				const sample = Object.values(map)[0];
				if (failure === "count") {
					for (let i = 0; i < 1000; i += 1) map[`p/${i}`] = sample;
				} else map[`p/${"x".repeat(255)}`] = sample;
				writeText(indexFile, JSON.stringify(data));
				const loaded = readUsageIndex(indexFile).get("s");
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
		index.update("s", file);
		index.save();
		const original = fs.readFileSync(indexFile, "utf8");
		for (const version of [1, 2]) {
			for (const leaf of ["total", "input", "output", "cacheRead", "cacheWrite", "cost", "turns", "models.tokens", "models.cost"]) {
				for (const malformed of [false, true]) {
					const data = JSON.parse(original);
					data.v = version;
					const tree = data.entries.s[treeName];
					const [head, tail] = leaf.split(".");
					const node = tail ? Object.values(tree.models)[0] : tree;
					if (malformed) node[tail ?? head] = null;
					else delete node[tail ?? head];
					writeText(indexFile, JSON.stringify(data));
					const loaded = readUsageIndex(indexFile).get("s");
					const label = `v${version} ${treeName}.${leaf}: ${malformed ? "null" : "absent"}`;
					assert.equal(loaded.offset, 0, label);
					assert.equal(compactUsage(loaded), null, label);
				}
			}
		}
	});
}

test("(gate 12) malformed numeric fields invalidate a row at load: v2 null, v1 tag, malformed tag, string", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	index.save();
	const savedFile = path.join(dir, "usage.json");
	const template = fs.readFileSync(savedFile, "utf8");
	const cases = [
		["v2 published.total null", (data) => { data.entries.s1.published.total = null; }],
		["v1 published.total tag", (data) => { data.v = 1; data.entries.s1.published.total = { $n: "Infinity" }; }],
		["v2 malformed tag", (data) => { data.entries.s1.published.total = { $n: "Bogus" }; }],
		["v2 string numeric field", (data) => { data.entries.s1.published.input = "number:Infinity"; }],
	];
	for (const [name, mutate] of cases) {
		const data = JSON.parse(template);
		mutate(data);
		writeText(savedFile, JSON.stringify(data));
		const loaded = readUsageIndex(savedFile).get("s1");
		assert.equal(loaded.offset, 0, name);
		assert.equal(loaded.complete, false, name);
		assert.equal("published" in loaded, false, name);
		assert.equal(compactUsage(loaded), null, name);
		assert.equal(fresh(loaded), false, name);
	}
});

test("(gate 12) valid v1 and v2 files load unchanged", (t) => {
	const { dir, fileOf, indexOf } = setup(t);
	const file = fileOf();
	writeText(file, `${line()}\n`);
	const index = indexOf();
	index.update("s1", file);
	index.save();
	const savedFile = path.join(dir, "usage.json");
	const v2 = readUsageIndex(savedFile).get("s1");
	assert.equal(compactUsage(v2).total, 10);
	assert.equal(fresh(v2), true);
	const v1Data = JSON.parse(fs.readFileSync(savedFile, "utf8"));
	v1Data.v = 1;
	writeText(savedFile, JSON.stringify(v1Data));
	const v1 = readUsageIndex(savedFile).get("s1");
	assert.deepEqual(v1, v2);
	assert.equal(compactUsage(v1).total, 10);
	assert.equal(fresh(v1), true);
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
