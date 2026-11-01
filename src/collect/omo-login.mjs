import { atomicWriteJson, readJsonSafe } from "../util/fsx.mjs";
import { readAuthSlots } from "./secrets.mjs";

/** senpi starts renewing a token 5 minutes before it expires (auth-lane.js:19,82-84). */
export const REFRESH_LEAD_MS = 5 * 60_000;

/**
 * Record a login when the refresh grant really changed, otherwise treat the
 * change as a renewal. A renewal keeps the earlier login time so an account
 * that refreshes every hour is not reported as logging in every hour.
 */
function isLogin(prev, slot, nowMs) {
	if (!slot.recoveryGrantCurrent && Number.isFinite(prev.expires) && nowMs < prev.expires - REFRESH_LEAD_MS) return true;
	if (prev.blockReason === "auth_error" && !slot.recoveryGrant) return true;
	if (prev.recoveryGrant && !slot.recoveryGrant) return true;
	return false;
}

function recordFrom(slot, loginMs, basis) {
	return {
		digest: slot.digest,
		expires: slot.expires,
		blockReason: slot.blockReason,
		recoveryGrant: slot.recoveryGrant,
		loginMs,
		basis,
	};
}

/**
 * Fold one observation of omo's auth slots into the login ledger.
 * `slots === undefined` means the read was unknown (missing or unreadable
 * file) and changes nothing.
 */
export function trackOmoLogins(prev, slots, nowMs) {
	if (slots === undefined) return prev;
	const slotsOut = {};
	for (const slot of slots) {
		if (!slot || typeof slot.name !== "string") continue;
		const prevSlot = prev?.slots?.[slot.name];
		if (!prev?.slots) {
			slotsOut[slot.name] = recordFrom(slot, nowMs, "first-seen");
		} else if (!prevSlot) {
			slotsOut[slot.name] = recordFrom(slot, nowMs, "login");
		} else if (prevSlot.digest === slot.digest) {
			slotsOut[slot.name] = recordFrom(slot, prevSlot.loginMs, prevSlot.basis);
		} else if (isLogin(prevSlot, slot, nowMs)) {
			slotsOut[slot.name] = recordFrom(slot, nowMs, "login");
		} else {
			slotsOut[slot.name] = recordFrom(slot, prevSlot.loginMs, prevSlot.basis);
		}
	}
	return { v: 1, observedMs: nowMs, slots: slotsOut };
}

export function omoLoginView(state) {
	if (!state) return undefined;
	return {
		slots: Object.entries(state.slots ?? {})
			.map(([name, rec]) => ({
				name,
				loginMs: rec.loginMs,
				basis: rec.basis,
				blockReason: rec.blockReason,
				expires: rec.expires,
			}))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
	};
}

/**
 * Lazy reader of the persisted login ledger plus its auth-file per-call refresh.
 * Writes only when the slot records themselves moved, so an idle account never
 * rewrites the file just because time passed.
 */
export function createOmoLoginSource({ file, authFile, clock, read = readAuthSlots }) {
	let state;
	let loaded = false;
	return function readOmoLogin() {
		if (!loaded) {
			loaded = true;
			const stored = readJsonSafe(file);
			state = stored && typeof stored === "object" && stored.v === 1 ? stored : undefined;
		}
		const next = trackOmoLogins(state, read(authFile), clock.now());
		if (JSON.stringify(next?.slots) !== JSON.stringify(state?.slots)) atomicWriteJson(file, next);
		state = next;
		return omoLoginView(state);
	};
}
