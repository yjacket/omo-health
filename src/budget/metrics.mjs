// Audit indicators and triggers (C-metrics). Pure: no clock, no io.
// Persisted shapes come from C-store: project.data.estimates / approvals / audits,
// rounds are [{round, firstMs}] (ascending by round, durable across todo closures).

const DAY = 24 * 60 * 60 * 1000;
const INFLIGHT = new Set(["started", "running", "pending"]);

function dataOf(project) {
	return project && typeof project.data === "object" && project.data !== null ? project.data : {};
}

function num(value) {
	return Number.isFinite(value) ? value : 0;
}

function listOf(value) {
	return Array.isArray(value) ? value : [];
}

// spendSince(ms) may return USD or a C-store spend object; both are accepted.
function usdOf(value) {
	if (Number.isFinite(value)) return value;
	if (value && typeof value === "object") return num(value.costUsd);
	return 0;
}

function latestApproval(project) {
	const approvals = listOf(dataOf(project).approvals);
	return approvals.length > 0 ? approvals[approvals.length - 1] : null;
}

// The estimate fixed at estimation time; changes append, so the last adjusted entry wins.
function latestAdjusted(project) {
	const estimates = listOf(dataOf(project).estimates);
	for (let i = estimates.length - 1; i >= 0; i -= 1) {
		const adjusted = estimates[i] && estimates[i].adjusted;
		if (adjusted && typeof adjusted === "object") return adjusted;
	}
	return null;
}

export function indicators({ project, rounds = [], spend = {}, spendSince, criteria, now } = {}) {
	const seen = listOf(rounds).filter((entry) => entry && Number.isFinite(entry.firstMs));
	const roundsCount = seen.length;
	const firstRoundMs = roundsCount > 0 ? Math.min(...seen.map((entry) => entry.firstMs)) : null;
	const since = typeof spendSince === "function" ? spendSince : () => 0;

	const spentUsd = num(spend.costUsd);
	const childUsd = num(spend.childUsd);
	const childShare = spentUsd > 0 ? childUsd / spentUsd : 0;

	const approval = latestApproval(project);
	const approvedUsd = approval ? num(approval.approvedUsd) : 0;
	const budgetRatio = approvedUsd > 0 ? spentUsd / approvedUsd : null;

	const adjusted = latestAdjusted(project);
	const forecastUsd = adjusted ? Math.max(spentUsd, num(adjusted.p50Usd)) : null;
	const forecastOverPercent =
		forecastUsd !== null && approvedUsd > 0 ? ((forecastUsd - approvedUsd) / approvedUsd) * 100 : null;

	return {
		roundsCount,
		firstRoundMs,
		roundsCostUsd: firstRoundMs === null ? 0 : usdOf(since(firstRoundMs)),
		childUsd,
		childShare,
		approvedUsd,
		spentUsd,
		budgetRatio,
		forecastUsd,
		forecastOverPercent,
		afterAcceptUsd: Number.isFinite(criteria?.allEvidencedMs) ? usdOf(since(criteria.allEvidencedMs)) : null,
	};
}

function limitsOf(cfg = {}) {
	const audit = cfg && typeof cfg.audit === "object" && cfg.audit !== null ? cfg.audit : cfg || {};
	const checkpointPercent = Number.isFinite(cfg?.checkpointPercent) ? cfg.checkpointPercent : 80;
	return { ...audit, checkpointPercent };
}

export function triggers(ind, cfg, { child24hUsd = 0 } = {}) {
	const a = limitsOf(cfg);
	const out = [];
	const roundsCount = num(ind?.roundsCount);
	const roundsCostUsd = num(ind?.roundsCostUsd);

	if (Number.isFinite(a.roundsRecord) && roundsCount >= a.roundsRecord) {
		const heavy =
			(Number.isFinite(a.roundsAudit) && roundsCount >= a.roundsAudit && roundsCostUsd >= num(a.roundsCostUsd)) ||
			(Number.isFinite(a.roundsHard) && roundsCount >= a.roundsHard);
		out.push({
			kind: "rounds",
			heavy,
			detail: `${roundsCount} numbered rounds, $${roundsCostUsd.toFixed(2)} since round 1`,
		});
	}

	const budgetRatio = ind?.budgetRatio;
	if (Number.isFinite(budgetRatio) && budgetRatio >= a.checkpointPercent / 100) {
		const over = ind?.forecastOverPercent;
		out.push({
			kind: "budget",
			heavy: Number.isFinite(over) && over >= num(a.overForecastPercent),
			detail: `${(budgetRatio * 100).toFixed(1)}% of approved, forecast $${num(ind?.forecastUsd).toFixed(2)}`,
		});
	}

	const afterAcceptUsd = ind?.afterAcceptUsd;
	if (Number.isFinite(afterAcceptUsd) && afterAcceptUsd >= num(a.afterAcceptUsd)) {
		out.push({
			kind: "after-accept",
			heavy: true,
			detail: `$${afterAcceptUsd.toFixed(2)} spent after all acceptance criteria were evidenced`,
		});
	}

	const threshold = Math.max(num(a.descendantUsd), num(a.descendantFraction) * num(ind?.approvedUsd));
	if (num(child24hUsd) >= threshold) {
		out.push({
			kind: "descendants",
			heavy: true,
			detail: `$${num(child24hUsd).toFixed(2)} of subagent spend in the last 24 h (threshold $${threshold.toFixed(2)})`,
		});
	}

	return out;
}

// IS-9 caps: one audit in flight per project, perProjectDay per rolling day, perDay
// across all projects, minGapMs unless new evidence arrived.
export function auditAllowed({ project, history = [], now, cfg, newEvidence = false } = {}) {
	const a = limitsOf(cfg);
	const entries = listOf(history).filter((entry) => entry && Number.isFinite(entry.ms));
	const projectId = project?.id;
	const scoped = entries.some((entry) => typeof entry.projectId === "string");
	const mine = scoped ? entries.filter((entry) => entry.projectId === projectId) : entries;

	if (mine.some((entry) => INFLIGHT.has(entry.status))) {
		return { allowed: false, reason: "in-flight" };
	}

	if (Number.isFinite(now) && Number.isFinite(a.perProjectDay)) {
		const since = now - DAY;
		const projectToday = mine.filter((entry) => entry.ms >= since && entry.ms <= now).length;
		if (projectToday >= a.perProjectDay) return { allowed: false, reason: "project-day-cap" };

		if (Number.isFinite(a.perDay)) {
			const allToday = entries.filter((entry) => entry.ms >= since && entry.ms <= now).length;
			if (allToday >= a.perDay) return { allowed: false, reason: "day-cap" };
		}

		if (Number.isFinite(a.minGapMs) && !newEvidence) {
			const lastMs = mine.reduce((max, entry) => Math.max(max, entry.ms), -Infinity);
			if (Number.isFinite(lastMs) && now - lastMs < a.minGapMs) return { allowed: false, reason: "min-gap" };
		}
	}

	return { allowed: true, reason: null };
}
