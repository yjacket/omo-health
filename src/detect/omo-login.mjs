import { makeFinding } from "./finding.mjs";

/**
 * D25 omo login aging (issue #5, GAP-2 / IS-1).
 *
 * omo's anthropic-subscription refresh tokens lived 18-29 days in the field; once one expires every session stops.
 * The secret readers report only when a slot was last seen to log in (`loginMs`) and how that fact was obtained
 * (`basis`), never the token itself.
 */
export const id = "D25";

const PROVIDER = "anthropic-subscription";
const DAY_MS = 86_400_000;

/** Detail sentence for the newest working slot. */
function detailFor(basis, days) {
	if (basis === "first-seen") {
		return `omo(${PROVIDER}) 로그인을 처음 확인한 지 ${days}일이 지났습니다. 로그인은 18~29일 뒤 만료되고, 그러면 모든 세션이 멈춥니다. /login으로 다시 로그인하세요.`;
	}
	return `omo(${PROVIDER})에 로그인한 지 ${days}일이 지났습니다. 로그인은 18~29일 뒤 만료되고, 그러면 모든 세션이 멈춥니다. /login으로 다시 로그인하세요.`;
}

export function detect(world) {
	const slots = world.secrets?.omoLogin?.slots;
	if (!Array.isArray(slots)) return [];
	const warnAfterMs = world.config.omoLogin?.warnAfterMs;
	if (!(warnAfterMs > 0)) return [];
	const usable = slots.filter((slot) => Number.isFinite(slot?.loginMs) && slot.blockReason !== "auth_error");
	if (usable.length === 0) return [];
	// Newest login decides; equal logins keep the first by name.
	let newest = usable[0];
	for (const slot of usable) {
		const tie = slot.loginMs === newest.loginMs && String(slot.name ?? "") < String(newest.name ?? "");
		if (slot.loginMs > newest.loginMs || tie) newest = slot;
	}
	const ageMs = world.now - newest.loginMs;
	if (ageMs < warnAfterMs) return [];
	const days = Math.floor(ageMs / DAY_MS);
	return [
		makeFinding({
			detector: id,
			kind: "omo-login-aging",
			severity: "warn",
			humanNeeded: true,
			subject: { key: "omo-login:anthropic-subscription" },
			evidence: [`ageDays:${days}`, `basis:${newest.basis}`, `slots:${usable.length}`],
			titleKo: "omo 다시 로그인 권장",
			detailKo: detailFor(newest.basis, days),
			data: { provider: PROVIDER, slot: newest.name, loginMs: newest.loginMs, basis: newest.basis, ageMs, warnAfterMs },
		}),
	];
}
