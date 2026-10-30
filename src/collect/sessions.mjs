import fs from "node:fs";
import path from "node:path";
import { promotedTodo } from "../align/steps.mjs";
import { redirectTargets } from "../detect/classify.mjs";
import { listDirSafe, statSafe } from "../util/fsx.mjs";
import { JsonlTail } from "../util/tail.mjs";
import { redact, sha1, truncate } from "../util/text.mjs";
import { toMs } from "../util/time.mjs";
import { readGoal, readUlwGoals } from "./anchors.mjs";
import { createTaskStoreReader, findChildSessionFile, senpiTaskStoreDir } from "./tasks.mjs";

const HISTORY = 200;
const STEPS = 200;
/** Finished calls a tracker holds until the engine drains them (one drain per tick). */
const COMPLETIONS = 1000;
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "notebookedit"]);
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
const SHELL_WRITE = /\b(rm|mv|cp|del|mkdir|rmdir|git\s+(commit|push|reset|checkout|merge|rebase|stash)|npm\s+(install|i)\b|pnpm\s+add|pip\s+install|Set-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item)\b/i;
const EVAL_WRITE = /writeFile|appendFile|unlink|rmSync|mkdirSync|renameSync|Bun\.write|open\(.*['"]w/;
const CHECK_COMMAND = /(npm\s+test|node\s+--test|pytest|vitest|jest|tsc|eslint|ruff|mypy|cargo\s+test|go\s+test)/i;
// Exit codes as eval cells report them ({"exit":1}, spawnSync status, tool.bash's "exited with code 1") count too:
// omo agents run most checks inside eval, whose tool result is not an error when the check fails.
const CHECK_FAILURE = /\b\d+\s+(failed|failing)\b|\bFAIL\b|✖|AssertionError|Traceback|"(?:exit|exitCode|exit_code)":\s*[1-9]\d{0,2}\b|"status":\s*[1-9]\b|exit(?:ed)? (?:with )?code [1-9]\d{0,2}\b|[ℹ#] fail [1-9]\d*/;
// Messages that start agent work without the user (goal continuations, wakes, task results, notifications, nudges).
const AUTO_CONTINUATION = /^(goal-continuation|omo-senpi:(wake|ulw-continuation)|senpi-task\.completion|[\w-]+:notification|omo-desk|omo-health)$/;
/** Custom entries that mark agent progress: a finished child task or a monitor notification. */
const PROGRESS_CUSTOM = /^(senpi-task\.completion|(?!omo-)[\w-]+:notification)$/;
const TODO_TOTAL = /Overall:\s*(\d+)\/(\d+) done,\s*(\d+) open/;
const TODO_OPEN = /^\s*- \[ \] (.+)$|^\s*- (.+) \[(?:pending|in_progress)\]/;

/** The same check run again: the command without leading `cd <dir> &&` hops, digits folded, 120 chars. */
export function checkKey(command) {
	return String(command ?? "").replace(/^\s*(?:(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/i, "").slice(0, 120).replace(/\d/g, "#");
}

function freshActivity(sinceMs) {
	return { sinceMs, toolCalls: 0, mutations: 0, files: new Map(), failingChecks: new Map(), failTimes: new Map(), taskSpawns: [], lastTodo: null };
}

/** A restart cannot recover earlier tool calls from a tail read; these counters are lower bounds. */
function seedActivity(alignmentDir, id) {
	if (!alignmentDir) return freshActivity(undefined);
	try {
		const data = JSON.parse(fs.readFileSync(path.join(alignmentDir, `${id}.json`), "utf8"));
		const saved = data.activity ?? data;
		const activity = freshActivity(saved.sinceMs);
		for (const key of ["toolCalls", "mutations", "mutationsBeforeAuto"]) if (Number.isFinite(saved[key])) activity[key] = saved[key];
		for (const [name, value] of (Array.isArray(saved.files) ? saved.files : Object.entries(saved.files ?? {})).slice(0, 200)) activity.files.set(name, value);
		for (const [key, count] of (Array.isArray(saved.failingChecks) ? saved.failingChecks : Object.entries(saved.failingChecks ?? {}))) activity.failingChecks.set(key, count);
		activity.taskSpawns = (saved.taskSpawns ?? []).slice(-50);
		activity.lastTodo = saved.lastTodo ?? null;
		return activity;
	} catch {
		return freshActivity(undefined);
	}
}

/** Read only the head, even when the live tail starts in the middle of a long session. */
function firstUserFromHead(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(256 * 1024);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const head = buf.subarray(0, n).toString("utf8");
		for (const line of head.slice(0, head.lastIndexOf("\n") + 1).split("\n")) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message?.role === "user") return truncate(redact(textOf(entry.message.content)), 1000);
			} catch { /* Partial or malformed JSONL line. */ }
		}
	} catch { /* Session file may have disappeared. */ }
	finally { if (fd !== undefined) fs.closeSync(fd); }
	return undefined;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

/** senpi's todo tool state (custom entry "senpi.todo-state", schema v2: phases[].tasks[].status); it survives new user turns. */
function todoStateOf(data, ms) {
	const tasks = (Array.isArray(data?.phases) ? data.phases : []).flatMap((phase) => (Array.isArray(phase?.tasks) ? phase.tasks : []));
	return { ms, total: tasks.length, open: tasks.filter((task) => task?.status === "pending" || task?.status === "in_progress").length };
}

function pushCapped(list, item, cap = HISTORY) {
	list.push(item);
	if (list.length > cap) list.splice(0, list.length - cap);
}

/** The session header is the first line; read at most 64 KB, never the whole file. */
export function readSessionHeader(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(65536);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const text = buf.subarray(0, n).toString("utf8");
		const end = text.indexOf("\n");
		const entry = JSON.parse(end >= 0 ? text.slice(0, end) : text);
		return entry?.type === "session" ? entry : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Paths a tool call writes to (edit/write/apply_patch); used by off-track detection. */
export function writeTargets(name, args) {
	const lower = String(name || "").toLowerCase();
	const out = [];
	if (WRITE_TOOLS.has(lower)) {
		const p = args?.path ?? args?.file_path ?? args?.filePath;
		if (typeof p === "string") out.push(p);
	}
	if (lower.includes("apply_patch") || lower.includes("apply-patch")) {
		const patch = String(args?.input ?? args?.patch ?? "");
		for (const match of patch.matchAll(PATCH_FILE_RE)) out.push(match[1].trim());
	}
	return out;
}

/** Files a call changes, for the activity counters: write tools plus shell redirects (D7/D14 read redirects from `commands`, not here). */
function activityTargets(name, args) {
	const out = writeTargets(name, args);
	if (name === "bash" || name === "shell" || name === "powershell") out.push(...redirectTargets(args?.command));
	if (name === "eval" && args?.tool?.bash) out.push(...redirectTargets(args.tool.bash));
	return out;
}

/** Command-like text of a tool call (bash command, eval code). */
export function commandText(name, args) {
	const lower = String(name || "").toLowerCase();
	if (lower === "bash" || lower === "shell" || lower === "powershell") return String(args?.command ?? "");
	if (lower === "eval") return String(args?.code ?? "");
	return "";
}

/**
 * Incremental state of one senpi session JSONL (F-6). Entries are queued as
 * they are read and applied only up to the clock, so replay and scan reuse the
 * same code path as the live daemon.
 */
export class SessionTracker {
	constructor({ file, kind = "main", meta = {}, tailBytes = null, alignmentDir }) {
		this.file = file;
		this.kind = kind;
		this.meta = meta;
		this.tail = new JsonlTail(file, { startTailBytes: tailBytes });
		this.queue = [];
		this.header = readSessionHeader(file);
		const id = meta.sessionId ?? this.header?.id ?? idFromFileName(file);
		this.pendingFailures = new Map();
		/** Tool calls whose result arrived, for the history recorder: `{id, sessionId, taskId, kind, tool, startMs, endMs, isError, commandHead}`. */
		this.completions = [];
		/** Todo titles finished so far and the one in progress: `start` of a finished title is a reopen. */
		this.todoDone = new Set();
		this.currentTodo = undefined;
		this.state = {
			id,
			file,
			kind,
			/** Display name of the last session_info entry, if any. */
			title: undefined,
			cwd: this.header?.cwd ?? meta.cwd,
			startedMs: toMs(this.header?.timestamp),
			taskId: meta.taskId,
			parentSessionId: meta.parentSessionId,
			rootSessionId: meta.rootSessionId,
			hostPid: meta.hostPid,
			lastEntryMs: undefined,
			/** Last conversation entry (message or custom_message); extension state records ("custom") are not activity. */
			lastActivityMs: undefined,
			lastMessage: undefined,
			lastAssistant: undefined,
			lastUser: undefined,
			pending: new Map(),
			resolved: new Map(),
			abandoned: 0,
			turns: [],
			userTurns: [],
			firstUserText: firstUserFromHead(file),
			activity: tailBytes === null ? freshActivity(undefined) : seedActivity(alignmentDir, id),
			anchor: null,
			toolHistory: [],
			/** Step ledger (ts, tool, kind, one-line text). Unlike `activity` it survives user turns: goal continuations are turns too. */
			steps: [],
			writes: [],
			commands: [],
			errors: [],
			custom: new Map(),
			healthMessages: [],
			todoState: undefined,
			parsedLines: 0,
			badLines: 0,
		};
	}

	/** Read newly appended lines into the queue. */
	read() {
		const result = this.tail.readNew();
		this.state.badLines += result.badLines;
		for (const entry of result.entries) {
			const ms = entryMs(entry);
			this.queue.push({ entry, ms });
		}
		return result;
	}

	/** Apply queued entries whose timestamp is <= nowMs. */
	advance(nowMs = Number.POSITIVE_INFINITY) {
		let applied = 0;
		while (this.queue.length && (this.queue[0].ms === undefined || this.queue[0].ms <= nowMs)) {
			const { entry, ms } = this.queue.shift();
			this.apply(entry, ms);
			applied += 1;
		}
		return applied;
	}

	apply(entry, ms) {
		const s = this.state;
		s.parsedLines += 1;
		if (ms !== undefined) s.lastEntryMs = Math.max(s.lastEntryMs ?? 0, ms);
		if (ms !== undefined && (entry.type === "message" || entry.type === "custom_message")) s.lastActivityMs = Math.max(s.lastActivityMs ?? 0, ms);
		if (entry.type === "session") {
			s.id = this.meta.sessionId ?? entry.id ?? s.id;
			s.cwd = entry.cwd ?? s.cwd;
			s.startedMs = toMs(entry.timestamp) ?? s.startedMs;
			return;
		}
		if (entry.type === "session_info") {
			// A rename writes a new session_info entry; the last one wins.
			if (typeof entry.name === "string") s.title = truncate(redact(entry.name), 120);
			return;
		}
		if (entry.type === "custom_message" || entry.type === "custom") {
			const type = entry.customType ?? "?";
			s.custom.set(type, ms);
			// A resumed session's host starts fresh: calls the previous host left without a result never get one (senpi repairs the pairs at the next request).
			// A session-binding entry is not a signal: senpi also writes it after a reload by the same, still running host.
			if (type === "pi-rules.scan" && (entry.data ?? entry.details)?.reason === "resume") this.abandonPending();
			// Work after the first automatic continuation answers the continuation, not the user's request (D15 overstep).
			const activity = s.activity;
			if (entry.type === "custom_message" && AUTO_CONTINUATION.test(type) && activity.mutationsBeforeAuto === undefined && Number.isFinite(activity.sinceMs) && ms > activity.sinceMs + 2000) activity.mutationsBeforeAuto = activity.mutations;
			if (type === "omo-health") pushCapped(s.healthMessages, { ms, details: entry.details ?? entry.data ?? {} }, 50);
			if (type === "senpi.todo-state") s.todoState = todoStateOf(entry.data, ms);
			if (Number.isFinite(ms) && PROGRESS_CUSTOM.test(type)) {
				const first = textOf(entry.content).split(/\r?\n/)[0];
				if (first.trim()) pushCapped(s.steps, { ms, tool: type, kind: "progress", text: truncate(first, 120) }, STEPS);
			}
			return;
		}
		if (entry.type !== "message" || !entry.message) return;
		const m = entry.message;
		const role = m.role;
		if (role === "assistant") this.applyAssistant(entry, m, ms);
		else if (role === "toolResult") this.applyToolResult(m, ms);
		else if (role === "user") {
			this.abandonPending();
			const text = textOf(m.content);
			if (s.firstUserText === undefined) s.firstUserText = truncate(redact(text), 1000);
			pushCapped(s.userTurns, { ms, text: truncate(redact(text), 400) }, 20);
			s.activity = freshActivity(ms);
			this.pendingFailures.clear();
			s.lastUser = { ms, textHead: truncate(redact(text), 300) };
		}
		s.lastMessage = { role, ms, stopReason: m.stopReason, errorMessage: m.errorMessage, toolCallId: m.toolCallId };
	}

	abandonPending() {
		if (this.state.pending.size) {
			this.state.abandoned += this.state.pending.size;
			this.state.pending.clear();
		}
	}

	applyAssistant(entry, m, ms) {
		const s = this.state;
		this.abandonPending();
		const content = Array.isArray(m.content) ? m.content : [];
		// senpi never runs the tool calls of an aborted or failed reply (repair-tool-pairs, replay-assistant-tools).
		const calls = m.stopReason === "aborted" || m.stopReason === "error" ? [] : content.filter((item) => item && item.type === "toolCall");
		const startMs = Number.isFinite(m.timestamp) ? m.timestamp : undefined;
		const usage = m.usage;
		if (usage && typeof usage === "object") {
			const durMs = startMs !== undefined && ms !== undefined ? ms - startMs : undefined;
			const output = Number(usage.output ?? 0);
			pushCapped(s.turns, {
				ms,
				startMs,
				durMs,
				provider: m.provider,
				model: m.model,
				input: Number(usage.input ?? 0),
				output,
				cacheRead: Number(usage.cacheRead ?? 0),
				cacheWrite: Number(usage.cacheWrite ?? 0),
				cost: Number(usage.cost?.total ?? 0),
				stopReason: m.stopReason,
				tps: durMs && durMs > 0 ? output / (durMs / 1000) : undefined,
			});
		}
		if (m.stopReason === "error") pushCapped(s.errors, { ms, text: truncate(redact(m.errorMessage ?? textOf(content)), 300), provider: m.provider, model: m.model }, 100);
		calls.forEach((call, index) => {
			const args = call.arguments ?? {};
			const activity = s.activity;
			activity.toolCalls++;
			const name = String(call.name ?? "").toLowerCase();
			this.recordStep(name, args, ms);
			const command = commandText(name, args);
			const paths = activityTargets(name, args);
			const mutation = WRITE_TOOLS.has(name) || name.includes("apply_patch") || name.includes("apply-patch")
				|| ((name === "bash" || name === "shell" || name === "powershell") && (paths.length > 0 || SHELL_WRITE.test(command)))
				|| (name === "eval" && (paths.length > 0 || EVAL_WRITE.test(command)));
			if (mutation) {
				activity.mutations++;
				for (const target of new Set(paths)) {
					let file = activity.files.get(target);
					if (!file && activity.files.size < 200) {
						file = { edits: 0, rounds: 0, failsBetween: 0, firstMs: ms, lastMs: ms };
						activity.files.set(target, file);
					}
					if (!file) continue;
					file.edits++;
					file.lastMs = ms;
					if (file.lastRound !== (entry.id ?? entry)) {
						if (file.rounds) file.failsBetween += this.pendingFailures.get(target) ?? 0;
						this.pendingFailures.set(target, 0);
						file.rounds++;
						file.lastRound = entry.id ?? entry;
					}
				}
			}
			if (name === "task") {
				for (const item of Array.isArray(args.tasks) ? args.tasks : [args]) {
					const summary = item?.task_summary ?? item?.description ?? item?.prompt?.slice(0, 120);
					pushCapped(activity.taskSpawns, { ms, summary, agent: item?.subagent_type ?? null }, 50);
				}
			}
			s.pending.set(call.id, { id: call.id, name: call.name, args, ms, batchId: entry.id, index, batchSize: calls.length });
			pushCapped(s.toolHistory, { id: call.id, ms, name: call.name, argsHash: sha1(JSON.stringify(args)), isError: undefined, errHead: undefined });
			for (const target of writeTargets(call.name, args)) pushCapped(s.writes, { ms, tool: call.name, path: target, id: call.id });
			const text = commandText(call.name, args);
			if (text) pushCapped(s.commands, { ms, tool: call.name, text: truncate(redact(text), 4000), id: call.id }, 100);
		});
		s.lastAssistant = {
			ms,
			startMs,
			stopReason: m.stopReason,
			errorMessage: m.errorMessage,
			provider: m.provider,
			model: m.model,
			textHead: truncate(redact(textOf(content)), 600),
			toolCalls: calls.length,
			entryId: entry.id,
		};
	}

	/**
	 * Append what a tool call says about its own purpose to the step ledger: the one-line `summary` of an eval,
	 * a subagent's `task_summary`, the goal text, and todo start/done (the exact progress markers; `start` of a
	 * finished title is a reopen). Calls without such text (edit, read, bash) leave no step.
	 */
	recordStep(name, args, ms) {
		if (!Number.isFinite(ms)) return;
		const s = this.state;
		const push = (kind, text, extra) => {
			if (typeof text === "string" && text.trim()) pushCapped(s.steps, { ms, tool: name, kind, text: truncate(redact(text.trim()), 160), ...extra }, STEPS);
		};
		if (name === "eval") push("eval", args.summary);
		else if (name === "create_goal") push("goal", args.objective);
		else if (name === "task") {
			for (const item of Array.isArray(args.tasks) ? args.tasks : [args]) push("task", item?.task_summary ?? item?.description ?? item?.prompt?.slice(0, 120), { agent: item?.subagent_type ?? null });
		} else if (name === "todo") {
			if (args.op === "init") push("plan", (Array.isArray(args.list) ? args.list.flatMap((phase) => phase?.items ?? []) : args.items ?? []).join("; "));
			else if (args.op === "start" && args.task) {
				push(this.todoDone.delete(args.task) ? "reopen" : "start", args.task);
				this.currentTodo = args.task;
			} else if (args.op === "done") {
				// A bare `done` finishes the todo in progress; `phase` finishes a whole phase.
				const title = args.task || args.phase || this.currentTodo;
				if (title) {
					this.todoDone.add(title);
					if (title === this.currentTodo) this.currentTodo = undefined;
					push("done", title);
				}
			}
		}
	}

	applyToolResult(m, ms) {
		const s = this.state;
		const id = m.toolCallId;
		const call = s.pending.get(id);
		const text = textOf(m.content);
		// An eval cell's summary names the check it runs ("node --test x 실행") even when its code spawns it indirectly.
		const summary = String(call?.name ?? "").toLowerCase() === "eval" ? String(call.args?.summary ?? "") : "";
		const checkBy = CHECK_COMMAND.test(summary) ? summary : call ? commandText(call.name, call.args) : "";
		if (call && CHECK_COMMAND.test(checkBy) && (m.isError || CHECK_FAILURE.test(text))) {
			const key = checkKey(checkBy);
			s.activity.failingChecks.set(key, (s.activity.failingChecks.get(key) ?? 0) + 1);
			const times = s.activity.failTimes.get(key) ?? [];
			times.push(ms);
			s.activity.failTimes.set(key, times.slice(-20));
			for (const target of s.activity.files.keys()) this.pendingFailures.set(target, (this.pendingFailures.get(target) ?? 0) + 1);
		}
		if (call && String(call.name).toLowerCase() === "todo") {
			// A `done` makes the tool start the next task on its own: it is open now, though no `start` call says so (D15).
			const promoted = call.args?.op === "done" && !m.isError ? promotedTodo(text) : undefined;
			if (promoted && promoted !== this.currentTodo && !this.todoDone.has(promoted)) {
				pushCapped(s.steps, { ms, tool: "todo", kind: "start", text: truncate(redact(promoted), 160) }, STEPS);
				this.currentTodo = promoted;
			}
			const match = text.match(TODO_TOTAL);
			if (match) s.activity.lastTodo = { open: Number(match[3]), total: Number(match[2]), openItems: text.split(/\r?\n/).flatMap((line) => {
				const item = line.match(TODO_OPEN);
				return item ? [item[1] ?? item[2]] : [];
			}).slice(0, 20) };
		}
		if (call && Number.isFinite(ms)) pushCapped(this.completions, { id, sessionId: s.id, taskId: s.taskId, kind: this.kind, tool: call.name, startMs: call.ms, endMs: ms, isError: Boolean(m.isError), commandHead: truncate(redact(commandText(call.name, call.args)), 400) }, COMPLETIONS);
		s.pending.delete(id);
		s.resolved.set(id, { ms, isError: Boolean(m.isError), textHead: truncate(redact(text), 300) });
		if (s.resolved.size > HISTORY) s.resolved.delete(s.resolved.keys().next().value);
		const hist = s.toolHistory.findLast?.((item) => item.id === id);
		if (hist) {
			hist.isError = Boolean(m.isError);
			if (m.isError) hist.errHead = truncate(redact(textOf(m.content)), 120);
		}
	}
}

export function entryMs(entry) {
	return toMs(entry?.timestamp) ?? (Number.isFinite(entry?.message?.timestamp) ? entry.message.timestamp : undefined);
}

export function idFromFileName(file) {
	const base = path.basename(file, ".jsonl");
	const index = base.lastIndexOf("_");
	return index >= 0 ? base.slice(index + 1) : base;
}

/**
 * Discovers main sessions (sensor heartbeats + recently modified session files)
 * and child sessions (task stores of every known project), and keeps one
 * SessionTracker per file.
 */
export class SessionRegistry {
	constructor({ paths, config, clock, taskReader = createTaskStoreReader(), log, scanWindow } = {}) {
		this.paths = paths;
		this.config = config;
		this.clock = clock;
		this.taskReader = taskReader;
		this.log = log;
		this.scanWindow = scanWindow;
		this.trackers = new Map();
		this.lastDiscoveryMs = -Infinity;
		this.mainFiles = new Set();
		this.childFileByTask = new Map();
		this.tasks = [];
		this.projects = new Set();
		this.badTaskRecords = 0;
	}

	tailBytes() {
		return this.scanWindow ? null : (this.config?.sessions?.tailBytes ?? 2 * 1024 * 1024);
	}

	discoverMain(sensors) {
		const now = this.clock.now();
		const recentMs = this.config?.sessions?.recentMs ?? 6 * 3600_000;
		if (now - this.lastDiscoveryMs >= 60_000 || this.scanWindow) {
			this.lastDiscoveryMs = now;
			const found = new Set();
			for (const dir of listDirSafe(this.paths.sessionsDir)) {
				const full = path.join(this.paths.sessionsDir, dir);
				for (const name of listDirSafe(full)) {
					if (!name.endsWith(".jsonl")) continue;
					const file = path.join(full, name);
					const stat = statSafe(file);
					if (!stat) continue;
					const inWindow = this.scanWindow
						? stat.mtimeMs >= this.scanWindow.fromMs && (stat.birthtimeMs || 0) <= this.scanWindow.toMs
						: now - stat.mtimeMs <= recentMs;
					if (inWindow) found.add(file);
				}
			}
			this.mainFiles = found;
		}
		for (const sensor of sensors?.values?.() ?? []) if (sensor.sessionFile) this.mainFiles.add(sensor.sessionFile);
		for (const file of this.mainFiles) {
			if (!this.trackers.has(file)) {
				const sensor = [...(sensors?.values?.() ?? [])].find((hb) => hb.sessionFile === file);
				this.trackers.set(file, new SessionTracker({ file, kind: "main", meta: { hostPid: sensor?.pid }, tailBytes: this.tailBytes(), alignmentDir: this.paths?.health?.alignmentDir }));
			}
		}
	}

	knownProjects(sensors) {
		const projects = new Set(this.config?.extraProjects ?? []);
		for (const tracker of this.trackers.values()) if (tracker.kind === "main" && tracker.state.cwd) projects.add(tracker.state.cwd);
		for (const sensor of sensors?.values?.() ?? []) if (sensor.cwd) projects.add(sensor.cwd);
		return projects;
	}

	discoverChildren(sensors) {
		const now = this.clock.now();
		const projects = this.knownProjects(sensors);
		const tasks = [];
		let bad = 0;
		const visited = new Set();
		const queue = [...projects];
		while (queue.length) {
			const cwd = queue.shift();
			const key = cwd.toLowerCase();
			if (visited.has(key)) continue;
			visited.add(key);
			const store = this.taskReader.read(cwd, this.paths?.agentDir ? senpiTaskStoreDir(cwd, this.paths.agentDir) : undefined);
			bad += store.badRecords;
			for (const task of store.tasks) {
				tasks.push(task);
				if (task.spawnCwd && !visited.has(task.spawnCwd.toLowerCase())) queue.push(task.spawnCwd);
			}
		}
		this.projects = visited;
		this.tasks = tasks;
		this.badTaskRecords = bad;
		for (const task of tasks) {
			const relevant = this.scanWindow
				? (task.createdAtMs ?? 0) <= this.scanWindow.toMs && (task.terminalAtMs ?? task.updatedAtMs ?? Infinity) >= this.scanWindow.fromMs
				: task.active || (task.terminalAtMs !== undefined && now - task.terminalAtMs <= 30 * 60_000) || task.residency === "resident";
			if (!relevant) continue;
			let file = this.childFileByTask.get(task.uid ?? task.taskId);
			if (!file) {
				file = findChildSessionFile(task.storeDir, task.taskId, task.childSessionId);
				if (file) this.childFileByTask.set(task.uid ?? task.taskId, file);
			}
			if (!file) continue;
			const meta = {
				sessionId: task.childSessionId,
				taskId: task.taskId,
				parentSessionId: task.parentSessionId,
				rootSessionId: task.rootSessionId,
				hostPid: task.hostPid,
				cwd: task.spawnCwd,
			};
			let tracker = this.trackers.get(file);
			if (!tracker) {
				tracker = new SessionTracker({ file, kind: "child", meta, tailBytes: this.tailBytes(), alignmentDir: this.paths?.health?.alignmentDir });
				this.trackers.set(file, tracker);
			}
			Object.assign(tracker.meta, meta);
			tracker.state.taskId = task.taskId;
			tracker.state.parentSessionId = task.parentSessionId;
			tracker.state.rootSessionId = task.rootSessionId;
			tracker.state.hostPid = task.hostPid;
			tracker.task = task;
		}
	}

	/** One discovery + incremental read cycle. */
	refresh({ sensors } = {}) {
		this.discoverMain(sensors);
		for (const tracker of this.trackers.values()) if (tracker.kind === "main") this.readTracker(tracker, sensors);
		this.discoverChildren(sensors);
		const now = this.clock.now();
		for (const tracker of this.trackers.values()) {
			if (tracker.kind === "child") this.readTracker(tracker, sensors);
		}
		// Forget files that went quiet long ago (live mode only).
		if (!this.scanWindow) {
			const recentMs = this.config?.sessions?.recentMs ?? 6 * 3600_000;
			for (const [file, tracker] of this.trackers) {
				const stat = statSafe(file);
				const stale = !stat || now - stat.mtimeMs > recentMs;
				const needed = tracker.kind === "child" ? tracker.task?.active : this.mainFiles.has(file);
				if (stale && !needed) this.trackers.delete(file);
			}
		}
		return this.snapshot();
	}

	readTracker(tracker, sensors) {
		let guard = 0;
		while (guard++ < 64) {
			const result = tracker.read();
			if (!result.more) break;
		}
		tracker.advance(this.clock.now());
		const state = tracker.state;
		const goal = readGoal(tracker.file, state.id);
		const ulw = state.cwd ? readUlwGoals(state.cwd, state.id) : [];
		state.anchor = tracker.kind === "child" && (tracker.task?.summary || state.firstUserText)
			? { objective: tracker.task?.summary ?? state.firstUserText, status: tracker.task?.status, source: "task" }
			: goal ? { objective: goal.objective, status: goal.status, source: "goal" }
			: ulw.length ? { objective: ulw.map((item) => item.title).join("; "), status: ulw.every((item) => item.status === "complete") ? "complete" : "active", source: "ulw" }
			: null;
		if (tracker.kind === "main") {
			const sensor = sensors?.get?.(tracker.state.id);
			if (sensor?.pid) tracker.state.hostPid = sensor.pid;
		}
	}

	snapshot() {
		const sessions = new Map();
		const completions = [];
		for (const tracker of this.trackers.values()) {
			const state = tracker.state;
			sessions.set(state.id, { ...state, task: tracker.task });
			if (tracker.completions.length) completions.push(...tracker.completions.splice(0));
		}
		return { sessions, tasks: this.tasks, projects: [...this.projects], badTaskRecords: this.badTaskRecords, completions };
	}
}
