import { subjectKey, subjectOf } from "./session-subject.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { auditFileVersion, auditIndexVersion, readVersionedAuditTimeline, sameAuditVersion } from "./auditor.mjs";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { loadSessionRecord, usageEntryOf } from "./session-record.mjs";

const DISCOVERY_TOO_LARGE = Symbol("discovery-too-large");

/** All retention and transcript reads belong to this thread. Usage arrives from the daemon. */
export function prepareAudit({ subject, now, bounds, indexEntries, indexFull }, { paths, loadRecord = loadSessionRecord, timeline }) {
	const { tokens, preparationMaxBytes, ...scanBounds } = bounds;
	const index = new Map();
	for (const entry of indexEntries) index.set(subjectKey(subjectOf(entry)), entry);
	if (indexFull) Object.defineProperty(index, "full", { value: true });
	// loadSessionRecord owns the message allowance. Discovery and the timeline share the rest.
	let remaining = preparationMaxBytes - scanBounds.messageScanTotalBytes;
	const { findMainFile, childFile } = createSessionFileLocator({ paths, clock: { now: () => now } });
	const discovered = new Map();
	const mainFile = (subject) => {
		const id = subjectKey(subject);
		const entry = index.get(id);
		if (entry?.state === "ok" && sameAuditVersion(auditFileVersion(entry.file), entry)) return entry.file;
		if (discovered.has(id)) return discovered.get(id);
		const result = findMainFile(subject, entry?.file ?? null, { maxBytes: remaining });
		remaining -= result.bytesRead;
		if (result.pending) throw DISCOVERY_TOO_LARGE;
		discovered.set(id, result.file);
		return result.file;
	};
	try {
		const record = loadRecord({ paths, subject, now, ...scanBounds, auditRetention: true, locator: { mainFile, childFile }, index });
		if (!record?.found) return { loaded: record };
		// Launch-only join keys travel separately from the record used to build the reviewer's bundle.
		const { selectedFps, auditSubjectIds, ...loaded } = record;
		const session = loaded.session ?? {};
		const entry = usageEntryOf(index, session);
		const indexVersion = auditIndexVersion(entry);
		const file = session.taskId ? entry?.file : mainFile(subjectOf({ ...session, sessionId: session.ledgerIds?.sessionId ?? session.sessionId }));
		let warning;
		const maxFileBytes = Math.min(scanBounds.messageScanMaxBytes, remaining);
		const report = readVersionedAuditTimeline(file, tokens, { maxFileBytes, timeline, log: { warn: (_event, detail) => { warning = detail; } } });
		return { loaded, selectedFps, auditSubjectIds, indexVersion, ...report, warning };
	} catch (error) {
		if (error !== DISCOVERY_TOO_LARGE) throw error;
		return { discoveryTooLarge: true };
	}
}

if (parentPort && workerData?.auditPrepareWorker) {
	parentPort.on("message", (job) => parentPort.postMessage(prepareAudit(job, workerData)));
}
