import path from "node:path";
import { atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, removeSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * The investigation list (plan todo 8): one JSON file per suspicion in `paths.health.investigationsDir`, named by the
 * finding's fp and written atomically. A suspicion (a time threshold, an anomaly signal, a report) is recorded here
 * first; only an analyst verdict, or a concrete-evidence rule, ends in an action, and the action is attached to the same
 * file. The engine writes; the dashboard reads (src/ui/model.mjs).
 *
 * `{id, openedMs, trigger: stall|anomaly|report|why, subject, detector, cls, rule, signature, evidence, signals[], status,
 *   lane, model, jobId, verdict, actions[], failures, retryAtMs, why, whyNoticed, looks, nextLookMs, updatedMs}`
 * status: open -> analyzing -> verdict -> released | advised | noticed | closed, or failed (the analyst could not answer;
 * `retryAtMs` is when it is asked again). `retryAtMs` also holds the next look after a `progressing` verdict.
 * `why: true` is sticky: a why look on an investigation that already existed (opened by a rule release, say) leaves the
 * flag on the record. `whyNoticed: true` is the one-message rule (C12): no second why/relay/main notice for that fp.
 */
export const STATUSES = Object.freeze(["open", "analyzing", "verdict", "released", "advised", "noticed", "closed", "failed"]);
/** Statuses of a settled suspicion (acted on, told or gone): a late verdict never reopens one, and `closed` is final. */
export const RESOLVED = Object.freeze(new Set(["released", "advised", "noticed", "closed"]));
const DAY_MS = 24 * 3600_000;
const MAX_ACTIONS = 20;
const MAX_SIGNALS = 20;

/** Masked like the decision log: an investigation file holds command text and verdict words. */
const masked = (value) => JSON.parse(redact(JSON.stringify(value)));

export function createInvestigations({ paths, clock }) {
	const dir = paths.health.investigationsDir;
	const fileOf = (id) => path.join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
	const get = (id) => readJsonSafe(fileOf(id));
	const write = (record) => atomicWriteJson(fileOf(record.id), record);

	/** Newest first; `sinceMs` keeps the ones touched since then. */
	const listRecords = ({ sinceMs = 0, limit = 200 } = {}) => {
		const out = [];
		for (const name of listDirSafe(dir)) {
			if (!name.endsWith(".json")) continue;
			const record = readJsonSafe(path.join(dir, name));
			if (record?.id && (record.updatedMs ?? record.openedMs ?? 0) >= sinceMs) out.push(record);
		}
		return out.sort((a, b) => b.openedMs - a.openedMs).slice(0, limit);
	};

	return {
		dir,
		get,
		/** Create the investigation of `id`, or return the one that already exists (an fp opens at most one). */
		open({ id, trigger = "stall", subject, detector, cls, rule, signature, evidence = [], signals = [], lane, model }) {
			const existing = get(id);
			if (existing) return existing;
			const now = clock.now();
			const record = masked({ id, openedMs: now, trigger, subject: subject ?? {}, detector: detector ?? null, cls: cls ?? null, rule: rule ?? null, signature: signature === undefined || signature === null ? null : truncate(String(signature), 500), evidence, signals, status: "open", lane: lane ?? null, model: model ?? null, jobId: null, verdict: null, actions: [], failures: 0, retryAtMs: null, updatedMs: now });
			ensureDir(dir);
			write(record);
			return record;
		},
		/**
		 * Update one investigation. `action` and `signal` are appended; every other key is set (`null` clears one), except
		 * `failures`, where `failures: "+1"` counts one more. Returns the new record, or undefined when `id` is unknown.
		 */
		attach(id, patch = {}) {
			const record = get(id);
			if (!record) return undefined;
			const { action, signal, failures, ...rest } = masked(patch);
			Object.assign(record, rest);
			if (failures === "+1") record.failures = (record.failures ?? 0) + 1;
			else if (Number.isFinite(failures)) record.failures = failures;
			if (action) record.actions = [...(record.actions ?? []), { atMs: clock.now(), ...action }].slice(-MAX_ACTIONS);
			if (signal) record.signals = [...(record.signals ?? []), signal].slice(-MAX_SIGNALS);
			record.updatedMs = clock.now();
			write(record);
			return record;
		},
		/** Newest first; `sinceMs` keeps the ones touched since then. */
		list: listRecords,
		/**
		 * The newest answered why verdict for one triage signature (analyst-why C14), or undefined. Only a verdict the
		 * analyst really answered counts: failed, notReached and already-reused verdicts are never a cache source, and
		 * neither is a verdict from a non-why look (`why` false) - a D1 release look must never be reused. `sinceMs`
		 * filters on the answer's own time (`verdict.atMs`), not on when the record was opened.
		 */
		findAnswered({ signature, sinceMs = 0 } = {}) {
			if (!signature) return undefined;
			return listRecords({ limit: 1000 }).find(
				(record) =>
					record.signature === signature &&
					record.verdict &&
					record.verdict.failed !== true &&
					record.verdict.notReached !== true &&
					record.verdict.reused !== true &&
					record.verdict.why === true &&
					Number.isFinite(record.verdict.atMs) &&
					record.verdict.atMs >= sinceMs,
			);
		},
		/** Remove the investigations untouched for `days` (history.retentionDays); returns how many went. */
		prune(days) {
			const cutoff = clock.now() - days * DAY_MS;
			let removed = 0;
			for (const name of listDirSafe(dir)) {
				if (!name.endsWith(".json")) continue;
				const file = path.join(dir, name);
				const record = readJsonSafe(file);
				if (record && (record.updatedMs ?? record.openedMs ?? 0) < cutoff && removeSafe(file)) removed += 1;
			}
			return removed;
		},
	};
}
