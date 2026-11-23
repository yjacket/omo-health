import path from "node:path";
import { subjectKey, subjectOf } from "./session-subject.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { auditFileVersion, auditIndexVersion, readVersionedAuditTimeline, sameAuditVersion } from "./auditor.mjs";
import { createSessionFileLocator, mainHeaderConflicts } from "./collect/session-files.mjs";
import { isInside } from "./paths.mjs";
import { loadSessionRecord, usageEntryOf } from "./session-record.mjs";
import { usageEntryFor } from "./usage-index.mjs";

const DISCOVERY_TOO_LARGE = Symbol("discovery-too-large");

/** All retention and transcript reads belong to this thread. Usage arrives from the daemon. */
export function prepareAudit({ subject, now, bounds, indexEntries, indexFull, liveOwners }, { paths, loadRecord = loadSessionRecord, timeline }) {
	const { tokens, preparationMaxBytes, ...scanBounds } = bounds;
	const index = new Map();
	for (const entry of indexEntries) index.set(subjectKey(subjectOf(entry)), entry);
	if (indexFull) Object.defineProperty(index, "full", { value: true });
	// loadSessionRecord owns the message allowance. Discovery and the timeline share the rest.
	let remaining = preparationMaxBytes - scanBounds.messageScanTotalBytes;
	const { findMainFile, childFile } = createSessionFileLocator({ paths, clock: { now: () => now } });
	const discovered = new Map();
	const ambiguous = new Set();
	const mainFile = (subject) => {
		const id = subjectKey(subject);
		if (discovered.has(id)) return discovered.get(id);
		const entry = usageEntryFor(index, subject);
		const external = entry?.kind === "main" && entry.file && !isInside(entry.file, paths.sessionsDir);
		const verified = !external && entry?.kind === "main" && entry.state === "ok" && sameAuditVersion(auditFileVersion(entry.file), entry);
		if (verified && subject.projectKey != null) return entry.file;
		const result = findMainFile(subject, entry ?? null, { maxBytes: remaining });
		remaining -= result.bytesRead;
		if (result.pending) throw DISCOVERY_TOO_LARGE;
		if (result.ambiguous || entry === null || (external && !result.file)) ambiguous.add(id);
		const file = ambiguous.has(id) ? undefined : result.file ?? (verified ? entry.file : undefined);
		discovered.set(id, file);
		return file;
	};
	try {
		const record = loadRecord({ paths, subject, now, ...scanBounds, auditRetention: true, locator: { mainFile, childFile }, index, liveOwners });
		if (!record?.found) return { loaded: record };
		// Launch-only join keys travel separately from the record used to build the reviewer's bundle.
		const { selectedFps, auditSubjectIds, ...loaded } = record;
		const session = loaded.session ?? {};
		const entry = usageEntryOf(index, session);
		const indexVersion = auditIndexVersion(entry);
		const mainSubject = record.subject ?? subjectOf({ ...session, sessionId: session.ledgerIds?.sessionId ?? session.sessionId });
		const file = mainSubject.taskId ? entry?.file : mainFile(mainSubject);
		if (!mainSubject.taskId && ambiguous.has(subjectKey(mainSubject))) return { modelsAmbiguous: true };
		let warning;
		const maxFileBytes = Math.min(scanBounds.messageScanMaxBytes, remaining);
		const report = readVersionedAuditTimeline(file, tokens, { maxFileBytes, timeline, log: { warn: (_event, detail) => { warning = detail; } } });
		if (!mainSubject.taskId && report.full?.sessionHeader) {
			const projectKey = mainSubject.projectKey ?? (isInside(file, paths.sessionsDir)
				? path.basename(path.dirname(file)) : entry?.projectKey);
			if (mainHeaderConflicts({ ...mainSubject, projectKey }, report.full.sessionHeader)) return { modelsAmbiguous: true };
		}
		return { loaded, selectedFps, auditSubjectIds, indexVersion, ...report, warning };
	} catch (error) {
		if (error !== DISCOVERY_TOO_LARGE) throw error;
		return { discoveryTooLarge: true };
	}
}

if (parentPort && workerData?.auditPrepareWorker) {
	parentPort.on("message", (job) => parentPort.postMessage(prepareAudit(job, workerData)));
}
