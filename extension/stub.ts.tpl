// omo-health release __VERSION__
// omo-health sensor stub. Installed by `omo-health install`; removed by `omo-health uninstall`.
// It only loads the sensor of the installed omo-health runtime: the root named by
// <healthHome>/app/current.json, then its last known good root, then the root baked in at install.
// If none of them loads it stays inert and never affects the session.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_ROOT = "__FALLBACK_ROOT__";

function healthHome() {
	return process.env.OMO_HEALTH_HOME || join(homedir(), ".omo-health");
}

/** Leave a trace for `omo-health doctor`; one line per failure. */
function logFailure(error: any) {
	try {
		const dir = join(healthHome(), "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "sensor-stub.log"), `${new Date().toISOString()} pid=${process.pid} ${String(error?.stack ?? error).slice(0, 2000)}\n`);
	} catch {
		// nothing else to do
	}
}

/** current.root, lkg.root, the baked fallback; read once at load time, never again in this session. */
function candidateRoots() {
	const roots = [];
	try {
		const current = JSON.parse(readFileSync(join(healthHome(), "app", "current.json"), "utf8").replace(/^\uFEFF/, ""));
		for (const root of [current?.root, current?.lkg?.root]) if (typeof root === "string" && root) roots.push(root);
	} catch (error: any) {
		// No pointer yet (dev checkout, old layout) is normal; a broken one is worth a trace.
		if (error?.code !== "ENOENT") logFailure(error);
	}
	roots.push(FALLBACK_ROOT);
	const seen = new Set();
	return roots.filter((root) => {
		const key = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		return seen.has(key) ? false : (seen.add(key), true);
	});
}

export default async function omoHealthSensorStub(pi: any) {
	let mod: any;
	for (const root of candidateRoots()) {
		try {
			// senpi evaluates extensions through jiti/vm, where import() has no dynamic-import callback
			// (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). Node's own require() loads a helper module whose
			// import() runs in Node's ESM loader; it adds ?v=<mtime> so a reload picks up sensor updates.
			// Only the sensor file is versioned, so the sensor imports nothing from the repo statically:
			// a session keeps the first copy of every plain module URL for its whole life.
			const sensor = join(root, "extension", "sensor.mjs");
			const { importFresh } = createRequire(sensor)(join(root, "extension", "import-fresh.mjs"));
			mod = await importFresh(sensor);
			break;
		} catch (error: any) {
			logFailure(error);
		}
	}
	if (!mod) return;
	try {
		// Not retried with another root: a sensor that failed half way may already have registered handlers.
		mod.default(pi);
	} catch (error: any) {
		logFailure(error);
	}
}
