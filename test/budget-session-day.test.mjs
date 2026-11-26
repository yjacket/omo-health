import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionDay, shareDistribution, windowThresholds } from "../src/budget/session-day.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const CFG = DEFAULT_CONFIG.budget;
const ACCOUNT = "anthropic-subscription/default";
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
// 0.062 %/$: the issue's own calibration (Claude 7-day window), so $162 is about 10% of the window.
const CLAUDE = Object.freeze({ account: ACCOUNT, windowId: "claude:7d", label: "Claude 주간", scope: null, calibrated: true, percentPerUsd: 0.062 });
const FABLE = Object.freeze({ account: ACCOUNT, windowId: "claude:7d_fable", label: "Fable 주간", scope: "fable", calibrated: true, percentPerUsd: 0.5 });

const row = (rootSessionId, cost, extra = {}) => ({ ms: T0, rootSessionId, source: "main", provider: "anthropic-subscription", model: "claude-opus-5-5", cost, ...extra });
const byId = (result) => new Map(result.sessions.map((s) => [s.sessionId, s]));

test("a root session tree (main + subagents) is held to the calibrated window's percent pair; audit cost is not the session's", () => {
	const rows = [
		row("a", 100),
		row("a", 70, { source: "child" }),
		row("a", 500, { source: "audit" }),
		row("b", 90),
		row("c", 50),
	];
	const result = sessionDay({ rows, states: [CLAUDE], cfg: CFG });
	const s = byId(result);
	assert.deepEqual([s.get("a").totalUsd, s.get("a").mainUsd, s.get("a").childUsd], [170, 100, 70]);
	assert.equal(Math.round(s.get("a").maxPercent * 10) / 10, 10.5);
	assert.equal(s.get("a").level, "owner");
	assert.deepEqual(s.get("a").basis, { kind: "window", account: ACCOUNT, windowId: "claude:7d", label: "Claude 주간", percent: 170 * 0.062, usd: 170, thresholdPercent: 10 });
	assert.equal(s.get("b").level, "investigate", "$90 = 5.6% is past the 5% investigate line");
	assert.equal(s.get("c").level, null, "$50 = 3.1% raises nothing");
	assert.deepEqual(result.sessions.map((x) => x.sessionId), ["a", "b", "c"], "sorted by level, then share");
});

test("an uncalibrated window applies no percent: its cost is held to the USD pair instead", () => {
	const rows = [row("a", 170), row("b", 90), row("c", 79)];
	const result = sessionDay({ rows, states: [{ ...CLAUDE, calibrated: false }], cfg: CFG });
	const s = byId(result);
	assert.deepEqual(s.get("a").shares, []);
	assert.equal(s.get("a").uncountedUsd, 170);
	assert.deepEqual([s.get("a").level, s.get("a").basis], ["owner", { kind: "usd", usd: 170, thresholdUsd: 160 }]);
	assert.deepEqual([s.get("b").level, s.get("b").basis.thresholdUsd], ["investigate", 80]);
	assert.equal(s.get("c").level, null);
	assert.deepEqual([result.investigateUsd, result.ownerUsd], [80, 160]);
});

test("cost no window counts (an unmapped provider) adds up in USD beside a calibrated window's share", () => {
	const rows = [row("a", 60), row("a", 100, { provider: "openai-codex", model: "gpt-6.2" })];
	const s = byId(sessionDay({ rows, states: [CLAUDE], cfg: CFG })).get("a");
	assert.equal(s.shares[0].usd, 60);
	assert.equal(s.shares[0].level, null, "$60 = 3.7% of the window");
	assert.equal(s.uncountedUsd, 100);
	assert.deepEqual([s.level, s.basis.kind], ["investigate", "usd"]);
	const aliased = byId(sessionDay({ rows: [row("a", 100, { provider: "claude-sdk-oauth" })], states: [CLAUDE], cfg: CFG })).get("a");
	assert.equal(aliased.shares[0].usd, 100, "budget.providerAliases connects a proxy provider to the account");
});

test("a scoped window counts only the models it applies to", () => {
	const rows = [row("a", 20, { model: "claude-fable-5-2" }), row("a", 100)];
	const s = byId(sessionDay({ rows, states: [CLAUDE, FABLE], cfg: CFG })).get("a");
	assert.deepEqual(s.shares.map((x) => [x.windowId, x.usd]), [["claude:7d", 120], ["claude:7d_fable", 20]]);
	assert.equal(s.level, "owner", "fable: $20 x 0.5 = 10% of its own window");
	assert.equal(s.basis.windowId, "claude:7d_fable");
	assert.equal(s.uncountedUsd, 0);
});

test("budget.windows overrides the percent pair of one window; 0 turns a threshold off", () => {
	const key = `${ACCOUNT}:claude:7d`;
	const cfg = { ...CFG, windows: { [key]: { sessionDayPercent: 20 } } };
	assert.deepEqual(windowThresholds(cfg, ACCOUNT, "claude:7d"), { investigatePercent: 5, ownerPercent: 20, overridden: true });
	assert.deepEqual(windowThresholds(cfg, ACCOUNT, "claude:7d_fable"), { investigatePercent: 5, ownerPercent: 10, overridden: false });
	const s = byId(sessionDay({ rows: [row("a", 170)], states: [CLAUDE], cfg })).get("a");
	assert.deepEqual([s.level, s.basis.thresholdPercent], ["investigate", 5], "10.5% is under the window's own 20%");
	const off = { ...CFG, sessionDayInvestigatePercent: 0, sessionDayPercent: 0, sessionDayInvestigateUsd: 0, sessionDayUsd: 0 };
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
