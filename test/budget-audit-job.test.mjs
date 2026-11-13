import "./helpers/tmp-root.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIT_CONTRACT, AUDIT_JOB_KIND, pollAudit, startAudit } from "../src/budget/audit-job.mjs";
import { parseOutput } from "../src/budget/audit.mjs";
import { unavailableReason } from "../src/judge/analyst.mjs";
import { createRunner } from "../src/runner.mjs";
import { GUARD_FLAGS } from "../src/judge/lane.mjs";
import { createFakeRunner, createRecordingSpawn } from "./fakes/runner.mjs";

const MODEL = "chatgpt-subscription/gpt-6-astra:high";
const PROJECT = "sess-1:goal-1";
const AUDIT = "audit-1";

const OPINION = {
	v: 1,
	auditId: AUDIT,
	projectId: PROJECT,
	assessment: "justified",
	confidence: 0.8,
	criteriaStatus: "apparently-met",
	findings: [{ pattern: "other", evidence: "round 4 in the table", explanation: "each round added new acceptance evidence" }],
	advice: "Continue with the current approach; spending tracks new acceptance evidence rather than repeated checking.",
	allocationOpinion: { assessment: "support", reason: "the remaining estimate is inside the approved budget" },
};

/** A json-mode transcript whose final assistant message is `text`. */
function jsonStdout(text, usage = { input: 120, output: 80, cacheRead: 4000, cacheWrite: 200, cost: { total: 0.25 } }) {
	return [
		JSON.stringify({ type: "session", version: 3, id: "audit-session" }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", provider: "chatgpt-subscription", model: "gpt-6-astra", content: [{ type: "text", text }], usage },
		}),
	].join("\n");
}

/** The shared fake runner, but its job directory is a real temp dir so startAudit's bundle write stays out of the repo. */
function fakeAuditRunner(outcomes) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-job-"));
	const fake = createFakeRunner({ outcomes });
	const runner = { ...fake, jobDir: (jobId) => path.join(root, jobId) };
	return { runner, paths: { health: { jobsDir: root } }, root };
}

test("done: validated opinion and usage, with the guarded argv and the OMO command", () => {
	const { runner, paths } = fakeAuditRunner({ [AUDIT_JOB_KIND]: { status: "done", stdout: jsonStdout(JSON.stringify(OPINION)) } });
	const previous = process.env.OMO_HEALTH_OMO;
	process.env.OMO_HEALTH_OMO = "omo-test";
	let started;
	try {
		started = startAudit({ runner, paths, model: MODEL, bundle: "# bundle\n", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	} finally {
		if (previous === undefined) delete process.env.OMO_HEALTH_OMO;
		else process.env.OMO_HEALTH_OMO = previous;
	}

	assert.equal(started.jobId, AUDIT);
	assert.equal(AUDIT_JOB_KIND, "budget-audit");
	assert.equal(runner.starts.length, 1);
	const start = runner.starts[0];
	assert.equal(start.kind, AUDIT_JOB_KIND);
	assert.equal(start.command, "omo-test");
	assert.deepEqual(start.args.slice(0, 3), ["-p", "--mode", "json"]);
	for (const flag of GUARD_FLAGS) assert.ok(start.args.includes(flag), `missing guard flag ${flag}`);
	assert.ok(start.args.includes(MODEL));
	assert.ok(start.args.includes(`@${started.bundleFile}`));
	assert.equal(AUDIT_CONTRACT.parse, parseOutput, "the contract parses with audit.parseOutput");
	assert.equal(AUDIT_CONTRACT.unavailableReason, unavailableReason, "the contract reuses the analyst's unavailable detection");
	assert.equal(start.parse, AUDIT_CONTRACT.parse);
	assert.equal(start.unavailableReason, AUDIT_CONTRACT.unavailableReason);
	for (const text of ["usage limit reached", "Provider is not configured: anthropic-subscription/default"]) {
		assert.equal(AUDIT_CONTRACT.unavailableReason(text), unavailableReason(text), `unavailable detection differs for ${text}`);
	}
	assert.equal(AUDIT_CONTRACT.unavailableReason("usage limit reached"), "usage-limit");
	assert.equal(AUDIT_CONTRACT.unavailableReason("Provider is not configured: anthropic-subscription/default"), "not-configured");

	const expectedBundleFile = path.join(paths.health.jobsDir, AUDIT, "bundle.md");
	assert.equal(started.bundleFile, expectedBundleFile);
	assert.equal(fs.readFileSync(expectedBundleFile, "utf8"), "# bundle\n");

	const out = pollAudit(runner, AUDIT);
	assert.equal(out.status, "done");
	assert.deepEqual(out.opinion, OPINION);
	assert.equal(out.usage.cost, 0.25);
	assert.equal(out.usage.costStatus, "reported");
});

test("the bundle is persisted through fsx (temp file + rename), not written in place", () => {
	const { runner, paths } = fakeAuditRunner({ [AUDIT_JOB_KIND]: { status: "running" } });
	const written = [];
	const original = fs.writeFileSync;
	const spy = (file, ...rest) => {
		written.push(String(file));
		return original.call(fs, file, ...rest);
	};
	mock.method(fs, "writeFileSync", spy);
	try {
		startAudit({ runner, paths, model: MODEL, bundle: "# bundle\n", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	} finally {
		mock.restoreAll();
	}
	const bundleFile = path.join(paths.health.jobsDir, AUDIT, "bundle.md");
	assert.ok(written.length > 0, "startAudit writes the bundle");
	assert.ok(!written.includes(bundleFile), "the bundle file is never written in place");
	assert.equal(fs.readFileSync(bundleFile, "utf8"), "# bundle\n", "the bundle content still lands at bundleFile");
});

test("a runner still working keeps polling as running", () => {
	const { runner, paths } = fakeAuditRunner({ [AUDIT_JOB_KIND]: { status: "running" } });
	startAudit({ runner, paths, model: MODEL, bundle: "b", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	assert.deepEqual(pollAudit(runner, AUDIT), { status: "running" });
	assert.deepEqual(pollAudit(runner, AUDIT), { status: "running" });
	assert.equal(runner.starts.length, 1, "a running poll never starts another job");
});

test("invalid JSON -> failed with reason invalid-opinion", () => {
	const { runner, paths } = fakeAuditRunner({ [AUDIT_JOB_KIND]: { status: "done", stdout: "The evidence looks fine, no JSON here." } });
	startAudit({ runner, paths, model: MODEL, bundle: "b", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	const out = pollAudit(runner, AUDIT);
	assert.equal(out.status, "failed");
	assert.equal(out.reason, "invalid-opinion");
});

test("a JSON answer that fails the strict opinion schema is invalid-opinion", () => {
	const { runner, paths } = fakeAuditRunner({
		[AUDIT_JOB_KIND]: { status: "done", stdout: jsonStdout(JSON.stringify({ ...OPINION, assessment: "waste-likely", findings: [] })) },
	});
	startAudit({ runner, paths, model: MODEL, bundle: "b", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	const out = pollAudit(runner, AUDIT);
	assert.equal(out.status, "failed");
	assert.equal(out.reason, "invalid-opinion");
	assert.ok(out.errors.some((error) => error.includes("findings")), JSON.stringify(out.errors));
});

test("timeout maps straight through", () => {
	const { runner, paths } = fakeAuditRunner({ [AUDIT_JOB_KIND]: { status: "timeout", result: null, exitCode: null } });
	startAudit({ runner, paths, model: MODEL, bundle: "b", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	assert.deepEqual(pollAudit(runner, AUDIT), { status: "timeout", reason: null });
});

test("unavailable maps without retrying inside the same poll (QA failure scenario)", () => {
	const { runner, paths } = fakeAuditRunner({
		[AUDIT_JOB_KIND]: { status: "unavailable", reason: "usage-limit", detail: "usage limit reached", result: null, exitCode: 1 },
	});
	startAudit({ runner, paths, model: MODEL, bundle: "b", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });

	const first = pollAudit(runner, AUDIT);
	const second = pollAudit(runner, AUDIT);
	assert.deepEqual(first, { status: "unavailable", reason: "usage-limit", detail: "usage limit reached" });
	assert.deepEqual(second, first);
	assert.equal(runner.starts.length, 1, "a poll never starts another job");
});

test("restart: a new runner with the kind contract reads an audit that finished while the daemon was down", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-real-"));
	const paths = { health: { jobsDir: path.join(home, "jobs") } };
	const clock = { now: () => 1_000_000 };
	const spawn = createRecordingSpawn();
	const identify = () => ({ ctimeMs: 500, cmdSha1: "cmdsha" });
	const isAlive = () => false; // the audit's process is gone; it wrote no exit.json

	const runnerA = createRunner({ paths, spawnImpl: spawn.spawnImpl, clock, identify, isAlive, contracts: { [AUDIT_JOB_KIND]: AUDIT_CONTRACT } });
	const started = startAudit({ runner: runnerA, paths, model: MODEL, bundle: "# bundle", projectId: PROJECT, auditId: AUDIT, timeoutMs: 60_000 });
	const outFile = path.join(paths.health.jobsDir, started.jobId, "out.txt");
	// What the real process printed before it died; the runner started it with an empty out.txt.
	fs.writeFileSync(outFile, jsonStdout(JSON.stringify(OPINION)));
	assert.equal(fs.existsSync(path.join(paths.health.jobsDir, started.jobId, "exit.json")), false);

	const runnerB = createRunner({ paths, spawnImpl: spawn.spawnImpl, clock, identify, isAlive, contracts: { [AUDIT_JOB_KIND]: AUDIT_CONTRACT } });
	const done = pollAudit(runnerB, started.jobId);
	assert.equal(done.status, "done");
	assert.deepEqual(done.opinion, OPINION);
	assert.equal(done.usage.cost, 0.25);

	// Without the kind contract the same job files are an answer the runner cannot parse. The bare runner never
	// started the job and has no contracts, like a daemon restarted after an audit began; a second job is used
	// because the first poll finalizes meta.json for every later reader.
	const withoutContract = createRunner({ paths, spawnImpl: spawn.spawnImpl, clock, identify, isAlive });
	const bare = startAudit({ runner: runnerA, paths, model: MODEL, bundle: "# bundle", projectId: PROJECT, auditId: "audit-2", timeoutMs: 60_000 });
	fs.writeFileSync(path.join(paths.health.jobsDir, bare.jobId, "out.txt"), jsonStdout(JSON.stringify(OPINION)));
	const missed = pollAudit(withoutContract, bare.jobId);
	assert.equal(missed.status, "failed");
	assert.equal(missed.reason, "no-result");
});
