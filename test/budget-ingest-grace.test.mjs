import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBudgetOffice } from "../src/budget/office.mjs";
import { createIngest } from "../src/budget/ingest.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { E, iso, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

// Issue #29: closeGraceMs keeps a finished goal open for late subagent cost only. Main-session work after the goal
// completed is new work: it belongs to no project, like a session with no goal.

const T0 = Date.UTC(2026, 10, 26, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const GOAL_CREATED = T0 - 10 * HOUR;
const COMPLETED = T0 - 4 * HOUR;

const usage = (cost) => ({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
const spendEntry = (ms, cost, text = "working") => E.assistant({ ms, usage: usage(cost), text });
const secs = (ms) => Math.trunc(ms / 1000);

function setup(t, sid) {
	const root = tmpDir("omoh-grace-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	const cwd = path.join(root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const dir = path.join(paths.sessionsDir, "--proj--");
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const clock = createFakeClock(T0);
	const config = structuredClone(DEFAULT_CONFIG);
	const goalDir = path.join(dir, "extensions", "goal");
	fs.mkdirSync(goalDir, { recursive: true });
	fs.writeFileSync(path.join(goalDir, `${sid}.json`), JSON.stringify({
		version: 1,
		goal: { id: "g1", objective: "finished work", status: "complete", createdAt: secs(GOAL_CREATED), completedAt: secs(COMPLETED), updatedAt: secs(COMPLETED) },
	}));
	return {
		sid,
		cwd,
		clock,
		store: createBudgetStore(db),
		file: path.join(dir, `2026-11-26T00-00-00-000Z_${sid}.jsonl`),
		office: () => {
			const runner = createFakeRunner();
			runner.jobDir = (jobId) => path.join(paths.health.jobsDir, jobId);
			return createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders: () => new Set(["anthropic-subscription"]) });
		},
		ingest: () => createIngest({ paths, store: createBudgetStore(db), clock, config }),
		mainRows: () => db.prepare("SELECT project_id, cost FROM usage_events WHERE source = 'main' ORDER BY ms, id").all().map((row) => ({ ...row })),
	};
}

// The three sessions in the issue: main cost before / after completion; all cost after completion was main cost.
const CASES = [
	{ sid: "01a1dd91", before: 11.7, after: 25.6 },
	{ sid: "01a21366", before: 9.3, after: 4.9 },
	{ sid: "01a21547", before: 9.6, after: 1.2 },
];

for (const { sid, before, after } of CASES) {
	test(`${sid}: main cost after completion stays off the finished goal; a late child still lands on it`, (t) => {
		const c = setup(t, sid);
		const pid = `${sid}:g1`;
		writeJsonl(c.file, [
			E.header(sid, c.cwd, GOAL_CREATED),
			spendEntry(GOAL_CREATED + HOUR, before),
			spendEntry(COMPLETED + HOUR, after, "new, unrelated work"),
		]);
		// A reviewer spawned before completion that keeps spending after it: the grace window exists for this.
		writeTask(c.cwd, { task_id: "t1", status: "completed", root_session_id: sid, parent_session_id: sid, child_session_id: "child-1", created_at: iso(COMPLETED - 10 * MIN) }, [
			E.header("child-1", c.cwd, COMPLETED - 10 * MIN),
			spendEntry(COMPLETED + 30 * MIN, 0.5),
		]);

		const office = c.office();
		office.tick({ shadow: false });
		assert.deepEqual(c.mainRows(), [{ project_id: pid, cost: before }, { project_id: null, cost: after }], "the post-completion main row has no project");
		const spend = c.store.spend({ projectId: pid });
		assert.equal(spend.mainUsd, before);
		assert.equal(spend.childUsd, 0.5, "late child cost inside the grace window still belongs to the goal");

		// Past the grace window the project closes with the goal's own cost as its actual.
		c.clock.set(COMPLETED + DEFAULT_CONFIG.budget.closeGraceMs + MIN);
		office.tick({ shadow: false });
		const project = c.store.getProject(pid);
		assert.equal(project.status, "closed");
		assert.equal(project.data.actualUsd, before + 0.5);
	});
}

test("an estimate block and a numbered round written after completion do not reach the finished project", (t) => {
	const sid = "01a1dd91";
	const c = setup(t, sid);
	const pid = `${sid}:g1`;
	const body = {
		v: 1,
		requestId: "req-1",
		projectId: pid,
		baseRevision: 0,
		remainingUsd: { p10: 5, p50: 10, p90: 20 },
		workClass: "investigation",
		basis: { workUnits: [{ description: "server load investigation", count: 2 }], assumptions: [] },
		nextCheckpoint: "load source found",
	};
	writeJsonl(c.file, [
		E.header(sid, c.cwd, GOAL_CREATED),
		spendEntry(GOAL_CREATED + HOUR, 1, "QA round 1 finished"),
		spendEntry(COMPLETED + HOUR, 1, `QA round 2 finished\n<omo-budget kind="estimate">\n${JSON.stringify(body)}\n</omo-budget>`),
	]);
	const result = c.ingest().run();
	assert.deepEqual(result.blocks, [], "the estimate for new work is routed to no project");
	assert.deepEqual(result.rounds.map((r) => [r.projectId, r.round]), [[pid, 1]], "only the round inside the goal counts");
});
