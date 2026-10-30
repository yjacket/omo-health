import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDetectors } from "../src/engine.mjs";

const DETECT_DIR = path.resolve(fileURLToPath(new URL("../src/detect/", import.meta.url)));

/** Every src/detect module whose exports include a detect function, however it is written (function, const, re-export). */
async function detectorModules() {
	const names = [];
	for (const name of fs.readdirSync(DETECT_DIR).filter((file) => file.endsWith(".mjs"))) {
		const mod = await import(pathToFileURL(path.join(DETECT_DIR, name)).href);
		if (typeof mod.detect === "function") names.push(name.slice(0, -4));
	}
	return names.sort();
}

test("loadDetectors loads every detector module that exports detect, in evaluation order", async () => {
	const expected = await detectorModules();
	assert.ok(expected.length > 0);
	const detectors = await loadDetectors();
	const loaded = detectors.map((detector) => detector.name);
	assert.deepEqual([...loaded].sort(), expected, "every src/detect module exporting detect is registered");
	assert.equal(loaded.indexOf("respawn"), loaded.indexOf("runaway") + 1, "D17 evaluates right after D2");
	assert.equal(loaded.at(-1), "boot-gap", "D23 evaluates last");
	for (const detector of detectors) assert.equal(typeof detector.detect, "function", `${detector.name} exports detect`);
});

test("detector ids are unique and the 0.8.0 assignments are final", async () => {
	const detectors = await loadDetectors();
	const ids = new Map();
	for (const detector of detectors) {
		if (!detector.id) continue;
		assert.equal(ids.has(detector.id), false, `${detector.name} reuses ${detector.id} from ${ids.get(detector.id)}`);
		ids.set(detector.id, detector.name);
	}
	assert.equal(ids.get("D17"), "respawn");
	assert.equal(ids.get("D22"), "reflection-orphans");
	assert.equal(ids.get("D23"), "boot-gap");
	assert.equal(ids.get("D21"), "goal-liveness");
});
