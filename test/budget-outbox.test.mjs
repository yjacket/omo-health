import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBudgetOffice } from "../src/budget/office.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createFakeRunner } from "./fakes/runner.mjs";
import { E, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";

const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SID = "main-0001";
const PID = `${SID}:g1`;
const secs = (ms) => Math.trunc(ms / 1000);

function sources(clock, sessions) {
	return {
		procs: { snapshot: async () => ({ takenAtMs: clock.now(), rows: [] }), os: async () => ({}), ports: async () => [], close() {} },
		registry: { refresh: () => ({ sessions, tasks: [] }) },
		logs: { read() {}, drain: () => [], stats: new Map() },
		versions: () => ({ omoAi: "1.0.0", senpi: "1.0.0" }),
	};
}

/** Real office + real engine on one in-memory DB; `state.sensor` makes the session have a fresh sensor. */
function setup(t) {
	const root = tmpDir("omoh-outbox-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(T0);
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const config = structuredClone(DEFAULT_CONFIG);
	config.budget.enabled = true;
	const sessions = new Map([[SID, sessionState({ id: SID, kind: "main" })]]);
	const state = { sensor: false };
	const makeEngine = () => {
		const runner = createFakeRunner();
		runner.jobDir = (jobId) => path.join(paths.health.jobsDir, jobId);
		const office = createBudgetOffice({ paths, db, clock, config, runner, loggedInProviders: () => new Set() });
		const engine = createEngine({
			paths,
			config,
			mode: "auto",
			clock,
			detectors: [],
			sources: sources(clock, sessions),
			actors: {
				budget: office,
				sensors: () => (state.sensor ? new Map([[SID, { sessionId: SID, ts: clock.now(), pid: 4242 }]]) : new Map()),
				notifier: { toast: () => ({ ok: true }) },
			},
			options: { selfPid: 1 },
		});
		return { office, engine };
	};
	return { root, paths, clock, config, db, state, sessions, store: createBudgetStore(db), makeEngine };
}

/** One active goal that spent $15 (>= the $10 estimate threshold). */
function seed(h) {
	const cwd = path.join(h.root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const dir = path.join(h.paths.sessionsDir, "--proj--");
	const goalDir = path.join(dir, "extensions", "goal");
	fs.mkdirSync(goalDir, { recursive: true });
	fs.writeFileSync(path.join(goalDir, `${SID}.json`), JSON.stringify({ version: 1, goal: { status: "active", id: "g1", objective: "keep the budget message", createdAt: secs(T0 - 3 * HOUR), updatedAt: secs(T0 - 3 * HOUR) } }));
	writeJsonl(path.join(dir, `2026-11-10T00-00-00-000Z_${SID}.jsonl`), [
		E.header(SID, cwd, T0 - 3 * HOUR),
		E.assistant({ ms: T0 - 2 * HOUR, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 15 } }, text: "working" }),
	]);
}

function inboxMessages(paths, sessionId) {
	const dir = path.join(paths.health.inboxDir, sessionId);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

function outbox(h) {
	return h.store.getProject(PID).data.outbox ?? [];
}

test("(a) a missing sensor loses no message: nothing is delivered, the project outbox holds the request", async (t) => {
	const h = setup(t);
	seed(h);
	await h.makeEngine().engine.tick();
	assert.deepEqual(inboxMessages(h.paths, SID), [], "no fresh sensor, no inbox file");
	const entries = outbox(h);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].message.details.actionKind, "budget-request");
	assert.equal(entries[0].message.sessionId, SID);
	assert.equal(entries[0].id, entries[0].message.id);
	assert.equal(entries[0].createdMs, T0);
});

test("(b) the next tick with a fresh sensor delivers exactly one request and empties the outbox", async (t) => {
	const h = setup(t);
	seed(h);
	const { engine } = h.makeEngine();
	await engine.tick();
	const pendingId = outbox(h)[0].id;
	h.state.sensor = true;
	h.clock.advance(MIN);
	await engine.tick();
	const messages = inboxMessages(h.paths, SID);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].details.actionKind, "budget-request");
	assert.equal(messages[0].id, pendingId, "the retained message is delivered, not a second composition");
	assert.deepEqual(outbox(h), []);
});

test("(c) later ticks send nothing again", async (t) => {
	const h = setup(t);
	seed(h);
	const { engine } = h.makeEngine();
	h.state.sensor = true;
	await engine.tick();
	h.clock.advance(MIN);
	await engine.tick();
	h.clock.advance(MIN);
	await engine.tick();
	assert.equal(inboxMessages(h.paths, SID).length, 1);
	assert.deepEqual(outbox(h), []);
});

test("(d) a restart keeps the pending message and delivers it once the sensor appears", async (t) => {
	const h = setup(t);
	seed(h);
	await h.makeEngine().engine.tick();
	const pending = outbox(h);
	assert.equal(pending.length, 1);
	// A new office and engine on the same DB: the outbox survives the process restart.
	const restarted = h.makeEngine();
	assert.equal(restarted.office.tick({ shadow: true }).messages.length, 0, "shadow reads nothing from the outbox");
	assert.deepEqual(outbox(h), pending, "shadow changes no outbox");
	h.state.sensor = true;
	h.clock.advance(MIN);
	await restarted.engine.tick();
	const messages = inboxMessages(h.paths, SID);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].id, pending[0].id);
	assert.deepEqual(outbox(h), []);
	h.clock.advance(MIN);
	await restarted.engine.tick();
	assert.equal(inboxMessages(h.paths, SID).length, 1, "delivered once, never again");
});

test("(e) an outbox entry older than 7 days is dropped with one message-expired event", async (t) => {
	const h = setup(t);
	seed(h);
	const { office } = h.makeEngine();
	const first = office.tick({ shadow: false });
	assert.equal(first.messages.length, 1, "the request is pending");
	h.clock.advance(7 * DAY + MIN);
	const out = office.tick({ shadow: false });
	assert.deepEqual(out.messages, [], "an expired message is not delivered");
	assert.deepEqual(outbox(h), []);
	const expired = h.store.events({ projectId: PID, limit: 200 }).filter((event) => event.kind === "message-expired");
	assert.equal(expired.length, 1);
	assert.equal(expired[0].data.messageId, first.messages[0].id);
	assert.equal(expired[0].data.reason, "expired");
});

test("(f) a sensor that returns after more than five minutes still gets the request, not a swept file", async (t) => {
	const h = setup(t);
	seed(h);
	const { engine } = h.makeEngine();
	await engine.tick();
	assert.equal(outbox(h).length, 1, "held while no sensor");
	// Six minutes later the sensor is back: the inbox sweep (5 min) runs in the same tick as the delivery.
	h.state.sensor = true;
	h.clock.advance(6 * MIN);
	await engine.tick();
	const messages = inboxMessages(h.paths, SID);
	assert.equal(messages.length, 1, "the delivered file is still in the inbox for the sensor");
	assert.equal(messages[0].details.actionKind, "budget-request");
	assert.equal(messages[0].createdMs, T0 + 6 * MIN, "the retried notice carries its delivery time");
	assert.deepEqual(outbox(h), []);
	const swept = path.join(h.paths.health.inboxDir, "_undelivered");
	assert.equal(fs.existsSync(swept) ? fs.readdirSync(swept).length : 0, 0, "nothing was set aside");
});
