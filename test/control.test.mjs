import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearPause, getPath, pauseState, readPause, setSwitch, SWITCHES, writePause } from "../src/control.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { atomicWriteJson } from "../src/util/fsx.mjs";

let root;
let paths;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-control-"));
	paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const readConfig = () => JSON.parse(fs.readFileSync(paths.health.configFile, "utf8"));

describe("pause", () => {
	it("writes untilMs for finite minutes and a bare marker otherwise", () => {
		assert.deepEqual(writePause(paths, { minutes: 15, now: 1_000 }), { untilMs: 1_000 + 900_000, byCli: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.pauseFile, "utf8")), { untilMs: 901_000, byCli: true });
		assert.deepEqual(writePause(paths, { minutes: Number.NaN }), { byCli: true });
		assert.deepEqual(writePause(paths), { byCli: true });
	});

	it("reports active, expired, indefinite and unreadable states", () => {
		assert.deepEqual(pauseState(paths, 5), { active: false, untilMs: null, indefinite: false, unreadable: false });
		writePause(paths, { minutes: 1, now: 0 });
		assert.deepEqual(pauseState(paths, 59_999), { active: true, untilMs: 60_000, indefinite: false, unreadable: false });
		assert.equal(pauseState(paths, 60_000).active, false);
		writePause(paths);
		assert.deepEqual(pauseState(paths, 5), { active: true, untilMs: null, indefinite: true, unreadable: false });
		fs.writeFileSync(paths.health.pauseFile, "{broken");
		assert.deepEqual(pauseState(paths, 5), { active: true, untilMs: null, indefinite: true, unreadable: true });
	});

	it("clearPause makes readPause false", () => {
		writePause(paths);
		assert.equal(readPause(paths, 1), true);
		assert.equal(clearPause(paths), true);
		assert.equal(readPause(paths, 1), false);
	});
});

describe("setSwitch", () => {
	it("keeps other keys and drops a key set back to its default", () => {
		atomicWriteJson(paths.health.configFile, { align: { perDay: 9 } });
		assert.deepEqual(setSwitch(paths, "mode", "shadow"), { ok: true, file: paths.health.configFile, value: "shadow", isDefault: false });
		assert.deepEqual(readConfig(), { align: { perDay: 9 }, mode: "shadow" });
		assert.equal(setSwitch(paths, "mode", "auto").isDefault, true);
		assert.deepEqual(readConfig(), { align: { perDay: 9 } });
	});

	it("creates nested keys and prunes empty parents", () => {
		assert.equal(setSwitch(paths, "actions.kill", false).ok, true);
		assert.deepEqual(readConfig(), { actions: { kill: false } });
		assert.equal(setSwitch(paths, "actions.kill", true).ok, true);
		assert.deepEqual(readConfig(), {});
	});

	it("rejects unknown keys and wrong value types without writing", () => {
		assert.deepEqual(setSwitch(paths, "judge.command", true), { ok: false, reason: "unknown-key" });
		assert.deepEqual(setSwitch(paths, "actions.kill", "false"), { ok: false, reason: "invalid-value" });
		assert.deepEqual(setSwitch(paths, "mode", "off"), { ok: false, reason: "invalid-value" });
		assert.equal(fs.existsSync(paths.health.configFile), false);
	});

	it("leaves a broken or non-object config.json untouched", () => {
		for (const text of ["{broken", "[1]"]) {
			fs.mkdirSync(path.dirname(paths.health.configFile), { recursive: true });
			fs.writeFileSync(paths.health.configFile, text);
			const result = setSwitch(paths, "actions.kill", false);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "unreadable");
			assert.equal(fs.readFileSync(paths.health.configFile, "utf8"), text);
		}
	});

	it("every switch key resolves in DEFAULT_CONFIG and its default is a valid value", () => {
		for (const spec of SWITCHES) {
			const def = getPath(DEFAULT_CONFIG, spec.key);
			assert.notEqual(def, undefined, spec.key);
			assert.equal(setSwitch(paths, spec.key, def).ok, true, spec.key);
		}
		assert.deepEqual(readConfig(), {});
	});
});
