import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { acceptReports, importLegacyIntake, queueReport, REPORT_DEDUPE_MS, REPORT_TEXT_MAX, REPORTS_PER_HOUR } from "../src/reports/intake.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";

function sandbox() {
	const root = tmpDir("omoh-intake-");
	return resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
}

const queuedNames = (paths) => fs.readdirSync(paths.health.intakeDir).filter((name) => name.endsWith(".json"));

test("the intake queue lives under the health home, outside care/", () => {
	const paths = sandbox();
	assert.equal(paths.health.intakeDir, path.join(paths.healthHome, "intake"));
	assert.equal(paths.health.deathsDir, path.join(paths.healthHome, "deaths"));
	const queued = queueReport(paths, { subject: "st_test", text: "tool hung", via: "cli", now: 1000 });
	assert.equal(queued.outcome, "queued");
	assert.equal(path.dirname(queued.file), paths.health.intakeDir);
	assert.deepEqual(queuedNames(paths), [path.basename(queued.file)]);
});

test("an identical report is a duplicate within the dedupe window and counts again after it", () => {
	const paths = sandbox();
	assert.equal(queueReport(paths, { subject: "st_c", text: "hang", via: "cli", now: 1000 }).outcome, "queued");
	assert.equal(queueReport(paths, { subject: "st_c", text: "  HANG ", via: "cli", now: 1100 }).outcome, "duplicate");
	assert.equal(queuedNames(paths).length, 1);
	assert.equal(queueReport(paths, { subject: "st_c", text: "hang", via: "cli", now: 1000 + REPORT_DEDUPE_MS + 1 }).outcome, "queued");
});

test("at most REPORTS_PER_HOUR reports queue within the hour, and invalid ones never queue", () => {
	const paths = sandbox();
	for (let i = 0; i < REPORTS_PER_HOUR; i++) assert.equal(queueReport(paths, { subject: "st_c", text: `symptom ${i}`, via: "cli", now: 1000 + i }).outcome, "queued");
	assert.equal(queueReport(paths, { subject: "st_c", text: "one more", via: "cli", now: 2000 }).outcome, "rate-limited");
	assert.equal(queueReport(paths, { subject: "../x", text: "t", via: "cli", now: 2000 }).outcome, "invalid");
	assert.equal(queueReport(paths, { subject: "st_c", text: "   ", via: "cli", now: 2000 }).outcome, "invalid");
	assert.equal(queuedNames(paths).length, REPORTS_PER_HOUR);
});

test("a queued report's text is redacted before it is cut, so a cut token never reaches the queue file (#82 round 2)", () => {
	const paths = sandbox();
	const text = `${"a".repeat(2000 - 10)}sk-ant-${"Z".repeat(40)}`;
	const queued = queueReport(paths, { subject: "st_c", text, via: "cli", now: 1000 });
	assert.equal(queued.outcome, "queued");
	assert.ok(queued.report.text.startsWith("aaaa"));
	assert.doesNotMatch(fs.readFileSync(queued.file, "utf8"), /sk-ant-[A-Za-z0-9]/);
});

test("a legacy care/intake is imported once: queued and processed files move, a present name wins, the directory goes", () => {
	const paths = sandbox();
	const legacy = path.join(paths.health.legacyCareDir, "intake");
	const write = (file, body) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(body));
	};
	write(path.join(legacy, "1000-a.json"), { v: 1, id: "a", atMs: 1000, via: "sensor", subject: "st_c", text: "old queued" });
	write(path.join(legacy, "processed", "900-p.json"), { v: 1, id: "p", atMs: 900, processedMs: 950, subject: "st_c", text: "done", outcome: "recorded" });
	write(path.join(legacy, "1100-b.json"), { v: 1, id: "b", text: "legacy copy" });
	write(path.join(paths.health.intakeDir, "1100-b.json"), { v: 1, id: "b", text: "current copy" });
	assert.equal(importLegacyIntake(paths, legacy), 2);
	assert.equal(fs.existsSync(legacy), false);
	assert.deepEqual(queuedNames(paths).sort(), ["1000-a.json", "1100-b.json"]);
	assert.equal(JSON.parse(fs.readFileSync(path.join(paths.health.intakeDir, "1100-b.json"), "utf8")).text, "current copy");
	assert.ok(fs.existsSync(path.join(paths.health.intakeDir, "processed", "900-p.json")));
	assert.equal(queueReport(paths, { subject: "st_c", text: "done", via: "cli", now: 1000 }).outcome, "duplicate", "imported processed records still count");
	assert.equal(importLegacyIntake(paths, legacy), 0);
});

const PARENT = "01a0ecd5-1e30-7c72-9467-1bdf4ee5995b";
/** A tick world holding subagent st_c (session c1) of main session PARENT. */
const reportWorld = () => makeWorld({ sessions: [sessionState({ id: "c1", kind: "child", taskId: "st_c", parentSessionId: PARENT, task: taskRecord({ taskId: "st_c" }) })] });
const processed = (paths) => {
	const dir = path.join(paths.health.intakeDir, "processed");
	return fs.readdirSync(dir).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
};
/** What the sensor writes for `/health report`: the daemon, not the writer, dedupes and rate-limits it. */
const sensorReport = (paths, report) => {
	fs.mkdirSync(paths.health.intakeDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.intakeDir, `${report.atMs}-${report.id}.json`), JSON.stringify({ v: 1, via: "sensor", ...report }));
};
const accept = (paths, atMs, tickResult, capture) => acceptReports({ paths, atMs, tickResult, capture });

test("an accepted report goes to the triage with its subject, the subject's top finding and its snapshot", () => {
	const paths = sandbox();
	const world = reportWorld();
	const d1 = { detector: "D1", kind: "stall", cls: "inproc", severity: "warn", subject: { sessionId: "c1", taskId: "st_c", parentSessionId: PARENT }, evidence: ["tool:read"], data: {} };
	assert.equal(queueReport(paths, { subject: "st_c", text: "subagent looks stuck", via: "cli", now: 1500 }).outcome, "queued");
	const captures = [];
	const { accepted, failures } = accept(paths, 2000, { findings: [d1], world }, (w, id, reason) => (captures.push([w, id, reason.kind]), "C:/snapshots/r.json"));
	assert.deepEqual(failures, []);
	// Handed to the engine, which triages the report and answers the session that owns st_c (#60 item 5).
	assert.deepEqual(accepted.map((r) => [r.report.text, r.snapshot, r.subject.sessionId, r.subject.taskId, r.subject.parentSessionId, r.subject.kind, r.top.cls]), [["subagent looks stuck", "C:/snapshots/r.json", "c1", "st_c", PARENT, "child", "inproc"]]);
	assert.deepEqual(captures, [[world, "st_c", "report"]]);
	assert.deepEqual(processed(paths).map((r) => [r.outcome, r.snapshot]), [["recorded", "C:/snapshots/r.json"]]);
	assert.deepEqual(queuedNames(paths), []);
});

test("the daemon accepts an identical report once an hour and at most REPORTS_PER_HOUR an hour", () => {
	const HOUR = 3600_000;
	const paths = sandbox();
	const world = reportWorld();
	assert.equal(queueReport(paths, { subject: "st_c", text: "hang", via: "cli", now: 1000 }).outcome, "queued");
	sensorReport(paths, { id: "s1", atMs: 1200, subject: "st_c", text: "hang" });
	assert.equal(accept(paths, 2000, { findings: [], world }).accepted.length, 1);
	assert.deepEqual(processed(paths).map((r) => r.outcome), ["recorded", "duplicate"]);
	for (let i = 1; i <= REPORTS_PER_HOUR; i++) sensorReport(paths, { id: `x${i}`, atMs: 3000 + i, subject: "st_c", text: `symptom ${i}` });
	assert.equal(accept(paths, 4000, { findings: [], world }).accepted.length, REPORTS_PER_HOUR - 1);
	assert.deepEqual(processed(paths).slice(2).map((r) => r.outcome), [...Array(REPORTS_PER_HOUR - 1).fill("recorded"), "rate-limited"]);
	assert.equal(queueReport(paths, { subject: "st_c", text: "one more", via: "cli", now: 5000 }).outcome, "rate-limited");
	assert.equal(queueReport(paths, { subject: "st_c", text: "hang", via: "cli", now: 2000 + HOUR + 1 }).outcome, "queued", "an hour later the same report counts again");
});

test("a failing claim write leaves the report queued, and a retry accepts it once", () => {
	const paths = sandbox();
	const world = reportWorld();
	const processedDir = path.join(paths.health.intakeDir, "processed");
	queueReport(paths, { subject: "st_c", text: "stuck", via: "cli", now: 1000 });
	// A file where a directory belongs makes writes into it throw, as a locked or full disk would.
	fs.writeFileSync(processedDir, "");
	const blocked = accept(paths, 2000, { findings: [], world });
	assert.deepEqual([blocked.failures.map((f) => f.subject), blocked.accepted], [["st_c"], []]);
	assert.equal(queuedNames(paths).length, 1, "the report stays queued");
	fs.rmSync(processedDir);
	assert.equal(accept(paths, 3000, { findings: [], world }).accepted.length, 1);
	assert.deepEqual([processed(paths).map((r) => r.outcome), queuedNames(paths)], [["recorded"], []]);
	// A queue file whose removal failed after the claim outlives it: the next tick only finishes the removal.
	const [name] = fs.readdirSync(processedDir);
	fs.copyFileSync(path.join(processedDir, name), path.join(paths.health.intakeDir, name));
	assert.deepEqual(accept(paths, 4000, { findings: [], world }).accepted, []);
	assert.deepEqual([processed(paths).map((r) => r.outcome), queuedNames(paths)], [["recorded"], []]);
});

test("reports wait for a tick world, and a report on a parent session meets its subagent's finding", () => {
	const paths = sandbox();
	const world = reportWorld();
	queueReport(paths, { subject: "st_c", text: "quiet for 20 min", via: "cli", now: 1000 });
	assert.deepEqual(accept(paths, 1500, {}).accepted, []);
	assert.equal(queuedNames(paths).length, 1, "without a world the report stays queued");
	const [undetected] = accept(paths, 2000, { findings: [], world }).accepted;
	assert.equal(undetected.top, undefined);
	const progressing = { detector: "D1", kind: "stall", cls: "progressing", severity: "info", subject: { sessionId: "c1", taskId: "st_c", parentSessionId: PARENT }, evidence: [], data: {} };
	assert.equal(queueReport(paths, { subject: PARENT, text: "my subagent hangs", via: "sensor", now: 3000 }).outcome, "queued");
	const [onParent] = accept(paths, 4000, { findings: [progressing], world }).accepted;
	assert.equal(onParent.top.cls, "progressing");
});

test("processed/ retention never trims what the hourly cap and duplicate check still read (#82)", () => {
	const HOUR = 3600_000;
	const now = 10 * HOUR;
	const paths = sandbox();
	const dir = path.join(paths.health.intakeDir, "processed");
	fs.mkdirSync(dir, { recursive: true });
	const record = (ms, id, outcome) => fs.writeFileSync(path.join(dir, `${ms}-${id}.json`), JSON.stringify({ v: 1, id, atMs: ms, processedMs: ms, via: "sensor", subject: "st_c", text: `symptom ${id}`, outcome }));
	for (let i = 0; i < 5; i++) record(now - 3 * HOUR + i, `old${i}`, "duplicate");
	for (let i = 0; i < REPORTS_PER_HOUR; i++) record(now - 50 * 60_000 + i, `rec${i}`, "recorded");
	// More than the 500 kept files in the hour, all later than the recorded ones.
	for (let i = 0; i < 505; i++) record(now - 30 * 60_000 + i, `dup${i}`, "duplicate");
	sensorReport(paths, { id: "q1", atMs: now - 1000, subject: "st_c", text: "one more" });
	accept(paths, now, { findings: [], world: reportWorld() });
	assert.equal(processed(paths).at(-1).outcome, "rate-limited", "the queued report met the cap");
	assert.equal(processed(paths).filter((r) => r.outcome === "recorded").length, REPORTS_PER_HOUR, "the recorded reports of the hour are kept");
	assert.equal(processed(paths).length, 500, "the file cap holds: the oldest uncounted records went, the counted ones stayed");
	assert.equal(queueReport(paths, { subject: "st_c", text: "yet another", via: "cli", now: now + 1000 }).outcome, "rate-limited");
});

test("under a flood of duplicate, rate-limited and invalid reports, retention trims those and keeps only the recorded ones the cap counts (#82 round 2)", () => {
	const HOUR = 3600_000;
	const now = 10 * HOUR;
	const paths = sandbox();
	const dir = path.join(paths.health.intakeDir, "processed");
	fs.mkdirSync(dir, { recursive: true });
	const record = (ms, id, outcome) => fs.writeFileSync(path.join(dir, `${ms}-${id}.json`), JSON.stringify({ v: 1, id, atMs: ms, processedMs: ms, via: "sensor", subject: "st_c", text: `symptom ${id}`, outcome }));
	// The recorded ones the hourly cap counts: three at the very start of the hour, the rest spread among the flood.
	for (let i = 0; i < REPORTS_PER_HOUR; i++) record(i < 3 ? now - 55 * 60_000 + i : now - 50 * 60_000 + 10 * 30 * i, `rec${i}`, "recorded");
	for (let i = 0; i < 250; i++) record(now - 50 * 60_000 + 10 * i + 1, `dup${i}`, "duplicate");
	for (let i = 0; i < 250; i++) record(now - 50 * 60_000 + 10 * i + 2, `rl${i}`, "rate-limited");
	for (let i = 0; i < 50; i++) record(now - 50 * 60_000 + 10 * i + 3, `bad${i}`, "invalid");
	sensorReport(paths, { id: "q1", atMs: now - 1000, subject: "st_c", text: "one more" });
	accept(paths, now, { findings: [], world: reportWorld() });
	const kept = processed(paths);
	assert.equal(kept.length, 500, "the directory is back to the file cap");
	assert.equal(kept.filter((r) => r.outcome === "recorded").length, REPORTS_PER_HOUR, "every counted record is still there");
	assert.equal(kept.at(-1).outcome, "rate-limited", "the queued report met the cap");
	assert.equal(queueReport(paths, { subject: "st_c", text: "yet another", via: "cli", now: now + 1000 }).outcome, "rate-limited", "and the cap still holds");
});

test("a sensor report is redacted and then cut when the daemon accepts it, so no token reaches processed/ or the triage (#82)", () => {
	const paths = sandbox();
	// The sensor keeps REPORT_TEXT_MAX plus a margin, so a token straddling the cut arrives whole.
	const text = `${"a".repeat(REPORT_TEXT_MAX - 10)}sk-ant-${"Z".repeat(40)}`;
	sensorReport(paths, { id: "s1", atMs: 1000, subject: "st_c", reporterSessionId: PARENT, text });
	const { accepted } = accept(paths, 2000, { findings: [], world: reportWorld() });
	const [record] = processed(paths);
	assert.equal(record.outcome, "recorded");
	assert.ok(record.text.startsWith("aaaa") && record.text.length <= REPORT_TEXT_MAX);
	assert.doesNotMatch(JSON.stringify(record), /sk-ant-[A-Za-z0-9]/);
	assert.doesNotMatch(JSON.stringify(accepted), /sk-ant-[A-Za-z0-9]/);
});
