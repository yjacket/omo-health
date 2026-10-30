import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createEngine } from "../src/engine.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { normalizeRows } from "../src/collect/procs.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock, iso } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";

const T0 = Date.parse("2026-10-10T10:00:00Z");

function runRecord({ runId = "dag_wait", name = "verify wave", status = "running", createdAt = T0, nodes } = {}) {
	return {
		runId,
		name,
		status,
		parentSessionId: "p1",
		rootSessionId: "p1",
		createdAt: iso(createdAt),
		updatedAt: iso(createdAt + 1000),
		nodes: nodes ?? [
			{ id: "a", state: "completed", attempt: 1, startedAt: iso(createdAt), completedAt: iso(createdAt + 1000) },
			{ id: "b", state: "completed", attempt: 1, startedAt: iso(createdAt), completedAt: iso(createdAt + 1000) },
			{ id: "c", state: "completed", attempt: 1, startedAt: iso(createdAt), completedAt: iso(createdAt + 1000) },
			{ id: "d", state: "running", attempt: 1, startedAt: iso(createdAt + 1000) },
			{ id: "e", state: "pending", attempt: 1 },
		],
	};
}

function harness({ wakeSources, runs = [], detectors = [] } = {}) {
	const root = tmpDir("omoh-waiting-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const cwd = path.join(root, "proj");
	const store = path.join(cwd, ".omo", "senpi-task");
	if (runs.length) {
		fs.mkdirSync(path.join(store, "dag", "runs"), { recursive: true });
		for (const run of runs) fs.writeFileSync(path.join(store, "dag", "runs", `${run.runId}.json`), JSON.stringify(run));
	}
	const clock = createFakeClock(T0 + 60_000);
	const session = sessionState({ id: "p1", kind: "main", cwd, hostPid: 7000, lastMessage: { role: "assistant", stopReason: "stop" } });
	const sessions = new Map([["p1", session]]);
	const sensors = () => new Map([["p1", { sessionId: "p1", pid: 7000, ts: clock.now(), idle: true, executingTools: 0, wakeSources }]]);
	const engine = createEngine({
		paths,
		config: { ...DEFAULT_CONFIG, procSnapshotMs: 20_000 },
		clock,
		mode: "shadow",
		detectors,
		sources: {
			procs: {
				async snapshot() {
					return { rows: normalizeRows([{ p: 7000, pp: 1, n: "node.exe", c: "2026-10-10T09:00:00Z", cl: "node cli.js" }]), takenAtMs: clock.now() };
				},
				async os() {
					return {};
				},
			},
			registry: { refresh: () => ({ sessions, tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
		},
		actors: { sensors, send: () => "inbox", notifier: { toast: () => ({ ok: true }) } },
		options: { selfPid: 999999 },
	});
	const readStatus = () => JSON.parse(fs.readFileSync(path.join(paths.health.statusDir, "p1.json"), "utf8"));
	return { engine, clock, paths, session, readStatus };
}

test("an idle main session waiting on a DAG shows DAG completed/total", async () => {
	const h = harness({ wakeSources: { "omo-dag": 1 }, runs: [runRecord()] });
	await h.engine.tick();
	const status = h.readStatus();
	assert.equal(status.level, "ok");
	assert.equal(status.text, "👀 DAG3/5");
	assert.deepEqual(status.waiting, { count: 1, dag: { completed: 3, total: 5, runId: "dag_wait", name: "verify wave" } });
});

test("a waiting session with only live task sources shows the live work count", async () => {
	const h = harness({ wakeSources: { "senpi-task": 2 } });
	await h.engine.tick();
	const status = h.readStatus();
	assert.equal(status.level, "ok");
	assert.equal(status.text, "👀 대기2");
	assert.deepEqual(status.waiting, { count: 2, dag: null });
});

test("a session waiting only on the human stays normal", async () => {
	const h = harness({ wakeSources: { "ask-user": 1 } });
	await h.engine.tick();
	const status = h.readStatus();
	assert.equal(status.level, "ok");
	assert.equal(status.text, "👀 정상");
	assert.equal(status.waiting, undefined);
});

test("a shown footer finding wins over the waiting state", async () => {
	const finding = makeFinding({
		detector: "D8",
		kind: "dead-child",
		severity: "warn",
		subject: { sessionId: "p1", key: "dead" },
		evidence: ["dead"],
		titleKo: "서브에이전트 멈춤",
		detailKo: "detail",
		humanNeeded: true,
	});
	const h = harness({ wakeSources: { "omo-dag": 1 }, runs: [runRecord()], detectors: [{ name: "probe", detect: () => [finding] }] });
	await h.engine.tick();
	const status = h.readStatus();
	assert.equal(status.level, "warn");
	assert.equal(status.text, "👀 작업정지");
	assert.equal(status.waiting, undefined);
});

test("world.workOf reads a session's store once per tick", async () => {
	const views = [];
	const probe = {
		name: "probe",
		detect(world) {
			const session = world.sessions.get("p1");
			const first = world.workOf(session);
			const second = world.workOf(session);
			assert.equal(second, first, "the same tick reuses the WorkView");
			views.push(first);
			return [];
		},
	};
	const h = harness({ runs: [runRecord()], detectors: [probe] });
	await h.engine.tick();
	await h.engine.tick();
	assert.equal(views.length, 2);
	assert.notEqual(views[1], views[0], "each tick reads the store afresh");
	assert.deepEqual(views[0].runs.map((run) => run.runId), ["dag_wait"]);
});
