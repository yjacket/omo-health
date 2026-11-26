// Session-day usage (#33, #40): one root session tree (main + every subagent, audit cost excluded) over the last 24 h.
// Pure: rows, window states and the budget config are injected.
// The tree's total cost, whatever provider or window it went to, is held to the USD pair ($100 audit, $200 owner).
// Each calibrated window also gets the tree's share (%): a row counts toward a window when its provider resolves to
// the window's account and the window applies to its model (same rule as store.spend). The percent pair is off (0)
// by default; `budget.windows` or the global percent keys turn it on. A threshold of 0 is off.
import { accountOf, windowApplies } from "./accounts.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS = { investigate: 1, owner: 2 };

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

export function windowKey(account, windowId) {
	return `${account}:${windowId}`;
}

/** The percent pair one window is held to: its `budget.windows` override, else the defaults. */
export function windowThresholds(cfg, account, windowId) {
	const budget = cfg ?? {};
	const override = budget.windows?.[windowKey(account, windowId)] ?? {};
	const pick = (key, fallback) => (finite(override[key]) ? override[key] : finite(budget[key]) ? budget[key] : fallback);
	return {
		investigatePercent: pick("sessionDayInvestigatePercent", 0),
		ownerPercent: pick("sessionDayPercent", 0),
		overridden: finite(override.sessionDayInvestigatePercent) || finite(override.sessionDayPercent),
	};
}

function levelOf(value, investigate, owner) {
	if (owner > 0 && value >= owner) return "owner";
	if (investigate > 0 && value >= investigate) return "investigate";
	return null;
}

/** Windows a share can be computed for: calibrated, with a percent-per-dollar coefficient. */
function countingWindows(states, cfg) {
	return (Array.isArray(states) ? states : [])
		.filter((s) => s && s.calibrated === true && finite(s.percentPerUsd) && s.account && s.windowId)
		.map((s) => ({ account: s.account, windowId: s.windowId, label: s.label ?? s.windowId, window: { id: s.windowId, scope: s.scope ?? null }, percentPerUsd: s.percentPerUsd, ...windowThresholds(cfg, s.account, s.windowId) }));
}

function costOf(row) {
	return row && finite(row.cost) && row.source !== "audit" ? row.cost : null;
}

/**
 * @param {{rows: {rootSessionId: string, source: string, provider: string|null, model: string|null, cost: number|null}[],
 *   states: object[], cfg: object}} input rows already limited to the last 24 h
 * @returns {{investigateUsd: number, ownerUsd: number, sessions: object[]}} sessions sorted by level, then share
 */
export function sessionDay({ rows, states, cfg } = {}) {
	const budget = cfg ?? {};
	const aliases = budget.providerAliases;
	const investigateUsd = finite(budget.sessionDayInvestigateUsd) ? budget.sessionDayInvestigateUsd : 100;
	const ownerUsd = finite(budget.sessionDayUsd) ? budget.sessionDayUsd : 200;
	const windows = countingWindows(states, budget);
	const trees = new Map();
	for (const row of Array.isArray(rows) ? rows : []) {
		const cost = costOf(row);
		if (cost === null || !row.rootSessionId) continue;
		let tree = trees.get(row.rootSessionId);
		if (!tree) {
			tree = { sessionId: row.rootSessionId, totalUsd: 0, mainUsd: 0, childUsd: 0, byWindow: windows.map(() => 0) };
			trees.set(row.rootSessionId, tree);
		}
		tree.totalUsd += cost;
		if (row.source === "main") tree.mainUsd += cost;
		else tree.childUsd += cost;
		const account = accountOf(row.provider, aliases);
		windows.forEach((w, i) => {
			if (account === w.account && windowApplies(w.window, row.model)) tree.byWindow[i] += cost;
		});
	}
	const sessions = [...trees.values()].map((tree) => {
		const shares = windows.map((w, i) => ({
			account: w.account,
			windowId: w.windowId,
			label: w.label,
			usd: tree.byWindow[i],
			percent: tree.byWindow[i] * w.percentPerUsd,
			investigatePercent: w.investigatePercent,
			ownerPercent: w.ownerPercent,
			level: levelOf(tree.byWindow[i] * w.percentPerUsd, w.investigatePercent, w.ownerPercent),
		}));
		const usdLevel = levelOf(tree.totalUsd, investigateUsd, ownerUsd);
		// The basis is what crossed the highest level; among windows the largest share wins.
		const candidates = [
			...shares.filter((s) => s.level).map((s) => ({ level: s.level, rank: s.percent / (s.level === "owner" ? s.ownerPercent : s.investigatePercent), basis: { kind: "window", account: s.account, windowId: s.windowId, label: s.label, percent: s.percent, usd: s.usd, thresholdPercent: s.level === "owner" ? s.ownerPercent : s.investigatePercent } })),
			...(usdLevel ? [{ level: usdLevel, rank: tree.totalUsd / (usdLevel === "owner" ? ownerUsd : investigateUsd), basis: { kind: "usd", usd: tree.totalUsd, thresholdUsd: usdLevel === "owner" ? ownerUsd : investigateUsd } }] : []),
		].sort((a, b) => LEVELS[b.level] - LEVELS[a.level] || b.rank - a.rank);
		const top = candidates[0] ?? null;
		const maxShare = shares.reduce((best, s) => (best === null || s.percent > best.percent ? s : best), null);
		return {
			sessionId: tree.sessionId,
			totalUsd: tree.totalUsd,
			mainUsd: tree.mainUsd,
			childUsd: tree.childUsd,
			shares,
			maxPercent: maxShare?.percent ?? null,
			level: top?.level ?? null,
			basis: top?.basis ?? null,
		};
	});
	sessions.sort((a, b) => (LEVELS[b.level] ?? 0) - (LEVELS[a.level] ?? 0) || (b.maxPercent ?? 0) - (a.maxPercent ?? 0) || b.totalUsd - a.totalUsd);
	return { investigateUsd, ownerUsd, sessions };
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(values, p) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * Per calibrated window, the 95th percentile of one root session tree's share of that window per UTC day, over the
 * rows given (rows carry `ms`). `days` counts the session-days with a non-zero share. Uncalibrated windows are absent.
 */
export function shareDistribution({ rows, states, cfg } = {}) {
	const budget = cfg ?? {};
	const windows = countingWindows(states, budget);
	const perWindow = windows.map(() => new Map());
	for (const row of Array.isArray(rows) ? rows : []) {
		const cost = costOf(row);
		if (cost === null || !row.rootSessionId || !finite(row.ms)) continue;
		const account = accountOf(row.provider, budget.providerAliases);
		const day = Math.floor(row.ms / DAY_MS);
		windows.forEach((w, i) => {
			if (account !== w.account || !windowApplies(w.window, row.model)) return;
			const key = `${row.rootSessionId}|${day}`;
			perWindow[i].set(key, (perWindow[i].get(key) ?? 0) + cost);
		});
	}
	const out = {};
	windows.forEach((w, i) => {
		const shares = [...perWindow[i].values()].filter((usd) => usd > 0).map((usd) => usd * w.percentPerUsd);
		out[windowKey(w.account, w.windowId)] = { p95Percent: shares.length ? percentile(shares, 0.95) : null, days: shares.length };
	});
	return out;
}
