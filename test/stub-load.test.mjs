import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { renderStub } from "../src/install.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SENSOR = path.join(REPO, "extension", "sensor.mjs");

test("the stub's load path works where senpi evaluates extensions (vm script without a dynamic import callback)", async () => {
	const bare = new vm.Script("(url) => import(url)").runInThisContext();
	await assert.rejects(bare(pathToFileURL(SENSOR).href), { code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING" }, "the environment reproduces the failure");
	const load = new vm.Script(`(async (createRequire, sensor, helper) => {
		const { importFresh } = createRequire(sensor)(helper);
		const mod = await importFresh(sensor);
		return typeof mod.default;
	})`).runInThisContext();
	assert.equal(await load(createRequire, SENSOR, path.join(path.dirname(SENSOR), "import-fresh.mjs")), "function");
});

test("the installed stub falls back to the lkg root when current.root is broken and logs the failure", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-stub-load-"));
	const home = path.join(dir, "home");
	const broken = path.join(dir, "broken");
	fs.mkdirSync(path.join(broken, "extension"), { recursive: true });
	fs.writeFileSync(path.join(broken, "extension", "sensor.mjs"), 'throw new Error("broken release sensor");\n');
	fs.copyFileSync(path.join(REPO, "extension", "import-fresh.mjs"), path.join(broken, "extension", "import-fresh.mjs"));
	fs.mkdirSync(path.join(home, "app"), { recursive: true });
	fs.writeFileSync(path.join(home, "app", "current.json"), JSON.stringify({ channel: "release", version: "9.9.9", root: broken, previous: null, lkg: { version: "0.1.0", root: REPO }, bad: [] }));
	// The baked fallback is missing too, so only the lkg root can load a sensor.
	const template = fs.readFileSync(path.join(REPO, "extension", "stub.ts.tpl"), "utf8");
	const stub = path.join(dir, "stub.mjs");
	fs.writeFileSync(stub, renderStub(template, { version: "9.9.9", root: path.join(dir, "missing") }).replace(/: any/g, ""));
	const mod = await import(pathToFileURL(stub).href);
	const handlers = new Map();
	const pi = { on: (event, handler) => handlers.set(event, handler), registerCommand() {} };
	const previous = process.env.OMO_HEALTH_HOME;
	process.env.OMO_HEALTH_HOME = home;
	try {
		await mod.default(pi);
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_HOME;
		else process.env.OMO_HEALTH_HOME = previous;
	}
	assert.ok(handlers.has("session_start"), "the lkg sensor registered its hooks");
	// One entry per failure; an entry's stack continues on untimestamped lines (doctor counts the same way).
	const lines = fs.readFileSync(path.join(home, "logs", "sensor-stub.log"), "utf8").split("\n").filter((line) => /^\d{4}-\d\d-\d\dT/.test(line));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /^\d{4}-\d\d-\d\dT[^ ]+ pid=\d+ .*broken release sensor/);
});
