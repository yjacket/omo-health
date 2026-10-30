export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Injectable clock. Production uses Date.now; tests and replays pass `now`. */
export function createClock(options = {}) {
	if (typeof options.now === "function") return { now: options.now };
	return { now: () => Date.now() };
}

/** Mutable fake clock for tests and replay. */
export function createFakeClock(startMs) {
	let current = startMs;
	return {
		now: () => current,
		set(ms) {
			current = ms;
		},
		advance(ms) {
			current += ms;
			return current;
		},
	};
}

export function iso(ms) {
	return new Date(ms).toISOString();
}

export function toMs(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** "2026-09-24 04:29:05 KST" */
export function kst(ms) {
	const shifted = new Date(ms + 9 * HOUR).toISOString();
	return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} KST`;
}

export function formatDuration(ms) {
	if (!Number.isFinite(ms)) return "?";
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) return `${h}시간 ${m}분`;
	if (m) return `${m}분${s ? ` ${s}초` : ""}`;
	return `${s}초`;
}
