import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearPause, getPath, NUMBER_KEYS, pauseState, readPause, setNumber, setSwitch, SWITCHES, writePause } from "../src/control.mjs";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.mjs";
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

describe("setNumber on a hand-written window entry without a colon (#33 review)", () => {
	it("removes it with null but never sets it, and refuses prototype names either way", () => {
		atomicWriteJson(paths.health.configFile, { budget: { windows: { claude7d: { sessionDayPercent: 20 } } } });
		assert.deepEqual(setNumber(paths, "sessionDayPercent", 15, "claude7d"), { ok: false, reason: "unknown-key" });
		assert.equal(setNumber(paths, "sessionDayPercent", null, "claude7d").ok, true);
		assert.deepEqual(readConfig(), {});
		for (const name of ["__proto__", "constructor", "prototype"]) assert.deepEqual(setNumber(paths, "sessionDayPercent", null, name), { ok: false, reason: "unknown-key" });
	});
});

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

describe("setNumber", () => {
	const WINDOW = "anthropic-subscription/default:claude:7d";

	it("keeps other keys and drops a number put back to its default", () => {
		atomicWriteJson(paths.health.configFile, { budget: { enabled: false } });
		assert.deepEqual(setNumber(paths, "budget.sessionDayPercent", 15), { ok: true, file: paths.health.configFile, value: 15, isDefault: false });
		assert.deepEqual(readConfig(), { budget: { enabled: false, sessionDayPercent: 15 } });
		assert.deepEqual(setNumber(paths, "budget.sessionDayPercent", null), { ok: true, file: paths.health.configFile, value: 10, isDefault: true });
		assert.deepEqual(readConfig(), { budget: { enabled: false } });
	});

	it("writes 0 (off), and treats the default value as a reset that prunes the empty parent", () => {
		assert.equal(setNumber(paths, "budget.shortMinBurnHours", 0).isDefault, false);
		assert.deepEqual(readConfig(), { budget: { shortMinBurnHours: 0 } });
		assert.equal(setNumber(paths, "budget.shortMinBurnHours", DEFAULT_CONFIG.budget.shortMinBurnHours).isDefault, true);
		assert.deepEqual(readConfig(), {});
	});

	it("writes a window override and removes the emptied window, windows and budget objects", () => {
		assert.deepEqual(setNumber(paths, "sessionDayPercent", 20, WINDOW), { ok: true, file: paths.health.configFile, value: 20, isDefault: false });
		// The global default is still an override for this window: it pins the window when the global value changes.
		assert.equal(setNumber(paths, "sessionDayInvestigatePercent", DEFAULT_CONFIG.budget.sessionDayInvestigatePercent, WINDOW).isDefault, false);
		assert.deepEqual(readConfig(), { budget: { windows: { [WINDOW]: { sessionDayPercent: 20, sessionDayInvestigatePercent: 5 } } } });
		assert.deepEqual(setNumber(paths, "sessionDayPercent", null, WINDOW), { ok: true, file: paths.health.configFile, value: null, isDefault: true });
		assert.deepEqual(readConfig(), { budget: { windows: { [WINDOW]: { sessionDayInvestigatePercent: 5 } } } });
		assert.equal(setNumber(paths, "sessionDayInvestigatePercent", null, WINDOW).ok, true);
		assert.deepEqual(readConfig(), {});
	});

	it("writes what the config loader reads back without a warning", () => {
		for (const key of NUMBER_KEYS) assert.equal(setNumber(paths, key, getPath(DEFAULT_CONFIG, key) + 1.5).ok, true, key);
		assert.equal(setNumber(paths, "sessionDayPercent", 0, WINDOW).ok, true);
		const { config, warnings } = loadConfig({ env: {}, paths });
		assert.deepEqual(warnings, []);
		for (const key of NUMBER_KEYS) assert.equal(getPath(config, key), getPath(DEFAULT_CONFIG, key) + 1.5, key);
		assert.deepEqual(config.budget.windows, { [WINDOW]: { sessionDayPercent: 0 } });
	});

	it("rejects unknown keys, malformed window names and bad values without writing", () => {
		for (const [key, value, window] of [
			["budget.reservePercent", 5],
			["sessionDayPercent", 5],
			["budget.sessionDayPercent", 5, WINDOW],
			["sessionDayUsd", 5, WINDOW],
			["sessionDayPercent", 5, "__proto__"],
			["sessionDayPercent", 5, "claude 7d:x"],
			["sessionDayPercent", 5, `a:${"b".repeat(200)}`],
			["sessionDayPercent", 5, null],
		]) {
			assert.deepEqual(setNumber(paths, key, value, window), { ok: false, reason: "unknown-key" }, `${key} ${window}`);
		}
		for (const value of [-1, "5", Number.NaN, Number.POSITIVE_INFINITY, true, undefined]) {
			assert.deepEqual(setNumber(paths, "budget.sessionDayPercent", value), { ok: false, reason: "invalid-value" }, String(value));
			assert.deepEqual(setNumber(paths, "sessionDayPercent", value, WINDOW), { ok: false, reason: "invalid-value" }, String(value));
		}
		assert.equal(fs.existsSync(paths.health.configFile), false);
		assert.equal("sessionDayPercent" in {}, false);
	});

	it("leaves a broken config.json untouched", () => {
		fs.mkdirSync(path.dirname(paths.health.configFile), { recursive: true });
		fs.writeFileSync(paths.health.configFile, "{broken");
		for (const result of [setNumber(paths, "budget.sessionDayPercent", 15), setNumber(paths, "sessionDayPercent", 15, WINDOW)]) {
			assert.equal(result.ok, false);
			assert.equal(result.reason, "unreadable");
		}
		assert.equal(fs.readFileSync(paths.health.configFile, "utf8"), "{broken");
	});
});
