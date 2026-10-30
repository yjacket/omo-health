import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import entry from "../extension/entry.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT_FRESH = path.join(REPO, "extension", "import-fresh.mjs");
const ENV_KEYS = ["OMO_HEALTH_HOME", "OMO_HEALTH_OMO_HOME"];

function sandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-entry-load-"));
	const home = path.join(dir, "home");
	fs.mkdirSync(path.join(home, "app"), { recursive: true });
	return { dir, home, omoHome: path.join(dir, "omo") };
}

// A fake release root whose sensor records which root it came from and the options it received.
function fakeRoot(dir, name, body) {
	const root = path.join(dir, name);
	const out = path.join(root, "called.json");
	fs.mkdirSync(path.join(root, "extension"), { recursive: true });
	fs.copyFileSync(IMPORT_FRESH, path.join(root, "extension", "import-fresh.mjs"));
	fs.writeFileSync(
		path.join(root, "extension", "sensor.mjs"),
		body ?? `import fs from "node:fs";\nexport default function (pi, options) {\n\tfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ root: ${JSON.stringify(root)}, options }));\n}\n`,
	);
	return { root, out };
}

function writeCurrent(home, current) {
	fs.writeFileSync(path.join(home, "app", "current.json"), JSON.stringify(current));
}

function fakePi() {
	const handlers = new Map();
	return { handlers, on: (event, handler) => handlers.set(event, handler), registerCommand() {} };
}

async function withSandboxEnv(sb, run) {
	const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.OMO_HEALTH_HOME = sb.home;
	process.env.OMO_HEALTH_OMO_HOME = sb.omoHome;
	try {
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

test("package channel: current.root is loaded with the clone as source", async () => {
	const sb = sandbox();
	const pkg = fakeRoot(sb.dir, "pkg");
	writeCurrent(sb.home, { channel: "package", root: pkg.root });
	await withSandboxEnv(sb, () => entry(fakePi()));
	const called = JSON.parse(fs.readFileSync(pkg.out, "utf8"));
	assert.equal(called.root, pkg.root);
	assert.equal(called.options.source, REPO);
	assert.equal(called.options.setupOnly, false);
});

test("pinned or dev current.json is ignored and the clone's own sensor loads", async () => {
	for (const channel of ["pinned", "dev"]) {
		// A full sensor marks its process as active; each case is a fresh process-level load.
		delete globalThis[Symbol.for("omo-health.sensor.active")];
		const sb = sandbox();
		const other = fakeRoot(sb.dir, "other");
		writeCurrent(sb.home, { channel, root: other.root });
		const pi = fakePi();
		await withSandboxEnv(sb, () => entry(pi));
		assert.equal(fs.existsSync(other.out), false, `${channel}: the pointed root must not load`);
		assert.ok(pi.handlers.has("session_start"), `${channel}: the clone's sensor registered its hooks`);
	}
});

test("setupOnly is true exactly when the legacy stub file exists", async () => {
	const sb = sandbox();
	const pkg = fakeRoot(sb.dir, "pkg");
	writeCurrent(sb.home, { channel: "package", root: pkg.root });
	const stub = path.join(sb.omoHome, "agent", "extensions", "omo-health-sensor.ts");

	fs.mkdirSync(path.dirname(stub), { recursive: true });
	fs.writeFileSync(stub, "// legacy stub\n");
	await withSandboxEnv(sb, () => entry(fakePi()));
	assert.equal(JSON.parse(fs.readFileSync(pkg.out, "utf8")).options.setupOnly, true);

	fs.rmSync(stub);
	fs.rmSync(pkg.out);
	await withSandboxEnv(sb, () => entry(fakePi()));
	assert.equal(JSON.parse(fs.readFileSync(pkg.out, "utf8")).options.setupOnly, false);
});

test("a broken root falls back to the lkg root and logs the failure", async () => {
	const sb = sandbox();
	const broken = fakeRoot(sb.dir, "broken", 'throw new Error("broken release sensor");\n');
	const lkg = fakeRoot(sb.dir, "lkg");
	writeCurrent(sb.home, { channel: "package", root: broken.root, lkg: { version: "0.6.1", root: lkg.root } });
	const pi = fakePi();
	await withSandboxEnv(sb, () => entry(pi));
	assert.equal(JSON.parse(fs.readFileSync(lkg.out, "utf8")).root, lkg.root);
	const lines = fs.readFileSync(path.join(sb.home, "logs", "sensor-stub.log"), "utf8").split("\n").filter((line) => /^\d{4}-\d\d-\d\dT/.test(line));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /^\d{4}-\d\d-\d\dT[^ ]+ pid=\d+ .*broken release sensor/);
});
