import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { statusReport } from "../bin/omo-health.mjs";
import { resolvePaths } from "../src/paths.mjs";

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
