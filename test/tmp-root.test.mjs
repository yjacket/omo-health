import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const helper = path.join(testDir, "helpers", "tmp-root.mjs");

/** Run a node command with TEMP/TMP/TMPDIR at a fresh empty dir; returns the result and what is left in that dir. */
function runWithFreshTemp(args) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-fresh-"));
	try {
		const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
		delete env.NODE_TEST_CONTEXT; // a nested node --test must not be suppressed as a recursive invocation.
		const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 120_000 });
		return { result, left: fs.readdirSync(tmp) };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("every test file loads the tmp-root helper first, so a direct node --test run leaves no temp dirs", () => {
	const files = fs.readdirSync(testDir).filter((name) => name.endsWith(".test.mjs"));
	assert.ok(files.length > 50);
	const missing = files.filter((name) => fs.readFileSync(path.join(testDir, name), "utf8").split(/\r?\n/, 1)[0] !== 'import "./helpers/tmp-root.mjs";');
	assert.deepEqual(missing, []);
});

test("a direct node --test run of a temp-dir-heavy file leaves nothing in TEMP", () => {
	const { result, left } = runWithFreshTemp(["--test", path.join(testDir, "config.test.mjs")]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(left, []);
});

test("the helper roots TEMP inside the original temp dir and removes the root when the process exits", () => {
	const code = `import ${JSON.stringify(pathToFileURL(helper).href)}; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; fs.mkdirSync(path.join(os.tmpdir(), "x")); console.log(os.tmpdir());`;
	const { result, left } = runWithFreshTemp(["--input-type=module", "-e", code]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(path.basename(result.stdout.trim()), /^omoh-test-/);
	assert.deepEqual(left, []);
});
