import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as stall from "../src/detect/stall.mjs";
import { makeWorld, raw, sessionState, taskRecord } from "./helpers/world.mjs";

const T = Date.parse("2026-09-29T12:48:01.000Z");
const HOST_PID = 25760;
const iso = (ms) => new Date(ms).toISOString();
/** A token whose first characters end just before the cut at `max` (max - 1 kept characters plus an ellipsis): only "sk-ant-ZZ" would remain, too short for the pattern. */
const leak = (max) => `${"a".repeat(max - 10)}sk-ant-${"Z".repeat(40)}`;

/** The D1 stall finding for a subagent whose pending bash call runs `cmd` (a node child keeps it busy). */
function stallFinding(cmd) {
	const record = taskRecord({ taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", childSessionId: "c1", createdAtMs: T - 3600_000 });
	const child = sessionState({ id: "c1", kind: "child", taskId: "st_c", hostPid: HOST_PID, parentSessionId: "p1", task: record, lastActivityMs: T, pendingCalls: [{ id: "call1", name: "bash", args: { command: cmd }, ms: T }] });
	const now = T + 12 * 60_000;
	const rows = [
		raw(HOST_PID, 20000, "node.exe", "2026-09-29T09:00:00Z", 0, 1e8, "node C:/npm/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js"),
		raw(100, HOST_PID, "bash.exe", iso(T + 5), 0, 2e6, `"C:/Program Files/Git/bin/bash.exe" -c "${cmd}"`),
		raw(101, 100, "node.exe", iso(T + 40), 0, 5e7, "node driver.mjs"),
	];
	const world = makeWorld({ now, sessions: [child], procSnapshots: [0, 1, 2].map((i) => ({ takenAtMs: now - (2 - i) * 20_000, rows })) });
	return stall.detect(world, {}).find((f) => f.kind === "stall");
}

test("a stall finding's command head is redacted before it is cut, so a cut token cannot slip under the pattern (#82 round 2)", () => {
	const finding = stallFinding(leak(400));
	assert.ok(finding.data.call.commandHead.startsWith("aaaa"), "the finding carries the command head");
	assert.doesNotMatch(finding.data.call.commandHead, /sk-ant-[A-Za-z0-9]/);
});

test("a stall finding's title is redacted before its 60-character cut (#82)", () => {
	const finding = stallFinding(leak(60));
	assert.match(finding.titleKo, /aaaa/, "the title carries the command head");
	assert.doesNotMatch(finding.titleKo, /sk-ant-[A-Za-z0-9]/);
});
