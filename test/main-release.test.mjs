import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signals } from "../src/anomaly/signals.mjs";
import { executeKill } from "../src/act/kill.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { closeDb, openDb } from "../src/db/db.mjs";
import { lineageOf, recordCompletion, recordLineage, shapeKeyOf } from "../src/db/toolcalls.mjs";
import * as stall from "../src/detect/stall.mjs";
import { createEngine } from "../src/engine.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { createAnalyst } from "../src/judge/analyst.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { guardProcessListeners } from "./helpers/fake-proc.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { INCIDENT_COMMAND, INCIDENT_PIDS, incidentRows, ordinaryRows } from "./helpers/wsl-incident.mjs";
import { sessionState } from "./helpers/world.mjs";

guardProcessListeners();

const CALL_MS = Date.parse("2026-10-07T03:00:00.000Z");
const HOST = 25760;
const MAIN = "m1";
const SEC = 1000;
const MIN = 60 * SEC;
const TREE = [INCIDENT_PIDS.shell, INCIDENT_PIDS.wsl, INCIDENT_PIDS.wscript];
/** wscript.exe is on the kill guard's protected list (src/detect/match.mjs): the release ends the shell and wsl.exe, which returns the tool call, and leaves the script host alone. */
const RELEASED = [INCIDENT_PIDS.shell, INCIDENT_PIDS.wsl];

const answers = (result) => ({ status: "done", result, costUsd: 0.01 });
const EVIDENCE = ["bash.exe is C:\\Windows\\System32\\bash.exe, the WSL launcher", "wscript.exe holds a visible window titled Windows Script Host"];
const WRONG_COMMAND = { verdict: "stuck", cause: "wrong-command", evidence: EVIDENCE, confidence: 0.9, diagnosis: "bash resolved to the WSL launcher, which ran a script file in wscript that opened a dialog.", mechanism: "`bash` resolved to C:\\Windows\\System32\\bash.exe, the WSL launcher, which handed the script to wscript.exe and its dialog waits for a person", avoid: "Call Git bash by its full path C:\\Program Files\\Git\\bin\\bash.exe", respawn_text: "Call Git bash directly." };

/**
 * One main session whose pending bash call runs under a host, with a real in-memory history DB past its cold start and
 * the real stall detector + analyst over a scripted runner. `rows` are the process rows; `idle` is whether the AGENT is
 * idle in the sensor heartbeat, `lastInputAgoMs` how long ago the HUMAN last typed.
 */
function harness({ rows = incidentRows, command = INCIDENT_COMMAND, outcome = answers(WRONG_COMMAND), idle = true, lastInputAgoMs = 1000, seedLineage = null, inbox = false } = {}) {
	const root = tmpDir("omoh-main-release-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(CALL_MS + 2 * MIN);
	const db = openDb({ file: ":memory:" });
	for (let i = 0; i < 250; i++) recordCompletion(db, { id: `seed-${i}`, sessionId: "old", kind: "main", tool: "bash", shapeKey: shapeKeyOf(command), startMs: CALL_MS - 3_600_000 - i * 1000 - 3000 * SEC, endMs: CALL_MS - 3_600_000 - i * 1000, endedBy: "result" });
	if (seedLineage) {
		const { fp, lineage } = lineageOf(seedLineage.map((name) => ({ name })));
		recordLineage(db, fp, lineage, CALL_MS - 3_600_000);
	}
	const main = sessionState({ id: MAIN, kind: "main", hostPid: HOST, rootSessionId: MAIN, lastMessage: { role: "assistant", stopReason: "toolUse" }, pendingCalls: [{ id: "toolu_call", name: "bash", args: { command }, ms: CALL_MS, batchId: "b" }] });
	const sessions = new Map([[MAIN, main]]);
	const procRows = new Map(rows({ host: HOST, callMs: CALL_MS, command }).map((row) => [row.p, row]));
	const procs = {
		async snapshot() {
			return { takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) };
		},
		async os() {
			return { commitFrac: 0.5, commitUsedBytes: 1, commitLimitBytes: 2 };
		},
		async ports() {
			return [];
		},
		restarts: 0,
		close() {},
	};
	const config = { ...DEFAULT_CONFIG, procSnapshotMs: 20_000 };
	const runner = createFakeRunner({ outcomes: { analyst: outcome } });
	const tracker = new ProcessTracker();
	const killed = [];
	const sent = [];
	const toasts = [];
	const decisions = [];
	const investigations = createInvestigations({ paths, clock });
	const engine = createEngine({
		paths,
		config,
		clock,
		detectors: [{ name: "stall", ...stall }],
		sources: { procs, registry: { refresh: () => ({ sessions, tasks: [], completions: [] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: {
			kill: (args) =>
				executeKill({
					...args,
					snapshot: async () => tracker.update({ takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) }),
					runner: (pid) => {
						killed.push(pid);
						procRows.delete(pid);
						// Ending the call's shell returns the tool call (an error result), as senpi does after a release.
						if (pid === INCIDENT_PIDS.shell) main.pending.clear();
						return { status: 0 };
					},
					sleep: async () => {},
				}),
			...(inbox ? {} : { send: (message) => (sent.push(message), "inbox-file") }),
			notifier: { toast: (t) => (toasts.push(t), { ok: true }) },
			decide: (d) => decisions.push(d),
			sensors: () => new Map([[MAIN, { sessionId: MAIN, pid: HOST, ts: clock.now(), idle, lastInputAt: clock.now() - lastInputAgoMs, sensorVersion: "0.5.0" }]]),
			db,
			analyst: createAnalyst({ config, paths, clock, runner, env: {} }),
		},
		options: { selfPid: 1, investigations },
	});
	return { engine, clock, db, runner, killed, sent, toasts, decisions, investigations, paths, procRows };
}

async function runUntil(h, untilMs, stepMs = 20 * SEC) {
	while (h.clock.now() <= untilMs) {
		await h.engine.tick();
		h.clock.advance(stepMs);
	}
}

/** Run the incident to 40 min and return what an observer could see; the db is closed. */
async function incident(opts) {
	const h = harness(opts);
	try {
		await runUntil(h, CALL_MS + 40 * MIN, 60 * SEC);
	} finally {
		closeDb(h.db);
	}
	return h;
}
const outcomeOf = (h) => ({ killed: h.killed.slice().sort((a, b) => a - b), sent: h.sent.map((m) => ({ kind: m.kind, sessionId: m.sessionId, deliverAs: m.deliverAs, triggerTurn: m.triggerTurn, content: m.content })), status: h.investigations.list().map((inv) => inv.status) });

test("signals: the WSL launcher C:\\Windows\\System32\\bash.exe under a tool is a signal; Git's bash is not", () => {
	const ask = (procs) => signals({ pending: { ageMs: 2 * MIN }, procs, shapeStats: () => undefined, lineageSeen: () => true, completions: 250, config: { enabled: true, minShapeSamples: 20, outlierFactor: 3 } });
	const wsl = { name: "bash.exe", cmdHead: 'C:\\Windows\\System32\\bash.exe -c "x"' };
	assert.deepEqual(ask([wsl]).map((s) => s.kind), ["system32-bash"]);
	assert.deepEqual(ask([{ name: "bash.exe", cmdHead: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "x"' }]), []);
});

test("incident (senpi bun -> System32 bash.exe -> wsl.exe -> wscript.exe, window visible): a wrong-command proof releases the tree and the session gets exactly one explanation", async () => {
	const h = await incident();
	assert.equal(h.runner.starts.length, 1, "one analyst look");
	const bundle = fs.readFileSync(path.join(h.paths.health.analystJobsDir, h.runner.starts[0].jobId, "bundle.md"), "utf8");
	for (const text of ["wscript.exe", "window_visible", "Windows Script Host", "system32-bash", "visible-window", "unseen-lineage", "release-shell", "wrong-command"]) assert.ok(bundle.includes(text), `the analyst is shown ${text}`);
	assert.ok(bundle.includes("C:\\\\Windows\\\\System32\\\\bash.exe"), "the root shell path is in the bundle");

	assert.deepEqual(h.killed.slice().sort((a, b) => a - b), RELEASED, "the call's shell chain went, one single-PID kill each");
	assert.ok(h.procRows.has(INCIDENT_PIDS.wscript), "the protected script host is not killed");
	assert.equal(h.sent.length, 1, "exactly one message");
	const [message] = h.sent;
	assert.deepEqual([message.kind, message.sessionId, message.deliverAs, message.triggerTurn], ["relay", MAIN, "followUp", true]);
	for (const line of EVIDENCE) assert.ok(message.content.includes(line), `the message cites: ${line}`);
	assert.deepEqual([message.details.cause, message.details.confidence, message.details.evidence], ["wrong-command", 0.9, EVIDENCE]);
	const [inv] = h.investigations.list();
	assert.deepEqual([inv.status, inv.trigger, inv.cls, inv.verdict.cause, inv.actions[0].kind, inv.actions[0].quiet], ["released", "stall", "unknown", "wrong-command", "release-shell", false]);
	assert.ok(h.decisions.some((d) => d.action?.kind === "release-shell" && d.result === "execute" && d.rule?.id === "R11"));
	assert.deepEqual(h.toasts, []);
});

test("analyst-why (8): the wrong-command release's actual inbox file carries the analyst's mechanism and avoid", async () => {
	const h = await incident({ inbox: true });
	assert.deepEqual(h.killed.slice().sort((a, b) => a - b), RELEASED);
	// No sensor writes receipts here, so the sweep later moves the file to inbox/_undelivered: read both.
	const files = fs.readdirSync(h.paths.health.inboxDir, { recursive: true }).filter((name) => String(name).endsWith(".json"));
	assert.equal(files.length, 1, "one explanation");
	const message = JSON.parse(fs.readFileSync(path.join(h.paths.health.inboxDir, files[0]), "utf8"));
	assert.equal(message.sessionId, MAIN);
	assert.equal(message.kind, "relay");
	assert.ok(message.content.includes(WRONG_COMMAND.mechanism), "what happened");
	assert.ok(message.content.includes(WRONG_COMMAND.avoid), "what to do instead");
});

test("incident: an agent that is busy still gets the one message, queued without starting a turn", async () => {
	const h = await incident({ idle: false });
	assert.deepEqual(h.killed.slice().sort((a, b) => a - b), RELEASED);
	assert.deepEqual(h.sent.map((m) => [m.kind, m.deliverAs, m.triggerTurn]), [["relay", "followUp", false]]);
});

test("incident: any answer but a proven wrong command is one notice and no release (another cause, too little confidence, no evidence, progressing, unrecoverable)", async () => {
	const verdicts = {
		"another cause": { ...WRONG_COMMAND, cause: "blocked-input" },
		"unknown cause": { ...WRONG_COMMAND, cause: "unknown" },
		"confidence under actConfidence": { ...WRONG_COMMAND, confidence: 0.5 },
		"no cited evidence": { ...WRONG_COMMAND, evidence: [] },
		progressing: { verdict: "progressing", cause: "external-wait", evidence: ["a dialog waits for a person"], confidence: 0.9, diagnosis: "It waits.", recheck_after_s: 300 },
		unrecoverable: { verdict: "unrecoverable", cause: "unknown", evidence: ["no process behind the call"], confidence: 0.9, diagnosis: "Cannot continue.", mechanism: "no process is behind the call, so no tool result can ever arrive", avoid: "Restart the step with a command that returns on its own", respawn_text: "Restart the step." },
	};
	for (const [name, verdict] of Object.entries(verdicts)) {
		const h = await incident({ outcome: answers(verdict) });
		assert.deepEqual(h.killed, [], `${name}: nothing is killed`);
		assert.ok(TREE.every((pid) => h.procRows.has(pid)), `${name}: the whole tree is alive after 40 min of ticks`);
		assert.equal(h.sent.length, 1, `${name}: exactly one notice, however many ticks follow`);
		assert.deepEqual([h.sent[0].kind, h.sent[0].sessionId, h.sent[0].deliverAs, h.sent[0].triggerTurn, h.sent[0].details.actionKind], ["self-notice", MAIN, "nextTurn", false, "main-notice"], name);
		assert.deepEqual(h.investigations.list().map((inv) => inv.status), ["noticed"], name);
		assert.equal(h.runner.starts.length, 1, `${name}: the analyst is asked once`);
		assert.deepEqual(h.decisions.filter((d) => d.action?.kind === "release-shell"), [], name);
	}
});

test("incident: an analyst that cannot answer releases nothing and tells nobody; it is retried", async () => {
	const h = await incident({ outcome: { status: "failed", reason: "exit-1" } });
	assert.deepEqual([h.killed, h.sent], [[], []]);
	assert.ok(TREE.every((pid) => h.procRows.has(pid)));
	assert.deepEqual(h.investigations.list().map((inv) => inv.status), ["failed"]);
	assert.ok(h.runner.starts.length >= 2, "asked again after the retry time");
});

test("a main session's idle stall with no anomaly signal gets the status notify, one why look and one self why-notice, and no kill (analyst-why C15: the main session now gets a why look, never a release)", async () => {
	const h = await incident({ rows: ordinaryRows, command: "sleep 3000", seedLineage: ["bash.exe", "sleep.exe"], outcome: answers(WRONG_COMMAND) });
	assert.equal(h.runner.starts.length, 1, "one why look");
	assert.deepEqual([h.killed, h.toasts], [[], []]);
	assert.deepEqual(h.sent.map((m) => [m.kind, m.sessionId, m.details.why]), [["self-notice", MAIN, true]], "one explanation, to the session itself");
	assert.ok(h.sent[0].content.includes(WRONG_COMMAND.mechanism) && h.sent[0].content.includes(WRONG_COMMAND.avoid));
	assert.deepEqual(h.decisions.filter((d) => d.action?.kind === "release-shell"), [], "a why look never offers the release");
	assert.deepEqual(h.investigations.list().map((inv) => [inv.status, inv.trigger, inv.why, inv.rule.id]), [["advised", "stall", true, "R11"]]);
	assert.equal(h.decisions.filter((d) => d.action?.kind === "notify" && d.result === "execute").length, 1);
});

test("a signal on a main session's call before any stall is due opens nothing of its own", async () => {
	const h = harness();
	try {
		await runUntil(h, CALL_MS + 4 * MIN);
		assert.deepEqual([h.investigations.list(), h.runner.starts.length, h.killed, h.sent], [[], 0, [], []]);
		assert.deepEqual(h.decisions.filter((d) => d.detector === "D19"), []);
	} finally {
		closeDb(h.db);
	}
});

test("user idleness decides nothing: the human's last input recent or hours old gives the same release, the same message and the same notice", async () => {
	for (const outcome of [answers(WRONG_COMMAND), answers({ ...WRONG_COMMAND, cause: "unknown" })]) {
		const recent = outcomeOf(await incident({ outcome, lastInputAgoMs: 1000 }));
		const old = outcomeOf(await incident({ outcome, lastInputAgoMs: 6 * 3600_000 }));
		const never = outcomeOf(await incident({ outcome, lastInputAgoMs: 40 * 24 * 3600_000 }));
		assert.deepEqual(old, recent, outcome.result.cause);
		assert.deepEqual(never, recent, outcome.result.cause);
		assert.equal(recent.sent.length, 1);
	}
	const released = outcomeOf(await incident({ lastInputAgoMs: 1000 }));
	const notified = outcomeOf(await incident({ outcome: answers({ ...WRONG_COMMAND, cause: "unknown" }), lastInputAgoMs: 1000 }));
	assert.deepEqual([released.killed, notified.killed], [RELEASED, []]);
});
