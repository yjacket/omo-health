import { parentPort, workerData } from "node:worker_threads";
import { prepareAudit } from "../../src/audit-prepare-worker.mjs";
import { usageTimeline } from "../../src/collect/usage.mjs";
import { loadSessionRecord } from "../../src/session-record.mjs";

parentPort.on("message", (job) => {
	const { paths, mode, signal } = workerData;
	if (mode === "crash") throw new Error("failed preparation: " + "x".repeat(500));
	if (mode === "exit") process.exit(7);
	const observed = { scans: [], timelines: [] };
	const result = prepareAudit(job, {
		paths,
		loadRecord(options) {
			if (mode === "block") {
				Atomics.store(signal, 0, 1);
				Atomics.notify(signal, 0);
				if (Atomics.wait(signal, 1, 0, 30_000) === "timed-out") throw new Error("test did not release preparation");
			}
			const { messageScanTotalBytes, messageScanMaxBytes, descendantScanMax } = options;
			observed.options = { messageScanTotalBytes, messageScanMaxBytes, descendantScanMax };
			if (mode === "bounds") return { found: false };
			if (mode === "scans") options.scanMessages = (file) => (observed.scans.push(file), []);
			const record = loadSessionRecord(options);
			if (mode === "oversized") record.tokens = { models: Array.from({ length: 3000 }, (_, i) => ({ key: `${"m".repeat(60)}${i}`, tokens: 1, cost: 0 })) };
			return record;
		},
		timeline(...args) {
			observed.timelines.push(args);
			const full = usageTimeline(...args);
			if (mode === "timeline") full.totals.modelsIncomplete = true;
			return full;
		},
	});
	parentPort.postMessage({ ...result, observed });
});
