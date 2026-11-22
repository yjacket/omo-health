import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { runDaemon } from "../src/daemon.mjs";
import { appendDecision, readDecisions } from "../src/decisions.mjs";
import { auditBundle } from "../src/judge/audit.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { loadSessionRecord } from "../src/session-record.mjs";
import { fakeProc } from "./helpers/fake-proc.mjs";

const T0 = Date.parse("2026-11-22T12:00:00Z");
const changedWrite = 200_000;
const originalWrite = 125_000;

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-config-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	let now = T0;
	let edits = 0;
	function writeConfig(cacheStormWrite) {
		fs.writeFileSync(paths.health.configFile, JSON.stringify({ tokens: { cacheStormWrite } }));
		const mtimeSec = T0 / 1000 + edits++;
		fs.utimesSync(paths.health.configFile, mtimeSec, mtimeSec);
	}
	writeConfig(originalWrite);
	const config = () => loadConfig({ env: {}, paths }).config;
	const sessionId = "s-config";
	const recordFinding = () => appendDecision(paths, {
		ts: new Date(++now).toISOString(), event: "opened", fp: "config-finding", detector: "D4", kind: "cache-storm",
		subject: { sessionId }, evidence: ["cacheWrite:300000"],
	});
	async function run(...ticks) {
		const proc = fakeProc();
		await runDaemon({
			paths, config: config(), configEnv: {}, proc, clock: { now: () => now }, uptimeMs: 60_000,
			overrides: {
				env: {}, procs: { kind: "fake" },
				createEngine: () => ({
					tick() { ticks.shift()?.(); },
					table: { all: () => [] },
					close() {},
				}),
				sleep() {
					now += 15_000;
					if (!ticks.length) proc.emit("SIGTERM");
				},
			},
		});
	}
	function finding() {
		appendEnded(paths, { sessionId, kind: "main", startedMs: T0, endedMs: now }, { nowMs: now });
		const record = loadSessionRecord({ paths, id: sessionId, now, auditRetention: true });
		const bundle = auditBundle(record, null, { config: config(), now });
		assert.equal(bundle.omo_health_record.findings.length, 1);
		return bundle.omo_health_record.findings[0];
	}
	const hashes = () => readDecisions(paths).filter((row) => row.event === "config" && row.result !== "rejected").map((row) => row.thresholdsHash);
	return { writeConfig, recordFinding, run, finding, hashes };
}

test("offline threshold edit makes the previous finding's thresholds unknown after restart", async (t) => {
	const f = fixture(t);
	await f.run(f.recordFinding);
	f.writeConfig(changedWrite);
	await f.run();
	const finding = f.finding();
	assert.equal(finding.thresholdsKnown, false);
	assert.equal(Object.hasOwn(finding, "thresholds"), false);
	const hashes = f.hashes();
	assert.equal(hashes.length, 2, "one config decision per start");
	for (const hash of hashes) assert.match(hash, /^[a-f0-9]{64}$/);
	assert.notEqual(hashes[0], hashes[1]);
});

test("unchanged thresholds remain known across restart with matching start decisions", async (t) => {
	const f = fixture(t);
	await f.run(f.recordFinding);
	await f.run();
	const finding = f.finding();
	assert.equal(finding.thresholdsKnown, true);
	assert.equal(finding.thresholds.cacheStormWrite, originalWrite);
	const hashes = f.hashes();
	assert.equal(hashes.length, 2, "one config decision per start");
	assert.match(hashes[0], /^[a-f0-9]{64}$/);
	assert.equal(hashes[0], hashes[1]);
});

test("changing and restoring thresholds breaks continuity even when the current hash matches", async (t) => {
	const f = fixture(t);
	await f.run(() => {
		f.recordFinding();
		f.writeConfig(changedWrite);
	}, () => f.writeConfig(originalWrite), () => {});
	const finding = f.finding();
	assert.equal(finding.thresholdsKnown, false);
	assert.equal(Object.hasOwn(finding, "thresholds"), false);
	const hashes = f.hashes();
	assert.equal(hashes.length, 3, "startup, changed, and restored each have a decision");
	for (const hash of hashes) assert.match(hash, /^[a-f0-9]{64}$/);
	assert.notEqual(hashes[0], hashes[1]);
	assert.equal(hashes[0], hashes[2]);
});
