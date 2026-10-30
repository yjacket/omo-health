import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import sensor from "../extension/sensor.mjs";
import { renderStub } from "../src/install.mjs";
import { DAEMON_NODE_ARGS } from "../src/launch.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

beforeEach(() => {
	delete globalThis[Symbol.for("omo-health.sensor.active")];
});

/** Minimal fake of the senpi ExtensionAPI surface the sensor uses. */
function fakePi() {
	const handlers = new Map();
	const sent = [];
	const commands = new Map();
	const registered = { tools: 0 };
	// senpi's cross-extension bus (`pi.events.on(channel, data => ...)`), the C6 mirror the sensor reads.
	const busHandlers = new Map();
	return {
		pi: {
			cwd: "C:\\dev\\proj",
			sessionKind: "interactive",
			events: {
				on(event, handler) {
					if (!busHandlers.has(event)) busHandlers.set(event, []);
					busHandlers.get(event).push(handler);
					return () => {};
				},
			},
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			sendMessage(message, opts) {
				sent.push({ message, opts });
			},
			registerCommand(name, spec) {
				commands.set(name, spec);
			},
			registerTool() {
				registered.tools += 1;
			},
		},
		handlers,
		sent,
		commands,
		registered,
		async emit(event, ctx, payload = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		async busEmit(event, data) {
			for (const handler of busHandlers.get(event) ?? []) await handler(data);
		},
	};
}

function fakeCtx({ idle = true, sessionId = "s-1" } = {}) {
	const ui = { status: [], widgets: [] };
	const ctx = {
		cwd: "C:\\dev\\proj",
		hasUI: true,
		idleValue: idle,
		aborted: 0,
		isIdle() {
			return ctx.idleValue;
		},
		hasPendingMessages: () => false,
		abort() {
			ctx.aborted += 1;
		},
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `C:/s/${sessionId}.jsonl` },
		ui: {
			setStatus: (key, text) => ui.status.push([key, text]),
			setWidget: (key, lines) => ui.widgets.push([key, lines]),
		},
	};
	return { ctx, ui };
}

function setup({ daemonTs, stopped = false, execPath = "node.exe", env, platform = "linux", bus = true } = {}) {
	const home = tmpDir("omoh-sensor-");
	const repo = tmpDir("omoh-repo-");
	fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
	fs.writeFileSync(path.join(repo, "bin", "omo-health.mjs"), "// fake");
	let clock = 1_790_000_000_000;
	const timers = [];
	const spawned = [];
	if (daemonTs !== undefined) fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: 4242, ts: daemonTs(clock), mode: "auto" }));
	if (stopped) fs.writeFileSync(path.join(home, "stopped"), "x");
	const fp = fakePi();
	if (!bus) delete fp.pi.events;
	const handle = sensor(fp.pi, {
		healthHome: home,
		repoRoot: repo,
		now: () => clock,
		setInterval: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
		clearInterval: () => timers.splice(0),
		spawn: (cmd, args, opts) => (spawned.push({ cmd, args, opts }), { unref() {} }),
		execPath,
		env,
		// Plain detached spawn path; the Windows WMI path is covered in launch.test.mjs.
		platform,
	});
	const advance = (ms) => {
		clock += ms;
		return clock;
	};
	const fpEmit = fp.emit;
	fp.emit = async (event, ctx, payload) => {
		await fpEmit(event, ctx, payload);
		await handle.__test.settle();
	};
	return { home, repo, fp, handle, timers, spawned, advance, now: () => clock };
}

test("the sensor and what it loads import only node built-ins statically (a hot reload must not reuse stale repo modules)", () => {
	for (const file of ["extension/sensor.mjs", "src/launch.mjs"]) {
		const specs = [...fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
		assert.deepEqual(specs.filter((spec) => !spec.startsWith("node:")), [], file);
	}
});

test("the factory registers no tools and starts nothing until session_start", async () => {
	const s = setup({ daemonTs: (c) => c });
	assert.equal(s.fp.registered.tools, 0);
	assert.equal(s.timers.length, 0);
	assert.equal(s.fp.handlers.has("before_agent_start"), false);
	assert.ok(s.fp.commands.has("health"));
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	assert.deepEqual(s.timers.map((t) => t.ms).sort((a, b) => a - b), [3000, 5000, 10000, 10000, 60000]);
});

test("heartbeat lastInputAt moves only on operator input, not on agent events or extension-injected input", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx({ idle: false });
	const lastInputAt = async () => {
		await s.handle.__test.heartbeat();
		return JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8")).lastInputAt;
	};
	await s.fp.emit("session_start", ctx);
	const started = await lastInputAt();
	assert.equal(started, s.now(), "a fresh sensor counts its load as operator presence");
	for (const event of ["agent_start", "turn_start", "message_end", "tool_execution_start", "agent_settled"]) {
		s.advance(1000);
		await s.fp.emit(event, ctx);
	}
	s.advance(1000);
	await s.fp.emit("input", ctx, { type: "input", text: "goal continuation", source: "extension" });
	assert.equal(await lastInputAt(), started, "agent turns and extension messages are not operator input");
	s.advance(1000);
	await s.fp.emit("input", ctx, { type: "input", text: "hello", source: "interactive" });
	assert.equal(await lastInputAt(), s.now());
	const typedAt = s.now();
	s.advance(60_000);
	await s.fp.emit("input", ctx, { type: "input", text: "from rpc", source: "rpc" });
	assert.equal(await lastInputAt(), typedAt + 60_000);
	const hb = () => JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	assert.deepEqual(hb().humanInputs, [typedAt, typedAt + 60_000], "only operator inputs, not the load or extension input");
	for (let i = 0; i < 25; i++) {
		s.advance(1000);
		await s.fp.emit("input", ctx, { type: "input", text: `n${i}`, source: "interactive" });
	}
	await s.handle.__test.heartbeat();
	assert.equal(hb().humanInputs.length, 20, "the last 20");
	assert.equal(hb().humanInputs.at(-1), s.now());
});

test("an extension reload keeps the operator-input record; a reload of another session or a fresh start does not inherit it", async () => {
	const first = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	const hb = (s) => JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	await first.fp.emit("session_start", ctx, { type: "session_start", reason: "startup" });
	first.advance(1000);
	await first.fp.emit("input", ctx, { type: "input", text: "hello", source: "interactive" });
	const typedAt = first.now();
	await first.fp.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" });

	const second = setup({ daemonTs: (c) => c });
	second.advance(5 * 3600_000);
	await second.fp.emit("session_start", ctx, { type: "session_start", reason: "reload" });
	await second.handle.__test.heartbeat();
	assert.equal(hb(second).lastInputAt, typedAt, "the reload is not operator input");
	assert.deepEqual(hb(second).humanInputs, [typedAt]);

	await second.fp.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" });
	const other = setup({ daemonTs: (c) => c });
	await other.fp.emit("session_start", fakeCtx({ sessionId: "s-2" }).ctx, { type: "session_start", reason: "reload" });
	await other.handle.__test.heartbeat();
	const otherHb = JSON.parse(fs.readFileSync(path.join(other.home, "sensors", "s-2.json"), "utf8"));
	assert.equal(otherHb.lastInputAt, other.now(), "another session does not inherit the record");
	assert.deepEqual(otherHb.humanInputs, []);

	const fresh = setup({ daemonTs: (c) => c });
	await fresh.fp.emit("session_start", ctx, { type: "session_start", reason: "reload" });
	await fresh.handle.__test.heartbeat();
	assert.equal(hb(fresh).lastInputAt, fresh.now(), "the carry is used once");
});

test("heartbeat carries the fields the daemon reads", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx({ idle: false });
	await s.fp.emit("session_start", ctx);
	await s.fp.emit("tool_execution_start", ctx);
	fs.writeFileSync(path.join(s.repo, "package.json"), JSON.stringify({ version: "1.2.3" }));
	await s.handle.__test.heartbeat();
	const hb = JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	assert.equal(hb.sessionId, "s-1");
	assert.equal(hb.sensorVersion, "1.2.3", "G17: the release the sensor came from");
	assert.equal(hb.root, s.repo);
	assert.equal(hb.pid, process.pid);
	assert.equal(hb.idle, false);
	assert.equal(hb.executingTools, 1);
	assert.equal(hb.sessionFile, "C:/s/s-1.jsonl");
	assert.equal(typeof hb.lastEventAt, "number");
	assert.equal(hb.goalLivenessSchema, 1, "C6: every heartbeat declares the goal-liveness schema");
	assert.deepEqual(hb.wakeSources, {}, "no bus event yet");
	assert.deepEqual(hb.holds, []);
	assert.deepEqual(hb.goalWait, { armed: false, kind: null, dueAtMs: null });
	assert.equal(hb.lastAgentStartAt, null, "#109: no run started yet");
	s.advance(1000);
	await s.fp.emit("turn_start", ctx);
	await s.handle.__test.heartbeat();
	assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8")).lastAgentStartAt, null, "only agent_start marks a run");
	s.advance(1000);
	await s.fp.emit("agent_start", ctx);
	await s.handle.__test.heartbeat();
	assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8")).lastAgentStartAt, s.now());
	await s.fp.emit("session_shutdown", ctx);
	assert.equal(fs.existsSync(path.join(s.home, "sensors", "s-1.json")), false);
});

test("goal-wait bus channels land in the heartbeat as wake sources, holds and the armed timer", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const hb = async () => {
		await s.handle.__test.heartbeat();
		return JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	};
	assert.deepEqual((await hb()).goalWait, { armed: false, kind: null, dueAtMs: null }, "no timer before the first event");
	await s.fp.busEmit("wake_source_state", { source: "monitors", activeCount: 2 });
	await s.fp.busEmit("terminal_monitor_state", { activeCount: 1, monitors: [{ id: "m1", description: "watch" }] });
	await s.fp.busEmit("continuation_hold_state", { source: "omo-keepalive", active: true });
	await s.fp.busEmit("goal_continuation_timer_state", { armed: true, kind: "monitor", dueAtMs: s.now() + 300_000 });
	const beat = await hb();
	assert.deepEqual(beat.wakeSources, { monitors: 2, "terminal-monitors": 1 }, "terminal_monitor_state is recorded as terminal-monitors");
	assert.deepEqual(beat.holds, ["omo-keepalive"]);
	assert.deepEqual(beat.goalWait, { armed: true, kind: "monitor", dueAtMs: s.now() + 300_000 });
	assert.equal(beat.goalLivenessSchema, 1);
	s.handle.__test.stop();
});

test("a goal schedule's full source counts resync a sensor that missed a source's own event (reload)", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	await s.fp.busEmit("wake_source_state", { source: "omo-desk", activeCount: 0 });
	await s.fp.busEmit("goal_continuation_scheduled", { goalId: "g1", delayMs: 3_570_000, activeMonitorCount: 1, wakeSources: { "omo-desk": 0, "senpi-task": 0, "terminal-monitors": 1 } });
	await s.handle.__test.heartbeat();
	const beat = JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	assert.deepEqual(beat.wakeSources, { "omo-desk": 0, "senpi-task": 0, "terminal-monitors": 1 });
	s.handle.__test.stop();
});

test("a released hold leaves holds empty and an unarmed timer clears the goal wait", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const hb = async () => {
		await s.handle.__test.heartbeat();
		return JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	};
	await s.fp.busEmit("continuation_hold_state", { source: "omo-keepalive", active: true });
	await s.fp.busEmit("continuation_hold_state", { source: "second-source", active: true });
	await s.fp.busEmit("goal_continuation_timer_state", { armed: true, kind: "userGrace", dueAtMs: s.now() + 60_000 });
	await s.fp.busEmit("continuation_hold_state", { source: "omo-keepalive", active: false });
	assert.deepEqual((await hb()).holds, ["second-source"]);
	await s.fp.busEmit("goal_continuation_timer_state", { armed: false, kind: "monitor" });
	const cleared = await hb();
	assert.deepEqual(cleared.goalWait, { armed: false, kind: "monitor", dueAtMs: null }, "armed:false keeps the kind but drops the due time");
	await s.fp.busEmit("continuation_hold_state", { source: "second-source", active: false });
	assert.deepEqual((await hb()).holds, []);
	s.handle.__test.stop();
});

test("malformed bus payloads are ignored and a new session starts with the channels reset", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const hb = async () => {
		await s.handle.__test.heartbeat();
		return JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	};
	await s.fp.busEmit("wake_source_state", { source: "monitors", activeCount: 3 });
	await s.fp.busEmit("continuation_hold_state", { source: "omo-keepalive", active: true });
	await s.fp.busEmit("goal_continuation_timer_state", { armed: true, kind: "monitor", dueAtMs: s.now() + 60_000 });
	for (const [event, payload] of [
		["wake_source_state", null],
		["wake_source_state", { activeCount: 1 }],
		["wake_source_state", { source: "x", activeCount: "2" }],
		["terminal_monitor_state", { activeCount: -1 }],
		["terminal_monitor_state", {}],
		["continuation_hold_state", { source: "x" }],
		["continuation_hold_state", { active: true }],
		["goal_continuation_timer_state", { kind: "monitor" }],
		["goal_continuation_timer_state", "armed"],
		["goal_continuation_scheduled", { wakeSources: "x" }],
		["goal_continuation_scheduled", { wakeSources: { y: "1" } }],
	]) {
		await s.fp.busEmit(event, payload);
	}
	const beat = await hb();
	assert.deepEqual(beat.wakeSources, { monitors: 3 });
	assert.deepEqual(beat.holds, ["omo-keepalive"]);
	assert.deepEqual(beat.goalWait, { armed: true, kind: "monitor", dueAtMs: s.now() + 60_000 });
	await s.fp.emit("session_start", ctx);
	const fresh = await hb();
	assert.deepEqual([fresh.wakeSources, fresh.holds, fresh.goalWait], [{}, [], { armed: false, kind: null, dueAtMs: null }]);
	assert.equal(fresh.goalLivenessSchema, 1);
	s.handle.__test.stop();
});

test("a host without pi.events still heartbeats: the bus mirror is guarded", async () => {
	const s = setup({ daemonTs: (c) => c, bus: false });
	await s.fp.emit("session_start", fakeCtx().ctx);
	await s.handle.__test.heartbeat();
	const hb = JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
	assert.equal(hb.goalLivenessSchema, 1);
	assert.deepEqual([hb.wakeSources, hb.holds, hb.goalWait], [{}, [], { armed: false, kind: null, dueAtMs: null }]);
	s.handle.__test.stop();
});

test("heartbeat names the herdr pane only inside herdr", async () => {
	const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wB", HERDR_TAB_ID: "wB:t1", HERDR_PANE_ID: "wB:p1", HERDR_SOCKET_PATH: "C:/herdr.sock", HERDR_BIN_PATH: "C:/h/herdr.exe" };
	const inside = setup({ daemonTs: (c) => c, env });
	await inside.fp.emit("session_start", fakeCtx().ctx);
	await inside.handle.__test.heartbeat();
	const hb = JSON.parse(fs.readFileSync(path.join(inside.home, "sensors", "s-1.json"), "utf8"));
	assert.deepEqual(hb.terminal, { kind: "herdr", workspaceId: "wB", tabId: "wB:t1", paneId: "wB:p1", socketPath: "C:/herdr.sock", binPath: "C:/h/herdr.exe" });
	inside.handle.__test.stop();
	const outside = setup({ daemonTs: (c) => c, env: { HERDR_PANE_ID: "wB:p1" } });
	await outside.fp.emit("session_start", fakeCtx().ctx);
	await outside.handle.__test.heartbeat();
	assert.equal("terminal" in JSON.parse(fs.readFileSync(path.join(outside.home, "sensors", "s-1.json"), "utf8")), false, "no HERDR_ENV=1, no terminal");
	outside.handle.__test.stop();
});

test("inbox messages are delivered with their delivery options and receipted", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "inbox", "s-1"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "inbox", "s-1", "1-a.json"), JSON.stringify({ id: "a", kind: "relay", content: "hello", deliverAs: "followUp", triggerTurn: true, details: { taskId: "st_x" } }));
	await s.handle.__test.inbox();
	assert.equal(s.fp.sent.length, 1);
	assert.deepEqual(s.fp.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(s.fp.sent[0].message.customType, "omo-health");
	assert.equal(s.fp.sent[0].message.details.taskId, "st_x");
	assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "receipts", "a.json"), "utf8")).result, "delivered");
	assert.deepEqual(fs.readdirSync(path.join(s.home, "inbox", "s-1")), []);
});

test("an expired inbox message is dropped with an expired receipt; an unexpired one is delivered", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const dir = path.join(s.home, "inbox", "s-1");
	fs.mkdirSync(dir, { recursive: true });
	const now = s.now();
	const notice = (id, expiresMs) => ({ id, kind: "self-notice", content: `notice ${id}`, deliverAs: "followUp", triggerTurn: false, details: { actionKind: "kill-orphan-watchers", expiresMs } });
	fs.writeFileSync(path.join(dir, "1-old.json"), JSON.stringify(notice("old", now - 1)));
	fs.writeFileSync(path.join(dir, "2-new.json"), JSON.stringify(notice("new", now + 60_000)));
	await s.handle.__test.inbox();
	assert.deepEqual(s.fp.sent.map((item) => item.message.content), ["notice new"]);
	assert.deepEqual(s.fp.sent[0].opts, { deliverAs: "followUp", triggerTurn: false });
	const receipt = (id) => JSON.parse(fs.readFileSync(path.join(s.home, "receipts", `${id}.json`), "utf8")).result;
	assert.deepEqual([receipt("old"), receipt("new")], ["expired", "delivered"]);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test("scope-check preserves steer and nextTurn but never triggers a turn even for a malformed inbox item", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx({ idle: false });
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "inbox", "s-1"), { recursive: true });
	for (const [i, deliverAs] of ["steer", "nextTurn", "followUp"].entries()) {
		fs.writeFileSync(path.join(s.home, "inbox", "s-1", `${i}.json`), JSON.stringify({ id: `scope-${i}`, kind: "scope-check", content: "consider", deliverAs, triggerTurn: true }));
	}
	await s.handle.__test.inbox();
	assert.deepEqual(s.fp.sent.map((item) => item.opts), ["steer", "nextTurn", "followUp"].map((deliverAs) => ({ deliverAs, triggerTurn: false })));
	assert.equal(ctx.aborted, 0);
});

test("abort-continue aborts a running turn and resumes only once idle", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx({ idle: false });
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "inbox", "s-1"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "inbox", "s-1", "1-b.json"), JSON.stringify({ id: "b", kind: "abort-continue", content: "resume" }));
	await s.handle.__test.inbox();
	assert.equal(ctx.aborted, 1);
	assert.equal(s.fp.sent.length, 0, "no message while the aborted run is still settling");
	await s.handle.__test.inbox();
	assert.equal(s.fp.sent.length, 0);
	ctx.idleValue = true;
	await s.handle.__test.inbox();
	assert.equal(s.fp.sent.length, 1);
	assert.deepEqual(s.fp.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
});

test("footer priority: stopped, stale daemon, global crit, session text", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx, ui } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "status"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "status", "s-1.json"), JSON.stringify({ text: "헬스 ⚠ 세션 문제" }));
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "헬스 ⚠ 세션 문제");
	fs.writeFileSync(path.join(s.home, "status", "_global.json"), JSON.stringify({ level: "crit", text: "헬스 ✖ 계정 차단", humanNeeded: [{ titleKo: "x" }] }));
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "헬스 ✖ 계정 차단");
	s.advance(60_000);
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "👀 감시기");
	fs.writeFileSync(path.join(s.home, "stopped"), "x");
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "👀 중지");
});

test("the footer is colored by level with the host theme: red crit, yellow warn, green ok, dim stopped", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx, ui } = fakeCtx();
	ctx.ui.theme = { fg: (color, text) => `<${color}>${text}` };
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "status"), { recursive: true });
	const write = (status) => fs.writeFileSync(path.join(s.home, "status", "s-1.json"), JSON.stringify(status));
	write({ level: "ok", text: "👀 정상" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "<success>👀 정상");
	write({ level: "warn", text: "👀 멈춤" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "<warning>👀 멈춤");
	write({ level: "crit", text: "👀 로그인" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "<error>👀 로그인");
	fs.writeFileSync(path.join(s.home, "stopped"), "x");
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "<dim>👀 중지");
	ctx.ui.theme = { fg: () => {
		throw new Error("unknown color");
	} };
	fs.rmSync(path.join(s.home, "stopped"));
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "👀 로그인", "a theme failure leaves the plain text");
});

test("footer shows the more severe of global and session; a degraded global warn does not hide a session crit", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx, ui } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "status"), { recursive: true });
	const write = (name, value) => fs.writeFileSync(path.join(s.home, "status", name), JSON.stringify(value));
	write("_global.json", { level: "warn", degraded: true, text: "헬스 ⚠ 감시 데이터 형식 변경 감지(일부 감시 불완전)", humanNeeded: [] });
	write("s-1.json", { level: "crit", text: "헬스 ✖ 세션 멈춤" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "헬스 ✖ 세션 멈춤");
	write("s-1.json", { level: "ok", text: "헬스 ✓" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "헬스 ⚠ 감시 데이터 형식 변경 감지(일부 감시 불완전)");
	write("s-1.json", { level: "warn", text: "헬스 ⚠ 세션 문제" });
	await s.handle.__test.status();
	assert.equal(ui.status.at(-1)[1], "헬스 ⚠ 세션 문제", "a tie goes to the session");
});

test("a stale daemon is respawned once (claim + cooldown); a stopped one is not", async () => {
	const s = setup({ daemonTs: (c) => c - 120_000 });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	await s.handle.__test.ensureDaemon();
	assert.equal(s.spawned.length, 1);
	assert.deepEqual(s.spawned[0].args.slice(-1), ["daemon"]);
	assert.deepEqual(s.spawned[0].args.slice(0, DAEMON_NODE_ARGS.length), [...DAEMON_NODE_ARGS], "the daemon starts with the same V8 limits as every launcher");
	assert.equal(s.spawned[0].opts.detached, true);
	assert.equal(s.spawned[0].opts.windowsHide, true);
	await s.handle.__test.ensureDaemon();
	assert.equal(s.spawned.length, 1, "cooldown");
	const stopped = setup({ daemonTs: (c) => c - 120_000, stopped: true });
	await stopped.fp.emit("session_start", fakeCtx().ctx);
	await stopped.handle.__test.ensureDaemon();
	assert.equal(stopped.spawned.length, 0);
});

test("a stale daemon is restarted through the installed bootstrap when app/boot.mjs exists", async () => {
	const s = setup({ daemonTs: (c) => c - 120_000 });
	const boot = path.join(s.home, "app", "boot.mjs");
	fs.mkdirSync(path.dirname(boot), { recursive: true });
	fs.writeFileSync(boot, "// boot");
	await s.fp.emit("session_start", fakeCtx().ctx);
	assert.equal(s.spawned.length, 1);
	assert.deepEqual(s.spawned[0].args.slice(DAEMON_NODE_ARGS.length), [boot, "daemon"]);
});

test("three failed spawns keep using the installed bootstrap and record unavailable deaths at most once per 30 minutes", async () => {
	const s = setup({ daemonTs: (c) => c - 120_000 });
	const app = path.join(s.home, "app");
	fs.mkdirSync(app, { recursive: true });
	fs.writeFileSync(path.join(app, "boot.mjs"), "// fake");
	await s.fp.emit("session_start", fakeCtx().ctx);
	const script = (index) => s.spawned[index].args.at(-2);
	assert.equal(script(0), path.join(app, "boot.mjs"));
	s.advance(120_000);
	await s.handle.__test.ensureDaemon();
	assert.equal(script(1), path.join(app, "boot.mjs"));
	s.advance(120_000);
	await s.handle.__test.ensureDaemon();
	assert.equal(script(2), path.join(app, "boot.mjs"));
	s.advance(120_000);
	await s.handle.__test.ensureDaemon();
	const deaths = path.join(s.home, "deaths");
	assert.equal(fs.readdirSync(deaths).length, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(deaths, fs.readdirSync(deaths)[0]))), { kind: "daemon-unavailable", spawns: 3, lastHb: 1_790_000_000_000 - 120_000 });
	s.advance(120_000);
	await s.handle.__test.ensureDaemon();
	assert.equal(fs.readdirSync(deaths).length, 1);
	s.advance(30 * 60_000);
	await s.handle.__test.ensureDaemon();
	assert.equal(fs.readdirSync(deaths).length, 2);
	fs.writeFileSync(path.join(s.home, "daemon.json"), JSON.stringify({ pid: 4242, ts: s.now() }));
	await s.handle.__test.ensureDaemon();
	s.advance(120_000);
	await s.handle.__test.ensureDaemon();
	assert.equal(s.spawned.at(-1).args.at(-2), path.join(app, "boot.mjs"), "a fresh heartbeat resets the fallback streak");
});

test("stale extension generation stops all timers and logs the error only once", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	ctx.ui.setStatus = () => { throw new Error("stale extension generation after reload"); };
	s.advance(60_000);
	await s.handle.__test.status();
	assert.equal(s.timers.length, 0);
	await s.fp.emit("session_start", ctx);
	assert.equal(s.timers.length, 0, "invalidated sensor cannot restart");
	await s.handle.__test.status();
	const log = fs.readFileSync(path.join(s.home, "logs", "sensor-errors.log"), "utf8");
	assert.equal(log.match(/stale extension generation after reload/g)?.length, 1);
});

test("a bun-hosted sensor starts the daemon with Node from PATH, not bun", async () => {
	const bin = tmpDir("omoh-node-bin-");
	const node = path.join(bin, "node.exe");
	fs.writeFileSync(node, "");
	const s = setup({ daemonTs: (c) => c - 120_000, execPath: "C:/bun/bun.exe", platform: "win32", env: { PATH: bin, OMO_HEALTH_HOME: "sandbox" } });
	await s.fp.emit("session_start", fakeCtx().ctx);
	assert.equal(s.spawned.length, 1);
	assert.equal(s.spawned[0].cmd, node);
});

test("/health widget toggles a widget with incidents", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx, ui } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	fs.mkdirSync(path.join(s.home, "status"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "status", "_global.json"), JSON.stringify({ level: "ok", text: "헬스 ✓", incidents: [{ fp: "f1", titleKo: "읽기 명령 폭주", firstSeenMs: s.now(), actions: ["kill-pids:execute"], reportPath: "C:/r.md" }] }));
	await s.fp.commands.get("health").handler("widget", ctx);
	assert.equal(ui.widgets.at(-1)[0], "omo-health");
	assert.ok(ui.widgets.at(-1)[1].some((line) => line.includes("kill-pids:execute")));
	await s.fp.commands.get("health").handler("widget", ctx);
	assert.equal(ui.widgets.at(-1)[1], undefined);
	s.handle.__test.stop();
});

test("heartbeat names the Orca terminal and leaves other terminals absent", async () => {
	const read = async (env) => {
		const s = setup({ daemonTs: (c) => c, env });
		await s.fp.emit("session_start", fakeCtx().ctx);
		await s.handle.__test.heartbeat();
		const hb = JSON.parse(fs.readFileSync(path.join(s.home, "sensors", "s-1.json"), "utf8"));
		s.handle.__test.stop();
		return hb;
	};
	assert.deepEqual((await read({ TERM_PROGRAM: "Orca", ORCA_TAB_ID: "tab-1", ORCA_WORKTREE_ID: "wt-1", ORCA_APP_VERSION: "1.4.2" })).terminal, { kind: "orca", tabId: "tab-1", worktreeId: "wt-1", appVersion: "1.4.2" });
	assert.deepEqual((await read({ ORCA_TAB_ID: "tab-2" })).terminal, { kind: "orca", tabId: "tab-2", worktreeId: null, appVersion: null });
	assert.deepEqual((await read({ TERM_PROGRAM: "Orca" })).terminal, { kind: "orca", tabId: null, worktreeId: null, appVersion: null });
	assert.equal("terminal" in (await read({ TERM_PROGRAM: "vscode" })), false);
});

test("the stub stays inert when the sensor path is missing", async () => {
	const tpl = fs.readFileSync(new URL("../extension/stub.ts.tpl", import.meta.url), "utf8");
	const dir = tmpDir("omoh-stub-");
	const js = renderStub(tpl, { version: "0.0.1", root: path.join(dir, "missing") }).replace(/: any/g, "");
	const file = path.join(dir, "stub.mjs");
	fs.writeFileSync(file, js);
	const mod = await import(new URL(`file:///${file.replace(/\\/g, "/")}`).href);
	const fp = fakePi();
	const previous = process.env.OMO_HEALTH_HOME;
	process.env.OMO_HEALTH_HOME = path.join(dir, "home");
	try {
		await mod.default(fp.pi);
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_HOME;
		else process.env.OMO_HEALTH_HOME = previous;
	}
	assert.equal(fp.handlers.size, 0);
	assert.match(fs.readFileSync(path.join(dir, "home", "logs", "sensor-stub.log"), "utf8"), /pid=\d+ /, "the failure is recorded for doctor");
});

test("the stub loads the real sensor through a native import", async () => {
	const tpl = fs.readFileSync(new URL("../extension/stub.ts.tpl", import.meta.url), "utf8");
	const sensorPath = new URL("../extension/sensor.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
	const dir = tmpDir("omoh-stub2-");
	const js = renderStub(tpl, { version: "0.0.1", root: path.resolve(path.dirname(sensorPath), "..") }).replace(/: any/g, "");
	const file = path.join(dir, "stub.mjs");
	fs.writeFileSync(file, js);
	const mod = await import(new URL(`file:///${file.replace(/\\/g, "/")}`).href);
	const fp = fakePi();
	// A sandbox home without app/current.json: the stub must not read the real one, and uses the baked root.
	const previous = process.env.OMO_HEALTH_HOME;
	process.env.OMO_HEALTH_HOME = path.join(dir, "home");
	try {
		await mod.default(fp.pi);
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_HOME;
		else process.env.OMO_HEALTH_HOME = previous;
	}
	assert.equal(fs.existsSync(path.join(dir, "home", "logs", "sensor-stub.log")), false, "a missing pointer is not a failure");
	assert.ok(fp.handlers.has("session_start"));
	assert.ok(fp.commands.has("health"));
});

/** A sensor whose spawn is a scripted fake; `script(child)` runs once the sensor has attached its listeners. */
function uiSetup({ script, execPath = "node.exe", env, platform = "linux", withBoot = false, spawnThrows = false } = {}) {
	const home = tmpDir("omoh-ui-");
	const repo = tmpDir("omoh-uirepo-");
	fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
	fs.writeFileSync(path.join(repo, "bin", "omo-health.mjs"), "// fake");
	if (withBoot) {
		fs.mkdirSync(path.join(home, "app"), { recursive: true });
		fs.writeFileSync(path.join(home, "app", "boot.mjs"), "// boot");
	}
	const calls = [];
	const children = [];
	const fp = fakePi();
	sensor(fp.pi, {
		healthHome: home,
		repoRoot: repo,
		execPath,
		env,
		platform,
		uiStartTimeoutMs: 50,
		setInterval: () => ({ unref() {} }),
		clearInterval() {},
		spawn: (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			if (spawnThrows) throw new Error("spawn EPERM");
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.killed = 0;
			child.kill = () => {
				child.killed += 1;
			};
			children.push(child);
			setImmediate(() => script?.(child));
			return child;
		},
	});
	const { ctx, ui } = fakeCtx();
	const notes = [];
	ctx.ui.notify = (text, level) => notes.push([text, level]);
	return { home, repo, fp, calls, children, ctx, ui, notes, run: () => fp.commands.get("health").handler("ui", ctx) };
}

test("/health ui runs the ui --json launcher with piped stdio and reports the url", async () => {
	const s = uiSetup({
		withBoot: false,
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:1/#t=x"}\n');
			child.emit("close", 0);
		},
	});
	await s.run();
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.calls[0].args, [path.join(s.repo, "bin", "omo-health.mjs"), "ui", "--json"]);
	assert.equal(s.calls[0].opts.stdio[1], "pipe");
	assert.equal(s.calls[0].opts.windowsHide, true);
	assert.equal(s.notes.length, 1);
	assert.match(s.notes[0][0], /^대시보드를 열었습니다: http:\/\/127\.0\.0\.1:1\/#t=x\n\(/);
});

test("plain /health opens the dashboard instead of the widget", async () => {
	const s = uiSetup({
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:6/#t=z","port":6,"opened":true}\n');
			child.emit("close", 0);
		},
	});
	await s.fp.commands.get("health").handler("", s.ctx);
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.calls[0].args.slice(1), ["ui", "--json"]);
	assert.match(s.notes[0][0], /^대시보드를 브라우저에서 열었습니다 \(포트 6\)/);
	assert.equal(s.ui.widgets.length, 0, "no widget when the dashboard opened");
});

test("plain /health falls back to the widget when the dashboard cannot be launched", async () => {
	const s = uiSetup({ spawnThrows: true });
	await s.fp.commands.get("health").handler("", s.ctx);
	assert.equal(s.calls.length, 1);
	assert.equal(s.ui.widgets.at(-1)[0], "omo-health");
	assert.ok(s.ui.widgets.at(-1)[1][0].startsWith("omo-health:"));
});

test("/health ui keeps the token out of the notify text once the launcher opened the browser", async () => {
	// Given a launcher that reports opened: true
	const s = uiSetup({
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:4/#t=secret","port":4,"opened":true}\n');
			child.emit("close", 0);
		},
	});
	await s.run();
	// Then the notify text names the port but carries neither the token nor the url
	assert.equal(s.notes.length, 1);
	assert.doesNotMatch(s.notes[0][0], /#t=|secret/);
	assert.match(s.notes[0][0], /^대시보드를 브라우저에서 열었습니다 \(포트 4\)\n/);
});

test("/health ui shows the tokenised url when the launcher could not open the browser", async () => {
	const s = uiSetup({
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:5/#t=secret","port":5,"opened":false}\n');
			child.emit("close", 0);
		},
	});
	await s.run();
	assert.match(s.notes[0][0], /^대시보드를 열었습니다: http:\/\/127\.0\.0\.1:5\/#t=secret\n\(/);
});

test("/health ui prefers the installed bootstrap and falls back to a widget without notify", async () => {
	const s = uiSetup({
		withBoot: true,
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:2/#t=y"}\n');
			child.emit("close", 0);
		},
	});
	s.ctx.ui.notify = undefined;
	await s.run();
	assert.equal(s.calls[0].args[0], path.join(s.home, "app", "boot.mjs"));
	assert.equal(s.ui.widgets.at(-1)[1].length, 2);
	assert.match(s.ui.widgets.at(-1)[1][0], /http:\/\/127\.0\.0\.1:2\//);
});

test("/health ui explains an old runtime, bad output, a non-zero exit and a hung launcher", async () => {
	const old = uiSetup({
		script: (child) => {
			child.stderr.emit("data", "unknown command: ui\n");
			child.emit("close", 2);
		},
	});
	await old.run();
	assert.equal(old.notes[0][0], "대시보드를 열지 못했습니다: 이 버전의 omo-health에는 ui 명령이 없습니다");

	const bad = uiSetup({
		script: (child) => {
			child.stdout.emit("data", "not json\n");
			child.emit("close", 0);
		},
	});
	await bad.run();
	assert.match(bad.notes[0][0], /^대시보드를 열지 못했습니다: /);

	const failed = uiSetup({
		script: (child) => {
			child.stderr.emit("data", "boom\n");
			child.emit("close", 1);
		},
	});
	await failed.run();
	assert.equal(failed.notes[0][0], "대시보드를 열지 못했습니다: boom");

	const hung = uiSetup({});
	await hung.run();
	assert.equal(hung.children[0].killed, 1, "a launcher past uiStartTimeoutMs is killed");
	assert.match(hung.notes[0][0], /^대시보드를 열지 못했습니다: /);
});

test("/health ui never rejects when spawn throws or the child errors", async () => {
	const thrown = uiSetup({ spawnThrows: true });
	await thrown.run();
	assert.match(thrown.notes[0][0], /^대시보드를 열지 못했습니다: spawn EPERM/);

	const errored = uiSetup({ script: (child) => child.emit("error", new Error("ENOENT")) });
	await errored.run();
	assert.equal(errored.notes[0][0], "대시보드를 열지 못했습니다: ENOENT");
});

test("a bun-hosted sensor opens the dashboard with Node from PATH", async () => {
	const bin = tmpDir("omoh-node-bin-");
	const node = path.join(bin, "node.exe");
	fs.writeFileSync(node, "");
	const s = uiSetup({
		execPath: "C:/bun/bun.exe",
		platform: "win32",
		env: { PATH: bin, OMO_HEALTH_HOME: "sandbox" },
		script: (child) => {
			child.stdout.emit("data", '{"url":"http://127.0.0.1:3/#t=z"}\n');
			child.emit("close", 0);
		},
	});
	await s.run();
	assert.equal(s.calls[0].cmd, node);
	assert.match(s.notes[0][0], /^대시보드를 열었습니다/);
});

test("/health report queues a report on this session or a named task for the daemon and registers no tool", async () => {
	const s = setup({ daemonTs: (c) => c });
	const { ctx, ui } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const health = s.fp.commands.get("health");
	const intake = path.join(s.home, "intake");
	await health.handler("report 서브에이전트가  멈춘 것 같다", ctx);
	assert.match(ui.widgets.at(-1)[1][0], /^보고 접수됨 \[/);
	s.advance(1000);
	await health.handler("report st_01a0ed19 77분째 조용함", ctx);
	s.advance(1000);
	await health.handler("report", ctx);
	assert.match(ui.widgets.at(-1)[1][0], /보고할 내용을 적어 주세요/);
	const names = fs.readdirSync(intake).sort();
	const reports = names.map((name) => JSON.parse(fs.readFileSync(path.join(intake, name), "utf8")));
	assert.deepEqual(reports.map((r) => [r.v, r.via, r.subject, r.reporterSessionId, r.text]), [
		[1, "sensor", "s-1", "s-1", "서브에이전트가  멈춘 것 같다"],
		[1, "sensor", "st_01a0ed19", "s-1", "77분째 조용함"],
	]);
	assert.deepEqual(names, reports.map((r) => `${r.atMs}-${r.id}.json`), "the daemon reads the queue in time order");
	assert.equal(s.fp.registered.tools, 0);
	s.handle.__test.stop();
});

function upgradeSetup({ idle }) {
	const s = setup();
	const { ctx } = fakeCtx({ idle });
	s.reloads = 0;
	ctx.reload = async () => {
		s.reloads += 1;
	};
	s.ctx = ctx;
	s.install = (root) => {
		fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "app", "current.json"), JSON.stringify({ channel: "pinned", root }));
	};
	s.check = async () => {
		await s.handle.__test.upgradeCheck();
		await s.handle.__test.settle();
	};
	return s;
}

test("a sensor running from an older root asks senpi to reload once the session is idle, at most three times per root", async () => {
	const s = upgradeSetup({ idle: false });
	const newRoot = tmpDir("omoh-new-");
	fs.mkdirSync(path.join(newRoot, "extension"), { recursive: true });
	fs.writeFileSync(path.join(newRoot, "extension", "sensor.mjs"), "// new");
	s.install(newRoot);
	await s.fp.emit("session_start", s.ctx);
	await s.check();
	assert.equal(s.reloads, 0, "a busy session is not reloaded");
	s.ctx.idleValue = true;
	await s.check();
	assert.equal(s.reloads, 1);
	await s.check();
	assert.equal(s.reloads, 1, "no second request inside the retry window");
	for (let i = 0; i < 4; i++) {
		s.advance(10 * 60_000);
		await s.check();
	}
	assert.equal(s.reloads, 3, "at most three requests for one root");
});

test("a sensor already on the installed root, with no installed release, or with a release missing its sensor never reloads", async () => {
	const s = upgradeSetup({ idle: true });
	await s.fp.emit("session_start", s.ctx);
	await s.check();
	s.install(s.repo);
	await s.check();
	s.install(tmpDir("omoh-empty-"));
	await s.check();
	assert.equal(s.reloads, 0);
});

test("package setup is skipped when current points at the matching clone sha", async () => {
	const s = setup();
	const ref = "refs/heads/main";
	fs.mkdirSync(path.join(s.repo, ".git", "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, ".git", "HEAD"), `ref: ${ref}\n`);
	fs.writeFileSync(path.join(s.repo, ".git", ref), `${"a".repeat(40)}\n`);
	fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "app", "boot.mjs"), "");
	fs.writeFileSync(path.join(s.home, "app", "current.json"), JSON.stringify({ channel: "package", source: s.repo, sha: "a".repeat(40) }));
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const pkg = sensor(s.fp.pi, { source: s.repo, healthHome: s.home, now: s.now, spawn: (...args) => s.spawned.push(args), platform: "linux" });
	await pkg.__test.packageCheck();
	assert.equal(s.spawned.length, 0);
});

test("setupOnly omits health command and heartbeat while full sensor generation is unique", async () => {
	const first = setup();
	const second = fakePi();
	const home = tmpDir("omoh-setup-only-");
	const setupOnly = sensor(second.pi, { source: first.repo, setupOnly: true, healthHome: home });
	assert.equal(second.commands.has("health"), false);
	assert.deepEqual([...second.handlers.keys()], ["session_start", "session_shutdown"]);
	setupOnly.__test.stop();
});

test("event contexts use requestReload and retain command-context reload compatibility", async () => {
	const s = upgradeSetup({ idle: true });
	const root = tmpDir("omoh-new-root-");
	fs.mkdirSync(path.join(root, "extension"), { recursive: true });
	fs.writeFileSync(path.join(root, "extension", "sensor.mjs"), "");
	s.install(root);
	let requested = 0;
	delete s.ctx.reload;
	s.ctx.requestReload = () => { requested++; };
	await s.fp.emit("session_start", s.ctx);
	await s.check();
	assert.equal(requested, 1);
});

test("/health uninstall and install spawn detached package commands", async () => {
	const home = tmpDir("omoh-health-command-");
	const source = tmpDir("omoh-health-source-");
	fs.mkdirSync(path.join(source, "bin"), { recursive: true });
	fs.writeFileSync(path.join(source, "bin", "omo-health.mjs"), "");
	const fp = fakePi();
	const calls = [];
	sensor(fp.pi, { source, healthHome: home, spawn: (cmd, args, opts) => (calls.push({ cmd, args, opts }), { unref() {} }) });
	const { ctx } = fakeCtx();
	await fp.commands.get("health").handler("uninstall --purge", ctx);
	await fp.commands.get("health").handler("install", ctx);
	assert.deepEqual(calls.map((call) => call.args.slice(1)), [["uninstall", "--purge"], ["install", "--from-package"]]);
	assert.ok(calls.every((call) => call.opts.detached && call.opts.windowsHide && call.opts.stdio === "ignore"));
});

test("package setup claims a changed clone once and uses the detached Node setup command", async () => {
	const s = setup();
	fs.mkdirSync(path.join(s.repo, ".git", "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, ".git", "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(s.repo, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
	const handler = fakePi();
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const sensorWithSource = sensor(handler.pi, { source: s.repo, healthHome: s.home, now: s.now, platform: "linux", env: {}, spawn: (cmd, args, opts) => (s.spawned.push({ cmd, args, opts }), { unref() {} }) });
	await sensorWithSource.__test.packageCheck();
	await sensorWithSource.__test.packageCheck();
	assert.equal(s.spawned.length, 1);
	assert.deepEqual(s.spawned[0].args, [path.join(s.repo, "bin", "omo-health.mjs"), "install", "--from-package"]);
	assert.deepEqual({ detached: s.spawned[0].opts.detached, windowsHide: s.spawned[0].opts.windowsHide, stdio: s.spawned[0].opts.stdio, cwd: s.spawned[0].opts.cwd }, { detached: true, windowsHide: true, stdio: "ignore", cwd: s.home });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, "app", "setup-state.json"))), { sha: "b".repeat(40), claimMs: s.now(), pid: process.pid });
});

test("package setup skips dev and stopped states and ensureDaemon waits for package boot", async () => {
	const s = setup();
	fs.mkdirSync(path.join(s.repo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, ".git", "HEAD"), `${"c".repeat(40)}\n`);
	fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "app", "current.json"), JSON.stringify({ channel: "dev" }));
	const fp = fakePi();
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const sensorWithSource = sensor(fp.pi, { source: s.repo, healthHome: s.home, now: s.now, platform: "linux", env: {}, spawn: (...args) => s.spawned.push(args) });
	await sensorWithSource.__test.packageCheck();
	assert.deepEqual(fs.readdirSync(path.join(s.home, "app")), ["current.json"]);
	fs.writeFileSync(path.join(s.home, "app", "current.json"), "{}");
	await sensorWithSource.__test.packageCheck();
	assert.equal(s.spawned.length, 1);
	s.handle.__test.stop();
	const stopped = setup({ stopped: true });
	const h = fakePi();
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const stoppedSensor = sensor(h.pi, { source: stopped.repo, healthHome: stopped.home, now: stopped.now, env: {}, spawn: (...args) => stopped.spawned.push(args) });
	await stoppedSensor.__test.packageCheck();
	await stoppedSensor.__test.ensureDaemon();
	assert.deepEqual(stopped.spawned, []);
});

test("a second full sensor for the same generation registers nothing", () => {
	const s = setup();
	const duplicate = fakePi();
	sensor(duplicate.pi, { healthHome: s.home, repoRoot: s.repo });
	const second = fakePi();
	sensor(second.pi, { healthHome: s.home, repoRoot: s.repo });
	assert.equal(second.handlers.size, 0);
	assert.equal(second.commands.size, 0);
});

test("a reload frees the generation so the next full sensor registers again", async () => {
	const s = setup();
	await s.fp.emit("session_shutdown", fakeCtx(), { reason: "reload" });
	const next = fakePi();
	sensor(next.pi, { healthHome: s.home, repoRoot: s.repo });
	assert.ok(next.commands.has("health"));
	assert.ok(next.handlers.has("session_start"));
});

test("package setup records spawn failure and backs off for that clone sha", async () => {
	const s = setup();
	fs.mkdirSync(path.join(s.repo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, ".git", "HEAD"), `${"d".repeat(40)}\n`);
	const child = new EventEmitter();
	child.unref = () => {};
	let calls = 0;
	const fp = fakePi();
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const instance = sensor(fp.pi, { source: s.repo, healthHome: s.home, now: s.now, env: {}, spawn: () => (calls++, child) });
	await instance.__test.packageCheck();
	const statePath = path.join(s.home, "app", "setup-state.json");
	const changed = new Promise((resolve, reject) => {
		const watcher = fs.watch(statePath, () => {
			watcher.close();
			resolve();
		});
		watcher.on("error", reject);
	});
	child.emit("error", new Error("spawn failed"));
	await changed;
	const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
	assert.deepEqual(state, { sha: "d".repeat(40), failedMs: s.now(), error: "spawn failed" });
	await instance.__test.packageCheck();
	assert.equal(calls, 1);
});

test("stopped suspends sensor writes and heartbeat resumes after stopped is removed", async () => {
	const s = setup({ stopped: true });
	const { ctx } = fakeCtx();
	await s.fp.emit("session_start", ctx);
	const snapshot = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) =>
		entry.isDirectory() ? [entry.name, snapshot(path.join(dir, entry.name))] : [entry.name, fs.readFileSync(path.join(dir, entry.name), "utf8")],
	);
	const before = snapshot(s.home);
	await s.handle.__test.heartbeat();
	await s.handle.__test.inbox();
	await s.handle.__test.ensureDaemon();
	assert.deepEqual(snapshot(s.home), before);
	fs.rmSync(path.join(s.home, "stopped"));
	await s.handle.__test.heartbeat();
	assert.ok(fs.existsSync(path.join(s.home, "sensors", "s-1.json")));
});

test("package ensureDaemon does not start a checkout when app boot is missing", async () => {
	const s = setup({ daemonTs: (c) => c - 120_000 });
	const fp = fakePi();
	delete globalThis[Symbol.for("omo-health.sensor.active")];
	const instance = sensor(fp.pi, { source: s.repo, healthHome: s.home, now: s.now, env: {}, platform: "linux", spawn: (...args) => s.spawned.push(args) });
	await instance.__test.ensureDaemon();
	assert.deepEqual(s.spawned, []);
});

test("setupOnly migration reload waits for package activation, removed stub and idle session", async () => {
	const s = setup();
	const sha = "e".repeat(40);
	fs.mkdirSync(path.join(s.repo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, ".git", "HEAD"), `${sha}\n`);
	fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
	fs.writeFileSync(path.join(s.home, "app", "boot.mjs"), "");
	fs.mkdirSync(path.join(s.repo, "extension"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, "extension", "sensor.mjs"), "");
	const omoHome = tmpDir("omoh-migration-");
	const stub = path.join(omoHome, "agent", "extensions", "omo-health-sensor.ts");
	fs.mkdirSync(path.dirname(stub), { recursive: true });
	fs.writeFileSync(stub, "");
	const fp = fakePi();
	let reloads = 0;
	const instance = sensor(fp.pi, { source: s.repo, setupOnly: true, healthHome: s.home, env: { OMO_HEALTH_OMO_HOME: omoHome }, now: s.now });
	const { ctx } = fakeCtx({ idle: false });
	ctx.requestReload = () => reloads++;
	await fp.emit("session_start", ctx);
	fs.writeFileSync(path.join(s.home, "app", "current.json"), JSON.stringify({ channel: "package", sha, source: s.repo }));
	await instance.__test.packageCheck();
	assert.equal(reloads, 0, "package activation alone does not bypass the legacy stub");
	fs.rmSync(stub);
	await instance.__test.packageCheck();
	assert.equal(reloads, 0, "busy session is not reloaded");
	ctx.idleValue = true;
	await instance.__test.packageCheck();
	await instance.__test.packageCheck();
	assert.equal(reloads, 1, "idle migration requests a single reload");
});

test("upgradeCheck still uses the command-context reload alias when requestReload is absent", async () => {
	const s = upgradeSetup({ idle: true });
	const root = tmpDir("omoh-reload-alias-");
	fs.mkdirSync(path.join(root, "extension"), { recursive: true });
	fs.writeFileSync(path.join(root, "extension", "sensor.mjs"), "");
	s.install(root);
	await s.fp.emit("session_start", s.ctx);
	await s.check();
	assert.equal(s.reloads, 1);
});
