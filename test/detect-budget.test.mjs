import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as budget from "../src/detect/budget.mjs";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const LATER = NOW + 60_000;
const RESET = NOW + 3 * 24 * 3600_000;
const LATER_RESET = NOW + 9 * 24 * 3600_000;

const windowEntry = (partial = {}) => ({
	account: "anthropic-subscription/default",
	windowId: "claude:7d_opus",
	label: "Claude 주간",
	scope: "opus",
	usedPercent: 88,
	resetsAtMs: RESET,
	hoursLeft: 70,
	reservePercent: 12,
	freePercent: 0,
	burnPerHour: 0.5,
	projectedAtResetPercent: 105,
	safeDailyPercent: 0.1,
	state: "short",
	stale: false,
	calibrated: true,
	...partial,
});

const snapshot = (partial = {}) => ({
	v: 1,
	updatedMs: NOW,
	enabled: true,
	treasury: { state: "ok", windows: [] },
	projects: [],
	audits: [],
	owner: [],
	events: [],
	...partial,
});

const world = (budgetSnapshot, now = NOW) => ({ now, budget: budgetSnapshot });

function fullSnapshot() {
	return snapshot({
		treasury: { state: "short", windows: [windowEntry()] },
		audits: [
			{
				auditId: "aud1",
				projectId: "p1",
				ms: NOW - 5000,
				status: "done",
				model: "chatgpt-subscription/gpt-6-astra:high",
				assessment: "waste-likely",
				confidence: 0.8,
				advice: "Run the failing case only.",
				findings: [{ pattern: "repeated-qa-without-acceptance-gain" }],
			},
		],
	});
}

const byKind = (findings) => new Map(findings.map((finding) => [finding.kind, finding]));

test("each kind keeps its severity, human flag and subject key across ticks", () => {
	const first = byKind(budget.detect(world(fullSnapshot())));
	assert.deepEqual([...first.keys()].sort(), ["audit-opinion", "treasury-short"]);

	const short = first.get("treasury-short");
	assert.equal(short.detector, "D26");
	assert.equal(short.severity, "warn");
	assert.equal(short.humanNeeded, true);
	assert.equal(short.subject.key, `budget:short:anthropic-subscription/default:claude:7d_opus:${RESET}`);

	const audit = first.get("audit-opinion");
	assert.equal(audit.severity, "info");
	assert.equal(audit.humanNeeded, false);
	assert.equal(audit.subject.key, "budget:audit:aud1");

	const second = byKind(budget.detect(world(fullSnapshot(), LATER)));
	for (const [kind, finding] of first) assert.equal(second.get(kind).fp, finding.fp, `${kind} keeps one fp across ticks`);
});

test("an owner request needs no human and emits nothing", () => {
	// Nothing is approved by a human: an increase is settled by the auditor or the rules,
	// so a leftover owner entry in the snapshot must not surface as a finding.
	const withOwner = snapshot({
		owner: [{ projectId: "p1", requestId: "req1", kind: "increase", increaseUsd: 42.5, reason: "new-evidence", sinceMs: NOW - 1000 }],
	});
	assert.deepEqual(budget.detect(world(withOwner)), []);
	assert.equal(budget.detect(world(fullSnapshot())).some((finding) => finding.kind === "owner-decision"), false);
});

test("a tight window is info and not a human action", () => {
	const tightSnapshot = (usedPercent, projectedAtResetPercent) =>
		snapshot({ treasury: { state: "tight", windows: [windowEntry({ state: "tight", usedPercent, freePercent: 6, projectedAtResetPercent })] } });
	const findings = budget.detect(world(tightSnapshot(70, 90)));
	assert.equal(findings.length, 1);
	const [tight] = findings;
	assert.equal(tight.kind, "treasury-tight");
	assert.equal(tight.severity, "info");
	assert.equal(tight.humanNeeded, false);
	assert.equal(tight.subject.key, `budget:tight:anthropic-subscription/default:claude:7d_opus:${RESET}`);

	const second = byKind(budget.detect(world(tightSnapshot(74, 96), LATER)));
	assert.equal(second.get("treasury-tight").fp, tight.fp, "treasury-tight keeps one fp across ticks");
});

test("no finding when the snapshot is missing or disabled", () => {
	assert.deepEqual(budget.detect(world(undefined)), []);
	assert.deepEqual(budget.detect(world(null)), []);
	assert.deepEqual(budget.detect(world(snapshot({ enabled: false, treasury: { state: "short", windows: [windowEntry()] } }))), []);
});

test("tight to short escalation yields a new fp", () => {
	const tight = budget.detect(world(snapshot({ treasury: { state: "tight", windows: [windowEntry({ state: "tight", projectedAtResetPercent: 90 })] } })));
	const short = budget.detect(world(snapshot({ treasury: { state: "short", windows: [windowEntry({ state: "short", projectedAtResetPercent: 120 })] } })));
	assert.equal(tight.length, 1);
	assert.equal(short.length, 1);
	assert.notEqual(tight[0].fp, short[0].fp);
	assert.notEqual(tight[0].subject.key, short[0].subject.key);
});

test("a new account window reset is a new fp", () => {
	const before = budget.detect(world(snapshot({ treasury: { state: "short", windows: [windowEntry()] } })));
	const after = budget.detect(world(snapshot({ treasury: { state: "short", windows: [windowEntry({ resetsAtMs: LATER_RESET })] } })));
	assert.notEqual(before[0].fp, after[0].fp);
});

test("an unknown treasury emits nothing", () => {
	assert.deepEqual(budget.detect(world(snapshot({ treasury: { state: "unknown", windows: [windowEntry({ state: "unknown", projectedAtResetPercent: null, freePercent: null })] } }))), []);
	assert.deepEqual(budget.detect(world(snapshot({ treasury: { state: "unknown", windows: [windowEntry({ state: "ok" })] } }))), []);
});

test("audits emit only waste-likely opinions", () => {
	const auditOf = (assessment) => snapshot({
		audits: [{ auditId: "aud2", projectId: "p1", status: "done", assessment, confidence: 0.6, advice: "Keep going.", findings: [] }],
	});
	assert.deepEqual(budget.detect(world(auditOf("justified"))), []);
	assert.deepEqual(budget.detect(world(auditOf("insufficient-evidence"))), []);
	assert.equal(budget.detect(world(auditOf("waste-likely"))).length, 1);
});
