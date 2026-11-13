import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { statusReport } from "../bin/omo-health.mjs";
import { resolvePaths } from "../src/paths.mjs";

test("status JSON budget carries no owner-pending list", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-status-budget-"));
	try {
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		fs.mkdirSync(path.dirname(paths.health.budgetSnapshotFile), { recursive: true });
		fs.writeFileSync(
			paths.health.budgetSnapshotFile,
			JSON.stringify({ v: 1, updatedMs: 10, treasury: { state: "ok", windows: [] }, projects: [], audits: [], owner: [{ projectId: "p1", requestId: "r1", kind: "estimate", increaseUsd: 5, reason: "more work", sinceMs: 1 }], events: [] }),
		);
		const budget = statusReport(paths, 1_000_000).budget;
		assert.equal(budget.state, "ok");
		assert.equal(Object.hasOwn(budget, "pendingOwner"), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("status JSON reports death count and latest record, including empty state", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-status-deaths-"));
	try {
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		assert.deepEqual(statusReport(paths, 1_000_000).deaths, { count: 0, last: null });
		fs.mkdirSync(paths.health.deathsDir, { recursive: true });
		fs.writeFileSync(path.join(paths.health.deathsDir, "one.json"), JSON.stringify({ kind: "hung", atMs: 10 }));
		fs.writeFileSync(path.join(paths.health.deathsDir, "20-unclean-exit.json"), JSON.stringify({ kind: "unclean-exit" }));
		assert.deepEqual(statusReport(paths, 1_000_000).deaths, { count: 2, last: { kind: "unclean-exit", atMs: 20 } });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
