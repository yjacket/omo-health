import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { workerData } from "node:worker_threads";

const { transcript, reads, observed, paths } = workerData;
const opens = new Int32Array(reads);
for (const method of ["openSync", "readFileSync", "createReadStream"]) {
	const original = fs[method];
	fs[method] = function (file, ...args) {
		if (method === "openSync" && file === transcript) Atomics.add(opens, 0, 1);
		if (observed && typeof file === "string" && file.startsWith(`${paths.sessionsDir}${path.sep}`) && file.endsWith(".jsonl")) {
			observed.postMessage(file);
		}
		return original.call(this, file, ...args);
	};
}
syncBuiltinESMExports();
await import("../../src/ui/detail-worker.mjs");
