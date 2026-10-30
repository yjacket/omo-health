import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { doctor } from "../src/cli-extra.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { runCommandValue } from "../src/install.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const config = { analyst: { command: "omo" } };
const base = {
	nodeVersion: () => "v24.0.0",
	processWorker: () => "stub",
	toastScript: () => "stub",
	omoCli: () => "stub",
	bootstrap: () => "stub",
	sensorLoads: () => "stub",
	daemonRunning: () => "stub",
	logParsingHealthy: () => "stub",
	omoInstallUntouched: () => "stub",
};

function setup(t, channel = "package") {
	const root = tmpDir("omoh-doctor-package-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "health");
	const source = path.join(root, "source");
	const paths = resolvePaths({ OMO_HEALTH_HOME: home, OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
	fs.mkdirSync(path.join(source, "bin"), { recursive: true });
	fs.writeFileSync(path.join(source, "bin", "omo-health.mjs"), "");
	fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ pi: { extensions: ["extension/entry.ts"] } }));
	fs.mkdirSync(paths.health.appDir, { recursive: true });
	fs.writeFileSync(paths.health.currentFile, JSON.stringify({ channel, version: "0.7.0", source, root: source }));
	return { paths, source };
}

test("doctor package: healthy entry, absent legacy stub, and injected Run registry", async (t) => {
	const { paths } = setup(t);
	const seen = [];
	const regRunner = (args) => {
		seen.push(args);
		return { status: 0, stdout: `${args.at(-1)} REG_SZ ${runCommandValue(paths)}` };
	};
	const result = await doctor({ paths, config, checks: base, regRunner });
	assert.equal(result.find((row) => row.name === "runtime").status, "ok");
	assert.deepEqual(result.find((row) => row.name === "sensor stub installed"), {
		name: "sensor stub installed", status: "ok", ok: true, detail: "legacy stub ABSENT",
	});
	assert.equal(result.find((row) => row.name === "stub up to date").detail, "current.source/package.json pi.extensions includes extension/entry.ts");
	assert.deepEqual(seen[0].slice(-2), ["/v", "omo-health"]);
});

test("doctor package: legacy stub present fails as a double load", async (t) => {
	const { paths } = setup(t);
	fs.mkdirSync(paths.extensionsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.extensionsDir, "omo-health-sensor.ts"), "legacy");
	const result = await doctor({ paths, config, checks: base });
	const row = result.find((item) => item.name === "sensor stub installed");
	assert.equal(row.status, "fail");
	assert.match(row.detail, /두 번 로드/);
});

test("doctor package: missing package entry fails", async (t) => {
	const { paths, source } = setup(t);
	fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ pi: { extensions: [] } }));
	const result = await doctor({ paths, config, checks: base });
	const row = result.find((item) => item.name === "stub up to date");
	assert.equal(row.status, "fail");
	assert.match(row.detail, /pi\.extensions missing extension\/entry\.ts/);
});

test("doctor pinned channel continues to require the current legacy stub", async (t) => {
	const { paths } = setup(t, "pinned");
	const result = await doctor({ paths, config, checks: base });
	assert.equal(result.find((row) => row.name === "runtime").status, "ok");
	assert.equal(result.find((row) => row.name === "sensor stub installed").status, "fail");
	assert.match(result.find((row) => row.name === "sensor stub installed").detail, /missing \(run install\)/);
});
