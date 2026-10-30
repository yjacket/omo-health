import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/leftovers.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const MIN = 60_000;
const CTIME = new Date(NOW - 2 * 3600_000).toISOString();
const SERVER = () => raw(900, 1, "node.exe", CTIME, 0, 0, "node server.js");
const KEY = `900@${CTIME}`;

function world({ task, sessions = [sessionState({ id: "c1", kind: "child", taskId: "st_l" })], att = {}, rows = [SERVER()], ports } = {}) {
	return makeWorld({
		now: NOW,
		sessions,
		tasks: [task ?? taskRecord({ taskId: "st_l", status: "completed", terminalAtMs: NOW - 40 * MIN })],
		procSnapshots: [{ takenAtMs: NOW, rows }],
		ports,
		attributed: new Map([[KEY, { sessionId: "c1", taskId: "st_l", toolCallId: "call1", sinceMs: NOW - 60 * MIN, role: "detached-server", ...att }]]),
	});
}

test("leftover-process: alive process of a task terminal past minAgeMs", () => {
	const [finding] = detect(world({ ports: [{ port: 18080, pid: 900, address: "127.0.0.1" }, { port: 5000, pid: 1 }] }));
	assert.equal(finding.detector, "D9");
	assert.equal(finding.kind, "leftover-process");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.data.pid, 900);
	assert.equal(finding.data.ctime, CTIME);
	assert.equal(finding.data.name, "node.exe");
	assert.equal(finding.data.killCommand, "taskkill /F /PID 900");
	assert.deepEqual(finding.data.ports, [18080]);
	assert.equal(finding.data.remedy, undefined);
	assert.ok(finding.titleKo && finding.detailKo);
});

test("leftover-process: session gone counts as owner gone", () => {
	const [finding] = detect(world({ sessions: [], task: taskRecord({ taskId: "other" }), att: { taskId: undefined } }));
	assert.equal(finding.data.pid, 900);
	assert.equal(finding.data.ports, undefined);
});

test("leftover-process: young terminal task, running task, dead or reused pid -> nothing", () => {
	assert.equal(detect(world({ task: taskRecord({ taskId: "st_l", status: "completed", terminalAtMs: NOW - 10 * MIN }) })).length, 0);
	assert.equal(detect(world({ task: taskRecord({ taskId: "st_l", status: "running" }) })).length, 0);
	assert.equal(detect(world({ rows: [raw(1, 0, "explorer.exe", CTIME)] })).length, 0);
	assert.equal(detect(world({ rows: [raw(900, 1, "node.exe", new Date(NOW - MIN).toISOString())] })).length, 0);
});
