import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OUTCOME_LABELS, TERMINAL_LABELS } from "../src/ui/labels.mjs";
import { buildSessionView } from "../src/ui/session-view.mjs";

const T0 = Date.parse("2026-10-10T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function investigation(extra = {}) {
	return {
		id: "fp-1",
		openedMs: T0,
		updatedMs: T0,
		status: "verdict",
		trigger: "stall",
		subject: { sessionId: "s-main", taskId: null, toolCallId: null, parentSessionId: null },
		detector: "D1",
		cls: "quiet-hang",
		rule: { id: "R12", v: 1, confidence: 0.6 },
		evidence: ["20m without output"],
		signals: [],
		lane: "quick",
		model: "provider/model",
		jobId: null,
		verdict: { atMs: T0 + 1000, verdict: "escalate", assessment: "suspicious", cause: "wrong-command", confidence: 0.8, diagnosis: "same broken command", evidence: [] },
		actions: [{ atMs: T0 + 2000, kind: "release-shell", quiet: true, killed: [], noop: [], survived: [] }],
		failures: 0,
		retryAtMs: null,
		verdictHistory: [
			{ ts: iso(T0 + 500), verdict: "wait", assessment: null, cause: null, confidence: 0.5, failed: false, reason: null, diagnosis: null },
			{ ts: iso(T0 + 1500), verdict: "escalate", assessment: "suspicious", cause: "wrong-command", confidence: 0.8, failed: false, reason: null, diagnosis: "same broken command" },
		],
		...extra,
	};
}

function record(overrides = {}) {
	return {
		found: true,
		id: "s-main",
		session: {
			sessionId: "s-main",
			kind: "main",
			parentSessionId: null,
			taskId: null,
			title: "main",
			cwd: "C:\\work",
			terminal: { kind: "orca" },
			omoVersion: "0.8.0",
			startedMs: T0,
			endedMs: T0 + 2 * 3_600_000,
			durationMs: 2 * 3_600_000,
			outcome: "goal-complete",
			reason: null,
			childCount: 1,
			estimated: false,
			source: "live",
		},
		tokens: { total: 10, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, costUnknown: false, turns: 1, models: [], state: "ok", complete: true, treeTotal: null, gone: false },
		children: [{ sessionId: "s-child", taskId: "st_a", title: "child", outcome: "answered", endedMs: T0 + 3_600_000, depth: 1, tokens: null, tokensState: "pending" }],
		coverage: { infoFindings: false },
		truncated: { messagesSkipped: [] },
		health: {
			findings: [
				{ fp: "fp-1", ts: iso(T0), event: "opened", detector: "D1", kind: "stall", severity: "warn", titleKo: "도구 호출 멈춤", scope: "session", evidence: [] },
				{ fp: "fp-2", ts: iso(T0), event: "opened", detector: "D99", kind: "odd-kind", severity: "loud", titleKo: null, scope: "machine", evidence: [] },
			],
			actions: [
				{ ts: iso(T0 + 2000), detector: "D1", kind: "kill-pids", result: "execute", detail: "killed 11", recipient: null, subject: {}, facts: {} },
				{ ts: iso(T0 + 3000), detector: "D1", kind: "odd-action", result: "mystery", detail: null, recipient: null, subject: {}, facts: {} },
			],
			investigations: [investigation()],
			messages: [{ ms: T0, recipient: "s-main", text: "hello" }],
			counts: { findings: 2, actions: 2, investigations: 1, messages: 1 },
		},
		audit: null,
		...overrides,
	};
}

describe("session view", () => {
	it("labels the session, findings, actions and children, falling back to the raw key for unknown kinds", () => {
		const raw = record();
		const view = buildSessionView(raw);
		assert.equal(view.session.outcomeKo, OUTCOME_LABELS["goal-complete"]);
		assert.equal(view.session.terminalLabel, TERMINAL_LABELS.orca);
		assert.equal(view.session.title, "main");
		const [known, odd] = view.health.findings;
		assert.equal(known.titleKo, "도구 호출 멈춤");
		assert.equal(known.severityKo, "주의");
		assert.equal(odd.titleKo, "D99 odd-kind");
		assert.equal(odd.severityKo, "loud");
		const [kill, unknown] = view.health.actions;
		assert.equal(kill.actionKo, "원인 프로세스 종료");
		assert.equal(kill.resultKo, "실행");
		assert.equal(unknown.actionKo, "odd-action");
		assert.equal(unknown.resultKo, "mystery");
		assert.equal(view.children[0].outcomeKo, OUTCOME_LABELS.answered);
		assert.equal(view.children[0].sessionId, "s-child");
	});

	it("maps investigations through investigationRow and keeps labelled verdict history in order", () => {
		const view = buildSessionView(record());
		const [row] = view.health.investigations;
		assert.equal(row.id, "fp-1");
		assert.equal(row.statusKo, "판정됨");
		assert.equal(row.triggerKo, "시간 초과");
		assert.equal(row.clsKo, "기록도 출력도 없이 멈춤");
		assert.equal(row.rule, "R12");
		assert.deepEqual(row.subject, { id: "s-main", kind: "main", kindKo: "메인", sessionShort: "s-main", taskId: null });
		assert.equal(row.verdict.verdict, "escalate");
		assert.equal(row.verdictKo, "의심");
		assert.equal(row.action.kindKo, "기다리던 셸 해제");
		assert.equal(row.actionCount, 1);
		assert.equal(row.evidence.length, 1);
		assert.deepEqual(row.verdictHistory.map((h) => [h.verdict, h.verdictKo, h.causeKo]), [
			["wait", "진행 중", "-"],
			["escalate", "의심", "잘못된 명령"],
		]);
		assert.deepEqual(row.verdictHistory.map((h) => h.ts), [iso(T0 + 500), iso(T0 + 1500)]);
	});

	it("is pure, leaves audit null and lets extras override it", () => {
		const raw = record();
		const snapshot = JSON.stringify(raw);
		assert.equal(buildSessionView(raw).audit, null);
		assert.equal(JSON.stringify(raw), snapshot);
		assert.deepEqual(buildSessionView(raw, { audit: { state: "queued" } }).audit, { state: "queued" });
		assert.equal(buildSessionView(raw).session.outcomeKo !== undefined, true);
	});

	it("returns a not-found record untouched apart from audit and extras", () => {
		const missing = { found: false, id: "s-missing" };
		assert.deepEqual(buildSessionView(missing), { found: false, id: "s-missing", audit: null });
		assert.deepEqual(buildSessionView(missing, { audit: { state: "done" } }), { found: false, id: "s-missing", audit: { state: "done" } });
	});

	it("labels the audit state, its reason and its verdict enums", () => {
		const audit = {
			state: {
				status: "failed",
				reason: "timeout:900s",
				result: {
					overall: "exaggerated",
					summary: "요약입니다",
					tokens: { judgment: "wasteful", explanation: "많이 썼습니다" },
					checks: [{ item: "D1", judgment: "overreach", explanation: "과합니다", evidence: ["F1"] }],
				},
			},
			planned: { model: "openai/gpt-review", lane: "architect", independence: "family" },
			blocked: null,
			stalled: false,
			usedToday: 1,
			perDay: 20,
		};
		const view = buildSessionView(record(), { audit });
		assert.equal(view.audit.state.statusKo, "실패");
		assert.equal(view.audit.state.reasonKo, "제한 시간 안에 답하지 않았습니다");
		assert.equal(view.audit.state.result.overallKo, "과장");
		assert.equal(view.audit.state.result.tokens.judgmentKo, "낭비");
		assert.equal(view.audit.state.result.checks[0].judgmentKo, "무리한 판단");
		assert.deepEqual(view.audit.planned, { model: "openai/gpt-review", lane: "architect", independence: "family" });
		assert.equal(view.audit.blocked, null);
		assert.equal(view.audit.usedToday, 1);
		assert.equal(view.audit.perDay, 20);
		assert.equal(audit.state.statusKo, undefined, "the input is not mutated");
	});

	it("shows a request the daemon has not taken as queued", () => {
		const view = buildSessionView(record(), { audit: { state: { status: "requested" }, planned: null, blocked: null, stalled: false, usedToday: 0, perDay: 20 } });
		assert.equal(view.audit.state.status, "queued");
		assert.equal(view.audit.state.statusKo, "대기 중");
		assert.equal(view.audit.statusKo, "대기 중");
		assert.equal(view.audit.state.reasonKo, null);
	});
});
