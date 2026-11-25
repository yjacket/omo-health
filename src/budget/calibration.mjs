// Quota calibration math (C-calibration). Pure: samples and spend lookups are injected.

const HOUR = 60 * 60 * 1000;

const DEFAULT_CFG = Object.freeze({
	minIntervalPercent: 2,
	minIntervals: 10,
	minCoveragePercent: 20,
	maxGapMs: 2 * HOUR,
	earlyDropPercent: 5,
});

// cfg may be calibration.budget.calibration itself or a parent object holding it.
function normalizeCfg(cfg) {
	const source = cfg && typeof cfg.calibration === "object" && cfg.calibration !== null ? cfg.calibration : cfg;
	const out = { ...DEFAULT_CFG };
	if (source && typeof source === "object") {
		for (const key of Object.keys(DEFAULT_CFG)) {
			if (Number.isFinite(source[key])) out[key] = source[key];
		}
	}
	return out;
}

function sortedSamples(samples) {
	return [...(samples ?? [])]
		.filter((sample) => Number.isFinite(sample?.updatedMs) && Number.isFinite(sample?.usedPercent))
		.sort((a, b) => a.updatedMs - b.updatedMs);
}

function makeEpoch(sample) {
	return {
		startMs: sample.updatedMs,
		endMs: sample.updatedMs,
		resetsAtMs: Number.isFinite(sample.resetsAtMs) ? sample.resetsAtMs : null,
		samples: [sample],
		endedBy: null,
	};
}

// Split samples into quota epochs: a scheduled reset (resetsAtMs moves > 1 h) or an early drop
// of usedPercent >= earlyDropPercent ends the current epoch.
export function epochs(samples = [], options = {}) {
	const earlyDropPercent = Number.isFinite(options?.earlyDropPercent) ? options.earlyDropPercent : DEFAULT_CFG.earlyDropPercent;
	const out = [];
	let current = null;
	for (const sample of sortedSamples(samples)) {
		if (!current) {
			current = makeEpoch(sample);
			out.push(current);
			continue;
		}
		const last = current.samples[current.samples.length - 1];
		const drop = last.usedPercent - sample.usedPercent;
		const resetsMoved =
			Number.isFinite(last.resetsAtMs) &&
			Number.isFinite(sample.resetsAtMs) &&
			Math.abs(sample.resetsAtMs - last.resetsAtMs) > HOUR;
		if (resetsMoved || drop >= earlyDropPercent) {
			current.endedBy = resetsMoved ? "scheduled" : "early";
			current = makeEpoch(sample);
			out.push(current);
			continue;
		}
		current.samples.push(sample);
		current.endMs = sample.updatedMs;
	}
	return out;
}

function weightedPercentile(sorted, totalWeight, p) {
	const target = totalWeight * p;
	let cumulative = 0;
	for (const interval of sorted) {
		cumulative += interval.deltaPercent;
		if (cumulative >= target) return interval.ratio;
	}
	return sorted[sorted.length - 1].ratio;
}

// Walk epochs, close a ratio interval when usedPercent rose by >= minIntervalPercent; discard
// intervals longer than maxGapMs or cheaper than $0.01. Returns the delta-weighted median and the
// weighted 20th/80th percentiles of percent-per-dollar.
export function calibrate({ samples = [], spendBetween, cfg = {} } = {}) {
	const settings = normalizeCfg(cfg);
	const intervals = [];
	for (const epoch of epochs(samples, { earlyDropPercent: settings.earlyDropPercent })) {
		let previous = epoch.samples[0];
		for (let i = 1; i < epoch.samples.length; i += 1) {
			const sample = epoch.samples[i];
			const gapMs = sample.updatedMs - previous.updatedMs;
			if (gapMs > settings.maxGapMs) {
				previous = sample;
				continue;
			}
			const deltaPercent = sample.usedPercent - previous.usedPercent;
			if (deltaPercent < settings.minIntervalPercent) continue;
			const spendUsd = Number(spendBetween?.(previous.updatedMs, sample.updatedMs));
			if (!Number.isFinite(spendUsd) || spendUsd < 0.01) {
				previous = sample;
				continue;
			}
			intervals.push({
				fromMs: previous.updatedMs,
				toMs: sample.updatedMs,
				deltaPercent,
				spendUsd,
				ratio: deltaPercent / spendUsd,
			});
			previous = sample;
		}
	}
	if (intervals.length === 0) {
		return { percentPerUsd: null, low: null, high: null, intervals: 0, coveragePercent: null, calibrated: false };
	}
	const epochSpans = epochs(samples, { earlyDropPercent: settings.earlyDropPercent });
	const totalSpanMs = epochSpans.reduce((sum, epoch) => sum + (epoch.endMs - epoch.startMs), 0);
	const coveredMs = intervals.reduce((sum, interval) => sum + (interval.toMs - interval.fromMs), 0);
	const coveragePercent = totalSpanMs > 0 ? Math.min(100, (coveredMs / totalSpanMs) * 100) : 0;
	const sorted = [...intervals].sort((a, b) => a.ratio - b.ratio);
	const totalWeight = intervals.reduce((sum, interval) => sum + interval.deltaPercent, 0);
	return {
		percentPerUsd: weightedPercentile(sorted, totalWeight, 0.5),
		low: weightedPercentile(sorted, totalWeight, 0.2),
		high: weightedPercentile(sorted, totalWeight, 0.8),
		intervals: intervals.length,
		coveragePercent,
		calibrated: intervals.length >= settings.minIntervals && coveragePercent >= settings.minCoveragePercent,
	};
}

// Unattributed use: observed percent movement minus the calibrated spend explanation.
export function externalPercent({ samples = [], spendBetween, coefficient, sinceMs } = {}) {
	if (!Number.isFinite(coefficient)) return null;
	let within = sortedSamples(samples);
	if (Number.isFinite(sinceMs)) within = within.filter((sample) => sample.updatedMs >= sinceMs);
	if (within.length < 2) return null;
	const fromMs = within[0].updatedMs;
	const toMs = within[within.length - 1].updatedMs;
	const spendUsd = Number(spendBetween?.(fromMs, toMs));
	if (!Number.isFinite(spendUsd)) return null;
	return within[within.length - 1].usedPercent - within[0].usedPercent - coefficient * spendUsd;
}
