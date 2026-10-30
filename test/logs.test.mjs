import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EventWindow, LogCollector, parseDeferredNames } from "../src/collect/logs.mjs";
import { createTranscriptIndex } from "../src/collect/transcripts.mjs";
import { encodeClaudeProjectDir } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const line = (o) => `${JSON.stringify(o)}\n`;

test("log records become typed events and unknown events are counted", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "session.log"),
		line({ ts: "2026-09-23T15:47:05.230Z", level: "warn", event: "provider_error", kind: "error", error: "Provider is not configured: anthropic-subscription" }) +
			line({ ts: "2026-09-23T10:26:31.675Z", level: "info", event: "claude_sdk_oauth_session_continuity", kind: "flatten", reason: "model_changed", count: 148 }) +
			line({ ts: "2026-09-23T16:00:00Z", level: "warn", event: "brand_new_event" }),
	);
	fs.writeFileSync(path.join(dir, "fallback.log"), line({ ts: "2026-09-23T10:23:41.882Z", level: "info", event: "fallback_applied", from: "a", to: "b", chainKey: "a", reason: "hard-error" }));
	fs.writeFileSync(
		path.join(dir, "config-reload.log"),
		line({ ts: "2026-09-23T15:47:05.163Z", level: "info", event: "change_detected", paths: ["C:\\Users\\user\\.omo\\agent\\settings.json"] }) +
			line({ ts: "2026-09-23T15:50:00Z", level: "info", event: "reload_deferred", reason: "2 subagent(s) still running: CPA 연구, grep job... - wait for them to finish or cancel them (task_cancel) before reloading." }),
	);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const events = logs.drain(Date.parse("2026-09-23T15:48:00Z"));
	assert.deepEqual(
		events.map((e) => e.type),
		["fallback", "continuity", "change", "providerError"],
	);
	assert.equal(events[1].count, 148);
	assert.equal(logs.drain().length, 2, "later events stay queued until the clock reaches them");
	assert.equal(logs.stats.get("session.log").unknown, 1);
	assert.deepEqual(logs.stats.get("session.log").unknownCounts, { brand_new_event: 1 });
	assert.deepEqual(logs.stats.get("session.log").unknownFirstSeenMs, { brand_new_event: Date.parse("2026-09-23T16:00:00Z") });
});

test("extraKnown log events are not counted as unknown", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "session.log"), line({ ts: "2026-09-23T16:00:00Z", level: "info", event: "new_event" }));
	const logs = new LogCollector({ logsDir: dir, full: true, extraKnown: { "session.log": ["new_event"] } });
	logs.read();
	const stats = logs.stats.get("session.log");
	assert.equal(stats.unknown, 0);
	assert.deepEqual(stats.unknownCounts, {});
	assert.deepEqual(stats.unknownFirstSeenMs, {});
});

test("omo todo events in session.log are known by default", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "session.log"),
		line({ ts: "2026-09-23T16:00:00Z", level: "info", event: "todo_first_turn" }) +
			line({ ts: "2026-09-23T16:00:01Z", level: "info", event: "todo_owed_backstop_suppressed" }),
	);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const stats = logs.stats.get("session.log");
	assert.equal(stats.unknown, 0);
	assert.deepEqual(stats.unknownCounts, {});
});

test("reload_deferred reasons parse into task names", () => {
	assert.deepEqual(parseDeferredNames("1 subagent(s) still running: CPA 경유 시 omo 손해 8건... - wait for them to finish or cancel them (task_cancel) before reloading."), ["CPA 경유 시 omo 손해 8건..."]);
	assert.deepEqual(parseDeferredNames("something else"), []);
});

test("rotation of config-reload.log is followed", () => {
	const dir = tmpDir();
	const file = path.join(dir, "config-reload.log");
	fs.writeFileSync(file, line({ ts: "2026-09-23T15:00:00Z", event: "watcher_started" }).repeat(5));
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	assert.equal(logs.drain().length, 5);
	fs.renameSync(file, `${file}.1`);
	fs.writeFileSync(file, line({ ts: "2026-09-23T15:01:00Z", event: "change_detected", paths: [] }));
	logs.read();
	assert.deepEqual(logs.drain().map((e) => e.type), ["change"]);
});

test("event window keeps only recent events", () => {
	const w = new EventWindow(60_000);
	w.add([{ ms: 0, type: "a" }, { ms: 50_000, type: "b" }], 50_000);
	w.add([{ ms: 100_000, type: "a" }], 100_000);
	assert.deepEqual(w.all().map((e) => e.ms), [50_000, 100_000]);
	assert.equal(w.since(60_000, "a").length, 1);
});

test("transcript index recovers run_in_background for a senpi toolCall id", () => {
	const projects = tmpDir();
	const cwd = "C:\\dev\\omo\\omo-rollover";
	const dir = path.join(projects, encodeClaudeProjectDir(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const entry = {
		type: "assistant",
		message: { content: [{ type: "tool_use", id: "toolu_01Rqc81VFbba5QN7aSuWFNyp", name: "Bash", input: { command: "node mock-upstream.mjs > logs/mock.out 2>&1", run_in_background: true, description: "start mock" } }] },
	};
	fs.writeFileSync(path.join(dir, "01a0cea4.jsonl"), `${JSON.stringify({ type: "user", message: { content: "x" } })}\n${JSON.stringify(entry)}\n`);
	const index = createTranscriptIndex({ claudeProjectsDir: projects, clock: { now: () => Date.now() } });
	const found = index.find({ toolCallId: "toolu_01Rqc81VFbba5QN7aSuWFNyp", cwd, sinceMs: Date.now() - 3600_000 });
	assert.equal(found.runInBackground, true);
	assert.equal(found.tool, "Bash");
	assert.equal(index.find({ toolCallId: "toolu_missing", cwd, sinceMs: 0 }), null);
});

test("transcript index finds a tool_use across chunk boundaries and rescans only appended bytes", () => {
	const projects = tmpDir();
	const cwd = "C:\\dev\\proj";
	const dir = path.join(projects, encodeClaudeProjectDir(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "s.jsonl");
	const filler = `${JSON.stringify({ type: "user", message: { content: "x".repeat(97) } })}\n`.repeat(40);
	const toolUse = (id, background) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 1", run_in_background: background } }] } })}\n`;
	fs.writeFileSync(file, filler + toolUse("toolu_A", true) + filler);
	let now = 1_000_000;
	const index = createTranscriptIndex({ claudeProjectsDir: projects, clock: { now: () => now }, chunkBytes: 64 });
	assert.equal(index.find({ toolCallId: "toolu_A", cwd, sinceMs: 0 }).runInBackground, true, "a 64-byte chunk splits both the needle and the line");
	assert.equal(index.find({ toolCallId: "toolu_B", cwd, sinceMs: 0 }), null);
	fs.appendFileSync(file, toolUse("toolu_B", false));
	assert.equal(index.find({ toolCallId: "toolu_B", cwd, sinceMs: 0 }), null, "not-found is cached for 60 s");
	now += 60_001;
	assert.equal(index.find({ toolCallId: "toolu_B", cwd, sinceMs: 0 }).runInBackground, false, "the retry sees the appended line");
});

test("omo 2026.9.x session.log events are known by default", () => {
	const dir = tmpDir();
	const names = ["compaction_queue_enqueue", "claude_sdk_oauth_checkpoint_recovered", "claude_sdk_oauth_restored_transcript_orphan_tail", "resume_context_reduced", "session_title_failed"];
	fs.writeFileSync(path.join(dir, "session.log"), names.map((event, i) => line({ ts: `2026-09-29T16:00:0${i}Z`, level: "warn", event })).join(""));
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const stats = logs.stats.get("session.log");
	assert.equal(stats.unknown, 0);
	assert.deepEqual(stats.unknownCounts, {});
});

test("unknown events seen only at info or debug level are recorded but not counted as drift", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "session.log"),
		line({ ts: "2026-09-29T16:00:00Z", level: "info", event: "quiet_info" }) +
			line({ ts: "2026-09-29T16:00:01Z", level: "debug", event: "quiet_debug" }) +
			line({ ts: "2026-09-29T16:00:02Z", level: "info", event: "quiet_info" }),
	);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const stats = logs.stats.get("session.log");
	assert.equal(stats.unknown, 0);
	assert.deepEqual([...stats.unknownNames].sort(), ["quiet_debug", "quiet_info"]);
	assert.deepEqual(stats.unknownCounts, { quiet_info: 2, quiet_debug: 1 });
	assert.deepEqual([...stats.unknownLoudNames], []);
});

test("unknown events at warn or error level, without a level, and malformed lines still count", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "session.log"),
		line({ ts: "2026-09-29T16:00:00Z", level: "info", event: "mixed_event" }) +
			line({ ts: "2026-09-29T16:00:01Z", level: "error", event: "mixed_event" }) +
			line({ ts: "2026-09-29T16:00:02Z", level: "warn", event: "loud_warn" }) +
			line({ ts: "2026-09-29T16:00:03Z", event: "no_level" }) +
			line({ ts: "2026-09-29T16:00:04Z", level: "info", event: "quiet_only" }) +
			"{ not json\n",
	);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const stats = logs.stats.get("session.log");
	assert.equal(stats.unknown, 3, "a name that ever logs above info stays loud; only its info lines are free");
	assert.deepEqual([...stats.unknownLoudNames].sort(), ["loud_warn", "mixed_event", "no_level"]);
	assert.ok(stats.unknownNames.has("quiet_only"));
	assert.equal(stats.bad, 1);
});

test("senpi circuit breaker events in fallback.log are known by default", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "fallback.log"),
		line({ ts: "2026-09-29T11:34:03Z", level: "info", event: "circuit_opened", selector: "anthropic/claude-x", durationMs: 60000 }) +
			line({ ts: "2026-09-29T11:34:04Z", level: "info", event: "circuit_open_skip", selector: "anthropic/claude-x" }) +
			line({ ts: "2026-09-29T11:34:05Z", level: "info", event: "circuit_opened", selector: "openai/gpt-x", durationMs: 30000 }),
	);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	const stats = logs.stats.get("fallback.log");
	assert.equal(stats.lines, 3);
	assert.equal(stats.unknown, 0);
	assert.deepEqual([...stats.unknownNames], [], "not even a quiet unknown-events finding");
	assert.deepEqual(stats.unknownCounts, {});
});

test("senpi 2026.10.x log events (omo 5.1.44-5.1.48) are known by default", () => {
	const dir = tmpDir();
	const write = (file, records) => fs.writeFileSync(path.join(dir, file), records.map(([level, event], i) => line({ ts: `2026-10-28T10:00:${String(i).padStart(2, "0")}Z`, level, event })).join(""));
	write("session.log", [
		["warn", "compaction_model_fallback"],
		["warn", "resume_turn_send_failed"],
		["warn", "held_command_failed"],
		["warn", "run_resume_settle_failed"],
		["warn", "session_hold_changed_failed"],
		["warn", "queued_input_outlived_run"],
		["warn", "extension_handler_stalled"],
		["warn", "turn_deadline_unsettled"],
		["info", "model_change"],
		["info", "request_shape_recovery"],
	]);
	write("fallback.log", [["info", "refusal_pin_released"]]);
	write("config-reload.log", [
		["warn", "registration_rejected"],
		["warn", "reload_loop_stopped"],
		["error", "watcher_error"],
		["debug", "generated_shim_change_suppressed"],
		["info", "registration_removed"],
	]);
	const logs = new LogCollector({ logsDir: dir, full: true });
	logs.read();
	for (const source of ["session.log", "fallback.log", "config-reload.log"]) {
		const stats = logs.stats.get(source);
		assert.equal(stats.unknown, 0, source);
		assert.deepEqual([...stats.unknownNames], [], source);
	}
});
