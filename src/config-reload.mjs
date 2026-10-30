import fs from "node:fs";
import { applyConfigInPlace, effectiveSwitches, loadConfig } from "./config.mjs";
import { appendDecision } from "./decisions.mjs";
import { atomicWriteFile } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/** "<mtimeMs>:<size>", "absent" (ENOENT) or "error:<code>": one stat per watched file. */
function signatureOf(file) {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch (error) {
		return error.code === "ENOENT" ? "absent" : `error:${error.code}`;
	}
}

function mtimeOf(signature) {
	const mtime = Number.parseFloat(signature);
	return Number.isFinite(mtime) ? mtime : null;
}

/** Keep a byte copy of a config.json that parses, so a later broken edit (or restart) falls back to it. */
function writeLastGood(paths) {
	let raw;
	try {
		raw = fs.readFileSync(paths.health.configFile);
		JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		return; // changed or broken since loadConfig read it; the next check handles the new signature
	}
	let current;
	try {
		current = fs.readFileSync(paths.health.configLastGoodFile);
	} catch {
		current = undefined;
	}
	if (current?.equals(raw)) return;
	atomicWriteFile(paths.health.configLastGoodFile, raw);
}

/**
 * Re-read config.json (and $OMO_HEALTH_CONFIG) between daemon ticks and apply it to `config` in place.
 * An unchanged config costs one stat per file; a broken file keeps the current config (or the last good copy).
 */
export function createConfigReloader({ paths, env, config, mode, clock, log, appendDecisionImpl = appendDecision, loadConfigImpl = loadConfig }) {
	const extraFile = env.OMO_HEALTH_CONFIG || null;
	const files = extraFile ? [paths.health.configFile, extraFile] : [paths.health.configFile];
	let attempted = null;
	// Per-file signatures seen by the previous check: a file newly absent waits one check (editors delete, then recreate).
	let previous = null;
	let applied = false;
	const state = {
		fileMtimeMs: null,
		loadedMs: clock.now(),
		extra: null,
		source: "defaults",
		modeOverride: mode ?? null,
		rejected: null,
		effective: effectiveSwitches(config, mode),
	};

	function reject({ source, file, message, fileMtimeMs, now }) {
		const error = truncate(redact(message), 200);
		state.rejected = { source, error, fileMtimeMs, atMs: now };
		log.warn("config_reload_rejected", { source, file, error });
		appendDecisionImpl(paths, { event: "config", result: "rejected", message: error, fileMtimeMs });
	}

	function check() {
		try {
			const signatures = files.map(signatureOf);
			const combined = signatures.join("|");
			const before = previous;
			previous = signatures;
			if (combined === attempted) return;
			if (attempted !== null && signatures.some((sig, i) => sig === "absent" && before?.[i] !== "absent")) return;
			const next = loadConfigImpl({ env, paths });
			attempted = combined;
			const now = clock.now();
			const userMtimeMs = mtimeOf(signatures[0]);
			const userBad = next.unreadable.find((u) => u.file === paths.health.configFile);
			const extraBad = extraFile ? next.unreadable.find((u) => u.file === extraFile) : undefined;
			if (extraBad || (userBad && !next.usedLastGood)) {
				const bad = userBad && !next.usedLastGood ? { source: "user", ...userBad, fileMtimeMs: userMtimeMs } : { source: "extra", ...extraBad, fileMtimeMs: mtimeOf(signatures[1]) };
				reject({ ...bad, now });
				// A broken extra file says nothing about config.json: when that parsed, it is still the copy to fall back to.
				if (!userBad) writeLastGood(paths);
				return;
			}
			const initial = !applied;
			const changed = applyConfigInPlace(config, next.config);
			applied = true;
			state.loadedMs = now;
			state.extra = extraFile ? { file: extraFile, fileMtimeMs: mtimeOf(signatures[1]) } : null;
			state.effective = effectiveSwitches(config, mode);
			if (next.usedLastGood) {
				// The copy's content is in effect; which config.json it came from is known only if this daemon applied it.
				state.source = "last-good";
				reject({ source: "user", file: userBad.file, message: userBad.message, fileMtimeMs: userMtimeMs, now });
			} else {
				state.source = signatures[0] === "absent" ? "defaults" : "file";
				state.fileMtimeMs = userMtimeMs;
				state.rejected = null;
			}
			log.info("config_reloaded", { initial, changed, warnings: next.warnings });
			if (changed.length) appendDecisionImpl(paths, { event: "config", result: "applied", changed: changed.slice(0, 50), fileMtimeMs: state.fileMtimeMs });
			if (state.source === "file") writeLastGood(paths);
		} catch (error) {
			log.error("config_reload_failed", { error: error.message, stack: String(error.stack).slice(0, 800) });
		}
	}

	return { check, state: () => structuredClone(state) };
}
