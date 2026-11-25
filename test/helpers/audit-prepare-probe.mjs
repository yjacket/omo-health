import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { prepareAudit } from "../../src/audit-prepare-worker.mjs";
import { usageTimeline } from "../../src/collect/usage.mjs";
import { loadSessionRecord } from "../../src/session-record.mjs";

parentPort.on("message", (job) => {
	const { paths, mode, signal } = workerData;
	if (mode === "crash") throw new Error("failed preparation: " + "x".repeat(500));
	if (mode === "exit") process.exit(7);
	const observed = { scans: [], timelines: [] };
	const { openSync, readSync, closeSync } = fs;
	const opened = new Map();
	if (mode === "session-bytes") {
		observed.sessionBytes = 0;
		observed.sessionOpens = [];
		fs.openSync = (file, ...args) => {
			const fd = openSync(file, ...args);
			if (typeof file === "string" && file.startsWith(paths.sessionsDir + path.sep) && file.endsWith(".jsonl")) {
				opened.set(fd, file);
				observed.sessionOpens.push(path.basename(file));
			}
			return fd;
		};
		fs.readSync = (fd, ...args) => {
			const count = readSync(fd, ...args);
			if (opened.has(fd)) observed.sessionBytes += count;
			return count;
		};
		fs.closeSync = (fd) => {
			opened.delete(fd);
			return closeSync(fd);
		};
	}
	const block = () => {
		Atomics.store(signal, 0, 1);
		Atomics.notify(signal, 0);
		if (Atomics.wait(signal, 1, 0, 30_000) === "timed-out") throw new Error("test did not release preparation");
	};
	let result;
	try {
		result = prepareAudit(job, {
			paths,
			loadRecord(options) {
				if (mode === "block") block();
				const { messageScanTotalBytes, messageScanMaxBytes, descendantScanMax } = options;
				observed.options = { messageScanTotalBytes, messageScanMaxBytes, descendantScanMax };
				if (mode === "bounds") return { found: false };
				if (mode === "scans") options.scanMessages = (file) => (observed.scans.push(file), []);
				const record = loadSessionRecord(options);
				if (mode === "block-after-record") block();
				return record;
			},
			timeline(...args) {
				observed.timelines.push(args);
				const full = usageTimeline(...args);
				if (mode === "timeline") full.totals.modelsIncomplete = true;
				if (mode === "oversized") full.totals.models = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`${"m".repeat(60)}${i}`, { tokens: 1, cost: 0 }]));
				return full;
			},
		});
	} finally {
		if (mode === "session-bytes") Object.assign(fs, { openSync, readSync, closeSync });
	}
	parentPort.postMessage({ ...result, observed });
});
