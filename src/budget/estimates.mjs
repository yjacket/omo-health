// Reference class and estimate adjustment (C-estimates). Pure: no clock, no io.
// Closed project records carry the persisted shape from C-store's data JSON:
// { id, status, data: { workClass, outcome, estimates: [...] } }, plus the final
// actual in USD as `actualUsd` on the record or under `data`.

const MIN_PROJECTS = 5;
const RATIO_MIN = 0.5;
const RATIO_MAX = 3;

function dataOf(project) {
	return project && typeof project.data === "object" && project.data !== null ? project.data : {};
}

function actualOf(project) {
	if (Number.isFinite(project?.actualUsd)) return project.actualUsd;
	const data = dataOf(project);
	return Number.isFinite(data.actualUsd) ? data.actualUsd : null;
}

function workClassOf(project) {
	if (typeof project?.workClass === "string") return project.workClass;
	const data = dataOf(project);
	return typeof data.workClass === "string" ? data.workClass : null;
}

// First estimate block of a project, regardless of whether later changes raised the budget.
function firstEstimateOf(project) {
	const list = Array.isArray(dataOf(project).estimates) ? dataOf(project).estimates : [];
	return list.find((entry) => entry && (entry.kind === undefined || entry.kind === "estimate")) ?? null;
}

function remainingP50(estimate) {
	if (Number.isFinite(estimate?.p50)) return estimate.p50;
	if (Number.isFinite(estimate?.remainingUsd?.p50)) return estimate.remainingUsd.p50;
	if (Number.isFinite(estimate?.raw?.remainingUsd?.p50)) return estimate.raw.remainingUsd.p50;
	if (Number.isFinite(estimate?.raw?.p50)) return estimate.raw.p50;
	return null;
}

function spentAtEstimateOf(estimate) {
	if (Number.isFinite(estimate?.spentAtEstimate)) return estimate.spentAtEstimate;
	if (Number.isFinite(estimate?.raw?.spentAtEstimate)) return estimate.raw.spentAtEstimate;
	return null;
}

// Linear-interpolated percentile over an ascending numeric array (0 <= p <= 1).
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const index = (sorted.length - 1) * p;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampRatio(value) {
	return Math.min(RATIO_MAX, Math.max(RATIO_MIN, value));
}

// The most recent audit opinion of a project, or null while no audit has produced one.
function lastOpinionOf(project) {
	const audits = dataOf(project).audits;
	if (!Array.isArray(audits)) return null;
	for (let index = audits.length - 1; index >= 0; index -= 1) {
		const opinion = audits[index]?.opinion;
		if (opinion && typeof opinion === "object") return opinion;
	}
	return null;
}

// An audit does not approve or deny anything; it only keeps a project whose latest opinion is
// "waste-likely" out of the calibration sample. Missing audits and other assessments stay in.
function wasteLikely(project) {
	return lastOpinionOf(project)?.assessment === "waste-likely";
}

// Actual USD of every closed project with actual > 0, narrowed to the requested workClass
// only once that class alone has MIN_PROJECTS observations; cancelled projects count.
export function referenceClass(closed = [], { workClass } = {}) {
	const withActual = (Array.isArray(closed) ? closed : [])
		.filter((project) => !wasteLikely(project))
		.map((project) => ({ project, actualUsd: actualOf(project) }))
		.filter((entry) => Number.isFinite(entry.actualUsd) && entry.actualUsd > 0);
	const sameClass = workClass
		? withActual.filter((entry) => workClassOf(entry.project) === workClass)
		: [];
	const selected = sameClass.length >= MIN_PROJECTS ? sameClass : withActual;
	const actuals = selected.map((entry) => entry.actualUsd).sort((a, b) => a - b);
	const n = selected.length;
	const ratios = [];
	for (const entry of selected) {
		const estimate = firstEstimateOf(entry.project);
		const p50 = remainingP50(estimate);
		const spentAtEstimate = spentAtEstimateOf(estimate);
		if (p50 === null || spentAtEstimate === null) continue;
		const expected = spentAtEstimate + p50;
		if (!(expected > 0)) continue;
		ratios.push(entry.actualUsd / expected);
	}
	const errorRatio = ratios.length >= MIN_PROJECTS ? clampRatio(median(ratios)) : null;
	return {
		n,
		p50: percentile(actuals, 0.5),
		p80: percentile(actuals, 0.8),
		p90: percentile(actuals, 0.9),
		errorRatio,
		calibrated: n >= MIN_PROJECTS,
	};
}

// Scale an estimate's remaining-work p50/p90 by the historical error ratio, on top of what
// the project already spent.
export function adjust(estimate, ref, spentUsd) {
	const ratio = Number.isFinite(ref?.errorRatio) ? ref.errorRatio : 1;
	const p50 = Number.isFinite(estimate?.p50) ? estimate.p50 : Number(estimate?.remainingUsd?.p50) || 0;
	const p90Input = Number.isFinite(estimate?.p90) ? estimate.p90 : Number(estimate?.remainingUsd?.p90);
	const p90 = Number.isFinite(p90Input) ? p90Input : p50;
	const p80 = p50 + 0.6 * (p90 - p50);
	const n = Number.isFinite(ref?.n) ? ref.n : 0;
	const coldStart = ref?.calibrated !== true;
	const basis =
		`n=${n} reference projects; ratio ${ratio.toFixed(2)}` +
		(coldStart ? `, cold start (need ${MIN_PROJECTS})` : "");
	return {
		p50Usd: spentUsd + p50 * ratio,
		reserveUsd: spentUsd + p80 * ratio,
		ratio,
		basis,
	};
}
