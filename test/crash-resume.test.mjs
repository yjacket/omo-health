import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as crashes from "../src/detect/crashes.mjs";
import { createEngine } from "../src/engine.mjs";
import { CRASH_RESUME_PROMPT } from "../src/act/terminal.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";

const START = Date.parse("2026-09-29T12:00:00Z");
const SID = "01a0ed3a-0000-7000-8000-000000000001";
const HOST = 5100;
const NEW_HOST = 5200;
const TERMINAL = { kind: "herdr", workspaceId: "wB", tabId: "wB:t1", paneId: "wB:p1" };
const hostRow = (p, ms) => ({ p, pp: 1, n: "bun.exe", c: new Date(ms).toISOString(), cl: "bun C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" });

/** herdr stand-in: the crashed pane wB:p1 sits at an idle shell (or runs bun when busy); tab create returns wB:t9 / wB:p9. */
function fakeHerdr({ busy, cwd }) {
	const calls = [];
	const screen = { text: " ❯ " };
	return {
		calls,
		screen,
		read(_terminal, paneId) {
			calls.push(["pane", "read", paneId]);
			return { ok: true, text: paneId === "wB:p9" ? screen.text : "" };
		},
		call(_terminal, args) {
			calls.push(args);
			const [group, verb] = args;
			if (group === "pane" && verb === "get") return { ok: true, result: { pane: { pane_id: args[2], cwd: `${cwd}\\` } } };
			if (group === "pane" && verb === "process-info") {
				const foreground = busy && args[3] === "wB:p1" ? [{ pid: 700, name: "powershell.exe" }, { pid: 701, name: "bun.exe" }] : [{ pid: 700, name: "powershell.exe" }];
				return { ok: true, result: { process_info: { shell_pid: 700, foreground_processes: foreground } } };
			}
			if (group === "tab" && verb === "create") return { ok: true, result: { tab: { tab_id: "wB:t9" }, root_pane: { pane_id: "wB:p9", cwd } } };
			if ((group === "tab" && verb === "close") || (group === "pane" && verb === "run") || (group === "pane" && verb === "send-keys")) return { ok: true, result: { type: "ok" } };
			return { ok: false, code: "unexpected" };
		},
	};
}

function harness({ todos = 2, busy = false, mode = "auto", recheckAlive = false } = {}) {
	const root = tmpDir("omoh-crash-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(paths.health.sensorsDir, { recursive: true });
	const clock = createFakeClock(START);
	const live = new Map([[1, { p: 1, pp: 0, n: "System", c: new Date(START - 1e7).toISOString() }], [HOST, hostRow(HOST, START - 60_000)]]);
	const session = { ...sessionState({ id: SID, cwd, hostPid: HOST }), todoState: { open: todos, total: 3 } };
	const herdr = fakeHerdr({ busy, cwd });
	const sent = [];
	const toasts = [];
	const decisions = [];
	const hbFile = path.join(paths.health.sensorsDir, `${SID}.json`);
	const writeHb = (pid, over = {}) => fs.writeFileSync(hbFile, JSON.stringify({ v: 1, pid, sessionId: SID, cwd, kind: "interactive", idle: true, pending: false, executingTools: 0, hasUI: true, terminal: TERMINAL, ts: clock.now(), ...over }));
	const alive = new ProcessTracker();
	const makeEngine = () =>
		createEngine({
			paths,
			config: DEFAULT_CONFIG,
			clock,
			mode,
			detectors: [{ name: "crashes", ...crashes }],
			sources: {
				procs: { async snapshot() { return { rows: normalizeRows([...live.values()]), takenAtMs: clock.now() }; }, async os() { return {}; } },
				registry: { refresh: () => ({ sessions: new Map([[SID, session]]), tasks: [] }) },
				logs: { read() {}, drain: () => [], stats: new Map() },
			},
			actors: {
				herdr,
				send: (message) => (sent.push(message), "inbox"),
				decide: (d) => decisions.push(d),
				notifier: { toast: (t) => (toasts.push(t), { ok: true }) },
				...(recheckAlive ? { snapshot: async () => alive.update({ rows: normalizeRows([...live.values(), hostRow(HOST, START - 60_000)]), takenAtMs: clock.now() }) } : {}),
			},
			options: { selfPid: 999999 },
		});
	return { engine: makeEngine(), makeEngine, clock, live, herdr, sent, toasts, decisions, paths, writeHb, hbFile, cwd };
}

/** The host runs with a fresh heartbeat, then dies: the tick that finds it dead decides and acts. */
async function crash(h, engine = h.engine, pid = HOST, over = { idle: false, executingTools: 1 }) {
	h.writeHb(pid, over);
	await engine.tick();
	h.clock.advance(40_000);
	h.live.delete(pid);
	return engine.tick();
}

const runs = (h) => h.herdr.calls.filter((args) => args[0] === "pane" && args[1] === "run");

test("a crash with open todos reopens the session in a new tab and never types into the crashed pane", async () => {
	const h = harness();
	await crash(h);
	assert.deepEqual(runs(h), [["pane", "run", "wB:p9", `omo --session ${SID} "${CRASH_RESUME_PROMPT}"`]], "the command-line prompt starts the turn (#109)");
	assert.deepEqual(h.herdr.calls.find((args) => args[0] === "tab"), ["tab", "create", "--workspace", "wB", "--cwd", h.cwd, "--label", "project (resumed)", "--env", `OMO_HEALTH_HOME=${h.paths.healthHome}`, "--no-focus"]);
	assert.equal(h.herdr.calls.some((args) => ["run", "send-text", "send-keys"].includes(args[1]) && args.includes("wB:p1")), false);
	assert.equal(fs.existsSync(h.hbFile), false, "the leftover heartbeat is removed once the outcome is recorded");
	assert.ok(h.decisions.some((d) => d.detector === "D18" && d.action?.kind === "crash-resume" && d.result === "execute" && d.outcome?.ok === true));
	assert.equal(h.toasts.length, 0);
	assert.equal(h.sent.length, 0, "no message before the new sensor is up");

	h.clock.advance(15_000);
	h.live.set(NEW_HOST, hostRow(NEW_HOST, h.clock.now() - 5_000));
	h.writeHb(NEW_HOST, { lastAgentStartAt: h.clock.now() - 2_000 });
	await h.engine.tick();
	assert.equal(h.sent.length, 1);
	assert.deepEqual([h.sent[0].kind, h.sent[0].sessionId, h.sent[0].deliverAs, h.sent[0].triggerTurn], ["self-notice", SID, "nextTurn", false]);
	assert.match(h.sent[0].content, /reopened in a new tab/);
	h.clock.advance(15_000);
	await h.engine.tick();
	assert.equal(h.sent.length, 1, "one notice");
	assert.equal(runs(h).length, 1, "one resume");
});

test("a resumed session that is already running again gets the note steered into its run, still without a new turn", async () => {
	const h = harness();
	await crash(h);
	h.clock.advance(15_000);
	h.live.set(NEW_HOST, hostRow(NEW_HOST, h.clock.now() - 5_000));
	h.writeHb(NEW_HOST, { idle: false });
	await h.engine.tick();
	assert.deepEqual([h.sent[0].deliverAs, h.sent[0].triggerTurn], ["steer", false]);
});

test("a reopened session that never starts a run (omo 5.1.48 interrupted-run hold, #109) gets no success notice but one human-needed toast", async () => {
	const h = harness();
	await crash(h);
	h.clock.advance(15_000);
	h.live.set(NEW_HOST, hostRow(NEW_HOST, h.clock.now() - 5_000));
	h.writeHb(NEW_HOST, { lastAgentStartAt: null });
	await h.engine.tick();
	assert.equal(h.sent.length, 0, "a sensor that is up but never ran is not a resumed session");
	h.clock.advance(DEFAULT_CONFIG.crashResume.startupMs);
	h.writeHb(NEW_HOST, { lastAgentStartAt: null });
	await h.engine.tick();
	assert.equal(h.sent.length, 0);
	assert.equal(h.toasts.length, 1);
	assert.match(`${h.toasts[0].title} ${h.toasts[0].body}`, /작업을 시작하지 않음/);
	assert.equal(runs(h).length, 1, "never a second omo on the same session");
});

test("an idle crash with only open todos (no turn, no active goal) is only recorded and its heartbeat removed", async () => {
	const h = harness({ todos: 2 });
	await crash(h, h.engine, HOST, {});
	assert.deepEqual(h.herdr.calls, []);
	assert.equal(fs.existsSync(h.hbFile), false);
	assert.ok(h.decisions.some((d) => d.detector === "D18" && d.action?.kind === "crash-cleanup" && d.result === "execute"));
	h.clock.advance(15_000);
	await h.engine.tick();
	assert.equal(h.toasts.length, 0);
	assert.equal(h.sent.length, 0);
});

test("a crashed pane that runs something else gets no tab; one human-needed toast names the session and cwd", async () => {
	const h = harness({ busy: true });
	await crash(h);
	assert.equal(h.herdr.calls.some((args) => args[0] === "tab"), false);
	assert.deepEqual(runs(h), []);
	assert.equal(fs.existsSync(h.hbFile), false);
	for (let i = 0; i < 3; i++) {
		h.clock.advance(15_000);
		await h.engine.tick();
	}
	assert.equal(h.toasts.length, 1);
	assert.equal(h.toasts[0].tag, `crash-stop-${SID}`);
	assert.ok(h.toasts[0].body.includes(h.cwd) && h.toasts[0].body.includes(SID));
});

test("the host and its heartbeat are re-checked right before acting", async () => {
	const h = harness({ recheckAlive: true });
	await crash(h);
	assert.equal(h.herdr.calls.length, 0, "a host alive in the fresh snapshot is left alone");
	assert.equal(fs.existsSync(h.hbFile), true);
});

test("shadow mode only records what it would do", async () => {
	const h = harness({ mode: "shadow" });
	await crash(h);
	assert.equal(h.herdr.calls.length, 0);
	assert.equal(fs.existsSync(h.hbFile), true);
	assert.ok(h.decisions.some((d) => d.action?.kind === "crash-resume" && d.result === "would"));
});

test("no new sensor within startupMs stops recovery with one toast", async () => {
	const h = harness();
	await crash(h);
	for (let i = 0; i < 16; i++) {
		h.clock.advance(15_000);
		await h.engine.tick();
	}
	assert.equal(h.toasts.length, 1);
	assert.match(h.toasts[0].title, /자동 재개 중단/);
	assert.equal(runs(h).length, 1);
});

test("the resume history survives a daemon restart, so a second crash within 30 minutes stops instead of looping", async () => {
	const h = harness();
	await crash(h);
	h.clock.advance(15_000);
	h.live.set(NEW_HOST, hostRow(NEW_HOST, h.clock.now() - 5_000));
	h.writeHb(NEW_HOST);
	await h.engine.tick();
	assert.equal(h.sent.length, 1);
	const saved = JSON.parse(JSON.stringify(h.engine.snapshotState()));
	assert.equal(saved.memories.crashes.resumes[SID].length, 1);
	const restarted = h.makeEngine();
	restarted.restoreState(saved, h.clock.now());
	h.clock.advance(10 * 60_000);
	await crash(h, restarted, NEW_HOST);
	assert.equal(runs(h).length, 1, "no second resume");
	assert.equal(fs.existsSync(h.hbFile), false);
	h.clock.advance(15_000);
	await restarted.tick();
	assert.equal(h.toasts.length, 1);
	assert.match(h.toasts[0].title, /반복 크래시/);
});

const CHOOSER = [" Resume blocked goal?", " Goal: finish the report", "", " → Resume goal", "   Leave stopped", "", " ↑↓ navigate  enter select  esc cancel", "", "──────", "C:\\x • fake m", "Goal blocked: user interrupted the turn"].join("\n");
const NEW_TERMINAL = { ...TERMINAL, tabId: "wB:t9", paneId: "wB:p9" };
const enters = (h) => h.herdr.calls.filter((args) => args[1] === "send-keys");
const OTHER_SID = "01a0ed3a-0000-7000-8000-00000000ffff";

/** The new tab's shell (pid 700 in the fake herdr) runs `omo --session <id> "<prompt>"`; its sensor is not up (the chooser holds session_start). */
async function reopenedWaiting(h, { sessionId = SID } = {}) {
	await crash(h);
	h.clock.advance(15_000);
	h.live.set(700, { p: 700, pp: 1, n: "powershell.exe", c: new Date(h.clock.now() - 20_000).toISOString(), cl: "powershell.exe" });
	h.live.set(NEW_HOST, { ...hostRow(NEW_HOST, h.clock.now() - 5_000), pp: 700, cl: `bun.exe C:\\x\\cli.js --session ${sessionId} "${CRASH_RESUME_PROMPT}"` });
}
const sensorUp = (h, over = {}) => h.writeHb(NEW_HOST, { terminal: NEW_TERMINAL, ...over });

test("option 2: the goal chooser in the new tab gets one Enter before the new sensor is even up; once the run starts the usual notice follows", async () => {
	const h = harness();
	await reopenedWaiting(h);
	h.herdr.screen.text = " ❯ ";
	await h.engine.tick();
	assert.deepEqual(enters(h), [], "no chooser on screen yet: nothing pressed");
	h.clock.advance(15_000);
	h.herdr.screen.text = CHOOSER;
	await h.engine.tick();
	assert.deepEqual(enters(h), [["pane", "send-keys", "wB:p9", "enter"]]);
	assert.ok(h.decisions.some((d) => d.action?.kind === "crash-answer" && d.result === "execute"));
	h.clock.advance(15_000);
	sensorUp(h, { lastAgentStartAt: h.clock.now() - 3_000, idle: false });
	await h.engine.tick();
	assert.equal(enters(h).length, 1, "Enter exactly once");
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0].content, /reopened in a new tab/);
	assert.equal(h.toasts.length, 0);
	assert.equal(h.herdr.calls.some((args) => ["run", "send-text", "send-keys"].includes(args[1]) && args.includes("wB:p1")), false, "the crashed pane is never written to");
});

test("option 2: an Enter that does not start a run falls back to the human-needed notice, never a second Enter or a second omo", async () => {
	const h = harness();
	await reopenedWaiting(h);
	h.herdr.screen.text = CHOOSER;
	await h.engine.tick();
	assert.equal(enters(h).length, 1);
	for (let i = 0; i < 4; i++) {
		h.clock.advance(15_000);
		await h.engine.tick();
	}
	assert.equal(enters(h).length, 1);
	assert.equal(h.toasts.length, 1);
	assert.match(`${h.toasts[0].title} ${h.toasts[0].body}`, /작업을 시작하지 않음/);
	assert.doesNotMatch(h.toasts[0].body, /omo --session/, "a host already runs in the new tab");
	assert.equal(runs(h).length, 1);
});

test("option 2: a new tab without this session's omo, or a chooser on Leave stopped, gets no key and one notice at startupMs", async () => {
	for (const [label, sessionId, screen] of [["another session", OTHER_SID, CHOOSER], ["Leave stopped highlighted", SID, CHOOSER.replace(" → Resume goal", "   Resume goal").replace("   Leave stopped", " → Leave stopped")]]) {
		const h = harness();
		await reopenedWaiting(h, { sessionId });
		h.herdr.screen.text = screen;
		for (let i = 0; i < 14; i++) {
			await h.engine.tick();
			h.clock.advance(15_000);
		}
		assert.deepEqual(enters(h), [], label);
		assert.equal(h.toasts.length, 1, label);
	}
});

test("option 2: a session that runs at once (omo 5.1.60, no chooser) gets no key", async () => {
	const h = harness();
	await crash(h);
	h.clock.advance(15_000);
	h.live.set(NEW_HOST, hostRow(NEW_HOST, h.clock.now() - 5_000));
	sensorUp(h, { lastAgentStartAt: h.clock.now() - 2_000 });
	await h.engine.tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.herdr.calls.some((args) => args[1] === "send-keys" || args[1] === "send-text"), false);
});
