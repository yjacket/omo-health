import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { defaultLaunchers, defaultTerminals, hasPendingParks, PARK_TIMING, runParkLifecycle } from "../src/act/park-resume.mjs";
import { readParkRecords } from "../src/collect/parks.mjs";
import { normalizeRows } from "../src/collect/procs.mjs";
import * as parks from "../src/detect/parks.mjs";
import { createEngine, loadDetectors } from "../src/engine.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { closeDb, openDb } from "../src/db/db.mjs";
import { createInvestigations } from "../src/investigations.mjs";
import { runDaemon } from "../src/daemon.mjs";
import { detect as detectCrashes } from "../src/detect/crashes.mjs";
import { gate } from "../src/judge/policy.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { fakeProc, guardProcessListeners } from "./helpers/fake-proc.mjs";
import { makeWorld, raw, sessionState } from "./helpers/world.mjs";

guardProcessListeners();

function fakeSpawn() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => child.emit("exit", null);
	return child;
}

const MIN = 60_000;
const START = Date.parse("2026-10-07T12:00:00Z");
const SID = "01a11580-07ab-7fdb-90cd-5da5c562928f";
const CREATED = START - 3 * 60 * MIN;
const OTHER = raw(1, 0, "System", "2026-10-01T00:00:00Z");
const HOST = 5100;
const iso = (ms) => new Date(ms).toISOString();
const hostRow = (pid, startedMs) => raw(pid, 1, "bun.exe", iso(startedMs), 0, 0, "bun C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js");
const sessionProc = (pid, startedMs, sid = SID) => raw(pid, 1, "omo.exe", iso(startedMs), 0, 0, `C:\\bin\\omo.exe --session ${sid}`);

function parkRecord(over = {}) {
	const createdAt = over.createdAt ?? CREATED;
	return { v: 1, parkId: `${SID}-${createdAt}`, sessionId: SID, cwd: "C:/dev/project", terminal: { kind: "orca", orca: { worktree: "C:/dev/project" } }, provider: "anthropic-subscription", account: "default", window: "five_hour", resetAt: START - 2 * MIN, reason: "usage-limit", goal: { id: "g1", pausedByLimitless: true }, status: "pending", createdAt, claim: null, result: null, ...over };
}

/** A parks dir, a fake clock and fake launcher/terminal/toast actors; tick() runs one lifecycle pass. */
function harness({ record = parkRecord(), config = DEFAULT_CONFIG, launch } = {}) {
	const root = tmpDir("park-resume-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	fs.mkdirSync(paths.health.parksDir, { recursive: true });
	const h = { paths, now: START, memory: {}, launches: [], closes: [], toasts: [], decisions: [], openTerminals: new Set(), config };
	h.fileOf = (createdAt = CREATED) => path.join(paths.health.parksDir, `${SID}.${createdAt}.park.json`);
	h.put = (rec) => fs.writeFileSync(h.fileOf(rec.createdAt), JSON.stringify(rec));
	h.read = (createdAt = CREATED) => JSON.parse(fs.readFileSync(h.fileOf(createdAt), "utf8"));
	h.ack = (createdAt = CREATED, parkId = `${SID}-${createdAt}`) => fs.writeFileSync(h.fileOf(createdAt).replace(/\.park\.json$/, ".ack.json"), JSON.stringify({ v: 1, parkId, sessionId: SID, pid: 4242, at: h.now }));
	let n = 0;
	h.launch =
		launch ??
		(async () => {
			const handle = `term_${++n}`;
			h.openTerminals.add(handle);
			return { ok: true, handle };
		});
	h.tick = ({ hb, procs = [], fresh = true } = {}) => {
		const world = makeWorld({ now: h.now, config, sensors: hb ? [{ v: 1, sessionId: SID, pid: HOST, ts: h.now, ...hb }] : [], procSnapshots: [{ takenAtMs: h.now, rows: [OTHER, ...(hb ? [hostRow(HOST, h.now - MIN)] : []), ...procs] }], procsFresh: fresh });
		return runParkLifecycle({
			paths,
			config,
			now: h.now,
			world,
			parkRecords: readParkRecords(paths, { includeMalformed: true }),
			memory: h.memory,
			gate: (req, sessionId) => gate(req, { mode: "auto", paused: false, config, subject: { sessionId }, subjectKind: "main" }),
			launchers: {
				orca: async (rec) => (h.launches.push(rec), h.launch(rec)),
				herdr: async (rec) => (h.launches.push(rec), h.launch(rec)),
			},
			terminals: { exists: (l) => h.openTerminals.has(l.handle), close: (l) => (h.closes.push(l.handle), h.openTerminals.delete(l.handle), true) },
			notifier: {
				toast: (t) => {
					h.toasts.push(t);
					return h.rejectToast ? Promise.reject(new Error("notifier exploded")) : { ok: true };
				},
			},
			log: {
				warn: (...args) => {
					h.logs ??= [];
					h.logs.push(args);
				},
			},
			decide: (d) => h.decisions.push(d),
		});
	};
	if (record) h.put(record);
	return h;
}

test("park-resume: claim, launch, ack, complete", async () => {
	const h = harness();
	const moves = await h.tick();
	assert.deepEqual(moves.map((m) => m.to), ["claimed", "launched"]);
	let rec = h.read();
	assert.equal(rec.status, "launched");
	assert.equal(rec.claim.attempt, 1);
	assert.equal(rec.claim.attemptId, `${SID}-${CREATED}#1`);
	assert.equal(rec.launch.handle, "term_1");
	assert.equal(h.launches.length, 1);
	h.now += 30_000;
	h.ack();
	await h.tick();
	rec = h.read();
	assert.equal(rec.status, "completed");
	assert.equal(rec.ack.parkId, rec.parkId);
	assert.equal(h.launches.length, 1);
	assert.equal(hasPendingParks(h.paths), false);
});

test("park-resume: a second tick does not relaunch", async () => {
	const h = harness();
	await h.tick();
	h.now += 30_000;
	await h.tick();
	h.now += 60_000;
	await h.tick();
	assert.equal(h.launches.length, 1);
	assert.equal(h.read().status, "launched");
});

test("park-resume: not due before resetAt + 60 s", async () => {
	const h = harness({ record: parkRecord({ resetAt: START - 30_000 }) });
	assert.deepEqual(await h.tick(), []);
	assert.equal(h.read().status, "pending");
	h.now += 31_000;
	await h.tick();
	assert.equal(h.launches.length, 1);
});

test("park-resume: a not-due pending record with the parking session's live heartbeat stays pending; after due with no heartbeat it is claimed and launched", async () => {
	const h = harness({ record: parkRecord({ resetAt: START + 60 * MIN }) });
	assert.deepEqual(await h.tick({ hb: {} }), []);
	let rec = h.read();
	assert.equal(rec.status, "pending");
	assert.equal(rec.updatedAt, undefined, "nothing was written");
	assert.equal(h.launches.length, 0);
	h.now = START + 61 * MIN;
	const moves = await h.tick();
	assert.deepEqual(moves.map((m) => `${m.from}>${m.to}`), ["pending>claimed", "claimed>launched"]);
	rec = h.read();
	assert.equal(rec.status, "launched");
	assert.equal(h.launches.length, 1);
});

test("park-resume: crash after claimed before launch (+3 min, no ack, no heartbeat) reverts to pending and launches exactly once", async () => {
	const h = harness({ record: parkRecord({ status: "claimed", claim: { at: START, attemptId: `${SID}-${CREATED}#1`, attempt: 1 } }) });
	await h.tick();
	assert.equal(h.launches.length, 0, "a fresh claim is left alone");
	h.now += 3 * MIN;
	const moves = await h.tick();
	assert.deepEqual(moves.map((m) => `${m.from}>${m.to}`), ["claimed>pending", "pending>claimed", "claimed>launched"]);
	assert.equal(h.launches.length, 1);
	assert.equal(h.read().claim.attempt, 2, "the lost claim used up attempt 1");
	h.now += 30_000;
	await h.tick();
	assert.equal(h.launches.length, 1);
});

test("park-resume: crash after launch (record left claimed, heartbeat present) completes without calling the launcher", async () => {
	const h = harness({ record: parkRecord({ status: "claimed", claim: { at: START - 3 * MIN, attemptId: "x", attempt: 1 } }) });
	await h.tick({ hb: {} });
	const rec = h.read();
	assert.equal(rec.status, "completed");
	assert.equal(rec.reason, "already-live");
	assert.equal(h.launches.length, 0);
});

test("park-resume: slow start with a --session process past the 2-minute deadline does not launch; a later ack completes", async () => {
	const h = harness({ record: parkRecord({ status: "claimed", claim: { at: START - 3 * MIN, attemptId: "x", attempt: 1 } }) });
	await h.tick({ procs: [sessionProc(7000, START - 150_000)] });
	assert.equal(h.read().status, "claimed");
	assert.equal(h.launches.length, 0);
	h.now += MIN;
	h.ack();
	await h.tick({ procs: [sessionProc(7000, START - 150_000)] });
	assert.equal(h.read().status, "completed");
	assert.equal(h.launches.length, 0);
});

test("park-resume: launched past 5 minutes with no ack, no --session process and the launch terminal still open closes that terminal and relaunches", async () => {
	const h = harness();
	await h.tick();
	h.now += 5 * MIN + 1000;
	const moves = await h.tick();
	assert.deepEqual(h.closes, ["term_1"], "only the handle this daemon launched is closed");
	assert.deepEqual(moves.map((m) => m.to), ["pending", "claimed", "launched"]);
	assert.equal(h.launches.length, 2);
	const rec = h.read();
	assert.equal(rec.launch.handle, "term_2");
	assert.equal(rec.claim.attempt, 2);
});

test("park-resume: a --session process alive 15 minutes without ack fails hung-start with one notification, no launch and no kill", async () => {
	const h = harness();
	await h.tick();
	h.now += 16 * MIN;
	const procs = [sessionProc(7000, START + 30_000)];
	await h.tick({ procs });
	let rec = h.read();
	assert.equal(rec.status, "failed");
	assert.equal(rec.reason, "hung-start");
	assert.deepEqual(rec.hungPids, [7000]);
	assert.equal(h.launches.length, 1, "only the first launch");
	assert.equal(h.closes.length, 0, "nothing is closed or killed");
	assert.equal(h.toasts.length, 1);
	h.now += MIN;
	await h.tick({ procs });
	rec = h.read();
	assert.equal(rec.status, "failed");
	assert.equal(h.toasts.length, 1);
});

test("park-resume: two unfinished episodes for one sid: the older becomes superseded and only the newer is launched", async () => {
	const h = harness();
	const newer = parkRecord({ createdAt: CREATED + 10 * MIN });
	h.put(newer);
	await h.tick();
	assert.equal(h.read(CREATED).status, "superseded");
	assert.equal(h.read(CREATED).supersededBy, newer.parkId);
	assert.equal(h.read(newer.createdAt).status, "launched");
	assert.deepEqual(h.launches.map((r) => r.parkId), [newer.parkId]);
	h.now += 10 * MIN;
	await h.tick();
	assert.equal(h.read(CREATED).status, "superseded", "a superseded episode is never launched");
});

test("park-resume: an acked older episode completes from its ack instead of being superseded, and the newer one is untouched until due", async () => {
	const h = harness();
	const newer = parkRecord({ createdAt: CREATED + 10 * MIN, resetAt: START + 60 * MIN });
	h.put(newer);
	h.ack(CREATED);
	await h.tick();
	assert.equal(h.read(CREATED).status, "completed");
	assert.equal(h.read(newer.createdAt).status, "pending");
	assert.equal(h.launches.length, 0);
});

test("park-resume: ack present while the record is claimed completes without the launcher", async () => {
	const h = harness({ record: parkRecord({ status: "claimed", claim: { at: START, attemptId: "x", attempt: 1 } }) });
	h.ack();
	await h.tick();
	assert.equal(h.read().status, "completed");
	assert.equal(h.launches.length, 0);
});

test("park-resume: an ack for another parkId does not complete the episode", async () => {
	const h = harness({ record: parkRecord({ status: "claimed", claim: { at: START, attemptId: "x", attempt: 1 } }) });
	h.ack(CREATED, `${SID}-1`);
	await h.tick();
	assert.equal(h.read().status, "claimed");
});

test("park-resume: launched without ack for 5 min is relaunched, and after 3 attempts fails with one notification (the hourly cap is not an attempt)", async () => {
	const h = harness();
	const t0 = h.now;
	await h.tick();
	h.now = t0 + 5 * MIN + 1000;
	await h.tick();
	assert.equal(h.launches.length, 2);
	h.now = t0 + 10 * MIN + 2000;
	await h.tick();
	let rec = h.read();
	assert.equal(h.launches.length, 2, "crashResume.perHour (2) holds the third launch");
	assert.equal(rec.status, "pending");
	assert.equal(rec.lastError, "rate-capped");
	assert.equal(rec.attempt, 2, "the cap did not use an attempt");
	h.now = t0 + 61 * MIN;
	await h.tick();
	assert.equal(h.launches.length, 3);
	assert.equal(h.read().claim.attempt, 3);
	h.now = t0 + 67 * MIN;
	await h.tick();
	rec = h.read();
	assert.equal(rec.status, "failed");
	assert.equal(rec.reason, "relaunch-exhausted");
	assert.equal(h.launches.length, 3);
	assert.equal(h.toasts.length, 1);
	h.now += 10 * MIN;
	await h.tick();
	assert.equal(h.toasts.length, 1);
});

test("park-resume: a launcher that throws on every call returns the record to pending with lastError each time, is called 3 times, and ends relaunch-exhausted with one toast", async () => {
	const h = harness({ launch: async () => { throw new Error("orca exploded"); } });
	const seen = [];
	for (let i = 0; i < 6; i++) {
		await h.tick();
		const rec = h.read();
		seen.push({ status: rec.status, attempt: rec.attempt, lastError: rec.lastError, reason: rec.reason });
		h.now += 30_000;
	}
	assert.deepEqual(seen.slice(0, 3), [1, 2, 3].map((attempt) => ({ status: "pending", attempt, lastError: "launcher-threw: orca exploded", reason: "usage-limit" })));
	assert.equal(seen[3].status, "failed");
	assert.equal(seen[3].reason, "relaunch-exhausted");
	assert.equal(h.launches.length, 3);
	assert.equal(h.toasts.length, 1);
	assert.match(h.toasts[0].body, /omo --session 01a11580/);
});

test("park-resume: a launcher error result returns the record to pending with lastError", async () => {
	const h = harness({ launch: async () => ({ ok: false, reason: "no-worktree-match" }) });
	await h.tick();
	const rec = h.read();
	assert.equal(rec.status, "pending");
	assert.equal(rec.lastError, "no-worktree-match");
	assert.equal(rec.attempt, 1);
});

test("park-resume: no trustworthy process table means no launch", async () => {
	const h = harness();
	await h.tick({ fresh: false });
	assert.equal(h.launches.length, 0);
	assert.equal(h.read().status, "pending");
});

test("park-resume: kind unknown fails no-launcher with one toast", async () => {
	const h = harness({ record: parkRecord({ terminal: { kind: "unknown" } }) });
	await h.tick();
	await h.tick();
	const rec = h.read();
	assert.equal(rec.status, "failed");
	assert.equal(rec.reason, "no-launcher");
	assert.equal(h.launches.length, 0);
	assert.equal(h.toasts.length, 1);
});

test("park-resume: kind self ack completes during housekeeping without launching", async () => {
	const h = harness({ record: parkRecord({ terminal: { kind: "self" } }) });
	h.ack();
	await h.tick();
	assert.equal(h.read().status, "completed");
	assert.ok(h.read().ack);
	assert.equal(h.launches.length, 0);
	assert.equal(hasPendingParks(h.paths), false, "a self record does not hold the daemon");
	h.now = START + PARK_TIMING.keepMs + MIN;
	await h.tick();
	assert.equal(fs.existsSync(h.fileOf()), false);
});

test("park-resume: rejecting failure notifier is awaited and logged without an unhandled rejection", async () => {
	const h = harness({ launch: async () => { throw new Error("orca exploded"); } });
	h.rejectToast = true;
	let unhandled;
	const onUnhandled = (error) => { unhandled = error; };
	process.on("unhandledRejection", onUnhandled);
	try {
		for (let i = 0; i < 4; i++) {
			await h.tick();
			h.now += 30_000;
		}
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(h.read().status, "failed");
		assert.equal(h.read().reason, "relaunch-exhausted");
		assert.equal(unhandled, undefined);
		assert.equal(h.logs.at(-1)[0], "park_notification_failed");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("park-resume: completed and failed records and their ack files are deleted after 7 days; unfinished ones are kept", async () => {
	const h = harness({ record: parkRecord({ status: "completed", finishedAt: START }) });
	h.ack();
	const failed = parkRecord({ createdAt: CREATED - 1000, status: "failed", reason: "hung-start", finishedAt: START });
	h.put(failed);
	await h.tick();
	assert.equal(fs.existsSync(h.fileOf()), true);
	h.now = START + PARK_TIMING.keepMs + 1000;
	await h.tick();
	assert.equal(fs.existsSync(h.fileOf()), false);
	assert.equal(fs.existsSync(h.fileOf().replace(/\.park\.json$/, ".ack.json")), false);
	assert.equal(fs.existsSync(h.fileOf(failed.createdAt)), false);
});

test("park-resume: the Orca launcher gets qaCommandPrefix from the record and applies it only under OMO_HEALTH_QA=1", async () => {
	const prefix = "$env:OMO_LIMITLESS_FAKE_RESET_IN_MS='1000'; ";
	const run = async (env) => {
		const calls = [];
		const spawnSync = (_cmd, args) => {
			calls.push(args);
			if (args[0] === "status") return { status: 0, stdout: "{}" };
			if (args[0] === "worktree") return { status: 0, stdout: JSON.stringify({ result: { worktrees: [{ worktreeId: "r::C:/dev/project", path: "C:/dev/project" }] } }) };
			return { status: 0, stdout: JSON.stringify({ result: { terminal: { handle: "term_qa" } } }) };
		};
		const out = await defaultLaunchers({ orcaDeps: { spawnSync, env } }).orca(parkRecord({ qaCommandPrefix: prefix }));
		return { out, command: calls.find((a) => a[0] === "terminal")?.[calls.find((a) => a[0] === "terminal").indexOf("--command") + 1] };
	};
	const plain = await run({});
	assert.deepEqual(plain.out, { ok: true, handle: "term_qa" });
	assert.equal(plain.command, `omo --session ${SID}`);
	const qa = await run({ OMO_HEALTH_QA: "1" });
	assert.equal(qa.command, `${prefix}omo --session ${SID}`);
});

test("park-resume: the Orca terminal cleanup always names the handle and never closes without one", () => {
	const calls = [];
	const terminals = defaultTerminals({ spawnSync: (_cmd, args) => (calls.push(args), { status: 0, stdout: "{}" }), env: {} });
	assert.equal(terminals.close({ kind: "orca" }), false);
	assert.equal(terminals.exists({ kind: "orca" }), false);
	assert.equal(calls.length, 0);
	assert.equal(terminals.close({ kind: "orca", handle: "term_1" }), true);
	assert.deepEqual(calls, [["terminal", "close", "--terminal", "term_1", "--json"]]);
});

test("park-resume: the daemon does not idle-exit while a pending record exists and no host is alive", async () => {
	const root = tmpDir("park-daemon-");
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.health.parksDir, { recursive: true });
	const file = path.join(paths.health.parksDir, `${SID}.${CREATED}.park.json`);
	fs.writeFileSync(file, JSON.stringify(parkRecord()));
	let now = 100_000;
	let ticks = 0;
	const engine = () => ({
		async tick() {
			now += MIN;
			ticks++;
			// Health finishes the episode on tick 6; only then may the idle clock end the daemon.
			if (ticks === 6) fs.writeFileSync(file, JSON.stringify(parkRecord({ status: "completed" })));
			return { findings: [] };
		},
		table: { all: () => [] },
		close() {},
	});
	const result = await runDaemon({ proc: fakeProc(), paths, config: { ...DEFAULT_CONFIG, idleExitMs: 2 * MIN, care: { ...DEFAULT_CONFIG.care, enabled: false } }, clock: { now: () => now }, overrides: { procs: { kind: "fake" }, createEngine: engine, spawn: fakeSpawn, env: {} } });
	assert.equal(result.reason, "idle-no-omo-hosts");
	assert.equal(ticks, 6, "idle for 2 min after tick 2, but held until the record finished");
});

test("park-resume: D18 skips unfinished health and unacked self parks, but not acked self parks", async () => {
	const T0 = START;
	const hb = { v: 1, pid: HOST, sessionId: SID, cwd: "C:\\dev\\project", kind: "interactive", idle: false, pending: false, executingTools: 1, hasUI: true, terminal: { kind: "herdr", workspaceId: "wA", paneId: "wA:p1" }, ts: T0 };
	const world = (now, alive, parkRecords) =>
		makeWorld({ now, sessions: [{ ...sessionState({ id: SID }), todoState: { open: 2, total: 5 } }], procSnapshots: [{ takenAtMs: now, rows: alive ? [OTHER, hostRow(HOST, T0 - 10 * MIN)] : [OTHER] }], hostExits: { heartbeats: [{ hb, file: "x", mtimeMs: T0 }], crashRecords: [], liveMarkers: new Map() }, parkRecords });
	const run = (parkRecords) => {
		const memory = {};
		detectCrashes(world(T0 + 5_000, true, parkRecords), memory);
		return detectCrashes(world(T0 + 40_000, false, parkRecords), memory).filter((f) => f.kind === "host-crash");
	};
	const self = harness({ record: parkRecord({ terminal: { kind: "self" }, resetAt: START + 60 * MIN }) });
	const selfEntry = { file: self.fileOf(), record: self.read() };
	assert.equal(run([])[0]?.data.remedy.kind, "crash-resume", "control: without a park record D18 resumes");
	assert.deepEqual(run([{ file: "f", record: parkRecord() }]), []);
	assert.equal(run([{ file: "f", record: parkRecord({ status: "completed" }) }])[0]?.data.remedy.kind, "crash-resume", "a finished episode no longer holds D18 back");
	assert.deepEqual(run([selfEntry]), [], "an unfinished self park without an ack suppresses D18");
	self.ack(self.read().createdAt, self.read().parkId);
	assert.equal(run([{ file: self.fileOf(), record: self.read() }])[0]?.data.remedy.kind, "crash-resume", "a matching ack prevents self park suppression before housekeeping");
	await self.tick();
	assert.equal(self.read().status, "completed", "housekeeping completes a self record from its ack");
	assert.equal(run([{ file: self.fileOf(), record: self.read() }])[0]?.data.remedy.kind, "crash-resume", "an acked self park no longer suppresses D18");
});

test("park-resume: the engine runs the lifecycle every tick through its gate; shadow mode never launches", async () => {
	const run = async (mode) => {
		const h = harness();
		const clock = createFakeClock(START);
		const launches = [];
		const engine = createEngine({
			paths: h.paths,
			config: DEFAULT_CONFIG,
			clock,
			mode,
			detectors: [{ name: "parks", ...parks }],
			sources: {
				procs: { async snapshot() { return { rows: normalizeRows([{ p: 1, pp: 0, n: "System", c: iso(START - 1e7) }]), takenAtMs: clock.now() }; }, async os() { return {}; } },
				registry: { refresh: () => ({ sessions: new Map(), tasks: [] }) },
				logs: { read() {}, drain: () => [], stats: new Map() },
			},
			actors: { parkLaunchers: { orca: async (rec) => (launches.push(rec.parkId), { ok: true, handle: "t" }) }, parkTerminals: { exists: () => false, close: () => false }, decide: () => {}, notifier: { toast: () => ({ ok: true }) } },
			options: { selfPid: 999999 },
		});
		await engine.tick();
		clock.advance(30_000);
		await engine.tick();
		return { launches, status: h.read().status };
	};
	assert.deepEqual(await run("auto"), { launches: [`${SID}-${CREATED}`], status: "launched" });
	assert.deepEqual(await run("shadow"), { launches: [], status: "pending" });
});

test("park-resume: with every detector, the anomaly watch and the investigations store live, a due park is D20 and never an anomaly investigation", async () => {
	// D19 belongs to 0.5.0's anomaly signals, which policy sends to the analyst; a park finding under D19 would open an investigation.
	const h = harness();
	const clock = createFakeClock(START);
	const db = openDb({ file: ":memory:" });
	const investigations = createInvestigations({ paths: h.paths, clock });
	const decisions = [];
	const analystStarts = [];
	const toasts = [];
	let launches = 0;
	const engine = createEngine({
		paths: h.paths,
		config: DEFAULT_CONFIG,
		clock,
		mode: "auto",
		detectors: await loadDetectors(),
		sources: {
			procs: { async snapshot() { return { rows: normalizeRows([{ p: 1, pp: 0, n: "System", c: iso(START - 1e7) }]), takenAtMs: clock.now() }; }, async os() { return {}; } },
			registry: { refresh: () => ({ sessions: new Map(), tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
		},
		actors: {
			db,
			analyst: { start: (finding) => (analystStarts.push(finding.fp), { tier: 2, verdict: "escalate", reason: "analyst-off", notReached: true }), poll: () => undefined, health: () => ({}), laneSessionIds: () => new Set() },
			parkLaunchers: { orca: async () => (launches++, Promise.reject(new Error("orca exploded"))) },
			parkTerminals: { exists: () => false, close: () => false },
			decide: (d) => decisions.push(d),
			notifier: { toast: (t) => (toasts.push(t), { ok: true }) },
			sensors: () => new Map(),
		},
		options: { selfPid: 999999, investigations },
	});
	const parkFindings = [];
	try {
		for (let i = 0; i < 10; i++) {
			const result = await engine.tick();
			parkFindings.push(...(result?.findings ?? []).filter((f) => f.kind === "park-due"));
			clock.advance(30_000);
		}
	} finally {
		closeDb(db);
	}
	assert.ok(parkFindings.length >= 1, "the due record raises park-due");
	assert.deepEqual(decisions.filter((d) => d.detector === "D19"), []);
	assert.deepEqual(investigations.list(), []);
	assert.deepEqual(analystStarts, [], "the analyst is never asked about a park");
	assert.deepEqual([...new Set(parkFindings.map((f) => f.detector))], ["D20"]);
	assert.deepEqual([launches, h.read().status, h.read().reason, toasts.length], [3, "failed", "relaunch-exhausted", 1]);
	assert.ok(decisions.some((d) => d.detector === "D20" && d.event === "park-transition"));
});

test("park-resume: policy allows it on a main session", () => {
	const req = { key: "park-resume:p:1", kind: "park-resume" };
	assert.equal(gate(req, { mode: "auto", paused: false, config: DEFAULT_CONFIG, subject: { sessionId: SID }, subjectKind: "main" }), "execute");
});

test("park-resume: actions.resume=false blocks it", async () => {
	const config = { ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, resume: false } };
	assert.equal(gate({ key: "k", kind: "park-resume" }, { mode: "auto", paused: false, config, subjectKind: "main" }), "skipped:switch-off");
	const h = harness({ config });
	await h.tick();
	await h.tick();
	assert.equal(h.launches.length, 0);
	assert.equal(h.read().status, "pending");
	assert.equal(h.decisions.filter((d) => d.event === "park-gated").length, 1, "the block is logged once");
});
