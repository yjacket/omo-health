import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createNotifier, powershellToastRunner, recordingToastRunner, resolveToastRunner } from "../src/act/notify.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-11-21T09:00:00Z");

function tempPaths() {
	const root = tmpDir("omoh-notify-");
	return resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
}

function readLines(file) {
	return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("OMO_HEALTH_TOAST_LOG selects the recording runner, and one notifier toast appends one line", () => {
	const paths = tempPaths();
	const file = path.join(paths.healthHome, "toast-log", "nested", "toasts.jsonl");
	const env = { OMO_HEALTH_TOAST_LOG: file };
	assert.notEqual(resolveToastRunner(env), powershellToastRunner, "the env seam must not fall back to PowerShell");
	const notifier = createNotifier({ paths, clock: createFakeClock(T), config: DEFAULT_CONFIG, env });
	const result = notifier.toast({ title: "제목", body: "본문", tag: "case-17" });
	assert.equal(result.ok, true);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const lines = readLines(file);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].title, "제목");
	assert.equal(lines[0].body, "본문");
	assert.equal(lines[0].tag, "case-17");
	assert.equal(typeof lines[0].ts, "number");
});

test("without OMO_HEALTH_TOAST_LOG the runner is powershellToastRunner (identity only)", () => {
	assert.equal(resolveToastRunner({}), powershellToastRunner);
	assert.equal(resolveToastRunner({ OMO_HEALTH_TOAST_LOG: "" }), powershellToastRunner);
	assert.equal(resolveToastRunner(undefined), powershellToastRunner);
});

test("an explicit runner still wins over the recording env", () => {
	const paths = tempPaths();
	const file = path.join(paths.healthHome, "toasts.jsonl");
	const seen = [];
	const notifier = createNotifier({ paths, clock: createFakeClock(T), config: DEFAULT_CONFIG, env: { OMO_HEALTH_TOAST_LOG: file }, runner: (toast) => (seen.push(toast.tag), { ok: true }) });
	notifier.toast({ title: "a", body: "b", tag: "explicit" });
	assert.deepEqual(seen, ["explicit"]);
	assert.equal(fs.existsSync(file), false);
});

test("recordingToastRunner appends one line per toast and returns the successful shape", () => {
	const file = path.join(tmpDir("omoh-toast-"), "a", "b", "toasts.jsonl");
	const runner = recordingToastRunner(file);
	for (const tag of ["one", "two"]) assert.deepEqual(runner({ title: "t", body: "b", tag }), { ok: true, status: 0, stderr: "" });
	assert.deepEqual(readLines(file).map((line) => line.tag), ["one", "two"]);
});
