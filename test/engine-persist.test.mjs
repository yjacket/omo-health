import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { runDaemon } from "../src/daemon.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";
import { fakeProc, guardProcessListeners } from "./helpers/fake-proc.mjs";

guardProcessListeners();

const T0 = Date.parse("2026-09-28T10:00:00Z");
const HOUR = 3600_000;

function sandbox(prefix) {
	const root = tmpDir(prefix);
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	return paths;
}

const deadChild = makeFinding({
	detector: "D8",
	kind: "dead-child",
	humanNeeded: true,
	subject: { sessionId: "c1", taskId: "st_1", parentSessionId: "p1", rootSessionId: "p1" },
	titleKo: "서브에이전트 종료",
	data: { remedy: { kind: "wake-parent", reason: "dead-child" } },
});

/** One engine "process": the dead-child detector keeps firing; `align` stands in for D15 rate-limit memory. */
function engineAt(paths, start, { nudge = false } = {}) {
	let now = start;
	const decisions = [];
	const sent = [];
	const toasts = [];
	const seenAlign = [];
	const sessions = new Map([
		["c1", sessionState({ id: "c1", kind: "child", taskId: "st_1", parentSessionId: "p1", rootSessionId: "p1" })],
		["p1", sessionState({ id: "p1", kind: "main" })],
	]);
	const detectors = [
		{ name: "orphans", detect: () => [deadChild] },
		{
			name: "align",
			detect: (world, memory) => {
				if (nudge) {
					memory.lastNudgeMs = world.now;
					memory.countToday = (memory.countToday ?? 0) + 1;
					memory.day = "2026-09-28";
				}
				seenAlign.push({ ...memory });
				return [];
			},
		},
	];
	const engine = createEngine({
		paths,
		config: DEFAULT_CONFIG,
		mode: "auto",
		clock: { now: () => now },
		detectors,
		sources: {
			procs: { snapshot: async () => ({ takenAtMs: now, rows: [] }), os: async () => ({}), close() {} },
			registry: { refresh: () => ({ sessions, tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
			versions: () => ({ omoAi: "1.0.0", senpi: "1.0.0" }),
		},
		actors: {
			sensors: () => new Map([["p1", { sessionId: "p1", ts: now, idle: true }]]),
			send: (message) => (sent.push(message), `inbox/${message.id}`),
			decide: (entry) => decisions.push(entry),
			notifier: { toast: (t) => (toasts.push(t), { ok: true }) },
		},
		options: { noStatus: true, selfPid: 1 },
	});
	return { engine, decisions, sent, toasts, seenAlign, advance: (ms) => (now += ms) };
}

const wakes = (decisions) => decisions.filter((d) => d.action?.kind === "wake-parent" && d.result === "execute");

test("a restored engine plans no second wake for an open finding and keeps D15 memory", async () => {
	const paths = sandbox("omoh-persist-");
	const a = engineAt(paths, T0, { nudge: true });
	await a.engine.tick();
	assert.equal(wakes(a.decisions).length, 1, "engine A wakes the parent once");
	assert.equal(a.sent.length, 1);
	assert.equal(a.toasts.length, 1);
	a.advance(60_000);
	await a.engine.tick();
	assert.equal(wakes(a.decisions).length, 1, "no repeat within one process");

	const snapshot = JSON.parse(JSON.stringify(a.engine.snapshotState()));
	assert.equal(snapshot.v, 1);
	assert.equal(snapshot.savedMs, T0 + 60_000);
	const saved = snapshot.records.find((r) => r.fp === deadChild.fp);
	assert.ok(saved.executed.includes(`wake-parent:${deadChild.fp}:0`));
	assert.equal(saved.loggedOpen, true);
	assert.equal(saved.remedyDone, true);
	assert.deepEqual(saved.finding, { fp: deadChild.fp, detector: "D8", kind: "dead-child", severity: "warn", subject: deadChild.subject, titleKo: deadChild.titleKo });
	assert.ok(saved.history.length <= 10);
	assert.deepEqual(snapshot.memories.align, { lastNudgeMs: T0 + 60_000, countToday: 2, day: "2026-09-28" });

	// The daemon restarts five minutes later (e.g. after an update) and restores the snapshot.
	const b = engineAt(paths, T0 + 6 * 60_000);
	assert.equal(b.engine.restoreState(snapshot, T0 + 6 * 60_000), 1);
	await b.engine.tick();
	assert.equal(wakes(b.decisions).length, 0, "no second wake after the restart");
	assert.equal(b.sent.length, 0, "no second message reaches the parent");
	assert.equal(b.toasts.length, 0, "no second toast");
	assert.equal(b.decisions.filter((d) => d.event === "opened").length, 0, "the finding is not re-opened in the decision log");
	assert.deepEqual(b.seenAlign[0], { lastNudgeMs: T0 + 60_000, countToday: 2, day: "2026-09-28" }, "D15 memory survives the restart");
	assert.equal(b.engine.records.get(deadChild.fp).firstSeenMs, T0);
});

test("restore drops records older than 24 h and keeps recent ones", () => {
	const paths = sandbox("omoh-persist-age-");
	const now = T0 + 48 * HOUR;
	const finding = (fp) => ({ fp, detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: fp }, titleKo: fp });
	const record = (fp, extra) => ({ fp, firstSeenMs: now - 30 * HOUR, state: "open", executed: [`wake-parent:${fp}:0`], remedyDone: true, step: 0, judge: { calls: 0, nextMs: 0 }, loggedOpen: true, history: [], finding: finding(fp), ...extra });
	const snapshot = {
		v: 1,
		savedMs: now - 60_000,
		records: [
			record("old-resolved", { lastSeenMs: now - 26 * HOUR, resolvedMs: now - 25 * HOUR }),
			record("old-open", { lastSeenMs: now - 25 * HOUR }),
			record("recent-resolved", { lastSeenMs: now - 2 * HOUR, resolvedMs: now - HOUR }),
			record("recent-open", { lastSeenMs: now - 60_000 }),
		],
		memories: { align: {} },
	};
	const { engine } = engineAt(paths, now);
	assert.equal(engine.restoreState(snapshot, now), 2);
	assert.deepEqual([...engine.records.keys()].sort(), ["recent-open", "recent-resolved"]);
	assert.ok(engine.records.get("recent-open").executed.has("wake-parent:recent-open:0"));
	assert.equal(engine.restoreState({ v: 2, records: snapshot.records }, now), 0, "unknown snapshot versions are ignored");
});

test("daemon restores state.json at start and saves it again on exit", async () => {
	const paths = sandbox("omoh-persist-daemon-");
	fs.writeFileSync(paths.health.stateFile, JSON.stringify({ v: 1, savedMs: 1, records: [], memories: { align: { countToday: 3 } } }));
	let now = 1_000_000;
	const restored = [];
	const fakeEngine = () => ({
		async tick() {
			now += 60_000;
			return { findings: [] };
		},
		table: { all: () => [] },
		snapshotState: () => ({ v: 1, savedMs: now, records: [], memories: { align: { countToday: 4 } } }),
		restoreState: (snapshot, at) => (restored.push({ snapshot, at }), 0),
		close() {},
	});
	const config = { ...DEFAULT_CONFIG, idleExitMs: 90_000, tickMs: 1 };
	const result = await runDaemon({ proc: fakeProc(), paths, config, clock: { now: () => now }, overrides: { procs: { close() {}, restarts: 0 }, createEngine: fakeEngine, env: {} } });
	assert.equal(result.reason, "idle-no-omo-hosts");
	assert.equal(restored.length, 1);
	assert.deepEqual(restored[0], { snapshot: { v: 1, savedMs: 1, records: [], memories: { align: { countToday: 3 } } }, at: 1_000_000 });
	const written = JSON.parse(fs.readFileSync(paths.health.stateFile, "utf8"));
	assert.deepEqual(written, { v: 1, savedMs: now, records: [], memories: { align: { countToday: 4 } } });
});
