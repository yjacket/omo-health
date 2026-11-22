import "./helpers/tmp-root.mjs";
import { subjectOf } from "../src/session-subject.mjs";
const sub = (sessionId, cwd) => subjectOf({ sessionId, cwd });
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { appendDecision } from "../src/decisions.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { loadSessionRecord } from "../src/session-record.mjs";
import { createUsageIndex } from "../src/usage-index.mjs";
import { OUTCOME_LABELS, TERMINAL_LABELS } from "../src/ui/labels.mjs";
import { buildSessionView } from "../src/ui/session-view.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

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
	it("(IS-3) detail renders a tree total only when a descendant has been counted", () => {
		const root = tmpDir("session-view-tree-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const cases = [["equal", 0, 10], ["lower", -3, 7], ["pending", null, null], ["missing", null, null]];
		const row = { kind: "main", outcome: "completed", startedMs: T0 - 1000, endedMs: T0 };
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		const count = (id, input, meta, options) => {
			const file = path.join(root, `${id}.jsonl`);
			fs.writeFileSync(file, `${JSON.stringify({ type: "usage", provider: "p", model: "m", usage: { input } })}\n`);
			index.update(sub(id), file, meta, options);
		};
		for (const [id, input] of cases) {
			const child = `${id}-child`;
			const meta = { kind: "child", taskId: `st_${id}`, parentSessionId: id };
			appendEnded(paths, { ...row, sessionId: id }, { nowMs: T0 });
			appendEnded(paths, { ...row, ...meta, sessionId: child }, { nowMs: T0 });
			count(id, 10, { kind: "main" });
			if (id === "missing") index.markMissing(sub(child), meta);
			else count(child, input ?? 0, meta, id === "pending" ? { maxBytes: 1 } : {});
		}
		index.save();
		const tokens = cases.map(([id]) => buildSessionView(loadSessionRecord({ paths, id, now: T0 })).tokens);
		assert.deepEqual(tokens.map((entry) => entry.treeTotal), cases.map(([, , total]) => total));

		const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
		const names = ["tokenReading", "treeTokenMark", "endedTokenBlock"];
		const el = (tag, attrs) => ({ tag, ...attrs });
		const endedTokenBlock = runInNewContext(
			names.map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") + "\nendedTokenBlock",
			{ el, block: (_title, _own, tree) => tree, endedTokenFacts: () => null, compactCount: String, fullCount: String },
		);
		assert.deepEqual(tokens.map((entry) => endedTokenBlock(entry)?.text), ["자식 포함 10", "자식 포함 7", undefined, undefined]);
	});

	it("detail tree completeness reflects ledger-only and indexed descendants", () => {
		const root = tmpDir("session-view-partial-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const row = { kind: "main", outcome: "completed", startedMs: T0 - 1000, endedMs: T0 };
		const ledgerChild = { kind: "child", taskId: "st_pending", parentSessionId: "s-main" };
		appendEnded(paths, { ...row, sessionId: "s-main" }, { nowMs: T0 });
		appendEnded(paths, { ...row, ...ledgerChild, sessionId: "pending" }, { nowMs: T0 });
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		const count = (id, input, meta) => {
			const file = path.join(root, `${id}.jsonl`);
			fs.writeFileSync(file, `${JSON.stringify({ type: "usage", provider: "p", model: "m", usage: { input } })}\n`);
			index.update(sub(id), file, meta);
		};
		const total = () => {
			index.save();
			const { treeTotal, treeTokensComplete } = buildSessionView(loadSessionRecord({ paths, id: "s-main", now: T0 })).tokens;
			return [treeTotal, treeTokensComplete];
		};
		count("s-main", 100, { kind: "main" });
		count("counted", 20, { kind: "child", parentSessionId: "s-main" });
		assert.deepEqual(total(), [120, false]);
		count("pending", 0, ledgerChild);
		assert.deepEqual(total(), [120, true]);
		index.markMissing(sub("missing"), { kind: "child", parentSessionId: "s-main" });
		assert.deepEqual(total(), [120, false]);
	});

	it("(plan 51) detail marks a pending parent tree partial until its read finishes", () => {
		const root = tmpDir("session-view-pending-parent-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		appendEnded(paths, { sessionId: "main", kind: "main", startedMs: T0 - 1000, endedMs: T0, outcome: "completed" }, { nowMs: T0 });
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		const transcript = (id, input) => {
			const file = path.join(root, `${id}.jsonl`);
			fs.writeFileSync(file, `${JSON.stringify({ type: "usage", provider: "p", model: "m", usage: { input } })}\n`);
			return file;
		};
		const parent = transcript("main", 100);
		index.update(sub("main"), parent, { kind: "main" }, { maxBytes: 1 });
		index.update(sub("child"), transcript("child", 20), { kind: "child", parentSessionId: "main" });
		const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
		const endedTokenBlock = runInNewContext(
			["tokenReading", "treeTokenMark", "endedTokenBlock"].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") + "\nendedTokenBlock",
			{ el: (_tag, attrs) => attrs, block: (_title, _own, tree) => tree, endedTokenFacts: () => null, compactCount: String, fullCount: String },
		);
		const display = () => {
			index.save();
			const { tokens } = buildSessionView(loadSessionRecord({ paths, id: "main", now: T0 }));
			const mark = endedTokenBlock(tokens);
			return [tokens.total, tokens.treeTotal, tokens.treeTokensComplete, mark.text, mark.title];
		};
		const pending = display();
		index.update(sub("main"), parent, { kind: "main" });
		assert.deepEqual([pending, display()], [
			[null, 20, false, "자식 포함 20+", "세지 못한 자식이 있어 일부만 더한 값입니다"],
			[100, 120, true, "자식 포함 120", "120"],
		]);
	});

	it("(plan 51) detail parent trees do not fall back to an ambiguous task-only child's tokens", () => {
		const root = tmpDir("session-view-ambiguous-tree-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const row = { kind: "main", outcome: "completed", startedMs: T0 - 1000, endedMs: T0 };
		const taskId = "st_shared";
		const parents = ["main-a", "main-b"];
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		const count = (id, input, meta) => {
			const file = path.join(root, `${id}.jsonl`);
			fs.writeFileSync(file, `${JSON.stringify({ type: "usage", provider: "p", model: "m", usage: { input } })}\n`);
			index.update(sub(id), file, meta);
		};
		for (const id of parents) {
			count(id, 100, { kind: "main" });
			appendEnded(paths, { ...row, sessionId: id }, { nowMs: T0 });
			appendEnded(paths, { ...row, sessionId: taskId, taskId, kind: "child", cwd: path.join(root, id), parentSessionId: id }, { nowMs: T0 });
		}
		count(taskId, 42, { kind: "child", taskId, parentSessionId: parents[0] });
		const totals = () => {
			index.save();
			return parents.map((id) => {
				const { tokens, children } = buildSessionView(loadSessionRecord({ paths, id, now: T0 }));
				return [tokens.treeTotal, tokens.treeTokensComplete, children.find((child) => child.taskId === taskId)?.tokens];
			});
		};
		assert.deepEqual(totals(), [[null, false, null], [null, false, null]]);
		for (const id of parents) count(`${id}-counted`, 20, { kind: "child", parentSessionId: id });
		assert.deepEqual(totals(), [[120, false, null], [120, false, null]]);
	});

	it("(IS-3) deleted task-only usage keeps its total and the existing detail label", (t) => {
		const root = tmpDir("session-view-deleted-task-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const taskId = "st_deleted";
		const row = { sessionId: taskId, taskId, kind: "child", startedMs: T0 - 1000, endedMs: T0, outcome: "completed" };
		appendEnded(paths, row, { nowMs: T0 });
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		const file = path.join(root, "task.jsonl");
		fs.writeFileSync(file, '{"type":"usage","provider":"p","model":"m","usage":{"input":42}}\n');
		index.update(sub(taskId), file, row);
		const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
		const endedTokenFacts = runInNewContext(
			["tokenReading", "endedTokenFacts"].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") + "\nendedTokenFacts",
			{
				el: (tag, attrs) => ({ tag, ...attrs }), facts: (rows) => rows, fullCount: String,
				empty: () => null, note: () => null, plain: (text) => text, costText: () => "-",
			},
		);
		const status = () => {
			index.save();
			const { tokens } = JSON.parse(JSON.stringify(buildSessionView(loadSessionRecord({ paths, id: taskId, now: T0 }))));
			const total = endedTokenFacts(tokens).find((entry) => entry?.[0] === "합계");
			return [tokens?.total, tokens?.gone, total?.[1]?.text, total?.[2]?.text ?? null];
		};
		assert.deepEqual(status(), [42, false, "42", null]);
		fs.rmSync(file);
		index.markMissing(sub(taskId));
		assert.deepEqual(status(), [42, true, "42", "파일 삭제됨"]);
	});

	it("detail overflow survives index reload and JSON, and renders on the token block and child row", () => {
		const root = tmpDir("session-view-overflow-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const row = { sessionId: "s-main", kind: "main", outcome: "completed", startedMs: T0 - 1000, endedMs: T0 };
		appendEnded(paths, row, { nowMs: T0 });
		appendEnded(paths, { ...row, sessionId: "s-child", kind: "child", taskId: "st_a", parentSessionId: "s-main", outcome: "answered" }, { nowMs: T0 });
		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now: () => T0 } });
		for (const [id, value, parentSessionId] of [["s-main", "1e309"], ["s-child", "-1e309", "s-main"]]) {
			const file = path.join(root, `${id}.jsonl`);
			fs.writeFileSync(file, `{"type":"usage","provider":"p","model":"m","usage":{"input":${value}}}\n`);
			index.update(sub(id), file, { parentSessionId: parentSessionId ?? null });
		}
		index.save();
		const record = loadSessionRecord({ paths, id: row.sessionId, now: T0 });
		assert.equal(record.tokens.total, Infinity);
		assert.equal(record.tokens.treeTotal, NaN);
		const detail = JSON.parse(JSON.stringify(buildSessionView(record)));
		const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
		const names = ["tokenReading", "endedTokenFacts", "endedChild"];
		const el = (tag, attrs, ...children) => ({ tag, ...attrs, children });
		const format = runInNewContext(
			names.map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") + `\n({ ${names.join(", ")} })`,
			{ el, empty: (text) => el("p", { text }), note: (text) => el("p", { text }), OUTCOME_TONE: {}, lastState: {}, compactCount: () => "-", fullCount: () => "-" },
		);
		const own = format.endedTokenFacts(detail.tokens);
		const child = format.endedChild(detail.children[0]).children[0].children[2].children[1];
		const title = "토큰 합계가 표시할 수 있는 범위를 넘었습니다";
		assert.deepEqual([detail.tokens.total, detail.tokens.tokensState, own.text, own.title], [null, "overflow", "-", title]);
		assert.deepEqual([detail.tokens.treeTotal, detail.tokens.treeTokensState], [null, "overflow"]);
		assert.deepEqual([detail.children[0].tokens.total, detail.children[0].tokensState, child.text, child.title],
			[null, "overflow", "토큰 -", title]);
	});

	it("IS-7: detail labels a D20 relaunch on the parked session only", () => {
		const root = tmpDir("session-view-relaunch-");
		const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
		const sessionId = "s-parked";
		const row = { sessionId, kind: "main", startedMs: T0 - 1000, endedMs: T0 };
		appendEnded(paths, row, { nowMs: T0 });
		appendEnded(paths, { ...row, sessionId: "s-other" }, { nowMs: T0 });
		const ts = iso(T0 + 1000);
		// Producer shape: src/act/park-resume.mjs:154-155,284; timestamp added by the decision log.
		appendDecision(paths, { detector: "D20", kind: "park-resume", event: "park-transition", subject: { sessionId }, parkId: `${sessionId}.${T0}`, sessionId, from: "claimed", to: "launched", why: "launched", ts });
		const detail = (id) => buildSessionView(loadSessionRecord({ paths, id, now: T0 + 1000 }));
		assert.deepEqual(detail("s-other").health.actions, []);
		assert.deepEqual(detail(sessionId).health.actions.map(({ kind, actionKo, resultKo, ts, recipient }) => [kind, actionKo, resultKo, ts, recipient]), [
			["relaunch", "한도 대기 세션 다시 열기", "다시 열었음", ts, sessionId],
		]);
	});

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

	it("(plan 37) sends full detail text instead of the investigation list previews", () => {
		const text = `${"x".repeat(900)}\nThe redacted final sentence.`;
		const evidence = [...Array.from({ length: 12 }, (_, i) => `line ${i}`), text];
		const raw = record();
		raw.health.findings[0].evidence = evidence;
		raw.health.actions[0].detail = text;
		raw.health.messages[0].text = text;
		const explanations = { diagnosis: text, mechanism: text, avoid: text, advice: text, reason: text, evidence };
		raw.health.investigations[0] = investigation({
			evidence,
			signals: [text],
			verdict: { verdict: "escalate", ...explanations },
			verdictHistory: [{ verdict: "escalate", ...explanations }],
			actions: [{ kind: "release-shell", detail: text, advice: text }],
		});
		const health = JSON.parse(JSON.stringify(buildSessionView(raw))).health;
		assert.deepEqual(health.findings[0].evidence, evidence);
		assert.equal(health.actions[0].detail, text);
		assert.equal(health.messages[0].text, text);
		const [investigationView] = health.investigations;
		assert.deepEqual(investigationView.evidence, evidence);
		assert.deepEqual(investigationView.signals, [text]);
		for (const [field, value] of Object.entries(explanations)) {
			assert.deepEqual(investigationView.verdict[field], value);
			assert.deepEqual(investigationView.verdictHistory[0][field], value);
		}
		assert.equal(investigationView.action.detail, text);
		assert.equal(investigationView.action.advice, text);
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

	it("(coverage) labels an incomplete detector review like other audit failures", () => {
		const state = { status: "failed", reason: "incomplete-checks", result: null };
		const view = buildSessionView(record(), { audit: { state } });
		assert.equal(view.audit.state.reasonKo, "감지를 모두 검토하지 않은 답을 받았습니다");
		assert.equal(view.audit.state.result, null);
	});
});
