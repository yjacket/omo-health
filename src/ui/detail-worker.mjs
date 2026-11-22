import { parentPort, workerData } from "node:worker_threads";
import { auditFileVersion, auditModelFacts, auditsToday, readAuditState, readAuditTimeline, requestAudit, withdrawAuditRequest } from "../auditor.mjs";
import { createSessionFileLocator } from "../collect/session-files.mjs";
import { loadConfig } from "../config.mjs";
import { resolveAuditModel } from "../judge/audit.mjs";
import { loadSessionRecord, recoverPendingAnalystModels, usageEntryOf } from "../session-record.mjs";
import { fresh, readUsageIndex } from "../usage-index.mjs";
import { auditReasonLabel, auditStatusLabel } from "./labels.mjs";
import { daemonStatus, loadDaemonInputs, recordsStamp } from "./model.mjs";

const ACTIVE_AUDIT_STATUSES = new Set(["requested", "queued", "launching", "running"]);
const isAuditActive = (state) => Boolean(state && (ACTIVE_AUDIT_STATUSES.has(state.status) || state.holdUntilExit === true));
const canonicalIdOf = (session, id) => typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : id;

export function detailSignature(paths, files) {
	return JSON.stringify([files.map(auditFileVersion), recordsStamp(paths)]);
}

function auditFactsFor(paths, session, tokens) {
	const usage = readUsageIndex(paths.health.usageIndexFile);
	const entry = usageEntryOf(usage, session ?? {});
	// Do not queue against an index row the daemon still has to finish or refresh.
	if (!fresh(entry)) return { ...auditModelFacts(entry, null), sessionModelsKnown: false };
	return auditModelFacts(entry, readAuditTimeline(entry.file, tokens));
}

function modelBlockOf(facts, session) {
	if (!facts.sessionModelsKnown) return "models-unknown";
	if (session?.analystModelsUnknown) return "analyst-models-unknown";
	return null;
}

/** The first refusal, in the order the detail and the POST agree on. */
function blockedOf({ config, daemon, usedToday, perDay, modelBlock, planned }) {
	if (config.audit?.enabled !== true) return "disabled";
	if (daemon.state !== "running") return "daemon-off";
	if (Number.isFinite(perDay) && usedToday >= perDay) return "cap";
	if (modelBlock) return modelBlock;
	if (!planned) return "no-model";
	return null;
}

/** Synchronous disk operations; the dashboard runs them only inside its detail worker. */
export function createDetailOperations({
	paths, env = process.env, load = loadSessionRecord, resolveModel = resolveAuditModel, readState = readAuditState,
	today = auditsToday, request = requestAudit, daemonInputs = loadDaemonInputs, auditDetail,
} = {}) {
	let at;
	const locator = createSessionFileLocator({ paths, clock: { now: () => at } });
	const loadRecord = ({ id, row, now }) => load({ paths, id, row, now, locator });
	const plan = (config, facts, analystModels) =>
		resolveModel(paths, config, { ...facts, analystModels: Array.isArray(analystModels) ? analystModels : [] });

	function preview(id, { session, analystModels }) {
		// A cached record may predate an exit that didn't generate a decision.
		if (session?.pendingAnalystJobs?.length) {
			const models = new Set(analystModels);
			if (recoverPendingAnalystModels(models, new Set(session.pendingAnalystJobs), paths.health.jobsDir)) {
				session = { ...session, analystModelsUnknown: false };
				analystModels = [...models];
			}
		}
		const { config } = loadConfig({ env, paths });
		const daemon = daemonStatus(daemonInputs({ paths, env, now: at }));
		// A task id and its canonical session id share the same audit files.
		const state = readState(paths, canonicalIdOf(session, id));
		const perDay = Number.isFinite(config.audit?.perDay) ? config.audit.perDay : null;
		const usedToday = today(paths, at);
		const facts = auditFactsFor(paths, session, config.tokens);
		const modelBlock = modelBlockOf(facts, session);
		const choice = modelBlock ? null : plan(config, facts, analystModels);
		const planned = choice && !choice.blocked ? choice : null;
		const blocked = blockedOf({ config, daemon, usedToday, perDay, modelBlock, planned });
		return { state, planned, blocked, stalled: isAuditActive(state) && daemon.state !== "running", usedToday, perDay };
	}
	const previewOf = auditDetail ?? ((record, id) => preview(id, record));

	const refuse = (status, reason) => [status, { error: reason, reasonKo: auditReasonLabel(reason) }];
	function startAudit(record, id) {
		if (!record?.found) return refuse(404, "not-found");
		const canonicalId = canonicalIdOf(record.session, id);
		const { config } = loadConfig({ env, paths });
		if (config.audit?.enabled !== true) return refuse(409, "disabled");
		const daemon = daemonStatus(daemonInputs({ paths, env, now: at }));
		if (daemon.state !== "running") return refuse(409, "daemon-off");
		if (isAuditActive(readState(paths, canonicalId))) return refuse(409, "running");
		const perDay = config.audit.perDay;
		if (Number.isFinite(perDay) && today(paths, at) >= perDay) return refuse(429, "cap");
		const facts = auditFactsFor(paths, record.session, config.tokens);
		const modelBlock = modelBlockOf(facts, record.session);
		if (modelBlock) return refuse(409, modelBlock);
		const choice = plan(config, facts, record.analystModels);
		if (!choice || choice.blocked) return refuse(409, "no-model");
		const claim = request(paths, canonicalId, at);
		if (!claim.created) return refuse(409, "running");
		// Intake may have published this claim, or another dashboard's, since the first read.
		const state = readState(paths, canonicalId);
		if (isAuditActive(state) && state.claimId !== claim.request.claimId) {
			withdrawAuditRequest(paths, canonicalId, claim.request.claimId);
			return refuse(409, "running");
		}
		return [202, { ok: true, audit: { sessionId: canonicalId, status: "queued", statusKo: auditStatusLabel("queued"), planned: choice } }];
	}

	return function prepare(job) {
		const { kind, id, now } = job;
		at = now;
		if (kind === "preview") return previewOf(job.record, id);
		const loaded = loadRecord(job);
		if (kind === "audit") return startAudit(loaded, id);
		if (loaded?.found !== true) return { record: loaded, files: [], signature: detailSignature(paths, []), audit: null };
		// Keep dependency paths out of the record sent through the client view.
		const { transcriptFiles, ...record } = loaded;
		const session = record.session;
		// Injected loaders may not report dependencies; retain the selected-file lookup for them.
		const file = transcriptFiles === undefined && (session?.taskId
			? locator.childFile({ taskId: session.taskId, sessionId: session.sessionId, cwds: session.cwd ? [session.cwd] : [] })
			: locator.mainFile(session?.sessionId));
		const files = transcriptFiles ?? (file ? [file] : []);
		return { record, files, signature: detailSignature(paths, files), audit: previewOf(record, id) };
	};
}

if (parentPort && workerData?.detailWorker) {
	const prepare = createDetailOperations(workerData);
	// Synchronous work in successive message callbacks preserves queue order.
	parentPort.on("message", (job) => {
		try {
			parentPort.postMessage({ result: prepare(job) });
		} catch (error) {
			parentPort.postMessage({ error: String(error?.message ?? error) });
		}
	});
}
