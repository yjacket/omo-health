import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/self.mjs";
import { makeWorld, raw } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const MB = 1024 * 1024;
const HOST_PID = 4000;
const host = (ageMs = 3600_000) => raw(HOST_PID, 1, "node.exe", new Date(NOW - ageMs).toISOString(), 0, 0, "node C:\\Users\\u\\senpi\\dist\\bundle\\cli.js");
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

const healthy = { pid: 1, tickLagMs: 1000, workerRestartsLastHour: 0, rssBytes: 80 * MB, cpuFrac: 0.01, parse: [], versions: { omoAi: "1.0.0", senpi: "2.0.0" }, previousVersions: { omoAi: "1.0.0", senpi: "2.0.0" } };
const selfWorld = (over = {}, extra = {}) => makeWorld({ now: NOW, self: { ...healthy, ...over }, ...extra });

test("healthy self -> nothing", () => {
	assert.deepEqual(detect(selfWorld()), []);
});

test("unknown events are informational and do not cause parse drift", () => {
	const world = selfWorld({
		parse: [{ source: "session.log", lines: 36, bad: 0, unknown: 2, unknownNames: ["todo_owed_backstop_suppressed", "todo_first_turn"], unknownCounts: { todo_owed_backstop_suppressed: 1, todo_first_turn: 1 }, unknownFirstSeenMs: { todo_owed_backstop_suppressed: NOW - MIN, todo_first_turn: NOW } }],
	});
	const findings = detect(world);
	assert.equal(ofKind(findings, "parse-drift").length, 0);
	const [finding] = ofKind(findings, "unknown-events");
	assert.equal(finding.detector, "D12");
	assert.equal(finding.severity, "info");
	assert.equal(finding.subject.key, "unknown-events:session.log");
	assert.deepEqual(finding.data, {
		source: "session.log",
		names: ["todo_first_turn", "todo_owed_backstop_suppressed"],
		counts: { todo_owed_backstop_suppressed: 1, todo_first_turn: 1 },
		firstSeenMs: { todo_owed_backstop_suppressed: NOW - MIN, todo_first_turn: NOW },
		degraded: false,
	});
});

test("parse-drift: > 5% bad over >= 20 lines -> warn degraded", () => {
	const world = selfWorld({ parse: [{ source: "logs", lines: 40, bad: 3, unknown: 0 }] });
	const [finding] = ofKind(detect(world), "parse-drift");
	assert.equal(finding.detector, "D12");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.data.source, "logs");
	assert.equal(finding.data.degraded, true);
	assert.ok(finding.titleKo && finding.detailKo);
	const few = selfWorld({ parse: [{ source: "logs", lines: 19, bad: 19, unknown: 0 }] });
	assert.equal(ofKind(detect(few), "parse-drift").length, 0);
});

test("session-parse-drift: broken lines in one session JSONL -> warn on that session, degraded", () => {
	const [finding] = ofKind(detect(selfWorld({ sessionParse: [{ id: "m1", lines: 10, bad: 3 }, { id: "m2", lines: 5000, bad: 2 }, { id: "m3", lines: 10, bad: 1 }] })), "session-parse-drift");
	assert.equal(finding.subject.sessionId, "m1");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.data.degraded, true);
	assert.ok(finding.titleKo);
	assert.equal(ofKind(detect(selfWorld({ sessionParse: [{ id: "m2", lines: 5000, bad: 2 }, { id: "m3", lines: 10, bad: 1 }] })), "session-parse-drift").length, 0);
});

test("version-changed: info when a version differs; nothing without previous versions", () => {
	const [finding] = ofKind(detect(selfWorld({ versions: { omoAi: "1.1.0", senpi: "2.0.0" } })), "version-changed");
	assert.equal(finding.severity, "info");
	assert.deepEqual(finding.data.changes, [{ name: "omoAi", from: "1.0.0", to: "1.1.0" }]);
	assert.equal(ofKind(detect(selfWorld({ versions: { omoAi: "1.1.0" }, previousVersions: undefined })), "version-changed").length, 0);
});

test("analyst-failing: warn once the analyst keeps failing, with its last error; nothing while healthy or unknown", () => {
	const last = { error: "timeout", jobId: "analyst-x", atMs: NOW - MIN };
	const [finding] = ofKind(detect(selfWorld({ analyst: { failing: true, holdOff: true, failures: 3, last } })), "analyst-failing");
	assert.deepEqual([finding.detector, finding.severity, finding.subject.key], ["D12", "warn", "self:analyst"]);
	assert.deepEqual(finding.evidence, ["failures:3", "error:timeout"]);
	assert.deepEqual(finding.data, { failures: 3, last });
	assert.ok(finding.titleKo && finding.detailKo);
	assert.equal(ofKind(detect(selfWorld({ analyst: { failing: false, holdOff: false, failures: 2 } })), "analyst-failing").length, 0);
	assert.equal(ofKind(detect(selfWorld()), "analyst-failing").length, 0);
	assert.equal(ofKind(detect(selfWorld({ judge: { failing: true, holdOff: true, failures: 3 } })), "judge-failing").length, 0, "the old judge feed is gone");
});

test("tick-lag and worker-restarts thresholds", () => {
	assert.equal(ofKind(detect(selfWorld({ tickLagMs: 121_000 })), "tick-lag")[0].severity, "warn");
	assert.equal(ofKind(detect(selfWorld({ tickLagMs: 120_000 })), "tick-lag").length, 0);
	assert.equal(ofKind(detect(selfWorld({ workerRestartsLastHour: 4 })), "worker-restarts")[0].severity, "warn");
	assert.equal(ofKind(detect(selfWorld({ workerRestartsLastHour: 3 })), "worker-restarts").length, 0);
});

test("self-budget: rss or cpu over budget", () => {
	const [rss] = ofKind(detect(selfWorld({ rssBytes: 301 * MB })), "self-budget");
	assert.equal(rss.severity, "warn");
	assert.equal(rss.data.overRss, true);
	assert.equal(rss.data.overCpu, false);
	const [cpu] = ofKind(detect(selfWorld({ cpuFrac: 0.06 })), "self-budget");
	assert.equal(cpu.data.overCpu, true);
	assert.equal(ofKind(detect(selfWorld({ rssBytes: 299 * MB, cpuFrac: 0.05 })), "self-budget").length, 0);
});

test("sensor-missing: live host without a fresh heartbeat -> info", () => {
	const world = selfWorld({}, { procSnapshots: [{ takenAtMs: NOW, rows: [host()] }] });
	const [finding] = ofKind(detect(world), "sensor-missing");
	assert.equal(finding.severity, "info");
	assert.equal(finding.subject.hostPid, HOST_PID);
	const stale = selfWorld({}, { procSnapshots: [{ takenAtMs: NOW, rows: [host()] }], sensors: [{ sessionId: "m1", pid: HOST_PID, ts: NOW - 6 * MIN }] });
	assert.equal(ofKind(detect(stale), "sensor-missing").length, 1);
});

test("sensor-missing: heartbeat within 5 min or a just-started host -> nothing", () => {
	const fresh = selfWorld({}, { procSnapshots: [{ takenAtMs: NOW, rows: [host()] }], sensors: [{ sessionId: "m1", pid: HOST_PID, ts: NOW - 4 * MIN }] });
	assert.equal(ofKind(detect(fresh), "sensor-missing").length, 0);
	const young = selfWorld({}, { procSnapshots: [{ takenAtMs: NOW, rows: [host(2 * MIN)] }] });
	assert.equal(ofKind(detect(young), "sensor-missing").length, 0);
});

test("unknown events seen only at info level are listed as quiet and never degrade or file", () => {
	const world = selfWorld({
		parse: [{ source: "session.log", lines: 40, bad: 0, unknown: 0, unknownNames: ["session_title_failed"], unknownLoudNames: [], unknownCounts: { session_title_failed: 897 }, unknownFirstSeenMs: { session_title_failed: NOW } }],
	});
	const findings = detect(world);
	assert.equal(ofKind(findings, "parse-drift").length, 0);
	const [finding] = ofKind(findings, "unknown-events");
	assert.equal(finding.subject.key, "unknown-events-quiet:session.log");
	assert.equal(finding.severity, "info");
	assert.deepEqual(finding.data, { source: "session.log", names: ["session_title_failed"], counts: { session_title_failed: 897 }, firstSeenMs: { session_title_failed: NOW }, degraded: false, quiet: true });
});

test("a source with loud and info-only unknown names reports each group on its own finding", () => {
	const world = selfWorld({
		parse: [{ source: "session.log", lines: 40, bad: 0, unknown: 3, unknownNames: ["quiet_one", "loud_one"], unknownLoudNames: ["loud_one"], unknownCounts: { quiet_one: 5, loud_one: 3 }, unknownFirstSeenMs: { quiet_one: NOW - MIN, loud_one: NOW } }],
	});
	const found = ofKind(detect(world), "unknown-events");
	const loud = found.find((f) => !f.data.quiet);
	const quiet = found.find((f) => f.data.quiet);
	assert.deepEqual(loud.data.names, ["loud_one"]);
	assert.deepEqual(loud.data.counts, { loud_one: 3 });
	assert.deepEqual(quiet.data.names, ["quiet_one"]);
	assert.deepEqual(quiet.data.counts, { quiet_one: 5 });
	assert.notEqual(loud.fp, quiet.fp);
});
