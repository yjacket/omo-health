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
 * The lane's models whose provider is logged in, in lane order. An unreadable or unparsable omo.jsonc / auth.json
 * is the same as an empty lane, and a lane that does not exist has no models.
 */
export function laneModels(paths, lane) {
	let models;
	try {
		models = parseJsonc(fs.readFileSync(paths.omoJsonc, "utf8"))?.["[native]"]?.categories?.[lane]?.models;
	} catch {
		return [];
	}
	if (!Array.isArray(models)) return [];
	const providers = loggedInProviders(paths.authFile);
	return models.filter((model) => typeof model === "string" && providers.has(providerOfModel(model)));
}

/**
 * The first model of the lane whose provider is logged in, else `config.analyst.fallbackModel`.
 * An unreadable or unparsable omo.jsonc / auth.json is the same as an empty lane.
 */
export function resolveLaneModel(paths, lane, config) {
	return laneModels(paths, lane)[0] ?? config.analyst.fallbackModel;
}

/** The model's name without its provider path and `:level` suffix: `a/b/claude-opus-5-5:max` -> `claude-opus-5-5`. */
export function modelName(model) {
	const text = String(model ?? "");
	const slash = text.lastIndexOf("/");
	const name = slash >= 0 ? text.slice(slash + 1) : text;
	const colon = name.lastIndexOf(":");
	return colon > 0 ? name.slice(0, colon) : name;
}

/** The model's family: its name up to the first `-`, lowercased (`claude-opus-5-5` -> `claude`). */
export function modelFamily(model) {
	return modelName(model).split("-")[0].toLowerCase();
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
