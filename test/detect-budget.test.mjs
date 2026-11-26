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

test("owner-call: a project past the ladder's last tier raises one human-needed finding per call", () => {
	const call = { ms: NOW, basis: "budget", ratio: 4.2, rounds: 3 };
	const world = { budget: { enabled: true, treasury: { windows: [] }, audits: [], projects: [{ id: "s:g", objective: "build the board", ownerCall: call }, { id: "s:h", ownerCall: null }] } };
	const findings = budget.detect(world);
	assert.equal(findings.length, 1);
	const [finding] = findings;
	assert.deepEqual([finding.kind, finding.severity, finding.humanNeeded], ["owner-call", "warn", true]);
	assert.equal(finding.subject.key, `budget:owner-call:s:g:${NOW}`);
	assert.match(finding.detailKo, /4\.2배/);
	assert.equal(budget.detect({ budget: { enabled: true, projects: [{ id: "s:g", ownerCall: { ...call, basis: "rounds", ratio: null, rounds: 41 } }] } })[0].detailKo.includes("41차"), true);
	assert.deepEqual(budget.detect({ budget: { enabled: true, projects: [{ id: "s:g", ownerCall: { ...call, answeredMs: LATER } }] } }), [], "an answered call needs no human (#24)");
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

test("session-day: only the owner level of a session tree is a human-needed warning, with its main/subagent split and one fp across ticks (#33)", () => {
	const tree = (partial = {}) => ({
		sessionId: "01a1ffcb-59fb-7563-8d59-9710650ec377",
		projectId: "01a1ffcb:g1",
		objective: "plan review loop",
		totalUsd: 282,
		mainUsd: 270,
		childUsd: 12,
		level: "owner",
		basis: { kind: "window", account: "anthropic-subscription/default", windowId: "claude:7d", label: "Claude 주간", percent: 17.5, usd: 282, thresholdPercent: 10 },
		...partial,
	});
	const sessions = [tree(), tree({ sessionId: "b", level: "investigate" }), tree({ sessionId: "c", level: null, basis: null })];
	const findings = budget.detect(world(snapshot({ sessionDay: { investigateUsd: 100, ownerUsd: 200, sessions } })));
	assert.equal(findings.length, 1);
	const [finding] = findings;
	assert.deepEqual([finding.kind, finding.severity, finding.humanNeeded], ["session-day", "warn", true]);
	assert.equal(finding.subject.key, "budget:session-day:01a1ffcb-59fb-7563-8d59-9710650ec377");
	assert.match(finding.titleKo, /17\.5%/);
	assert.match(finding.detailKo, /메인 \$270, 하위작업 \$12/);
	const usd = budget.detect(world(snapshot({ sessionDay: { sessions: [tree({ basis: { kind: "usd", usd: 230, thresholdUsd: 200 }, totalUsd: 230 })] } }), LATER));
	assert.equal(usd[0].fp, finding.fp, "the same session keeps one fp whatever crossed");
	assert.match(usd[0].detailKo, /\$230.*\$200/, "the tree's total against the USD owner line (#40)");
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

test("a reset time that jitters by a few hundred ms keeps one fp per window cycle (#27)", () => {
	// Two real Claude 7d readings on 2026-11-25, just before the hour, and one that crosses it.
	const jittered = [1796126399725, 1796126399969, 1796126400050];
	for (const state of ["short", "tight"]) {
		const fps = jittered.map((resetsAtMs) => budget.detect(world(snapshot({ treasury: { state, windows: [windowEntry({ state, resetsAtMs })] } })))[0].fp);
		assert.equal(new Set(fps).size, 1, `${state}: one fp for one cycle`);
		const nextCycle = budget.detect(world(snapshot({ treasury: { state, windows: [windowEntry({ state, resetsAtMs: jittered[0] + 7 * 24 * 3600_000 })] } })))[0].fp;
		assert.notEqual(nextCycle, fps[0], `${state}: the next 7d cycle is a new fp`);
	}
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
