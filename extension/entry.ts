import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <clone>/extension/entry.ts, so the clone is two levels up.
const CLONE = dirname(dirname(fileURLToPath(import.meta.url)));

function healthHome(): string {
	return process.env.OMO_HEALTH_HOME || join(homedir(), ".omo-health");
}

function legacyStubPath(): string {
	return join(process.env.OMO_HEALTH_OMO_HOME || join(homedir(), ".omo"), "agent", "extensions", "omo-health-sensor.ts");
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

/** Package channel: current.root, lkg.root, then the clone. A pinned or dev pointer is ignored. */
function candidateRoots(): string[] {
	const roots: string[] = [];
	try {
		const current = JSON.parse(readFileSync(join(healthHome(), "app", "current.json"), "utf8").replace(/^\uFEFF/, ""));
		if (current?.channel === "package") {
			for (const root of [current.root, current.lkg?.root]) if (typeof root === "string" && root) roots.push(root);
		}
	} catch (error: any) {
		// No pointer yet is normal; a broken one is worth a trace.
		if (error?.code !== "ENOENT") logFailure(error);
	}
	roots.push(CLONE);
	const seen = new Set<string>();
	return roots.filter((root) => {
		const key = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export default async function omoHealthEntry(pi: any) {
	const setupOnly = existsSync(legacyStubPath());
	let mod: any;
	for (const root of candidateRoots()) {
		try {
			// Same loader as stub.ts.tpl: senpi evaluates extensions where a bare import() has no callback.
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
		mod.default(pi, { source: CLONE, setupOnly });
	} catch (error: any) {
		logFailure(error);
	}
}
