import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { composeScopeCheck } from "../src/act/messages.mjs";
import { createBudgetOffice } from "../src/budget/office.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import * as align from "../src/detect/align.mjs";
import * as budgetDetector from "../src/detect/budget.mjs";
import { createEngine, loadDetectors } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { E, iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";

const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SID = "main-0001";
const ACCOUNT = "anthropic-subscription/default";
const secs = (ms) => Math.trunc(ms / 1000);

function sources(clock, sessions) {
	return {
		procs: { snapshot: async () => ({ takenAtMs: clock.now(), rows: [] }), os: async () => ({}), ports: async () => [], close() {} },
		registry: { refresh: () => ({ sessions, tasks: [] }) },
		logs: { read() {}, drain: () => [], stats: new Map() },
		versions: () => ({ omoAi: "1.0.0", senpi: "1.0.0" }),
	};
}

/** An engine with the real budget office (in-memory DB) and the real D26 detector; one main session with a fresh sensor. */
function harness(t, { enabled = true, mode = "auto" } = {}) {
	const root = tmpDir("omoh-engine-budget-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(T0);
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const config = structuredClone(DEFAULT_CONFIG);
	config.budget.enabled = enabled;
	const runner = createFakeRunner();
	runner.jobDir = (jobId) => path.join(paths.health.jobsDir, jobId);
	const office = createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders: () => new Set() });
	const sessions = new Map([[SID, sessionState({ id: SID, kind: "main" })]]);
	const engine = createEngine({
		paths,
		config,
		mode,
		clock,
		detectors: [{ name: "budget", ...budgetDetector }],
		sources: sources(clock, sessions),
		actors: {
			budget: office,
			sensors: () => new Map([[SID, { sessionId: SID, ts: clock.now(), pid: 4242 }]]),
			notifier: { toast: () => ({ ok: true }) },
		},
		options: { selfPid: 1 },
	});
	return { root, paths, clock, config, engine, store: createBudgetStore(db) };
}

/** A goal session that spent $12 (>= estimateAfterUsd) and a 7-day window burning 10 %/h with 48 h left (short). */
function seed(h) {
	const cwd = path.join(h.root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const dir = path.join(h.paths.sessionsDir, "--proj--");
	const goalDir = path.join(dir, "extensions", "goal");
	fs.mkdirSync(goalDir, { recursive: true });
	fs.writeFileSync(path.join(goalDir, `${SID}.json`), JSON.stringify({ version: 1, goal: { status: "active", id: "g1", objective: "wire the budget office", createdAt: secs(T0 - 3 * HOUR), updatedAt: secs(T0 - 3 * HOUR) } }));
	writeJsonl(path.join(dir, `2026-11-10T00-00-00-000Z_${SID}.jsonl`), [
		E.header(SID, cwd, T0 - 3 * HOUR),
		E.assistant({ ms: T0 - 2 * HOUR, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 12 } }, text: "working" }),
	]);
	const resetsAtMs = T0 + 48 * HOUR;
	h.store.insertQuotaSamples([{ account: ACCOUNT, windowId: "claude:7d", updatedMs: T0 - 2 * HOUR, usedPercent: 60, resetsAtMs, windowMinutes: 10080 }]);
	fs.mkdirSync(path.dirname(h.paths.subscriptionUsageFile), { recursive: true });
	fs.writeFileSync(h.paths.subscriptionUsageFile, JSON.stringify({
		accounts: { [ACCOUNT]: { plan: "max", updatedAt: T0, nextAt: T0 + MIN, windows: [{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 80, resetsAt: iso(resetsAtMs) }] } },
	}));
}

function inboxMessages(paths, sessionId) {
	const dir = path.join(paths.health.inboxDir, sessionId);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

test("an engine tick with the budget on writes the snapshot, delivers the budget request to the inbox and raises D26 for a short window", async (t) => {
	const h = harness(t);
	seed(h);
	const result = await h.engine.tick();
	const snapshot = JSON.parse(fs.readFileSync(h.paths.health.budgetSnapshotFile, "utf8"));
	assert.equal(snapshot.enabled, true);
	assert.equal(snapshot.treasury.windows[0].state, "short");
	assert.equal(result.world.budget.updatedMs, T0, "the snapshot reaches the world the detectors read");
	const messages = inboxMessages(h.paths, SID);
	assert.deepEqual(messages.map((m) => m.details.actionKind), ["budget-request"]);
	assert.equal(messages[0].kind, "self-notice");
	assert.equal(messages[0].details.projectId, `${SID}:g1`);
	const short = result.findings.filter((f) => f.detector === "D26" && f.kind === "treasury-short");
	assert.equal(short.length, 1);
	assert.equal(short[0].humanNeeded, true);
	assert.equal(result.globalStatus.budget.state, "short");
	assert.equal(result.globalStatus.budget.windows.length, 1);

	// The next tick re-sends nothing already delivered.
	h.clock.advance(MIN);
	await h.engine.tick();
	assert.equal(inboxMessages(h.paths, SID).length, 1);
});

test("shadow mode writes the snapshot but delivers nothing", async (t) => {
	const h = harness(t, { mode: "shadow" });
	seed(h);
	const result = await h.engine.tick();
	assert.ok(fs.existsSync(h.paths.health.budgetSnapshotFile));
	assert.deepEqual(inboxMessages(h.paths, SID), []);
	assert.equal(result.findings.filter((f) => f.detector === "D26" && f.kind === "treasury-short").length, 1, "D26 still reads the shadow snapshot");
});

test("budget.enabled=false: no snapshot, no message, no D26, status budget null", async (t) => {
	const h = harness(t, { enabled: false });
	seed(h);
	const result = await h.engine.tick();
	assert.equal(fs.existsSync(h.paths.health.budgetSnapshotFile), false);
	assert.deepEqual(inboxMessages(h.paths, SID), []);
	assert.equal(result.world.budget, undefined);
	assert.deepEqual(result.findings.filter((f) => f.detector === "D26"), []);
	assert.equal(result.globalStatus.budget, null);
});

test("an engine without actors.budget has no budget key in its status (replay, scan)", async (t) => {
	const h = harness(t);
	const engine = createEngine({
		paths: h.paths,
		config: h.config,
		mode: "auto",
		clock: h.clock,
		detectors: [{ name: "budget", ...budgetDetector }],
		sources: sources(h.clock, new Map()),
		actors: { sensors: () => new Map() },
		options: { selfPid: 1, noStatus: true },
	});
	const result = await engine.tick();
	assert.equal("budget" in result.globalStatus, false);
	assert.equal(result.world.budget, undefined);
});

test("loadDetectors registers D26", async () => {
	const detectors = await loadDetectors();
	assert.ok(detectors.some((d) => d.name === "budget" && d.id === "D26"));
});

// D15 long-run handover (IS-12): exactly one owner of long goals.
const T = Date.parse("2026-09-28T12:00:00Z");
const alpha = (i) => String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));
/** 6 h 10 min of steady todo progress (steps 10 min apart): over the shipped longRun.activeMs, no other D15 signal. */
function longRunWorld(config) {
	const steps = Array.from({ length: 38 }, (_, i) => {
		const ms = T - (37 - i) * 10 * MIN;
		const kind = ["start", "eval", "done"][i % 3];
		return { ms, tool: kind === "eval" ? "eval" : "todo", kind, text: kind === "eval" ? `Work on ${alpha(i)}` : `Todo ${alpha(Math.floor(i / 3))}` };
	});
	const session = { id: "s1", kind: "main", firstUserText: "Build it", lastUser: { ms: T - 7 * HOUR, textHead: "Build it" },
		activity: { sinceMs: T - 7 * HOUR, mutations: 0, toolCalls: 0, files: new Map(), failingChecks: new Map(), taskSpawns: [] },
		anchor: { objective: "Build it", status: "active" }, healthMessages: [], writes: [], steps };
	return { now: T, config, sessions: new Map([[session.id, session]]), isSessionLive: () => true };
}

test("D15 long-run is not emitted with the shipped defaults (budget auditor on)", () => {
	assert.equal(DEFAULT_CONFIG.budget.enabled && DEFAULT_CONFIG.budget.audit.enabled, true);
	assert.deepEqual(align.detect(longRunWorld(DEFAULT_CONFIG), {}).filter((f) => f.data.signal === "long-run"), []);
});

test("D15 long-run is still emitted with the budget auditor off or the budget off, and its scope check has no undefined", () => {
	const auditOff = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, audit: { ...DEFAULT_CONFIG.budget.audit, enabled: false } } };
	const budgetOff = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, enabled: false } };
	for (const config of [auditOff, budgetOff]) {
		const [finding, ...rest] = align.detect(longRunWorld(config), {});
		assert.equal(rest.length, 0);
		assert.equal(finding.data.signal, "long-run");
		const message = composeScopeCheck({ finding, sessionId: "s1", now: T });
		assert.ok(!message.content.includes("undefined"), message.content);
		assert.match(message.content, /scope check \(long-run\): .*h of active work/);
	}
});
