import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBudgetOffice } from "../src/budget/office.mjs";
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

function changeBlock({ projectId, revision, requestId = "chg-1", p10 = 10, p50 = 20, p90 = 30 }) {
	const body = {
		v: 1,
		requestId,
		projectId,
		baseRevision: revision,
		remainingUsd: { p10, p50, p90 },
		workClass: "implementation",
		basis: { workUnits: [{ description: "extra integration work", count: 2 }], assumptions: ["same model mix"] },
		nextCheckpoint: "integration done",
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
		office({ runner = createFakeRunner(), loggedIn = ["chatgpt-subscription"] } = {}) {
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

test("(c)-(f), (h): request at $10, estimate -> decision, 100% checkpoint, change -> auditor denies, restart re-sends nothing", (t) => {
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

	// (f) a change over the auto limit goes to the auditor; the audit runs as a runner job.
	out = step([E.assistant({ ms: T0 - 20 * MIN, usage: usage(0), text: changeBlock({ projectId: pid, revision: 1 }) })]);
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"]);
	assert.equal(out.messages[0].details.decision, "pending-auditor");
	assert.equal(runner.starts.length, 1);
	assert.equal(runner.starts[0].kind, "budget-audit");
	assert.ok(runner.starts[0].args.includes("--no-tools"));
	const auditId = runner.starts[0].jobId;
	project = c.store.getProject(pid);
	assert.equal(project.status, "pending");
	assert.equal(project.data.pending.route, "auditor");

	const opinion = {
		v: 1,
		auditId,
		projectId: pid,
		assessment: "waste-likely",
		confidence: 0.8,
		criteriaStatus: "unknown",
		findings: [{ pattern: "repeated-qa-without-acceptance-gain", evidence: "rounds 3-9 rerun the same QA", explanation: "no new acceptance evidence was produced" }],
		advice: "Stop rerunning the full QA pass; verify only the two new failure paths.",
		allocationOpinion: { assessment: "revise", reason: "a cheaper path keeps every criterion" },
	};
	Object.assign(job, {
		status: "done",
		stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-6-astra", content: [{ type: "text", text: JSON.stringify(opinion) }], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } } } })}\n`,
	});
	out = step();
	assert.deepEqual(c.kinds(out.messages).sort(), ["budget-audit-opinion", "budget-decision"]);
	assert.match(out.messages.find((m) => m.details.actionKind === "budget-audit-opinion").content, /not an instruction/);
	const denied = out.messages.find((m) => m.details.actionKind === "budget-decision");
	assert.equal(denied.details.decision, "denied");
	assert.equal(denied.details.by, "auditor");
	assert.match(denied.content, /a cheaper path keeps every criterion/, "the opinion's reason is the denial basis");
	assert.equal(runner.starts.length, 1, "no second audit while the caps hold");
	assert.equal(c.store.spend({ projectId: pid }).auditUsd, 0.4, "the audit's own cost is ledgered as audit usage");
	assert.equal(out.snapshot.owner, undefined, "there is no owner queue in the snapshot");
	assert.equal(out.snapshot.audits[0].assessment, "waste-likely");
	project = c.store.getProject(pid);
	assert.equal(project.status, "approved", "a denial keeps the approved budget");
	assert.equal(project.data.pending, null);
	assert.equal(project.revision, 1, "a denial never bumps the revision");

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
	// reserve $8 x share 1 x 3 %/USD = 24% > 25% of 88% usable => the auditor decides (an empty mix would have read 0% and approved).
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"]);
	assert.equal(out.messages[0].details.decision, "pending-auditor");
	const project = c.store.getProject(pid);
	assert.equal(project.status, "pending");
	assert.equal(project.data.approvals.length, 0);
	assert.equal(project.data.pending.route, "auditor");
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
	const completedMs = T0 - 14 * HOUR;
	const transcript = (c) => {
		const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
		for (let i = 1; i <= 7; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
		return entries;
	};

	// A goal completed 14 h ago: still inside the 24 h closeGrace, 7 numbered rounds and $40 spent.
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
	for (let i = 1; i <= 7; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
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
	for (let i = 1; i <= 7; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
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
	c.writeGoal({ id: "g1", objective: "cancelled work", status: "cancelled", completedAt: secs(T0 - 14 * HOUR), createdAt: secs(T0 - 20 * HOUR), updatedAt: secs(T0 - 14 * HOUR) });
	const entries = [E.header(c.sid, c.cwd, T0 - 20 * HOUR)];
	for (let i = 1; i <= 7; i++) entries.push(E.assistant({ ms: T0 - (21 - i) * HOUR, text: `QA round ${i} finished`, usage: usage(40 / 7) }));
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
	for (let i = 1; i <= 7; i++) entries.push(E.assistant({ ms: T0 - (8 - i) * 10 * MIN, usage: usage(2), text: `QA round ${i} finished` }));
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
	assert.match(roundsTrigger.detail, /7 numbered rounds/);
	assert.deepEqual(row.auditDeferred, { ms: T0 + MIN, reason: "no-model" });
	assert.equal(c.store.getProject(pid).data.auditDeferredReason, "no-model");
	assert.equal(runner.starts.length, 0);
	loggedIn.push("chatgpt-subscription");
	c.clock.advance(MIN);
	row = office.tick({}).snapshot.projects.find((p) => p.id === pid);
	assert.equal(runner.starts.length, 1, "the provider is available now");
	assert.equal(row.lastAudit.status, "running");
	assert.equal(row.auditDeferred, null, "a later audit clears the deferral");
});

test("(t) a change with no capable model is denied by rule as audit-unavailable, never held for a human", (t) => {
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
	assert.deepEqual(c.kinds(out.messages), ["budget-decision"], "one denial, no pending-auditor message");
	assert.equal(out.messages[0].details.decision, "denied");
	assert.equal(out.messages[0].details.by, "rule");
	assert.match(out.messages[0].content, /reason: audit-unavailable/);
	assert.equal(out.messages[0].details.reason, "audit-unavailable");
	assert.equal(runner.starts.length, 0, "no audit runs without a capable model");
	const events = c.store.events({ projectId: pid, limit: 100 });
	assert.ok(events.some((e) => e.kind === "audit-deferred" && e.data.reason === "no-model"));
	assert.equal(events.filter((e) => e.kind === "audit-started").length, 0);
	const project = c.store.getProject(pid);
	assert.equal(project.status, "approved", "the denial keeps the approved budget");
	assert.equal(project.data.pending, null);
	assert.equal(project.revision, 1);
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

test("disabled budget: tick returns the empty result and writes no snapshot", (t) => {
	const c = setup(t);
	c.config.budget.enabled = false;
	assert.deepEqual(c.office().tick({}), { snapshot: null, messages: [], events: [] });
	assert.equal(fs.existsSync(c.paths.health.budgetSnapshotFile), false);
});
