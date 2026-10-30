/**
 * omo-health in-session sensor (plan todo 15, D-2, D-7, D-8, D-9, R1-B3, R1-N4).
 *
 * Loaded into every omo session by a one-line stub in ~/.omo/agent/extensions.
 * It never registers tools, never changes the system prompt, never calls a
 * model, and never does blocking I/O inside event hooks. It only:
 *   1. writes a heartbeat file every 10 s (session id, host pid, idle state, herdr pane);
 *   2. delivers messages the daemon drops into its inbox (pi.sendMessage);
 *   3. shows the daemon's status in the footer (ctx.ui.setStatus) and /health;
 *   4. restarts the daemon when its heartbeat goes stale;
 *   5. queues `/health report` texts for the daemon (<healthHome>/intake).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEARTBEAT_MS = 10_000;
const INBOX_MS = 3_000;
const STATUS_MS = 5_000;
const ENSURE_MS = 10_000;
/** How often the sensor looks for a newer installed omo-health, and how long it waits before asking for a reload again. */
const UPGRADE_MS = 60_000;
const UPGRADE_RETRY_MS = 10 * 60_000;
const UPGRADE_TRIES = 3;
const DAEMON_STALE_MS = 45_000;
const SPAWN_COOLDOWN_MS = 120_000;
const SPAWN_CHECK_MS = 90_000;
const DEATH_COOLDOWN_MS = 30 * 60_000;
const CLAIM_MS = 60_000;
const SETUP_FAILURE_MS = 10 * 60_000;
/** Same cap as src/reports/intake.mjs REPORT_TEXT_MAX (the sensor imports only node built-ins). */
const REPORT_TEXT_MAX = 2000;
/** The daemon redacts a queued text and then cuts it to REPORT_TEXT_MAX; this margin keeps a token that straddles the cut whole for the pattern. */
const REPORT_REDACT_MARGIN = 256;
/** Hands the operator-input record from a sensor that is being reloaded to its successor in the same host process. */
const RELOAD_CARRY = Symbol.for("omo-health.sensor.reload-carry");
const MESSAGE_KINDS = new Set(["relay", "self-notice", "wake", "nudge", "revert-notice", "relay-cancel", "scope-check", "test"]);
/** senpi's cross-extension bus (pi.events) channels the heartbeat mirrors; the sensor only reads them (Contract C6). */
const WAKE_SOURCE_EVENT = "wake_source_state";
const TERMINAL_MONITOR_EVENT = "terminal_monitor_state";
const CONTINUATION_HOLD_EVENT = "continuation_hold_state";
const GOAL_TIMER_EVENT = "goal_continuation_timer_state";
const GOAL_SCHEDULED_EVENT = "goal_continuation_scheduled";

function kst(ms) {
	const shifted = new Date(ms + 9 * 3600_000).toISOString();
	return `${shifted.slice(5, 10)} ${shifted.slice(11, 16)}`;
}

async function readJson(file) {
	try {
		return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

async function writeJsonAtomic(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value));
	await fs.rename(tmp, file);
}

/** Async existence check: `ensureDaemon` also runs from `session_start`, where sync I/O is not allowed. */
function exists(file) {
	return fs.access(file).then(
		() => true,
		() => false,
	);
}

/** Inline read-only keepwarm snapshot reader (same rules as bin/omo-health.mjs keepwarmStatus). */
async function keepwarmLine(env, at) {
	const file = path.join(env?.OMO_KEEPWARM_HOME || path.join(os.homedir(), ".omo-keepwarm"), "status", "_global.json");
	if (!(await exists(file))) return null;
	const snap = await readJson(file);
	if (!snap || snap.v !== 1) return "keepwarm: unknown (unreadable)";
	const staleAfter = Number.isFinite(snap.staleAfter) ? snap.staleAfter : Number.isFinite(snap.ts) ? snap.ts + 10 * 60_000 : undefined;
	if (staleAfter === undefined) return "keepwarm: unknown (unreadable)";
	if (at > staleAfter) return "keepwarm: unknown (stale)";
	return snap.text ?? null;
}

function safeSegment(value) {
	return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The herdr pane this session runs in (herdr injects these into every pane), so a crashed host can be reopened next to it. */
function terminalIdentity(env) {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) {
		if (env.TERM_PROGRAM !== "Orca" && !env.ORCA_TAB_ID) return undefined;
		return { kind: "orca", tabId: env.ORCA_TAB_ID || null, worktreeId: env.ORCA_WORKTREE_ID || null, appVersion: env.ORCA_APP_VERSION || null };
	}
	return { kind: "herdr", workspaceId: env.HERDR_WORKSPACE_ID, tabId: env.HERDR_TAB_ID, paneId: env.HERDR_PANE_ID, socketPath: env.HERDR_SOCKET_PATH, binPath: env.HERDR_BIN_PATH };
}

export default function omoHealthSensor(pi, options = {}) {
	const home = options.healthHome ?? process.env.OMO_HEALTH_HOME ?? path.join(os.homedir(), ".omo-health");
	const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const source = options.source ? path.resolve(options.source) : undefined;
	const now = options.now ?? (() => Date.now());
	const setIntervalImpl = options.setInterval ?? setInterval;
	const clearIntervalImpl = options.clearInterval ?? clearInterval;
	const spawnImpl = options.spawn ?? spawn;
	const execPath = options.execPath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const dirs = {
		sensors: path.join(home, "sensors"),
		inbox: path.join(home, "inbox"),
		receipts: path.join(home, "receipts"),
		status: path.join(home, "status"),
	};

	let ctx;
	let sessionId;
	let timers = [];
	let lastEventAt = now();
	// Last operator input (the host's `input` event, not agent turns). Starting the host counts as presence; an extension
	// reload does not (the host reloads on its own, e.g. on config changes), so a reload keeps the previous sensor's record.
	let lastInputAt = now();
	// The last 20 operator inputs: the daemon anchors the user's latest request on the user turn written with one of them.
	const humanInputs = [];
	let executingTools = 0;
	// When this host last started an agent run; null until it does. The daemon reads it to tell whether a crash-resumed
	// session really started its turn (#109: since omo 5.1.48 a reopened session can sit on an interrupted-run hold).
	let lastAgentStartAt = null;
	let running = false;
	let lastStatusText;
	let lastSpawnAt = -Infinity;
	let pendingSpawnAt;
	let failedSpawns = 0;
	let lastDeathAt = -Infinity;
	let disabled = false;
	let widgetOpen = false;
	let pendingResume;
	let busy = { heartbeat: false, inbox: false, status: false, ensure: false };
	let stopped = false;
	let migration = { sha: null, tries: 0, lastMs: -Infinity };
	// Goal-wait channel state for the heartbeat (Contract C6): mirrored from pi.events, never invented here.
	let wakeSources = {};
	let holds = [];
	let goalWait = { armed: false, kind: null, dueAtMs: null };
	const resetChannelState = () => {
		wakeSources = {};
		holds = [];
		goalWait = { armed: false, kind: null, dueAtMs: null };
	};

	async function refreshStopped() {
		stopped = await exists(path.join(home, "stopped"));
		return stopped;
	}

	async function packageSha() {
		const git = path.join(source, ".git");
		const head = (await fs.readFile(path.join(git, "HEAD"), "utf8")).trim();
		if (!head.startsWith("ref: ")) return head;
		const ref = head.slice(5);
		try {
			return (await fs.readFile(path.join(git, ref), "utf8")).trim();
		} catch {
			const packed = await fs.readFile(path.join(git, "packed-refs"), "utf8");
			return packed.split(/\r?\n/).map((line) => line.match(/^([0-9a-f]{40})\s+(.+)$/)).find((match) => match?.[2] === ref)?.[1];
		}
	}

	const touch = () => {
		lastEventAt = now();
	};

	const inflight = new Map();
	const reported = new Set();
	const safe = (name, fn) => () => {
		if (disabled || busy[name]) return inflight.get(name);
		busy[name] = true;
		const run = (async () => {
			try {
				await fn();
			} catch (error) {
				// Senpi has invalidated this extension instance: no callbacks from its old generation may run again.
				const staleGeneration = String(error?.message ?? error).includes("stale extension generation after reload");
				if (staleGeneration) {
					disabled = true;
					stop();
				}
				// a sensor failure must never disturb the session; record the first one per job for `doctor`
				const reportKey = staleGeneration ? "stale-generation" : name;
				if (!reported.has(reportKey)) {
					reported.add(reportKey);
					try {
						await fs.mkdir(path.join(home, "logs"), { recursive: true });
						await fs.appendFile(path.join(home, "logs", "sensor-errors.log"), `${new Date(now()).toISOString()} pid=${process.pid} ${name}: ${String(error?.stack ?? error).slice(0, 1500)}\n`);
					} catch {
						// Logging must not disturb the host session.
					}
				}
			} finally {
				busy[name] = false;
			}
		})();
		inflight.set(name, run);
		return run;
	};

	function capture(nextCtx) {
		if (!nextCtx) return;
		ctx = nextCtx;
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? sessionId;
		} catch {
			// keep the previous id
		}
	}

	function isIdle() {
		try {
			return ctx?.isIdle?.() ?? true;
		} catch {
			return true;
		}
	}

	// G17: which release a session's sensor came from; read once, the file never changes under a loaded sensor.
	let version;
	const ownVersion = async () => {
		version ??= (await readJson(path.join(repoRoot, "package.json")))?.version ?? null;
		return version;
	};

	const heartbeat = safe("heartbeat", async () => {
		if (await refreshStopped()) return;
		if (!sessionId) return;
		let sessionFile;
		let pending = false;
		try {
			sessionFile = ctx?.sessionManager?.getSessionFile?.();
			pending = Boolean(ctx?.hasPendingMessages?.());
		} catch {
			// ignore
		}
		await writeJsonAtomic(path.join(dirs.sensors, `${safeSegment(sessionId)}.json`), {
			v: 1,
			pid: process.pid,
			sessionId,
			sessionFile,
			cwd: ctx?.cwd ?? pi.cwd,
			kind: pi.sessionKind ?? "interactive",
			idle: isIdle(),
			pending,
			lastEventAt,
			lastInputAt,
			humanInputs,
			lastAgentStartAt,
			executingTools,
			wakeSources,
			holds,
			goalWait,
			goalLivenessSchema: 1,
			hasUI: Boolean(ctx?.hasUI),
			sensorVersion: await ownVersion(),
			root: repoRoot,
			terminal: terminalIdentity(env),
			ts: now(),
		});
	});

	async function deliver(message) {
		const payload = { customType: "omo-health", content: message.content, display: true, details: message.details ?? {} };
		pi.sendMessage(payload, { deliverAs: ["steer", "followUp", "nextTurn"].includes(message.deliverAs) ? message.deliverAs : "followUp", triggerTurn: message.kind === "scope-check" ? false : Boolean(message.triggerTurn) });
	}

	const inbox = safe("inbox", async () => {
		if (await refreshStopped()) return;
		if (!sessionId) return;
		if (pendingResume && isIdle()) {
			const message = pendingResume;
			pendingResume = undefined;
			await deliver({ ...message, deliverAs: "followUp", triggerTurn: true });
			await writeJsonAtomic(path.join(dirs.receipts, `${message.id}.json`), { id: message.id, sessionId, deliveredMs: now(), kind: message.kind, resumed: true });
		}
		const dir = path.join(dirs.inbox, safeSegment(sessionId));
		let names;
		try {
			names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const file = path.join(dir, name);
			const message = await readJson(file);
			if (!message?.id) {
				await fs.rm(file, { force: true });
				continue;
			}
			let result = "delivered";
			// A message past its expiry describes a state that no longer exists (#102): receipted, never shown.
			if (Number.isFinite(message.details?.expiresMs) && message.details.expiresMs < now()) {
				result = "expired";
			} else if (message.kind === "abort-continue") {
				// R1-B3: abort only a turn that is really running, resume only once idle.
				if (!isIdle()) {
					try {
						ctx?.abort?.();
					} catch {
						// ignore
					}
					pendingResume = message;
					result = "aborted-waiting-idle";
				} else {
					await deliver({ ...message, deliverAs: "followUp", triggerTurn: true });
				}
			} else if (MESSAGE_KINDS.has(message.kind)) {
				await deliver(message);
			} else {
				result = "unknown-kind";
			}
			await writeJsonAtomic(path.join(dirs.receipts, `${message.id}.json`), { id: message.id, sessionId, deliveredMs: now(), kind: message.kind, result });
			await fs.rm(file, { force: true });
		}
	});

	async function footerText() {
		const [session, global, daemon, stopped] = await Promise.all([
			readJson(path.join(dirs.status, `${safeSegment(sessionId)}.json`)),
			readJson(path.join(dirs.status, "_global.json")),
			readJson(path.join(home, "daemon.json")),
			fs.stat(path.join(home, "stopped")).then(
				() => true,
				() => false,
			),
		]);
		if (stopped) return { text: "👀 중지", level: "stopped", session, global, daemon };
		if (!daemon || now() - (daemon.ts ?? 0) > DAEMON_STALE_MS) return { text: "👀 감시기", level: "crit", session, global, daemon };
		if ((global?.humanNeeded ?? []).length) return { text: global.text, level: global.level, session, global, daemon };
		// The more severe of the two wins; a tie goes to the session's own text.
		const levels = { ok: 0, info: 1, warn: 2, crit: 3 };
		const rank = (status) => (status ? (levels[status.level] ?? -1) : -2);
		const chosen = rank(session) >= rank(global) ? session : global;
		return { text: chosen?.text ?? "👀 정상", level: chosen?.level ?? "ok", session, global, daemon };
	}

	/** The footer carries no level symbol: the host theme's color says it (red crit, yellow warn, green ok, dim stopped). */
	const FOOTER_COLORS = { crit: "error", warn: "warning", ok: "success", info: "success", stopped: "dim" };
	function colored(text, level) {
		try {
			return ctx.ui.theme?.fg?.(FOOTER_COLORS[level] ?? "success", text) ?? text;
		} catch {
			return text;
		}
	}

	const status = safe("status", async () => {
		if (!sessionId || !ctx?.hasUI) return;
		const { text, level } = await footerText();
		const shown = colored(text, level);
		if (shown !== lastStatusText) {
			lastStatusText = shown;
			ctx.ui.setStatus("omo-health", shown);
		}
	});

	/** The sensor may run under bun; the daemon and the dashboard launcher need Node for their V8 limits and worker. */
	async function findNode() {
		if (/^node(\.exe)?$/i.test(path.basename(execPath))) return execPath;
		const pathValue = env.PATH ?? env.Path ?? "";
		for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
			const candidate = path.join(dir, platform === "win32" ? "node.exe" : "node");
			if (dir && await exists(candidate)) return candidate;
		}
		throw new Error("Node executable not found on PATH for omo-health daemon");
	}

	const ensureDaemon = safe("ensure", async () => {
		if (await refreshStopped()) return;
		if (source && !(await exists(path.join(home, "app", "boot.mjs")))) return;
		const daemon = await readJson(path.join(home, "daemon.json"));
		const fresh = daemon && now() - (daemon.ts ?? 0) <= DAEMON_STALE_MS && !daemon.stoppedMs;
		if (fresh) {
			pendingSpawnAt = undefined;
			failedSpawns = 0;
			return;
		}
		if (pendingSpawnAt !== undefined && now() - pendingSpawnAt >= SPAWN_CHECK_MS) {
			pendingSpawnAt = undefined;
			failedSpawns++;
			if (failedSpawns >= 3 && now() - lastDeathAt >= DEATH_COOLDOWN_MS) {
				const ms = now();
				await writeJsonAtomic(path.join(home, "deaths", `${ms}-daemon-unavailable-${process.pid}.json`), { kind: "daemon-unavailable", spawns: failedSpawns, lastHb: daemon?.ts ?? null });
				lastDeathAt = ms;
			}
		}
		if (now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return;
		// The installed bootstrap picks the runtime from app/current.json; a checkout without one runs itself.
		const boot = path.join(home, "app", "boot.mjs");
		const script = (await exists(boot)) ? boot : path.join(repoRoot, "bin", "omo-health.mjs");
		if (!(await exists(script))) return;
		// One spawner at a time across all sessions on the machine.
		const claim = path.join(home, "spawn-claim.json");
		const existing = await readJson(claim);
		if (existing && now() - (existing.at ?? 0) < CLAIM_MS) return;
		await fs.mkdir(home, { recursive: true });
		await writeJsonAtomic(claim, { pid: process.pid, sessionId, at: now() });
		const confirm = await readJson(claim);
		if (confirm?.pid !== process.pid || confirm?.sessionId !== sessionId) return;
		// Loaded fresh (?v=<mtime>): a session keeps the first copy of every plain module URL for its whole life,
		// so a static import pinned a hot-reloaded sensor to an old launch.mjs (live 2026-09-24, sensor-stub.log).
		const launchUrl = new URL("../src/launch.mjs", import.meta.url);
		const { launchDaemon } = await import(`${launchUrl.href}?v=${Math.round((await fs.stat(launchUrl)).mtimeMs)}`);
		const nodePath = await findNode();
		lastSpawnAt = now();
		// Outside this host's process tree, so the daemon survives this session closing.
		await launchDaemon({ script, execPath: nodePath, spawnImpl, platform, env });
		pendingSpawnAt = now();
	});

	/**
	 * A newer omo-health was installed (app/current.json names another root than the one this sensor runs from): ask
	 * senpi to reload this session's extensions once the session is idle, so the stub loads the new sensor. Senpi's own
	 * config watch usually does this when install rewrites the stub, but it does not always fire. A sensor started from
	 * the installed root (or a checkout with no installed release) has nothing to do.
	 */
	let upgrade = { root: null, tries: 0, lastMs: -Infinity };
	const samePath = (a, b) => (platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
	async function migrationReload(sha) {
		if (await exists(path.join(env.OMO_HEALTH_OMO_HOME || path.join(os.homedir(), ".omo"), "agent", "extensions", "omo-health-sensor.ts"))) return;
		if (migration.sha !== sha) migration = { sha, tries: 0, lastMs: -Infinity };
		if (migration.tries >= UPGRADE_TRIES || now() - migration.lastMs < UPGRADE_RETRY_MS) return;
		if (!isIdle() || ctx?.hasPendingMessages?.() || executingTools > 0) return;
		const requestReload = ctx?.requestReload ?? ctx?.reload;
		if (typeof requestReload !== "function") return;
		migration.tries++;
		migration.lastMs = now();
		await requestReload.call(ctx);
	}
	const packageCheck = safe("package", async () => {
		if (!source || await refreshStopped()) return;
		const app = path.join(home, "app");
		const current = await readJson(path.join(app, "current.json"));
		if (current?.channel === "dev") return;
		const sha = await packageSha();
		if (!sha) return;
		const bootExists = await exists(path.join(app, "boot.mjs"));
		if (current?.channel === "package" && current.sha === sha && samePath(current.source, source) && bootExists) {
			if (options.setupOnly) await migrationReload(sha);
			return;
		}
		const stateFile = path.join(app, "setup-state.json");
		const state = await readJson(stateFile);
		if (state?.sha === sha && ((Number.isFinite(state.failedMs) && now() - state.failedMs < SETUP_FAILURE_MS) || (Number.isFinite(state.claimMs) && now() - state.claimMs < CLAIM_MS))) return;
		await writeJsonAtomic(stateFile, { sha, claimMs: now(), pid: process.pid });
		const claim = await readJson(stateFile);
		if (claim?.sha !== sha || claim.pid !== process.pid) return;
		const nodePath = await findNode();
		const child = spawnImpl(nodePath, [path.join(source, "bin", "omo-health.mjs"), "install", "--from-package"], { detached: true, windowsHide: true, stdio: "ignore", cwd: home, env });
		child?.unref?.();
		child?.once?.("error", async (error) => {
			await writeJsonAtomic(stateFile, { sha, failedMs: now(), error: String(error?.message ?? error) });
		});
	});
	const upgradeCheck = safe("upgrade", async () => {
		const root = (await readJson(path.join(home, "app", "current.json")))?.root;
		const requestReload = ctx?.requestReload ?? ctx?.reload;
		if (typeof root !== "string" || samePath(root, repoRoot) || typeof requestReload !== "function") return;
		if (!(await exists(path.join(root, "extension", "sensor.mjs")))) return;
		if (upgrade.root !== root) upgrade = { root, tries: 0, lastMs: -Infinity };
		if (upgrade.tries >= UPGRADE_TRIES || now() - upgrade.lastMs < UPGRADE_RETRY_MS) return;
		if (!isIdle() || ctx.hasPendingMessages?.() || executingTools > 0) return;
		upgrade.tries += 1;
		upgrade.lastMs = now();
		await requestReload.call(ctx);
	});

	function start() {
		if (running || disabled) return;
		running = true;
		const every = (ms, fn) => {
			const timer = setIntervalImpl(fn, ms);
			timer?.unref?.();
			timers.push(timer);
		};
		if (options.setupOnly) {
			if (source) {
				every(UPGRADE_MS, packageCheck);
				void packageCheck();
			}
			return;
		}
		every(HEARTBEAT_MS, heartbeat);
		every(INBOX_MS, inbox);
		every(STATUS_MS, status);
		every(ENSURE_MS, ensureDaemon);
		every(UPGRADE_MS, upgradeCheck);
		if (source) every(UPGRADE_MS, packageCheck);
		void heartbeat();
		void ensureDaemon();
		if (source) void packageCheck();
	}

	function stop() {
		for (const timer of timers) clearIntervalImpl(timer);
		timers = [];
		running = false;
	}

	if (!options.setupOnly && globalThis[Symbol.for("omo-health.sensor.active")] === (source ?? repoRoot)) {
		return {};
	}
	if (!options.setupOnly) {
		globalThis[Symbol.for("omo-health.sensor.active")] = source ?? repoRoot;
	}
	pi.on("session_start", async (event, nextCtx) => {
		capture(nextCtx);
		resetChannelState();
		if (options.setupOnly) {
			start();
			return;
		}
		touch();
		const carry = globalThis[RELOAD_CARRY];
		delete globalThis[RELOAD_CARRY];
		if (event?.reason === "reload" && carry?.sessionId === sessionId) {
			lastInputAt = carry.lastInputAt;
			humanInputs.splice(0, humanInputs.length, ...carry.humanInputs);
		} else {
			lastInputAt = now();
		}
		start();
	});
	// Returns nothing, so the host continues with the input unchanged. Messages the extensions inject (goal continuations, nudges) arrive with source "extension".
	if (!options.setupOnly) pi.on("input", async (event, nextCtx) => {
		capture(nextCtx);
		if (event?.source !== "extension") {
			lastInputAt = now();
			humanInputs.push(lastInputAt);
			if (humanInputs.length > 20) humanInputs.shift();
		}
	});
	pi.on("session_shutdown", async (event) => {
		stop();
		resetChannelState();
		if (options.setupOnly) return;
		// A reload loads a fresh sensor into this same process; it must not find this one's marker.
		if (globalThis[Symbol.for("omo-health.sensor.active")] === (source ?? repoRoot)) delete globalThis[Symbol.for("omo-health.sensor.active")];
		if (event?.reason === "reload" && sessionId) globalThis[RELOAD_CARRY] = { sessionId, lastInputAt, humanInputs: [...humanInputs] };
		if (sessionId) {
			try {
				await fs.rm(path.join(dirs.sensors, `${safeSegment(sessionId)}.json`), { force: true });
			} catch {
				// ignore
			}
		}
	});
	for (const event of options.setupOnly ? [] : ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end", "tool_execution_update"]) {
		pi.on(event, async (_event, nextCtx) => {
			capture(nextCtx);
			touch();
			if (event === "agent_start") lastAgentStartAt = lastEventAt;
		});
	}
	if (!options.setupOnly) pi.on("tool_execution_start", async (_event, nextCtx) => {
		capture(nextCtx);
		executingTools += 1;
		touch();
	});
	if (!options.setupOnly) pi.on("tool_execution_end", async (_event, nextCtx) => {
		capture(nextCtx);
		executingTools = Math.max(0, executingTools - 1);
		touch();
	});
	if (!options.setupOnly) pi.on("agent_settled", async (_event, nextCtx) => {
		capture(nextCtx);
		executingTools = 0;
		touch();
	});

	/**
	 * Contract C6: mirror senpi's goal-wait bus channels into the heartbeat. Guarded - an older host has no bus, and a
	 * malformed payload is ignored rather than trusted. These handlers only touch memory (the sensor never blocks here).
	 */
	if (typeof pi.events?.on === "function") {
		const subscribe = (event, handler) => {
			try {
				pi.events.on(event, handler);
			} catch {
				// a host that exposes a bus but rejects the subscription must not break the sensor
			}
		};
		const noteWakeSource = (source, activeCount) => {
			if (typeof source !== "string" || !source || !Number.isFinite(activeCount)) return;
			wakeSources[source] = activeCount;
		};
		subscribe(WAKE_SOURCE_EVENT, (data) => {
			if (data && typeof data === "object") noteWakeSource(data.source, data.activeCount);
		});
		subscribe(TERMINAL_MONITOR_EVENT, (data) => {
			if (data && typeof data === "object" && Number.isInteger(data.activeCount) && data.activeCount >= 0) noteWakeSource("terminal-monitors", data.activeCount);
		});
		subscribe(CONTINUATION_HOLD_EVENT, (data) => {
			if (!data || typeof data !== "object" || typeof data.source !== "string" || !data.source || typeof data.active !== "boolean") return;
			const at = holds.indexOf(data.source);
			if (data.active && at === -1) holds.push(data.source);
			else if (!data.active && at !== -1) holds.splice(at, 1);
		});
		// senpi repeats every source count when it parks a goal, so a sensor that missed a source's own event (a reload) catches up.
		subscribe(GOAL_SCHEDULED_EVENT, (data) => {
			if (!data || typeof data !== "object" || !data.wakeSources || typeof data.wakeSources !== "object") return;
			for (const [source, activeCount] of Object.entries(data.wakeSources)) noteWakeSource(source, activeCount);
		});
		subscribe(GOAL_TIMER_EVENT, (data) => {
			if (!data || typeof data !== "object" || typeof data.armed !== "boolean") return;
			goalWait = { armed: data.armed, kind: typeof data.kind === "string" && data.kind ? data.kind : null, dueAtMs: data.armed && Number.isFinite(data.dueAtMs) ? data.dueAtMs : null };
		});
	}

	/**
	 * `/health report [task id] <text>`: queue a report on this session (or the named subagent) in <healthHome>/intake, the file
	 * `omo-health report` writes. The daemon dedupes, rate-limits and triages it (src/reports/intake.mjs); a command, not
	 * a tool, so no session pays prompt tokens for it.
	 */
	async function fileReport(input) {
		const [first = ""] = input.split(/\s+/);
		const named = /^st_[A-Za-z0-9_-]+$/.test(first);
		const subject = named ? first : sessionId;
		const text = (named ? input.slice(first.length) : input).trim();
		if (!text) return "보고할 내용을 적어 주세요: /health report [작업 id] <내용>";
		if (!subject) return "세션 id를 아직 몰라 보고하지 못했습니다";
		const atMs = now();
		const id = `${atMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await writeJsonAtomic(path.join(home, "intake", `${atMs}-${id}.json`), { v: 1, id, atMs, via: "sensor", subject, reporterSessionId: sessionId ?? null, text: text.slice(0, REPORT_TEXT_MAX + REPORT_REDACT_MARGIN) });
		return `보고 접수됨 [${id}] ${subject}: 감시기가 다음 확인(약 15초 안)에 사건으로 기록하고 증거를 남깁니다. 같은 보고는 1시간에 한 번만 기록합니다.`;
	}

	/** Runs the short-lived `ui --json` launcher (it detaches the server itself); resolves { url } or { reason }, never rejects. */
	function launchUi(script, nodePath, timeoutMs) {
		return new Promise((resolve) => {
			let out = "";
			let err = "";
			let timer;
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			let child;
			try {
				child = spawnImpl(nodePath, [script, "ui", "--json"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
			} catch (error) {
				finish({ reason: String(error?.message ?? error) });
				return;
			}
			timer = setTimeout(() => {
				try {
					child.kill?.();
				} catch {
					// already gone
				}
				finish({ reason: `${timeoutMs}ms 안에 시작하지 않았습니다` });
			}, timeoutMs);
			child.on?.("error", (error) => finish({ reason: String(error?.message ?? error) }));
			child.stdout?.on?.("data", (chunk) => {
				out += chunk;
			});
			child.stderr?.on?.("data", (chunk) => {
				err += chunk;
			});
			child.on?.("close", (code) => {
				const errLines = err.trim().split(/\r?\n/).filter(Boolean);
				const summary = (errLines.find((line) => /error/i.test(line)) ?? errLines.at(-1) ?? "출력 없음").slice(0, 200);
				if (code === 2 && /unknown command/i.test(err)) return finish({ reason: "이 버전의 omo-health에는 ui 명령이 없습니다" });
				if (code !== 0) return finish({ reason: summary });
				try {
					const line = JSON.parse(out.split(/\r?\n/)[0]);
					if (typeof line.url === "string" && line.url) return finish({ url: line.url, opened: line.opened === true });
				} catch {
					// fall through to the stderr summary
				}
				finish({ reason: summary });
			});
		});
	}

	async function openDashboard() {
		try {
			const boot = path.join(home, "app", "boot.mjs");
			const script = (await exists(boot)) ? boot : path.join(repoRoot, "bin", "omo-health.mjs");
			const result = await launchUi(script, await findNode(), options.uiStartTimeoutMs ?? 15000);
			// The url carries the per-launch token; notify text may be persisted with the session, so show it only when the browser did not get it.
			if (result.opened) return { ok: true, lines: [`대시보드를 브라우저에서 열었습니다 (포트 ${new URL(result.url).port})`, "(30분 동안 쓰지 않으면 닫힙니다)"] };
			return result.url
				? { ok: true, lines: [`대시보드를 열었습니다: ${result.url}`, "(브라우저가 안 열리면 이 주소를 여세요. 30분 동안 쓰지 않으면 닫힙니다)"] }
				: { ok: false, lines: [`대시보드를 열지 못했습니다: ${result.reason}`] };
		} catch (error) {
			return { ok: false, lines: [`대시보드를 열지 못했습니다: ${String(error?.message ?? error)}`] };
		}
	}

	/** The daemon's alignment ledger for this session (alignment/<sid>.json): goal, requests, commitments, last scope check. */
	async function alignmentLines() {
		if (!sessionId) return [];
		const ledger = await readJson(path.join(home, "alignment", `${safeSegment(sessionId)}.json`));
		if (!ledger) return [];
		const short = (value, max) => {
			const text = String(value ?? "").replace(/\s+/g, " ").trim();
			return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
		};
		const lines = [];
		if (ledger.goal?.objective) lines.push(`원래 목표: ${short(ledger.goal.objective, 120)}`);
		const requests = (ledger.requests ?? []).slice(-3).map((r) => short(r.text, 60)).filter(Boolean);
		if (requests.length) lines.push(`최근 요청: ${requests.join(" | ")}`);
		const open = ledger.openCommitments ?? {};
		lines.push(`열린 약속: 할 일 ${open.todoOpen ?? 0}개${open.goalActive ? " / 목표 진행 중" : ""}`);
		const nudge = ledger.nudges?.at(-1);
		if (Number.isFinite(nudge?.ms)) lines.push(`범위 점검: ${kst(nudge.ms).slice(6)} ${nudge.signal}`);
		return lines;
	}

	if (!options.setupOnly) pi.registerCommand?.("health", {
		description: "omo-health: 대시보드 열기 (열지 못하면 상태 위젯 표시), widget(상태와 최근 24시간 사건 위젯, 다시 입력하면 닫힘), ui(대시보드 열기), report [작업 id] <내용>(문제 보고)",
		handler: async (args, commandCtx) => {
			capture(commandCtx);
			const input = String(args ?? "").trim();
			const [verb] = input.split(/\s+/);
			const show = (lines) => {
				if (!commandCtx?.hasUI) return;
				if (commandCtx.ui.notify) commandCtx.ui.notify(lines.join("\n"), "info");
				else {
					widgetOpen = true;
					commandCtx.ui.setWidget("omo-health", lines);
				}
			};
			if (verb === "ui") {
				try {
					show((await openDashboard()).lines);
				} catch {
					// the host command must never throw
				}
				return;
			}
			if (verb === "report") {
				try {
					show([await fileReport(input.slice(verb.length).trim())]);
				} catch (error) {
					// the host command must never throw; the operator sees why the report was not queued
					show([`보고를 저장하지 못했습니다: ${String(error?.message ?? error)}`]);
				}
				return;
			}
			if (verb === "uninstall" || verb === "install") {
				try {
					const script = verb === "install" && source
						? path.join(source, "bin", "omo-health.mjs")
						: path.join(home, "app", "boot.mjs");
					const args = verb === "uninstall"
						? [script, "uninstall", ...(input.split(/\s+/).includes("--purge") ? ["--purge"] : [])]
						: source ? [script, "install", "--from-package"] : [script, "install"];
					const child = spawnImpl(await findNode(), args, { detached: true, windowsHide: true, stdio: "ignore", cwd: home, env });
					child?.unref?.();
					show([verb === "uninstall" ? "omo-health 제거를 시작했습니다" : "omo-health 설치를 시작했습니다"]);
				} catch (error) {
					show([`실행하지 못했습니다: ${String(error?.message ?? error)}`]);
				}
				return;
			}
			if (!commandCtx?.hasUI) return;
			if (widgetOpen) {
				widgetOpen = false;
				commandCtx.ui.setWidget("omo-health", undefined);
				return;
			}
			if (verb !== "widget") {
				// plain /health: the dashboard, with the widget only as the fallback when it cannot open
				try {
					const dashboard = await openDashboard();
					if (dashboard.ok) {
						show(dashboard.lines);
						return;
					}
				} catch {
					// fall back to the widget
				}
			}
			const { text, session, global, daemon } = await footerText();
			const lines = [];
			lines.push(`omo-health: ${text}`);
			lines.push(daemon ? `감시기 pid ${daemon.pid}, 모드 ${daemon.mode ?? "?"}, 마지막 갱신 ${Math.round((now() - (daemon.ts ?? 0)) / 1000)}초 전` : "감시기 기록 없음");
			for (const h of global?.humanNeeded ?? []) lines.push(`! 사람 조치 필요: ${h.titleKo}`);
			lines.push(...(await alignmentLines()));
			const keepwarm = await keepwarmLine(env, now());
			if (keepwarm) lines.push(keepwarm);
			const incidents = [...(session?.incidents ?? []), ...(global?.incidents ?? [])];
			const seen = new Set();
			const rows = incidents.filter((i) => (seen.has(i.fp) ? false : seen.add(i.fp))).sort((a, b) => b.firstSeenMs - a.firstSeenMs).slice(0, 10);
			if (!rows.length) lines.push("최근 24시간 사건 없음");
			for (const i of rows) lines.push(`${kst(i.firstSeenMs)} ${i.resolvedMs ? "✓" : "•"} ${i.titleKo}${i.actions?.length ? ` [${i.actions.join(", ")}]` : ""}${i.reportPath ? ` → ${i.reportPath}` : ""}`);
			widgetOpen = true;
			commandCtx.ui.setWidget("omo-health", lines);
		},
	});

	return {
		__test: {
			heartbeat,
			inbox,
			status,
			ensureDaemon,
			upgradeCheck,
			packageCheck,
			stop,
			settle: () => Promise.all([...inflight.values()]),
			get sessionId() {
				return sessionId;
			},
		},
	};
}
