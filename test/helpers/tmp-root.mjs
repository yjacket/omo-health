// Each test process gets its own temp root and removes it on exit, so the suite (also run by staging on every
// update) leaves nothing in %TEMP%. Child processes inherit the root. Every test file imports this as its first line,
// so a direct `node --test test/x.test.mjs` is clean too; `npm test --import` and staging still load it as well, and
// the module is evaluated once per process either way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-test-"));
for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = root;
process.on("exit", () => {
	try {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// Still locked by a child a test left running: it is only disk, and the next run starts clean anyway.
	}
});
