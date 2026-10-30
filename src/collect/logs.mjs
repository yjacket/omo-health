import path from "node:path";
import { JsonlTail } from "../util/tail.mjs";
import { toMs } from "../util/time.mjs";

/** Event names seen in omo 5 / senpi 2026.9.x logs (F-9). Anything else counts as drift. */
export const KNOWN_EVENTS = {
	"session.log": new Set([
		"claude_sdk_oauth_session_continuity",
		"claude_sdk_oauth_session_close",
		"claude_sdk_oauth_session_auth",
		"provider_error",
		"queue_enqueue",
		"compaction_start",
		"compaction_decision",
		"compaction_queue_restored",
		"todo_first_turn",
		"todo_owed_backstop_suppressed",
		"compaction_queue_enqueue",
		"claude_sdk_oauth_checkpoint_recovered",
		"claude_sdk_oauth_restored_transcript_orphan_tail",
		"resume_context_reduced",
		"session_title_failed",
		// senpi 2026.10.x (omo 5.1.44-5.1.48), info/debug: routine records.
		"model_change",
		"cursor_context_window_observed",
		"cursor_admission_truncated",
		"request_shape_recovery",
		"tool_placement_pinned",
		"tool_dispatch_observer_failed",
		// senpi 2026.10.x, warn: a step failed or was cut short. Known, so none counts as format drift.
		"clipboard_error",
		"compaction_queue_deferred",
		"compaction_model_fallback",
		"cursor_admission_over_budget",
		"external_delivery_start_failed",
		"offload_module_stuck",
		"engine_turn_record_write_failed",
		"prompt_rejected",
		"transcript_write_failed",
		"tool_dispatcher_close_failed",
		"tool_child_close_failed",
		"human_input_listener_failed",
		"resume_turn_send_failed",
		"held_command_failed",
		"run_resume_settle_failed",
		"session_hold_changed_failed",
		"lifecycle_goal_read_failed",
		"queued_input_outlived_run",
		"pending_input_clear_unrecorded",
		"abort_delivery_release_failed",
		"abort_release_failed",
		"input_release_settle_failed",
		"extension_handler_stalled",
		"turn_deadline_failed",
		"turn_deadline_record_failed",
		"turn_deadline_abort_failed",
		"turn_deadline_unsettled",
		"goal_continuation_record_write_failed",
	]),
	"fallback.log": new Set([
		"cooldown_noted",
		"fallback_applied",
		"fallback_reverted",
		"candidate_skipped",
		"fallback_cleared_manual",
		"no_chain",
		"validation_warning",
		"candidates_exhausted",
		// senpi's per-selector circuit breaker (core/retry-fallback/circuit.js, controller.js); it logs no closing event.
		"circuit_opened",
		"circuit_open_skip",
		// senpi 2026.10.x, info.
		"refusal_pin_released",
	]),
	"config-reload.log": new Set([
		"reload_deferred",
		"reload_requested",
		"routine_settings_change_suppressed",
		"watcher_started",
		"reload_completed",
		"self_write_suppressed",
		"change_detected",
		"registration_added",
		"validation_rejected",
		// senpi 2026.10.x: debug/info records, then warn/error ones.
		"registration_removed",
		"registration_rejection_suppressed",
		"generated_shim_change_suppressed",
		"registration_rejected",
		"reload_loop_stopped",
		"watcher_error",
	]),
};

/**
 * Levels at which an unknown event is only noise. omo adds informational events with every release, and nothing
 * consumes them, so they are listed for the operator but never count as drift. Any other level (warn, error,
 * or none at all) may mean a changed failure format the detectors cannot see.
 */
const QUIET_LEVELS = new Set(["info", "debug"]);
const MAX_UNKNOWN_NAMES = 20;

const DEFERRED_RE = /^\s*\d+\s+subagent\(s\)\s+still running:\s*(.*?)(?:\s+-\s+wait for them.*)?$/s;

/** "N subagent(s) still running: A, B - wait for them ..." -> ["A", "B"] */
export function parseDeferredNames(reason) {
	const match = DEFERRED_RE.exec(String(reason ?? ""));
	if (!match) return [];
	return match[1]
		.split(/,\s+/)
		.map((name) => name.trim())
		.filter(Boolean);
}

/** Map one raw log record to a typed event. */
export function normalizeLogRecord(source, record) {
	const ms = toMs(record.ts);
	const base = { src: source, ms, level: record.level, event: record.event, ...(typeof record.sessionId === "string" && record.sessionId ? { sessionId: record.sessionId } : {}) };
	switch (record.event) {
		case "claude_sdk_oauth_session_continuity":
			return { ...base, type: "continuity", kind: record.kind, reason: record.reason, count: record.count };
		case "claude_sdk_oauth_session_close":
			return { ...base, type: "close", reason: record.reason };
		case "provider_error":
			return { ...base, type: "providerError", error: String(record.error ?? "") };
		case "cooldown_noted":
			return { ...base, type: "cooldown", selector: record.selector, error: String(record.errorMessage ?? "") };
		case "fallback_applied":
			return { ...base, type: "fallback", from: record.from, to: record.to, reason: record.reason, chainKey: record.chainKey };
		case "change_detected":
			return { ...base, type: "change", paths: Array.isArray(record.paths) ? record.paths : [], deferred: record.deferred };
		case "reload_deferred":
			return { ...base, type: "reloadDeferred", reason: record.reason, names: parseDeferredNames(record.reason) };
		case "reload_completed":
			return { ...base, type: "reloadCompleted" };
		case "compaction_start":
			return { ...base, type: "compaction" };
		default:
			return { ...base, type: "other" };
	}
}

/**
 * Tails the three omo logs. Records are queued and released up to the clock
 * so live mode, scan mode and replay share one path.
 */
export class LogCollector {
	constructor({ logsDir, tailBytes = 1024 * 1024, full = false, extraKnown = {} }) {
		this.sources = ["session.log", "fallback.log", "config-reload.log"].map((name) => ({
			name,
			tail: new JsonlTail(path.join(logsDir, name), { startTailBytes: full ? null : tailBytes }),
		}));
		this.extraKnown = extraKnown;
		this.queue = [];
		this.stats = new Map(this.sources.map((s) => [s.name, { lines: 0, bad: 0, unknown: 0, unknownNames: new Set(), unknownLoudNames: new Set(), unknownCounts: {}, unknownFirstSeenMs: {} }]));
	}

	/** Records of these sessions (a live Set of the analyst's lane session ids) are skipped before anything counts or detects them. */
	setExcludedSessions(sessionIds) {
		this.excludedSessions = sessionIds;
	}

	setExtraKnown(map) {
		this.extraKnown = map ?? {};
		for (const [source, stats] of this.stats) {
			for (const name of this.extraKnown[source] ?? []) {
				stats.unknownNames.delete(name);
				stats.unknownLoudNames.delete(name);
				delete stats.unknownCounts[name];
				delete stats.unknownFirstSeenMs[name];
			}
		}
	}

	read() {
		for (const source of this.sources) {
			const stats = this.stats.get(source.name);
			let guard = 0;
			while (guard++ < 64) {
				const result = source.tail.readNew();
				stats.bad += result.badLines;
				for (const record of result.entries) {
					if (record && typeof record.sessionId === "string" && this.excludedSessions?.has(record.sessionId)) continue;
					stats.lines += 1;
					if (!record || typeof record.event !== "string") {
						stats.bad += 1;
						continue;
					}
					if (!(KNOWN_EVENTS[source.name].has(record.event) || this.extraKnown[source.name]?.includes(record.event))) {
						const loud = !QUIET_LEVELS.has(record.level);
						if (loud) stats.unknown += 1;
						// The cap is per group so a flood of info-level names can never crowd out a loud one.
						const groupSize = loud ? stats.unknownLoudNames.size : stats.unknownNames.size - stats.unknownLoudNames.size;
						if (stats.unknownNames.has(record.event) || groupSize < MAX_UNKNOWN_NAMES) {
							stats.unknownNames.add(record.event);
							if (loud) stats.unknownLoudNames.add(record.event);
							stats.unknownCounts[record.event] = (stats.unknownCounts[record.event] ?? 0) + 1;
							if (!Object.hasOwn(stats.unknownFirstSeenMs, record.event)) stats.unknownFirstSeenMs[record.event] = toMs(record.ts);
						}
					}
					this.queue.push(normalizeLogRecord(source.name, record));
				}
				if (!result.more) break;
			}
		}
		this.queue.sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
	}

	/** Remove and return queued events with ms <= nowMs. */
	drain(nowMs = Number.POSITIVE_INFINITY) {
		let index = 0;
		while (index < this.queue.length && (this.queue[index].ms ?? 0) <= nowMs) index += 1;
		return this.queue.splice(0, index);
	}
}

/** Rolling window of recent log events (default 6 h) for detectors. */
export class EventWindow {
	constructor(windowMs = 6 * 3600_000) {
		this.windowMs = windowMs;
		this.events = [];
	}

	add(events, nowMs) {
		for (const event of events) this.events.push(event);
		const cutoff = nowMs - this.windowMs;
		let drop = 0;
		while (drop < this.events.length && (this.events[drop].ms ?? 0) < cutoff) drop += 1;
		if (drop) this.events.splice(0, drop);
	}

	since(ms, type) {
		return this.events.filter((event) => (event.ms ?? 0) >= ms && (!type || event.type === type));
	}

	all(type) {
		return type ? this.events.filter((event) => event.type === type) : this.events;
	}
}
