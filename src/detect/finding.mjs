import { sha1 } from "../util/text.mjs";

/**
 * Detector contract (plan todo 5).
 *
 * A detector module exports:
 *   export const id = "D4";                       // detector id
 *   export function detect(world, memory) {...}   // -> Finding[]
 *
 * `world` is the immutable per-tick snapshot built by src/state.mjs.
 * `memory` is a plain object owned by that detector that persists across
 * ticks (use it for "only once per incident" bookkeeping). Detectors never
 * mutate `world`, never touch the filesystem and never act.
 *
 * Finding fields:
 *   fp          stable fingerprint (same incident -> same fp across ticks)
 *   detector    "D1".."D14"
 *   kind        detector-specific kind, e.g. "cache-storm"
 *   severity    "info" | "warn" | "crit"
 *   humanNeeded true only when a person must act (drives Windows toasts)
 *   subject     { sessionId?, taskId?, parentSessionId?, rootSessionId?, hostPid?, toolCallId?, pids?, key? }
 *   cls         optional classification (stall class etc.)
 *   evidence    short machine-readable strings ("ports:18080->60496")
 *   titleKo     one-line Korean title (footer / report heading)
 *   detailKo    Korean explanation for the incident report
 *   data        detector-specific data; `data.remedy` (optional) requests an
 *               automatic action: { kind: "wake-parent"|"nudge"|"abort-continue"|"revert-settings", ... }
 */
export function makeFinding({ detector, kind, severity = "warn", humanNeeded = false, subject = {}, cls, evidence = [], titleKo, detailKo, data = {} }) {
	const subjectKey = [
		subject.key,
		subject.sessionId,
		subject.taskId,
		subject.toolCallId,
		...(subject.pids ?? []).map((p) => `${p.pid}@${p.ctime}`),
	]
		.filter((part) => part !== undefined && part !== null && part !== "")
		.join("|");
	const fp = sha1(`${detector}|${kind}|${subjectKey}|${cls ?? ""}`).slice(0, 16);
	return { fp, detector, kind, severity, humanNeeded, subject, cls, evidence, titleKo, detailKo, data };
}

export const SEVERITY_RANK = { info: 0, warn: 1, crit: 2 };

/** History-scanning detectors only report evidence newer than this (old history is not news). */
export const RECENT_EVIDENCE_MS = 60 * 60_000;

export function maxSeverity(a, b) {
	return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b;
}
