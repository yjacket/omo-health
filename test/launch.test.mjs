import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DAEMON_NODE_ARGS, launchDaemon, WMI_CREATE_SCRIPT } from "../src/launch.mjs";

const SCRIPT = "C:\\dev\\omo\\omo-health\\bin\\omo-health.mjs";

/** Fake spawn: records calls; powershell children print `wmiOutput` and exit with `wmiCode` on the next tick. */
function fakeSpawn({ wmiOutput = "0 4321\r\n", wmiCode = 0 } = {}) {
	const calls = [];
	const impl = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const child = new EventEmitter();
		child.pid = 1000 + calls.length;
		child.unref = () => {};
		child.kill = () => {};
		if (cmd === "powershell.exe") {
			child.stdout = new EventEmitter();
			process.nextTick(() => {
				child.stdout.emit("data", wmiOutput);
				child.emit("close", wmiCode);
			});
		}
		return child;
	};
	return { impl, calls };
}

test("on Windows the daemon is created through WMI, hidden, with the V8 limits and the repo as cwd", async () => {
	const fake = fakeSpawn();
	const result = await launchDaemon({ script: SCRIPT, extraArgs: ["--config", "C:\\q a\\c.json"], execPath: "C:\\Program Files\\nodejs\\node.exe", env: { PATH: "x" }, platform: "win32", spawnImpl: fake.impl });
	assert.deepEqual(result, { via: "wmi", pid: 4321 });
	assert.equal(fake.calls.length, 1);
	const [call] = fake.calls;
	assert.equal(call.cmd, "powershell.exe");
	assert.equal(call.args.at(-1), WMI_CREATE_SCRIPT);
	assert.equal(call.opts.windowsHide, true);
	assert.equal(call.opts.env.OMOH_LAUNCH_CMD, `"C:\\Program Files\\nodejs\\node.exe" ${DAEMON_NODE_ARGS.join(" ")} ${SCRIPT} daemon --config "C:\\q a\\c.json"`);
	assert.equal(call.opts.env.OMOH_LAUNCH_CWD, "C:\\dev\\omo\\omo-health");
	assert.equal(call.opts.env.PATH, "x");
});

test("a WMI failure falls back to a plain detached spawn and says why", async () => {
	const fake = fakeSpawn({ wmiOutput: "9 \r\n", wmiCode: 0 });
	const result = await launchDaemon({ script: SCRIPT, execPath: "node.exe", env: {}, platform: "win32", spawnImpl: fake.impl });
	assert.equal(result.via, "spawn");
	assert.match(result.wmiError, /^wmi: exit 0/);
	assert.equal(fake.calls.length, 2);
	assert.equal(fake.calls[1].cmd, "node.exe");
	assert.deepEqual(fake.calls[1].args, [...DAEMON_NODE_ARGS, SCRIPT, "daemon"]);
	assert.equal(fake.calls[1].opts.detached, true);
});

test("OMO_HEALTH_* redirects and other platforms keep the plain detached spawn (a WMI child would lose the env)", async () => {
	for (const [env, platform] of [
		[{ OMO_HEALTH_HOME: "C:\\sandbox" }, "win32"],
		[{}, "linux"],
	]) {
		const fake = fakeSpawn();
		const result = await launchDaemon({ script: SCRIPT, execPath: "node.exe", env, platform, spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0].cmd, "node.exe");
		assert.equal(fake.calls[0].opts.env, env);
		assert.equal(fake.calls[0].opts.windowsHide, true);
	}
});
