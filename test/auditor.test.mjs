import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, test } from "node:test";
import { AUDIT_CONTRACT, REQUEST_TTL_MS, auditsToday, createAuditor, readAuditState, requestAudit } from "../src/auditor.mjs";
import { safeSubjectId } from "../src/session-id.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { usageTimeline } from "../src/collect/usage.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { detectorThresholdsHash } from "../src/config-reload.mjs";
import { appendDecision } from "../src/decisions.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { AUDIT_LIST_CAPS } from "../src/judge/audit.mjs";
import { GUARD_FLAGS } from "../src/judge/lane.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, readEnded } from "../src/session-ledger.mjs";
import { createRunner } from "../src/runner.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { createUiServer } from "../src/ui/server.mjs";
import { createUsageIndex, fresh } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { createRecordingSpawn } from "./fakes/runner.mjs";
import { readJsonSafe } from "../src/util/fsx.mjs";
import { E, appendJsonl, earlyCacheStormEntries, writeJsonl, writeTask } from "./helpers/fixtures.mjs";
import { indexLiveParentTranscript } from "./helpers/live-parent-transcript.mjs";

const BASE = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const POLL = 30_000;
const silent = { info() {}, warn() {}, error() {} };
const LANES = { ultrabrain: ["openai/gpt-5-5"], architect: ["google/gemini-3-pro"], "deep-high": ["xai/grok-5"] };
const TOKEN_ONLY_ANSWER = {
	overall: "sound",
	summary: "토큰 사용과 점검이 모두 적절했습니다.",
	tokens: { judgment: "normal", explanation: "정상 범위입니다." },
	checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
	recommendations: [],
	confidence: 0.8,
};
const RUNNING = { status: "running", result: null, exitCode: null };
const DONE = { status: "done", result: TOKEN_ONLY_ANSWER, exitCode: 0 };

/** poll results in order; the last one repeats. */
const queue = (...results) => (_jobId, n) => results[Math.min(n, results.length - 1)];

/** In-memory runner with the real runner's surface; every behavior is a field the test can swap (`script` answers poll). */
function fakeRunner(paths, state) {
	const r = {
		starts: [],
		polls: [],
		adopts: [],
		terminates: [],
		pollCounts: new Map(),
		writeMeta: true,
		startError: undefined,
		script: queue(RUNNING),
		adopt: () => "absent",
		aliveFn: () => false,
		start(opts) {
			r.starts.push(opts);
			if (r.startError) throw r.startError;
			if (r.writeMeta) {
				const dir = path.join(paths.health.jobsDir, opts.jobId);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ pid: 5000 + r.starts.length, ctimeMs: null, cmdSha1: null, startedMs: state.now, timeoutMs: opts.timeoutMs, kind: opts.kind, command: opts.command, args: opts.args }));
			}
			return { jobId: opts.jobId, pid: 5000 + r.starts.length };
		},
		poll(jobId) {
			r.polls.push(jobId);
			const n = r.pollCounts.get(jobId) ?? 0;
			r.pollCounts.set(jobId, n + 1);
			return r.script(jobId, n);
		},
		adoptJob(jobId, options) {
			r.adopts.push({ jobId, options });
			return r.adopt(jobId, options);
		},
		alive: (jobId) => r.aliveFn(jobId),
		terminate(jobId) {
			r.terminates.push(jobId);
			return "sent";
		},
	};
	return r;
}

const auditors = new Set();
afterEach(async () => {
	await Promise.all([...auditors].map((auditor) => auditor.close?.()));
	auditors.clear();
});

function probeWorker(mode, observed) {
	return (_url, options) => {
		const worker = new Worker(new URL("./helpers/audit-prepare-probe.mjs", import.meta.url), {
			...options, workerData: { paths: options.workerData.paths, mode },
		});
		worker.on("message", (reply) => observed?.(reply.observed));
		return worker;
	};
}

function harness({ providers = ["anthropic-subscription", "openai", "google", "xai"], sessions = ["m1"], entries } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-"));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.omoHome, { recursive: true });
	fs.mkdirSync(paths.agentDir, { recursive: true });
	fs.writeFileSync(paths.omoJsonc, JSON.stringify({ "[native]": { categories: Object.fromEntries(Object.entries(LANES).map(([lane, models]) => [lane, { models }])) } }));
	fs.writeFileSync(paths.authFile, JSON.stringify(Object.fromEntries(providers.map((provider) => [provider, {}]))));
	const state = { now: BASE };
	const clock = { now: () => state.now };
	const config = structuredClone(DEFAULT_CONFIG);
	const h = { root, paths, state, clock, config, runner: undefined, files: {} };
	h.runner = fakeRunner(paths, state);
	h.addSession = (id, list = entries ?? [E.assistant({ ms: BASE - 120_000, id: `a-${id}`, model: "claude-opus-5-5", provider: "anthropic-subscription" })]) => {
		const file = path.join(paths.sessionsDir, "proj", `2026-11-20T11-00-00-000Z_${id}.jsonl`);
		writeJsonl(file, list);
		appendEnded(paths, { sessionId: id, kind: "main", startedMs: BASE - 3_600_000, endedMs: BASE - 60_000, outcome: "completed", reason: "done", cwd: "C:\\dev\\proj" });
		h.files[id] = file;
		return file;
	};
	for (const id of sessions) h.addSession(id);
	h.auditor = (extra = {}) => {
		const auditor = createAuditor({ paths, config, clock, log: silent, runner: h.runner, env: {}, ...extra });
		auditors.add(auditor);
		return auditor;
	};
	h.tick = (auditor, ms = POLL) => {
		state.now += ms;
		auditor.tick(state.now);
	};
	h.prepare = async (auditor, ms) => {
		h.tick(auditor, ms);
		await auditor.preparing();
		auditor.tick(state.now);
	};
	h.request = (id) => {
		const claim = requestAudit(paths, id, state.now);
		state.now += 1;
		return claim;
	};
	h.record = (id) => readJsonSafe(path.join(paths.health.auditsDir, `${id}.json`));
	h.budget = () => readJsonSafe(paths.health.auditBudgetFile);
	h.jobsOf = (id) => h.runner.starts.filter((start) => start.jobId.endsWith(`-${id}`));
	return h;
}

/** Start the oldest queued audit, then die right after the runner spawned it (before `running` is persisted). */
async function crashAfterStart(h, { writeMeta = true } = {}) {
	h.runner.writeMeta = writeMeta;
	const first = h.auditor({
		afterStart: () => {
			throw new Error("crash");
		},
	});
	await assert.rejects(h.prepare(first), /crash/);
	return first;
}

const modelOf = (start) => start.args[start.args.indexOf("--model") + 1];

test("IS-8: one ordinary cold turn does not require a D4 check", async (t) => {
	const h = harness({ entries: [E.assistant({
		ms: BASE - 120_000,
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
	})] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	appendDecision(h.paths, { ts: new Date(BASE - 3_600_000).toISOString(), event: "config", result: "startup", thresholdsHash: detectorThresholdsHash(h.config) });
	const auditor = h.auditor();
	h.request("m1");
	await h.prepare(auditor);
	const launched = h.record("m1");
	assert.equal(launched.status, "running");
	const document = fs.readFileSync(path.join(h.paths.health.jobsDir, launched.jobId, "bundle.md"), "utf8");
	const bundle = JSON.parse(document.split("\n").find((line) => line.startsWith('{"session":')));
	const suggestion = document.split("\n").find((line) => line.startsWith("Also write one check"));
	assert.equal(bundle.inferenceThresholdsKnown.D4, true);
	assert.equal(bundle.tokens.turns, 1);
	assert.equal(bundle.tokens.cacheRead, 0);
	assert.deepEqual(bundle.tokens.cache, { hitRate: 0, stormTurns: 0 });
	assert.equal(bundle.tokens.errors.count, 0);
	assert.deepEqual(launched.firedDetectors, []);

	h.runner.script = queue(DONE);
	h.tick(auditor);
	const { status, reason } = readAuditState(h.paths, "m1");
	assert.deepEqual(
		{ suggestedD4: /\bD4\b/.test(suggestion), required: launched.requiredDetectors, status, reason },
		{ suggestedD4: false, required: [], status: "done", reason: null },
	);
});

test("IS-7 indexed transcript: audit includes the message ref for a child located through a live parent", async () => {
	const h = harness({ sessions: [] });
	const { index, child } = indexLiveParentTranscript(h.paths, h.root, BASE);
	assert.equal(index.get(child.id)?.file, child.file);
	assert.equal(fresh(index.get(child.id)), true);
	const auditor = h.auditor({ index });
	h.request(child.id);
	await h.prepare(auditor);
	assert.equal(h.record(child.id).status, "running");
	const document = fs.readFileSync(path.join(h.runner.starts[0].cwd, "bundle.md"), "utf8");
	const bundle = JSON.parse(document.split("\n").find((line) => line.startsWith('{"session":')));
	assert.equal(bundle.tokens.total, 51_302);
	assert.deepEqual(bundle.omo_health_record.messages, [{ ref: "M1", ms: child.ms, kind: child.kind }]);
});

test("(IS-2 worker) board callbacks keep running while audit preparation is blocked", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const signal = new Int32Array(new SharedArrayBuffer(8));
	let posts = 0;
	const auditor = h.auditor({ createWorker(_url, options) {
		assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 64);
		const worker = new Worker(new URL("./helpers/audit-prepare-probe.mjs", import.meta.url), {
			...options, workerData: { paths: options.workerData.paths, mode: "block", signal },
		});
		const post = worker.postMessage.bind(worker);
		worker.postMessage = (message) => { posts++; post(message); };
		return worker;
	} });
	const boards = [];
	const updateBoard = () => boards.push(h.state.now);
	h.request("m1");
	h.request("m2");
	h.tick(auditor);
	assert.equal(h.record("m1").status, "queued");
	try {
		await Atomics.waitAsync(signal, 0, 0, 30_000).value;
		assert.equal(Atomics.load(signal, 0), 1, "worker entered loadRecord");
		for (let i = 0; i < 4; i++) {
			h.tick(auditor);
			updateBoard();
			assert.equal(boards.length, i + 1);
			assert.equal(auditor.busy(), true);
			assert.equal(h.record("m1").status, "queued");
			assert.equal(h.record("m2").status, "queued");
		}
		assert.equal(posts, 1);
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
	} finally {
		Atomics.store(signal, 1, 1);
		Atomics.notify(signal, 1);
	}
	await auditor.preparing();
	assert.equal(h.record("m1").status, "queued", "reply alone must not launch");
	h.tick(auditor);
	h.tick(auditor);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m2").status, "queued");
	assert.equal(h.runner.starts.length, 1);
	assert.deepEqual(h.budget().jobs, [h.record("m1").jobId]);
	assert.equal(h.budget().count, 1);
});

for (const mode of ["crash", "exit"]) {
	test(`(IS-2 worker) worker ${mode} fails one audit uncharged and the next worker launches`, async () => {
		const h = harness({ sessions: ["m1", "m2"] });
		let workers = 0;
		const auditor = h.auditor({ createWorker(url, options) {
			if (++workers === 1) return probeWorker(mode)(url, options);
			return new Worker(url, options);
		} });
		h.request("m1");
		h.tick(auditor);
		await auditor.preparing?.();
		h.tick(auditor);
		const first = h.record("m1");
		assert.equal(first.status, "failed");
		assert.equal(first.reason, "prepare-error");
		assert.match(first.detail, mode === "crash" ? /failed preparation/ : /exited \(7\)/);
		assert.ok(first.detail.length <= 300);
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
		h.request("m2");
		await h.prepare(auditor);
		assert.equal(workers, 2);
		assert.equal(h.record("m2").status, "running");
		assert.equal(h.runner.starts.length, 1);
		assert.deepEqual(h.budget().jobs, [h.record("m2").jobId]);
		assert.equal(h.budget().count, 1);
	});
}

for (const complete of [true, false]) {
	test(`(coverage) an audit ${complete ? "reviewing every fired detector finishes done" : "citing both findings without judging both detectors fails without a refund"}`, async (t) => {
		const h = harness();
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		fs.mkdirSync(h.paths.health.decisionsDir, { recursive: true });
		appendJsonl(path.join(h.paths.health.decisionsDir, "2026-11-20.jsonl"), [
			{ ts: new Date(BASE - 100_000).toISOString(), fp: "d6", event: "opened", detector: "D6", subject: { sessionId: "m1" } },
			{ ts: new Date(BASE - 110_000).toISOString(), fp: "d8", event: "opened", detector: "D8" },
		]);
		h.request("m1");
		await h.prepare(h.auditor());
		const launched = readAuditState(h.paths, "m1");
		assert.equal(launched.status, "running");
		const checks = [{ item: "D6", judgment: "sound", explanation: "적절했습니다.", evidence: ["근거: F1, F2"] }];
		if (complete) checks.push({ item: "F2", judgment: "sound", explanation: "적절했습니다.", evidence: ["근거: F2"] });
		h.runner.script = () => ({ ...DONE, result: { ...TOKEN_ONLY_ANSWER, checks } });
		h.tick(h.auditor()); // Finish on a fresh auditor, using the launch-time evidence.

		const state = readAuditState(h.paths, "m1");
		assert.equal(state.status, complete ? "done" : "failed");
		assert.deepEqual(launched.firedDetectors, ["D6", "D8"]);
		assert.deepEqual(h.budget().jobs, [launched.jobId]);
		assert.equal(h.budget().count, 1);
		if (complete) {
			assert.deepEqual(state.result.checks, checks);
			assert.equal(state.reason, null);
		} else {
			assert.equal(state.reason, "incomplete-checks");
			assert.equal(state.result, null);
			assert.equal(state.reasonKo, "감지를 모두 검토하지 않은 답을 받았습니다");
		}
	});
}

for (const [complete, restart] of [[false, false], [false, true], [true, true]]) {
	test(`plan65: ${complete ? "judging" : "omitting"} the suggested D4 ${restart ? "after a restart" : "without a restart"}`, async (t) => {
		const { cacheStormWrite } = DEFAULT_CONFIG.tokens;
		const entries = [3 * cacheStormWrite, 0, 0].map((cacheRead, i) => E.assistant({
			ms: BASE - 120_000 + i * 1000,
			usage: { input: 10, output: 100, cacheRead, cacheWrite: i === 0 ? 0 : cacheStormWrite },
		}));
		const h = harness({ entries });
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		appendDecision(h.paths, { ts: new Date(BASE - 3_600_000).toISOString(), event: "config", result: "startup", thresholdsHash: detectorThresholdsHash(h.config) });
		const auditor = h.auditor();
		h.request("m1");
		await h.prepare(auditor);
		const launched = h.record("m1");
		assert.equal(launched.status, "running");
		assert.deepEqual(launched.firedDetectors, []);
		const document = fs.readFileSync(path.join(h.paths.health.jobsDir, launched.jobId, "bundle.md"), "utf8");
		assert.match(document, /"stormTurns":2/);
		assert.match(document, /^Also write one check for each detector whose conditions the aggregates suggest should have fired \(D4\),/m);

		const checks = [...TOKEN_ONLY_ANSWER.checks];
		if (complete) checks.push({ item: "D4", judgment: "missed", explanation: "캐시 폭풍을 놓쳤습니다.", evidence: ["T"] });
		h.runner.script = () => ({ ...DONE, result: { ...TOKEN_ONLY_ANSWER, checks } });
		if (restart) await auditor.close();
		h.tick(restart ? h.auditor() : auditor);

		const state = readAuditState(h.paths, "m1");
		assert.equal(state.status, complete ? "done" : "failed");
		assert.equal(state.reason, complete ? null : "incomplete-checks");
		if (complete) assert.deepEqual(state.result.checks, checks);
		else {
			assert.equal(state.result, null);
			assert.equal(state.reasonKo, "감지를 모두 검토하지 않은 답을 받았습니다");
		}
		assert.deepEqual(launched.requiredDetectors, ["D4"]);
		assert.deepEqual(state.requiredDetectors, launched.requiredDetectors);
		assert.equal(h.runner.starts.length, 1);
		assert.deepEqual(h.budget().jobs, [launched.jobId]);
		assert.equal(h.budget().count, 1);
	});
}

for (const complete of [false, true]) {
	test(`(IS-8) an early D4 cache storm survives 201 ordinary turns: ${complete ? "judging D4 finishes done" : "omitting D4 fails"}`, async (t) => {
		const entries = earlyCacheStormEntries(BASE - 300_000, DEFAULT_CONFIG.tokens.cacheStormWrite);
		const h = harness({ entries });
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		appendDecision(h.paths, { ts: new Date(BASE - 3_600_000).toISOString(), event: "config", result: "startup", thresholdsHash: detectorThresholdsHash(h.config) });
		const auditor = h.auditor();
		h.request("m1");
		await h.prepare(auditor);
		const launched = h.record("m1");
		assert.equal(launched.status, "running");
		assert.deepEqual(launched.firedDetectors, []);

		const checks = [...TOKEN_ONLY_ANSWER.checks];
		if (complete) checks.push({ item: "D4", judgment: "missed", explanation: "캐시 폭풍을 놓쳤습니다.", evidence: ["T"] });
		h.runner.script = () => ({ ...DONE, result: { ...TOKEN_ONLY_ANSWER, checks } });
		h.tick(auditor);
		const state = h.record("m1");
		assert.equal(state.status, complete ? "done" : "failed");
		assert.equal(state.reason, complete ? null : "incomplete-checks");
		assert.deepEqual(state.result?.checks ?? null, complete ? checks : null);

		assert.deepEqual(launched.requiredDetectors, ["D4"]);
		const document = fs.readFileSync(path.join(h.paths.health.jobsDir, launched.jobId, "bundle.md"), "utf8");
		assert.match(document, /"stormTurns":2/);
	});
}

test("IS-8 image load: omitting D4 fails and judging D4 finishes done", async (t) => {
	const user = E.user("", BASE - 123_000);
	const count = DEFAULT_CONFIG.tokens.imageTrimCount;
	user.message.content = Array(count).fill({ type: "image", data: "AAAA", mimeType: "image/png" });
	const h = harness({ sessions: ["m1", "m2"], entries: [user, E.assistant({ ms: BASE - 120_000 })] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	appendDecision(h.paths, { ts: new Date(BASE - 3_600_000).toISOString(), event: "config", result: "startup", thresholdsHash: detectorThresholdsHash(h.config) });
	const auditor = h.auditor();
	const outcomes = [];
	for (const [id, complete] of [["m1", false], ["m2", true]]) {
		h.request(id);
		await h.prepare(auditor);
		const launched = h.record(id);
		assert.equal(launched.status, "running");
		assert.deepEqual(launched.firedDetectors, []);
		const document = fs.readFileSync(path.join(h.paths.health.jobsDir, launched.jobId, "bundle.md"), "utf8");
		assert.match(document, /"stormTurns":0/);
		assert.match(document, new RegExp(`"images":\\{"peakCount":${count},"peakMiB":[^,]+,"incomplete":false\\}`));
		const checks = [...TOKEN_ONLY_ANSWER.checks];
		if (complete) checks.push({ item: "D4", judgment: "missed", explanation: "이미지 누적을 놓쳤습니다.", evidence: ["T"] });
		h.runner.script = () => ({ ...DONE, result: { ...TOKEN_ONLY_ANSWER, checks } });
		h.tick(auditor);
		const state = h.record(id);
		if (complete) assert.deepEqual(state.result?.checks, checks);
		const suggested = /^Also write one check.*\bD4\b/m.test(document);
		outcomes.push([launched.requiredDetectors, suggested, state.status, state.reason]);
	}
	assert.deepEqual(outcomes, [
		[["D4"], true, "failed", "incomplete-checks"],
		[["D4"], true, "done", null],
	]);
});

test("(gate 16) audit preparation reaches reviewer launch with a resident index at 96 MiB", (t) => {
	const h = harness({ providers: ["openai", "google"], entries: [E.assistant({ ms: BASE - 120_000, model: "gpt-5-5", provider: "openai" })] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const source = (name) => JSON.stringify(new URL(`../src/${name}.mjs`, import.meta.url).href);
	const program = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createUsageIndex } from ${source("usage-index")};
import { createAuditor, requestAudit, readAuditState } from ${source("auditor")};
import { DEFAULT_CONFIG } from ${source("config")};
const [mode, pathsJSON, transcript] = process.argv.slice(1);
const paths = JSON.parse(pathsJSON);
const now = ${BASE};
const clock = { now: () => now };
const file = paths.health.usageIndexFile;
const index = createUsageIndex({ file, clock });
if (mode === "fixture") {
	index.update("m1", transcript, { kind: "main" });
	const seed = index.get("m1");
	index.save();
	const fd = fs.openSync(file, "a");
	try {
		const prefix = "C:/" + ("작".repeat(192) + "/").repeat(6);
		for (let i = 0; i < 12000; i++) fs.writeSync(fd, JSON.stringify({ ...seed, id: "s" + i, file: prefix + i }) + "\\n");
	} finally { fs.closeSync(fd); }
} else {
	assert.ok(index.get("m1").published.total > 0);
	const open = fs.openSync;
	let indexOpens = 0;
	fs.openSync = (name, ...args) => {
		if (name === file) ++indexOpens;
		return open(name, ...args);
	};
	let launches = 0;
	requestAudit(paths, "m1", now);
	const auditor = createAuditor({ paths, index, clock, config: DEFAULT_CONFIG, env: {}, timelineMaxBytes: 0, runner: {
		start() { launches++; return { pid: 5001 }; },
	} });
	auditor.tick(now + 1);
	assert.equal(indexOpens, 0, "the submitting daemon tick never reopens the index");
	await auditor.preparing();
	auditor.tick(now + 1);
	assert.equal(launches, 1);
	const record = readAuditState(paths, "m1");
	assert.deepEqual([record.status, record.model], ["running", "google/gemini-3-pro"]);
	assert.ok(fs.readFileSync(paths.health.jobsDir + "/" + record.jobId + "/bundle.md", "utf8").includes('"total":' + index.get("m1").published.total));
	assert.equal(indexOpens, 0);
}
`;
	for (const mode of ["fixture", "audit"]) {
		const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "--eval", program, mode, JSON.stringify(h.paths), h.files.m1], { encoding: "utf8" });
		assert.equal(result.status, 0, `${mode}:\n${result.stderr}\n${result.error ?? ""}`);
	}
});

test("a request becomes queued, then running with the marker, the guard flags and one charge, then done", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	assert.equal(a.busy(), false, "a request file alone is not read until a tick");
	await h.prepare(a);
	const record = h.record("m1");
	assert.equal(record.status, "running");
	assert.deepEqual([record.model, record.lane, record.independence], ["openai/gpt-5-5", "ultrabrain", "family"]);
	assert.equal(h.runner.starts.length, 1);
	const start = h.runner.starts[0];
	assert.equal(start.kind, "audit");
	assert.equal(start.timeoutMs, 15 * 60_000);
	assert.equal(typeof start.parse, "function");
	assert.equal(start.parse, AUDIT_CONTRACT.parse);
	assert.equal(start.unavailableReason, AUDIT_CONTRACT.unavailableReason);
	for (const flag of GUARD_FLAGS) assert.ok(start.args.includes(flag), `guard flag ${flag}`);
	const bundleFile = path.join(h.paths.health.jobsDir, record.jobId, "bundle.md");
	assert.ok(start.args.includes(`@${bundleFile}`));
	assert.ok(fs.existsSync(bundleFile));
	assert.equal(start.args[start.args.indexOf("--session-id") + 1], record.laneSessionId);
	const marker = readJsonSafe(path.join(h.paths.health.jobsDir, record.jobId, "analyst.json"));
	assert.deepEqual([marker.kind, marker.sessionId, marker.model, marker.jobId], ["audit", record.laneSessionId, record.model, record.jobId]);
	assert.deepEqual(h.budget().jobs, [record.jobId]);
	assert.equal(h.budget().count, 1);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false, "the request is consumed");

	h.runner.script = () => DONE;
	h.tick(a);
	const done = h.record("m1");
	assert.equal(done.status, "done");
	assert.equal(done.result.overall, "sound");
	assert.ok(Number.isFinite(done.finishedMs));
	assert.equal(a.busy(), false);
});

test("a request the daemon accepted is not expired while it waits behind a running audit, and starts after it", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m2").status, "queued");
	h.tick(a, REQUEST_TTL_MS + 60_000);
	assert.equal(h.record("m1").status, "running", "still inside its 15-minute limit");
	assert.equal(h.record("m2").status, "queued", "the expiry applies to a request file the daemon has not taken, not to the queue");
	h.runner.script = () => DONE;
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	await h.prepare(a);
	assert.equal(h.record("m2").status, "running", "the waiting request starts once the slot is free");
	h.tick(a);
	assert.equal(h.record("m2").status, "done");
	assert.equal(h.record("m2").reason ?? null, null);
	assert.equal(h.runner.starts.length, 2);
	assert.equal(h.budget().count, 2);
});

test("a running job survives a daemon restart: one runner.start and one charge", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.runner.script = queue(RUNNING, RUNNING, DONE);
	await h.prepare(a);
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "running");
	const b = h.auditor();
	assert.equal(b.busy(), true, "a record left running holds the slot in the new process");
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("a rerun charges again", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.runner.script = () => DONE;
	await h.prepare(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 2);
	assert.equal(h.budget().count, 2);
	assert.notEqual(h.runner.starts[0].jobId, h.runner.starts[1].jobId);
});

test("dying right after the spawn leaves a launching record that the next auditor polls to done without a second start", async () => {
	const h = harness();
	h.request("m1");
	await crashAfterStart(h);
	assert.equal(h.record("m1").status, "launching");
	h.runner.script = () => DONE;
	const b = h.auditor();
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("dying inside the spawn (no meta.json) ends launch-uncertain without a second start", async () => {
	const h = harness();
	h.request("m1");
	await crashAfterStart(h, { writeMeta: false });
	const b = h.auditor();
	h.tick(b);
	const record = h.record("m1");
	assert.equal(record.status, "failed");
	assert.equal(record.reason, "launch-uncertain");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.runner.adopts.length, 1);
	assert.equal(h.budget().count, 1, "the charge stays");
	assert.equal(b.busy(), false);
});

async function twoSessionsCrashed() {
	const h = harness({ sessions: ["m1", "m2"] });
	h.request("m1");
	h.request("m2");
	await crashAfterStart(h, { writeMeta: false });
	return h;
}

test("after that crash with a second audit queued: adoptJob running keeps the second waiting until the first ends", async () => {
	const h = await twoSessionsCrashed();
	h.runner.adopt = () => "running";
	h.runner.script = (jobId, n) => (jobId.endsWith("-m1") && n >= 1 ? DONE : RUNNING);
	const b = h.auditor();
	assert.equal(h.record("m1").status, "running");
	h.tick(b);
	assert.equal(h.runner.starts.length, 1, "the first is still running");
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1, "the slot was freed by the poll of this tick");
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
});

test("after that crash: adoptJob absent frees the slot and the second starts on the next tick", async () => {
	const h = await twoSessionsCrashed();
	h.runner.adopt = () => "absent";
	const b = h.auditor();
	assert.equal(h.record("m1").reason, "launch-uncertain");
	assert.equal(h.runner.starts.length, 1);
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
	assert.equal(h.runner.starts.filter((start) => start.jobId.endsWith("-m1")).length, 1, "the uncertain job is never restarted");
});

test("after that crash: a throwing adoptJob keeps the second waiting across ticks", async () => {
	const h = await twoSessionsCrashed();
	h.runner.adopt = () => {
		throw new Error("cim down");
	};
	const b = h.auditor();
	for (let i = 0; i < 4; i++) {
		h.tick(b);
		assert.equal(h.record("m1").status, "launching");
		assert.equal(h.runner.starts.length, 1);
	}
	assert.equal(b.busy(), true);
	h.runner.adopt = () => "absent";
	h.tick(b);
	assert.equal(h.record("m1").reason, "launch-uncertain");
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2);
});

function aliveFlag(h) {
	const flag = { value: true, throws: false };
	h.runner.aliveFn = () => {
		if (flag.throws) throw new Error("identity lookup failed");
		return flag.value;
	};
	return flag;
}

test("five failed lookups past the deadline, then timeout: the second audit starts only after alive turns false", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	const failedLookup = { status: "running", result: null, exitCode: null, detail: "job process lookup failed" };
	h.runner.script = (jobId, n) => (!jobId.endsWith("-m1") ? RUNNING : n < 5 ? failedLookup : { status: "timeout", result: null, exitCode: null });
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	for (let i = 0; i < 5; i++) {
		h.tick(a);
		assert.equal(h.record("m1").status, "running");
		assert.equal(h.runner.starts.length, 1);
	}
	h.tick(a);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.record("m1").terminationUnconfirmed], ["running", null, true]);
	assert.equal(h.record("m1").holdUntilExit, true);
	for (let i = 0; i < 3; i++) {
		h.tick(a);
		assert.equal(h.runner.starts.length, 1, "alive: still held");
	}
	alive.value = false;
	h.tick(a);
	assert.equal(h.record("m1").holdUntilExit, undefined);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason], ["failed", "timeout"]);
	assert.equal(h.runner.starts.length, 1, "alive turned false on this tick; the next one starts");
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 2);
});

test("a timeout holds the slot while alive is true, retries terminate on every poll, and survives a failed lookup", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "timeout", result: null, exitCode: null } : RUNNING);
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	h.tick(a);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.record("m1").terminationUnconfirmed], ["running", null, true]);
	assert.equal(a.busy(), true);
	alive.throws = true;
	h.tick(a);
	assert.equal(h.record("m1").holdUntilExit, true, "a failed lookup keeps the hold");
	assert.equal(h.runner.terminates.length, 0);
	alive.throws = false;
	for (let i = 1; i <= 3; i++) {
		h.tick(a);
		assert.equal(h.runner.terminates.length, i, "terminate is sent again on each poll while alive");
		assert.equal(h.runner.starts.length, 1);
	}
	alive.value = false;
	h.tick(a);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason], ["failed", "timeout"]);
	assert.equal(h.runner.starts.length, 1);
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 2);
});

test("IS-10 deadline: the second audit starts and charges once only after the timed-out model child is gone", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.config.audit.timeoutMs = POLL;
	const recording = createRecordingSpawn();
	const identity = { ctimeMs: BASE, cmdSha1: "launcher" };
	const child = { pid: 71000, ctimeMs: BASE + POLL + 2, cmdSha1: "model-child" };
	let launcherAlive = true;
	let childAlive = true;
	const runner = createRunner({
		paths: h.paths, clock: h.clock, env: {}, spawnImpl: recording.spawnImpl,
		isAlive: (pid) => pid === 70000 ? launcherAlive : childAlive,
		identify: (pid) => pid === child.pid ? (childAlive ? child : null) : (pid !== 70000 || launcherAlive ? identity : null),
		findJobProcess: (jobId) => jobId.endsWith("-m1") && childAlive ? child : null,
	});
	const a = h.auditor({ runner });
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	const firstJob = h.record("m1").jobId;
	launcherAlive = false;
	fs.writeFileSync(path.join(runner.jobDir(firstJob), "exit.json"), JSON.stringify({ code: 0 }));
	const kills = () => recording.calls.filter(({ command }) => command === "taskkill").map(({ args }) => args);
	h.tick(a, POLL);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m2").status, "queued");
	assert.deepEqual(kills(), []);
	h.tick(a);
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "71000"]]);
	h.tick(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m2").status, "queued");
	assert.equal(recording.calls.length, 3, "one launch and two termination attempts");
	assert.equal(h.budget().count, 1);
	childAlive = false;
	h.tick(a);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason], ["failed", "timeout"]);
	assert.equal(h.record("m2").status, "queued");
	await h.prepare(a);
	const second = h.record("m2");
	assert.equal(second.status, "running");
	h.tick(a);
	assert.equal(recording.calls.filter(({ command }) => command !== "taskkill").length, 2);
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "71000"], ["/F", "/T", "/PID", "71000"]]);
	assert.equal(h.budget().count, 2);
	assert.deepEqual(h.budget().jobs, [firstJob, second.jobId]);
});

test("a launching record whose meta.json has ctimeMs null is polled through the runner, and a second audit waits for its end", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.request("m1");
	h.request("m2");
	await crashAfterStart(h);
	const meta = readJsonSafe(path.join(h.paths.health.jobsDir, h.record("m1").jobId, "meta.json"));
	assert.equal(meta.ctimeMs, null);
	h.runner.script = (jobId, n) => (jobId.endsWith("-m1") && n >= 1 ? DONE : RUNNING);
	const b = h.auditor();
	assert.equal(h.record("m1").status, "running");
	h.tick(b);
	assert.equal(h.runner.starts.length, 1);
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.adopts.length, 0, "meta.json exists, so no process lookup is needed");
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2);
});

test("a pre-spawn throw (spawned:false) refunds the charge and ends spawn-error", async () => {
	const h = harness();
	h.runner.startError = Object.assign(new Error("EACCES"), { spawned: false });
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	const record = h.record("m1");
	assert.equal(record.status, "failed");
	assert.equal(record.reason, "spawn-error");
	assert.equal(record.detail, "EACCES");
	assert.deepEqual(h.budget(), { day: "2026-11-20", count: 0, jobs: [], refunded: [record.jobId] });
	assert.equal(a.busy(), false);
});

test("(IS-10) only a confirmed non-launch refunds, even when its poll result is replayed after restart", async (t) => {
	const h = harness({ sessions: ["m1", "m2"] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	h.runner.writeMeta = false;
	h.runner.start = ({ jobId }) => {
		h.runner.starts.push(jobId);
		return { jobId };
	};
	h.runner.script = (jobId) => ({
		status: "failed",
		reason: "spawn-error:ENOENT",
		...(jobId.endsWith("-m2") ? { spawned: false } : {}),
	});
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	h.tick(a);
	const { jobId: uncertainId, status, reason } = h.record("m1");
	assert.deepEqual([status, reason, h.budget().count], ["failed", "spawn-error:ENOENT", 1]);

	h.request("m2");
	await h.prepare(a);
	const running = h.record("m2");
	assert.equal(running.status, "running");
	assert.equal(h.budget().count, 2);
	h.tick(a);
	assert.deepEqual([h.record("m2").status, h.record("m2").reason, h.budget().count], ["failed", "spawn-error", 1]);
	const refundedBudget = { day: "2026-11-20", count: 1, jobs: [uncertainId], refunded: [running.jobId] };
	assert.deepEqual(h.budget(), refundedBudget);
	h.tick(a);
	assert.deepEqual(h.budget(), refundedBudget);

	// Replay the running record left by a crash after the budget write but before the failure record write.
	fs.writeFileSync(path.join(h.paths.health.auditsDir, "m2.json"), JSON.stringify(running));
	h.tick(h.auditor());
	assert.deepEqual([h.record("m2").status, h.record("m2").reason], ["failed", "spawn-error"]);
	assert.deepEqual(h.budget(), refundedBudget);
	assert.deepEqual(h.runner.starts, [uncertainId, running.jobId]);
	assert.deepEqual(h.runner.polls, [uncertainId, running.jobId, running.jobId]);
});

test("(IS-10) a nonexistent OMO_HEALTH_OMO executable ends spawn-error without spending the daily budget", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const env = { OMO_HEALTH_OMO: path.join(h.root, "missing-omo.exe") };
	let spawnError;
	const runner = createRunner({ paths: h.paths, clock: h.clock, env, spawnImpl: (...args) => {
		const child = spawn(...args);
		spawnError = once(child, "error");
		return child;
	} });
	const a = h.auditor({ runner, env });
	assert.equal(auditsToday(h.paths, h.state.now), 0);
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(auditsToday(h.paths, h.state.now), 1);
	const [error] = await spawnError;
	assert.equal(error.code, "ENOENT");
	h.tick(a);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, auditsToday(h.paths, h.state.now)], ["failed", "spawn-error", 0]);
	assert.equal(a.busy(), false);
});

test("a post-spawn meta write failure keeps the charge and the launching record; the second waits for adoptJob", async () => {
	for (const adopted of ["running", "absent"]) {
		const h = harness({ sessions: ["m1", "m2"] });
		h.runner.startError = Object.assign(new Error("EPERM meta"), { spawned: true, pid: 77 });
		const a = h.auditor();
		h.request("m1");
		h.request("m2");
		await h.prepare(a);
		assert.equal(h.record("m1").status, "launching");
		assert.equal(h.budget().count, 1, "the charge stays");
		h.runner.startError = undefined;
		h.runner.adopt = () => adopted;
		h.runner.script = (jobId, n) => (jobId.endsWith("-m1") && n >= 1 ? DONE : RUNNING);
		h.tick(a);
		assert.equal(h.runner.starts.length, 1, `second waits (adopt ${adopted})`);
		if (adopted === "running") {
			assert.equal(h.record("m1").status, "running");
			h.tick(a);
			assert.equal(h.record("m1").status, "done");
			assert.equal(h.runner.starts.length, 1);
		} else {
			assert.equal(h.record("m1").reason, "launch-uncertain");
		}
		await h.prepare(a);
		assert.equal(h.runner.starts.length, 2);
		assert.equal(h.budget().count, 2);
	}
});

test("a same-length rewrite is no longer fresh, queueLedger requeues it, and the audit refuses with models-unknown until the recount", async () => {
	const mk = (model, input) => E.assistant({ ms: BASE - 120_000, id: "a-m1", model, provider: "openai", usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });
	const h = harness({ entries: [mk("gpt-5-4", 10)] });
	const file = h.files.m1;
	const index = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock, log: silent });
	const tracker = createUsageTracker({ paths: h.paths, index, locator: createSessionFileLocator({ paths: h.paths, clock: h.clock }), clock: h.clock, log: silent });
	const rows = readEnded(h.paths);
	tracker.queueLedger(rows);
	tracker.tick({});
	index.save();
	assert.equal(fresh(index.get("m1")), true);
	assert.equal(index.get("m1").published.total, 15);

	const before = fs.statSync(file);
	writeJsonl(file, [mk("gpt-5-5", 20)]);
	assert.equal(fs.statSync(file).size, before.size, "the rewrite keeps the length");
	fs.utimesSync(file, new Date(before.atimeMs), new Date(before.mtimeMs + 5000));
	assert.equal(fresh(index.get("m1")), false);
	assert.ok(tracker.queueLedger(rows) > 0, "the changed file is queued again");

	const a = h.auditor({ index, timelineMaxBytes: 1 });
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined, "nothing is charged");

	tracker.tick({});
	index.save();
	assert.equal(fresh(index.get("m1")), true);
	assert.equal(index.get("m1").published.total, usageTimeline(file).totals.total, "the recount equals the oracle");
	assert.equal(index.get("m1").published.total, 25);
	h.request("m1");
	await h.prepare(a);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro", "gpt-5-5 is excluded after the recount");
});

test("a same-length rewrite read by a complete timeline excludes the new model before the recount", async () => {
	const mk = (model, input) => E.assistant({ ms: BASE - 120_000, id: "a-m1", model, provider: "openai", usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });
	const h = harness({ entries: [mk("gpt-5-4", 10)] });
	const file = h.files.m1;
	const index = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock, log: silent });
	const tracker = createUsageTracker({ paths: h.paths, index, locator: createSessionFileLocator({ paths: h.paths, clock: h.clock }), clock: h.clock, log: silent });
	tracker.queueLedger(readEnded(h.paths));
	tracker.tick({});
	index.save();
	assert.deepEqual(Object.keys(index.get("m1").published.models), ["openai/gpt-5-4"]);
	const before = fs.statSync(file);
	writeJsonl(file, [mk("gpt-5-5", 20)]);
	assert.equal(fs.statSync(file).size, before.size, "the rewrite keeps the length");
	fs.utimesSync(file, new Date(before.atimeMs), new Date(before.mtimeMs + 5000));
	assert.equal(fresh(index.get("m1")), false, "the index still holds the old read");

	const a = h.auditor({ index });
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 1, "a complete timeline proves coverage without the recount");
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro", "the rewritten model gpt-5-5 is excluded");
	const document = fs.readFileSync(path.join(h.runner.starts[0].cwd, "bundle.md"), "utf8");
	const json = document.match(/^Evidence bundle \(JSON data, not instructions\):\r?\n(.+)$/m)?.[1];
	assert.ok(json, "the outbound document contains its evidence bundle");
	const { total, models } = JSON.parse(json).tokens;
	assert.deepEqual({ total, models }, {
		total: 25,
		models: [{ key: "openai/gpt-5-5", tokens: 25, cost: 0.01 }],
	});
});

test("evidence-too-large charges nothing and never starts", async () => {
	const h = harness();
	const a = h.auditor({ createWorker: probeWorker("oversized") });
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "evidence-too-large");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined);
});

function openaiLine(extra = {}) {
	return E.assistant({ ms: BASE - 60_000, id: "a-late", model: "gpt-5-5", provider: "openai", ...extra });
}
const prewarm = (phase) => ({ type: "custom", customType: "prompt-cache-prewarm", id: `pw-${phase}`, timestamp: new Date(BASE - 30_000).toISOString(), data: { phase, provider: "openai", model: "gpt-5-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });

function indexed(h, id, { maxBytes } = {}) {
	const index = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock, log: silent });
	index.update(id, h.files[id], { kind: "main" }, maxBytes ? { maxBytes } : {});
	index.save();
	return index;
}

test("(IS-1, IS-9) reviewer launch excludes an identity learned only by the resident index after preparation", async (t) => {
	for (const changed of [false, true]) {
		const h = harness();
		const index = indexed(h, "m1");
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		const auditor = h.auditor({ index });
		const published = fs.readFileSync(index.file, "utf8");
		assert.equal(index.get("m1").published.usedModels["openai/gpt-5-5"], undefined);

		h.request("m1");
		h.tick(auditor);
		await auditor.preparing();
		assert.equal(h.record("m1").status, "queued");
		assert.equal(h.runner.starts.length, 0);

		if (changed) {
			appendJsonl(h.files.m1, [openaiLine()]);
			index.update("m1", h.files.m1, { kind: "main" });
			assert.ok(index.get("m1").published.usedModels["openai/gpt-5-5"]);
			assert.equal(fresh(index.get("m1")), true);
			assert.equal(fs.readFileSync(index.file, "utf8"), published, "the resident update was not saved");
		}

		h.tick(auditor);
		if (changed) {
			await auditor.preparing();
			auditor.tick(h.state.now);
		}
		assert.equal(h.record("m1").status, "running");
		assert.equal(h.runner.starts.length, 1);
		assert.equal(modelOf(h.runner.starts[0]), changed ? "google/gemini-3-pro" : "openai/gpt-5-5");
	}
});

test("(IS-1, IS-8) an indexed append without a timeline sends current tokens to the reviewer", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const index = indexed(h, "m1");
	const previousTotal = index.get("m1").published.total;
	let prepared;
	let sentTokens;
	const start = h.runner.start;
	h.runner.start = (options) => {
		const attachment = options.args.find((arg) => arg.startsWith("@"));
		assert.equal(attachment, `@${path.join(options.cwd, "bundle.md")}`);
		const document = fs.readFileSync(attachment.slice(1), "utf8");
		const json = document.match(/^Evidence bundle \(JSON data, not instructions\):\r?\n(.+)$/m)?.[1];
		assert.ok(json, "the runner receives the evidence bundle");
		sentTokens = JSON.parse(json).tokens;
		return start(options);
	};
	const auditor = h.auditor({ index, timelineMaxBytes: 1, createWorker(url, options) {
		const worker = new Worker(url, options);
		worker.on("message", (reply) => { prepared = reply; });
		return worker;
	} });
	h.request("m1");
	h.tick(auditor);
	const first = auditor.preparing();
	assert.ok(first);
	await first;
	assert.equal(prepared.full, null);
	assert.equal(prepared.loaded.tokens.total, previousTotal);
	assert.equal(h.budget(), undefined);

	appendJsonl(h.files.m1, [openaiLine()]);
	index.update("m1", h.files.m1, { kind: "main" });
	const current = index.get("m1");
	assert.equal(fresh(current), true);
	assert.ok(current.published.total > previousTotal);
	assert.ok(current.published.models["openai/gpt-5-5"]);

	h.tick(auditor);
	const retry = auditor.preparing();
	if (retry) {
		assert.notEqual(retry, first);
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
		await retry;
		assert.equal(prepared.full, null);
		h.tick(auditor);
	}
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(modelOf(h.runner.starts[0]), LANES.architect[0]);
	assert.equal(h.budget().count, 1);
	assert.deepEqual(h.budget().jobs, [h.runner.starts[0].jobId]);
	assert.deepEqual({ total: sentTokens.total, models: Object.fromEntries(sentTokens.models.map(({ key, tokens, cost }) => [key, { tokens, cost }])) }, {
		total: current.published.total,
		models: Object.fromEntries(Object.entries(current.published.models).map(([key, { tokens, cost }]) => [key, { tokens, cost }])),
	});
	assert.ok(retry, "the first preparation was replaced before charging");
});

test("(IS-1, IS-8) three consecutive index version changes without a timeline fail models-unknown uncharged", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const index = indexed(h, "m1");
	const auditor = h.auditor({ index, timelineMaxBytes: 1 });
	h.request("m1");
	h.tick(auditor);
	for (let i = 1; i <= 3; i++) {
		const preparation = auditor.preparing();
		assert.ok(preparation);
		await preparation;
		appendJsonl(h.files.m1, [openaiLine({ id: `a-index-change-${i}` })]);
		index.update("m1", h.files.m1, { kind: "main" });
		assert.equal(fresh(index.get("m1")), true);
		h.tick(auditor);
		assert.equal(h.runner.starts.length, 0, `index version change ${i} must not launch`);
		assert.equal(h.budget(), undefined);
		assert.equal(h.record("m1").status, i < 3 ? "queued" : "failed");
	}
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(auditor.preparing(), undefined);
});

async function prepareWithFrozenRecord(h, mutate) {
	const signal = new Int32Array(new SharedArrayBuffer(8));
	const auditor = h.auditor({ createWorker(_url, options) {
		return new Worker(new URL("./helpers/audit-prepare-probe.mjs", import.meta.url), {
			...options, workerData: { paths: h.paths, mode: "block-after-record", signal },
		});
	} });
	h.request("m1");
	h.tick(auditor);
	try {
		await Atomics.waitAsync(signal, 0, 0, 30_000).value;
		assert.equal(Atomics.load(signal, 0), 1, "worker finished the record join");
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
		mutate();
	} finally {
		Atomics.store(signal, 1, 1);
		Atomics.notify(signal, 1);
	}
	await auditor.preparing();
	h.tick(auditor);
}

test("(IS-9 launch refresh) a late analyzing decision for an older decision-only fp changes the launched model", async () => {
	for (const change of ["none", "unrelated", "selected"]) {
		const h = harness();
		const ts = new Date(BASE).toISOString();
		for (let i = 0; i <= AUDIT_LIST_CAPS.findings; i++) {
			appendDecision(h.paths, { ts: new Date(BASE + i).toISOString(), fp: `f-${i}`, detector: "D1", event: "opened", subject: { sessionId: "m1" } });
		}
		await prepareWithFrozenRecord(h, () => {
			if (change === "none") return;
			const event = { ts, event: "investigation", status: "analyzing", model: LANES.ultrabrain[0] };
			appendDecision(h.paths, { ...event, fp: "other-session" });
			appendDecision(h.paths, { ...event, fp: "f-0", status: "open" });
			if (change === "selected") appendDecision(h.paths, { ...event, fp: "f-0" });
		});
		assert.equal(h.record("m1").status, "running");
		assert.equal(h.runner.starts.length, 1);
		assert.equal(modelOf(h.runner.starts[0]), change === "selected" ? LANES.architect[0] : LANES.ultrabrain[0], change);
		assert.equal(h.budget().count, 1);
	}
});

test("(IS-9 launch refresh) a changed investigation file joins prepared models and prevents a charge", async () => {
	const h = harness({ providers: ["google", "openai"] });
	const store = createInvestigations(h);
	store.open({ id: "investigation", subject: { sessionId: "m1" }, model: LANES.architect[0] });
	await prepareWithFrozenRecord(h, () => store.attach("investigation", { model: LANES.ultrabrain[0] }));
	assert.equal(h.runner.starts.length, 0, "neither the previous nor the current analyst may review");
	assert.equal(h.record("m1").reason, "no-model");
	assert.equal(h.budget(), undefined);
});

test("(IS-9 launch refresh) new descendant investigations exclude their analyst but unrelated ones do not", async () => {
	const first = LANES.ultrabrain[0];
	const next = LANES.architect[0];
	const models = {};
	for (const [kind, subject, source] of [
		["unrelated", { sessionId: "other", taskId: "st_other", parentSessionId: "m1", toolCallId: "st_child" }, "both"],
		["descendant session", { sessionId: "child" }, "both"],
		["descendant task", { taskId: "st_child" }, "file"],
		["descendant parent and task", { parentSessionId: "m1", taskId: "st_child" }, "both"],
		["audited session decision", { sessionId: "m1" }, "decision"],
	]) {
		const h = harness();
		h.config.analyst.lane = "deep-high";
		appendEnded(h.paths, {
			sessionId: "child", taskId: "st_child", parentSessionId: "m1", kind: "child",
			startedMs: BASE - 180_000, endedMs: BASE - 90_000, outcome: "completed",
		});
		await prepareWithFrozenRecord(h, () => {
			const fp = "late-investigation";
			if (source !== "decision") {
				createInvestigations(h).open({ id: fp, subject, ...(source === "file" ? { model: first } : {}) });
			}
			if (source !== "file") {
				// The engine's analyzing row can name only the fp, not the subject.
				appendDecision(h.paths, {
					ts: new Date(BASE).toISOString(), event: "investigation", status: "analyzing", fp, model: first,
					...(source === "decision" ? { subject } : {}),
				});
			}
		});
		assert.equal(h.record("m1").status, "running", kind);
		assert.equal(h.runner.starts.length, 1, kind);
		assert.equal(h.budget().count, 1, kind);
		models[kind] = modelOf(h.runner.starts[0]);
	}
	assert.deepEqual(models, {
		unrelated: first,
		"descendant session": next,
		"descendant task": next,
		"descendant parent and task": next,
		"audited session decision": next,
	});
});

test("(IS-9) an unindexed append after preparation retries before selecting a reviewer", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const index = indexed(h, "m1");
	const auditor = h.auditor({ index });
	h.request("m1");
	h.tick(auditor);
	const first = auditor.preparing();
	await first;
	appendJsonl(h.files.m1, [openaiLine()]);
	assert.equal(index.get("m1").published.usedModels["openai/gpt-5-5"], undefined);
	h.tick(auditor);
	assert.equal(h.runner.starts.length, 0, "the stale timeline must not launch a reviewer");
	assert.equal(h.budget(), undefined);
	assert.equal(h.record("m1").status, "queued");
	const retry = auditor.preparing();
	assert.ok(retry && retry !== first);
	await retry;
	h.tick(auditor);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");
	assert.equal(h.budget().count, 1);
});

test("(IS-9) three consecutive timeline version changes fail models-unknown uncharged", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const auditor = h.auditor({ index: indexed(h, "m1") });
	h.request("m1");
	h.tick(auditor);
	for (let i = 1; i <= 3; i++) {
		const preparation = auditor.preparing();
		assert.ok(preparation);
		await preparation;
		appendJsonl(h.files.m1, [openaiLine({ id: `a-change-${i}` })]);
		h.tick(auditor);
		assert.equal(h.runner.starts.length, 0, `version change ${i} must not launch`);
		assert.equal(h.budget(), undefined);
		assert.equal(h.record("m1").status, i < 3 ? "queued" : "failed");
	}
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(auditor.preparing(), undefined);
});

test("(IS-1) a saturated index sends only related entries to the worker", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const index = indexed(h, "m1");
	for (let depth = 1; depth <= 9; depth++) {
		index.markMissing(`child-${depth}`, { parentSessionId: depth === 1 ? "m1" : `child-${depth - 1}` });
	}
	index.markMissing("root-only", { parentSessionId: "absent", rootSessionId: "m1" });
	const longPath = "C:/" + ("unrelated/".repeat(800));
	for (let i = 0; !index.full && i < 3000; i++) {
		index.markMissing(`unrelated-${i}`, { file: longPath, parentSessionId: `unrelated-${i}` });
	}
	assert.equal(index.full, true);
	assert.ok([...index.values()].length > 1000);
	let posted;
	const auditor = h.auditor({ index, createWorker(url, options) {
		const worker = new Worker(url, options);
		const post = worker.postMessage.bind(worker);
		worker.postMessage = (job) => { posted = job; post(job); };
		return worker;
	} });
	h.request("m1");
	await h.prepare(auditor);
	assert.equal(posted.indexFull, true);
	assert.deepEqual(posted.indexEntries.map(({ id }) => id).sort(),
		["m1", ...Array.from({ length: 8 }, (_, i) => `child-${i + 1}`), "root-only"].sort());
	assert.equal(h.record("m1").status, "running");
});

test("(IS-1) worker prepares tokens, children and model facts after the index file is deleted", async (t) => {
	const h = harness({ entries: [openaiLine()] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const index = indexed(h, "m1");
	const childFile = path.join(h.root, "child.jsonl");
	writeJsonl(childFile, [openaiLine()]);
	index.update("c1", childFile, { parentSessionId: "m1" });
	index.save();
	const resident = createUsageIndex({ file: index.file, clock: h.clock, log: silent });
	fs.unlinkSync(index.file);
	let reply;
	const auditor = h.auditor({ index: resident, timelineMaxBytes: 0, createWorker(url, options) {
		const worker = new Worker(url, options);
		worker.on("message", (result) => { reply = result; });
		return worker;
	} });
	h.request("m1");
	await h.prepare(auditor);
	const ownTotal = resident.get("m1").published.total;
	const childTotal = resident.get("c1").published.total;
	assert.equal(reply.loaded.tokens?.total, ownTotal, "the worker uses the resident publication");
	assert.equal(reply.loaded.tokens.treeTotal, ownTotal + childTotal);
	assert.ok(reply.loaded.tokens.models.some(({ key }) => key === "openai/gpt-5-5"));
	assert.deepEqual(reply.loaded.children.map((child) => [child.sessionId, child.tokens?.total]), [["c1", childTotal]]);
	assert.equal(reply.full, null, "the timeline cannot supply the model facts");
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");
});

test("(gate 15) the auditor excludes an identity missing only from published.usedModels", async () => {
	const h = harness({ entries: [openaiLine()] });
	const index = indexed(h, "m1");
	const file = index.file;
	const [header, row] = fs.readFileSync(file, "utf8").split("\n");
	const entry = JSON.parse(row);
	delete entry.published.usedModels["openai/gpt-5-5"];
	fs.writeFileSync(file, `${header}\n${JSON.stringify(entry)}\n`);

	const resident = createUsageIndex({ file, clock: h.clock, log: silent });
	const a = h.auditor({ index: resident, timelineMaxBytes: fs.statSync(h.files.m1).size - 1 });
	h.request("m1");
	await h.prepare(a);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");
});

test("without a full timeline, an incomplete entry and a complete entry that is not at the end both end models-unknown without a charge", async () => {
	const h = harness();
	const index = indexed(h, "m1", { maxBytes: 10 });
	assert.equal(index.get("m1").complete, false);
	appendJsonl(h.files.m1, [openaiLine()]);
	const small = fs.statSync(h.files.m1).size - 1;
	const a = h.auditor({ index, timelineMaxBytes: small });
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "models-unknown");

	const resident = indexed(h, "m1");
	appendJsonl(h.files.m1, [E.assistant({ ms: BASE - 20_000, id: "a-later", model: "gpt-5-5", provider: "openai" })]);
	const entry = resident.get("m1");
	assert.equal(entry.complete, true);
	assert.equal(fresh(entry), false, "complete but not at the end");
	const b = h.auditor({ index: resident, timelineMaxBytes: fs.statSync(h.files.m1).size - 1 });
	h.request("m1");
	await h.prepare(b);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined);

	const c = h.auditor({ index: resident });
	h.request("m1");
	await h.prepare(c);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro", "with the timeline the unread suffix is seen and its model excluded");
});

test("a prewarm entry alone excludes the first candidate, a failed prewarm in an unread suffix too", async () => {
	const h = harness({ entries: [E.assistant({ ms: BASE - 120_000, id: "a-1", model: "claude-opus-5-5", provider: "anthropic-subscription" }), prewarm("warmed")] });
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");

	const g = harness();
	const index = indexed(g, "m1");
	appendJsonl(g.files.m1, [prewarm("failed")]);
	const entry = index.get("m1");
	assert.equal(fresh(entry), false);
	const b = g.auditor({ index });
	g.request("m1");
	await g.prepare(b);
	assert.equal(modelOf(g.runner.starts[0]), "google/gemini-3-pro");
});

const carrierLine = (kind) => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
	const timestamp = new Date(BASE - 60_000).toISOString();
	if (kind === "toolResult") {
		return { type: "message", id: "tr-1", timestamp, message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: false, provider: "openai", model: "gpt-5-5", usage } };
	}
	return { type: "compaction", id: "cmp-1", timestamp, provider: "openai", model: "gpt-5-5", usage };
};

for (const kind of ["toolResult", "compaction"]) {
	test(`(plan 24) the reviewer launch excludes a model seen only in a ${kind}`, async (t) => {
		const h = harness({ entries: [E.assistant({ ms: BASE - 120_000, id: "a-m1", model: "claude-opus-5-5", provider: "anthropic-subscription" }), carrierLine(kind)] });
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		const a = h.auditor();
		h.request("m1");
		await h.prepare(a);
		assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");
	});
}

test("(plan 25) a compaction carrying usage without a model fails the queued audit as models-unknown without starting the runner or charging", async (t) => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
	const h = harness({
		entries: [
			E.assistant({ ms: BASE - 120_000, id: "a-m1", model: "claude-opus-5-5", provider: "anthropic-subscription" }),
			{ type: "compaction", id: "cmp-1", timestamp: new Date(BASE - 60_000).toISOString(), provider: "openai", usage },
		],
	});
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined);
});

test("a fresh task-keyed entry from another store cannot certify a queued child audit", async (t) => {
	const h = harness({ sessions: [] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const taskId = "st_shared";
	const index = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock });
	for (const sessionId of ["child-a", "child-b"]) {
		const cwd = path.join(h.root, sessionId);
		const file = writeTask(cwd, { task_id: taskId, child_session_id: sessionId, status: "completed" }, [
			E.assistant({ ms: BASE - 120_000, id: `a-${sessionId}`, model: "claude-opus-5-5", provider: "anthropic-subscription" }),
		]);
		appendEnded(h.paths, { sessionId, taskId, kind: "child", startedMs: BASE - 180_000, endedMs: BASE - 60_000, outcome: "completed", cwd });
		if (sessionId === "child-a") index.update(taskId, file, { kind: "child", taskId });
	}
	assert.equal(fresh(index.get(taskId)), true);
	assert.equal(index.has("child-b"), false);
	assert.ok(index.save(), "publish the colliding entry to the preparation worker");

	h.request("child-b");
	await h.prepare(h.auditor({ index }));
	const { status, reason } = h.record("child-b");
	assert.deepEqual([status, reason, h.runner.starts.length, h.budget()], ["failed", "models-unknown", 0, undefined]);
});

for (const incomplete of ["timeline", "index"]) {
	test(`(gate 14) the auditor refuses when only the ${incomplete} lost model identities`, async () => {
		const h = harness();
		indexed(h, "m1");
		if (incomplete === "index") {
			const file = h.paths.health.usageIndexFile;
			const [header, row] = fs.readFileSync(file, "utf8").split("\n");
			const entry = JSON.parse(row);
			entry.published.modelsIncomplete = true;
			fs.writeFileSync(file, `${header}\n${JSON.stringify(entry)}\n`);
		}
		const index = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock, log: silent });
		const a = h.auditor({ index, createWorker: probeWorker(incomplete) });
		h.request("m1");
		await h.prepare(a);
		assert.equal(h.record("m1").reason, "models-unknown");
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
	});
}

test("the auditor passes a 64 MiB total message scan budget", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const calls = [];
	const a = h.auditor({ createWorker: probeWorker("bounds", ({ options }) => calls.push(options)) });
	h.request("m1");
	await h.prepare(a);
	assert.deepEqual(calls.map((options) => options.messageScanTotalBytes), [64 * 1024 * 1024]);
});

test("preparing a file above timelineMaxBytes neither scans messages nor reads it through usageTimeline", async () => {
	const h = harness();
	const scans = [];
	const timelines = [];
	const seen = [];
	const deps = (limit) => ({
		timelineMaxBytes: limit,
		createWorker: probeWorker("scans", (reply) => {
			seen.push(reply.options);
			scans.push(...reply.scans);
			timelines.push(...reply.timelines);
		}),
	});
	const a = h.auditor(deps(10));
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.deepEqual(scans, []);
	assert.deepEqual(timelines, []);
	assert.equal(seen[0].messageScanMaxBytes, 10);
	assert.equal(seen[0].descendantScanMax, 50);

	const b = h.auditor(deps(256 * 1024 * 1024));
	h.request("m1");
	await h.prepare(b);
	assert.equal(scans.length, 1, "under the limit the same spies are called");
	assert.equal(timelines.length, 1);
	assert.equal(timelines[0][1].maxFileBytes, 256 * 1024 * 1024 - fs.statSync(h.files.m1).size, "the header probe reduces the timeline allowance");
});

test("a job the runner no longer knows is adopted before it ends no-job; the second waits meanwhile", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "failed", reason: "no-job", result: null, exitCode: null } : RUNNING);
	h.runner.adopt = () => "running";
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.runner.adopts.length, 1);
	h.tick(a);
	assert.equal(h.runner.starts.length, 1, "while adoptJob returns running the second waits");
	h.runner.adopt = () => "absent";
	h.tick(a);
	assert.equal(h.record("m1").reason, "no-job");
	assert.ok(Number.isFinite(h.record("m1").finishedMs));
	assert.equal(h.runner.starts.length, 1);
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 2);
});

test("IS-10 missing meta: a throwing adoption lookup keeps the record running and warns after the deadline", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.config.audit.timeoutMs = 2 * POLL;
	let lookupUnavailable = true;
	let lookups = 0;
	const recording = createRecordingSpawn();
	const runner = createRunner({
		paths: h.paths, clock: h.clock, env: {},
		spawnImpl: recording.spawnImpl,
		isAlive: () => lookupUnavailable,
		identify: () => ({ ctimeMs: BASE, cmdSha1: "audit-job" }),
		findJobProcess() {
			lookups++;
			if (lookupUnavailable) throw new Error("cim down");
			return null;
		},
	});
	const a = h.auditor({ runner });
	const kills = () => recording.calls.filter(({ command }) => command === "taskkill");
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	const { jobId, startedMs } = h.record("m1");
	const deadlineMs = startedMs + h.config.audit.timeoutMs;
	fs.unlinkSync(path.join(runner.jobDir(jobId), "meta.json"));
	h.tick(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(a.busy(), true);
	assert.equal(lookups, 1);
	assert.equal(h.record("m1").terminationUnconfirmed, undefined);
	h.tick(a);
	assert.equal(h.state.now, deadlineMs);
	assert.equal(h.record("m1").terminationUnconfirmed, undefined, "the deadline has not passed yet");
	h.tick(a);
	assert.equal(lookups, 3);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m2").status, "queued");
	assert.equal(recording.calls.length, 1, "only the first audit has spawned");
	assert.deepEqual(kills(), [], "no kill may use an unverified identity");
	assert.deepEqual([h.record("m1").terminationUnconfirmed, h.record("m1").deadlineMs], [true, deadlineMs]);

	lookupUnavailable = false;
	h.tick(a);
	const finished = h.record("m1");
	assert.deepEqual([finished.status, finished.reason, finished.terminationUnconfirmed, finished.deadlineMs],
		["failed", "no-job", undefined, undefined]);
	assert.deepEqual(kills(), []);
	assert.equal(h.record("m2").status, "queued");
	await h.prepare(a);
	assert.equal(h.record("m2").status, "running");
});

test("an expired request ends failed expired and starts nothing", () => {
	const h = harness();
	const a = h.auditor();
	requestAudit(h.paths, "m1", BASE - REQUEST_TTL_MS - 1);
	h.tick(a);
	assert.equal(h.record("m1").reason, "expired");
	assert.equal(h.record("m1").status, "failed");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false);
});

test("an invalid request file is deleted", () => {
	const h = harness();
	const a = h.auditor();
	fs.mkdirSync(h.paths.health.auditRequestsDir, { recursive: true });
	const bad = [
		["x.json", "not json"],
		["m1.json", JSON.stringify({ v: 1, sessionId: "m2", requestedMs: BASE })],
		["..%2f.json", JSON.stringify({ v: 1, sessionId: "../x", requestedMs: BASE })],
		["m3.json", JSON.stringify({ v: 2, sessionId: "m3", requestedMs: BASE })],
	];
	for (const [name, text] of bad) fs.writeFileSync(path.join(h.paths.health.auditRequestsDir, name), text);
	h.tick(a);
	assert.deepEqual(fs.readdirSync(h.paths.health.auditRequestsDir), []);
	assert.equal(a.busy(), false);
});

test("a duplicate request while running is deleted and keeps the original job", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	const jobId = h.record("m1").jobId;
	h.request("m1");
	h.tick(a);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false);
	assert.equal(h.record("m1").jobId, jobId);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("a failed first kill is retried by the restarted daemon, and the second audit waits until alive turns false", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "timeout", result: null, exitCode: null } : RUNNING);
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	h.tick(a);
	h.tick(a);
	assert.equal(h.runner.terminates.length, 1, "the first taskkill was sent and failed; alive stays true");
	const recordFile = path.join(h.paths.health.auditsDir, "m1.json");
	const { terminationUnconfirmed, deadlineMs, ...record } = h.record("m1");
	fs.writeFileSync(recordFile, JSON.stringify({ ...record, status: "failed", reason: "timeout", finishedMs: h.state.now }));
	await a.close();
	const b = h.auditor();
	assert.equal(h.record("m1").holdUntilExit, true);
	assert.deepEqual([h.record("m1").status, h.record("m1").terminationUnconfirmed], ["running", true]);
	h.state.now += 1_000;
	b.tick(h.state.now);
	assert.equal(h.runner.terminates.length, 2, "the new auditor terminates again on its first poll");
	assert.equal(h.runner.starts.length, 1);
	alive.value = false;
	h.tick(b);
	assert.equal(h.runner.starts.length, 1);
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2);
});

test("a retry request during a timeout hold is deleted across a restart, and is accepted only once alive is false", async () => {
	const h = harness();
	const alive = aliveFlag(h);
	h.runner.script = () => ({ status: "timeout", result: null, exitCode: null });
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	h.tick(a);
	const jobId = h.record("m1").jobId;
	h.request("m1");
	h.tick(a);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false);
	const b = h.auditor();
	h.tick(b);
	assert.deepEqual([h.record("m1").jobId, h.record("m1").holdUntilExit], [jobId, true]);
	assert.equal(h.runner.starts.length, 1);
	alive.value = false;
	h.tick(b);
	assert.equal(h.record("m1").holdUntilExit, undefined);
	h.runner.script = () => DONE;
	h.request("m1");
	await h.prepare(b);
	assert.equal(h.runner.starts.length, 2, "a new request is accepted after the exit");
});

test("a duplicate request while launching with adoptJob throwing is deleted: same jobId, no second start, no second charge", async () => {
	const h = harness();
	h.request("m1");
	await crashAfterStart(h, { writeMeta: false });
	h.runner.adopt = () => {
		throw new Error("cim down");
	};
	const b = h.auditor();
	const jobId = h.record("m1").jobId;
	h.request("m1");
	h.tick(b);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false);
	assert.equal(h.record("m1").jobId, jobId);
	assert.equal(h.record("m1").status, "launching");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("two sessions run one after the other", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.record("m2").status, "queued");
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1);
	await h.prepare(a);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
	h.tick(a);
	assert.equal(h.record("m2").status, "done");
	assert.equal(h.budget().count, 2);
});

test("disabled, not-found and no-model end failed without a charge", async () => {
	const off = harness();
	off.config.audit.enabled = false;
	const a = off.auditor();
	off.request("m1");
	off.tick(a);
	assert.equal(off.record("m1").reason, "disabled");

	const none = harness();
	const b = none.auditor();
	none.request("ghost");
	await none.prepare(b);
	assert.equal(none.record("ghost").reason, "not-found");

	const solo = harness({ providers: ["anthropic-subscription"] });
	const c = solo.auditor();
	solo.request("m1");
	await solo.prepare(c);
	assert.equal(solo.record("m1").reason, "no-model");
	for (const x of [off, none, solo]) {
		assert.equal(x.runner.starts.length, 0);
		assert.equal(x.budget(), undefined);
	}
});

test("a spent daily budget ends cap", async () => {
	const h = harness();
	h.config.audit.perDay = 1;
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	h.tick(a);
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.record("m1").reason, "cap");
	assert.equal(h.runner.starts.length, 1);
});

test("bad output ends bad-output with the head of out.txt in the detail", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	const jobId = h.record("m1").jobId;
	fs.writeFileSync(path.join(h.paths.health.jobsDir, jobId, "out.txt"), "not json at all");
	h.runner.script = () => ({ status: "done", result: null, exitCode: 0 });
	h.tick(a);
	const record = h.record("m1");
	assert.equal(record.reason, "bad-output");
	assert.equal(record.detail, "not json at all");
	assert.equal(a.busy(), false);
});

test("an unavailable provider and another runner failure end failed with their reason", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "unavailable", reason: "usage-limit", detail: "limit", result: null, exitCode: 1 } : { status: "failed", reason: "exit-3", detail: "boom", result: null, exitCode: 3 });
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	await h.prepare(a);
	h.tick(a);
	await h.prepare(a);
	h.tick(a);
	assert.equal(h.record("m1").reason, "unavailable:usage-limit");
	assert.equal(h.record("m2").reason, "exit-3");
});

test("ticks 10 s apart poll a running job once per 30 s", async () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a, 10_000);
	assert.equal(h.runner.polls.length, 0);
	h.tick(a, 10_000);
	h.tick(a, 10_000);
	assert.equal(h.runner.polls.length, 0, "20 s after the start");
	h.tick(a, 10_000);
	assert.equal(h.runner.polls.length, 1);
	h.tick(a, 10_000);
	h.tick(a, 10_000);
	assert.equal(h.runner.polls.length, 1);
	h.tick(a, 10_000);
	assert.equal(h.runner.polls.length, 2);
});

test("busy is true while queued, launching or running, and false after the end", async () => {
	const h = harness();
	const a = h.auditor();
	assert.equal(a.busy(), false);
	h.request("m1");
	await h.prepare(a);
	assert.equal(a.busy(), true);
	h.runner.script = () => DONE;
	h.tick(a);
	assert.equal(a.busy(), false);
});

test("auditsToday counts today's budget plus pending requests and ignores yesterday's file", () => {
	const h = harness();
	fs.mkdirSync(h.paths.health.auditsDir, { recursive: true });
	fs.writeFileSync(h.paths.health.auditBudgetFile, JSON.stringify({ day: "2026-11-19", count: 5, jobs: ["x"] }));
	assert.equal(auditsToday(h.paths, BASE), 0);
	fs.writeFileSync(h.paths.health.auditBudgetFile, JSON.stringify({ day: "2026-11-20", count: 2, jobs: ["a", "b"] }));
	assert.equal(auditsToday(h.paths, BASE), 2);
	requestAudit(h.paths, "m1", BASE);
	assert.equal(auditsToday(h.paths, BASE), 3);
});

test("finished records older than history.retentionDays are pruned once a day", async () => {
	const h = harness();
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	h.tick(a, 60 * DAY);
	assert.equal(h.record("m1").status, "done", "inside the retention window");
	h.tick(a, 31 * DAY);
	assert.equal(h.record("m1"), undefined);
});

test("a duplicate audit request cannot replace the first claim", (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const dir = h.paths.health.auditRequestsDir;
	const file = path.join(dir, "m1.json");
	const first = requestAudit(h.paths, "m1", BASE);
	const before = fs.readFileSync(file);
	const second = requestAudit(h.paths, "m1", BASE + 1);
	assert.deepEqual(fs.readFileSync(file), before, "the second call must leave the first claim unchanged");
	assert.deepEqual(first, { created: true, request: { v: 1, sessionId: "m1", requestedMs: BASE, claimId: first.request.claimId } });
	assert.match(first.request.claimId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.deepEqual(second, { created: false });
	assert.deepEqual(fs.readdirSync(dir), ["m1.json"]);
});

test("plan77: direct audit requests and daemon intake reject unsafe file stems", async (t) => {
	const h = harness({ sessions: [] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const { paths } = h;
	const directAccepted = [];
	for (const id of [".", "..", "../x", "a/b", "a\\b", "%2e%2e", "x.", "a\0b", "a\n", "x".repeat(81), "con", "nul.txt"]) {
		try {
			requestAudit(paths, id, BASE);
			directAccepted.push(id);
		} catch (error) {
			if (error.message !== "invalid session id") directAccepted.push(`${id}: ${error.code ?? error.message}`);
		}
	}
	const names = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	const directFiles = names(paths.health.auditRequestsDir);
	fs.mkdirSync(paths.health.auditRequestsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.auditRequestsDir, "injected..json"), JSON.stringify({ v: 1, sessionId: "injected.", requestedMs: BASE - REQUEST_TTL_MS - 1 }));
	const auditor = h.auditor();
	auditor.tick(BASE);
	assert.deepEqual({
		directAccepted, directFiles, pending: names(paths.health.auditRequestsDir),
		records: names(paths.health.auditsDir).filter((name) => name !== "requests"),
	}, { directAccepted: [], directFiles: [], pending: [], records: [] });
});

test("request helpers: safeSubjectId, the atomic request file and the state a request, a running record and a finished record show", async () => {
	const h = harness();
	assert.equal(safeSubjectId("abc-1.2_x"), "abc-1.2_x");
	for (const bad of ["", "../x", "a/b", "a b", "_budget", 5, null, "x".repeat(200)]) assert.equal(safeSubjectId(bad), null, String(bad));
	assert.throws(() => requestAudit(h.paths, "../x", BASE));
	assert.equal(readAuditState(h.paths, "m1"), null);
	const { request: { claimId } } = requestAudit(h.paths, "m1", BASE);
	assert.deepEqual(readJsonSafe(path.join(h.paths.health.auditRequestsDir, "m1.json")), { v: 1, sessionId: "m1", requestedMs: BASE, claimId });
	assert.equal(readAuditState(h.paths, "m1").status, "requested");
	const a = h.auditor();
	await h.prepare(a);
	assert.equal(readAuditState(h.paths, "m1").status, "running");
	h.runner.script = () => DONE;
	h.tick(a);
	assert.equal(readAuditState(h.paths, "m1").status, "done");
	requestAudit(h.paths, "m1", h.state.now);
	assert.equal(readAuditState(h.paths, "m1").status, "requested", "a rerun request shows before the daemon takes it");
});

test("IS-8: a config reload after audit preparation still hides current D4 thresholds", async (t) => {
	const h = harness();
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const initialWrite = h.config.tokens.cacheStormWrite;
	const thresholdsHash = detectorThresholdsHash(h.config);
	appendDecision(h.paths, { ts: new Date(BASE - 121_000).toISOString(), event: "config", result: "startup", thresholdsHash });
	appendDecision(h.paths, {
		ts: new Date(BASE - 120_000).toISOString(), event: "opened", fp: "cache-storm", detector: "D4",
		kind: "cache-storm", subject: { sessionId: "m1" }, evidence: ["cacheWrite:10000"],
	});
	const auditor = h.auditor();
	h.request("m1");
	h.tick(auditor);
	await auditor.preparing();
	h.config.tokens.cacheStormWrite = initialWrite + 1;
	appendDecision(h.paths, { ts: new Date(h.state.now - 1).toISOString(), event: "config", result: "applied", thresholdsHash: detectorThresholdsHash(h.config) });
	h.config.tokens.cacheStormWrite = initialWrite;
	appendDecision(h.paths, { ts: new Date(h.state.now).toISOString(), event: "config", result: "applied", thresholdsHash });
	auditor.tick(h.state.now);
	assert.equal(h.record("m1").status, "running");
	const document = fs.readFileSync(path.join(h.runner.starts[0].cwd, "bundle.md"), "utf8");
	const bundle = JSON.parse(document.split("\n").find((line) => line.startsWith('{"session":')));
	assert.deepEqual(bundle.omo_health_record.findings.map(({ detector, thresholdsKnown }) => [detector, thresholdsKnown]), [["D4", false]]);
	assert.doesNotMatch(document, /"cacheStormWrite":/);
});

test("two looks at one investigation exclude every analyst model through the production join and model choice", async () => {
	const h = harness();
	fs.mkdirSync(h.paths.health.investigationsDir, { recursive: true });
	fs.writeFileSync(
		path.join(h.paths.health.investigationsDir, "F1.json"),
		JSON.stringify({ id: "F1", openedMs: BASE - 300_000, updatedMs: BASE - 60_000, trigger: "stall", subject: { sessionId: "m1" }, status: "verdict", model: "openai/gpt-5-5", verdict: null }),
	);
	fs.mkdirSync(h.paths.health.decisionsDir, { recursive: true });
	appendJsonl(path.join(h.paths.health.decisionsDir, "2026-11-20.jsonl"), [
		{ ts: new Date(BASE - 290_000).toISOString(), fp: "F1", event: "investigation", status: "open" },
		{ ts: new Date(BASE - 240_000).toISOString(), fp: "F1", event: "investigation", status: "analyzing", model: "google/gemini-3-pro" },
	]);
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	assert.deepEqual([h.record("m1").model, h.record("m1").independence], ["xai/grok-5", "family"], "the first look's model is excluded too");
});

for (const source of ["recorded", "retained", "missing", "late", "late-missing"]) test(`IS-9 provenance: daemon checks ${source} analyst evidence before launching or charging`, async () => {
	const h = harness();
	const fp = "fallback-fp";
	const jobId = "analyst-fallback";
	const requested = "openai/other-analyst";
	const fallback = LANES.ultrabrain[0];
	const ts = new Date(BASE - 60_000).toISOString();
	const terminal = {
		ts, fp, jobId, event: "investigation", status: "verdict", analyst: { verdict: "act" },
		...(["recorded", "late"].includes(source) ? { usedModels: [requested, fallback] } : {}),
	};
	appendDecision(h.paths, { ts, fp, jobId, event: "investigation", status: "analyzing", subject: { sessionId: "m1" }, model: requested });
	if (source === "retained") {
		const dir = path.join(h.paths.health.jobsDir, jobId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "err.log"), `Model fallback: ${requested} -> ${fallback} (transient)\n`);
	}
	if (source.startsWith("late")) {
		await prepareWithFrozenRecord(h, () => appendDecision(h.paths, terminal));
	} else {
		appendDecision(h.paths, terminal);
		const a = h.auditor();
		h.request("m1");
		await h.prepare(a);
	}
	if (source.endsWith("missing")) {
		assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.runner.starts.length, h.budget()], ["failed", "analyst-models-unknown", 0, undefined]);
	} else {
		assert.equal(h.runner.starts.length, 1);
		assert.equal(modelOf(h.runner.starts[0]), LANES.architect[0]);
		assert.equal(h.budget().count, 1);
	}
});

test("IS-9 unfinished analyst run: daemon refuses without charge, then excludes the recorded fallback", async (t) => {
	for (const duringPreparation of [false, true]) {
		const h = harness({ providers: ["p"] });
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		fs.writeFileSync(h.paths.omoJsonc, JSON.stringify({ "[native]": { categories: {
			ultrabrain: { models: ["p/b"] }, architect: { models: ["p/c"] },
		} } }));
		const run = { ts: new Date(BASE).toISOString(), event: "investigation", fp: "current-fp", jobId: "analyst-current" };
		const start = () => {
			const dir = path.join(h.paths.health.jobsDir, run.jobId);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "err.log"), "Model fallback: p/a -> p/b\n");
			appendDecision(h.paths, { ...run, status: "analyzing", subject: { sessionId: "m1" }, model: "p/a" });
		};
		if (duringPreparation) await prepareWithFrozenRecord(h, start);
		else {
			start();
			const a = h.auditor();
			h.request("m1");
			await h.prepare(a);
		}
		assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.runner.starts.length, h.budget()],
			["failed", "analyst-models-unknown", 0, undefined], `analyzing row arrived during preparation: ${duringPreparation}`);
		appendDecision(h.paths, { ...run, status: "verdict", analyst: { verdict: "act" }, usedModels: ["p/a", "p/b"] });
		const a = h.auditor();
		h.request("m1");
		await h.prepare(a);
		assert.deepEqual(h.runner.starts.map(modelOf), ["p/c"]);
		assert.equal(h.budget().count, 1);
	}
});

test("IS-9 unknown session models take precedence over an unfinished analyst run in the daemon", async (t) => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
	const h = harness({ entries: [
		{ type: "compaction", id: "cmp-1", timestamp: new Date(BASE - 60_000).toISOString(), provider: "openai", usage },
	] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	appendDecision(h.paths, { ts: new Date(BASE).toISOString(), event: "investigation", fp: "current-fp", jobId: "analyst-current", status: "analyzing", subject: { sessionId: "m1" }, model: "openai/other-analyst" });
	h.request("m1");
	await h.prepare(h.auditor());
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.runner.starts.length, h.budget()],
		["failed", "models-unknown", 0, undefined]);
});

test("a decision-only fp's analyzing model is excluded from the daemon's model choice", async () => {
	const h = harness();
	assert.equal([...LANES.ultrabrain][0], "openai/gpt-5-5", "the analyst model is the first lane candidate");
	fs.mkdirSync(h.paths.health.decisionsDir, { recursive: true });
	appendJsonl(path.join(h.paths.health.decisionsDir, "2026-11-20.jsonl"), [
		{ ts: new Date(BASE - 290_000).toISOString(), fp: "F9", event: "opened", subject: { sessionId: "m1" } },
		{ ts: new Date(BASE - 240_000).toISOString(), fp: "F9", event: "investigation", status: "analyzing", model: "openai/gpt-5-5" },
	]);
	assert.equal(fs.existsSync(path.join(h.paths.health.investigationsDir, "F9.json")), false, "no investigation file exists for the fp");
	const a = h.auditor();
	h.request("m1");
	await h.prepare(a);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.record("m1").model, "google/gemini-3-pro", "the next lane candidate is chosen");
	assert.notEqual(modelOf(h.runner.starts[0]), "openai/gpt-5-5");
});

test("IS-9: audit fallback stderr rejects a valid verdict without refunding the job", async (t) => {
	const h = harness({ sessions: ["direct", "fallback"] });
	t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const recording = createRecordingSpawn();
	const runner = createRunner({ paths: h.paths, spawnImpl: recording.spawnImpl, clock: h.clock, env: {}, isAlive: () => true, identify: () => null, findJobProcess: () => null });
	const auditor = h.auditor({ runner });
	const jobs = [];
	for (const id of ["direct", "fallback"]) {
		h.request(id);
		await h.prepare(auditor);
		const { jobId, status } = h.record(id);
		assert.equal(status, "running");
		jobs.push(jobId);
		const dir = runner.jobDir(jobId);
		fs.writeFileSync(path.join(dir, "out.txt"), JSON.stringify(TOKEN_ONLY_ANSWER));
		fs.writeFileSync(path.join(dir, "err.log"), id === "fallback"
			? "diagnostic\r\nModel fallback: p/reviewer -> p/audited (provider refused)\r\n"
			: "Model fallback exhausted: p/reviewer (no candidates)\nModel fallback reverted: p/other -> p/reviewer\n");
		fs.writeFileSync(path.join(dir, "exit.json"), '{"code":0}');
		h.tick(auditor);
	}
	const direct = h.record("direct");
	assert.equal(direct.status, "done");
	assert.deepEqual(direct.result, TOKEN_ONLY_ANSWER);
	const rejected = readAuditState(h.paths, "fallback");
	assert.deepEqual([rejected.status, rejected.reason, rejected.result], ["failed", "model-fallback", null]);
	assert.equal(rejected.reasonKo, "선택한 검토 모델이 다른 모델로 전환되어 답을 사용하지 않았습니다");
	assert.deepEqual(readJsonSafe(path.join(runner.jobDir(jobs[1]), "meta.json")).final,
		{ status: "failed", reason: "model-fallback", result: null, exitCode: 0 });
	assert.equal(h.budget().count, 2);
	assert.deepEqual(h.budget().jobs, jobs);
	assert.equal(h.budget().refunded, undefined);
});

test("IS-10 launching: overdue adoption failures warn without killing or releasing the slot", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.config.audit.timeoutMs = 60_000;
	const recording = createRecordingSpawn();
	const identity = { ctimeMs: BASE, cmdSha1: "audit-job" };
	let lookupFails = true;
	let lookups = 0;
	const runner = createRunner({
		paths: h.paths, clock: h.clock, env: {}, spawnImpl: recording.spawnImpl,
		isAlive: () => true,
		identify: () => identity,
		findJobProcess() {
			lookups++;
			if (lookupFails) throw new Error("cim down");
			return { pid: 70000, ...identity };
		},
	});
	const initial = h.auditor({ runner, afterStart() { throw new Error("crash"); } });
	h.request("m1");
	await assert.rejects(h.prepare(initial), /crash/);
	await initial.close();
	const { jobId, launchMs } = h.record("m1");
	const metaFile = path.join(runner.jobDir(jobId), "meta.json");
	fs.unlinkSync(metaFile); // Model the crash window where no runner metadata survived.
	const deadlineMs = launchMs + h.config.audit.timeoutMs;
	const restarted = h.auditor({ runner });
	h.request("m2");
	h.tick(restarted, deadlineMs - h.state.now);
	assert.equal(h.record("m1").terminationUnconfirmed, undefined, "not overdue at the deadline");
	for (let i = 0; i < 3; i++) {
		h.tick(restarted, POLL);
		assert.equal(h.record("m1").status, "launching");
		assert.equal(h.record("m2").status, "queued");
		assert.equal(fs.existsSync(metaFile), false);
		assert.equal(recording.calls.length, 1, "only the original launch; no taskkill or second start");
	}
	assert.equal(lookups, 5, "startup and each tick retry adoption");
	assert.deepEqual([h.record("m1").terminationUnconfirmed, h.record("m1").deadlineMs], [true, deadlineMs]);

	await restarted.close();
	lookupFails = false;
	const recovered = h.auditor({ runner });
	assert.deepEqual([h.record("m1").status, h.record("m1").terminationUnconfirmed, h.record("m1").deadlineMs],
		["running", undefined, undefined], "successful adoption clears the launching warning before the next poll");
	h.tick(recovered);
	assert.deepEqual(recording.calls.slice(1).map(({ command, args }) => [command, args]),
		[["taskkill", ["/F", "/T", "/PID", "70000"]]], "normal timeout handling only kills once identity is verified");
	assert.equal(h.record("m2").status, "queued");
});

test("IS-10 unconfirmed: overdue identity failures are recorded while the next audit waits", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.config.audit.timeoutMs = 60_000;
	const identity = { ctimeMs: BASE - 1_000, cmdSha1: "audit-job" };
	let failLookup = false;
	let alive = true;
	let lookups = 0;
	const recording = createRecordingSpawn();
	const runner = createRunner({
		paths: h.paths, clock: h.clock, env: {},
		spawnImpl(command, args, options) {
			if (command === "taskkill") alive = false;
			return recording.spawnImpl(command, args, options);
		},
		isAlive: () => alive,
		identify() {
			lookups++;
			if (failLookup) throw new Error("identity lookup failed");
			return alive ? identity : null;
		},
		findJobProcess: () => null,
	});
	const a = h.auditor({ runner });
	const kills = () => recording.calls.filter(({ command }) => command === "taskkill").map(({ args }) => args);
	h.request("m1");
	await h.prepare(a);
	const { startedMs } = h.record("m1");
	const deadlineMs = startedMs + h.config.audit.timeoutMs;
	failLookup = true;
	h.tick(a, POLL);
	assert.equal(h.record("m1").terminationUnconfirmed, undefined, "a lookup error before the deadline is not overdue");
	h.request("m2");
	const beforeOverduePolls = lookups;
	for (let i = 0; i < 5; i++) {
		h.tick(a, POLL);
		assert.equal(h.record("m1").status, "running");
		assert.equal(h.record("m2").status, "queued");
		assert.deepEqual(kills(), [], "no kill may use an unverified identity");
	}
	assert.equal(lookups - beforeOverduePolls, 5);
	assert.equal(h.budget().count, 1);
	assert.deepEqual(
		[h.record("m1").terminationUnconfirmed, h.record("m1").deadlineMs],
		[true, deadlineMs],
	);

	failLookup = false;
	h.tick(a);
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "70000"]]);
	h.tick(a);
	const finished = h.record("m1");
	assert.deepEqual(
		[finished.status, finished.reason, finished.terminationUnconfirmed, finished.deadlineMs, finished.holdUntilExit],
		["failed", "timeout", undefined, undefined, undefined],
	);
	assert.deepEqual(kills(), [["/F", "/T", "/PID", "70000"]]);
	assert.equal(h.record("m2").status, "queued");
	await h.prepare(a);
	assert.equal(h.record("m2").status, "running");
	assert.equal(h.budget().count, 2);
});

test("a failed first kill is retried by the real runner and the one-per-PC slot stays held until the verified pid is gone", async () => {
	const h = harness();
	h.config.audit.timeoutMs = 60_000;
	const identity = { ctimeMs: BASE - 1_000, cmdSha1: "audit-job" };
	const processState = { alive: true };
	const recording = createRecordingSpawn();
	const runner = createRunner({ paths: h.paths, spawnImpl: recording.spawnImpl, clock: h.clock, env: {}, isAlive: () => processState.alive, identify: () => (processState.alive ? identity : null), findJobProcess: () => null });
	const a = createAuditor({ paths: h.paths, config: h.config, clock: h.clock, log: silent, runner, env: {} });
	const kills = () => recording.calls.filter((call) => call.command === "taskkill").length;
	h.request("m1");
	await h.prepare(a);
	h.state.now += 61_000;
	a.tick(h.state.now);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.record("m1").terminationUnconfirmed], ["running", null, true]);
	assert.equal(kills(), 1, "the timeout path sent the first taskkill");
	h.tick(a, 30_000);
	assert.equal(h.record("m1").terminationUnconfirmed, true, "a failed first kill keeps exit unconfirmed while the verified process lives");
	assert.equal(a.busy(), true);
	assert.equal(kills(), 2, "the kill is retried");
	processState.alive = false;
	h.tick(a, 30_000);
	assert.equal(h.record("m1").holdUntilExit, undefined);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason], ["failed", "timeout"]);
	assert.equal(a.busy(), false);
});

test("IS-10 transition: a restarted daemon rejects POST until the overdue audit exits", async (t) => {
	const id = "main-audit";
	const h = harness({ sessions: [id] });
	h.config.audit.timeoutMs = 60_000;
	let alive = true;
	let taskkill;
	const identity = { ctimeMs: BASE, cmdSha1: "launcher" };
	const recording = createRecordingSpawn();
	const newRunner = () => createRunner({
		paths: h.paths, clock: h.clock, env: {},
		isAlive: () => alive, identify: () => alive ? identity : null, findJobProcess: () => null,
		spawnImpl(command, args, options) {
			const child = recording.spawnImpl(command, args, options);
			if (command === "taskkill") taskkill = child;
			return child;
		},
	});
	const first = h.auditor({ runner: newRunner() });
	h.request(id);
	await h.prepare(first);
	const { jobId, startedMs } = h.record(id);
	const deadlineMs = startedMs + h.config.audit.timeoutMs;
	h.tick(first, h.config.audit.timeoutMs + 1);
	taskkill.emit("exit", 1, null);
	const beforeRestart = h.record(id);
	await first.close();
	const restarted = h.auditor({ runner: newRunner() });
	h.tick(restarted);
	const during = h.record(id);
	fs.writeFileSync(h.paths.health.daemonJson, JSON.stringify({ ts: h.clock.now(), pid: process.pid }));
	const prepare = createDetailOperations({
		paths: h.paths, env: {}, load: () => ({ found: true, session: { sessionId: id } }),
	});
	const token = "audit-test-token";
	const ui = createUiServer({
		paths: h.paths, token, getState: () => ({}), now: h.clock.now,
		startAudit: (id) => prepare({ kind: "audit", id, now: h.clock.now() }),
	});
	t.after(() => ui.close());
	const { port } = await ui.listen();
	const response = await fetch(`http://127.0.0.1:${port}/api/audit`, {
		method: "POST", headers: { "x-omo-health-token": token, "content-type": "application/json" },
		body: JSON.stringify({ sessionId: id }),
	});
	assert.deepEqual([response.status, (await response.json()).error], [409, "running"]);
	assert.equal(restarted.busy(), true);
	for (const record of [beforeRestart, during]) {
		assert.deepEqual([record.jobId, record.status, record.terminationUnconfirmed, record.deadlineMs, record.finishedMs],
			[jobId, "running", true, deadlineMs, null]);
	}
	assert.equal(recording.calls.filter(({ command }) => command === "taskkill").length, 2);
	alive = false;
	h.tick(restarted);
	const finished = h.record(id);
	assert.deepEqual([finished.status, finished.reason, finished.terminationUnconfirmed, finished.holdUntilExit],
		["failed", "timeout", undefined, undefined]);
	assert.equal(restarted.busy(), false);
});

test("IS-10 retry: a restarted auditor retries the adopted child and charges the next audit only after confirmed exit", async () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.config.audit.timeoutMs = 60_000;
	const launcher = { ctimeMs: BASE, cmdSha1: "launcher" };
	const child = { pid: 71000, ctimeMs: 0, cmdSha1: "model-child" };
	let launcherAlive = true;
	let childAlive = true;
	let taskkill;
	const recording = createRecordingSpawn();
	const newRunner = () => createRunner({
		paths: h.paths, clock: h.clock, env: {},
		spawnImpl(command, args, options) {
			const proc = recording.spawnImpl(command, args, options);
			if (command === "taskkill") taskkill = proc;
			return proc;
		},
		isAlive: (pid) => pid === 70000 ? launcherAlive : pid !== child.pid || childAlive,
		identify: (pid) => pid === child.pid ? (childAlive ? child : null) : pid === 70000 && !launcherAlive ? null : launcher,
		findJobProcess: () => childAlive ? child : null,
	});
	const runner = newRunner();
	const a = h.auditor({ runner });
	const starts = () => recording.calls.filter(({ command }) => command !== "taskkill").length;
	const kills = () => recording.calls.filter(({ command }) => command === "taskkill").map(({ args }) => args);
	const ownTree = ["/F", "/T", "/PID", String(child.pid)];
	h.request("m1");
	await h.prepare(a);
	const { jobId, startedMs } = h.record("m1");
	child.ctimeMs = startedMs + 1;
	const meta = () => readJsonSafe(path.join(runner.jobDir(jobId), "meta.json"));
	launcherAlive = false;
	fs.writeFileSync(path.join(runner.jobDir(jobId), "exit.json"), '{"code":0}');
	h.request("m2");
	h.tick(a, h.config.audit.timeoutMs + 1);
	assert.deepEqual(kills(), [ownTree]);
	taskkill.emit("exit", 1, null);
	assert.equal(meta().adopted, true);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m1").terminationUnconfirmed, true);
	assert.equal(h.record("m2").status, "queued");
	assert.deepEqual(h.budget().jobs, [jobId]);
	assert.equal(h.budget().count, 1);
	await a.close();

	const restarted = h.auditor({ runner: newRunner() });
	h.tick(restarted);
	assert.deepEqual(kills(), [ownTree, ownTree], "the first post-restart poll must retry the failed kill");
	assert.equal(meta().adoptedTerminationAttempts, 2, "the attempt count survives restart");
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.record("m1").terminationUnconfirmed, true);
	assert.equal(h.record("m2").status, "queued");
	assert.equal(starts(), 1);
	assert.equal(h.budget().count, 1);

	taskkill.emit("exit", 0, null);
	childAlive = false;
	h.tick(restarted);
	assert.deepEqual(kills(), [ownTree, ownTree]);
	assert.equal(meta().final.exitConfirmed, true);
	assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.record("m1").holdUntilExit],
		["failed", "timeout", undefined]);
	assert.equal(h.record("m2").status, "queued");
	assert.equal(starts(), 1);
	await h.prepare(restarted);
	const second = h.record("m2");
	assert.equal(second.status, "running");
	assert.equal(starts(), 2);
	assert.deepEqual(h.budget().jobs, [jobId, second.jobId]);
	assert.equal(h.budget().count, 2, "the queued audit added exactly one charge");
});

for (const timedOut of [true, false]) {
	test(`IS-10: a surviving model child blocks the next audit ${timedOut ? "after timeout" : "after launcher exit"}`, async (t) => {
		const h = harness({ sessions: ["m1", "m2"] });
		t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
		h.config.audit.timeoutMs = 60_000;
		const identity = { ctimeMs: BASE, cmdSha1: "launcher" };
		const modelChild = { pid: 71000, ctimeMs: BASE + 1, cmdSha1: "model-child" };
		let rootAlive = true;
		let childAlive = true;
		let failedLookup = false;
		const recording = createRecordingSpawn();
		const runner = createRunner({
			paths: h.paths, spawnImpl: recording.spawnImpl, clock: h.clock, env: {},
			isAlive: (pid) => pid !== 70000 || rootAlive,
			identify: (pid) => pid === modelChild.pid ? (childAlive ? modelChild : null) : rootAlive ? identity : null,
			findJobProcess: (jobId, args) => {
				assert.equal(jobId, h.record("m1").jobId);
				assert.deepEqual(args, recording.calls[0].args);
				if (failedLookup) throw new Error("CIM unavailable");
				return childAlive ? modelChild : null;
			},
		});
		const a = h.auditor({ runner });
		const starts = () => recording.calls.filter((call) => call.command !== "taskkill").length;
		h.request("m1");
		await h.prepare(a);
		const { jobId: firstJob } = h.record("m1");
		h.request("m2");
		if (timedOut) {
			h.tick(a, 61_000);
			assert.deepEqual([h.record("m1").status, h.record("m1").reason, h.record("m1").terminationUnconfirmed], ["running", null, true]);
		}
		rootAlive = false;
		fs.writeFileSync(path.join(runner.jobDir(firstJob), "exit.json"), '{"code":0}');
		h.tick(a);
		await h.prepare(a);
		assert.equal(starts(), 1, "the second audit must not launch alongside the model child");
		assert.equal(h.record("m2").status, "queued");
		assert.deepEqual(h.budget().jobs, [firstJob]);

		childAlive = false;
		failedLookup = true;
		h.tick(a);
		await h.prepare(a);
		assert.equal(h.record("m2").status, "queued", "a failed process lookup is not proof the child exited");
		assert.equal(starts(), 1);
		assert.equal(h.budget().count, 1);

		failedLookup = false;
		h.tick(a);
		if (timedOut) assert.deepEqual([h.record("m1").status, h.record("m1").reason], ["failed", "timeout"]);
		await h.prepare(a);
		assert.equal(starts(), 2);
		const second = h.record("m2");
		assert.equal(second.status, "running");
		assert.deepEqual(h.budget().jobs, [firstJob, second.jobId]);
		assert.equal(h.budget().count, 2, "the newly launched audit adds exactly one charge");
	});
}
