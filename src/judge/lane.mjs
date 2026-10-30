import fs from "node:fs";
import { parseJsonc } from "../collect/config-files.mjs";

/**
 * The analyst's model lane (plan todo 7). The model is the first rung of omo's own category lane
 * (`"[native]".categories.<lane>.models` in omo.jsonc) whose provider the machine is logged in to, so the analyst
 * follows the owner's lane configuration instead of a hardcoded model.
 */

/** Flags the analyst always runs with: no session file, no extensions/skills/context files, and above all no tools. */
export const GUARD_FLAGS = Object.freeze(["--no-session", "-ne", "-ns", "-nc", "--no-tools"]);

export const ANALYST_INSTRUCTION = "Judge from the attached evidence bundle only and answer with one JSON object and nothing else.";

/** Provider of a `provider/model[:level]` id: the text before the first `/`. */
export function providerOfModel(model) {
	const text = String(model ?? "");
	const slash = text.indexOf("/");
	return slash > 0 ? text.slice(0, slash) : undefined;
}

/** Provider names the machine is logged in to: the KEYS of auth.json, never its values. */
function loggedInProviders(authFile) {
	try {
		return new Set(Object.keys(JSON.parse(fs.readFileSync(authFile, "utf8")) ?? {}));
	} catch {
		return new Set();
	}
}

/**
 * The first model of the lane whose provider is logged in, else `config.analyst.fallbackModel`.
 * An unreadable or unparsable omo.jsonc / auth.json is the same as an empty lane.
 */
export function resolveLaneModel(paths, lane, config) {
	const fallback = config.analyst.fallbackModel;
	let models;
	try {
		models = parseJsonc(fs.readFileSync(paths.omoJsonc, "utf8"))?.["[native]"]?.categories?.[lane]?.models;
	} catch {
		return fallback;
	}
	if (!Array.isArray(models)) return fallback;
	const providers = loggedInProviders(paths.authFile);
	return models.find((model) => typeof model === "string" && providers.has(providerOfModel(model))) ?? fallback;
}

/** Throws unless every guard flag is in `args`. The runner calls it on the final argv too. */
export function assertGuardFlags(args) {
	for (const flag of GUARD_FLAGS) if (!args.includes(flag)) throw new Error(`analyst argv is missing guard flag ${flag}`);
	return args;
}

/**
 * argv for one analyst run. The evidence goes in only as the attached `@<bundleFile>`, never on argv itself, and the
 * analyst gets no tools. Throws when a guard flag is missing, so a later edit cannot quietly loosen the sandbox.
 */
export function laneArgs({ model, bundleFile, sessionId }) {
	if (!model) throw new Error("laneArgs: model is required");
	if (!bundleFile) throw new Error("laneArgs: bundleFile is required");
	return assertGuardFlags(["-p", ...GUARD_FLAGS, "--model", model, ...(sessionId ? ["--session-id", sessionId] : []), `@${bundleFile}`, ANALYST_INSTRUCTION]);
}
