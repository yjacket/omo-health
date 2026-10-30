/**
 * Wake sources (senpi's per-source live counts, mirrored into the sensor heartbeat's `wakeSources`) that are not work:
 * a question or a desk board waiting on the human, and the loop guard's hard stop. User idleness is never a reason to wake
 * or to call a wait stuck, so these never count as live work.
 */
export const NON_WORK_WAKE_SOURCES = Object.freeze(new Set(["ask-user", "omo-desk", "omo-inbox", "loop-guard-hard-stop"]));

/** The live work sources of a heartbeat's `wakeSources`: `[name, count]` with a finite count > 0, non-work sources left out. */
export function workWakeSources(wakeSources) {
	if (!wakeSources || typeof wakeSources !== "object") return [];
	return Object.entries(wakeSources).filter(([name, count]) => !NON_WORK_WAKE_SOURCES.has(name) && Number.isFinite(count) && count > 0);
}

/** The summed count of live work sources (0 when there are none). */
export function workWakeCount(wakeSources) {
	return workWakeSources(wakeSources).reduce((sum, [, count]) => sum + count, 0);
}
