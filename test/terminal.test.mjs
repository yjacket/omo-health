import "./helpers/tmp-root.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CRASH_RESUME_PROMPT, createHerdrCli, isIdleShell, resumeCommand, resumeInNewTab, sameDir } from "../src/act/terminal.mjs";

const CWD = "C:\\tmp\\repo-a\\";
const SID = "ses-abc12345-def";
const terminal = { kind: "herdr", workspaceId: "wB", tabId: "wB:t1", paneId: "wB:p1" };
const ok = (result) => ({ status: 0, stdout: JSON.stringify({ result }), stderr: "" });
const idle = (paneId) => ok({ process_info: { pane_id: paneId, shell_pid: 10, foreground_processes: [{ pid: 10 }] } });
const busy = () => ok({ process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }, { pid: 99, name: "bun.exe" }] } });

function harness(overrides = {}) {
	const calls = [];
	const scripts = {
		get: () => ok({ pane: { pane_id: "wB:p1", cwd: CWD } }),
		crashedInfo: () => idle("wB:p1"),
		create: () => ok({ tab: { tab_id: "wB:t2" }, root_pane: { pane_id: "wB:p2", cwd: CWD } }),
		newInfo: () => idle("wB:p2"),
		// herdr 0.9.0 prints nothing on a successful `pane run`.
		run: () => ({ status: 0, stdout: "", stderr: "" }),
		close: () => ok({ type: "ok" }),
		...overrides,
	};
	const spawnSync = (bin, args) => {
		calls.push(args);
		const [a, b] = args;
		if (a === "pane" && b === "get") return scripts.get();
		if (a === "pane" && b === "process-info") return args[3] === "wB:p1" ? scripts.crashedInfo() : scripts.newInfo();
		if (a === "tab" && b === "create") return scripts.create();
		if (a === "pane" && b === "run") return scripts.run();
		if (a === "tab" && b === "close") return scripts.close();
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	const cli = createHerdrCli({ spawnSync, exists: () => true });
	const sleeps = [];
	const run = (extra = {}) => resumeInNewTab({ terminal, cwd: CWD, sessionId: SID, label: "lbl", cli, exists: () => true, sleep: async (ms) => sleeps.push(ms), ...extra });
	const has = (a, b) => calls.some((c) => c[0] === a && c[1] === b);
	return { calls, run, has, sleeps };
}

test("happy path runs in order and only writes to the new pane", async () => {
	const h = harness();
	const r = (await h.run());
	assert.deepEqual(r, { ok: true, tabId: "wB:t2", paneId: "wB:p2", command: `omo --session ${SID}` });
	assert.deepEqual(h.calls, [
		["pane", "get", "wB:p1"],
		["pane", "process-info", "--pane", "wB:p1"],
		["tab", "create", "--workspace", "wB", "--cwd", CWD, "--label", "lbl", "--no-focus"],
		["pane", "process-info", "--pane", "wB:p2"],
		["pane", "run", "wB:p2", `omo --session ${SID}`],
	]);
	for (const c of h.calls) {
		if (["run", "send-text", "send-keys"].includes(c[1])) assert.notEqual(c[2], "wB:p1");
	}
});

test("env reaches only the new tab (herdr tabs do not inherit a workspace's env)", async () => {
	const h = harness();
	assert.equal((await h.run({ env: { OMO_HEALTH_HOME: "C:\\tmp\\sandbox home" } })).ok, true);
	assert.deepEqual(h.calls.find((c) => c[0] === "tab"), ["tab", "create", "--workspace", "wB", "--cwd", CWD, "--label", "lbl", "--env", "OMO_HEALTH_HOME=C:\\tmp\\sandbox home", "--no-focus"]);
});

test("no-terminal for undefined, other kind, missing paneId", async () => {
	const h = harness();
	for (const t of [undefined, { ...terminal, kind: "orca" }, { kind: "herdr", workspaceId: "wB" }]) {
		assert.equal((await h.run({ terminal: t })).reason, "no-terminal");
	}
	assert.equal(h.calls.length, 0);
});

test("bad-session-id", async () => {
	const h = harness();
	assert.equal((await h.run({ sessionId: "a; rm -rf" })).reason, "bad-session-id");
	assert.equal((await h.run({ sessionId: "" })).reason, "bad-session-id");
});

test("cwd-missing", async () => {
	const h = harness();
	assert.equal((await h.run({ exists: () => false })).reason, "cwd-missing");
	assert.equal(h.calls.length, 0);
});

test("pane-gone creates no tab", async () => {
	const h = harness({
		get: () => ({ status: 1, stdout: JSON.stringify({ error: { code: "pane_not_found", message: "x" } }), stderr: "" }),
	});
	assert.equal((await h.run()).reason, "pane-gone");
	assert.equal(h.has("tab", "create"), false);
});

test("pane-cwd-mismatch creates no tab", async () => {
	const h = harness({ get: () => ok({ pane: { cwd: "C:\\other" } }) });
	assert.equal((await h.run()).reason, "pane-cwd-mismatch");
	assert.equal(h.has("tab", "create"), false);
});

test("pane-busy creates no tab and runs nothing", async () => {
	const h = harness({ crashedInfo: busy });
	assert.equal((await h.run()).reason, "pane-busy");
	assert.equal(h.has("tab", "create"), false);
	assert.equal(h.has("pane", "run"), false);
});

test("the new tab's shell gets a few moments to appear before anything is typed", async () => {
	let n = 0;
	const h = harness({ newInfo: () => (++n < 3 ? ok({ process_info: { shell_pid: 10 } }) : idle("wB:p2")) });
	assert.equal((await h.run()).ok, true);
	assert.equal(h.calls.filter((c) => c[1] === "process-info" && c[3] === "wB:p2").length, 3);
	assert.deepEqual(h.sleeps, [500, 500]);
	assert.ok(h.calls.findIndex((c) => c[1] === "run") > h.calls.findLastIndex((c) => c[1] === "process-info"), "typed only after the shell was seen idle");
});

test("new-tab-not-ready closes the tab and never runs", async () => {
	const h = harness({ newInfo: busy });
	const r = (await h.run());
	assert.equal(r.reason, "new-tab-not-ready");
	assert.equal(r.tabId, "wB:t2");
	assert.ok(h.calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "wB:t2"));
	assert.equal(h.has("pane", "run"), false);
});

test("run-failed closes the tab", async () => {
	const h = harness({ run: () => ({ status: 1, stdout: "", stderr: "boom" }) });
	const r = (await h.run());
	assert.equal(r.reason, "run-failed");
	assert.ok(h.calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "wB:t2"));
});

test("createHerdrCli uses binPath only for herdr basename that exists", () => {
	const bins = [];
	const spawnSync = (bin) => (bins.push(bin), ok({}));
	const mk = (exists) => createHerdrCli({ spawnSync, exists });
	mk(() => true).call({ binPath: "C:\\x\\herdr.exe" }, ["a"]);
	mk(() => true).call({ binPath: "C:\\x\\evil.exe" }, ["a"]);
	mk(() => false).call({ binPath: "C:\\x\\herdr.exe" }, ["a"]);
	mk(() => true).call({}, ["a"]);
	assert.deepEqual(bins, ["C:\\x\\herdr.exe", "herdr", "herdr", "herdr"]);
});

test("createHerdrCli passes HERDR_SOCKET_PATH and spawn options", () => {
	let opts;
	const spawnSync = (_bin, _args, options) => {
		opts = options;
		return ok({});
	};
	const cli = createHerdrCli({ spawnSync, env: { A: "1" }, exists: () => true, timeoutMs: 5 });
	cli.call({ socketPath: "\\\\.\\pipe\\h" }, ["x"]);
	assert.equal(opts.env.HERDR_SOCKET_PATH, "\\\\.\\pipe\\h");
	assert.equal(opts.env.A, "1");
	assert.equal(opts.timeout, 5);
	assert.equal(opts.windowsHide, true);
	assert.equal(opts.encoding, "utf8");
});

test("createHerdrCli maps exit 1 JSON error code", () => {
	const cli = createHerdrCli({
		spawnSync: () => ({ status: 1, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: "m" } }) }),
		exists: () => true,
	});
	assert.deepEqual(cli.call({}, ["x"]), { ok: false, code: "pane_not_found", message: "m" });
});

test("createHerdrCli maps bad JSON to bad-json and other failures", () => {
	const mk = (r) => createHerdrCli({ spawnSync: () => r, exists: () => true }).call({}, ["x"]);
	assert.equal(mk({ status: 0, stdout: "nope", stderr: "" }).code, "bad-json");
	assert.deepEqual(mk({ status: 0, stdout: "", stderr: "" }), { ok: true, result: undefined }, "a silent success (pane run) is a success");
	assert.equal(mk({ status: 2, stdout: "", stderr: "usage" }).code, "exit-2");
	assert.equal(mk({ error: new Error("ENOENT") }).code, "spawn-error");
});

test("isIdleShell edge cases", () => {
	assert.equal(isIdleShell({ shell_pid: 1, foreground_processes: [] }), false);
	assert.equal(isIdleShell({ foreground_processes: [{ pid: 1 }] }), false);
	assert.equal(isIdleShell({ shell_pid: 1, foreground_processes: [{ pid: 1 }, { pid: 2 }] }), false);
	assert.equal(isIdleShell(undefined), false);
	assert.equal(isIdleShell({ shell_pid: 1, foreground_processes: [{ pid: 1 }, { pid: 1 }] }), true);
});

test("sameDir and resumeCommand", () => {
	assert.equal(sameDir("C:\\x\\y\\", "c:/x/y"), true);
	assert.equal(sameDir("", ""), false);
	assert.equal(resumeCommand("ses-abc12345"), "omo --session ses-abc12345");
	assert.equal(resumeCommand("short"), undefined);
	assert.equal(resumeCommand("ses-abc12345", CRASH_RESUME_PROMPT), `omo --session ses-abc12345 "${CRASH_RESUME_PROMPT}"`);
	for (const bad of ['say "hi"', "it's", "$HOME", "a`b", "100%", "wow!", "a\nb", "", "한글"]) assert.equal(resumeCommand("ses-abc12345", bad), undefined, bad);
});

test("a prompt rides on the resume command in the new pane", async () => {
	const h = harness();
	const r = await h.run({ prompt: CRASH_RESUME_PROMPT });
	assert.equal(r.command, `omo --session ${SID} "${CRASH_RESUME_PROMPT}"`);
	assert.deepEqual(h.calls.at(-1), ["pane", "run", "wB:p2", r.command]);
});
