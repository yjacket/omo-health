import { parentPort, workerData } from "node:worker_threads";
import { readVersionedAuditTimeline } from "./auditor.mjs";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { loadSessionRecord, usageEntryOf } from "./session-record.mjs";

/** All retention and transcript reads belong to this thread. Usage arrives from the daemon. */
export function prepareAudit({ sessionId, now, bounds, indexEntries, indexFull }, { paths, loadRecord = loadSessionRecord, timeline }) {
	const { tokens, ...scanBounds } = bounds;
	const index = new Map();
	for (const entry of indexEntries) index.set(entry.id, entry);
	if (indexFull) Object.defineProperty(index, "full", { value: true });
	const locator = createSessionFileLocator({ paths, clock: { now: () => now }, indexedFile: (id) => index.get(id)?.file });
	const record = loadRecord({ paths, id: sessionId, now, ...scanBounds, auditRetention: true, locator, index });
	if (!record?.found) return { loaded: record };
	// Launch-only join keys travel separately from the record used to build the reviewer's bundle.
	const { selectedFps, auditSubjectIds, ...loaded } = record;
	const session = loaded.session ?? {};
	const entry = usageEntryOf(index, session);
	const file = entry?.file ?? (session.taskId ? null : locator.mainFile(session.sessionId));
	let warning;
	const report = readVersionedAuditTimeline(file, tokens, { maxFileBytes: bounds.messageScanMaxBytes, timeline, log: { warn: (_event, detail) => { warning = detail; } } });
	return { loaded, selectedFps, auditSubjectIds, ...report, warning };
}

if (parentPort && workerData?.auditPrepareWorker) {
	parentPort.on("message", (job) => parentPort.postMessage(prepareAudit(job, workerData)));
}
