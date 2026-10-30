import path from "node:path";
import { kst } from "../util/time.mjs";
import { makeFinding } from "./finding.mjs";
import { deduplicateParkRecords, readParkRecords } from "../collect/parks.mjs";

/**
 * D20 park-due: sessions with usage-limit park records ready for resuming.
 * Records are created by omo-limitless with a resetAt time.
 * When resetAt + gracePeriod has passed and status is "pending", the session is ready to resume.
 */
export const id = "D20";

const GRACE_PERIOD_MS = 60_000; // 1 minute grace period after reset time
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function detect(world, memory = {}) {
	memory.seen ??= {};

	const now = world.now;
	const recordsInput = world.parkRecords ?? (world.paths?.health?.parksDir ? readParkRecords(world.paths, { includeMalformed: true }) : []);
	const { valid, invalid, superseded } = deduplicateParkRecords(recordsInput);

	const out = [];

	// Emit finding for each invalid record, once per file
	for (const { file, name, error } of invalid) {
		const key = `invalid:${name}`;
		if (!memory.seen[key]) {
			memory.seen[key] = { atMs: now };
			out.push(
				makeFinding({
					detector: id,
					kind: "park-invalid",
					severity: "warn",
					subject: { key },
					evidence: [`file:${name}`, `error:${error}`],
					titleKo: `한도 대기 기록 오류`,
					detailKo: `파일 ${name}: ${error}. 이 기록은 건너뜁니다.`,
					data: { file, name, error },
				}),
			);
		}
	}

	// Mark superseded records with "superseded" marker in memory
	for (const entry of superseded) {
		const key = `superseded:${entry.record.parkId}`;
		if (!memory.seen[key]) {
			memory.seen[key] = { atMs: now, status: "superseded" };
		}
	}

	// Emit findings for valid, actionable records
	for (const entry of valid) {
		const { record, file } = entry;
		const { parkId, sessionId, resetAt, status, terminal } = record;
		const key = `${parkId}`;

		// Only emit park-due when:
		// 1. Status is "pending" (not yet launched)
		// 2. resetAt + grace period has passed
		if (status === "pending" && now >= resetAt + GRACE_PERIOD_MS) {
			if (!memory.seen[key] || memory.seen[key].status !== "due") {
				memory.seen[key] = { atMs: now, status: "due" };
				out.push(
					makeFinding({
						detector: id,
						kind: "park-due",
						severity: "info",
						subject: { sessionId, key },
						evidence: [`parkId:${parkId}`, `resetAt:${kst(resetAt)}`, `status:${status}`],
						titleKo: `세션 ${sessionId} 사용량 한도 리셋됨`,
						detailKo: `사용량 한도가 리셋되어 재개할 수 있습니다 (${kst(resetAt)}).`,
						data: {
							parkId,
							sessionId,
							resetAt,
							status,
							terminal,
						},
					}),
				);
			}
		}
	}

	// Prune old entries from memory (7 days)
	for (const key of Object.keys(memory.seen)) {
		if (now - memory.seen[key].atMs > KEEP_MS) {
			delete memory.seen[key];
		}
	}

	return out;
}
