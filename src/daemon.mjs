import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeLedgers } from "./align/ledger.mjs";
import { isOurDaemon, killHungHolder } from "./death.mjs";
import { acceptReports, importLegacyIntake } from "./reports/intake.mjs";
import { VERSION } from "./version.mjs";
import { createLogger } from "./log.mjs";
import { createNotifier } from "./act/notify.mjs";
import { hasPendingParks } from "./act/park-resume.mjs";
import { readPause } from "./control.mjs";
import { revertSettings } from "./act/config-revert.mjs";
import { LogCollector } from "./collect/logs.mjs";
import { createProcessSource } from "./collect/procs.mjs";
import { currentDowntime } from "./collect/downtime.mjs";
import { SessionRegistry } from "./collect/sessions.mjs";
import { createTranscriptIndex } from "./collect/transcripts.mjs";
import { createConfigTracker } from "./collect/config-files.mjs";
import { createConfigReloader } from "./config-reload.mjs";
import { readAuthBlocks } from "./collect/secrets.mjs";
import { createEngine, loadDetectors } from "./engine.mjs";
import { createEvidence } from "./evidence.mjs";
import { createAnalyst, parseAnalystOutput, unavailableReason } from "./judge/analyst.mjs";
import { createRunner } from "./runner.mjs";
import { countTempFiles, createBaseline } from "./baseline.mjs";
import { closeDb, createMaintainer, openDb } from "./db/db.mjs";
import { gate } from "./judge/policy.mjs";
import { isSenpiHost } from "./state.mjs";
import { launchDaemon } from "./launch.mjs";
import { createInvestigations } from "./investigations.mjs";
import { pruneHome } from "./retention.mjs";
import { backfillOnce } from "./session-backfill.mjs";
import { buildSessionSnapshot, detectEnded } from "./session-board.mjs";
import { appendEnded } from "./session-ledger.mjs";
import { atomicWriteJson, ensureDir, readJsonSafe, statSafe } from "./util/fsx.mjs";
import { pathKey } from "./paths.mjs";
import { defaultRegRunner, RUN_KEY, runValueName } from "./install.mjs";

export { VERSION } from "./version.mjs";

function pidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

const LOCK_HEARTBEAT_GRACE_MS = 5 * 60_000;
const LOCK_STARTUP_GRACE_MS = 60_000;
/** At most one handover per this window: the sensor that wins the respawn race may run non-elevated too. */
const ELEVATE_BACKOFF_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** A board snapshot left by the previous daemon this recent still tells which sessions ended across the restart. */
const BOARD_RESUME_MS = 10 * 60_000;

/** Old per-session files go; what went is logged. Never throws. */
function runRetention(paths, now, log) {
	try {
		const { removed, errors } = pruneHome(paths, now);
		const kinds = {};
		for (const item of removed) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
		log.info("retention_pruned", { removed: removed.length, kinds, errors: errors.length, firstError: errors[0]?.message });
	} catch (error) {
		log.error("retention_failed", { error: error.message });
	}
}

/**
 * Windows mandatory integrity: a non-elevated daemon cannot terminate an elevated process, so it cannot clean up
 * after elevated omo sessions (live 2026-09-29: medium daemon, elevated senpi hosts; D16 found nothing, taskkill was
 * denied). A senpi host with a fresh sensor above the daemon's own integrity is the target of a handover: the daemon
 * exits ("elevate"), boot does not relaunch it, and a sensor respawns it through WMI at the sensor's own integrity.
 * @returns {{pid: number, sessionId: string, il: number, own: number}|undefined}
 */
export function elevationTarget(world) {
	const own = world?.procs?.integrity;
	if (!Number.isInteger(own) || !world.sensors) return undefined;
	for (const hb of world.sensors.values()) {
		if (!world.sensorFor(hb.sessionId)) continue;
		const host = world.procs.get(hb.pid);
		if (host && isSenpiHost(host) && Number.isInteger(host.il) && host.il > own) return { pid: host.pid, sessionId: hb.sessionId, il: host.il, own };
	}
	return undefined;
}

/**
 * The lock holder is our daemon only if its PID is alive AND the heartbeat names that PID and is recent
 * (or the holder started moments ago and has not heartbeated yet). A lock left by a hard exit whose PID
 * now belongs to an unrelated process fails this, so `stop`/`uninstall` never kill it and a new daemon
 * takes the lock over.
 */
function lockHolderLive(paths, lock, now) {
	if (!lock?.pid || !pidAlive(lock.pid)) return false;
	const hb = readJsonSafe(paths.health.daemonJson);
	if (hb?.pid === lock.pid && now - (hb.ts ?? 0) < LOCK_HEARTBEAT_GRACE_MS) return true;
	return Number.isFinite(lock.startedMs) && now - lock.startedMs >= 0 && now - lock.startedMs < LOCK_STARTUP_GRACE_MS;
}

/** Single-instance lock: exclusive create; a lock whose owner is not a live daemon is taken over. */
export function acquireLock(paths, now = Date.now(), deathOptions) {
	ensureDir(paths.healthHome);
	const record = { pid: process.pid, startedMs: now };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(paths.health.lockFile, "wx");
			fs.writeSync(fd, JSON.stringify(record));
			fs.closeSync(fd);
			return { ok: true };
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const holder = readJsonSafe(paths.health.lockFile);
			if (holder?.pid && holder.pid !== process.pid) {
				const live = lockHolderLive(paths, holder, now);
				const hb = readJsonSafe(paths.health.daemonJson);
				if (pidAlive(holder.pid) && hb?.pid === holder.pid && now - hb.ts > 3 * 60_000 && isOurDaemon(holder.pid, deathOptions?.exec)) {
					if (!killHungHolder(paths, holder, now, deathOptions)) return { ok: false, holder };
				} else if (live) return { ok: false, holder };
			}
			try {
				fs.unlinkSync(paths.health.lockFile);
			} catch {
				// raced with another starter; retry once
			}
		}
	}
	return { ok: false, holder: readJsonSafe(paths.health.lockFile) };
}

export function releaseLock(paths) {
	const holder = readJsonSafe(paths.health.lockFile);
	if (holder?.pid === process.pid) {
		try {
			fs.unlinkSync(paths.health.lockFile);
		} catch {
			// ignore
		}
	}
}

export function daemonState(paths, now = Date.now()) {
	const hb = readJsonSafe(paths.health.daemonJson);
	const lock = readJsonSafe(paths.health.lockFile);
	const running = lockHolderLive(paths, lock, now);
	return { running, pid: running ? lock.pid : undefined, heartbeat: hb, stopped: Boolean(statSafe(paths.health.stoppedFile)), paused: readJsonSafe(paths.health.pauseFile) ?? (statSafe(paths.health.pauseFile) ? {} : undefined) };
}

function pruneDeaths(paths, now, retentionDays) {
	const cutoff = now - retentionDays * 24 * 60 * 60_000;
	try {
		for (const name of fs.readdirSync(paths.health.deathsDir)) {
			const file = path.join(paths.health.deathsDir, name);
				let stat;
				try {
					stat = fs.statSync(file);
				} catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}
				if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function createSelfStats() {
	let lastCpu = process.cpuUsage();
	let lastAt = process.hrtime.bigint();
	return () => {
		const cpu = process.cpuUsage();
		const at = process.hrtime.bigint();
		const wallMs = Number(at - lastAt) / 1e6;
		const usedMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
		lastCpu = cpu;
		lastAt = at;
		return { rssBytes: process.memoryUsage().rss, cpuFrac: wallMs > 0 ? usedMs / wallMs : 0 };
	};
}

/**
 * Run the supervisor in this process until stopped (plan todo 11):
 * lock, heartbeat every tick, `stopped` file honoured, idle exit when no omo
 * host has been alive for config.idleExitMs.
 */
export async function runDaemon({ paths, config: injectedConfig, mode, clock = { now: () => Date.now() }, uptimeMs = os.uptime() * 1000, echo = false, overrides = {}, configEnv, proc = process } = {}) {
	// The reloader updates this copy in place; everything built below holds it (or its sub-objects).
	const config = structuredClone(injectedConfig);
	ensureDir(paths.healthHome);
	/**
	 * C7 (plan todo 7): what omo-limitless reads before it lets a session wait on a goal. `wakeReady` is exactly what
	 * `gate()` answers for a goal-wake request on a main session - probed on a copy of the config whose actionScope is
	 * emptied, because the scope is per-session and travels separately as `actionScope`. The capability follows
	 * goalLiveness.enabled; without it the block is absent, so a watcher never takes a hold from this daemon.
	 */
	const goalLivenessFields = () => {
		if (config.goalLiveness?.enabled !== true) return { capabilities: ["park-resume"] };
		const probeConfig = { ...config, actionScope: [] };
		const verdict = gate(
			{ kind: "goal-wake", key: "goal-liveness-probe" },
			{ mode: mode ?? config.mode, paused: readPause(paths, clock.now()), config: probeConfig, executed: new Set(), subject: {}, subjectKind: "main" },
		);
		return { capabilities: ["park-resume", "goal-liveness"], goalLiveness: { wakeReady: verdict === "execute", actionScope: config.actionScope?.length ? [...config.actionScope] : null } };
	};
	const log = createLogger({ file: `${paths.health.logsDir}/daemon.log`, clock, echo });
	const env = overrides.env ?? process.env;
	const regRunner = overrides.regRunner ?? defaultRegRunner;
	const sleep = overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const explicitConfig = process.argv.indexOf("--config");
	const configArgs = explicitConfig >= 0 && process.argv[explicitConfig + 1] ? ["--config", process.argv[explicitConfig + 1]] : [];
	const elevateFile = path.join(paths.healthHome, "elevate.json");
	// Old layout (Run value, sensor or `start` pointing at a checkout): hand over to the installed release through boot.
	const installed = readJsonSafe(paths.health.currentFile);
	if (installed?.channel && installed.channel !== "dev" && typeof installed.root === "string" && pathKey(installed.root) !== pathKey(paths.repoRoot) && !env.OMO_HEALTH_VIA_BOOT) {
		if (statSafe(paths.health.bootFile)) {
			const launched = await (overrides.launch ?? launchDaemon)({ script: paths.health.bootFile, extraArgs: configArgs, env });
			log.info("daemon_redirect", { from: paths.repoRoot, to: installed.root, via: launched?.via, pid: launched?.pid });
			return { exitCode: 0, reason: "redirect" };
		}
		log.warn("daemon_redirect_skipped", { missing: paths.health.bootFile, root: installed.root });
	}
	const lock = acquireLock(paths, clock.now(), { tickWaitMs: config.analyst?.timeoutMs });
	if (!lock.ok) {
		log.info("already_running", { holder: lock.holder });
		return { exitCode: 0, reason: "already-running", holder: lock.holder };
	}
	// Read the gap before this start overwrites the heartbeat or the engine saves state (D23).
	// A downtime record that cannot be written costs the notice, never the start.
	let downtime;
	try {
		downtime = currentDowntime({ paths, now: clock.now(), uptimeMs, config });
		log.info("downtime", { kind: downtime?.kind ?? "none", gapMs: downtime?.gapMs });
	} catch (error) {
		log.error("downtime_error", { error: String(error?.message ?? error) });
	}
	pruneDeaths(paths, clock.now(), config.history.retentionDays);
	runRetention(paths, clock.now(), log);
	let lastRetentionMs = clock.now();
	// Reports queued under the old layout (care/intake) join the intake queue once; the legacy directory goes.
	try {
		const imported = importLegacyIntake(paths, path.join(paths.health.legacyCareDir, "intake"));
		if (imported) log.info("legacy_intake_imported", { files: imported });
	} catch (error) {
		log.error("legacy_intake_import_failed", { error: error.message });
	}
	const procs = overrides.procs ?? createProcessSource({ binDir: paths.health.binDir, log });
	// Evidence snapshots: of opened findings (after each tick), of reports, and of a judged subject for its triage bundle (#55 B).
	const evidence = createEvidence({ paths });
	log.info("process_worker", { kind: procs.kind });
	// The local history DB: this daemon is its single writer. A DB that cannot open never stops supervision (the baseline
	// then runs in memory and logs baseline_db_failed).
	let db = null;
	let dbError;
	try {
		db = openDb({ file: paths.health.dbFile });
	} catch (error) {
		dbError = error;
	}
	const dbMaintainer = db ? createMaintainer({ db, config, clock, log }) : undefined;
	const buildEngine = async () => (overrides.createEngine ?? createEngine)({
		paths,
		config,
		clock,
		log,
		mode,
		detectors: await loadDetectors(),
		sources: {
			procs,
			registry: new SessionRegistry({ paths, config, clock, log }),
			logs: new LogCollector({ logsDir: paths.logsDir }),
			transcripts: createTranscriptIndex({ claudeProjectsDir: paths.claudeProjectsDir, clock }),
			config: createConfigTracker({ paths, clock: () => clock.now(), config: config.config }),
			secrets: () => ({ authBlocks: readAuthBlocks(paths.authFile) }),
		},
		actors: {
			// The category-lane analyst (omo -p): a runner job the engine polls; analyst.enabled switches it without a restart.
			analyst: createAnalyst({ config, paths, clock, log, runner: createRunner({ paths, clock, contracts: { analyst: { parse: parseAnalystOutput, unavailableReason } } }) }),
			evidence,
			db,
			// #55 C: this machine's usual rates per owner, saved in the DB's baseline_samples; deviations only ask for an earlier look.
			baseline: createBaseline({ paths, config, clock, log, db, dbError, tempFiles: () => countTempFiles(os.tmpdir()) }),
			notifier: createNotifier({ paths, clock, config, log }),
			revert: revertSettings,
		},
		options: { selfStats: createSelfStats(), downtime },
	});
	let engine;
	try {
		engine = await buildEngine();
	} catch (error) {
		// The loop's finally never runs: free the DB files (Windows keeps them locked) and the lock for the next start.
		closeDb(db);
		releaseLock(paths);
		throw error;
	}
	// Records and D15 memory survive restarts (updates restart the daemon), so open findings re-send nothing.
	const saveEngineState = () => {
		if (!engine.snapshotState) return;
		try {
			atomicWriteJson(paths.health.stateFile, engine.snapshotState());
		} catch (error) {
			log.error("state_save_failed", { error: error.message });
		}
	};
	try {
		const restored = engine.restoreState?.(readJsonSafe(paths.health.stateFile), clock.now());
		if (restored !== undefined) log.info("state_restored", { records: restored });
	} catch (error) {
		log.error("state_restore_failed", { error: error.message });
	}
	// Opt-in (main passes configEnv): tests that inject a config must not have it replaced by a file.
	const reloader = configEnv ? createConfigReloader({ paths, env: configEnv, config, mode, clock, log }) : undefined;
	let lastStateSaveMs = clock.now();
	let stopping = false;
	const ledgerCache = new Map();
	const boardInvestigations = createInvestigations({ paths, clock });
	const savedBoard = readJsonSafe(paths.health.sessionsSnapshotFile);
	let prevBoard = savedBoard?.v === 1 && clock.now() - (savedBoard.ts ?? 0) <= BOARD_RESUME_MS ? savedBoard : undefined;
	let backfilled = false;
	const daemonStartedMs = clock.now();
	let lastHostSeenMs = clock.now();
	const lastElevate = readJsonSafe(elevateFile)?.atMs;
	let lastElevateMs = Number.isFinite(lastElevate) ? lastElevate : -Infinity;
	const shutdown = (reason) => {
		if (stopping) return;
		stopping = true;
		log.info("daemon_stopping", { reason });
	};
	const processHandlers = {
		SIGINT: () => shutdown("SIGINT"),
		SIGTERM: () => shutdown("SIGTERM"),
		uncaughtException: (error) => log.error("uncaught", { error: error.message, stack: String(error.stack).slice(0, 800) }),
		unhandledRejection: (error) => log.error("unhandled_rejection", { error: String(error?.message ?? error) }),
	};
	for (const [event, handler] of Object.entries(processHandlers)) proc.on(event, handler);
	log.info("daemon_started", { pid: process.pid, mode: mode ?? config.mode, version: VERSION });
	let exitReason = "stopped";
	let packageSourceMissingMs;
	let heartbeat;
	try {
		while (!stopping) {
			const started = clock.now();
			if (statSafe(paths.health.stoppedFile)) {
				exitReason = "stopped-file";
				break;
			}
			const current = readJsonSafe(paths.health.currentFile);
			if (current?.channel === "package") {
				const sourceMissing = typeof current.source !== "string" || !fs.existsSync(current.source);
				if (!sourceMissing) packageSourceMissingMs = undefined;
				else {
					if (packageSourceMissingMs === undefined) packageSourceMissingMs = clock.now();
					const graceMs = Number(env.OMO_HEALTH_ORPHAN_GRACE_MS) || 20 * 60_000;
					if (clock.now() - packageSourceMissingMs >= graceMs) {
						regRunner(["delete", RUN_KEY, "/v", runValueName(env), "/f"]);
						fs.writeFileSync(paths.health.stoppedFile, "");
						exitReason = "package-removed";
						break;
					}
				}
			} else packageSourceMissingMs = undefined;
			// A tick can run long (a resume from sleep): its start goes into the heartbeat first, so a new starter's
			// hung-holder takeover (src/death.mjs) tells a long tick from a hung daemon.
			reloader?.check();
			if (heartbeat) atomicWriteJson(paths.health.daemonJson, { ...heartbeat, tickStartedMs: started, mode: mode ?? config.mode, ...goalLivenessFields(), ...(reloader ? { config: reloader.state() } : {}) });
			let result;
			try {
				result = await engine.tick();
			} catch (error) {
				log.error("tick_failed", { error: error.message, stack: String(error.stack).slice(0, 800) });
			}
			try {
				if (result) writeLedgers(paths, result, clock.now(), ledgerCache);
			} catch (error) {
				log.error("ledger_write_failed", { error: error.message });
			}
			// Report intake must never stop supervision.
			try {
				const intake = acceptReports({ paths, atMs: clock.now(), tickResult: result, capture: evidence.capture });
				// A report whose claim write failed stays queued; the next tick accepts it (once).
				for (const failure of intake.failures) log.error("report_failed", failure);
				// Each recorded report is triaged on the next ticks and answered to the session that owns its subject (#60 item 5).
				for (const entry of intake.accepted) engine.triageReport?.(entry);
			} catch (error) {
				log.error("report_intake_failed", { error: error.message, stack: String(error.stack).slice(0, 800) });
			}
			// Evidence of an opened subagent finding fades within minutes; a failed snapshot must not stop supervision.
			try {
				evidence.tick(result);
			} catch (error) {
				log.error("evidence_failed", { error: error.message, stack: String(error.stack).slice(0, 800) });
			}
			// The session board: the live snapshot, and the sessions that ended since the last one.
			if (result?.world) {
				try {
					const boardNow = clock.now();
					const board = buildSessionSnapshot(result.world, result.findings ?? [], boardInvestigations.list({ sinceMs: boardNow - 7 * DAY_MS }), boardNow);
					atomicWriteJson(paths.health.sessionsSnapshotFile, board);
					if (result.world.procsFresh !== false) {
						for (const record of detectEnded(prevBoard, board, result.world, boardNow)) {
							try {
								appendEnded(paths, record);
							} catch (error) {
								log.error("session_ended_write_failed", { sessionId: record.sessionId, error: error.message });
							}
						}
						prevBoard = board;
					}
				} catch (error) {
					log.error("session_board_failed", { error: error.message, stack: String(error.stack).slice(0, 800) });
				}
			}
			// One-time reconstruction of the last 30 days, after the first tick so the board is up first.
			if (!backfilled) {
				backfilled = true;
				try {
					const summary = backfillOnce(paths, clock.now());
					if (!summary.skipped) log.info("session_backfill", { counts: summary.counts, errors: summary.errors.length, firstError: summary.errors[0] });
				} catch (error) {
					log.error("session_backfill_failed", { error: error.message });
				}
			}
			if (clock.now() - lastRetentionMs >= DAY_MS) {
				lastRetentionMs = clock.now();
				runRetention(paths, lastRetentionMs, log);
			}
			dbMaintainer?.tick(clock.now());
			if (clock.now() - lastStateSaveMs >= 60_000) {
				lastStateSaveMs = clock.now();
				saveEngineState();
			}
			const hosts = engine.table.all().filter(isSenpiHost).length;
			if (hosts > 0) lastHostSeenMs = clock.now();
			heartbeat = {
				pid: process.pid,
				ts: clock.now(),
				startedMs: daemonStartedMs,
				tickStartedMs: started,
				version: VERSION,
				root: paths.repoRoot,
				mode: mode ?? config.mode,
				tickMs: clock.now() - started,
				workerPid: procs.pid,
				integrity: engine.table.integrity,
				liveHosts: hosts,
				findings: result?.findings?.length,
				// omo-limitless parks a session (and exits) only when the running daemon can take it up.
				...goalLivenessFields(),
				...(reloader ? { config: reloader.state() } : {}),
			};
			atomicWriteJson(paths.health.daemonJson, heartbeat);
			if (clock.now() - lastHostSeenMs > config.idleExitMs && !hasPendingParks(paths)) {
				exitReason = "idle-no-omo-hosts";
				break;
			}
			// Only an acting daemon needs the rights; shadow never kills.
			const elevation = (mode ?? config.mode) === "auto" && clock.now() - lastElevateMs >= ELEVATE_BACKOFF_MS ? elevationTarget(result?.world) : undefined;
			if (elevation) {
				lastElevateMs = clock.now();
				atomicWriteJson(elevateFile, { atMs: lastElevateMs, pid: process.pid, integrity: elevation.own, host: elevation.pid, hostIntegrity: elevation.il, sessionId: elevation.sessionId });
				log.info("elevation_handover", elevation);
				exitReason = "elevate";
				break;
			}
			const wait = Math.max(1000, config.tickMs - (clock.now() - started));
			await sleep(wait);
		}
	} finally {
		// The real process keeps them until it exits: bin/ lets the event loop drain after this returns, and a late rejection
		// during cleanup must still be logged, not crash the daemon. An injected proc (tests) must not keep them.
		if (proc !== process) for (const [event, handler] of Object.entries(processHandlers)) proc.off(event, handler);
		saveEngineState();
		engine.close();
		closeDb(db);
		releaseLock(paths);
		const hb = readJsonSafe(paths.health.daemonJson) ?? {};
		atomicWriteJson(paths.health.daemonJson, { ...hb, stoppedMs: clock.now(), exitReason });
		log.info("daemon_exit", { reason: exitReason });
	}
	return { exitCode: 0, reason: exitReason };
}
