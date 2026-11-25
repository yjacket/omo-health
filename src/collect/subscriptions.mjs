import { readJsonSafe } from "../util/fsx.mjs";
import { redact, truncate } from "../util/text.mjs";

/** C-config `budget.staleMs`: a reading older than this is display-only evidence. */
const DEFAULT_STALE_MS = 10 * 60_000;
const ERROR_MAX = 200;

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** `claude:7d_fable` -> `fable`; anything not shaped `<x>:<y>_<scope>` -> null. */
function scopeOf(id) {
	const colon = id.indexOf(":");
	if (colon <= 0) return null;
	const underscore = id.indexOf("_", colon + 1);
	if (underscore <= colon + 1 || underscore === id.length - 1) return null;
	return id.slice(underscore + 1);
}

function windowOf(raw) {
	if (!isObject(raw)) return undefined;
	const id = text(raw.id);
	const label = text(raw.label);
	const usedPercent = finite(raw.usedPercent);
	if (id === null || label === null || usedPercent === null) return undefined;
	const resetsAt = text(raw.resetsAt);
	const resetsAtMs = resetsAt === null ? null : Number.isFinite(Date.parse(resetsAt)) ? Date.parse(resetsAt) : null;
	return {
		id,
		label,
		windowMinutes: finite(raw.windowMinutes),
		usedPercent,
		resetsAtMs,
		scope: scopeOf(id),
	};
}

function windowsOf(raw) {
	if (!Array.isArray(raw)) return [];
	return raw.map(windowOf).filter((w) => w !== undefined);
}

/**
 * Reads senpi's machine-wide subscription usage cache. Read-only.
 * A failed or pending account keeps the PREVIOUS windows beside a fresh `updatedAt`
 * (usage-cache.js:37-43, usage-poller.js:85-104), so both are stale no matter the age.
 */
export function readSubscriptionUsage(file, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
	const cache = readJsonSafe(file);
	if (!isObject(cache) || !isObject(cache.accounts)) {
		return { ok: false, error: `unreadable subscription usage cache: ${file}`, accounts: [] };
	}
	const accounts = [];
	for (const [account, raw] of Object.entries(cache.accounts)) {
		if (!isObject(raw)) continue;
		const updatedMs = finite(raw.updatedAt);
		const nextMs = finite(raw.nextAt);
		// The producer's own sanitize drops entries without both timestamps.
		if (updatedMs === null || nextMs === null) continue;
		const errorText = text(raw.error);
		const error = errorText === null ? null : truncate(redact(errorText), ERROR_MAX);
		const pending = raw.pending === true;
		const failed = error !== null;
		const slash = account.indexOf("/");
		accounts.push({
			account,
			provider: slash > 0 ? account.slice(0, slash) : account,
			plan: text(raw.plan),
			updatedMs,
			nextMs,
			error,
			pending,
			failed,
			stale: failed || pending || now - updatedMs > staleMs,
			windows: windowsOf(raw.windows),
		});
	}
	return { ok: true, accounts };
}
