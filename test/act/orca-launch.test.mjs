import "../helpers/tmp-root.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchInOrca } from "../../src/act/orca-launch.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(dir, "fake-orca.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orca-launch-"));
const sid = "test123456789";
const worktreeId = "repo-123::C:/my/workspace";
const envelope = (result) => JSON.stringify({ id: "fixture", ok: true, result });
const worktrees = envelope({ worktrees: [{ worktreeId, path: "c:\\MY\\WORKSPACE" }] });

function run({ cwd = "C:/my/workspace", sessionId = sid, prefix, qa = false, fixtures = {} } = {}) {
	const record = path.join(tmp, `${Date.now()}-${Math.random()}.json`);
	const logFile = path.join(tmp, `${Date.now()}-${Math.random()}-calls.json`);
	const spawnOptions = [];
	const env = {
		...process.env,
		ORCA_CLI_COMMAND: process.execPath,
		ORCA_FIXTURES: JSON.stringify({
			"status --json": envelope({ app: { running: true } }),
			"worktree ps --json": worktrees,
			"terminal create": envelope({ terminal: { handle: "term_fixture_123" } }),
			...fixtures,
		}),
		ORCA_CALL_LOG: logFile,
		...(qa ? { OMO_HEALTH_QA: "1" } : {}),
	};
	const spawnSync = (cmd, args, options) => {
		spawnOptions.push(options);
		if (cmd !== process.execPath) return nodeSpawnSync(cmd, args, options);
		return nodeSpawnSync(cmd, [fakeCli, ...args], { ...options, env });
	};
	const result = launchInOrca({ cwd, sessionId, qaCommandPrefix: prefix }, { env, spawnSync });
	const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
	fs.rmSync(logFile, { force: true });
	return { result, calls, spawnOptions };
}

test("success pins full create argv, returned handle, timeout and shell safety", () => {
	const { result, calls, spawnOptions } = run();
	assert.deepEqual(result, { ok: true, handle: "term_fixture_123" });
	assert.deepEqual(calls.map((c) => c.argv), [
		["status", "--json"],
		["worktree", "ps", "--json"],
		["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", "resume test1234", "--command", `omo --session ${sid}`, "--json"],
	]);
	for (const options of spawnOptions) {
		assert.equal(options.shell, undefined);
		assert.equal(options.windowsHide, true);
		assert.equal(options.timeout, 15000);
	}
});

test("Orca unavailable and malformed status fail closed", () => {
	assert.deepEqual(run({ fixtures: { "status --json": { status: 1, stdout: "" } } }).result, { ok: false, reason: "orca-not-running" });
	assert.deepEqual(run({ fixtures: { "status --json": "not json" } }).result, { ok: false, reason: "orca-status-invalid" });
});

test("missing cwd worktree returns failure without terminal create", () => {
	const { result, calls } = run({ cwd: "C:/nonexistent" });
	assert.deepEqual(result, { ok: false, reason: "no-worktree-match" });
	assert.equal(calls.some((call) => call.argv[0] === "terminal"), false);
});

test("invalid session ids and unsafe cwd never create a terminal", () => {
	for (const sessionId of ["short", 'abcd1234" && calc', "abcd1234&calc"]) {
		const { result, calls } = run({ sessionId });
		assert.deepEqual(result, { ok: false, reason: "invalid-sid" });
		assert.equal(calls.length, 0);
	}
	for (const cwd of ['C:/my/"workspace', "C:/my/work&space"]) {
		const { result, calls } = run({ cwd });
		assert.deepEqual(result, { ok: false, reason: "no-worktree-match" });
		assert.equal(calls.some((call) => call.argv[0] === "terminal"), false);
	}
});

test("QA command prefixes accept one to three safe environment assignments only", () => {
	const accepted = [
		"$env:OMO_LIMITLESS_TEST='value'; ",
		"$env:OMO_LIMITLESS_FAKE_USAGE_FILE='C:\\QA Data\\usage.json'; $env:OMO_HEALTH_HOME='C:/QA Home'; $env:OMO_LIMITLESS_CONFIG='C:\\config\\qa.toml'; ",
	];
	const rejected = [
		"$env:OMO_LIMITLESS_A='1'; $env:OMO_HEALTH_B='2'; $env:OMO_LIMITLESS_C='3'; $env:OMO_HEALTH_D='4'; ",
		"$env:OMO_OTHER_X='value'; ",
		...["&", "|", "<", ">", '"', "'", "`", "$", ";", "^", "%"].map((char) => `$env:OMO_LIMITLESS_X='value${char}tail'; `),
		"$env:OMO_LIMITLESS_X='value';",
		"$env:OMO_LIMITLESS_X=value; ",
		"set OMO_LIMITLESS_X=value && ",
	];
	const command = (calls) => calls[2].argv;
	for (const prefix of accepted) {
		const calls = run({ prefix, qa: true }).calls;
		assert.deepEqual(command(calls), ["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", "resume test1234", "--command", `${prefix}omo --session ${sid}`, "--json"]);
	}
	for (const prefix of rejected) {
		const calls = run({ prefix, qa: true }).calls;
		assert.deepEqual(command(calls), ["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", "resume test1234", "--command", `omo --session ${sid}`, "--json"]);
	}
	const gatedOff = run({ prefix: accepted[0] }).calls;
	assert.deepEqual(command(gatedOff), ["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", "resume test1234", "--command", `omo --session ${sid}`, "--json"]);
});

test("create CLI errors, malformed output and success without handle fail closed", () => {
	assert.deepEqual(run({ fixtures: { "terminal create": { status: 1, stdout: "" } } }).result, { ok: false, reason: "terminal-create-failed" });
	assert.deepEqual(run({ fixtures: { "terminal create": "not json" } }).result, { ok: false, reason: "terminal-create-invalid" });
	assert.deepEqual(run({ fixtures: { "terminal create": envelope({ created: true }) } }).result, { ok: false, reason: "no-handle-returned" });
});
