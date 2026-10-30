import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { applyConfigInPlace, DEFAULT_CONFIG, loadConfig } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";

function tempPaths() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-cfg-"));
	return { dir, paths: { health: { configFile: path.join(dir, "config.json") } } };
}

test("defaults load with no files", () => {
	const { paths } = tempPaths();
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.stall.softMs, 300_000);
	assert.equal(config.stall.runawayReadonlyMs, 600_000);
	assert.equal(config.mode, "auto");
	assert.deepEqual(warnings, []);
});

test("the analyst budget bounds the wider why routing (8/h, 40/day, 2 per finding)", () => {
	assert.deepEqual([DEFAULT_CONFIG.analyst.perHour, DEFAULT_CONFIG.analyst.perDay, DEFAULT_CONFIG.analyst.perFinding], [8, 40, 2]);
});

test("analyst jobs are outside the legacy care jobs directory", () => {
	const { health, healthHome } = resolvePaths({ HOME: "C:/omo-health-path-test" });
	assert.equal(health.analystJobsDir, path.join(healthHome, "jobs"));
	assert.equal(health.bootGapsDir, path.join(healthHome, "boot-gaps"));
	assert.equal(health.jobsDir, health.analystJobsDir);
	assert.ok(!health.jobsDir.startsWith(health.legacyCareDir + path.sep));
});

test("user config merges deeply and invalid fields are ignored with a warning", () => {
	const { paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ stall: { softMs: "x", runawayReadonlyMs: 1234 }, mode: "loud", bogus: 1 }));
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.stall.softMs, DEFAULT_CONFIG.stall.softMs);
	assert.equal(config.stall.runawayReadonlyMs, 1234);
	assert.equal(config.stall.serverForegroundMs, DEFAULT_CONFIG.stall.serverForegroundMs);
	assert.equal(config.mode, "auto");
	assert.equal(warnings.length, 3);
});

test("OMO_HEALTH_CONFIG overrides the user config", () => {
	const { dir, paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ stall: { softMs: 111 } }));
	const qa = path.join(dir, "qa.json");
	fs.writeFileSync(qa, JSON.stringify({ stall: { softMs: 30_000 }, mode: "shadow" }));
	const { config, sources } = loadConfig({ env: { OMO_HEALTH_CONFIG: qa }, paths });
	assert.equal(config.stall.softMs, 30_000);
	assert.equal(config.mode, "shadow");
	assert.deepEqual(sources, [paths.health.configFile, qa]);
});

test("align defaults are present, and the self-care and update sections are gone", () => {
	const { paths } = tempPaths();
	const { config, warnings } = loadConfig({ env: {}, paths });
	const MIN = 60_000;
	assert.deepEqual(warnings, []);
	assert.equal(config.care, undefined);
	assert.equal(config.update, undefined);
	assert.equal(config.judge, undefined);
	assert.equal(config.align.perDay, 4);
	assert.equal(config.align.minGapMs, 45 * MIN);
});

test("goalLiveness defaults match the contract, and invalid values fall back with a warning", () => {
	assert.deepEqual(DEFAULT_CONFIG.goalLiveness, { enabled: true, livenessMs: 3_570_000, graceMs: 120_000, minWakeGapMs: 3_570_000, quietMs: 30 * 60_000, foldGraceMs: 2 * 60_000, idleWakeHoldMs: 10 * 60_000 });
	const { paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ goalLiveness: { livenessMs: "1h", graceMs: -1, enabled: "yes", minWakeGapMs: 60_000 } }));
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.goalLiveness.livenessMs, DEFAULT_CONFIG.goalLiveness.livenessMs, "a non-number is ignored");
	assert.equal(config.goalLiveness.graceMs, DEFAULT_CONFIG.goalLiveness.graceMs, "a negative number is ignored");
	assert.equal(config.goalLiveness.enabled, DEFAULT_CONFIG.goalLiveness.enabled, "a non-boolean is ignored");
	assert.equal(config.goalLiveness.minWakeGapMs, 60_000, "a valid number is taken");
	assert.equal(warnings.length, 3);
});

test("a string in align.minGapMs is rejected with a warning", () => {
	const { paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ align: { minGapMs: "15m", perDay: 3 } }));
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.align.minGapMs, DEFAULT_CONFIG.align.minGapMs);
	assert.equal(config.align.perDay, 3);
	assert.deepEqual(warnings, ["config align.minGapMs must be a non-negative number; ignored"]);
});

test("a missing OMO_HEALTH_CONFIG is reported, not fatal", () => {
	const { paths } = tempPaths();
	const { config, warnings } = loadConfig({ env: { OMO_HEALTH_CONFIG: "Z:/nope/qa.json" }, paths });
	assert.equal(config.stall.softMs, DEFAULT_CONFIG.stall.softMs);
	assert.ok(warnings.some((w) => w.includes("OMO_HEALTH_CONFIG")));
});

const created = [];
after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function lastGoodPaths() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-cfg-lg-"));
	created.push(dir);
	return { dir, paths: { health: { configFile: path.join(dir, "config.json"), configLastGoodFile: path.join(dir, "config.last-good.json") } } };
}

test("applyConfigInPlace applies nested keys and arrays, drops missing keys and keeps every object identity", () => {
	const target = { mode: "auto", actions: { kill: true, detach: true }, list: ["a"], gone: 1, nested: { deep: { x: 1 } } };
	const { actions, list, nested } = target;
	const deep = nested.deep;
	const next = { mode: "shadow", actions: { kill: false, detach: true }, list: ["b", "c"], nested: { deep: { x: 2 } } };
	const changed = applyConfigInPlace(target, next);
	assert.deepEqual(target, next);
	assert.equal(target.actions, actions);
	assert.equal(target.list, list);
	assert.equal(target.nested, nested);
	assert.equal(target.nested.deep, deep);
	assert.notEqual(target.actions, next.actions, "next objects are copied, never referenced");
	assert.deepEqual(changed, [
		{ key: "gone", from: 1, to: undefined },
		{ key: "mode", from: "auto", to: "shadow" },
		{ key: "actions.kill", from: true, to: false },
		{ key: "list", from: ["a"], to: ["b", "c"] },
		{ key: "nested.deep.x", from: 1, to: 2 },
	]);
	assert.deepEqual(applyConfigInPlace(target, next), []);
});

test("loadConfig returns a deep copy that shares nothing with DEFAULT_CONFIG", () => {
	const { paths } = lastGoodPaths();
	const { config } = loadConfig({ env: {}, paths });
	assert.notEqual(config.actions, DEFAULT_CONFIG.actions);
	assert.notEqual(config.analyst.reports, DEFAULT_CONFIG.analyst.reports);
	assert.notEqual(config.extraProjects, DEFAULT_CONFIG.extraProjects);
});

test("a config.json that fails to parse is listed in unreadable", () => {
	const { paths } = lastGoodPaths();
	fs.writeFileSync(paths.health.configFile, '{"actions":');
	const { config, unreadable, usedLastGood } = loadConfig({ env: {}, paths });
	assert.deepEqual(unreadable.map((u) => u.file), [paths.health.configFile]);
	assert.ok(unreadable[0].message.length > 0);
	assert.equal(usedLastGood, false);
	assert.equal(config.actions.kill, DEFAULT_CONFIG.actions.kill, "no copy: defaults");
});

test("an unreadable config.json falls back to the last good copy when one exists", () => {
	const { paths } = lastGoodPaths();
	fs.writeFileSync(paths.health.configFile, '{"actions":');
	fs.writeFileSync(paths.health.configLastGoodFile, JSON.stringify({ actions: { kill: false } }));
	const { config, unreadable, usedLastGood, sources, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.actions.kill, false);
	assert.equal(usedLastGood, true);
	assert.deepEqual(sources, [paths.health.configLastGoodFile]);
	assert.deepEqual(unreadable.map((u) => u.file), [paths.health.configFile]);
	assert.ok(warnings.includes(`config file unreadable, using the last good copy: ${paths.health.configLastGoodFile}`));
});

test("a missing config.json is not unreadable and ignores the last good copy", () => {
	const { paths } = lastGoodPaths();
	fs.writeFileSync(paths.health.configLastGoodFile, JSON.stringify({ actions: { kill: false } }));
	const { config, unreadable, usedLastGood } = loadConfig({ env: {}, paths });
	assert.deepEqual(unreadable, []);
	assert.equal(usedLastGood, false);
	assert.equal(config.actions.kill, true);
});
