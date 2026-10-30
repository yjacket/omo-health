import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.mjs";
import { createConfigReloader } from "../src/config-reload.mjs";
import { readDecisions } from "../src/decisions.mjs";
import { resolvePaths } from "../src/paths.mjs";

const DEFAULTS_JSON = JSON.stringify(DEFAULT_CONFIG);
const created = [];
after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => assert.equal(JSON.stringify(DEFAULT_CONFIG), DEFAULTS_JSON, "DEFAULT_CONFIG never changes"));

let mtimeSec = 1_800_000_000;

/** Write config.json with a fresh, strictly increasing mtime so every edit changes the signature. */
function writeConfig(paths, text) {
	fs.writeFileSync(paths.health.configFile, text);
	mtimeSec += 10;
	fs.utimesSync(paths.health.configFile, mtimeSec, mtimeSec);
	return fs.statSync(paths.health.configFile).mtimeMs;
}

function setup({ mode, env = {}, initial = "{}" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-reload-"));
	created.push(root);
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	if (initial !== undefined) writeConfig(paths, initial);
	const config = loadConfig({ env, paths }).config;
	const logs = [];
	const log = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (event, data) => logs.push({ level, event, data })]));
	let loads = 0;
	const loadConfigImpl = (args) => {
		loads++;
		return loadConfig(args);
	};
	const clock = { now: () => 5_000 };
	const reloader = createConfigReloader({ paths, env, config, mode, clock, log, loadConfigImpl });
	return { paths, config, logs, reloader, get loads() { return loads; } };
}

test("an edited config.json is applied in place once, with a receipt and an applied decision", () => {
	const s = setup();
	const actions = s.config.actions;
	s.reloader.check();
	assert.equal(s.loads, 1, "the first check always reads");
	s.reloader.check();
	assert.equal(s.loads, 1, "an unchanged file is not read again");

	const mtimeMs = writeConfig(s.paths, '{"actions":{"kill":false}}');
	s.reloader.check();
	s.reloader.check();
	assert.equal(s.loads, 2);
	assert.equal(s.config.actions, actions, "sub-objects keep their identity");
	assert.equal(s.config.actions.kill, false);
	const state = s.reloader.state();
	assert.equal(state.fileMtimeMs, mtimeMs);
	assert.equal(state.source, "file");
	assert.equal(state.effective["actions.kill"], false);
	const applied = readDecisions(s.paths).filter((d) => d.event === "config" && d.result === "applied");
	assert.equal(applied.length, 1);
	assert.deepEqual(applied[0].changed, [{ key: "actions.kill", from: true, to: false }]);
	assert.equal(applied[0].fileMtimeMs, mtimeMs);
});

test("a broken config.json keeps the current values and is rejected once per signature", () => {
	const s = setup({ initial: '{"actions":{"kill":false}}' });
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);

	const brokenMtime = writeConfig(s.paths, '{"actions":');
	s.reloader.check();
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);
	const state = s.reloader.state();
	assert.ok(state.rejected.error.length > 0);
	assert.equal(state.rejected.source, "user");
	assert.equal(state.rejected.fileMtimeMs, brokenMtime);
	assert.equal(s.logs.filter((l) => l.event === "config_reload_rejected").length, 1);
	assert.equal(readDecisions(s.paths).filter((d) => d.event === "config" && d.result === "rejected").length, 1);
});

test("without a last good copy a broken config.json is rejected and the running config is kept", () => {
	const s = setup({ initial: undefined });
	s.config.actions.kill = false; // what main loaded before the file broke
	writeConfig(s.paths, '{"mode":');
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);
	const state = s.reloader.state();
	assert.equal(state.source, "defaults", "nothing was applied yet");
	assert.ok(state.rejected.error.length > 0);
});

test("a restart with a broken config.json runs on the last good copy", () => {
	const s = setup({ initial: undefined });
	fs.writeFileSync(s.paths.health.configLastGoodFile, '{"actions":{"kill":false},"mode":"shadow"}');
	const brokenMtime = writeConfig(s.paths, '{"actions":');
	s.reloader.check();
	const state = s.reloader.state();
	assert.equal(state.source, "last-good");
	assert.equal(state.effective["actions.kill"], false);
	assert.equal(state.effective.mode, "shadow");
	assert.equal(s.config.actions.kill, false);
	assert.equal(state.rejected.fileMtimeMs, brokenMtime);
	assert.equal(fs.readFileSync(s.paths.health.configLastGoodFile, "utf8"), '{"actions":{"kill":false},"mode":"shadow"}', "the copy is not overwritten by the broken file");
});

test("an unreadable --config file is rejected and the current config kept", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-reload-extra-"));
	created.push(root);
	const extra = path.join(root, "extra.json");
	fs.writeFileSync(extra, '{"actions":{"kill":false}}');
	const s = setup({ env: { OMO_HEALTH_CONFIG: extra } });
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);
	assert.equal(s.reloader.state().extra.file, extra);
	fs.writeFileSync(extra, "{");
	fs.utimesSync(extra, mtimeSec + 1000, mtimeSec + 1000);
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);
	assert.equal(s.reloader.state().rejected.source, "extra");
});

test("a rejected --config file does not stop a valid config.json from becoming the last good copy", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-reload-extra-"));
	created.push(root);
	const extra = path.join(root, "extra.json");
	fs.writeFileSync(extra, "{");
	const s = setup({ env: { OMO_HEALTH_CONFIG: extra }, initial: '{"actions":{"kill":false}}' });
	s.reloader.check();
	assert.equal(s.reloader.state().rejected.source, "extra");
	assert.equal(s.logs.filter((l) => l.event === "config_reload_rejected").length, 1);
	assert.equal(fs.readFileSync(s.paths.health.configLastGoodFile, "utf8"), '{"actions":{"kill":false}}');
});

test("--shadow wins over the file's mode and is reported as the override", () => {
	const s = setup({ mode: "shadow" });
	s.reloader.check();
	const mtimeMs = writeConfig(s.paths, '{"mode":"auto"}');
	s.reloader.check();
	const state = s.reloader.state();
	assert.equal(state.fileMtimeMs, mtimeMs);
	assert.equal(state.effective.mode, "shadow");
	assert.equal(state.modeOverride, "shadow");
});

test("a successful reload keeps a byte copy of config.json as the last good copy", () => {
	const s = setup();
	s.reloader.check();
	writeConfig(s.paths, '\uFEFF{ "actions": { "kill": false } }\n');
	s.reloader.check();
	assert.deepEqual(fs.readFileSync(s.paths.health.configLastGoodFile), fs.readFileSync(s.paths.health.configFile));
});

test("a deleted config.json applies the defaults only on the second consecutive check", () => {
	const s = setup({ initial: '{"actions":{"kill":false}}' });
	s.reloader.check();
	assert.equal(s.config.actions.kill, false);
	fs.rmSync(s.paths.health.configFile);
	s.reloader.check();
	assert.equal(s.config.actions.kill, false, "an editor may recreate it right away");
	s.reloader.check();
	assert.equal(s.config.actions.kill, true);
	assert.equal(s.reloader.state().source, "defaults");
	assert.equal(s.reloader.state().fileMtimeMs, null);
});
