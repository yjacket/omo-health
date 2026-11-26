import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBudgetOffice } from "../src/budget/office.mjs";
import { detect as detectBudget } from "../src/detect/budget.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { appendJsonl, E, iso, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SID = "main-0001";

const usage = (cost) => ({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
const spendEntry = (ms, cost, extra = {}) => E.assistant({ ms, usage: usage(cost), text: "working", ...extra });

function estimateBlock({ projectId, revision, requestId = "est-1", p10 = 2, p50 = 5, p90 = 10 }) {
	const body = {
		v: 1,
		requestId,
		projectId,
		baseRevision: revision,
		remainingUsd: { p10, p50, p90 },
		workClass: "implementation",
		basis: { workUnits: [{ description: "remaining office wiring", count: 3 }], assumptions: [] },
		nextCheckpoint: "tests green",
	};
	return `Progress noted.\n<omo-budget kind="estimate">\n${JSON.stringify(body)}\n</omo-budget>`;
}

function changeBlock({ projectId, revision, requestId = "chg-1", p10 = 10, p50 = 20, p90 = 30, progress = ["wired the second integration adapter"] }) {
	const body = {
		v: 1,
		requestId,
		projectId,
		baseRevision: revision,
		remainingUsd: { p10, p50, p90 },
		workClass: "implementation",
		basis: { workUnits: [{ description: "extra integration work", count: 2 }], assumptions: ["same model mix"] },
		nextCheckpoint: "integration done",
		progress,
		reason: "new-evidence",
		justification: "The integration surfaced two failure paths the first estimate did not cover at all.",
		alternatives: [{ description: "ship without the retry path", remainingUsd: { p10: 5, p50: 8, p90: 12 }, tradeoff: "retry gap" }],
	};
	return `Need more budget.\n<omo-budget kind="change">\n${JSON.stringify(body)}\n</omo-budget>`;
}

function setup(t, { sid = SID } = {}) {
	const root = tmpDir("omoh-office-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	const cwd = path.join(root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const dir = path.join(paths.sessionsDir, "--proj--");
	const file = path.join(dir, `2026-11-10T00-00-00-000Z_${sid}.jsonl`);
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const clock = createFakeClock(T0);
	const config = structuredClone(DEFAULT_CONFIG);
	// Room for one staged large raise on top of the original approval (the default 100% cap is exercised by
	// test/budget-projects.test.mjs); this test is about who decides, not about the cap.
	config.budget.maxChangePercent = 300;
	const ctx = {
		root,
		paths,
		cwd,
		dir,
		file,
		db,
		clock,
		config,
		sid,
		store: createBudgetStore(db),
		writeGoal(goal) {
			const goalDir = path.join(dir, "extensions", "goal");
			fs.mkdirSync(goalDir, { recursive: true });
			fs.writeFileSync(path.join(goalDir, `${sid}.json`), JSON.stringify({ version: 1, goal: { status: "active", ...goal } }));
		},
		// The transcripts' main model is Claude Opus, so the auditor is the Claude top model (budget.audit.topModels).
		office({ runner = createFakeRunner(), loggedIn = ["anthropic-subscription"] } = {}) {
			runner.jobDir = (jobId) => path.join(paths.health.jobsDir, jobId);
			return createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders: () => new Set(loggedIn) });
		},
		rows: () => db.prepare("SELECT * FROM usage_events ORDER BY ms, id").all(),
		kinds: (messages) => messages.map((m) => m.details.actionKind),
	};
	return ctx;
}

const secs = (ms) => Math.trunc(ms / 1000);

test("(a) usage rows land on the goal project; a child task transcript is charged to its root's project", (t) => {
	const c = setup(t);
	c.writeGoal({ id: "g1", objective: "build the office", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - HOUR), spendEntry(T0 - 30 * MIN, 1)]);
	writeTask(c.cwd, { task_id: "t1", status: "completed", root_session_id: c.sid, parent_session_id: c.sid, child_session_id: "child-1", created_at: iso(T0 - 20 * MIN) }, [
		E.header("child-1", c.cwd, T0 - 20 * MIN),
		spendEntry(T0 - 10 * MIN, 2),
	]);
	c.office().tick({ shadow: false });
	const rows = c.rows();
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((r) => [r.session_id, r.root_session_id, r.project_id, r.source]), [
		[c.sid, c.sid, `${c.sid}:g1`, "main"],
		["child-1", c.sid, `${c.sid}:g1`, "child"],
	]);
	const spend = c.store.spend({ projectId: `${c.sid}:g1` });
	assert.equal(spend.mainUsd, 1);
	assert.equal(spend.childUsd, 2);
});

test("(b) the second tick reads only the appended lines (stored offset)", (t) => {
	const c = setup(t);
	c.writeGoal({ id: "g1", objective: "offsets", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - HOUR), spendEntry(T0 - 30 * MIN, 1, { id: "aaaa0001" })]);
	const office = c.office();
	office.tick({});
	assert.equal(c.rows().length, 1);
	assert.equal(c.store.getOffset(c.file).offset, fs.statSync(c.file).size);
	// Rewrite the already-read line in place (same file, same size, different entry id): a re-read from 0 would add a row.
	fs.writeFileSync(c.file, fs.readFileSync(c.file, "utf8").replace("aaaa0001", "bbbb0002"));
	appendJsonl(c.file, [spendEntry(T0 - 20 * MIN, 0.5, { id: "cccc0003" })]);
	c.clock.advance(MIN);
	office.tick({});
	assert.deepEqual(c.rows().map((r) => r.id), [`${c.sid}:aaaa0001`, `${c.sid}:cccc0003`]);
	assert.equal(c.store.getOffset(c.file).offset, fs.statSync(c.file).size);
});

test("(c)-(f), (h): request at $10, estimate -> decision, 100% checkpoint, staged rule raise + independent audit, restart re-sends nothing", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "deliver the office", createdAt: secs(T0 - 2 * HOUR), updatedAt: secs(T0 - 2 * HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - 2 * HOUR), spendEntry(T0 - HOUR, 9.99)]);
	const job = { status: "running" };
	const runner = createFakeRunner({ outcomes: { "budget-audit": job } });
	const office = c.office({ runner });
	const step = (entries) => {
		if (entries) appendJsonl(c.file, entries);
		c.clock.advance(MIN);
		const out = office.tick({ shadow: false });
		// The engine reports delivery after each tick; without it the durable outbox keeps the message pending.
		office.delivered(out.messages.map((message) => ({ messageId: message.id, delivered: true })));
		return out;
	};

	assert.deepEqual(c.kinds(office.tick({}).messages), [], "$9.99 is below the estimate threshold");
	// (c) crossing $10 sends exactly one request, to the root session.
	let out = step([spendEntry(T0 - 50 * MIN, 0.02)]);
	assert.deepEqual(c.kinds(out.messages), ["budget-request"]);
	assert.equal(out.messages[0].sessionId, c.sid);
	assert.equal(out.messages[0].kind, "self-notice");
	assert.deepEqual(c.kinds(step().messages), []);

	// (d) the estimate block in the next reply is approved: revision 1.
	out = step([E.assistant({ ms: T0 - 40 * MIN, usage: usage(0), text: estimateBlock({ projectId: pid, revision: 0 }) })]);
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"]);
	assert.equal(out.messages[0].details.decision, "approved");
	let project = c.store.getProject(pid);
	assert.equal(project.revision, 1);
	assert.equal(project.status, "approved");
	const approved = project.data.approvals[0].approvedUsd;
	assert.ok(Math.abs(approved - (10.01 + 8)) < 1e-9, `approved ${approved}`);

	// (e) spend past 100% -> one checkpoint (100 only), never repeated.
	out = step([spendEntry(T0 - 30 * MIN, 9)]);
	assert.deepEqual(c.kinds(out.messages), ["budget-checkpoint"]);
	assert.equal(out.messages[0].details.checkpoint, 100);
	assert.deepEqual(c.kinds(step().messages), []);

	// (f) a large change with progress is approved staged by rule in the same tick; the change review audit
	// starts independently and can never alter the decision.
	out = step([E.assistant({ ms: T0 - 20 * MIN, usage: usage(0), text: changeBlock({ projectId: pid, revision: 1 }) })]);
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"]);
	assert.equal(out.messages[0].details.decision, "approved");
	assert.equal(out.messages[0].details.by, "rule");
	assert.equal(out.messages[0].details.staged, true);
	assert.equal(out.messages[0].details.nextCheckpoint, "integration done");
	assert.match(out.messages[0].content, /funds the work up to the next checkpoint "integration done"/);
	assert.equal(runner.starts.length, 1, "one audit runs");
	assert.equal(runner.starts[0].kind, "budget-audit");
	assert.ok(runner.starts[0].args.includes("--no-tools"));
	const auditId = runner.starts[0].jobId;
	project = c.store.getProject(pid);
	// Spend had already passed 1x when the change came in, so the one audit running is the tier-1 ladder audit.
	assert.deepEqual([project.data.audits.at(-1).tier, project.data.audits.at(-1).triggers], [1, ["ladder-budget"]]);
	assert.equal(project.status, "approved");
	assert.equal(project.data.pending, null);
	assert.equal(project.revision, 2);
	assert.equal(project.data.approvals.at(-1).staged, true);
	assert.equal(project.data.approvals.at(-1).nextCheckpoint, "integration done");
	const approvedAfterChange = project.data.approvals.at(-1).approvedUsd;
	// The adjusted p50 already includes the 19.01 spent: the stage funds 19.01 + 20 up to the next checkpoint.
	assert.ok(Math.abs(approvedAfterChange - 39.01) < 1e-9, `staged ${approvedAfterChange}`);
	assert.deepEqual(out.snapshot.projects.find((p) => p.id === pid).stage, { nextCheckpoint: "integration done" });

	const opinion = {
		v: 2,
		auditId,
		projectId: pid,
		assessment: "waste-likely",
		confidence: 0.8,
		criteriaStatus: "unknown",
		situation: "Rounds 3-9 reran the same QA pass after the integration was done.",
		criteria: [],
		counterevidence: "",
		decides: [{ who: "agent", what: "Whether to stop the full QA reruns." }],
		findings: [{ pattern: "repeated-qa-without-acceptance-gain", evidence: "rounds 3-9 rerun the same QA", explanation: "no new acceptance evidence was produced" }],
		advice: "Stop rerunning the full QA pass; verify only the two new failure paths.",
		allocationOpinion: { assessment: "revise", reason: "a cheaper path keeps every criterion" },
	};
	Object.assign(job, {
		status: "done",
		stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-6-astra", content: [{ type: "text", text: JSON.stringify(opinion) }], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } } } })}\n`,
	});
	out = step();
	assert.deepEqual(c.kinds(out.messages), ["budget-audit-opinion"], "the opinion is delivered, no decision follows");
	assert.match(out.messages[0].content, /not an instruction/);
	project = c.store.getProject(pid);
	assert.equal(project.status, "approved");
	assert.equal(project.data.approvals.at(-1).approvedUsd, approvedAfterChange, "an opinion never changes the approved budget");
	assert.equal(project.revision, 2, "an opinion never bumps the revision");
	assert.equal(runner.starts.length, 1, "no second audit while the caps hold");
	assert.equal(c.store.spend({ projectId: pid }).auditUsd, 0.4, "the audit's own cost is ledgered as audit usage");
	assert.equal(out.snapshot.owner, undefined, "there is no owner queue in the snapshot");
	assert.equal(out.snapshot.audits[0].assessment, "waste-likely");
	assert.deepEqual(out.snapshot.projects.find((p) => p.id === pid).stage, { nextCheckpoint: "integration done" });

	// A leftover decide file from an older dashboard has no effect and is deleted.
	fs.mkdirSync(c.paths.health.budgetCommandsDir, { recursive: true });
	const leftover = path.join(c.paths.health.budgetCommandsDir, `${c.clock.now()}-olddec.json`);
	fs.writeFileSync(leftover, JSON.stringify({ kind: "decide", projectId: pid, requestId: "chg-1", approve: true }));
	out = step();
	assert.deepEqual(c.kinds(out.messages), []);
	assert.equal(fs.existsSync(leftover), false, "the retired decide file is removed");
	assert.equal(c.store.getProject(pid).status, "approved");

	// (h) restart: a new office on the same db re-sends nothing and starts no audit.
	const restarted = c.office({ runner: createFakeRunner() });
	c.clock.advance(MIN);
	assert.deepEqual(restarted.tick({}).messages, []);
	c.clock.advance(MIN);
	assert.deepEqual(restarted.tick({}).messages, []);
});

test("(g) shadow: no messages, no audits, project state unchanged, snapshot written", (t) => {
	const c = setup(t);
	c.writeGoal({ id: "g1", objective: "shadow goal", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - HOUR), spendEntry(T0 - 30 * MIN, 12)]);
	const runner = createFakeRunner();
	const out = c.office({ runner }).tick({ shadow: true });
	assert.deepEqual(out.messages, []);
	assert.equal(runner.starts.length, 0);
	const snapshot = JSON.parse(fs.readFileSync(c.paths.health.budgetSnapshotFile, "utf8"));
	assert.equal(snapshot.v, 1);
	assert.equal(snapshot.projects[0].id, `${c.sid}:g1`);
	assert.equal(snapshot.projects[0].spentUsd, 12);
	assert.equal(c.store.getProject(`${c.sid}:g1`).status, "tracking", "a shadow tick persists no lifecycle change");
	assert.ok(out.events.some((e) => e.kind === "would-action" && e.data.actionKind === "budget-request"));
});

test("(i) a failed poll with a fresh updatedAt adds no quota sample and shows the window as unknown", (t) => {
	const c = setup(t);
	fs.mkdirSync(path.dirname(c.paths.subscriptionUsageFile), { recursive: true });
	fs.writeFileSync(c.paths.subscriptionUsageFile, JSON.stringify({
		accounts: {
			"anthropic-subscription/default": {
				plan: "max",
				updatedAt: T0,
				nextAt: T0 + MIN,
				error: "http-500",
				windows: [{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 40, resetsAt: iso(T0 + 48 * HOUR) }],
			},
		},
	}));
	const out = c.office().tick({});
	assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM quota_samples").get().n, 0);
	const w = out.snapshot.treasury.windows[0];
	assert.equal(w.state, "unknown");
	assert.equal(w.stale, true);
	assert.equal(w.error, "http-500");
	assert.equal(w.usedPercent, 40, "the stale reading is still shown");
	assert.equal(out.snapshot.treasury.state, "unknown");
});

test("(j) a child keeps charging the goal that spawned it after a replacement, also after a restart re-read from offset 0", (t) => {
	const c = setup(t);
	const A = `${c.sid}:gA`;
	const B = `${c.sid}:gB`;
	const t0 = T0 - 2 * HOUR;
	const t1 = T0 - HOUR;
	const t2 = T0 - 30 * MIN;
	c.writeGoal({ id: "gA", objective: "goal A", createdAt: secs(t0 - HOUR), updatedAt: secs(t0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, t0 - HOUR), spendEntry(t0 - 10 * MIN, 1)]);
	const childFile = writeTask(c.cwd, { task_id: "tA", status: "running", root_session_id: c.sid, parent_session_id: c.sid, child_session_id: "child-a", created_at: iso(t0) }, [
		E.header("child-a", c.cwd, t0),
		spendEntry(t0 + 5 * MIN, 2),
	]);
	c.clock.set(t0 + MIN);
	c.office().tick({});
	assert.equal(c.store.spend({ projectId: A }).costUsd, 3);

	// t1: goal B replaces A (the goal file now holds only B). t2 > t1: the child records $5, main records $1.
	c.writeGoal({ id: "gB", objective: "goal B", createdAt: secs(t1), updatedAt: secs(t1) });
	appendJsonl(childFile, [spendEntry(t2, 5)]);
	appendJsonl(c.file, [spendEntry(t2, 1)]);
	c.clock.set(T0);
	const office = c.office();
	office.tick({});
	assert.equal(c.store.spend({ projectId: A }).costUsd, 8, "A gains the child's $5");
	assert.equal(c.store.spend({ projectId: B }).costUsd, 1, "B only has its own main-session spend");
	assert.equal(c.store.spend({ projectId: B }).childUsd, 0);
	const before = c.rows().map((r) => [r.id, r.project_id]);

	// Restart, re-ingesting everything from offset 0.
	c.db.exec("DELETE FROM ingest_offsets");
	c.clock.advance(MIN);
	c.office().tick({});
	assert.deepEqual(c.rows().map((r) => [r.id, r.project_id]), before, "same attribution, no duplicate rows");
	assert.equal(c.store.spend({ projectId: A }).costUsd, 8);
	assert.equal(c.store.spend({ projectId: B }).costUsd, 1);
});

test("an empty byModel takes the root session's latest model, so capacity is never checked against 0%", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	const account = "anthropic-subscription/default";
	const window = { id: "claude:7d", label: "7d", windowMinutes: 10080 };
	const resetsAtMs = T0 + 2 * HOUR;
	// A calibrated window: 12 readings 20 min apart, +3% each, with $1 of other-session spend in every interval => 3 %/USD.
	const samples = [];
	const calib = [];
	for (let i = 0; i < 12; i++) {
		const ms = T0 - (11 - i) * 20 * MIN;
		samples.push({ account, windowId: window.id, updatedMs: ms, usedPercent: 10 + 3 * i, resetsAtMs, windowMinutes: 10080 });
		if (i < 11) calib.push({ id: `calib:${i}`, ms: ms + MIN, sessionId: "calib", rootSessionId: "calib", source: "main", provider: "anthropic-subscription", model: "claude-opus-5-5", cost: 1, costStatus: "reported" });
	}
	c.store.insertQuotaSamples(samples);
	c.store.insertUsage(calib);
	fs.mkdirSync(path.dirname(c.paths.subscriptionUsageFile), { recursive: true });
	fs.writeFileSync(c.paths.subscriptionUsageFile, JSON.stringify({
		accounts: { [account]: { plan: "max", updatedAt: T0, nextAt: T0 + MIN, windows: [{ ...window, usedPercent: 43, resetsAt: iso(resetsAtMs) }] } },
	}));
	// The project's own usage has no reported cost: spend 0, byModel {}.
	const noCost = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
	c.writeGoal({ id: "g1", objective: "capacity", createdAt: secs(T0 - 3 * HOUR), updatedAt: secs(T0 - 3 * HOUR) });
	writeJsonl(c.file, [
		E.header(c.sid, c.cwd, T0 - 3 * HOUR),
		E.assistant({ ms: T0 - 2 * HOUR, usage: noCost, text: "step" }),
		E.assistant({ ms: T0 - HOUR, usage: noCost, text: estimateBlock({ projectId: pid, revision: 0 }) }),
	]);
	const out = c.office().tick({});
	const w = out.snapshot.treasury.windows[0];
	assert.equal(w.calibrated, true);
	assert.equal(w.state, "ok");
	assert.equal(c.store.spend({ projectId: pid }).costUsd, 0);
	// reserve $8 x share 1 x 3 %/USD = 24% of the window, over the 8.8% auto band: the treasury denies by rule
	// (an empty mix would have read 0% and approved, so the latest model really was used).
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"]);
	assert.equal(out.messages[0].details.decision, "denied");
	assert.equal(out.messages[0].details.by, "rule");
	assert.equal(out.messages[0].details.reason, "insufficient-capacity");
	assert.equal(out.messages[0].details.resetAtMs, null, "the window still has free capacity, so no reset binds");
	const project = c.store.getProject(pid);
	assert.equal(project.status, "requested");
	assert.equal(project.data.approvals.length, 0);
	assert.equal(project.data.pending, null);
	assert.equal(project.revision, 0);
	assert.equal(out.snapshot.owner, undefined, "there is no owner queue in the snapshot");
});

test("(qa) a replaced transcript (new file identity) is re-read from 0 without duplicating usage rows", (t) => {
	const c = setup(t);
	c.writeGoal({ id: "g1", objective: "identity", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - HOUR), spendEntry(T0 - 40 * MIN, 1, { id: "dddd0001" }), spendEntry(T0 - 30 * MIN, 2, { id: "dddd0002" })]);
	const office = c.office();
	office.tick({});
	const first = c.store.getOffset(c.file);
	assert.equal(c.rows().length, 2);
	// Replace the file: write a new file and rename it over the old one (new identity), with one extra line.
	const tmp = `${c.file}.new`;
	fs.copyFileSync(c.file, tmp);
	appendJsonl(tmp, [spendEntry(T0 - 20 * MIN, 4, { id: "dddd0003" })]);
	fs.renameSync(tmp, c.file);
	c.clock.advance(MIN);
	office.tick({});
	const second = c.store.getOffset(c.file);
	assert.notEqual(second.identity, first.identity);
	assert.equal(second.offset, fs.statSync(c.file).size);
	assert.deepEqual(c.rows().map((r) => r.id), [`${c.sid}:dddd0001`, `${c.sid}:dddd0002`, `${c.sid}:dddd0003`]);
	assert.equal(c.store.spend({ projectId: `${c.sid}:g1` }).costUsd, 7);
});

test("(k) a byte cap smaller than every line still reads whole lines and stores offsets on line boundaries", (t) => {
	const c = setup(t);
	c.config.budget.ingestBytesPerTick = 40;
	c.writeGoal({ id: "g1", objective: "long lines", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [
		E.header(c.sid, c.cwd, T0 - HOUR),
		spendEntry(T0 - 50 * MIN, 1, { id: "eeee0001" }),
		spendEntry(T0 - 40 * MIN, 2, { id: "eeee0002" }),
		spendEntry(T0 - 30 * MIN, 3, { id: "eeee0003" }),
	]);
	const raw = fs.readFileSync(c.file);
	const boundaries = new Set([0]);
	for (let i = 0; i < raw.length; i++) if (raw[i] === 0x0a) boundaries.add(i + 1);
	const lines = raw.toString("utf8").split("\n").filter(Boolean);
	assert.ok(lines.length === 4 && lines.every((line) => Buffer.byteLength(line) > 40), "every line is longer than the cap");
	const office = c.office();
	for (let run = 0; run < 10 && c.rows().length < 3; run++) {
		office.tick({});
		const offset = c.store.getOffset(c.file).offset;
		assert.ok(boundaries.has(offset), `run ${run + 1} stored offset ${offset} inside a line`);
		c.clock.advance(MIN);
	}
	assert.deepEqual(c.rows().map((r) => r.id), [`${c.sid}:eeee0001`, `${c.sid}:eeee0002`, `${c.sid}:eeee0003`]);
	assert.equal(c.store.getOffset(c.file).offset, raw.length);
});

test("(l) an unterminated line longer than the cap waits for its newline before it is consumed", (t) => {
	const c = setup(t);
	c.config.budget.ingestBytesPerTick = 40;
	c.writeGoal({ id: "g1", objective: "torn line", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - HOUR)]);
	const office = c.office();
	office.tick({});
	const afterHeader = c.store.getOffset(c.file).offset;
	assert.equal(afterHeader, fs.statSync(c.file).size);
	const line = JSON.stringify(spendEntry(T0 - 30 * MIN, 1, { id: "ffff0001" }));
	assert.ok(line.length > 40);
	fs.appendFileSync(c.file, line);
	c.clock.advance(MIN);
	office.tick({});
	assert.equal(c.rows().length, 0);
	assert.equal(c.store.getOffset(c.file).offset, afterHeader, "the offset never moves into the unfinished line");
	c.clock.advance(MIN);
	office.tick({});
	assert.equal(c.rows().length, 0);
	assert.equal(c.store.getOffset(c.file).offset, afterHeader);
	fs.appendFileSync(c.file, "\n");
	c.clock.advance(MIN);
	office.tick({});
	assert.deepEqual(c.rows().map((r) => r.id), [`${c.sid}:ffff0001`]);
	assert.equal(c.store.getOffset(c.file).offset, fs.statSync(c.file).size);
});


test("(m) a completed goal inside closeGrace starts no audit; an active goal does", (t) => {
	// After the last round (T0 - 10 h): main-session rounds after completion are new work and count for no project.
	const completedMs = T0 - 9 * HOUR;
	const transcript = (c) => {
		const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
		// 11 numbered rounds: past the ladder's first step (10) with no approved budget.
		for (let i = 1; i <= 11; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
		return entries;
	};

	// A goal completed 9 h ago: still inside the 24 h closeGrace, 11 numbered rounds and $40 spent.
	const done = setup(t);
	const donePid = `${done.sid}:g1`;
	done.writeGoal({ id: "g1", objective: "finished work", status: "completed", completedAt: secs(completedMs), createdAt: secs(T0 - 22 * HOUR), updatedAt: secs(completedMs) });
	writeJsonl(done.file, transcript(done));
	const doneRunner = createFakeRunner();
	const doneOffice = done.office({ runner: doneRunner });
	for (let i = 0; i < 3; i++) {
		doneOffice.tick({ shadow: false });
		done.clock.advance(MIN);
	}
	assert.equal(doneRunner.starts.length, 0, "a completed goal's heavy trigger starts nothing");
	const doneEvents = done.store.events({ projectId: donePid, limit: 200 });
	assert.ok(doneEvents.some((e) => e.kind === "trigger" && e.data.kind === "rounds" && e.data.heavy === true), "the heavy trigger really fires");
	const skipped = doneEvents.filter((e) => e.kind === "audit-skipped");
	assert.equal(skipped.length, 1, "one skip event across three ticks");
	assert.equal(skipped[0].data.reason, "goal-not-active");

	// Same rounds and spend, but the goal is active: exactly one audit starts.
	const active = setup(t);
	active.writeGoal({ id: "g1", objective: "work in progress", createdAt: secs(T0 - 22 * HOUR), updatedAt: secs(T0 - 22 * HOUR) });
	writeJsonl(active.file, transcript(active));
	const activeRunner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const activeOffice = active.office({ runner: activeRunner });
	for (let i = 0; i < 3; i++) {
		activeOffice.tick({ shadow: false });
		active.clock.advance(MIN);
	}
	assert.equal(activeRunner.starts.length, 1, "the active goal gets one audit");
	assert.equal(activeRunner.starts[0].kind, "budget-audit");
	assert.equal(active.store.events({ projectId: `${active.sid}:g1`, limit: 100 }).filter((e) => e.kind === "audit-skipped").length, 0);
});

test("(o) a deleted goal file makes the project's goal missing: no later audit starts", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "vanishing goal", createdAt: secs(T0 - 20 * HOUR), updatedAt: secs(T0 - 14 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
	for (let i = 1; i <= 11; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
	writeJsonl(c.file, entries);
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner });
	office.tick({ shadow: false });
	const startedBefore = c.store.events({ projectId: pid, limit: 200 }).filter((e) => e.kind === "audit-started").length;
	assert.equal(runner.starts.length, startedBefore);
	fs.rmSync(path.join(c.dir, "extensions", "goal", `${c.sid}.json`));
	let out = null;
	for (let i = 0; i < 3; i++) {
		c.clock.advance(MIN);
		out = office.tick({ shadow: false });
	}
	assert.equal(runner.starts.length, startedBefore, "no audit starts after the goal record disappears");
	assert.equal(c.store.events({ projectId: pid, limit: 200 }).filter((e) => e.kind === "audit-started").length, startedBefore);
	assert.equal(c.store.getProject(pid).data.goalStatus, "missing");
	assert.equal(out.events.filter((e) => e.projectId === pid && e.kind === "audit-started").length, 0);
});

test("(q) a session that left the backfill window is no longer in progress: no audit even with its goal file gone", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "aging goal", createdAt: secs(T0 - 20 * HOUR), updatedAt: secs(T0 - 14 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
	for (let i = 1; i <= 11; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
	writeJsonl(c.file, entries);
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner });
	office.tick({ shadow: false });
	const startedBefore = runner.starts.length;
	// The transcript ages out of the backfill window and the goal file is removed: ingest no longer sees the session.
	const old = (T0 - (c.config.budget.backfillDays + 1) * 24 * HOUR) / 1000;
	fs.utimesSync(c.file, old, old);
	fs.rmSync(path.join(c.dir, "extensions", "goal", `${c.sid}.json`));
	for (let i = 0; i < 3; i++) {
		c.clock.advance(MIN);
		office.tick({ shadow: false });
	}
	assert.equal(runner.starts.length, startedBefore, "an unseen goal never opens an audit");
	const events = c.store.events({ projectId: pid, limit: 200 });
	assert.equal(events.filter((e) => e.kind === "audit-started").length, startedBefore);
});

test("(p) a cancelled goal's heavy trigger records one audit-skipped and starts no audit", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "cancelled work", status: "cancelled", completedAt: secs(T0 - 9 * HOUR), createdAt: secs(T0 - 20 * HOUR), updatedAt: secs(T0 - 9 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
	for (let i = 1; i <= 11; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
	writeJsonl(c.file, entries);
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner });
	for (let i = 0; i < 3; i++) {
		office.tick({ shadow: false });
		c.clock.advance(MIN);
	}
	assert.equal(runner.starts.length, 0, "a cancelled goal gets no audit even though it closes in the trigger tick");
	const events = c.store.events({ projectId: pid, limit: 200 });
	const skipped = events.filter((e) => e.kind === "audit-skipped" && e.data.reason === "goal-not-active");
	assert.equal(skipped.length, 1, "one skip event across three ticks");
	assert.ok(events.some((e) => e.kind === "trigger" && e.data.kind === "rounds" && e.data.heavy === true), "the heavy trigger really fires");
	assert.equal(c.store.getProject(pid).status, "closed");
});

test("(r) a light rounds crossing keeps its first tick time in the snapshot", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "rounds in the snapshot", createdAt: secs(T0 - 2 * HOUR), updatedAt: secs(T0 - 2 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 2 * HOUR)];
	for (let i = 1; i <= 3; i++) entries.push(E.assistant({ ms: T0 - (4 - i) * 30 * MIN, usage: usage(1), text: `QA round ${i} finished` }));
	writeJsonl(c.file, entries);
	const office = c.office();
	const first = office.tick({}).snapshot.projects.find((p) => p.id === pid);
	const entry = first.triggers.find((t) => t.kind === "rounds");
	assert.equal(entry.heavy, false);
	assert.equal(entry.firstMs, T0);
	assert.equal(first.auditDeferred, null);
	c.clock.advance(MIN);
	const second = office.tick({}).snapshot.projects.find((p) => p.id === pid);
	assert.equal(second.triggers.find((t) => t.kind === "rounds").firstMs, T0, "the first sighting never moves");
});

test("(s) no logged-in model defers an audit visibly; a later audit clears the deferral", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "heavy rounds without a model", createdAt: secs(T0 - 2 * HOUR), updatedAt: secs(T0 - 2 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 2 * HOUR)];
	for (let i = 1; i <= 11; i++) entries.push(E.assistant({ ms: T0 - (12 - i) * 10 * MIN, usage: usage(2), text: `QA round ${i} finished` }));
	writeJsonl(c.file, entries);
	const loggedIn = [];
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner, loggedIn });
	office.tick({});
	c.clock.advance(MIN);
	let row = office.tick({}).snapshot.projects.find((p) => p.id === pid);
	const roundsTrigger = row.triggers.find((t) => t.kind === "rounds");
	assert.equal(roundsTrigger.heavy, true);
	assert.equal(roundsTrigger.firstMs, T0);
	assert.match(roundsTrigger.detail, /11 numbered rounds/);
	assert.deepEqual(row.auditDeferred, { ms: T0 + MIN, reason: "no-model" });
	assert.equal(c.store.getProject(pid).data.auditDeferredReason, "no-model");
	assert.equal(runner.starts.length, 0);
	loggedIn.push("anthropic-subscription");
	c.clock.advance(MIN);
	row = office.tick({}).snapshot.projects.find((p) => p.id === pid);
	assert.equal(runner.starts.length, 1, "the provider is available now");
	assert.equal(row.lastAudit.status, "running");
	assert.equal(row.auditDeferred, null, "a later audit clears the deferral");
});

test("(t) a large change with no capable model is still decided by rule and the audit is deferred (no-model)", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "no auditor available", createdAt: secs(T0 - 2 * HOUR), updatedAt: secs(T0 - 2 * HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - 2 * HOUR), spendEntry(T0 - HOUR, 12)]);
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner, loggedIn: [] });
	const step = (entries) => {
		if (entries) appendJsonl(c.file, entries);
		c.clock.advance(MIN);
		const out = office.tick({ shadow: false });
		office.delivered(out.messages.map((message) => ({ messageId: message.id, delivered: true })));
		return out;
	};

	let out = step();
	assert.deepEqual(c.kinds(out.messages), ["budget-request"]);
	out = step([E.assistant({ ms: T0 - 50 * MIN, usage: usage(0), text: estimateBlock({ projectId: pid, revision: 0 }) })]);
	assert.equal(out.messages[0].details.decision, "approved");

	out = step([E.assistant({ ms: T0 - 40 * MIN, usage: usage(0), text: changeBlock({ projectId: pid, revision: 1 }) })]);
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"], "the raise is decided in this same tick");
	assert.equal(out.messages[0].details.decision, "approved");
	assert.equal(out.messages[0].details.by, "rule");
	assert.equal(out.messages[0].details.staged, true);
	assert.equal(out.messages[0].details.nextCheckpoint, "integration done");
	assert.equal(runner.starts.length, 0, "no audit runs without a capable model");
	const events = c.store.events({ projectId: pid, limit: 100 });
	assert.ok(events.some((e) => e.kind === "audit-deferred" && e.data.reason === "no-model"));
	assert.equal(events.filter((e) => e.kind === "audit-started").length, 0);
	const project = c.store.getProject(pid);
	assert.equal(project.status, "approved");
	assert.equal(project.data.pending, null);
	assert.equal(project.revision, 2);
	assert.equal(project.data.approvals.at(-1).staged, true);
	assert.ok(Math.abs(project.data.approvals.at(-1).approvedUsd - 32) < 1e-9, "the adjusted p50: 12 spent + 20 remaining median");
	assert.deepEqual(out.snapshot.projects.find((p) => p.id === pid).stage, { nextCheckpoint: "integration done" });
	assert.deepEqual(out.snapshot.projects.find((p) => p.id === pid).auditDeferred.reason, "no-model");
});

test("(n) the snapshot reports backfill progress until every byte of the window is read", (t) => {
	const c = setup(t);
	c.config.budget.ingestBytesPerTick = 1;
	c.writeGoal({ id: "g1", objective: "progress", createdAt: secs(T0 - HOUR), updatedAt: secs(T0 - HOUR) });
	writeJsonl(c.file, [
		E.header(c.sid, c.cwd, T0 - HOUR),
		spendEntry(T0 - 50 * MIN, 1, { id: "abab0001" }),
		spendEntry(T0 - 40 * MIN, 2, { id: "abab0002" }),
		spendEntry(T0 - 30 * MIN, 3, { id: "abab0003" }),
	]);
	const childFile = writeTask(c.cwd, { task_id: "t1", status: "completed", root_session_id: c.sid, parent_session_id: c.sid, child_session_id: "child-1", created_at: iso(T0 - 20 * MIN) }, [
		E.header("child-1", c.cwd, T0 - 20 * MIN),
		spendEntry(T0 - 10 * MIN, 1, { id: "abab0004" }),
	]);
	const total = fs.statSync(c.file).size + fs.statSync(childFile).size;
	const office = c.office();
	let out = office.tick({});
	assert.equal(out.snapshot.ingest.totalBytes, total);
	assert.equal(out.snapshot.ingest.files, 2);
	assert.ok(out.snapshot.ingest.pendingBytes > 0, "a 1-byte cap cannot finish the window in one tick");
	for (let i = 0; i < 40 && out.snapshot.ingest.pendingBytes > 0; i++) {
		c.clock.advance(MIN);
		out = office.tick({});
	}
	assert.equal(out.snapshot.ingest.pendingBytes, 0);
	assert.equal(out.snapshot.ingest.pendingFiles, 0);
	assert.equal(out.snapshot.ingest.totalBytes, total);
	assert.equal(out.snapshot.ingest.updatedMs, c.clock.now());
});

// The 01a1ffcb shape: the agent's own criterion (a reviewer approval) never passes and no budget was approved, so the
// review rounds climb the ladder; the bundle shows the auditor the request, the criterion, the verdicts and the PR.
function reviewLoop(c, { from = 19, count = 11 } = {}) {
	c.writeGoal({ id: "g1", objective: "criterion 1: a plan-reviewer unconditional approval receipt exists", createdAt: secs(T0 - 30 * HOUR), updatedAt: secs(T0 - 30 * HOUR) });
	const verdict = (ms, round) => ({
		type: "custom_message", customType: "omo-senpi:wake", id: `wake${round}`, timestamp: iso(ms),
		content: `task completion name:plan-review-r${round} id:st_${round} agent:plan-reviewer(chatgpt-subscription/gpt-6.2-astra) status:completed\nresult:"**[REJECT]** round ${round} edge case in the ledger"`,
		details: { producerDetails: [{ customType: "senpi-task.completion", details: [{ name: `plan-review-r${round}`, agent_type: "plan-reviewer", model: "chatgpt-subscription/gpt-6.2-astra", status: "completed" }] }] },
	});
	const spawn = (ms, round) => E.assistant({ ms, usage: usage(3), calls: [{ id: `call${round}`, name: "task", args: { subagent_type: "plan-reviewer", name: `plan-review-r${round}`, task_summary: `Plan review r${round}: ledger fixes` } }] });
	const entries = [
		E.header(c.sid, c.cwd, T0 - 30 * HOUR),
		E.user("세션별로 토큰사용량을 표시하자. plan approval 은 이 자리에서 모두 허가하니 더이상 질문하지 말고 바로 진행하라", T0 - 30 * HOUR),
		spendEntry(T0 - 29 * HOUR, 2),
		E.toolResult("pr", T0 - 28 * HOUR, { name: "eval", text: "pr 0 https://github.com/yjacket/omo-health/pull/21 | commits 44" }),
	];
	for (let i = 0; i < count; i++) entries.push(spawn(T0 - 27 * HOUR + i * 30 * MIN, from + i), verdict(T0 - 27 * HOUR + i * 30 * MIN + MIN, from + i));
	writeJsonl(c.file, entries);
}

function ticks(office, c, n = 3) {
	let out = null;
	for (let i = 0; i < n; i++) {
		out = office.tick({ shadow: false });
		c.clock.advance(MIN);
	}
	return out;
}

test("(r) past 10 review rounds without a budget, the Claude session's top Claude model audits once at high effort", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	reviewLoop(c);
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	ticks(c.office({ runner, loggedIn: ["chatgpt-subscription", "anthropic-subscription"] }), c);
	assert.equal(runner.starts.length, 1, "one audit, not one per tick");
	const args = runner.starts[0].args;
	assert.equal(args[args.indexOf("--model") + 1], "anthropic-subscription/claude-fable-5-2:high", "the main session's family, tier 1 effort");
	for (const flag of ["--no-tools", "--no-session"]) assert.ok(args.includes(flag), `the auditor stays tool-less (${flag})`);
	const audit = c.store.getProject(pid).data.audits.at(-1);
	assert.deepEqual([audit.tier, audit.ladder.basis, audit.digest], [1, "rounds", "no-model"]);
	const bundle = fs.readFileSync(args.find((a) => a.startsWith("@")).slice(1), "utf8");
	for (const part of ["plan approval 은 이 자리에서 모두 허가하니", "plan-reviewer unconditional approval receipt", "**[REJECT]** round 29 edge case", "11 reviewer spawns", "https://github.com/yjacket/omo-health/pull/21", "## Ladder"]) {
		assert.ok(bundle.includes(part), `bundle misses ${part}`);
	}
	assert.deepEqual(c.store.rounds(pid).map((r) => r.round), Array.from({ length: 11 }, (_, i) => 19 + i), "\"Plan review r19\" counts as round 19");
});

test("(r2) the quick lane summarizes the raw evidence first; the auditor reads the summary, not the raw verdicts", (t) => {
	const c = setup(t);
	reviewLoop(c);
	fs.mkdirSync(path.dirname(c.paths.authFile), { recursive: true });
	fs.writeFileSync(c.paths.authFile, JSON.stringify({ opengateway: { type: "api" }, "anthropic-subscription": { type: "oauth" } }));
	fs.writeFileSync(c.paths.omoJsonc, JSON.stringify({ "[native]": { categories: { quick: { models: ["opengateway/deepseek/deepseek-v4.1-flash:low"] } } } }));
	const runner = createFakeRunner({ outcomes: {
		"budget-digest": { status: "done", result: { opinionText: "DIGEST: 11 rejections, all ledger edge cases", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } } },
		"budget-audit": { status: "running" },
	} });
	const office = c.office({ runner });
	// Tick 1 registers the project; tick 2 opens the audit with its digest.
	ticks(office, c, 2);
	assert.deepEqual(runner.starts.map((s) => s.kind), ["budget-digest"], "the digest runs first");
	const digestArgs = runner.starts[0].args;
	assert.equal(digestArgs[digestArgs.indexOf("--model") + 1], "opengateway/deepseek/deepseek-v4.1-flash:low");
	assert.ok(digestArgs.includes("--no-tools"));
	assert.match(fs.readFileSync(digestArgs.find((a) => a.startsWith("@")).slice(1), "utf8"), /\*\*\[REJECT\]\*\* round 29/);
	ticks(office, c, 1);
	assert.deepEqual(runner.starts.map((s) => s.kind), ["budget-digest", "budget-audit"]);
	const bundle = fs.readFileSync(runner.starts[1].args.find((a) => a.startsWith("@")).slice(1), "utf8");
	assert.ok(bundle.includes("DIGEST: 11 rejections, all ledger edge cases"));
	assert.ok(!bundle.includes("## Reviewer runs"), "the raw verdicts stay with the digest");
	assert.ok(bundle.includes("plan approval 은 이 자리에서"), "owner requests stay verbatim");
	assert.equal(c.store.getProject(`${c.sid}:g1`).data.audits.at(-1).digest, "done");
	assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source = 'audit'").get().n, 1, "the digest's own cost is on the ledger");
});

test("(r3) past 40 review rounds the session is asked once to call the owner, and D26 raises a human-needed finding", (t) => {
	const c = setup(t);
	reviewLoop(c, { count: 41 });
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } });
	const office = c.office({ runner });
	const outs = [];
	for (let i = 0; i < 3; i++) {
		outs.push(office.tick({ shadow: false }));
		c.clock.advance(MIN);
	}
	const calls = outs.flatMap((o) => o.messages).filter((m) => m.details.actionKind === "budget-owner-call");
	assert.equal(calls.length >= 1, true);
	assert.equal(new Set(calls.map((m) => m.id)).size, 1, "one owner call, re-offered until delivered");
	assert.match(calls[0].content, /ask the owner with the question tool/);
	assert.match(calls[0].content, /41 review rounds/);
	const row = outs.at(-1).snapshot.projects.find((p) => p.id === `${c.sid}:g1`);
	assert.equal(row.ownerCall.rounds, 41);
});

test("(r4) a rule audit below 1x spends no tier: tier 1 still audits when spend passes the approved budget (gate review B1)", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	c.writeGoal({ id: "g1", objective: "approved work", createdAt: secs(T0 - 2 * HOUR), updatedAt: secs(T0 - 2 * HOUR) });
	writeJsonl(c.file, [E.header(c.sid, c.cwd, T0 - 2 * HOUR), spendEntry(T0 - HOUR, 9.99)]);
	const job = { status: "running" };
	const runner = createFakeRunner({ outcomes: { "budget-audit": job } });
	const office = c.office({ runner });
	const step = (entries) => {
		if (entries) appendJsonl(c.file, entries);
		c.clock.advance(MIN);
		const out = office.tick({ shadow: false });
		office.delivered(out.messages.map((message) => ({ messageId: message.id, delivered: true })));
		return out;
	};
	office.tick({ shadow: false });
	assert.deepEqual(c.kinds(step([spendEntry(T0 - 50 * MIN, 0.02)]).messages), ["budget-request"]);
	// $18.01 approved on the estimate; $10.01 spent, below 1x.
	step([E.assistant({ ms: T0 - 40 * MIN, usage: usage(0), text: estimateBlock({ projectId: pid, revision: 0 }) })]);
	// A large change below 1x is approved staged ($10.01 + $20 = $30.01) and opens the change-review rule audit.
	step([E.assistant({ ms: T0 - 30 * MIN, usage: usage(0), text: changeBlock({ projectId: pid, revision: 1 }) })]);
	let project = c.store.getProject(pid);
	assert.ok(Math.abs(project.data.approvals.at(-1).approvedUsd - 30.01) < 1e-9, `staged ${project.data.approvals.at(-1).approvedUsd}`);
	assert.equal(runner.starts.length, 1, "the change review runs");
	const rule = project.data.audits.at(-1);
	assert.deepEqual([rule.tier, rule.ladder.basis, rule.triggers], [null, "rule", ["change-review"]], "the office records the rule audit without a tier");
	Object.assign(job, {
		status: "done",
		stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "claude-fable-5-2", content: [{ type: "text", text: JSON.stringify({ v: 2, auditId: rule.auditId, projectId: pid, assessment: "waste-likely", confidence: 0.8, criteriaStatus: "unknown", situation: "Rounds reran the same QA pass.", criteria: [], counterevidence: "", decides: [{ who: "agent", what: "Whether to stop the reruns." }], findings: [{ pattern: "repeated-qa-without-acceptance-gain", evidence: "the same QA reran", explanation: "no new acceptance evidence" }], advice: "Stop rerunning the full QA pass; verify only the two new failure paths.", allocationOpinion: { assessment: "revise", reason: "a cheaper path keeps every criterion" } }) }], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } } } })}\n`,
	});
	assert.deepEqual(c.kinds(step().messages), ["budget-audit-opinion"]);
	assert.equal(c.store.getProject(pid).data.audits.at(-1).status, "done");
	// A day later spend passes the $30.01 approval: tier 1 is still unspent, so its audit opens.
	c.clock.advance(25 * HOUR);
	Object.assign(job, { status: "running" });
	step([spendEntry(T0 + 25 * HOUR, 25)]);
	assert.equal(runner.starts.length, 2, "passing 1x opens the tier-1 audit");
	project = c.store.getProject(pid);
	const audit = project.data.audits.at(-1);
	assert.deepEqual([audit.tier, audit.ladder.basis, audit.triggers], [1, "budget", ["ladder-budget"]]);
});

test("(r5) a ladder audit that ends without an opinion leaves its tier open: one retry per minGapMs, at most LADDER_ATTEMPTS attempts (#24)", (t) => {
	const LADDER_ATTEMPTS = 3; // src/budget/office.mjs
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	reviewLoop(c);
	// The day caps are not under test here: room for every attempt inside one rolling day.
	Object.assign(c.config.budget.audit, { perProjectDay: 10, perDay: 10 });
	const runner = createFakeRunner({ outcomes: { "budget-audit": { status: "timeout", reason: "timeout" } } });
	const office = c.office({ runner });
	ticks(office, c, 4);
	assert.equal(runner.starts.length, 1, "the failed attempt is not retried before minGapMs");
	assert.equal(c.store.getProject(pid).data.audits.at(-1).status, "timeout");
	for (let attempt = 2; attempt <= LADDER_ATTEMPTS + 1; attempt++) {
		c.clock.advance(c.config.budget.audit.minGapMs);
		ticks(office, c, 2);
		assert.equal(runner.starts.length, Math.min(attempt, LADDER_ATTEMPTS), `after gap ${attempt - 1}`);
	}
	const audits = c.store.getProject(pid).data.audits;
	assert.deepEqual(audits.map((a) => [a.tier, a.status]), Array.from({ length: LADDER_ATTEMPTS }, () => [1, "timeout"]), "every attempt is the tier-1 ladder audit");
});

test("(r6) the owner call is answered once the session records the owner's answer to a question; other messages leave it open (#24)", (t) => {
	const c = setup(t);
	const pid = `${c.sid}:g1`;
	reviewLoop(c, { count: 41 });
	const office = c.office({ runner: createFakeRunner({ outcomes: { "budget-audit": { status: "running" } } }) });
	const ownerCalls = (out) => detectBudget({ budget: out.snapshot }).filter((f) => f.kind === "owner-call");
	const question = (status, ms) => {
		const entry = E.toolResult("q1", ms, { name: "ask_user_question", text: "계속해" });
		entry.message.details = { status };
		return entry;
	};
	const first = ticks(office, c, 3);
	assert.equal(ownerCalls(first).length, 1);
	appendJsonl(c.file, [E.user("[LEAD] your work thread has had no update for 17 min.", c.clock.now()), question("timed_out", c.clock.now())]);
	const unanswered = ticks(office, c, 1);
	assert.equal(ownerCalls(unanswered).length, 1, "a timeout or a lead note is no owner answer");
	const answerMs = c.clock.now();
	appendJsonl(c.file, [question("answered", answerMs)]);
	const answered = ticks(office, c, 1);
	const row = answered.snapshot.projects.find((p) => p.id === pid);
	assert.deepEqual([row.ownerCall.answeredMs, row.ownerCall.answeredVia], [answerMs, "question-tool"]);
	assert.deepEqual(ownerCalls(answered), [], "D26 lets the call go");
	assert.equal(c.store.events({ limit: 50 }).filter((e) => e.kind === "owner-answered").length, 1);
});

test("disabled budget: tick returns the empty result and writes no snapshot", (t) => {
	const c = setup(t);
	c.config.budget.enabled = false;
	assert.deepEqual(c.office().tick({}), { snapshot: null, messages: [], events: [] });
	assert.equal(fs.existsSync(c.paths.health.budgetSnapshotFile), false);
});
