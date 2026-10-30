import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { executeKill } from "../src/act/kill.mjs";
import { normalizeRows, ProcessTracker } from "../src/collect/procs.mjs";
import { applyConfigInPlace, DEFAULT_CONFIG } from "../src/config.mjs";
import * as runaway from "../src/detect/runaway.mjs";
import * as stall from "../src/detect/stall.mjs";
import { createEngine } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { sessionState, taskRecord } from "./helpers/world.mjs";

// The runaway-grep kill scenario of test/engine.test.mjs (harness), run twice on one engine and one config object.
const CALL_MS = Date.parse("2026-09-23T15:37:04.874Z");
const HOST = 25760;
const iso = (ms) => new Date(ms).toISOString();
const GREP = "grep -o 'x\\{0,1800\\}y' omo.js | head -1";
const SHELL = `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${GREP.replace(/"/g, '\\"')}"`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-engine-switch-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** Process rows of one grep tool call started at callMs (shell, head, and the runaway grep). */
function callRows(callMs, { shell, head, grep }) {
	return [
		[shell, { p: shell, pp: HOST, n: "bash.exe", c: iso(callMs + 5), cpu: 0, pv: 1e6, cl: SHELL }],
		[head, { p: head, pp: shell, n: "head.exe", c: iso(callMs + 50), cpu: 0, pv: 1e6, cl: "head -1" }],
		[grep, { p: grep, pp: 62120, n: "grep.exe", c: iso(callMs + 400), cpu: 0, pv: 5e8, cl: '"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -o x\\{0,1800\\}y omo.js' }],
	];
}

test("a kill switch turned off in place gates the next finding of the same engine", { timeout: 20_000 }, async () => {
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(CALL_MS + 9 * 60_000);
	const config = structuredClone({ ...DEFAULT_CONFIG, procSnapshotMs: 20_000 });
	const task = taskRecord({ taskId: "st_01a0ced9", status: "running", hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", backgroundMode: "background", childSessionId: "c1" });
	const child = sessionState({ id: "c1", kind: "child", taskId: task.taskId, hostPid: HOST, parentSessionId: "p1", rootSessionId: "p1", task, pendingCalls: [{ id: "toolu_grep", name: "bash", args: { command: GREP }, ms: CALL_MS, batchId: "b" }] });
	const parent = sessionState({ id: "p1", kind: "main", hostPid: HOST, lastMessage: { role: "assistant", stopReason: "stop" } });
	const sessions = new Map([["c1", child], ["p1", parent]]);
	const procRows = new Map([[HOST, { p: HOST, pp: 1, n: "node.exe", c: "2026-09-23T09:00:00Z", cpu: 0, pv: 1e8, cl: "node C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" }], ...callRows(CALL_MS, { shell: 60168, head: 60180, grep: 55000 })]);
	const tracker = new ProcessTracker();
	const killed = [];
	const engine = createEngine({
		paths,
		config,
		clock,
		detectors: [
			{ name: "stall", ...stall },
			{ name: "runaway", ...runaway },
		],
		sources: {
			procs: {
				async snapshot() {
					for (const row of procRows.values()) if (row.n === "grep.exe") row.cpu += 19_500;
					return { takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) };
				},
				async os() {
					return { commitFrac: 0.5, commitUsedBytes: 1, commitLimitBytes: 2 };
				},
				async ports() {
					return [];
				},
				restarts: 0,
				close() {},
			},
			registry: { refresh: () => ({ sessions, tasks: [task] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
		},
		actors: {
			kill: (args) =>
				executeKill({
					...args,
					snapshot: async () => tracker.update({ takenAtMs: clock.now(), rows: normalizeRows([...procRows.values()]) }),
					runner: (pid) => {
						killed.push(pid);
						procRows.delete(pid);
						return { status: 0 };
					},
					sleep: async () => {},
				}),
			send: () => "inbox-file",
			notifier: { toast: () => ({ ok: true }) },
			decide: () => {},
			sensors: () => new Map([["p1", { sessionId: "p1", pid: HOST, ts: clock.now(), idle: true }]]),
			judge: { judge: async () => ({ verdict: "escalate", reason: "test" }) },
		},
		options: { selfPid: 1 },
	});
	const killResultsUntil = async (untilMs) => {
		const out = [];
		while (clock.now() <= untilMs) {
			out.push(...(await engine.tick()).results.filter((r) => r.kind === "kill-pids"));
			clock.advance(20_000);
		}
		return out;
	};

	// Given tick series 1: finding A (runaway grep 55000) is killed.
	const first = await killResultsUntil(CALL_MS + 10 * 60_000 + 10_000);
	assert.deepEqual(first.map((r) => r.result), ["execute"]);
	assert.deepEqual(killed, [55000]);
	const fpA = first[0].fp;
	child.pending.clear();
	await engine.tick();

	// When: the reloader turns actions.kill off in the same config object.
	applyConfigInPlace(config, { ...config, actions: { ...config.actions, kill: false } });

	// Then: finding B (a new call, a new fp) is gated off.
	const callB = clock.now();
	for (const [pid, row] of callRows(callB, { shell: 61168, head: 61180, grep: 56000 })) procRows.set(pid, row);
	child.pending.set("toolu_grep2", { batchId: "b2", index: 0, batchSize: 1, id: "toolu_grep2", name: "bash", args: { command: GREP }, ms: callB });
	const second = await killResultsUntil(callB + 10 * 60_000 + 10_000);
	assert.equal(second.length, 1);
	assert.notEqual(second[0].fp, fpA);
	assert.equal(second[0].result, "skipped:switch-off");
	assert.deepEqual(killed, [55000]);
});
