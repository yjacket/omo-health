import "./helpers/tmp-root.mjs";
import { projectKeyOf, subjectOf } from "../src/session-subject.mjs";
const sub = (sessionId, cwd) => subjectOf({ sessionId, cwd });
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createAuditor, requestAudit } from "../src/auditor.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { auditFileKey } from "../src/session-subject.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { createUsageIndex } from "../src/usage-index.mjs";
import { E, writeJsonl } from "./helpers/fixtures.mjs";

const NOW = Date.UTC(2026, 10, 20);
const MiB = 1024 * 1024;
const PROBE_BYTES = 64 * 1024;
const TARGET = "custom-owner.jsonl";

function fixture(t, { bystanders = 0, indexed = false, bounds } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-bound-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	const dir = path.join(paths.sessionsDir, projectKeyOf(root));
	const file = path.join(dir, TARGET);
	writeJsonl(file, [
		E.header("owner", root, NOW - 2000),
		E.assistant({ ms: NOW - 1500, model: "claude-opus-5-5", provider: "anthropic-subscription" }),
	]);
	if (bystanders) {
		// Each path incurs a separate probe, without storing hundreds of MiB of fixture data.
		const prefix = path.join(root, "unrelated.jsonl");
		const header = JSON.stringify({ type: "session", id: "unrelated" });
		for (let i = 0; i < bystanders; i++) {
			const candidate = path.join(dir, `custom-bystander-${String(i).padStart(5, "0")}.jsonl`);
			const source = `${prefix}-${Math.floor(i / 512)}`;
			if (i % 512 === 0) fs.writeFileSync(source, header.padEnd(PROBE_BYTES - 1) + "\n");
			fs.linkSync(source, candidate);
		}
	}
	appendEnded(paths, { sessionId: "owner", kind: "main", startedMs: NOW - 2000, endedMs: NOW - 1000, cwd: root });
	const clock = { now: () => NOW };
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	if (indexed) index.update(sub("owner", root), file, { kind: "main" });
	fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: { ultrabrain: { models: ["openai/gpt-5-5"] } } } }));
	fs.writeFileSync(paths.authFile, JSON.stringify({ openai: {} }));
	const starts = [];
	let observed;
	const auditor = createAuditor({
		paths, config: DEFAULT_CONFIG, clock, index, env: {}, runner: { start: (job) => starts.push(job) },
		createWorker(_url, options) {
			const worker = new Worker(new URL("./helpers/audit-prepare-probe.mjs", import.meta.url), {
				...options, workerData: { paths, mode: "session-bytes" },
			});
			worker.on("message", (result) => { observed = result.observed; });
			const post = worker.postMessage.bind(worker);
			worker.postMessage = (job) => post({ ...job, bounds: { ...job.bounds, ...bounds } });
			return worker;
		},
	});
	return {
		file, starts,
		async prepare() {
			try {
				requestAudit(paths, sub("owner", root), NOW);
				auditor.tick(NOW);
				await auditor.preparing();
				auditor.tick(NOW);
				return { observed, record: JSON.parse(fs.readFileSync(path.join(paths.health.auditsDir, `${auditFileKey(sub("owner", root))}.json`), "utf8")),
					charged: fs.existsSync(paths.health.auditBudgetFile) };
			} finally {
				await auditor.close();
			}
		},
	};
}

test("(IS-10) cold discovery stays within the real 320 MiB preparation bound", async (t) => {
	const bound = 320 * MiB;
	const h = fixture(t, { bystanders: bound / PROBE_BYTES + 16 });
	const { observed, record, charged } = await h.prepare();
	assert.ok(observed.sessionBytes > 0, "the worker reached header discovery");
	assert.ok(observed.sessionBytes <= bound, `worker read ${observed.sessionBytes} session-file bytes; bound was ${bound}`);
	assert.equal(record.reason, "evidence-too-large");
	assert.equal(charged, false);
});

test("(IS-10) the worker uses a matching resident stat without probing any header", async (t) => {
	const h = fixture(t, { bystanders: 32, indexed: true });
	const { observed, record } = await h.prepare();
	assert.deepEqual(observed.sessionOpens, [TARGET, TARGET], "only the message scan and timeline may open the indexed file");
	assert.equal(observed.sessionBytes, 2 * fs.statSync(h.file).size);
	assert.equal(record.status, "running");
});

test("(IS-10) discovery that cannot fit fails before launch or charge", async (t) => {
	const h = fixture(t, { bystanders: 4, bounds: {
		preparationMaxBytes: PROBE_BYTES - 1, messageScanMaxBytes: PROBE_BYTES - 1, messageScanTotalBytes: 0,
	} });
	const { observed, record, charged } = await h.prepare();
	assert.deepEqual({ status: record.status, reason: record.reason, starts: h.starts.length, charged },
		{ status: "failed", reason: "evidence-too-large", starts: 0, charged: false });
	assert.deepEqual(observed.sessionOpens, [], "an atomic header probe cannot fit");
});
