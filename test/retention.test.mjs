import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { pruneHome } from "../src/retention.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

function sandbox(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-retention-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return resolvePaths({ OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), USERPROFILE: root });
}

/** Write `file` with an mtime `ageMs` before NOW. */
function writeAt(file, ageMs, body = "x") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	const when = new Date(NOW - ageMs);
	fs.utimesSync(file, when, when);
}

function touchDir(dir, ageMs) {
	fs.mkdirSync(dir, { recursive: true });
	const when = new Date(NOW - ageMs);
	fs.utimesSync(dir, when, when);
}

const removedPaths = (result) => new Set(result.removed.map((entry) => entry.path));

test("old files in alignment/status/receipts are pruned and fresh ones are kept", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	writeAt(path.join(health.alignmentDir, "old.json"), 8 * DAY);
	writeAt(path.join(health.alignmentDir, "new.json"), 1 * DAY);
	writeAt(path.join(health.statusDir, "old.json"), 8 * DAY);
	writeAt(path.join(health.statusDir, "new.json"), 1 * DAY);
	writeAt(path.join(health.receiptsDir, "old.json"), 8 * DAY);
	writeAt(path.join(health.receiptsDir, "new.json"), 1 * DAY);

	const result = pruneHome(paths, NOW, { days: 7 });
	const gone = removedPaths(result);

	assert.deepEqual(result.errors, []);
	assert.equal(fs.existsSync(path.join(health.alignmentDir, "old.json")), false);
	assert.equal(fs.existsSync(path.join(health.alignmentDir, "new.json")), true);
	assert.equal(fs.existsSync(path.join(health.statusDir, "old.json")), false);
	assert.equal(fs.existsSync(path.join(health.statusDir, "new.json")), true);
	assert.equal(fs.existsSync(path.join(health.receiptsDir, "old.json")), false);
	assert.equal(fs.existsSync(path.join(health.receiptsDir, "new.json")), true);
	assert.equal(gone.has(path.join(health.alignmentDir, "old.json")), true);
	assert.equal(gone.has(path.join(health.statusDir, "old.json")), true);
	assert.equal(gone.has(path.join(health.receiptsDir, "old.json")), true);
	assert.equal(result.removed.length, 3, "only the three aged files are removed");
});

test("_global.json and _sessions.json are kept however old they are", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	writeAt(path.join(health.statusDir, "_global.json"), 365 * DAY);
	writeAt(path.join(health.statusDir, "_sessions.json"), 365 * DAY);

	const result = pruneHome(paths, NOW, { days: 7 });

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.errors, []);
	assert.equal(fs.existsSync(path.join(health.statusDir, "_global.json")), true);
	assert.equal(fs.existsSync(path.join(health.statusDir, "_sessions.json")), true);
});

test("sensors/.tmp spools older than a day go; fresh .tmp and other names stay", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	writeAt(path.join(health.sensorsDir, "old.tmp"), 2 * DAY);
	writeAt(path.join(health.sensorsDir, "fresh.tmp"), 2 * 60 * 60 * 1000);
	writeAt(path.join(health.sensorsDir, "state.json"), 30 * DAY);

	pruneHome(paths, NOW, { days: 7 });

	assert.equal(fs.existsSync(path.join(health.sensorsDir, "old.tmp")), false);
	assert.equal(fs.existsSync(path.join(health.sensorsDir, "fresh.tmp")), true);
	assert.equal(fs.existsSync(path.join(health.sensorsDir, "state.json")), true);
});

test("empty session dirs in inbox older than the window go; fresh or busy ones stay", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	touchDir(path.join(health.inboxDir, "sess-old"), 8 * DAY);
	touchDir(path.join(health.inboxDir, "sess-new"), 1 * DAY);
	const busy = path.join(health.inboxDir, "sess-busy");
	touchDir(busy, 8 * DAY);
	writeAt(path.join(busy, "msg.json"), 8 * DAY);

	const result = pruneHome(paths, NOW, { days: 7 });
	const gone = removedPaths(result);

	assert.equal(fs.existsSync(path.join(health.inboxDir, "sess-old")), false);
	assert.equal(fs.existsSync(path.join(health.inboxDir, "sess-new")), true);
	assert.equal(fs.existsSync(busy), true);
	assert.equal(gone.has(path.join(health.inboxDir, "sess-old")), true);
});

test("protected directories are never touched", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	const protectedDirs = [
		health.decisionsDir,
		health.reportsDir,
		health.snapshotsDir,
		health.investigationsDir,
		health.jobsDir,
		health.deathsDir,
		health.intakeDir,
		health.lkgDir,
		health.appDir,
		health.sessionsDir,
	];
	const planted = [];
	for (const dir of protectedDirs) {
		const file = path.join(dir, "old.json");
		writeAt(file, 365 * DAY);
		planted.push(file);
	}
	writeAt(health.dbFile, 365 * DAY);

	const result = pruneHome(paths, NOW, { days: 7 });

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.errors, []);
	for (const file of planted) assert.equal(fs.existsSync(file), true, file);
	assert.equal(fs.existsSync(health.dbFile), true);
});

test("a missing health home is a no-op and nothing is thrown", (t) => {
	const paths = sandbox(t);

	const result = pruneHome(paths, NOW, { days: 7 });

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.errors, []);
});

test("an unremovable file is reported in errors, not thrown", (t) => {
	const paths = sandbox(t);
	const { health } = paths;
	const a = path.join(health.alignmentDir, "ro-a.json");
	const b = path.join(health.alignmentDir, "ro-b.json");
	writeAt(a, 8 * DAY);
	writeAt(b, 8 * DAY);
	fs.chmodSync(a, 0o444);
	fs.chmodSync(b, 0o444);
	t.after(() => {
		for (const file of [a, b]) {
			try {
				fs.chmodSync(file, 0o666);
			} catch {
				// already removed (POSIX): nothing to restore
			}
		}
	});

	const result = pruneHome(paths, NOW, { days: 7 });

	// Either outcome is fine: each file is either removed or counted as an error, never both and never a throw.
	for (const file of [a, b]) {
		const wasRemoved = result.removed.some((entry) => entry.path === file);
		const hadError = result.errors.some((entry) => entry.path === file);
		assert.equal(wasRemoved !== hadError, true, `${file} must be removed XOR errored`);
	}
});
