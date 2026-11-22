import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const contender = `
	import fs from "node:fs";
	import { setImmediate } from "node:timers/promises";
	import { requestAudit } from ${JSON.stringify(new URL("../src/auditor.mjs", import.meta.url).href)};
	const [dir, signal, now] = process.argv.slice(1);
	process.send("ready");
	const deadline = performance.now() + 10_000;
	while (!fs.existsSync(signal)) {
		if (performance.now() >= deadline) throw new Error("claim signal not received");
		await setImmediate();
	}
	process.send(requestAudit({ health: { auditRequestsDir: dir } }, "same-id", Number(now)));
	process.disconnect();
`;

test("only one of two processes released by the same signal claims the audit", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-race-"));
	const dir = path.join(root, "requests");
	const signal = path.join(root, "go");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	let ready = 0;
	const results = await Promise.all([100, 200].map(async (now) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", contender, dir, signal, String(now)], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		let result;
		child.on("message", (message) => {
			if (message === "ready") {
				if (++ready === 2) fs.writeFileSync(signal, "");
			} else {
				result = message;
			}
		});
		assert.deepEqual(await once(child, "close"), [0, null]);
		assert.ok(result);
		return result;
	}));
	// The baseline returns the request itself for every successful write.
	assert.deepEqual(results.map((result) => result.created ?? Boolean(result)).sort(), [false, true]);
	assert.deepEqual(fs.readdirSync(dir), ["same-id.json"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "same-id.json"), "utf8")), results.find((result) => result.created).request);
});
