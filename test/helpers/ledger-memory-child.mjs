import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [operation, dir, mode, shape, fixture] = process.argv.slice(2);
const src = process.env.OMOH_MEMORY_BASELINE
	? pathToFileURL(path.resolve(process.env.OMOH_MEMORY_BASELINE, "src") + path.sep)
	: new URL("../../src/", import.meta.url);
const load = (name) => import(new URL(`${name}.mjs`, src));
const { createUsageIndex, INDEX_BYTE_BUDGET } = await load("usage-index");
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
const indexFile = paths.health.usageIndexFile;
const open = () => createUsageIndex({ file: indexFile, clock });

if (operation === "build-index") {
	const index = open();
	const seed = path.join(dir, "seed.jsonl");
	put(seed, usageLine);
	index.update("seed", seed, { kind: "main" });
	const prefix = "C:/작업/" + ("a".repeat(194) + "/").repeat(100);
	for (let i = 0; !index.full; i++) index.markMissing(`index-${i}`, { kind: "main", file: `${prefix}${i}` });
	assert.ok(index.save());
	console.log(`INDEX budget=${INDEX_BYTE_BUDGET} entries=${index.entries().length} disk=${fs.statSync(indexFile).size}`);
} else {
	const full = mode === "full";
	const index = open();
	assert.equal(index.full, full);
	assert.equal(index.get("seed")?.published?.total, full ? 42 : undefined);
	const locator = createSessionFileLocator({ paths, clock });
	const tracker = createUsageTracker({ paths, index, locator, clock });
	const queue = () => tracker.queueLedger(streamEnded(paths, { sinceMs: now - 30 * day, withLocation: true }));
	const ended = { sessionId: "gate19-new", kind: "main", endedMs: now };
	switch (operation) {
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
			assert.equal(tracker.tokensOf(liveId)?.tokens?.total, 42);
			break;
		}
		case "save":
			index.update("seed", path.join(fixture, "seed.jsonl"), { kind: "main" });
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
			requestAudit(paths, "seed", now);
			let starts = 0;
			createAuditor({ paths, index, config: DEFAULT_CONFIG, clock, env: {}, runner: {
				start() { starts++; return { pid: 1 }; },
			} }).tick(now + 1);
			const state = readAuditState(paths, "seed");
			if (shape === "family") {
				assert.equal(starts, 0);
				assert.equal(state?.reason, "evidence-too-large");
			} else {
				assert.equal(starts, 1, JSON.stringify(state));
				assert.equal(state?.status, "running");
			}
			break;
		}
		default:
			assert.fail(`unknown operation: ${operation}`);
	}
	if (full) assert.equal(index.get("seed")?.published?.total, 42);
}
