import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";

const { transcript, reads } = workerData;
const opens = new Int32Array(reads);
const openSync = fs.openSync;
fs.openSync = function (file, ...args) {
	if (file === transcript) Atomics.add(opens, 0, 1);
	return openSync.call(this, file, ...args);
};
syncBuiltinESMExports();
await import("../../src/ui/detail-worker.mjs");
