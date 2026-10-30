import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { doctor, run } from "../src/cli-extra.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

// Every check except the real "log parsing healthy" is stubbed, so the test reads a sandbox _global.json only.
const STUBS = {
	nodeVersion: () => process.versions.node,
	processWorker: () => "stub",
	toastScript: () => "stub",
	omoCli: () => "stub",
	runtime: () => "stub",
	bootstrap: () => "stub",
	sensorStub: () => "stub",
	stubUpToDate: () => "stub",
	sensorLoads: () => "stub",
	logonAutostart: () => "stub",
	daemonRunning: () => "stub",
	omoInstallUntouched: () => "stub",
};

function sandbox(globalStatus) {
	const root = tmpDir("omoh-doctor-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), USERPROFILE: root });
	fs.mkdirSync(paths.health.statusDir, { recursive: true });
	fs.writeFileSync(path.join(paths.health.statusDir, "_global.json"), JSON.stringify(globalStatus));
	return paths;
}

const config = { analyst: { command: "omo" } };
const parsingRow = (rows) => rows.find((r) => r.name === "log parsing healthy");

async function exitCode(paths) {
	const log = console.log;
	console.log = () => {};
	try {
		return await run("doctor", [], { paths, config, checks: STUBS });
	} finally {
		console.log = log;
	}
}

test("doctor: unknown omo log events are a warning and exit 0", async () => {
	const paths = sandbox({ unknownEvents: [{ source: "session.log", names: ["todo_first_turn", "todo_owed_backstop_suppressed"] }], failures: [] });
	const row = parsingRow(await doctor({ paths, config, checks: STUBS }));
	assert.equal(row.status, "warn");
	assert.equal(row.ok, true);
	assert.match(row.detail, /session\.log todo_first_turn, todo_owed_backstop_suppressed/);
	assert.equal(await exitCode(paths), 0);
});

test("doctor: degraded log parsing is a failure and exit 1", async () => {
	const paths = sandbox({ degraded: true, unknownEvents: [{ source: "session.log", names: ["x"] }], failures: [] });
	const row = parsingRow(await doctor({ paths, config, checks: STUBS }));
	assert.equal(row.status, "fail");
	assert.equal(row.ok, false);
	assert.match(row.detail, /degraded/);
	assert.equal(await exitCode(paths), 1);
});

test("doctor: healthy parsing is ok and every row carries status, ok and detail", async () => {
	const paths = sandbox({ failures: [] });
	const rows = await doctor({ paths, config, checks: STUBS });
	assert.equal(parsingRow(rows).status, "ok");
	for (const row of rows) {
		assert.ok(["ok", "warn", "fail"].includes(row.status));
		assert.equal(row.ok, row.status !== "fail");
		assert.equal(typeof row.detail, "string");
	}
	assert.equal(await exitCode(paths), 0);
});

