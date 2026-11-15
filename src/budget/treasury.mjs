// Treasury: per-window state and a capacity check for a reserve (C-treasury). Pure: no I/O, no clock.
// The caller supplies the reading (samples), the calibration result, the committed spend and `now`.
import { windowApplies } from "./accounts.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SCOPE_RE = /^[^:]+:[^_]+_(.+)$/u;

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function sortedSamples(samples) {
	if (!Array.isArray(samples)) return [];
	return samples
		.filter((sample) => sample && finite(sample.updatedMs) && finite(sample.usedPercent))
		.slice()
		.sort((a, b) => a.updatedMs - b.updatedMs);
}

// Same epoch boundary as C-calibration: a drop of >= earlyDropPercent or a reset time that moved > 1 h.
function sameEpoch(prev, next, earlyDropPercent) {
	if (!prev) return true;
	if (finite(prev.resetsAtMs) && finite(next.resetsAtMs) && Math.abs(prev.resetsAtMs - next.resetsAtMs) > HOUR_MS) return false;
	return prev.usedPercent - next.usedPercent < earlyDropPercent;
}

function currentEpoch(samples, earlyDropPercent) {
	let start = samples.length - 1;
	while (start > 0 && sameEpoch(samples[start - 1], samples[start], earlyDropPercent)) start--;
	return samples.slice(start);
}

// (last - first usedPercent) / hours over the current epoch's samples inside the last 24 h.
// Fewer than 2 samples or a span under 1 h => null (no burn estimate).
function burnRate(samples, now, earlyDropPercent) {
	const epoch = currentEpoch(samples, earlyDropPercent).filter((sample) => sample.updatedMs >= now - DAY_MS);
	if (epoch.length < 2) return null;
	const first = epoch[0];
	const last = epoch[epoch.length - 1];
	const spanMs = last.updatedMs - first.updatedMs;
	if (spanMs < HOUR_MS) return null;
	return (last.usedPercent - first.usedPercent) / (spanMs / HOUR_MS);
}

function scopeOf(window) {
	if (!window) return null;
	if (typeof window.scope === "string" && window.scope.length > 0) return window.scope;
	const id = typeof window.id === "string" ? window.id : null;
	if (!id) return null;
	const match = SCOPE_RE.exec(id);
	return match ? match[1] : null;
}

function reserveOf(cfg) {
	const budget = cfg ?? {};
	const reserve = finite(budget.reservePercent) ? budget.reservePercent : 0;
	const audit = finite(budget.auditReservePercent) ? budget.auditReservePercent : 0;
	return reserve + audit;
}

function earlyDropOf(cfg) {
	const value = cfg?.calibration?.earlyDropPercent;
	return finite(value) ? value : 5;
}

export function windowState({ account, window, samples, calibration, committedUsd, now, cfg, stale } = {}) {
	const reservePercent = reserveOf(cfg);
	const reading = sortedSamples(samples);
	const last = reading.length > 0 ? reading[reading.length - 1] : null;
	const usedPercent = last ? last.usedPercent : null;
	const resetsAtMs = last && finite(last.resetsAtMs) ? last.resetsAtMs : null;
	const hoursLeft = resetsAtMs === null ? null : Math.max(0, (resetsAtMs - now) / HOUR_MS);

	const calibrated = calibration?.calibrated === true && finite(calibration.high);
	const percentPerUsd = finite(calibration?.percentPerUsd) ? calibration.percentPerUsd : null;
	const calibrationHigh = calibrated ? calibration.high : null;
	const committed = finite(committedUsd) ? committedUsd : 0;
	const committedPercent = calibrated ? committed * calibrationHigh : null;
	const freePercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent - reservePercent - (committedPercent ?? 0));

	const burnPerHour = burnRate(reading, now, earlyDropOf(cfg));
	const projectedAtResetPercent =
		usedPercent === null || burnPerHour === null || hoursLeft === null ? null : usedPercent + burnPerHour * hoursLeft;
	const safeDailyPercent =
		usedPercent === null || hoursLeft === null
			? null
			: Math.max(0, (100 - reservePercent - usedPercent) / Math.max(hoursLeft / 24, 1 / 24));

	// A window that is already used up reads short whatever the projection: with no burn data or a
	// reset that already passed, the projection cannot see the exhaustion on its own.
	// Stale/unknown still wins over everything (a stale 100% reading is not evidence).
	let state;
	if (stale === true || usedPercent === null) state = "unknown";
	else if (usedPercent >= 100) state = "short";
	else if (projectedAtResetPercent !== null && projectedAtResetPercent > 100) state = "short";
	else if ((projectedAtResetPercent !== null && projectedAtResetPercent > 100 - reservePercent) || freePercent < 5) state = "tight";
	else state = "ok";

	return {
		account,
		windowId: window?.id ?? null,
		label: window?.label ?? window?.id ?? null,
		scope: scopeOf(window),
		usedPercent,
		resetsAtMs,
		hoursLeft,
		reservePercent,
		committedPercent,
		freePercent,
		burnPerHour,
		projectedAtResetPercent,
		safeDailyPercent,
		state,
		stale: stale === true,
		calibrated,
		percentPerUsd,
		// Extension of the C-treasury shape: the high calibration bound capacityCheck multiplies by.
		calibrationHigh,
	};
}

// ok < tight < short; unknown only when every window is unknown (an all-unknown treasury is not "ok").
const SEVERITY = { ok: 0, tight: 1, short: 2 };

export function summarize(states) {
	const list = Array.isArray(states) ? states : [];
	const known = list.filter((state) => state && state.state && state.state !== "unknown");
	let state;
	if (known.length === 0) state = "unknown";
	else state = known.reduce((worst, item) => (SEVERITY[item.state] > SEVERITY[worst] ? item.state : worst), "ok");
	return { state, windows: list };
}

function shareFor(state, byModel) {
	const entries = Object.entries(byModel ?? {}).filter(([, usd]) => finite(usd));
	const total = entries.reduce((sum, [, usd]) => sum + usd, 0);
	if (total <= 0) return { share: 0, applicable: true, total };
	const window = { id: state.windowId, scope: state.scope };
	const matching = entries.reduce((sum, [model, usd]) => (windowApplies(window, model) ? sum + usd : sum), 0);
	return { share: matching / total, applicable: matching > 0, total };
}

export function capacityCheck({ states, reserveUsd, byModel, cfg } = {}) {
	const budget = cfg ?? {};
	const reservePercent = reserveOf(cfg);
	const usablePercent = 100 - reservePercent;
	const cycleLimit = (finite(budget.autoApproveCyclePercent) ? budget.autoApproveCyclePercent : 0) / 100 * usablePercent;
	const freeLimitPercent = finite(budget.autoApproveFreePercent) ? budget.autoApproveFreePercent : 0;
	const ownerLimit = (finite(budget.ownerProjectPercent) ? budget.ownerProjectPercent : 0) / 100 * usablePercent;
	const reserve = finite(reserveUsd) ? reserveUsd : 0;

	const list = Array.isArray(states) ? states : [];
	let fits = true;
	let large = false;
	const perWindow = [];
	for (const state of list) {
		const { share, applicable } = shareFor(state, byModel);
		const high = finite(state.calibrationHigh) ? state.calibrationHigh : null;
		const requiredPercent = high === null ? null : reserve * share * high;
		const freePercent = finite(state.freePercent) ? state.freePercent : null;
		if (requiredPercent !== null) {
			const withinCycle = requiredPercent <= cycleLimit;
			const withinFree = freePercent !== null && requiredPercent <= (freeLimitPercent / 100) * freePercent;
			if (!withinCycle || !withinFree) fits = false;
			if (requiredPercent > ownerLimit) large = true;
			if (freePercent === null || requiredPercent > freePercent) large = true;
		}
		if (applicable && state.state === "short") large = true;
		perWindow.push({ windowId: state.windowId, requiredPercent, freePercent, usablePercent });
	}
	return { fits, large, perWindow };
}
