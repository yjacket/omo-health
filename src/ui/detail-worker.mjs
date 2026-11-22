import { parentPort, workerData } from "node:worker_threads";
import { auditModelFacts, auditsToday, readAuditState, readAuditTimeline, requestAudit, withdrawAuditRequest } from "../auditor.mjs";
import { createSessionFileLocator } from "../collect/session-files.mjs";
import { loadConfig } from "../config.mjs";
import { resolveAuditModel } from "../judge/audit.mjs";
import { loadSessionRecord, usageEntryOf } from "../session-record.mjs";
import { fresh, readUsageIndex } from "../usage-index.mjs";
import { auditReasonLabel, auditStatusLabel } from "./labels.mjs";
import { daemonStatus, loadDaemonInputs } from "./model.mjs";

const ACTIVE_AUDIT_STATUSES = new Set(["requested", "queued", "launching", "running"]);
const isAuditActive = (state) => Boolean(state && (ACTIVE_AUDIT_STATUSES.has(state.status) || state.holdUntilExit === true));
const canonicalIdOf = (session, id) => typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : id;

function auditFactsFor(paths, session, tokens) {
	const usage = readUsageIndex(paths.health.usageIndexFile);
	const entry = usageEntryOf(usage, session ?? {});
	// Do not queue against an index row the daemon still has to finish or refresh.
	if (!fresh(entry)) return { ...auditModelFacts(entry, null), sessionModelsKnown: false };
	return auditModelFacts(entry, readAuditTimeline(entry.file, tokens));
}

/** The first refusal, in the order the detail and the POST agree on. */
function blockedOf({ config, daemon, usedToday, perDay, modelsKnown, planned }) {
	if (config.audit?.enabled !== true) return "disabled";
	if (daemon.state !== "running") return "daemon-off";
	if (Number.isFinite(perDay) && usedToday >= perDay) return "cap";
	if (!modelsKnown) return "models-unknown";
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
	const loadRecord = ({ id, endedMs, now }) => load({ paths, id, endedMs, now, locator });
	const plan = (config, facts, analystModels) =>
		facts.sessionModelsKnown ? resolveModel(paths, config, { ...facts, analystModels: Array.isArray(analystModels) ? analystModels : [] }) : null;

	function preview(id, { session, analystModels }) {
		const { config } = loadConfig({ env, paths });
		const daemon = daemonStatus(daemonInputs({ paths, env, now: at }));
		// A task id and its canonical session id share the same audit files.
		const state = readState(paths, canonicalIdOf(session, id));
		const perDay = Number.isFinite(config.audit?.perDay) ? config.audit.perDay : null;
		const usedToday = today(paths, at);
		const facts = auditFactsFor(paths, session, config.tokens);
		const choice = plan(config, facts, analystModels);
		const planned = choice && !choice.blocked ? choice : null;
		const blocked = blockedOf({ config, daemon, usedToday, perDay, modelsKnown: facts.sessionModelsKnown, planned });
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
		if (!facts.sessionModelsKnown) return refuse(409, "models-unknown");
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
		const record = loadRecord(job);
		if (kind === "audit") return startAudit(record, id);
		if (record?.found !== true) return { record, file: undefined, audit: null };
		const session = record.session;
		const file = session?.taskId
			? locator.childFile({ taskId: session.taskId, sessionId: session.sessionId, cwds: session.cwd ? [session.cwd] : [] })
			: locator.mainFile(session?.sessionId);
		return { record, file, audit: previewOf(record, id) };
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
