import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionDay, shareDistribution, windowThresholds } from "../src/budget/session-day.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const CFG = DEFAULT_CONFIG.budget;
const ACCOUNT = "anthropic-subscription/default";
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
// 0.062 %/$: the #33 calibration (Claude 7-day window), so $162 is about 10% of the window.
const CLAUDE = Object.freeze({ account: ACCOUNT, windowId: "claude:7d", label: "Claude 주간", scope: null, calibrated: true, percentPerUsd: 0.062 });
const FABLE = Object.freeze({ account: ACCOUNT, windowId: "claude:7d_fable", label: "Fable 주간", scope: "fable", calibrated: true, percentPerUsd: 0.5 });
// The percent pair #33 shipped as the default, now opt-in.
const PERCENT_ON = Object.freeze({ ...CFG, sessionDayInvestigatePercent: 5, sessionDayPercent: 10 });

const row = (rootSessionId, cost, extra = {}) => ({ ms: T0, rootSessionId, source: "main", provider: "anthropic-subscription", model: "claude-opus-5-5", cost, ...extra });
const byId = (result) => new Map(result.sessions.map((s) => [s.sessionId, s]));

test("by default the tree's 24 h total cost decides: under $100 nothing, $100 audits, $200 asks a human (#40)", () => {
	const rows = [row("d99", 99), row("d100", 60), row("d100", 40, { source: "child" }), row("d199", 199), row("d200", 120), row("d200", 80, { source: "child" })];
	for (const states of [[CLAUDE], [{ ...CLAUDE, calibrated: false }], []]) {
		const result = sessionDay({ rows, states, cfg: CFG });
		const s = byId(result);
		assert.deepEqual([result.investigateUsd, result.ownerUsd], [100, 200]);
		assert.deepEqual(
			["d99", "d100", "d199", "d200"].map((id) => [id, s.get(id).level, s.get(id).basis?.kind ?? null]),
			[
				["d99", null, null],
				["d100", "investigate", "usd"],
				["d199", "investigate", "usd"],
				["d200", "owner", "usd"],
			],
			`${states.length} window(s), calibrated: ${states[0]?.calibrated ?? "-"}`,
		);
		assert.deepEqual(s.get("d200").basis, { kind: "usd", usd: 200, thresholdUsd: 200 });
		assert.deepEqual(s.get("d100").basis, { kind: "usd", usd: 100, thresholdUsd: 100 });
	}
});

test("cost a window counts and cost no window counts add up to one total; audit cost is not the session's (#40)", () => {
	const rows = [
		row("a", 60),
		row("a", 100, { source: "child", provider: "openai-codex", model: "gpt-6.2" }),
		row("a", 45, { source: "child", provider: "github-copilot", model: "gpt-6.2" }),
		row("a", 500, { source: "audit" }),
	];
	const s = byId(sessionDay({ rows, states: [CLAUDE], cfg: CFG })).get("a");
	assert.deepEqual([s.totalUsd, s.mainUsd, s.childUsd], [205, 60, 145]);
	assert.equal(s.shares[0].usd, 60, "the Claude window still shows its share as a reference");
	assert.deepEqual([s.level, s.basis], ["owner", { kind: "usd", usd: 205, thresholdUsd: 200 }]);
	const ordered = sessionDay({ rows: [row("claude", 110), row("codex", 190, { provider: "openai-codex", model: "gpt-6.2" }), row("quiet-claude", 60), row("quiet-codex", 90, { provider: "openai-codex", model: "gpt-6.2" })], states: [CLAUDE], cfg: CFG });
	assert.deepEqual(ordered.sessions.map((x) => x.sessionId), ["codex", "claude", "quiet-codex", "quiet-claude"], "level, then total cost: a tree no window counts is not ranked below a smaller one");
	const aliased = byId(sessionDay({ rows: [row("a", 100, { provider: "claude-sdk-oauth" })], states: [CLAUDE], cfg: CFG })).get("a");
	assert.equal(aliased.shares[0].usd, 100, "budget.providerAliases connects a proxy provider to the account");
});

test("the window percent pair is off by default: a large share of a window raises nothing below $100 (#40)", () => {
	assert.deepEqual([CFG.sessionDayInvestigatePercent, CFG.sessionDayPercent, CFG.sessionDayInvestigateUsd, CFG.sessionDayUsd], [0, 0, 100, 200]);
	assert.deepEqual(windowThresholds(CFG, ACCOUNT, "claude:7d"), { investigatePercent: 0, ownerPercent: 0, overridden: false });
	assert.deepEqual(windowThresholds({}, ACCOUNT, "claude:7d"), { investigatePercent: 0, ownerPercent: 0, overridden: false }, "no config: still off");
	// $90 of Fable is 45% of its window.
	const s = byId(sessionDay({ rows: [row("a", 90, { model: "claude-fable-5-2" })], states: [CLAUDE, FABLE], cfg: CFG })).get("a");
	assert.equal(s.shares.find((x) => x.windowId === "claude:7d_fable").percent, 45);
	assert.deepEqual(s.shares.map((x) => x.level), [null, null]);
	assert.deepEqual([s.level, s.basis], [null, null]);
});

test("the percent pair still works when set: a tree's share of a calibrated window or a scoped window crosses before $200", () => {
	const rows = [row("a", 170), row("b", 90), row("c", 50)];
	const s = byId(sessionDay({ rows, states: [CLAUDE], cfg: PERCENT_ON }));
	assert.equal(Math.round(s.get("a").maxPercent * 10) / 10, 10.5);
	assert.deepEqual(s.get("a").basis, { kind: "window", account: ACCOUNT, windowId: "claude:7d", label: "Claude 주간", percent: 170 * 0.062, usd: 170, thresholdPercent: 10 });
	assert.equal(s.get("b").level, "investigate", "$90 = 5.6% is past the 5% investigate line");
	assert.equal(s.get("c").level, null);
	const scoped = byId(sessionDay({ rows: [row("a", 20, { model: "claude-fable-5-2" }), row("a", 100)], states: [CLAUDE, FABLE], cfg: PERCENT_ON })).get("a");
	assert.deepEqual(scoped.shares.map((x) => [x.windowId, x.usd]), [["claude:7d", 120], ["claude:7d_fable", 20]]);
	assert.deepEqual([scoped.level, scoped.basis.windowId], ["owner", "claude:7d_fable"], "fable: $20 x 0.5 = 10% of its own window");
});

test("budget.windows turns the percent pair on for one window; the USD owner level still outranks a window's investigate; 0 turns a threshold off", () => {
	const key = `${ACCOUNT}:claude:7d`;
	const cfg = { ...CFG, windows: { [key]: { sessionDayInvestigatePercent: 5, sessionDayPercent: 10 } } };
	assert.deepEqual(windowThresholds(cfg, ACCOUNT, "claude:7d"), { investigatePercent: 5, ownerPercent: 10, overridden: true });
	assert.deepEqual(windowThresholds(cfg, ACCOUNT, "claude:7d_fable"), { investigatePercent: 0, ownerPercent: 0, overridden: false });
	const s = byId(sessionDay({ rows: [row("a", 170), row("b", 210, { provider: "openai-codex", model: "gpt-6.2" }), row("c", 90)], states: [CLAUDE, FABLE], cfg }));
	assert.deepEqual([s.get("a").level, s.get("a").basis.kind], ["owner", "window"], "$170 = 10.5% of the overridden window");
	assert.deepEqual([s.get("b").level, s.get("b").basis.kind], ["owner", "usd"], "cost outside the overridden window still meets the USD pair");
	assert.deepEqual([s.get("c").level, s.get("c").basis.kind], ["investigate", "window"]);
	const wide = { ...CFG, windows: { [key]: { sessionDayInvestigatePercent: 5, sessionDayPercent: 20 } } };
	const both = byId(sessionDay({ rows: [row("a", 210)], states: [CLAUDE], cfg: wide })).get("a");
	assert.equal(both.shares[0].level, "investigate", "$210 = 13% is past the window's 5% only");
	assert.deepEqual([both.level, both.basis.kind], ["owner", "usd"], "the USD owner level outranks the window's investigate");
	const off = { ...PERCENT_ON, sessionDayInvestigateUsd: 0, sessionDayUsd: 0, sessionDayInvestigatePercent: 0, sessionDayPercent: 0 };
	assert.equal(byId(sessionDay({ rows: [row("a", 5000), row("a", 5000, { provider: "github-copilot" })], states: [CLAUDE], cfg: off })).get("a").level, null);
});

test("shareDistribution: the 95th percentile of one session tree's daily share per calibrated window", () => {
	const rows = [];
	// 20 session-days on 2 sessions: $10, $20, ... $200 of Claude spend; plus an audit row that must not count.
	for (let i = 1; i <= 20; i++) rows.push(row(i % 2 ? "a" : "b", i * 10, { ms: T0 - Math.floor((i - 1) / 2) * DAY }));
	rows.push(row("a", 10_000, { source: "audit" }));
	const out = shareDistribution({ rows, states: [CLAUDE, { ...FABLE, calibrated: false }], cfg: CFG });
	assert.deepEqual(Object.keys(out), [`${ACCOUNT}:claude:7d`], "an uncalibrated window has no distribution");
	assert.equal(out[`${ACCOUNT}:claude:7d`].days, 20);
	assert.equal(Math.round(out[`${ACCOUNT}:claude:7d`].p95Percent * 100) / 100, Math.round(190 * 0.062 * 100) / 100);
	assert.deepEqual(shareDistribution({ rows: [], states: [CLAUDE], cfg: CFG })[`${ACCOUNT}:claude:7d`], { p95Percent: null, days: 0 });
});
