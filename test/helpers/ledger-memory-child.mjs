import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [operation, dir, mode, shape, fixture] = process.argv.slice(2);
const src = process.env.OMOH_MEMORY_BASELINE
	? pathToFileURL(path.resolve(process.env.OMOH_MEMORY_BASELINE, "src") + path.sep)
	: new URL("../../src/", import.meta.url);
const load = (name) => import(new URL(`${name}.mjs`, src));
const { createUsageIndex, INDEX_BYTE_BUDGET, USAGE_TICK_BYTES } = await load("usage-index");
const subjectModule = process.env.OMOH_MEMORY_BASELINE ? null : await load("session-subject");
const sub = (sessionId, cwd, taskId) => subjectModule ? subjectModule.subjectOf({ sessionId, cwd, taskId }) : sessionId;
const key = (sessionId, cwd, taskId) => subjectModule ? subjectModule.subjectKey(sub(sessionId, cwd, taskId)) : sessionId;
const { resolvePaths } = await load("paths");
const { appendEnded, hasEnded, streamEnded } = await load("session-ledger");
const { backfillOnce } = await load("session-backfill");
const { createUsageTracker } = await load("usage-tracker");
const { createSessionFileLocator } = await load("collect/session-files");
const { createAuditor, requestAudit, readAuditState } = await load("auditor");
const { DEFAULT_CONFIG } = await load("config");

const day = 86_400_000;
const now = Date.UTC(2026, 10, 22, 20);
const clock = { now: () => now };
const paths = resolvePaths({ USERPROFILE: dir, HOME: dir, OMO_HEALTH_HOME: path.join(dir, "health"), OMO_HEALTH_OMO_HOME: path.join(dir, ".omo") });
const put = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const usageLine = '{"type":"usage","provider":"p","model":"one","usage":{"input":42}}\n';
const sparseTick = operation === "sparse-tick" || operation === "positioned-tick";
const indexFile = sparseTick ? path.join(dir, `${mode}-${operation}.json`) : paths.health.usageIndexFile;
const open = () => createUsageIndex({ file: indexFile, clock });

if (operation === "all-sources") {
	const { loadSessionRecord } = await load("session-record");
	const sessionId = "seed";
	const childId = "child";
	const ts = new Date(now - 1000).toISOString();
	const subject = { sessionId };
	const jsonl = (row) => JSON.stringify(row) + "\n";
	const padding = "z".repeat(256 * 1024);
	const repeats = 416;
	const big = (name, file, noise, { header = "", tail = "" } = {}) => {
		put(file, header);
		const fd = fs.openSync(file, "a");
		try {
			const block = Buffer.from(noise.repeat(8));
			for (let i = 0; i < repeats / 8; i++) fs.writeSync(fd, block);
			fs.writeSync(fd, tail);
		} finally {
			fs.closeSync(fd);
		}
		const bytes = Buffer.byteLength(noise) * repeats;
		assert.ok(bytes > 96 * 1024 * 1024, name);
		console.log(`${name} unrelated bytes=${bytes}`);
	};
	const ended = { kind: "main", startedMs: now - 30_000, endedMs: now };
	big("ledger", path.join(paths.health.sessionsDir, `ended-${ts.slice(0, 10)}.jsonl`),
		jsonl({ ...ended, sessionId: "other", cwd: padding }),
		{ tail: jsonl({ ...ended, sessionId }) + jsonl({ ...ended, sessionId: childId, parentSessionId: sessionId }) });
	big("decisions", path.join(paths.health.decisionsDir, `${ts.slice(0, 10)}.jsonl`),
		jsonl({ ts, event: "opened", fp: "unrelated", subject: { sessionId: "other" }, evidence: [padding] }),
		{ tail: jsonl({ ts, event: "opened", fp: "related", subject }) });
	let invBytes = 0;
	for (let i = 0; i < repeats; i++) {
		const id = `other-${i}`;
		const text = jsonl({ id, subject: { sessionId: "other" }, openedMs: now, evidence: [padding] });
		put(path.join(paths.health.investigationsDir, `${id}.json`), text);
		invBytes += Buffer.byteLength(text);
	}
	assert.ok(invBytes > 96 * 1024 * 1024);
	console.log(`investigations unrelated bytes=${invBytes}`);
	put(path.join(paths.health.investigationsDir, "related.json"), jsonl({ id: "related", subject, openedMs: now }));
	const ownFile = path.join(paths.sessionsDir, "probe", `2026-11-22_${sessionId}.jsonl`);
	put(ownFile, usageLine);
	const index = open();
	index.markMissing(sub("other"), { kind: "main", file: padding });
	index.update(sub(sessionId), ownFile, { kind: "main" });
	assert.ok(index.save());
	const [header, ...rows] = fs.readFileSync(indexFile, "utf8").trimEnd().split("\n");
	const entry = (id) => rows.find((line) => JSON.parse(line).id === id) + "\n";
	// The index is writer-capped; repeated valid IDs model stale copies in an
	// overlarge input without consuming its admission budget before the target.
	big("usage index", indexFile, entry("other"), { header: header + "\n", tail: entry(sessionId) });
	big("descendant transcript", path.join(paths.sessionsDir, "probe", `2026-11-22_${childId}.jsonl`),
		jsonl({ type: "custom_message", customType: "other", content: padding }),
		{ tail: jsonl({ timestamp: ts, type: "custom_message", customType: "omo-health", content: "related notice" }) });
	const result = loadSessionRecord({ paths, id: sessionId, now });
	assert.equal(result.session.sessionId, sessionId);
	assert.deepEqual(result.children.map(({ sessionId }) => sessionId), [childId]);
	assert.equal(result.tokens.total, 42);
	assert.deepEqual(result.health.findings.map(({ fp }) => fp), ["related"]);
	assert.deepEqual(result.health.investigations.map(({ id }) => id), ["related"]);
	assert.deepEqual(result.health.messages, [{ ms: Date.parse(ts), recipient: childId, kind: null, text: "related notice" }]);
	console.log("all source matches found");
} else if (operation === "audit-own-decisions") {
	const sessionId = "seed";
	const ts = new Date(now - 1000).toISOString();
	assert.equal(appendEnded(paths, { sessionId, cwd: dir, kind: "main", startedMs: now - 30_000, endedMs: now }, { nowMs: now }), true);
	put(path.join(paths.sessionsDir, subjectModule?.projectKeyOf(dir) ?? "probe", `2026-11-22_${sessionId}.jsonl`), usageLine);
	put(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["other/reviewer"] } } } }));
	put(paths.authFile, '{"other":{}}');
	const file = path.join(paths.health.decisionsDir, `${ts.slice(0, 10)}.jsonl`);
	put(file, "");
	const row = JSON.stringify({ ts, event: "opened", fp: "own-finding", detector: "D1", subject: { sessionId }, evidence: ["quiet:5ms", "x".repeat(256 * 1024)] }) + "\n";
	const block = Buffer.from(row.repeat(8));
	const fd = fs.openSync(file, "a");
	try {
		for (let i = 0; i < 52; i++) fs.writeSync(fd, block);
	} finally {
		fs.closeSync(fd);
	}
	const bytes = fs.statSync(file).size;
	assert.ok(bytes > 96 * 1024 * 1024);
	console.log(`DECISIONS matching bytes=${bytes}`);
	requestAudit(paths, sub(sessionId, dir), now);
	let starts = 0;
	const auditor = createAuditor({ paths, config: DEFAULT_CONFIG, clock, env: {}, runner: {
		start() { starts++; return { pid: 1 }; },
	} });
	auditor.tick(now);
	await auditor.preparing();
	auditor.tick(now);
	const state = readAuditState(paths, sub(sessionId, dir));
	if (state?.status === "running") {
		assert.equal(starts, 1);
		const refs = JSON.parse(fs.readFileSync(path.join(paths.health.jobsDir, state.jobId, "refs.json"), "utf8"));
		assert.equal(Object.keys(refs.findingRefs).length, 50);
		assert.deepEqual(state.firedDetectors, ["D1"]);
	} else {
		assert.equal(starts, 0);
		assert.equal(state?.reason, "evidence-too-large", JSON.stringify(state));
	}
	console.log(`AUDIT matching decisions: ${state.reason ?? state.status}`);
} else if (operation === "decision-join") {
	const { loadSessionRecord } = await load("session-record");
	const { appendDecision } = await load("decisions");
	const sessionId = "seed";
	assert.equal(appendEnded(paths, { sessionId, kind: "main", startedMs: now - 30_000, endedMs: now }, { nowMs: now }), true);
	const ts = new Date(now - 1000).toISOString();
	const file = path.join(paths.health.decisionsDir, `${ts.slice(0, 10)}.jsonl`);
	fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
	const row = JSON.stringify({ ts, event: "opened", fp: "unrelated", subject: { sessionId: "other" }, evidence: ["x".repeat(8192)] }) + "\n";
	const block = Buffer.from(row.repeat(128));
	const fd = fs.openSync(file, "w");
	try {
		for (let i = 0; i < 112; i++) fs.writeSync(fd, block);
	} finally {
		fs.closeSync(fd);
	}
	const bytes = fs.statSync(file).size;
	assert.ok(bytes > 96 * 1024 * 1024);
	console.log(`DECISIONS unrelated bytes=${bytes}`);
	const record = () => {
		const result = loadSessionRecord({ paths, id: sessionId, now });
		assert.equal(result.found, true);
		return result.health;
	};
	const empty = record();
	assert.deepEqual([empty.findings, empty.actions], [[], []]);
	const fp = "related";
	// The fp-only action precedes the finding that makes the fp eligible.
	appendDecision(paths, { ts, fp, action: { kind: "nudge" }, result: "would" });
	appendDecision(paths, { ts, fp, event: "opened", subject: { sessionId } });
	const joined = record();
	assert.deepEqual(joined.findings.map(({ fp, scope }) => [fp, scope]), [["related", "session"]]);
	assert.deepEqual(joined.actions.map(({ kind, result }) => [kind, result]), [["nudge", "would"]]);
	console.log("DECISIONS bounded join: findings 0 → 1, actions 0 → 1");
} else if (operation === "build-sparse") {
	const cwd = path.join(dir, "prj");
	const target = path.join(cwd, ".omo", "senpi-task", "children", "st_seed", "sessions", "st_seed", "2026-11-22_seed.jsonl");
	put(target, "");
	const fd = fs.openSync(target, "w");
	const chunk = '{"x":"' + "x".repeat(65527) + '"}\n';
	try {
		for (let i = 0; i < 511; i++) fs.writeSync(fd, chunk);
		fs.writeSync(fd, chunk.slice(0, -usageLine.length - 3) + '"}\n' + usageLine);
	} finally {
		fs.closeSync(fd);
	}
	const index = open();
	assert.equal(index.update(sub("seed", cwd, "st_seed"), target, { kind: "child", taskId: "st_seed" }), USAGE_TICK_BYTES);
	const prefix = "C:/작업/" + ("a".repeat(194) + "/").repeat(100);
	for (let i = 0; !index.full; i++) index.markMissing(sub(`existing-${i}`), { kind: "main", file: `${prefix}${i}` });
	assert.ok(index.save());
	const ledger = path.join(paths.health.sessionsDir, "ended-2026-11-22.jsonl");
	const out = fs.openSync(ledger, "w");
	try {
		const write = (row) => fs.writeSync(out, JSON.stringify(row) + "\n");
		write({ sessionId: "seed", taskId: "st_seed", kind: "child", endedMs: now, cwd });
		const longCwd = path.join(dir, "작업") + "/" + ("a".repeat(194) + "/").repeat(99);
		for (let i = 0; i < 1030; i++) {
			write({ sessionId: `c${i}`, taskId: `st_${i}`, kind: "child", endedMs: now - 1, cwd: `${longCwd}${i}` });
		}
	} finally {
		fs.closeSync(out);
	}
} else if (operation === "build-index") {
	const index = open();
	const seed = path.join(dir, "seed.jsonl");
	put(seed, usageLine);
	index.update(sub("seed"), seed, { kind: "main" });
	const prefix = "C:/작업/" + ("a".repeat(194) + "/").repeat(100);
	for (let i = 0; !index.full; i++) index.markMissing(sub(`index-${i}`), { kind: "main", file: `${prefix}${i}` });
	assert.ok(index.save());
	console.log(`INDEX budget=${INDEX_BYTE_BUDGET} entries=${index.entries().length} disk=${fs.statSync(indexFile).size}`);
} else {
	const full = mode === "full";
	const index = open();
	assert.equal(index.full, full);
	assert.equal(index.get(key("seed", sparseTick ? path.join(dir, "prj") : undefined, sparseTick ? "st_seed" : undefined))?.published?.total, full ? 42 : undefined);
	const locator = createSessionFileLocator({ paths, clock });
	const tracker = createUsageTracker({ paths, index, locator, clock });
	const queue = () => tracker.queueLedger(streamEnded(paths, { sinceMs: now - 30 * day, withLocation: true }));
	const ended = { sessionId: "gate19-new", kind: "main", endedMs: now };
	switch (operation) {
		case "sparse-tick":
		case "positioned-tick": {
			function* sparse() {
				for (const { sessionId, taskId, kind, endedMs } of streamEnded(paths)) {
					yield { sessionId, taskId, kind, endedMs };
				}
			}
			assert.equal(operation === "positioned-tick" ? queue() : tracker.queueLedger(sparse()), full ? 1030 : 1031);
			const tick = tracker.tick({ sessions: new Map() });
			assert.equal(tick.bytesRead, full ? 0 : USAGE_TICK_BYTES);
			assert.equal(tracker.tokensOf(sub("seed", sparseTick ? path.join(dir, "prj") : undefined, sparseTick ? "st_seed" : undefined))?.tokens?.total, 42);
			break;
		}
		case "append":
			assert.equal(appendEnded(paths, ended, { nowMs: now }), true);
			assert.equal(appendEnded(paths, ended, { nowMs: now }), false);
			assert.equal(hasEnded(paths, ended.sessionId, { nowMs: now }), true);
			break;
		case "backfill": {
			const result = backfillOnce(paths, now);
			assert.equal(result.skipped, false);
			assert.deepEqual(result.errors, []);
			assert.deepEqual(backfillOnce(paths, now), { skipped: true });
			break;
		}
		case "retention":
			assert.equal(index.prune(now), 0);
			assert.ok(queue() > 0);
			break;
		case "tick": {
			assert.ok(queue() > 0);
			const id = "gate19-live";
			const file = path.join(dir, `2026-11-22_${id}.jsonl`);
			const fd = fs.openSync(file, "w");
			try {
				const chunk = "x".repeat(1024 * 1024);
				fs.writeSync(fd, '{"type":"noise","content":"');
				for (let i = 0; i < 12; i++) fs.writeSync(fd, chunk);
				fs.writeSync(fd, '"}\n' + usageLine);
			} finally {
				fs.closeSync(fd);
			}
			// A saturated index can update an admitted row; it need not admit a new one.
			const liveId = full ? "seed" : id;
			const target = path.join(dir, `2026-11-22_${liveId}.jsonl`);
			if (full) fs.renameSync(file, target);
			const world = { sessions: new Map([[liveId, { id: liveId, kind: "main", file: target }]]) };
			assert.ok(tracker.tick(world).bytesRead > 12 * 1024 * 1024);
			assert.equal(tracker.tokensOf(sub(liveId))?.tokens?.total, 42);
			break;
		}
		case "save":
			index.update(sub("seed"), path.join(fixture, "seed.jsonl"), { kind: "main" });
			assert.equal(index.save(), true);
			assert.ok(fs.statSync(indexFile).size > 0);
			break;
		case "load":
			break; // open() above is the fresh daemon load.
		case "audit": {
			assert.ok(queue() > 0);
			put(path.join(paths.sessionsDir, "probe", "2026-11-22_seed.jsonl"), usageLine);
			put(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["other/reviewer"] } } } }));
			put(paths.authFile, '{"other":{}}');
			requestAudit(paths, sub("seed"), now);
			let starts = 0;
			const auditor = createAuditor({ paths, index, config: DEFAULT_CONFIG, clock, env: {}, runner: {
				start() { starts++; return { pid: 1 }; },
			} });
			auditor.tick(now + 1);
			await auditor.preparing();
			auditor.tick(now + 1);
			const state = readAuditState(paths, sub("seed"));
			if (shape === "family") {
				assert.equal(starts, 0);
				assert.equal(state?.reason, "evidence-too-large", JSON.stringify(state));
			} else {
				assert.equal(starts, 1, JSON.stringify(state));
				assert.equal(state?.status, "running");
			}
			break;
		}
		default:
			assert.fail(`unknown operation: ${operation}`);
	}
	if (full) assert.equal(index.get(key("seed", sparseTick ? path.join(dir, "prj") : undefined, sparseTick ? "st_seed" : undefined))?.published?.total, 42);
}
