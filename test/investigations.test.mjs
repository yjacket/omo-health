import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createInvestigations } from "../src/investigations.mjs";
import { makeFinding } from "../src/detect/finding.mjs";
import { triageSignature } from "../src/judge/triage.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const T = Date.parse("2026-10-15T09:00:00Z");
const MIN = 60_000;
const HOUR = 3600_000;

/** A store over a private temp home, with a clock the test drives. */
function sandbox(prefix = "omoh-inv-") {
	const root = tmpDir(prefix);
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(T);
	return { root, paths, clock, investigations: createInvestigations({ paths, clock }) };
}

/** A D10 same-call loop as src/detect/loops.mjs reports it: the tool and the argument hash are part of the pattern. */
function loopFinding({ argsHash = "h1", tool = "read" } = {}) {
	return makeFinding({
		detector: "D10",
		kind: "same-call-loop",
		subject: { sessionId: "c1", taskId: "st_1", key: `call:${tool}:${String(argsHash).slice(0, 12)}` },
		evidence: [`tool:${tool}`, `argsHash:${argsHash}`],
		titleKo: "도구 반복 루프",
		data: { tool, argsHash, count: 12, runLength: 12, startMs: T - 5 * MIN, endMs: T - MIN },
	});
}

test("the signature round-trips: it is stored at open, masked like every other field, and truncated to 500 chars (#56 C7)", () => {
	const { investigations, paths } = sandbox();
	const signature = triageSignature(loopFinding());
	const opened = investigations.open({ id: "fp-a", trigger: "why", subject: { sessionId: "c1" }, detector: "D10", signature });
	assert.equal(opened.signature, signature);
	assert.equal(investigations.get("fp-a").signature, signature, "it survives the write");
	assert.equal(investigations.list()[0].signature, signature, "and the read-back");
	assert.equal(fs.existsSync(path.join(paths.health.investigationsDir, "fp-a.json")), true);

	const secret = investigations.open({ id: "fp-secret", signature: "curl -H 'x: sk-ant-api03-abcdefghijklmnop'" });
	assert.equal(secret.signature.includes("sk-ant-api03-abcdefghijklmnop"), false, "a credential never reaches the file");
	assert.match(secret.signature, /REDACTED/);

	const long = investigations.open({ id: "fp-long", signature: "x".repeat(900) });
	assert.equal(long.signature.length, 500);
	assert.equal(investigations.open({ id: "fp-none" }).signature, null, "a finding without a signature stores null, not undefined");
});

test("an investigation opened for a release takes a sticky why flag on the look that starts later (C7)", () => {
	const { investigations } = sandbox();
	const opened = investigations.open({ id: "fp-rel", trigger: "stall", cls: "stuck", detector: "D1", signature: "sig" });
	assert.equal(opened.why, undefined, "an R7 release investigation is not a why investigation yet");
	investigations.attach("fp-rel", { why: true, status: "analyzing", jobId: "job-1" });
	const after = investigations.attach("fp-rel", { status: "verdict", verdict: { verdict: "stuck", why: true } });
	assert.equal(investigations.get("fp-rel").why, true, "the flag is sticky across later attaches");
	assert.equal(after.trigger, "stall", "a why look never rewrites the trigger of an existing investigation");
	assert.equal(investigations.attach("fp-unknown", { why: true }), undefined, "an unknown id is reported, not created");
});

test("findAnswered returns the newest answered why verdict for a signature and refuses every unusable one (C14)", () => {
	const { investigations, clock } = sandbox();
	const sig = "D10|same-call-loop|||read|h1";
	const seed = (id, verdict) => {
		investigations.open({ id, trigger: "why", detector: "D10", signature: sig });
		investigations.attach(id, { verdict });
		clock.advance(MIN);
	};
	seed("fp-ok", { verdict: "stuck", assessment: "suspicious", why: true, atMs: T });
	seed("fp-failed", { verdict: "escalate", why: true, failed: true, atMs: T });
	seed("fp-notreached", { verdict: "escalate", why: true, notReached: true, atMs: T });
	seed("fp-reused", { verdict: "escalate", why: true, reused: true, atMs: T });
	seed("fp-release", { verdict: "stuck", why: false, atMs: T });
	seed("fp-old", { verdict: "stuck", why: true, atMs: T - 3 * HOUR });

	const found = investigations.findAnswered({ signature: sig, sinceMs: T - HOUR });
	assert.equal(found.id, "fp-ok", "only the answered, unused, in-window why verdict counts");
	assert.equal(found.verdict.why, true);
	assert.equal(investigations.findAnswered({ signature: sig, sinceMs: T + MIN }), undefined, "an answer older than the window is not reused");
	assert.equal(investigations.findAnswered({ signature: "other" }), undefined, "another pattern is another answer");
	assert.equal(investigations.findAnswered({}), undefined, "no signature, no lookup");

	// The answer of an investigation opened by a rule release counts when its look was a why look (the trigger is not the key).
	investigations.open({ id: "fp-rel-why", trigger: "stall", detector: "D1", signature: "sig-rel" });
	investigations.attach("fp-rel-why", { why: true, verdict: { verdict: "stuck", why: true, atMs: T + MIN } });
	assert.equal(investigations.findAnswered({ signature: "sig-rel", sinceMs: 0 }).id, "fp-rel-why");
	// A D1 release look is never a cache source, whatever the trigger.
	investigations.open({ id: "fp-rel-plain", trigger: "why", detector: "D1", signature: "sig-rel2" });
	investigations.attach("fp-rel-plain", { verdict: { verdict: "stuck", assessment: "stuck", why: false, atMs: T + MIN } });
	assert.equal(investigations.findAnswered({ signature: "sig-rel2", sinceMs: 0 }), undefined);
	// A verdict without its own answer time (a not-reached record) is unusable too.
	investigations.open({ id: "fp-noat", trigger: "why", detector: "D10", signature: "sig-noat" });
	investigations.attach("fp-noat", { verdict: { verdict: "wait", why: true } });
	assert.equal(investigations.findAnswered({ signature: "sig-noat", sinceMs: 0 }), undefined, "a verdict with no answer time is not reused");
});
