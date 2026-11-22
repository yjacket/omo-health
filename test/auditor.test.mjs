import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AUDIT_CONTRACT, REQUEST_TTL_MS, auditsToday, createAuditor, readAuditState, requestAudit, safeAuditId } from "../src/auditor.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { usageTimeline } from "../src/collect/usage.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { GUARD_FLAGS } from "../src/judge/lane.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded, readEnded } from "../src/session-ledger.mjs";
import { loadSessionRecord } from "../src/session-record.mjs";
import { createRunner } from "../src/runner.mjs";
import { createUsageIndex, fresh } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { createRecordingSpawn } from "./fakes/runner.mjs";
import { readJsonSafe } from "../src/util/fsx.mjs";
import { E, appendJsonl, writeJsonl } from "./helpers/fixtures.mjs";

const BASE = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const POLL = 30_000;
const silent = { info() {}, warn() {}, error() {} };
const LANES = { ultrabrain: ["openai/gpt-5-5"], architect: ["google/gemini-3-pro"], "deep-high": ["xai/grok-5"] };
const ANSWER = {
	overall: "sound",
	summary: "토큰 사용과 점검이 모두 적절했습니다.",
	tokens: { judgment: "normal", explanation: "정상 범위입니다." },
	checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
	recommendations: [],
	confidence: 0.8,
};
const RUNNING = { status: "running", result: null, exitCode: null };
const DONE = { status: "done", result: ANSWER, exitCode: 0 };

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
	h.auditor = (extra = {}) => createAuditor({ paths, config, clock, log: silent, runner: h.runner, env: {}, ...extra });
	h.tick = (auditor, ms = POLL) => {
		state.now += ms;
		auditor.tick(state.now);
	};
	h.request = (id) => {
		const request = requestAudit(paths, id, state.now);
		state.now += 1;
		return request;
	};
	h.record = (id) => readJsonSafe(path.join(paths.health.auditsDir, `${id}.json`));
	h.budget = () => readJsonSafe(paths.health.auditBudgetFile);
	h.jobsOf = (id) => h.runner.starts.filter((start) => start.jobId.endsWith(`-${id}`));
	return h;
}

/** Start the oldest queued audit, then die right after the runner spawned it (before `running` is persisted). */
function crashAfterStart(h, { writeMeta = true } = {}) {
	h.runner.writeMeta = writeMeta;
	const first = h.auditor({
		afterStart: () => {
			throw new Error("crash");
		},
	});
	assert.throws(() => h.tick(first), /crash/);
	return first;
}

const modelOf = (start) => start.args[start.args.indexOf("--model") + 1];

test("a request becomes queued, then running with the marker, the guard flags and one charge, then done", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	assert.equal(a.busy(), false, "a request file alone is not read until a tick");
	h.tick(a);
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

test("a running job survives a daemon restart: one runner.start and one charge", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.runner.script = queue(RUNNING, RUNNING, DONE);
	h.tick(a);
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

test("a rerun charges again", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.runner.script = () => DONE;
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	h.request("m1");
	h.tick(a);
	assert.equal(h.runner.starts.length, 2);
	assert.equal(h.budget().count, 2);
	assert.notEqual(h.runner.starts[0].jobId, h.runner.starts[1].jobId);
});

test("dying right after the spawn leaves a launching record that the next auditor polls to done without a second start", () => {
	const h = harness();
	h.request("m1");
	crashAfterStart(h);
	assert.equal(h.record("m1").status, "launching");
	h.runner.script = () => DONE;
	const b = h.auditor();
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("dying inside the spawn (no meta.json) ends launch-uncertain without a second start", () => {
	const h = harness();
	h.request("m1");
	crashAfterStart(h, { writeMeta: false });
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

function twoSessionsCrashed() {
	const h = harness({ sessions: ["m1", "m2"] });
	h.request("m1");
	h.request("m2");
	crashAfterStart(h, { writeMeta: false });
	return h;
}

test("after that crash with a second audit queued: adoptJob running keeps the second waiting until the first ends", () => {
	const h = twoSessionsCrashed();
	h.runner.adopt = () => "running";
	h.runner.script = (jobId, n) => (jobId.endsWith("-m1") && n >= 1 ? DONE : RUNNING);
	const b = h.auditor();
	assert.equal(h.record("m1").status, "running");
	h.tick(b);
	assert.equal(h.runner.starts.length, 1, "the first is still running");
	h.tick(b);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1, "the slot was freed by the poll of this tick");
	h.tick(b);
	assert.equal(h.runner.starts.length, 2);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
});

test("after that crash: adoptJob absent frees the slot and the second starts on the next tick", () => {
	const h = twoSessionsCrashed();
	h.runner.adopt = () => "absent";
	const b = h.auditor();
	assert.equal(h.record("m1").reason, "launch-uncertain");
	assert.equal(h.runner.starts.length, 1);
	h.tick(b);
	assert.equal(h.runner.starts.length, 2);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
	assert.equal(h.runner.starts.filter((start) => start.jobId.endsWith("-m1")).length, 1, "the uncertain job is never restarted");
});

test("after that crash: a throwing adoptJob keeps the second waiting across ticks", () => {
	const h = twoSessionsCrashed();
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
	h.tick(b);
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

test("five failed lookups past the deadline, then timeout: the second audit starts only after alive turns false", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	const failedLookup = { status: "running", result: null, exitCode: null, detail: "job process lookup failed" };
	h.runner.script = (jobId, n) => (!jobId.endsWith("-m1") ? RUNNING : n < 5 ? failedLookup : { status: "timeout", result: null, exitCode: null });
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
	for (let i = 0; i < 5; i++) {
		h.tick(a);
		assert.equal(h.record("m1").status, "running");
		assert.equal(h.runner.starts.length, 1);
	}
	h.tick(a);
	assert.equal(h.record("m1").reason, "timeout");
	assert.equal(h.record("m1").holdUntilExit, true);
	for (let i = 0; i < 3; i++) {
		h.tick(a);
		assert.equal(h.runner.starts.length, 1, "alive: still held");
	}
	alive.value = false;
	h.tick(a);
	assert.equal(h.record("m1").holdUntilExit, undefined);
	assert.equal(h.runner.starts.length, 1, "alive turned false on this tick; the next one starts");
	h.tick(a);
	assert.equal(h.runner.starts.length, 2);
});

test("a timeout holds the slot while alive is true, retries terminate on every poll, and survives a failed lookup", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "timeout", result: null, exitCode: null } : RUNNING);
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").reason, "timeout");
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
	assert.equal(h.runner.starts.length, 1);
	h.tick(a);
	assert.equal(h.runner.starts.length, 2);
});

test("a launching record whose meta.json has ctimeMs null is polled through the runner, and a second audit waits for its end", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.request("m1");
	h.request("m2");
	crashAfterStart(h);
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
	h.tick(b);
	assert.equal(h.runner.starts.length, 2);
});

test("a pre-spawn throw (spawned:false) refunds the charge and ends spawn-error", () => {
	const h = harness();
	h.runner.startError = Object.assign(new Error("EACCES"), { spawned: false });
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	const record = h.record("m1");
	assert.equal(record.status, "failed");
	assert.equal(record.reason, "spawn-error");
	assert.equal(record.detail, "EACCES");
	assert.deepEqual(h.budget(), { day: "2026-11-20", count: 0, jobs: [] });
	assert.equal(a.busy(), false);
});

test("a post-spawn meta write failure keeps the charge and the launching record; the second waits for adoptJob", () => {
	for (const adopted of ["running", "absent"]) {
		const h = harness({ sessions: ["m1", "m2"] });
		h.runner.startError = Object.assign(new Error("EPERM meta"), { spawned: true, pid: 77 });
		const a = h.auditor();
		h.request("m1");
		h.request("m2");
		h.tick(a);
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
		h.tick(a);
		assert.equal(h.runner.starts.length, 2);
		assert.equal(h.budget().count, 2);
	}
});

test("a same-length rewrite is no longer fresh, queueLedger requeues it, and the audit refuses with models-unknown until the recount", () => {
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

	const a = h.auditor({ timelineMaxBytes: 1 });
	h.request("m1");
	h.tick(a);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined, "nothing is charged");

	tracker.tick({});
	index.save();
	assert.equal(fresh(index.get("m1")), true);
	assert.equal(index.get("m1").published.total, usageTimeline(file).totals.total, "the recount equals the oracle");
	assert.equal(index.get("m1").published.total, 25);
	h.request("m1");
	h.tick(a);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro", "gpt-5-5 is excluded after the recount");
});

test("evidence-too-large charges nothing and never starts", () => {
	const h = harness();
	const a = h.auditor({
		loadRecord: (options) => {
			const record = loadSessionRecord(options);
			return { ...record, tokens: { models: Array.from({ length: 3000 }, (_, i) => ({ key: `${"m".repeat(60)}${i}`, tokens: 1, cost: 0 })) } };
		},
	});
	h.request("m1");
	h.tick(a);
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

test("without a full timeline, an incomplete entry and a complete entry that is not at the end both end models-unknown without a charge", () => {
	const h = harness();
	const index = indexed(h, "m1", { maxBytes: 10 });
	assert.equal(index.get("m1").complete, false);
	appendJsonl(h.files.m1, [openaiLine()]);
	const small = fs.statSync(h.files.m1).size - 1;
	const a = h.auditor({ timelineMaxBytes: small });
	h.request("m1");
	h.tick(a);
	assert.equal(h.record("m1").reason, "models-unknown");

	indexed(h, "m1");
	appendJsonl(h.files.m1, [E.assistant({ ms: BASE - 20_000, id: "a-later", model: "gpt-5-5", provider: "openai" })]);
	const entry = createUsageIndex({ file: h.paths.health.usageIndexFile, clock: h.clock, log: silent }).get("m1");
	assert.equal(entry.complete, true);
	assert.equal(fresh(entry), false, "complete but not at the end");
	const b = h.auditor({ timelineMaxBytes: fs.statSync(h.files.m1).size - 1 });
	h.request("m1");
	h.tick(b);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.equal(h.runner.starts.length, 0);
	assert.equal(h.budget(), undefined);

	const c = h.auditor();
	h.request("m1");
	h.tick(c);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro", "with the timeline the unread suffix is seen and its model excluded");
});

test("a prewarm entry alone excludes the first candidate, a failed prewarm in an unread suffix too", () => {
	const h = harness({ entries: [E.assistant({ ms: BASE - 120_000, id: "a-1", model: "claude-opus-5-5", provider: "anthropic-subscription" }), prewarm("warmed")] });
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	assert.equal(modelOf(h.runner.starts[0]), "google/gemini-3-pro");

	const g = harness();
	indexed(g, "m1");
	appendJsonl(g.files.m1, [prewarm("failed")]);
	const entry = createUsageIndex({ file: g.paths.health.usageIndexFile, clock: g.clock, log: silent }).get("m1");
	assert.equal(fresh(entry), false);
	const b = g.auditor();
	g.request("m1");
	g.tick(b);
	assert.equal(modelOf(g.runner.starts[0]), "google/gemini-3-pro");
});

for (const incomplete of ["timeline", "index"]) {
	test(`(gate 14) the auditor refuses when only the ${incomplete} lost model identities`, () => {
		const h = harness();
		indexed(h, "m1");
		if (incomplete === "index") {
			const file = h.paths.health.usageIndexFile;
			const saved = JSON.parse(fs.readFileSync(file, "utf8"));
			saved.entries.m1.published.modelsIncomplete = true;
			fs.writeFileSync(file, JSON.stringify(saved));
		}
		const a = h.auditor({
			timeline: (...args) => {
				const full = usageTimeline(...args);
				if (incomplete === "timeline") full.totals.modelsIncomplete = true;
				return full;
			},
		});
		h.request("m1");
		h.tick(a);
		assert.equal(h.record("m1").reason, "models-unknown");
		assert.equal(h.runner.starts.length, 0);
		assert.equal(h.budget(), undefined);
	});
}

test("preparing a file above timelineMaxBytes neither scans messages nor reads it through usageTimeline", () => {
	const h = harness();
	const scans = [];
	const timelines = [];
	const seen = [];
	const deps = (limit) => ({
		timelineMaxBytes: limit,
		loadRecord: (options) => {
			seen.push(options);
			return loadSessionRecord({ ...options, scanMessages: (file) => (scans.push(file), []) });
		},
		timeline: (...args) => (timelines.push(args), usageTimeline(...args)),
	});
	const a = h.auditor(deps(10));
	h.request("m1");
	h.tick(a);
	assert.equal(h.record("m1").reason, "models-unknown");
	assert.deepEqual(scans, []);
	assert.deepEqual(timelines, []);
	assert.equal(seen[0].messageScanMaxBytes, 10);
	assert.equal(seen[0].descendantScanMax, 50);

	const b = h.auditor(deps(256 * 1024 * 1024));
	h.request("m1");
	h.tick(b);
	assert.equal(scans.length, 1, "under the limit the same spies are called");
	assert.equal(timelines.length, 1);
	assert.equal(timelines[0][1].maxFileBytes, 256 * 1024 * 1024);
});

test("a job the runner no longer knows is adopted before it ends no-job; the second waits meanwhile", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "failed", reason: "no-job", result: null, exitCode: null } : RUNNING);
	h.runner.adopt = () => "running";
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
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
	h.tick(a);
	assert.equal(h.runner.starts.length, 2);
});

test("a no-job answer with a throwing lookup keeps the record running", () => {
	const h = harness();
	h.runner.script = () => ({ status: "failed", reason: "no-job", result: null, exitCode: null });
	h.runner.adopt = () => {
		throw new Error("cim down");
	};
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "running");
	assert.equal(a.busy(), true);
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

test("a duplicate request while running is deleted and keeps the original job", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	const jobId = h.record("m1").jobId;
	h.request("m1");
	h.tick(a);
	assert.equal(fs.existsSync(path.join(h.paths.health.auditRequestsDir, "m1.json")), false);
	assert.equal(h.record("m1").jobId, jobId);
	assert.equal(h.record("m1").status, "running");
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.budget().count, 1);
});

test("a failed first kill is retried by the restarted daemon, and the second audit waits until alive turns false", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	const alive = aliveFlag(h);
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "timeout", result: null, exitCode: null } : RUNNING);
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
	h.tick(a);
	h.tick(a);
	assert.equal(h.runner.terminates.length, 1, "the first taskkill was sent and failed; alive stays true");
	const b = h.auditor();
	assert.equal(h.record("m1").holdUntilExit, true);
	h.state.now += 1_000;
	b.tick(h.state.now);
	assert.equal(h.runner.terminates.length, 2, "the new auditor terminates again on its first poll");
	assert.equal(h.runner.starts.length, 1);
	alive.value = false;
	h.tick(b);
	assert.equal(h.runner.starts.length, 1);
	h.tick(b);
	assert.equal(h.runner.starts.length, 2);
});

test("a retry request during a timeout hold is deleted across a restart, and is accepted only once alive is false", () => {
	const h = harness();
	const alive = aliveFlag(h);
	h.runner.script = () => ({ status: "timeout", result: null, exitCode: null });
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
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
	h.tick(b);
	assert.equal(h.runner.starts.length, 2, "a new request is accepted after the exit");
});

test("a duplicate request while launching with adoptJob throwing is deleted: same jobId, no second start, no second charge", () => {
	const h = harness();
	h.request("m1");
	crashAfterStart(h, { writeMeta: false });
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

test("two sessions run one after the other", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.record("m2").status, "queued");
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	assert.equal(h.runner.starts.length, 1);
	h.tick(a);
	assert.ok(h.runner.starts[1].jobId.endsWith("-m2"));
	h.tick(a);
	assert.equal(h.record("m2").status, "done");
	assert.equal(h.budget().count, 2);
});

test("disabled, not-found and no-model end failed without a charge", () => {
	const off = harness();
	off.config.audit.enabled = false;
	const a = off.auditor();
	off.request("m1");
	off.tick(a);
	assert.equal(off.record("m1").reason, "disabled");

	const none = harness();
	const b = none.auditor();
	none.request("ghost");
	none.tick(b);
	assert.equal(none.record("ghost").reason, "not-found");

	const solo = harness({ providers: ["anthropic-subscription"] });
	const c = solo.auditor();
	solo.request("m1");
	solo.tick(c);
	assert.equal(solo.record("m1").reason, "no-model");
	for (const x of [off, none, solo]) {
		assert.equal(x.runner.starts.length, 0);
		assert.equal(x.budget(), undefined);
	}
});

test("a spent daily budget ends cap", () => {
	const h = harness();
	h.config.audit.perDay = 1;
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	h.tick(a);
	h.request("m1");
	h.tick(a);
	assert.equal(h.record("m1").reason, "cap");
	assert.equal(h.runner.starts.length, 1);
});

test("bad output ends bad-output with the head of out.txt in the detail", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	const jobId = h.record("m1").jobId;
	fs.writeFileSync(path.join(h.paths.health.jobsDir, jobId, "out.txt"), "not json at all");
	h.runner.script = () => ({ status: "done", result: null, exitCode: 0 });
	h.tick(a);
	const record = h.record("m1");
	assert.equal(record.reason, "bad-output");
	assert.equal(record.detail, "not json at all");
	assert.equal(a.busy(), false);
});

test("an unavailable provider and another runner failure end failed with their reason", () => {
	const h = harness({ sessions: ["m1", "m2"] });
	h.runner.script = (jobId) => (jobId.endsWith("-m1") ? { status: "unavailable", reason: "usage-limit", detail: "limit", result: null, exitCode: 1 } : { status: "failed", reason: "exit-3", detail: "boom", result: null, exitCode: 3 });
	const a = h.auditor();
	h.request("m1");
	h.request("m2");
	h.tick(a);
	h.tick(a);
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").reason, "unavailable:usage-limit");
	assert.equal(h.record("m2").reason, "exit-3");
});

test("ticks 10 s apart poll a running job once per 30 s", () => {
	const h = harness();
	const a = h.auditor();
	h.request("m1");
	h.tick(a, 10_000);
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

test("busy is true while queued, launching or running, and false after the end", () => {
	const h = harness();
	const a = h.auditor();
	assert.equal(a.busy(), false);
	h.request("m1");
	h.tick(a);
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

test("finished records older than history.retentionDays are pruned once a day", () => {
	const h = harness();
	h.runner.script = () => DONE;
	const a = h.auditor();
	h.request("m1");
	h.tick(a);
	h.tick(a);
	assert.equal(h.record("m1").status, "done");
	h.tick(a, 60 * DAY);
	assert.equal(h.record("m1").status, "done", "inside the retention window");
	h.tick(a, 31 * DAY);
	assert.equal(h.record("m1"), undefined);
});

test("request helpers: safeAuditId, the atomic request file and the state a request, a running record and a finished record show", () => {
	const h = harness();
	assert.equal(safeAuditId("abc-1.2_x"), "abc-1.2_x");
	for (const bad of ["", "../x", "a/b", "a b", "_budget", 5, null, "x".repeat(200)]) assert.equal(safeAuditId(bad), null, String(bad));
	assert.throws(() => requestAudit(h.paths, "../x", BASE));
	assert.equal(readAuditState(h.paths, "m1"), null);
	requestAudit(h.paths, "m1", BASE);
	assert.deepEqual(readJsonSafe(path.join(h.paths.health.auditRequestsDir, "m1.json")), { v: 1, sessionId: "m1", requestedMs: BASE });
	assert.equal(readAuditState(h.paths, "m1").status, "requested");
	const a = h.auditor();
	h.tick(a);
	assert.equal(readAuditState(h.paths, "m1").status, "running");
	h.runner.script = () => DONE;
	h.tick(a);
	assert.equal(readAuditState(h.paths, "m1").status, "done");
	requestAudit(h.paths, "m1", h.state.now);
	assert.equal(readAuditState(h.paths, "m1").status, "requested", "a rerun request shows before the daemon takes it");
});

test("two looks at one investigation exclude every analyst model through the production join and model choice", () => {
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
	h.tick(a);
	assert.deepEqual([h.record("m1").model, h.record("m1").independence], ["xai/grok-5", "family"], "the first look's model is excluded too");
});

test("a decision-only fp's analyzing model is excluded from the daemon's model choice", () => {
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
	h.tick(a);
	assert.equal(h.runner.starts.length, 1);
	assert.equal(h.record("m1").model, "google/gemini-3-pro", "the next lane candidate is chosen");
	assert.notEqual(modelOf(h.runner.starts[0]), "openai/gpt-5-5");
});

test("a failed first kill is retried by the real runner and the one-per-PC slot stays held until the verified pid is gone", () => {
	const h = harness();
	h.config.audit.timeoutMs = 60_000;
	const identity = { ctimeMs: BASE - 1_000, cmdSha1: "audit-job" };
	const processState = { alive: true };
	const recording = createRecordingSpawn();
	const runner = createRunner({ paths: h.paths, spawnImpl: recording.spawnImpl, clock: h.clock, env: {}, isAlive: () => processState.alive, identify: () => (processState.alive ? identity : null) });
	const a = createAuditor({ paths: h.paths, config: h.config, clock: h.clock, log: silent, runner, env: {} });
	const kills = () => recording.calls.filter((call) => call.command === "taskkill").length;
	h.request("m1");
	h.tick(a);
	h.state.now += 61_000;
	a.tick(h.state.now);
	assert.deepEqual([h.record("m1").reason, h.record("m1").holdUntilExit], ["timeout", true]);
	assert.equal(kills(), 1, "the timeout path sent the first taskkill");
	h.tick(a, 30_000);
	assert.equal(h.record("m1").holdUntilExit, true, "a failed first kill keeps the slot while the verified process lives");
	assert.equal(kills(), 2, "the kill is retried");
	processState.alive = false;
	h.tick(a, 30_000);
	assert.equal(h.record("m1").holdUntilExit, undefined);
	assert.equal(a.busy(), false);
});
