import { parentPort, workerData } from "node:worker_threads";
import { auditModelFacts, readAuditTimeline } from "./auditor.mjs";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { loadSessionRecord, usageEntryOf } from "./session-record.mjs";
import { readUsageIndex } from "./usage-index.mjs";

/** All retention and transcript reads belong to this thread, including its own published index snapshot. */
export function prepareAudit({ sessionId, now, bounds }, { paths, loadRecord = loadSessionRecord, timeline }) {
	const { tokens, ...scanBounds } = bounds;
	const index = readUsageIndex(paths.health.usageIndexFile);
	const locator = createSessionFileLocator({ paths, clock: { now: () => now }, indexedFile: (id) => index.get(id)?.file });
	const loaded = loadRecord({ paths, id: sessionId, now, ...scanBounds, auditRetention: true, locator, index });
	if (!loaded?.found) return { loaded };
	const session = loaded.session ?? {};
	const entry = usageEntryOf(index, session);
	const file = entry?.file ?? (session.taskId ? null : locator.mainFile(session.sessionId));
	let warning;
	const full = readAuditTimeline(file, tokens, { maxFileBytes: bounds.messageScanMaxBytes, timeline, log: { warn: (_event, detail) => { warning = detail; } } });
	return { loaded, full, facts: auditModelFacts(entry, full), warning };
}

if (parentPort && workerData?.auditPrepareWorker) {
	parentPort.on("message", (job) => parentPort.postMessage(prepareAudit(job, workerData)));
}
