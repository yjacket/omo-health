import { atomicWriteJson, readJsonSafe } from "../util/fsx.mjs";

/**
 * Dashboard preferences (`<healthHome>/ui-prefs.json`, plan todo 6): the only
 * preference today is hiding child rows in the session history. The dashboard
 * server is the only writer; readers tolerate a missing, half-written or
 * malformed file and fall back to the default.
 */
const PREF_KEYS = ["hideChildren"];

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `{hideChildren}` for the dashboard: the stored boolean, else the default false. */
export function readUiPrefs(paths) {
	const data = readJsonSafe(paths.health.uiPrefsFile);
	return { hideChildren: isRecord(data) && typeof data.hideChildren === "boolean" ? data.hideChildren : false };
}

/**
 * Write the exact keys `["hideChildren"]` with a boolean value; anything else
 * is refused without touching the file. The file carries the version so a later
 * schema change can tell old copies apart.
 */
export function writeUiPrefs(paths, prefs) {
	if (!isRecord(prefs)) return { ok: false, reason: "invalid" };
	const keys = Object.keys(prefs);
	if (keys.length !== PREF_KEYS.length || !PREF_KEYS.every((key) => Object.hasOwn(prefs, key))) {
		return { ok: false, reason: "invalid" };
	}
	if (typeof prefs.hideChildren !== "boolean") return { ok: false, reason: "invalid" };
	atomicWriteJson(paths.health.uiPrefsFile, { v: 1, hideChildren: prefs.hideChildren });
	return { ok: true };
}
