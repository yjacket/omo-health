import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { readUiPrefs, writeUiPrefs } from "../src/ui/prefs.mjs";

const roots = [];
after(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeHome() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-prefs-"));
	roots.push(root);
	const env = { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") };
	return { env, paths: resolvePaths(env) };
}

describe("dashboard preferences", () => {
	it("defaults to hiding nothing when the file is missing", () => {
		const home = makeHome();
		assert.deepEqual(readUiPrefs(home.paths), { hideChildren: false });
	});

	it("round-trips the preference through ui-prefs.json with a version", () => {
		const home = makeHome();
		assert.deepEqual(writeUiPrefs(home.paths, { hideChildren: true }), { ok: true });
		assert.deepEqual(readUiPrefs(home.paths), { hideChildren: true });
		const raw = JSON.parse(fs.readFileSync(home.paths.health.uiPrefsFile, "utf8"));
		assert.deepEqual(raw, { v: 1, hideChildren: true });
		assert.deepEqual(writeUiPrefs(home.paths, { hideChildren: false }), { ok: true });
		assert.deepEqual(readUiPrefs(home.paths), { hideChildren: false });
	});

	it("rejects a non-boolean value and extra keys without touching the file", () => {
		const home = makeHome();
		assert.deepEqual(writeUiPrefs(home.paths, { hideChildren: true }), { ok: true });
		const invalid = [
			{ hideChildren: "yes" },
			{ hideChildren: 1 },
			{ hideChildren: true, other: 1 },
			{ other: true },
			{},
			null,
			[],
		];
		for (const prefs of invalid) assert.deepEqual(writeUiPrefs(home.paths, prefs), { ok: false, reason: "invalid" }, JSON.stringify(prefs));
		assert.deepEqual(readUiPrefs(home.paths), { hideChildren: true });
	});

	it("falls back to the default for a malformed or shapeless file", () => {
		const home = makeHome();
		fs.mkdirSync(path.dirname(home.paths.health.uiPrefsFile), { recursive: true });
		for (const content of ["{", "[]", "null", JSON.stringify({ hideChildren: "yes" }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 2, hideChildren: "true" })]) {
			fs.writeFileSync(home.paths.health.uiPrefsFile, content);
			assert.deepEqual(readUiPrefs(home.paths), { hideChildren: false }, content);
		}
	});
});
