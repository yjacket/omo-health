import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareExpected, runReplay } from "../src/replay.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const dirs = fs
	.readdirSync(FIXTURES, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(FIXTURES, entry.name, "expected.json")))
	.map((entry) => entry.name)
	.sort();

for (const name of dirs) {
	test(`replay ${name}`, async () => {
		const dir = path.join(FIXTURES, name);
		const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
		const result = await runReplay(dir);
		assert.deepEqual(compareExpected(result, expected), []);
	});
}

test("F7 drifts through the failing-check or review-loop rule (plan todo 24, reviewer r1 B1)", async () => {
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-f7-"));
	try {
		fs.cpSync(path.join(FIXTURES, "F7"), copy, { recursive: true });
		const meta = JSON.parse(fs.readFileSync(path.join(copy, "meta.json"), "utf8"));
		fs.writeFileSync(path.join(copy, "meta.json"), JSON.stringify({ ...meta, config: { align: { failRepeats: 1000, reviewLoops: 1000 } } }));
		const expected = JSON.parse(fs.readFileSync(path.join(copy, "expected.json"), "utf8"));
		const problems = compareExpected(await runReplay(copy), expected);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /^missing finding .*"cls":"churn"/);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
});

test("F8 nudges once and the note names the evidence; F9 children share the parent's budget", async () => {
	const notes = (result) => result.sent.filter((message) => message.kind === "scope-check");
	const f8 = notes(await runReplay(path.join(FIXTURES, "F8")));
	assert.equal(f8.length, 1);
	assert.match(f8[0].content, /scope check \(stuck\): 12 steps on 'Fix flaky check' since 14:02Z/);
	const f9 = notes(await runReplay(path.join(FIXTURES, "F9")));
	assert.deepEqual(f9.map((message) => message.sessionId), ["01a0d700-0007-7000-8000-000000000007"], "two cycling children, one note to their parent");
	assert.match(f9[0].content, /^Forward this to subagent st_01a0d70[12] with task_send:/);
});

/** A fixture copied with its meta changed (the F7 pattern): the variants of one story are built in the test. */
async function replayWith(fixture, change) {
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-variant-"));
	try {
		fs.cpSync(path.join(FIXTURES, fixture), copy, { recursive: true });
		const meta = JSON.parse(fs.readFileSync(path.join(copy, "meta.json"), "utf8"));
		fs.writeFileSync(path.join(copy, "meta.json"), JSON.stringify(change(meta)));
		return await runReplay(copy);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
}
const RELEASES = ["kill-pids", "release-shell", "detach-server"];
/** F13's window ends before the error tool result arrives (19:04:40Z), so the suspicion is still open when the replay stops. */
const stillOpen = (meta) => ({ ...meta, clockEnd: "2026-09-29T19:04:35.000Z" });

test("F12/F13: a stuck verdict releases a child's tree quietly, then the parent gets exactly one why message (todo 8; analyst-why IS-3: a child release is no longer silent)", async () => {
	for (const [name, pids] of [["F12", [71000, 71010]], ["F13", [72000, 72010]]]) {
		const result = await runReplay(path.join(FIXTURES, name));
		assert.deepEqual(result.actions.filter((a) => RELEASES.includes(a.kind)).map((a) => [a.kind, [...a.targets].sort()]), [["release-shell", pids]], name);
		assert.deepEqual(result.investigations.map((inv) => [inv.status, inv.trigger, inv.verdict.stuck, inv.actions.map((a) => [a.kind, a.quiet ?? false])]), [["advised", "stall", true, [["release-shell", true], ["why-notice", false]]]], name);
		assert.deepEqual(result.sent.map((m) => [m.kind, m.details?.why]), [["relay", true]], `${name}: one why message to the parent`);
		assert.ok(/What happened: .{20,}/.test(result.sent[0].content) && /Do instead: .{20,}/.test(result.sent[0].content), `${name}: it carries mechanism and avoid`);
		assert.equal(result.analystJobs.length, 1, name);
	}
});

test("F13 with the analyst failing, refused or missing: no process action, the investigation reads failed with a retry time, and the decision row says why (todo 8)", async () => {
	const rows = (result) => result.decisions.filter((d) => d.event === "investigation" && d.status === "failed").map((d) => d.result);
	const failed = await replayWith("F13", (meta) => ({ ...stillOpen(meta), analyst: { durationMs: 20_000, status: "failed", reason: "exit-1" } }));
	assert.deepEqual(rows(failed), ["analyst-failed"]);
	const refused = await replayWith("F13", (meta) => ({ ...stillOpen(meta), config: { analyst: { perDay: 0 } } }));
	assert.deepEqual(rows(refused), ["skipped:analyst-unavailable"]);
	const missing = await replayWith("F13", (meta) => {
		const { analyst, ...rest } = stillOpen(meta);
		return rest;
	});
	assert.deepEqual(rows(missing), ["skipped:analyst-unavailable"]);
	for (const result of [failed, refused, missing]) {
		assert.deepEqual(result.actions.filter((a) => RELEASES.includes(a.kind)), []);
		assert.deepEqual(result.sent, []);
		assert.deepEqual(result.investigations.map((inv) => [inv.status, Number.isFinite(inv.retryAtMs)]), [["failed", true]]);
	}
});

test("F13 with an analyst that says progressing, or answers garbage, kills nothing either", async () => {
	const progressing = await replayWith("F13", (meta) => ({ ...stillOpen(meta), analyst: { durationMs: 20_000, result: { verdict: "progressing", cause: "external-wait", evidence: ["the host is waiting for a handover"], confidence: 0.8, diagnosis: "It is a deliberate wait.", recheck_after_s: 900 } } }));
	assert.deepEqual(progressing.investigations.map((inv) => [inv.status, Number.isFinite(inv.retryAtMs)]), [["verdict", true]]);
	const garbage = await replayWith("F13", (meta) => ({ ...stillOpen(meta), analyst: { durationMs: 20_000, result: { verdict: "kill-it-all" } } }));
	assert.deepEqual(garbage.investigations.map((inv) => inv.status), ["failed"]);
	for (const result of [progressing, garbage]) assert.deepEqual([result.actions.filter((a) => RELEASES.includes(a.kind)), result.sent], [[], []]);
});

test("fixtures hold no tokens", () => {
	const hits = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/sk-ant|eyJ[A-Za-z0-9_-]{20}/.test(fs.readFileSync(full, "utf8"))) hits.push(path.relative(FIXTURES, full));
		}
	};
	walk(FIXTURES);
	assert.deepEqual(hits, []);
});
