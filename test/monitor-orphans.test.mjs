import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executeKill } from "../src/act/kill.mjs";
import { pendingMessages, sendToSession, sweepUndelivered } from "../src/act/inbox.mjs";
import { composeMonitorOrphanNotice } from "../src/act/messages.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as monitorOrphans from "../src/detect/monitor-orphans.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const START = Date.parse("2026-09-29T09:00:00Z");
const COMMAND = "tail -n 0 -F probe.log | grep --line-buffered ZZZPROBE";
const row = (p, n, cl, ms = START, pp = 0) => ({ p, pp, n, cl, c: new Date(ms).toISOString() });
const baseRows = () => [
	row(10, "bun.exe", "bun C:/senpi/dist/bundle/cli.js", START - 10000),
	row(20, "bash.exe", `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${COMMAND}"`, START, 10),
	row(21, "bash.exe", `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${COMMAND}"`, START + 400, 20),
	row(22, "tail.exe", '"C:\\Program Files\\Git\\usr\\bin\\tail.exe" -n 0 -F probe.log', START + 450),
	row(23, "grep.exe", '"C:\\Program Files\\Git\\usr\\bin\\grep.exe" --line-buffered ZZZPROBE', START + 490),
];
const monitor = (monitorId, overrides = {}) => ({ monitorId, sessionId: "owner", description: `watch ${monitorId}`, runtimeKind: "command", command: COMMAND, runtime: { pid: 20, startedAtMs: START }, ...overrides });

function harness({ rows = baseRows(), monitors = [monitor("m1")], host = true, heartbeat = host, graceMs = 60_000, mode = "auto", useDisk = false, integrity, sessionFile = false } = {}) {
	// host: the senpi host process (pid 10, the launcher's parent) is running. heartbeat: its sensor reports it.
	// integrity: the daemon's own RID; like Windows, a kill of a row with a larger `il` exits 1 and the process survives.
	if (!host) rows = rows.filter((r) => r.p !== 10);
	const root = tmpDir("omoh-monitor-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	const manifest = path.join(paths.sessionsDir, "project", "extensions", "terminal", "owner.json");
	fs.mkdirSync(path.dirname(manifest), { recursive: true });
	fs.writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: "owner", monitors, backgroundSessions: [] }));
	const session = path.join(paths.sessionsDir, "project", "2026-09-29T08-00-00-000Z_owner.jsonl");
	if (sessionFile) fs.writeFileSync(session, "{}\n");
	const clock = createFakeClock(START + 1000);
	const live = new Map(rows.map((r) => [r.p, r]));
	const tracker = new ProcessTracker();
	// integrity may be a sequence: the daemon's rights at each successive snapshot (tick snapshot, perform re-check).
	const seq = Array.isArray(integrity) ? [...integrity] : [integrity];
	let currentIl = seq[0];
	const snapshot = async () => {
		currentIl = seq.length > 1 ? seq.shift() : seq[0];
		return tracker.update({ rows: normalizeRows([...live.values()]), takenAtMs: clock.now(), integrity: currentIl });
	};
	const tickSnapshot = async () => { currentIl = seq.length > 1 ? seq.shift() : seq[0]; return { rows: normalizeRows([...live.values()]), takenAtMs: clock.now(), integrity: currentIl }; };
	const attempts = [];
	const killed = [];
	const sent = [];
	const toasts = [];
	const decisions = [];
	const engine = createEngine({ paths, config: { ...DEFAULT_CONFIG, monitorOrphans: { enabled: true, graceMs } }, clock, mode,
		detectors: [{ name: "monitor-orphans", ...monitorOrphans }],
		sources: { procs: { snapshot: tickSnapshot, async os() { return {}; } },
			registry: { refresh: () => ({ sessions: new Map(), tasks: [] }) }, logs: { read() {}, drain: () => [], stats: new Map() } },
		actors: { sensors: () => heartbeat ? new Map([["owner", { sessionId: "owner", pid: 10, ts: clock.now() }]]) : new Map(),
			kill: (args) => executeKill({ ...args, snapshot, runner(pid) {
				attempts.push(pid);
				if (currentIl !== undefined && live.get(pid)?.il > currentIl) return { status: 1, error: "Access is denied." };
				killed.push(pid);
				live.delete(pid);
				return { status: 0 };
			}, sleep: async () => {} }),
			...(useDisk ? {} : { send(msg) { sent.push(msg); return "inbox"; } }),
			decide: (d) => decisions.push(d), notifier: { toast(msg) { toasts.push(msg); return { ok: true }; } } },
		options: { selfPid: 999999, noStatus: false } });
	const writeManifest = (list) => fs.writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: "owner", monitors: list, backgroundSessions: [] }));
	return { engine, clock, live, killed, attempts, sent, toasts, decisions, paths, manifest, session, writeManifest };
}
const killDecisions = (h) => h.decisions.filter((d) => d.action?.kind === "kill-orphan-watchers");
const undeliveredDir = (h) => path.join(h.paths.health.inboxDir, "_undelivered");
async function mature(h) { await h.engine.tick(); h.clock.advance(60_000); return h.engine.tick(); }

test("dead launcher: grace, exact inner and pipeline members, one quiet deferred notice and decisions", async () => {
	const h = harness({ heartbeat: false, rows: baseRows().filter((r) => r.p !== 20), monitors: [monitor("m1"), monitor("m2", { runtime: { pid: 20, startedAtMs: START + 60_000 }, command: "unrelated" })] });
	assert.deepEqual((await h.engine.tick()).results, []);
	h.clock.advance(59_999);
	assert.deepEqual((await h.engine.tick()).results, []);
	h.clock.advance(1);
	const result = await h.engine.tick();
	assert.deepEqual(h.killed.sort(), [21, 22, 23]);
	assert.equal(result.findings[0].severity, "info");
	assert.equal(result.globalStatus.level, "ok");
	assert.equal(h.sent.length, 1);
	// #102: on the next agent turn (followUp), never a wake-up; timestamped; a non-persistent monitor may be re-armed.
	assert.deepEqual([h.sent[0].kind, h.sent[0].deliverAs, h.sent[0].triggerTurn, h.sent[0].sessionId], ["self-notice", "followUp", false, "owner"]);
	assert.match(h.sent[0].content, /3.*m1|m1.*3/);
	assert.ok(h.sent[0].content.includes(new Date(h.clock.now()).toISOString()));
	assert.match(h.sent[0].content, /Re-arm/);
	assert.deepEqual(h.sent[0].details.monitors, [{ sessionId: "owner", monitorId: "m1", persistent: false }]);
	assert.equal(h.sent[0].details.expiresMs, h.sent[0].details.killedAtMs + 15 * 60_000);
	assert.equal(h.toasts.length, 0);
	assert.ok(h.decisions.some((d) => d.action?.kind === "kill-orphan-watchers" && d.outcome.killed.length === 3));
	await h.engine.tick();
	assert.equal(h.sent.length, 1);
	const restored = harness({ rows: [], host: true });
	restored.engine.restoreState(h.engine.snapshotState(), h.clock.now());
	assert.equal(restored.engine.snapshotState().memories.monitorOrphans.done["owner:m1"] > 0, true);
});

test("a running owner's ended monitor is cleaned without a notice: senpi already told it", async () => {
	const h = harness({ rows: baseRows().filter((r) => r.p !== 20) });
	await mature(h);
	assert.deepEqual(h.killed.sort(), [21, 22, 23]);
	assert.equal(h.sent.length, 0);
});

test("a live launcher under a live host is never killed, even when the owner's sensor is silent", async () => {
	const h = harness({ heartbeat: false });
	const result = await mature(h);
	assert.deepEqual(result.findings, []);
	assert.deepEqual(h.killed, []);
	assert.equal(h.sent.length, 0);
});

test("owner host gone kills launcher as well; live launcher and live owner are left alone", async () => {
	const dead = harness({ host: false });
	await mature(dead);
	assert.deepEqual(dead.killed.sort(), [20, 21, 22, 23]);
	const live = harness();
	await mature(live);
	assert.deepEqual(live.killed, []);
	assert.equal(live.sent.length, 0);
});

test("unattributed dead-session process, reused pid, mismatched command, file and missing runtime are never killed", async () => {
	const rows = [row(20, "bash.exe", "bash -c DIFFERENT", START), row(21, "bash.exe", `bash -c "${COMMAND}"`, START + 31_000), row(22, "tail.exe", "tail -n 0 -F probe.log", START + 31_000), row(24, "sleep.exe", "sleep 999", START)];
	const h = harness({ rows, host: false, monitors: [monitor("m1"), monitor("file", { runtimeKind: "file" }), monitor("missing", { runtime: undefined })] });
	await mature(h);
	assert.deepEqual(h.killed, []);
	assert.equal(h.sent.length, 0);
});

test("two orphan monitors of one owner aggregate in a single inbox file; it survives an absent owner until 30 days", async () => {
	const second = "cat other.log | grep MARKER";
	const h = harness({ host: false, useDisk: true,
		rows: [...baseRows(), row(30, "bash.exe", `bash -c "${second}"`, START + 100), row(31, "cat.exe", "cat other.log", START + 150), row(32, "grep.exe", "grep MARKER", START + 160)],
		monitors: [monitor("m1"), monitor("m2", { command: second, runtime: { pid: 30, startedAtMs: START + 100 } })] });
	await mature(h);
	assert.equal(h.killed.length, 7);
	const messages = pendingMessages(h.paths, "owner");
	assert.equal(messages.length, 1);
	assert.equal(messages[0].message.details.monitors.length, 2);
	assert.equal(sweepUndelivered(h.paths, h.clock.now() + 29 * 24 * 3600_000).length, 0);
	assert.equal(pendingMessages(h.paths, "owner").length, 1);
	// Rule 3: after 30 days the notice expires into _undelivered, still without a toast.
	assert.equal(sweepUndelivered(h.paths, h.clock.now() + 31 * 24 * 3600_000).length, 0);
	assert.equal(pendingMessages(h.paths, "owner").length, 0);
	assert.equal(fs.readdirSync(undeliveredDir(h)).length, 1);
	assert.equal(h.toasts.length, 0);
});

test("a live monitor with overlapping members protects them from an obsolete manifest", async () => {
	const h = harness({ monitors: [monitor("live"), monitor("obsolete", { sessionId: "other" })] });
	await mature(h);
	assert.deepEqual(h.killed, []);
});

test("shadow mode records would-kill without sending a notice or touching processes", async () => {
	const h = harness({ host: false, mode: "shadow" });
	const result = await mature(h);
	assert.ok(result.results.some((r) => r.result === "would" && r.kind === "kill-orphan-watchers"));
	assert.deepEqual(h.killed, []);
	assert.deepEqual(h.sent, []);
});

test("quoted pipe remains part of one segment; same-looking but mistimed processes stay alive", () => {
	const command = "grep 'a|b' probe.log | head -1";
	const m = monitor("quoted", { command });
	const rows = normalizeRows([
		row(20, "bash.exe", `bash -c "${command}"`),
		row(21, "grep.exe", "grep a|b probe.log", START + 100),
		row(22, "head.exe", "head -1", START + 100),
		row(23, "head.exe", "head -1", START + 31_000),
	]);
	const table = new ProcessTracker().update({ rows, takenAtMs: START + 40_000 });
	assert.deepEqual(monitorOrphans.watcherMembers(m, table).members.map((p) => p.pid), [20, 21, 22]);
});

test("manifest scan reads dormant session dirs but bounds age and count without writing to omo home", () => {
	const h = harness();
	assert.equal(monitorOrphans.readMonitorManifests(h.paths, h.clock.now()).length, 1);
	const before = fs.readFileSync(h.manifest, "utf8");
	assert.equal(monitorOrphans.readMonitorManifests(h.paths, h.clock.now())[0].monitorId, "m1");
	assert.equal(fs.readFileSync(h.manifest, "utf8"), before);
	const old = new Date(h.clock.now() - 31 * 24 * 3600_000);
	fs.utimesSync(h.manifest, old, old);
	assert.equal(monitorOrphans.readMonitorManifests(h.paths, h.clock.now()).length, 0);
});

const DAY = 24 * 3600_000;
const TARGETS = ["bash.exe:20", "bash.exe:21", "grep.exe:23", "tail.exe:22"];

test("a monitor removed from its manifest after the launcher died is still reaped from memory, with decision targets", async () => {
	const h = harness();
	assert.deepEqual((await h.engine.tick()).findings, []);
	h.live.delete(20);
	h.writeManifest([]);
	h.clock.advance(60_000);
	await mature(h);
	assert.deepEqual(h.killed.sort(), [21, 22, 23]);
	const [d] = killDecisions(h);
	assert.equal(d.result, "execute");
	assert.deepEqual(d.action.params.targets.sort(), TARGETS.slice(1));
	// Nothing left to reap: the remembered entry is dropped on the next fresh snapshot.
	h.clock.advance(60_000);
	await h.engine.tick();
	assert.equal(h.engine.snapshotState().memories.monitorOrphans.remembered["owner:m1"], undefined);
});

test("remembered entries survive snapshot/restore, bounded by count and age; malformed ones are ignored", async () => {
	const h = harness();
	await h.engine.tick();
	const saved = h.engine.snapshotState();
	const entry = saved.memories.monitorOrphans.remembered["owner:m1"];
	assert.deepEqual(entry, { sessionId: "owner", monitorId: "m1", description: "watch m1", runtimeKind: "command", command: COMMAND, runtime: { pid: 20, startedAtMs: START }, sessionDir: path.join(h.paths.sessionsDir, "project"), lastSeenMs: h.clock.now() });
	const restored = harness({ monitors: [] });
	restored.engine.restoreState(JSON.parse(JSON.stringify(saved)), h.clock.now());
	assert.deepEqual(restored.engine.snapshotState().memories.monitorOrphans.remembered, { "owner:m1": entry });

	const remembered = {};
	for (let i = 0; i < 205; i++) remembered[`s:${i}`] = { ...entry, sessionId: "s", monitorId: String(i), lastSeenMs: START + i };
	remembered["s:old"] = { ...entry, sessionId: "s", monitorId: "old", runtime: { pid: 20, startedAtMs: START - 31 * DAY }, lastSeenMs: START + 999 };
	remembered["s:bad"] = { ...entry, sessionId: "s", monitorId: "bad", runtime: { pid: "20", startedAtMs: START }, lastSeenMs: START + 998 };
	remembered["s:nocmd"] = { ...entry, sessionId: "s", monitorId: "nocmd", command: "", lastSeenMs: START + 997 };
	const bounded = harness({ monitors: [] });
	bounded.engine.restoreState({ v: 1, records: [], memories: { monitorOrphans: { remembered } } }, START + 1000);
	const kept = bounded.engine.snapshotState().memories.monitorOrphans.remembered;
	assert.equal(Object.keys(kept).length, 200);
	assert.deepEqual(Object.keys(kept).sort(), Array.from({ length: 200 }, (_, i) => `s:${i + 5}`).sort());
});

test("a remembered entry whose launcher still runs under a live host is never killed", async () => {
	const h = harness({ heartbeat: false });
	await h.engine.tick();
	h.writeManifest([]);
	h.clock.advance(60_000);
	const result = await mature(h);
	assert.deepEqual(result.findings, []);
	assert.deepEqual(h.killed, []);
	assert.ok(h.engine.snapshotState().memories.monitorOrphans.remembered["owner:m1"]);
});

test("kill-orphan-watchers decisions carry name:pid targets in execute and shadow", async () => {
	const auto = harness({ host: false });
	await mature(auto);
	const [executed] = killDecisions(auto);
	assert.equal(executed.result, "execute");
	assert.deepEqual(executed.action.params.targets.sort(), TARGETS);
	const shadow = harness({ host: false, mode: "shadow" });
	await mature(shadow);
	const [would] = killDecisions(shadow);
	assert.equal(would.result, "would");
	assert.deepEqual(would.action.params.targets.sort(), TARGETS);
});

test("orphan notices expire at 30 days or when the owner's session file is gone, quietly", async () => {
	const h = harness({ host: false, heartbeat: false, useDisk: true, sessionFile: true });
	await mature(h);
	const [pending] = pendingMessages(h.paths, "owner");
	assert.equal(pending.message.details.sessionFile, h.session);
	await h.engine.tick();
	assert.equal(pendingMessages(h.paths, "owner").length, 1);
	fs.rmSync(h.session);
	await h.engine.tick();
	assert.equal(pendingMessages(h.paths, "owner").length, 0);
	assert.deepEqual(fs.readdirSync(undeliveredDir(h)), [path.basename(pending.file)]);
	assert.equal(h.toasts.length, 0);

	const d = harness({ monitors: [] });
	const now = d.clock.now();
	const existing = path.join(d.paths.sessionsDir, "project", "x_present.jsonl");
	fs.writeFileSync(existing, "{}\n");
	const item = { description: "w", monitorId: "m", count: 1 };
	const notices = {
		old: composeMonitorOrphanNotice({ sessionId: "old", items: [{ ...item, sessionFile: existing }], now: now - 31 * DAY }),
		gone: composeMonitorOrphanNotice({ sessionId: "gone", items: [{ ...item, sessionFile: path.join(d.paths.sessionsDir, "project", "x_gone.jsonl") }], now }),
		present: composeMonitorOrphanNotice({ sessionId: "present", items: [{ ...item, sessionFile: existing }], now: now - 29 * DAY }),
		legacy: composeMonitorOrphanNotice({ sessionId: "legacy", items: [item], now: now - 29 * DAY }),
	};
	assert.equal(notices.legacy.details.sessionFile, undefined);
	for (const message of Object.values(notices)) sendToSession(d.paths, message);
	assert.deepEqual(sweepUndelivered(d.paths, now), []);
	const left = () => Object.keys(notices).filter((id) => pendingMessages(d.paths, id).length);
	assert.deepEqual(left(), ["present", "legacy"]);
	assert.equal(fs.readdirSync(undeliveredDir(d)).length, 2);
	assert.deepEqual(sweepUndelivered(d.paths, now + 2 * DAY), []);
	assert.deepEqual(left(), []);
	assert.equal(fs.readdirSync(undeliveredDir(d)).length, 4);
});

test("members of higher integrity than the daemon are never planned for a kill; equal integrity is killed", async () => {
	const elevated = () => baseRows().map((r) => ({ ...r, il: 12288 }));
	const medium = harness({ host: false, integrity: 8192, rows: elevated() });
	for (let i = 0; i < 4; i++) {
		assert.deepEqual((await medium.engine.tick()).findings, []);
		medium.clock.advance(60_000);
	}
	assert.deepEqual(medium.attempts, []);
	assert.deepEqual(killDecisions(medium), []);
	assert.deepEqual(medium.engine.snapshotState().memories.monitorOrphans.active, {});
	const high = harness({ host: false, integrity: 12288, rows: elevated() });
	await mature(high);
	assert.deepEqual(high.killed.sort(), [20, 21, 22, 23]);
});

test("a higher-integrity member found at perform time is skipped, never retried with a denied kill", async () => {
	// The daemon's own rights drop between the tick snapshot and perform()'s fresh re-check: the kill would be
	// denied, so it must not be attempted (status 1, "Access is denied") and must not loop.
	const elevated = () => baseRows().map((r) => r.p === 10 ? r : { ...r, il: 12288 });
	const h = harness({ host: false, heartbeat: false, integrity: [12288, 12288, 8192], rows: elevated() });
	assert.deepEqual((await h.engine.tick()).results, []);
	h.clock.advance(60_000);
	const result = await h.engine.tick();
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].outcome?.skipped, "no-longer-orphan");
	assert.equal(h.attempts.length, 0, "no denied taskkill runs");
	assert.equal(killDecisions(h)[0].result, "execute");
	// And a second tick does not plan it again.
	h.clock.advance(60_000);
	assert.equal((await h.engine.tick()).results.length, 0);
	assert.equal(h.attempts.length, 0);
});

const withdrawals = (h) => h.decisions.filter((d) => d.event === "notice-withdrawn").map((d) => d.result);
const receipts = (h) => fs.existsSync(h.paths.health.receiptsDir) ? fs.readdirSync(h.paths.health.receiptsDir) : [];

test("(a) the orphan's own stale manifest still listing the monitor does not withdraw a fresh notice", async () => {
	const h = harness({ host: false, useDisk: true });
	await mature(h);
	assert.deepEqual(h.killed.sort(), [20, 21, 22, 23]);
	for (let i = 0; i < 5; i++) {
		h.clock.advance(60_000);
		await h.engine.tick();
	}
	assert.equal(pendingMessages(h.paths, "owner").length, 1);
	assert.deepEqual(withdrawals(h), []);
});

test("(b) a new live watcher for the same monitor under a live host withdraws the notice as restored, with no receipt", async () => {
	const h = harness({ host: false, useDisk: true });
	await mature(h);
	assert.equal(pendingMessages(h.paths, "owner").length, 1);
	h.clock.advance(60_000);
	const restart = h.clock.now();
	h.live.set(50, row(50, "bun.exe", "bun C:/senpi/dist/bundle/cli.js", restart - 10_000));
	h.live.set(40, row(40, "bash.exe", `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${COMMAND}"`, restart, 50));
	h.writeManifest([monitor("m1", { runtime: { pid: 40, startedAtMs: restart } })]);
	await h.engine.tick();
	assert.equal(pendingMessages(h.paths, "owner").length, 0);
	assert.deepEqual(withdrawals(h), ["withdrawn:restored"]);
	assert.deepEqual(receipts(h), []);
	assert.deepEqual(h.killed.sort(), [20, 21, 22, 23], "the restored watcher is left alone");
});

test("(c) an undelivered notice older than 30 minutes is withdrawn as expired", async () => {
	const h = harness({ host: false, useDisk: true });
	await mature(h);
	h.clock.advance(30 * 60_000);
	await h.engine.tick();
	assert.equal(pendingMessages(h.paths, "owner").length, 1, "exactly 30 minutes is still kept");
	h.clock.advance(1);
	await h.engine.tick();
	assert.equal(pendingMessages(h.paths, "owner").length, 0);
	assert.deepEqual(withdrawals(h), ["withdrawn:expired"]);
});

test("(d) a persistent monitor's notice carries kill time and targets and never advises a re-arm", async () => {
	const h = harness({ host: false, useDisk: true, monitors: [monitor("m1", { persistent: true, durabilityClass: "restartable-command", expiresAt: START + DAY })] });
	await mature(h);
	const [{ message }] = pendingMessages(h.paths, "owner");
	assert.equal(message.details.killedAtMs, h.clock.now());
	assert.equal(message.details.expiresMs, h.clock.now() + 15 * 60_000);
	assert.deepEqual(message.details.killed.map((k) => Number(k.split(":")[0])).sort(), [20, 21, 22, 23]);
	assert.ok(message.details.killed.every((k) => /^\d+:.+/.test(k)));
	assert.deepEqual(message.details.monitors, [{ sessionId: "owner", monitorId: "m1", persistent: true }]);
	assert.deepEqual([message.deliverAs, message.triggerTurn], ["followUp", false]);
	assert.doesNotMatch(message.content, /Re-arm/i);
	assert.match(message.content, /senpi re-runs persistent monitors on restart/);
	assert.ok(message.content.includes(new Date(h.clock.now()).toISOString()));
	// The durabilityClass alone (no `persistent` field) is enough.
	const byClass = composeMonitorOrphanNotice({ sessionId: "s", now: START, items: [{ description: "w", monitorId: "m", count: 1, persistent: monitorOrphans.isPersistent({ durabilityClass: "restartable-command" }) }] });
	assert.doesNotMatch(byClass.content, /Re-arm/i);
});

test("rememberedEntry never stores an entry whose launcher predates the 30-day bound", () => {
	// The bound lives at the write and restore gates (rememberedEntry): nothing that old can reach unionMonitors.
	assert.equal(monitorOrphans.rememberedEntry(monitor("m1", { runtime: { pid: 20, startedAtMs: START - 31 * 24 * 3600_000 } }), START - 31 * 24 * 3600_000, START), undefined);
	assert.equal(monitorOrphans.restoreRemembered({ x: monitorOrphans.rememberedEntry(monitor("m1"), START - 20 * 24 * 3600_000, START - 20 * 24 * 3600_000) }, START)["owner:m1"].runtime.pid, 20);
	assert.deepEqual(Object.keys(monitorOrphans.restoreRemembered({ x: { monitorId: "m1" } }, START)), []);
});
