import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, SWITCH_KEYS } from "../src/config.mjs";
import { SWITCHES } from "../src/control.mjs";
import { resolvePaths } from "../src/paths.mjs";

const MIN = 60_000;
const H = 60 * MIN;

const created = [];
after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPaths() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-budget-cfg-"));
	created.push(dir);
	return { dir, paths: { health: { configFile: path.join(dir, "config.json") } } };
}

test("budget defaults match C-config exactly", () => {
	assert.deepEqual(DEFAULT_CONFIG.budget, {
		enabled: true,
		reservePercent: 10,
		auditReservePercent: 2,
		staleMs: 10 * MIN,
		backfillDays: 8,
		ingestBytesPerTick: 8 * 1024 * 1024,
		retentionDays: 120,
		estimateAfterUsd: 10,
		checkpointPercent: 80,
		autoApproveCyclePercent: 10,
		autoApproveFreePercent: 25,
		autoChangePercent: 20,
		// A staged change may grow the original approval by at most this percent.
		maxChangePercent: 100,
		ownerProjectPercent: 25,
		burstFactor: 1.25,
		closeGraceMs: 24 * H,
		providerAliases: ["claude-sdk-oauth=anthropic-subscription"],
		calibration: { minIntervalPercent: 2, minIntervals: 10, minCoveragePercent: 20, maxGapMs: 2 * H, earlyDropPercent: 5 },
		audit: {
			enabled: true,
			models: ["chatgpt-subscription/gpt-6-astra:high", "anthropic-subscription/claude-opus-5-5:high"],
			perProjectDay: 2,
			perDay: 4,
			minGapMs: 6 * H,
			timeoutMs: 15 * MIN,
			roundsRecord: 3,
			roundsAudit: 4,
			roundsCostUsd: 10,
			roundsHard: 6,
			overForecastPercent: 20,
			afterAcceptUsd: 5,
			descendantUsd: 25,
			descendantFraction: 0.2,
			outlierFactor: 1.5,
		},
	});
});

test("loadConfig returns the budget tree without warnings", () => {
	const { paths } = tempPaths();
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.deepEqual(config.budget, DEFAULT_CONFIG.budget);
	assert.notEqual(config.budget, DEFAULT_CONFIG.budget, "a deep copy");
	assert.deepEqual(warnings, []);
});

test("budget.audit.models survives a user override", () => {
	const { paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ budget: { audit: { models: ["anthropic-subscription/claude-sonnet-5-5:high"] } } }));
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.deepEqual(config.budget.audit.models, ["anthropic-subscription/claude-sonnet-5-5:high"]);
	assert.equal(config.budget.audit.perProjectDay, 2, "other audit defaults stay");
	assert.deepEqual(warnings, []);
});

test("an unknown budget key logs unknown config key ignored and keeps defaults", () => {
	const { paths } = tempPaths();
	fs.writeFileSync(paths.health.configFile, JSON.stringify({ budget: { enabled: false, audit: { bogus: 1 } } }));
	const { config, warnings } = loadConfig({ env: {}, paths });
	assert.equal(config.budget.enabled, false, "a valid sibling still applies");
	assert.equal(config.budget.audit.perDay, 4);
	assert.deepEqual(warnings, ["unknown config key ignored: budget.audit.bogus"]);
});

test("a negative budget.reservePercent keeps the default 10 (QA failure scenario)", () => {
	const { dir, paths } = tempPaths();
	const qa = path.join(dir, "qa.json");
	fs.writeFileSync(qa, JSON.stringify({ budget: { reservePercent: -1 } }));
	const { config, warnings } = loadConfig({ env: { OMO_HEALTH_CONFIG: qa }, paths });
	assert.equal(config.budget.reservePercent, 10);
	assert.deepEqual(warnings, ["config budget.reservePercent must be a non-negative number; ignored"]);
});

test("budget paths live under the health home and the usage cache under agentDir", () => {
	const T = path.join(os.tmpdir(), "omoh-budget-home");
	const resolved = resolvePaths({ OMO_HEALTH_HOME: T });
	assert.equal(resolved.health.budgetSnapshotFile, path.join(T, "budget", "snapshot.json"));
	assert.equal(resolved.health.budgetDir, path.join(T, "budget"));
	assert.equal(resolved.health.budgetCommandsDir, path.join(T, "budget", "commands"));
	assert.equal(resolved.health.budgetCouponsFile, path.join(T, "budget", "coupons.json"));
	assert.equal(resolved.subscriptionUsageFile, path.join(resolved.agentDir, "subscription-usage.json"));
});

test("both budget switches are declared in SWITCH_KEYS and SWITCHES, in order, with Korean labels", () => {
	assert.deepEqual(SWITCH_KEYS.slice(-2), ["budget.enabled", "budget.audit.enabled"]);
	assert.deepEqual(SWITCHES.map((s) => s.key), [...SWITCH_KEYS]);
	const budget = SWITCHES.find((s) => s.key === "budget.enabled");
	const audit = SWITCHES.find((s) => s.key === "budget.audit.enabled");
	assert.deepEqual([budget.labelKo, audit.labelKo], ["예산 관리", "지출 감사"]);
	assert.equal(budget.type, "boolean");
	assert.equal(audit.type, "boolean");
	assert.ok(budget.descKo.length > 0 && audit.descKo.length > 0);
});
