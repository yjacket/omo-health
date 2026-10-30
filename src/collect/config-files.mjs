import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config.mjs";
import { classifyProviderError } from "../detect/provider.mjs";
import { atomicWriteFile, atomicWriteJson, readJsonSafe } from "../util/fsx.mjs";

/**
 * Tracks omo's settings.json and omo.jsonc (plan todo 13) and keeps the
 * last-known-good copy of settings.json under healthHome/lkg/.
 */

export function sha1Buffer(buffer) {
	return crypto.createHash("sha1").update(buffer).digest("hex");
}

export const lkgFiles = (paths) => ({
	dir: paths.health.lkgDir,
	settings: path.join(paths.health.lkgDir, "settings.json"),
	state: path.join(paths.health.lkgDir, "state.json"),
	rejectedDir: path.join(paths.health.lkgDir, "rejected"),
});

/** lkg state file: { sha1, savedAtMs, lastRevert? } */
export function readLkgState(paths) {
	const state = readJsonSafe(lkgFiles(paths).state, {});
	return state && typeof state === "object" ? state : {};
}

export function writeLkgState(paths, state) {
	atomicWriteJson(lkgFiles(paths).state, state);
}

/**
 * Tolerant JSONC: // and /* *\/ comments and trailing commas are allowed.
 * Throws SyntaxError like JSON.parse on anything else.
 */
export function parseJsonc(text) {
	const src = String(text ?? "").replace(/^\uFEFF/, "");
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
			out += src.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i += 1;
		} else if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) throw new SyntaxError("Unterminated block comment in JSONC");
			i = end + 2;
			out += " ";
		} else {
			out += ch;
			i += 1;
		}
	}
	// drop trailing commas: `,` followed only by whitespace before } or ] (outside strings)
	let cleaned = "";
	for (let k = 0; k < out.length; k++) {
		const ch = out[k];
		if (ch === '"') {
			let j = k + 1;
			while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
			cleaned += out.slice(k, j + 1);
			k = j;
			continue;
		}
		if (ch === ",") {
			let j = k + 1;
			while (j < out.length && /\s/.test(out[j])) j += 1;
			if (out[j] === "}" || out[j] === "]") continue;
		}
		cleaned += ch;
	}
	return JSON.parse(cleaned);
}

function readFileState(file) {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch {
		return { exists: false };
	}
	try {
		const buffer = fs.readFileSync(file);
		return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size, buffer, sha1: sha1Buffer(buffer) };
	} catch (error) {
		return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size, readError: error.code ?? error.message };
	}
}

function parseWith(buffer, parser) {
	try {
		return { parsed: parser(buffer.toString("utf8").replace(/^\uFEFF/, "")), parseError: undefined };
	} catch (error) {
		return { parsed: undefined, parseError: String(error.message ?? error) };
	}
}

const sessionList = (sessions) => (sessions instanceof Map ? [...sessions.values()] : [...(sessions ?? [])]);

function providerErrorsSince(events, sessions, sinceMs) {
	const list = events ? (typeof events.since === "function" ? events.since(sinceMs, "providerError") : events.filter((e) => e.type === "providerError" && e.ms >= sinceMs)) : [];
	if (list.some((e) => classifyProviderError(e.error) === "not-configured")) return true;
	for (const session of sessionList(sessions)) {
		if ((session.errors ?? []).some((e) => e.ms >= sinceMs && classifyProviderError(e.text) === "not-configured")) return true;
	}
	return false;
}

function okTurnSince(sessions, sinceMs) {
	for (const session of sessionList(sessions)) {
		if ((session.turns ?? []).some((t) => t.ms >= sinceMs && t.stopReason !== "error")) return true;
	}
	return false;
}

/**
 * @param {{paths: object, clock?: () => number, config?: object}} options
 *   config is the `config` section (lkgQuietMs); defaults to DEFAULT_CONFIG.config.
 */
export function createConfigTracker({ paths, clock = () => Date.now(), config = DEFAULT_CONFIG.config }) {
	const files = lkgFiles(paths);
	let settings = { file: paths.settingsFile, exists: false, sha1: undefined, mtimeMs: undefined, parsed: undefined, parseError: undefined, changedAtMs: undefined, previousSha1: undefined };
	let settingsSize;
	let omoJsonc = { file: paths.omoJsonc, exists: false, sha1: undefined, mtimeMs: undefined, parseError: undefined };
	let omoSize;

	function refreshSettings() {
		const st = readFileState(paths.settingsFile);
		if (!st.exists) {
			if (settings.exists) settings = { ...settings, exists: false, previousSha1: settings.sha1, sha1: undefined, parsed: undefined, parseError: undefined, mtimeMs: undefined, changedAtMs: clock() };
			return;
		}
		if (st.readError) return; // transient (Windows share lock); keep the last view
		if (settings.exists && st.sha1 === settings.sha1 && st.mtimeMs === settings.mtimeMs && st.size === settingsSize) return;
		settingsSize = st.size;
		const { parsed, parseError } = parseWith(st.buffer, JSON.parse);
		const changed = st.sha1 !== settings.sha1;
		settings = {
			file: paths.settingsFile,
			exists: true,
			sha1: st.sha1,
			mtimeMs: st.mtimeMs,
			parsed,
			parseError,
			changedAtMs: changed ? st.mtimeMs : settings.changedAtMs,
			previousSha1: changed ? settings.sha1 : settings.previousSha1,
		};
	}

	function refreshOmo() {
		const st = readFileState(paths.omoJsonc);
		if (!st.exists) {
			omoJsonc = { file: paths.omoJsonc, exists: false, sha1: undefined, mtimeMs: undefined, parseError: undefined };
			return;
		}
		if (st.readError) return;
		if (omoJsonc.exists && st.sha1 === omoJsonc.sha1 && st.mtimeMs === omoJsonc.mtimeMs && st.size === omoSize) return;
		omoSize = st.size;
		omoJsonc = { file: paths.omoJsonc, exists: true, sha1: st.sha1, mtimeMs: st.mtimeMs, parseError: parseWith(st.buffer, parseJsonc).parseError };
	}

	function maybePromote(state, { events, sessions }) {
		if (!settings.exists || settings.parseError || !settings.sha1) return state;
		if (state.sha1 === settings.sha1) return state;
		const now = clock();
		const since = settings.changedAtMs ?? settings.mtimeMs ?? now;
		if (now - since < config.lkgQuietMs) return state;
		if (providerErrorsSince(events, sessions, since)) return state;
		if (!okTurnSince(sessions, since)) return state;
		let buffer;
		try {
			buffer = fs.readFileSync(paths.settingsFile);
		} catch {
			return state;
		}
		if (sha1Buffer(buffer) !== settings.sha1) return state; // changed under us; next tick
		atomicWriteFile(files.settings, buffer);
		const next = { ...state, sha1: settings.sha1, savedAtMs: now };
		writeLkgState(paths, next);
		return next;
	}

	return {
		update({ events, sessions } = {}) {
			refreshSettings();
			refreshOmo();
			let state = readLkgState(paths);
			state = maybePromote(state, { events, sessions });
			return {
				settings: { ...settings },
				omoJsonc: { ...omoJsonc },
				lkg: state.sha1 && fs.existsSync(files.settings) ? { sha1: state.sha1, savedAtMs: state.savedAtMs } : undefined,
				lastRevert: state.lastRevert ? { ...state.lastRevert } : undefined,
			};
		},
	};
}
