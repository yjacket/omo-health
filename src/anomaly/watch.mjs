import { commandText } from "../collect/sessions.mjs";
import { completionCount, lineageOf, lineageSeen, recordCompletion, recordLineage, shapeKeyOf, shapeStats } from "../db/toolcalls.mjs";
import { tag } from "../detect/classify.mjs";
import { makeFinding } from "../detect/finding.mjs";
import { matchPendingCall, programName } from "../detect/match.mjs";
import { exePathOf } from "../judge/triage.mjs";
import { redact, truncate } from "../util/text.mjs";
import { ANOMALY_DETECTOR, COLD_START_COMPLETIONS, MIN_PENDING_MS, SIGNAL_LABELS_KO, signals } from "./signals.mjs";

/**
 * The engine's side of the tool-call history and the general anomaly signals (plan todo 10).
 *
 * `capture` watches every pending call each tick and keeps what its process tree shows while it runs (the lineage, any
 * visible window): once the call ends the tree is gone. `record` turns the finished calls the session trackers report
 * into history rows (only the normalized shape and the redacted lineage are stored, never the command). `raise` turns
 * signals of a long pending call of a subagent into findings of detector D19; the engine investigates them with the same
 * analyst path as a stall suspicion, and nothing here plans an action.
 */

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
/** A call's lineage keeps growing while its first processes start; after this it is frozen (see treeLineage). */
const LINEAGE_SETTLE_MS = 90_000;
const STATS_CACHE_MS = 60_000;
const STALE_CAPTURE_MS = 10 * 60_000;
const MAX_RELEASED = 500;
const SHELL_TOOLS = /^(bash|shell|powershell)$/i;

const isShell = (name) => SHELL_TOOLS.test(String(name ?? ""));
/** The history's shape of a call: a shell command's normalized pattern, else the tool name. */
const shapeOf = (name, command) => (isShell(name) && command ? shapeKeyOf(truncate(redact(command), 400)) : `tool:${String(name ?? "").toLowerCase()}`);
const slim = (proc) => ({ ...tag(proc), ...(proc.windowVisible === undefined ? {} : { windowVisible: proc.windowVisible }), ...(proc.windowTitle ? { windowTitle: proc.windowTitle } : {}) });

export function createAnomalyWatch({ db, config, clock, log, laneSessionIds }) {
	const captured = new Map();
	const released = new Map();
	const anomalies = new Map();
	const opens = [];
	const capped = new Set();
	const statsCache = new Map();
	const isLane = (sessionId) => Boolean(sessionId && laneSessionIds?.()?.has(sessionId));
	const cachedStats = (shapeKey, now) => {
		const hit = statsCache.get(shapeKey);
		if (hit && now - hit.atMs < STATS_CACHE_MS) return hit.stats;
		const since = now - (config.history?.baselineDays ?? 7) * DAY_MS;
		const stats = shapeStats(db, shapeKey, since, config.anomaly?.outlierQuantile ?? 0.99);
		statsCache.set(shapeKey, { atMs: now, stats });
		if (statsCache.size > 200) statsCache.delete(statsCache.keys().next().value);
		return stats;
	};

	return {
		/** A call omo-health released: the result that follows ends it by omo-health, not by itself. */
		released(callId, now = clock.now()) {
			if (!callId) return;
			released.set(callId, now);
			while (released.size > MAX_RELEASED) released.delete(released.keys().next().value);
		},

		/** Remember each pending call's shape and, while it runs, its process tree's lineage and windows. */
		capture(world) {
			const now = world.now;
			const live = new Set();
			for (const session of world.sessions.values()) {
				if (isLane(session.id)) continue;
				for (const call of session.pending?.values?.() ?? []) {
					live.add(call.id);
					const command = commandText(call.name, call.args);
					let entry = captured.get(call.id);
					if (!entry) {
						entry = { shapeKey: shapeOf(call.name, command), shell: isShell(call.name) && Boolean(command), tree: [] };
						captured.set(call.id, entry);
					}
					entry.lastLiveMs = now;
					if (!entry.shell || !world.procsFresh) continue;
					let match;
					try {
						match = matchPendingCall({ call, session, world });
					} catch (error) {
						log?.warn?.("anomaly_match_failed", { error: error.message });
						continue;
					}
					if (match.state !== "running" || match.confidence !== "high" || !match.tree.length) continue;
					entry.tree = match.tree.map(slim);
					entry.rootPid = match.root?.pid;
					entry.rootPath = match.root ? exePathOf(match.root) : undefined;
					entry.programs = [...new Set(match.tree.map(programName))];
					entry.windowSeen = (entry.windowSeen ?? false) || match.tree.some((proc) => proc.windowVisible === true);
					if (!entry.lineageFp || now - call.ms <= LINEAGE_SETTLE_MS) {
						// A tree whose processes all started long after the call has no lineage of the call's own: none is recorded.
						const { lineage, fp } = lineageOf(match.tree, call.ms);
						entry.lineage = lineage || undefined;
						entry.lineageFp = lineage ? fp : undefined;
					}
				}
			}
			for (const [id, entry] of captured) if (!live.has(id) && now - (entry.lastLiveMs ?? 0) > STALE_CAPTURE_MS) captured.delete(id);
		},

		/** Write the finished calls of this tick into the history (one transaction); a failure is logged, never thrown. */
		record(completions = []) {
			const rows = completions.filter((c) => c?.id && !isLane(c.sessionId));
			if (!rows.length) return 0;
			try {
				db.exec("BEGIN");
				for (const c of rows) {
					const entry = captured.get(c.id);
					recordCompletion(db, {
						id: c.id,
						sessionId: c.sessionId,
						taskId: c.taskId,
						kind: c.kind,
						tool: c.tool,
						shapeKey: entry?.shapeKey ?? shapeOf(c.tool, c.commandHead),
						lineageFp: entry?.lineageFp,
						lineage: entry?.lineage,
						startMs: c.startMs,
						endMs: c.endMs,
						isError: c.isError,
						endedBy: released.has(c.id) ? "omo-health" : "result",
						windowSeen: entry?.windowSeen,
					});
					if (entry?.lineageFp) recordLineage(db, entry.lineageFp, entry.lineage, c.endMs);
					captured.delete(c.id);
					released.delete(c.id);
				}
				db.exec("COMMIT");
				return rows.length;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// No transaction was open.
				}
				log?.warn?.("history_record_failed", { error: error.message });
				return 0;
			}
		},

		/**
		 * The D19 findings of this tick: one per pending call of a live subagent that raised a signal. A call that already has
		 * a D1 stall finding is annotated with its signals instead (its investigation asks the analyst); a main session's call
		 * is only ever annotated this way, never given a D19 finding of its own. Silent until the
		 * history is past its cold start; at most anomaly.perHour calls are opened per hour.
		 */
		raise({ world, findings }) {
			const cfg = config.anomaly;
			const now = world.now;
			const out = [];
			if (!cfg?.enabled) return out;
			let completions;
			try {
				completions = completionCount(db);
			} catch (error) {
				log?.warn?.("anomaly_history_failed", { error: error.message });
				return out;
			}
			if (completions < COLD_START_COMPLETIONS) return out;
			while (opens.length && now - opens[0] >= HOUR_MS) opens.shift();
			const stalls = new Map(findings.filter((f) => f.detector === "D1" && f.kind === "stall" && f.subject?.toolCallId).map((f) => [f.subject.toolCallId, f]));
			const pendingIds = new Set();
			for (const session of world.sessions.values()) {
				if ((session.kind !== "child" && session.kind !== "main") || isLane(session.id) || !world.isSessionLive(session)) continue;
				if (session.task?.terminal && (session.task.terminalAtMs ?? 0) <= now) continue;
				for (const call of session.pending?.values?.() ?? []) {
					pendingIds.add(call.id);
					const ageMs = now - call.ms;
					const entry = captured.get(call.id);
					if (ageMs < MIN_PENDING_MS || !entry?.shell) continue;
					const found = signals({
						pending: { ageMs, shapeKey: entry.shapeKey, lineageFp: entry.lineageFp, lineage: entry.lineage },
						procs: entry.tree,
						shapeStats: (key) => cachedStats(key, now),
						lineageSeen: (fp) => lineageSeen(db, fp),
						completions,
						config: cfg,
					});
					let known = anomalies.get(call.id);
					const stall = stalls.get(call.id);
					if (stall && !known) {
						if (found.length) {
							const merged = new Map((stall.data?.signals ?? []).map((s) => [s.kind, s]));
							for (const s of found) if (!merged.has(s.kind)) merged.set(s.kind, { ...s, atMs: now });
							stall.data = { ...stall.data, signals: [...merged.values()] };
						}
						continue;
					}
					if (session.kind === "main") continue;
					if (!known) {
						if (!found.length) continue;
						if (opens.length >= cfg.perHour) {
							if (!capped.has(call.id)) {
								capped.add(call.id);
								log?.info?.("anomaly_capped", { callId: call.id, signals: found.map((s) => s.kind) });
							}
							continue;
						}
						known = { signals: new Map(), attached: new Set(), openedMs: now };
						anomalies.set(call.id, known);
						opens.push(now);
					}
					for (const s of found) if (!known.signals.has(s.kind)) known.signals.set(s.kind, { ...s, atMs: now });
					const command = commandText(call.name, call.args);
					const list = [...known.signals.values()];
					const finding = makeFinding({
						detector: ANOMALY_DETECTOR,
						kind: "anomaly",
						severity: "info",
						subject: { sessionId: session.id, taskId: session.taskId, parentSessionId: session.parentSessionId, rootSessionId: session.rootSessionId, hostPid: world.shellParentPid(session), toolCallId: call.id },
						evidence: list.map((s) => `signal:${s.kind}`),
						titleKo: `이상 징후: ${list.map((s) => SIGNAL_LABELS_KO[s.kind] ?? s.kind).join(", ")}`,
						detailKo: `${session.taskId ?? session.id}의 도구 호출이 ${Math.round(ageMs / 60_000)}분째 끝나지 않았고 일반 이상 신호가 있습니다: ${list.map((s) => `${s.kind}(${s.detail})`).join("; ")}`,
						data: {
							call: { id: call.id, name: call.name, commandHead: truncate(redact(command), 400), ms: call.ms, batchId: call.batchId },
							ageMs,
							signals: list,
							match: { state: "running", confidence: "high", reason: "anomaly-capture", rootPid: entry.rootPid, rootPath: entry.rootPath, tree: entry.tree, orphans: [] },
							sessionKind: session.kind,
							background: session.task?.backgroundMode,
							cwd: session.task?.spawnCwd ?? session.cwd,
							programs: entry.programs ?? [],
						},
					});
					known.fp = finding.fp;
					out.push(finding);
				}
			}
			for (const id of anomalies.keys()) if (!pendingIds.has(id)) anomalies.delete(id);
			return out;
		},

		/** Attach the signals an anomaly investigation has not heard of yet; returns what was attached. */
		annotate(investigations) {
			const attached = [];
			for (const known of anomalies.values()) {
				if (!known.fp || !investigations.get(known.fp)) continue;
				for (const s of known.signals.values()) {
					if (known.attached.has(s.kind)) continue;
					known.attached.add(s.kind);
					const inv = investigations.attach(known.fp, { signal: { kind: s.kind, detail: s.detail, atMs: s.atMs } });
					if (inv) attached.push({ fp: known.fp, kind: s.kind, status: inv.status });
				}
			}
			return attached;
		},
	};
}
