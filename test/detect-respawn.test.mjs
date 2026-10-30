import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as respawn from "../src/detect/respawn.mjs";
import * as stall from "../src/detect/stall.mjs";
import { validateAnalyst } from "../src/judge/analyst.mjs";
import { planFinding, newRecord, respawnCandidates } from "../src/judge/policy.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const STEP = 20_000;
const iso = (ms) => new Date(ms).toISOString();
const HOST_PID = 4000;
const HOST = (i = 0) => raw(HOST_PID, 1, "node.exe", iso(NOW - 5 * 3600_000), i * 10, 1e8, "node C:\\npm\\omo-ai\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js");
const shellCmd = (cmd) => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${cmd}"`;

function child(partial = {}) {
	const task = taskRecord({ taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1" });
	return sessionState({ id: "c1", kind: "child", taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", task, ...partial });
}

/**
 * A respawn storm: at every snapshot the old short-lived pids are gone and fresh ones appear
 * under `launcherPid` (or orphaned). Snapshots end at `now`.
 */
function stormSnaps({ now = NOW, count = 12, launcher = { p: 9200, pp: HOST_PID, n: "node.exe", cl: `node driver.mjs`, c: iso(NOW - 6 * 60_000) }, everySnap = true } = {}) {
	const snaps = [];
	for (let i = 0; i < count; i++) {
		const t = now - (count - 1 - i) * STEP;
		const rows = [HOST(i)];
		if (launcher) rows.push(raw(launcher.p, launcher.pp, launcher.n, launcher.c, 0, 0, launcher.cl));
		if (i > 0 && (everySnap || i % 2 === 0)) {
			rows.push(raw(60000 + i, launcher.p, "chrome.exe", iso(t - 900), 0, 0, '"C:/Program Files/Google/Chrome/chrome.exe" --headless=new --remote-debugging-pipe'));
			rows.push(raw(61000 + i, 60000 + i, "chrome.exe", iso(t - 800), 0, 0, '"C:\\Program Files\\Google\\Chrome\\chrome.exe" --type=crashpad-handler --initial-client-data=0x' + i.toString(16)));
		}
		snaps.push({ takenAtMs: t, rows });
	}
	return snaps;
}

test("D17: the same program dying every snapshot and relaunching is a respawn storm owned by the host's session", () => {
	const sessions = [sessionState({ id: "p1", hostPid: HOST_PID }), child()];
	const world = makeWorld({ now: NOW, sessions, procSnapshots: stormSnaps() });
	const findings = respawn.detect(world, {});
	assert.equal(findings.length, 1);
	const f = findings[0];
	assert.equal(f.detector, "D17");
	assert.equal(f.kind, "respawn-storm");
	assert.equal(f.data.storm.name, "chrome.exe");
	assert.equal(f.data.respawnerPid, 9200);
	assert.equal(f.subject.sessionId, "p1");
	assert.equal(f.data.remedy.kind, "kill-respawner");
});

test("D17: a program that stays alive and a varied normal workload are not storms", () => {
	const count = 8;
	const snaps = [];
	for (let i = 0; i < count; i++) {
		const t = NOW - (count - 1 - i) * STEP;
		const rows = [HOST(i), raw(500, HOST_PID, "node.exe", iso(NOW - 60_000), 0, 0, "node dev-server.mjs")];
		// different command each time (a build), plus a bash child of a shell (polling loop)
		rows.push(raw(700 + i, HOST_PID, "node.exe", iso(t - 500), 0, 0, `node run-${i}.mjs`));
		rows.push(raw(900 + i, 901, "sleep.exe", iso(t - 500), 0, 0, "sleep 1"));
		rows.push(raw(901, 9200, "bash.exe", iso(NOW - 60_000), 0, 0, '"bash.exe" -c "while true; do curl -s x; sleep 1; done"'));
		rows.push(raw(9200, HOST_PID, "bash.exe", iso(NOW - 60_000), 0, 0, '"bash.exe" -c watcher'));
		rows.push(raw(910 + i, 901, "curl.exe", iso(t - 500), 0, 0, "curl -s x"));
		snaps.push({ takenAtMs: t, rows });
	}
	const world = makeWorld({ now: NOW, sessions: [child()], procSnapshots: snaps });
	assert.deepEqual(respawn.detect(world, {}), []);
});

test("D17: an unowned storm (orphaned instances only) is reported without a session or remedy", () => {
	const count = 8;
	const snaps = [];
	for (let i = 0; i < count; i++) {
		const t = NOW - (count - 1 - i) * STEP;
		const rows = [HOST(i)];
		if (i > 0) {
			// orphan: the launcher pid is not in the table at all
			rows.push(raw(60000 + i, 30000 + i, "chrome.exe", iso(t - 900), 0, 0, '"chrome.exe" --headless --user-data-dir=C:/qa/p'));
		}
		snaps.push({ takenAtMs: t, rows });
	}
	const world = makeWorld({ now: NOW, sessions: [child()], procSnapshots: snaps });
	const [f] = respawn.detect(world, {});
	assert.ok(f);
	assert.equal(f.subject.sessionId, undefined);
	assert.equal(f.data.remedy, undefined);
	assert.equal(f.severity, "info");
});

test("D17: a storm whose caught respawner no omo session spawned (the user's browser) gets no kill remedy", () => {
	const launcher = { p: 34252, pp: 1234, n: "msedge.exe", cl: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"', c: iso(NOW - 6 * 60_000) };
	const world = makeWorld({ now: NOW, sessions: [child()], procSnapshots: stormSnaps({ launcher }) });
	const [f, ...rest] = respawn.detect(world, {});
	assert.equal(rest.length, 0);
	assert.equal(f.data.respawnerPid, 34252, "the respawner is caught");
	assert.equal(f.subject.sessionId, undefined);
	assert.equal(f.data.remedy, undefined);
	assert.equal(f.severity, "info");
});

test("D17: a storm owned by a pending tool call is not reported again", () => {
	const cmd = "cd /tmp && node driver.mjs > driver.log 2>&1";
	const call = { id: "t1", name: "bash", args: { command: cmd }, ms: NOW - 8 * 60_000 };
	const session = child({ pendingCalls: [call] });
	const snaps = stormSnaps();
	for (const snap of snaps) snap.rows.push(raw(6010, HOST_PID, "bash.exe", iso(call.ms + 50), 0, 0, shellCmd(cmd)));
	// The storm's launcher runs inside the call's shell tree.
	const fixed = snaps.map((snap) => ({
		takenAtMs: snap.takenAtMs,
		rows: snap.rows.map((row) => (row.p === 9200 ? { ...row, pp: 6010 } : row)),
	}));
	const world = makeWorld({ now: NOW, sessions: [session], procSnapshots: fixed });
	assert.deepEqual(respawn.detect(world, {}), []);
});

test("D1: a pending call whose tree owns the respawner classifies as respawn-loop -> release-shell", () => {
	const cmd = "cd /tmp && node driver.mjs > driver.log 2>&1";
	const call = { id: "t1", name: "bash", args: { command: cmd }, ms: NOW - 8 * 60_000 };
	const session = child({ pendingCalls: [call] });
	const snaps = stormSnaps();
	for (const snap of snaps) snap.rows.push(raw(6010, HOST_PID, "bash.exe", iso(call.ms + 50), 0, 0, shellCmd(cmd)));
	const fixed = snaps.map((snap) => ({
		takenAtMs: snap.takenAtMs,
		rows: snap.rows.map((row) => (row.p === 9200 ? { ...row, pp: 6010 } : row)),
	}));
	const world = makeWorld({ now: NOW, sessions: [session], procSnapshots: fixed });
	const [f] = stall.detect(world, {}).filter((x) => x.kind === "stall");
	assert.equal(f.cls, "respawn-loop");
	assert.equal(f.severity, "warn");
	assert.equal(f.data.classification.action.kind, "release-shell");
	// Ladder plan: release-shell is requested once due.
	const plan = planFinding({ finding: f, record: newRecord(f.fp, NOW), now: NOW + 60_000, config: DEFAULT_CONFIG });
	assert.deepEqual(plan.requests.map((r) => r.kind), ["release-shell"]);
});

test("D1: with respawn.enabled off a storm owned by the pending call is not classified as respawn-loop", () => {
	const cmd = "cd /tmp && node driver.mjs > driver.log 2>&1";
	const call = { id: "t1", name: "bash", args: { command: cmd }, ms: NOW - 8 * 60_000 };
	const session = child({ pendingCalls: [call] });
	const snaps = stormSnaps();
	for (const snap of snaps) snap.rows.push(raw(6010, HOST_PID, "bash.exe", iso(call.ms + 50), 0, 0, shellCmd(cmd)));
	const fixed = snaps.map((snap) => ({
		takenAtMs: snap.takenAtMs,
		rows: snap.rows.map((row) => (row.p === 9200 ? { ...row, pp: 6010 } : row)),
	}));
	const world = makeWorld({ now: NOW, sessions: [session], procSnapshots: fixed, config: { respawn: { enabled: false } } });
	assert.ok(world.respawnStorms().length > 0, "the tracker still sees the storm");
	assert.deepEqual(respawn.detect(world, {}), []);
	assert.equal(stall.detect(world, {}).some((f) => f.cls === "respawn-loop"), false);
});

test("D17: the kill-respawner request stays blocked for a main-session owner: only release-shell on a proven wrong command passes the main gate", async () => {
	const { gate } = await import("../src/judge/policy.mjs");
	const verdict = gate(
		{ key: "k", kind: "kill-respawner" },
		{ mode: "auto", paused: false, config: DEFAULT_CONFIG, executed: new Set(), subject: { sessionId: "p1" }, subjectKind: "main" },
	);
	assert.equal(verdict, "skipped:main-session");
});

test("D17's kill asks the analyst first; an act kills, a wait holds, an escalation tells the owner once (#55 C)", () => {
	const sessions = [sessionState({ id: "p1", hostPid: HOST_PID }), child()];
	const [f] = respawn.detect(makeWorld({ now: NOW, sessions, procSnapshots: stormSnaps() }), {});
	assert.equal(f.data.remedy.kind, "kill-respawner");
	assert.deepEqual(f.data.storm.lineage, ["node.exe", "node.exe"], "the respawner up to the omo host: the signature's lineage");
	const candidates = respawnCandidates(f);
	const answer = (verdict, cause = "runaway") => validateAnalyst({ verdict, cause, evidence: ["chrome relaunches every 20 s"], confidence: 0.9, diagnosis: "a launcher loop", mechanism: "driver.mjs relaunches chrome every 20 s because each launch exits at once", avoid: "Run chrome once with a fixed debugging port and reuse it", respawn_text: "Run chrome once with --remote-debugging-port=0." }, candidates, DEFAULT_CONFIG);
	const plan = (record, now = NOW) => planFinding({ finding: f, record, now, config: DEFAULT_CONFIG });
	const kinds = (p) => p.requests.map((r) => r.kind);
	const looked = (verdict, nextLookMs = NOW + 300_000) => Object.assign(newRecord(f.fp, NOW), { looks: 1, nextLookMs, analyst: { step: "look0", candidates, verdict } });

	assert.deepEqual(plan(newRecord(f.fp, NOW)).requests.map((r) => [r.kind, r.key, r.candidates.map((c) => c.id)]), [["analyze", `analyze:${f.fp}:look0`, ["wait", "kill-respawner", "escalate"]]]);
	const running = Object.assign(newRecord(f.fp, NOW), { looks: 1, analyst: { step: "look0", jobId: "job-1", candidates } });
	assert.deepEqual(plan(running), { requests: [], state: "analyzing" }, "a running look is not asked again");

	const act = plan(looked(answer("stuck")));
	assert.deepEqual([kinds(act), act.requests[0].hold, act.requests[0].triage.tier, act.requests[0].triage.evidence.length], [["kill-respawner"], undefined, 2, 1], "the analyst's act kills with its triage");
	const wait = answer("progressing");
	assert.deepEqual(plan(looked(wait)), { requests: [], state: "waiting-analyst" }, "wait holds the kill");
	assert.deepEqual(plan(looked(wait), NOW + 300_000).requests.map((r) => r.key), [`analyze:${f.fp}:look1`], "the next look is asked once nextLookMs has come");

	const told = plan(looked(answer("unrecoverable")));
	assert.deepEqual([told.requests.map((r) => [r.kind, r.key, r.verdict.advice]), told.state], [[["respawn-notice", `respawn-notice:${f.fp}:look0`, "Run chrome once with --remote-debugging-port=0."]], "escalated"], "the owner is told; nothing is killed");
	// A stuck answer below actConfidence, or an act that mayActIrreversibly refuses, is an escalation: no kill.
	const unsure = validateAnalyst({ verdict: "stuck", cause: "runaway", evidence: ["e"], confidence: 0.5, diagnosis: "d", mechanism: "driver.mjs relaunches chrome every 20 s", avoid: "Run chrome once and reuse the instance" }, candidates, DEFAULT_CONFIG);
	assert.deepEqual(kinds(plan(looked(unsure))), ["respawn-notice"]);
	const vetoed = plan(looked({ tier: 2, verdict: "act", actionId: "kill-respawner", assessment: "suspicious", confidence: 0.9, evidence: ["e"] }));
	assert.deepEqual(vetoed.requests.map((r) => [r.kind, r.verdict.vetoed]), [["respawn-notice", "kill-respawner"]]);
	assert.equal(kinds(plan(Object.assign(newRecord(f.fp, NOW), { remedyDone: true }))).length, 0);
	assert.equal(plan(Object.assign(newRecord(f.fp, NOW), { remedyDone: true })).state, "remedied");
});

test("D17 never kills early when the analyst cannot answer: it holds, retries at nextLookMs, and only respawn.maxHoldMs ends the hold (#86 review)", () => {
	const MIN = 60_000;
	const sessions = [sessionState({ id: "p1", hostPid: HOST_PID }), child()];
	const [f] = respawn.detect(makeWorld({ now: NOW, sessions, procSnapshots: stormSnaps() }), {});
	const plan = (record, now) => planFinding({ finding: f, record, now, config: DEFAULT_CONFIG });
	const looked = (verdict, nextLookMs) => Object.assign(newRecord(f.fp, NOW), { looks: 1, nextLookMs, analyst: { step: "look0", candidates: respawnCandidates(f), verdict } });
	const cannot = [
		["a failed run", { tier: 2, verdict: "escalate", reason: "timeout", failed: true }, "analyst-failed"],
		["an unusable answer", validateAnalyst(null, [], DEFAULT_CONFIG), "analyst-failed"],
		["a job that never started", { tier: 2, verdict: "escalate", reason: "analyst-failing", notReached: true }, "analyst-failed"],
		["out of budget", { tier: 2, verdict: "escalate", reason: "budget-exhausted", notReached: true }, "analyst-budget-spent"],
		["shadow mode", { tier: 2, verdict: "escalate", reason: "would", notReached: true }, "would-analyze"],
	];
	for (const [name, verdict, state] of cannot) {
		const held = plan(looked(verdict, NOW + 5 * MIN), NOW + MIN);
		assert.deepEqual([held.requests, held.state], [[], state], `${name}: hold, no kill, no notice`);
		assert.deepEqual(plan(looked(verdict, NOW + 5 * MIN), NOW + 5 * MIN).requests.map((r) => r.kind), ["analyze"], `${name}: asked again at nextLookMs`);
	}
	// respawn.maxHoldMs (30 min from first sight) is the rule's own concrete evidence: the kill runs whatever the analyst is doing.
	const maxHold = DEFAULT_CONFIG.respawn.maxHoldMs;
	const holds = [
		looked({ tier: 2, verdict: "escalate", reason: "timeout", failed: true }, NOW + 45 * MIN),
		looked({ tier: 2, verdict: "wait", assessment: "normal", confidence: 0.9 }, NOW + 45 * MIN),
		Object.assign(newRecord(f.fp, NOW), { looks: 1, analyst: { step: "look0", jobId: "job-1" } }),
	];
	for (const record of holds) {
		assert.deepEqual(plan(record, NOW + maxHold - MIN).requests.filter((r) => r.kind === "kill-respawner"), []);
		assert.deepEqual(plan(record, NOW + maxHold).requests.map((r) => [r.kind, r.hold]), [["kill-respawner", "max-hold"]]);
	}
});

function callOwnedStormWorld(extra = {}) {
	const cmd = "cd /tmp && node driver.mjs > driver.log 2>&1";
	const call = { id: "t1", name: "bash", args: { command: cmd }, ms: NOW - 8 * 60_000 };
	const session = child({ pendingCalls: [call] });
	const snaps = stormSnaps();
	for (const snap of snaps) snap.rows.push(raw(6010, HOST_PID, "bash.exe", iso(call.ms + 50), 0, 0, shellCmd(cmd)));
	const fixed = snaps.map((snap) => ({ takenAtMs: snap.takenAtMs, rows: snap.rows.map((row) => (row.p === 9200 ? { ...row, pp: 6010 } : row)) }));
	return makeWorld({ now: NOW, sessions: [session], procSnapshots: fixed, ...extra });
}

test("D1's respawn-loop (R5b) applies D17's guards: a stale process table or a history replay never classifies a call as a respawn loop (#82)", () => {
	const classes = (world) => stall.detect(world, {}).filter((x) => x.kind === "stall").map((f) => f.cls);
	const live = callOwnedStormWorld();
	assert.ok(live.respawnStorms().length > 0);
	assert.ok(classes(live).includes("respawn-loop"), "control: a fresh table in live mode classifies the loop");
	for (const [name, extra] of [["stale process table", { procsFresh: false }], ["history replay", { self: { pid: 1, mode: "history" } }]]) {
		const world = callOwnedStormWorld(extra);
		assert.ok(world.respawnStorms().length > 0, `${name}: the tracker still holds the storm`);
		assert.deepEqual(respawn.detect(world, {}), [], `${name}: D17 stays quiet`);
		assert.equal(classes(world).includes("respawn-loop"), false, `${name}: R5b stays quiet too`);
	}
});
