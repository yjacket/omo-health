import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readCommands, writeCommand } from "../src/budget/commands.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-11-12T00:00:00Z");
const NAME = /^\d+-[a-z0-9]{6}\.json$/;

function sandbox(t) {
	const root = tmpDir("omoh-budget-commands-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, paths, dir: paths.health.budgetCommandsDir };
}

const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test("write/read round trip keeps the command and names the file <ms>-<rand>.json", (t) => {
	const { paths, dir } = sandbox(t);
	const decide = { kind: "decide", projectId: "sess:goal", requestId: "req-1", approve: true };
	const coupons = { kind: "coupons", account: "anthropic-subscription/default", count: 20 };

	const first = writeCommand(paths, decide, { now: T });
	const second = writeCommand(paths, coupons, { now: T + 1 });

	assert.equal(path.dirname(first), dir);
	assert.equal(path.dirname(second), dir);
	assert.match(path.basename(first), NAME);
	assert.match(path.basename(second), NAME);
	assert.deepEqual(JSON.parse(fs.readFileSync(first, "utf8")), decide);
	assert.deepEqual(JSON.parse(fs.readFileSync(second, "utf8")), coupons);

	const read = readCommands(paths);
	assert.equal(read.length, 2);
	assert.deepEqual(read.map((entry) => entry.cmd), [decide, coupons]);
	assert.deepEqual(read.map((entry) => entry.file), [first, second].sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1)));
});

test("invalid commands are rejected before anything is written", (t) => {
	const { paths, dir } = sandbox(t);
	const bad = [
		{ kind: "coupons", account: "anthropic-subscription/default", count: 21 },
		{ kind: "coupons", account: "anthropic-subscription/default", count: -1 },
		{ kind: "decide", projectId: "p", requestId: "r" },
		{ kind: "decide", projectId: "p", requestId: "r", approve: "yes" },
		{ kind: "decide", projectId: "", requestId: "r", approve: true },
		{ kind: "decide", projectId: "p", requestId: "r", approve: true, note: "extra" },
		{ kind: "other", projectId: "p" },
		null,
	];

	for (const cmd of bad) {
		assert.throws(() => writeCommand(paths, cmd, { now: T }), /invalid budget command/, `accepted ${JSON.stringify(cmd)}`);
	}
	assert.deepEqual(filesIn(dir), []);
	assert.equal(fs.existsSync(dir), false, "the command directory is not created by a rejected command");
});

test("readCommands returns commands ordered by file name", (t) => {
	const { paths, dir } = sandbox(t);
	fs.mkdirSync(dir, { recursive: true });
	const names = ["1700000003000-zzzzzz.json", "1700000001000-aaaaaa.json", "1700000002000-mmmmmm.json"];
	for (const [i, name] of names.entries()) {
		fs.writeFileSync(path.join(dir, name), JSON.stringify({ kind: "coupons", account: `acct-${i}`, count: i }));
	}
	fs.writeFileSync(path.join(dir, "notes.txt"), "not a command");

	const read = readCommands(paths);
	assert.deepEqual(
		read.map((entry) => path.basename(entry.file)),
		[...names].sort(),
	);
	assert.deepEqual(read.map((entry) => entry.cmd.account), ["acct-1", "acct-2", "acct-0"]);
});

test("a half-written file is skipped and left for the next read (QA failure)", (t) => {
	const { paths, dir } = sandbox(t);
	fs.mkdirSync(dir, { recursive: true });
	const complete = writeCommand(paths, { kind: "decide", projectId: "p", requestId: "r", approve: false }, { now: T });
	const half = path.join(dir, `${T + 1}-half00.json`);
	const body = JSON.stringify({ kind: "coupons", account: "anthropic-subscription/default", count: 3 });
	fs.writeFileSync(half, body.slice(0, body.length - 1)); // no closing brace

	const first = readCommands(paths);
	assert.deepEqual(first.map((entry) => entry.file), [complete]);
	assert.equal(fs.existsSync(half), true, "the unreadable file stays for the next read");

	fs.writeFileSync(half, body);
	const second = readCommands(paths);
	assert.deepEqual(second.map((entry) => entry.file), [complete, half].sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1)));
	assert.deepEqual(second.map((entry) => entry.cmd), [
		{ kind: "decide", projectId: "p", requestId: "r", approve: false },
		{ kind: "coupons", account: "anthropic-subscription/default", count: 3 },
	]);
});
