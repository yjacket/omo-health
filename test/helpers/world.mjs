import { EventWindow } from "../../src/collect/logs.mjs";
import { normalizeRows, ProcessTracker } from "../../src/collect/procs.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { buildWorld } from "../../src/state.mjs";

function deepMerge(base, over) {
	if (!over) return base;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? deepMerge(base[k], v) : v;
	return out;
}

/** A session state with every field detectors read, defaults filled in. */
export function sessionState(partial = {}) {
	const pending = new Map();
	for (const call of partial.pendingCalls ?? []) pending.set(call.id, { batchId: "b1", index: 0, batchSize: 1, args: {}, ...call });
	return {
		id: partial.id ?? "s1",
		file: partial.file ?? `C:/tmp/${partial.id ?? "s1"}.jsonl`,
		kind: partial.kind ?? "main",
		cwd: partial.cwd ?? "C:\\dev\\proj",
		startedMs: partial.startedMs,
		taskId: partial.taskId,
		parentSessionId: partial.parentSessionId,
		rootSessionId: partial.rootSessionId,
		hostPid: partial.hostPid,
		lastEntryMs: partial.lastEntryMs,
		lastActivityMs: partial.lastActivityMs,
		lastMessage: partial.lastMessage,
		lastAssistant: partial.lastAssistant,
		lastUser: partial.lastUser,
		pending,
		resolved: partial.resolved ?? new Map(),
		abandoned: 0,
		turns: partial.turns ?? [],
		toolHistory: partial.toolHistory ?? [],
		writes: partial.writes ?? [],
		commands: partial.commands ?? [],
		errors: partial.errors ?? [],
		custom: partial.custom ?? new Map(),
		healthMessages: partial.healthMessages ?? [],
		parsedLines: partial.parsedLines ?? 10,
		badLines: partial.badLines ?? 0,
		task: partial.task,
	};
}

/** A normalized task record (see src/collect/tasks.mjs normalizeTask). */
export function taskRecord(partial = {}) {
	const status = partial.status ?? "running";
	return {
		taskId: "st_x",
		status,
		residency: "resident",
		parentSessionId: "p1",
		rootSessionId: "p1",
		executionMode: "in-process",
		backgroundMode: "background",
		hostPid: 4000,
		childSessionId: "c1",
		name: "st_x",
		summary: "task",
		spawnCwd: "C:\\dev\\proj",
		active: ["running", "queued", "pending", "starting"].includes(status),
		terminal: ["completed", "error", "cancelled", "interrupted", "lost"].includes(status),
		...partial,
	};
}

/**
 * Build a world for detector tests.
 * options.procSnapshots: [{takenAtMs, rows:[raw ps rows {p,pp,n,c,cpu,pv,cl,wv?,wt?}]}] fed in order.
 */
export function makeWorld(options = {}) {
	const now = options.now ?? Date.parse("2026-09-23T16:00:00Z");
	const config = deepMerge(DEFAULT_CONFIG, options.config);
	const tracker = new ProcessTracker();
	let procs;
	for (const snap of options.procSnapshots ?? []) procs = tracker.update({ takenAtMs: snap.takenAtMs, rows: normalizeRows(snap.rows) });
	const sessions = new Map();
	for (const s of options.sessions ?? []) sessions.set(s.id, s);
	const events = new EventWindow(24 * 3600_000);
	if (options.events) events.add(options.events, now);
	return buildWorld({
		now,
		config,
		paths: options.paths,
		registry: { sessions, tasks: options.tasks ?? [...sessions.values()].map((s) => s.task).filter(Boolean) },
		procs,
		os: options.os,
		ports: options.ports,
		events,
		newEvents: options.newEvents ?? [],
		sensors: new Map((options.sensors ?? []).map((hb) => [hb.sessionId, hb])),
		configState: options.configState,
		secrets: options.secrets,
		versions: options.versions,
		self: options.self ?? { pid: 1 },
		attributed: options.attributed,
		intentFor: options.intentFor,
		fileProbe: options.fileProbe,
		terminalManifest: options.terminalManifest,
		goalStore: options.goalStore,
		workOf: options.workOf,
		downtime: options.downtime,
		hostExits: options.hostExits,
		parkRecords: options.parkRecords,
		procsFresh: options.procsFresh,
	});
}

export const raw = (p, pp, n, c, cpu = 0, pv = 0, cl = "") => ({ p, pp, n, c, cpu, pv, ws: pv, cl });

/**
 * A step ledger (see SessionTracker.state.steps) where one todo has been in progress for `count` steps that
 * cycle fix -> rerun -> review, `gapMs` apart, the last one two minutes before `now`.
 */
export function cyclingSteps(now, { todo = "Fix X", count = 14, gapMs = 120_000 } = {}) {
	const texts = ["Fix X in the parser", "Rerun the parser tests", "Review the parser diff"];
	const first = now - 2 * gapMs - (count - 1) * gapMs;
	const steps = [{ ms: first - gapMs, tool: "todo", kind: "start", text: todo }];
	for (let i = 0; i < count; i++) steps.push({ ms: first + i * gapMs, tool: "eval", kind: "eval", text: texts[i % texts.length] });
	return steps;
}
