import fs from "node:fs";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** Every threshold here is referenced by the plan (IS-*, todo 1). */
export const DEFAULT_CONFIG = Object.freeze({
	tickMs: 15_000,
	procSnapshotMs: 20_000,
	mode: "auto",
	stall: {
		softMs: 5 * MIN,
		runawayReadonlyMs: 10 * MIN,
		serverForegroundMs: 2 * MIN,
		blockedInputMs: 3 * MIN,
		unboundedWaitMs: 15 * MIN,
		// An unknown stall (R11) only opens an investigation at this age; the analyst decides whether it is stuck.
		unknownJudgeMs: 10 * MIN,
		noProgressMs: 10 * MIN,
		progressingMaxMs: 60 * MIN,
		// #52: a child's call with no transcript event and no output this long is a stall suspicion, whatever its class: it
		// opens an investigation, and only an analyst verdict releases it.
		quietMs: 15 * MIN,
		// A task that stalled within restallWindowMs is looked at after restallMs instead of quietMs.
		restallWindowMs: 60 * MIN,
		restallMs: 5 * MIN,
		inprocToolRelayMs: 20 * MIN,
		mainNotifyMs: 20 * MIN,
		boundGraceMs: 60_000,
		cpuBusyFrac: 0.8,
		cpuIdleFrac: 0.02,
		cpuSamples: 2,
		verifyResultMs: 90_000,
		repeatWindowMs: 30 * MIN,
		sleepUnboundedSec: 3600,
		matchWindowBeforeMs: 10_000,
		matchWindowAfterMs: 120_000,
	},
	memory: {
		growthMBPerMin: 100,
		growthWindowMs: 5 * MIN,
		treeMaxBytes: 4 * 1024 * 1024 * 1024,
		commitFrac: 0.9,
		// Under commit pressure only a tree this big is worth killing (a 139 MB server at 91% commit is not the cause).
		pressureMinBytes: 1024 * 1024 * 1024,
	},
	tokens: {
		cacheStormWrite: 100_000,
		cacheStormReadFrac: 0.25,
		burnPerHour: 2_000_000,
		burnMultiple: 3,
		resendCount: 50,
		contextMax: 400_000,
		contextGrowth: 50_000,
		contextTurns: 3,
		// A burn spike stays open this long after its condition last held, so a sliding hour that dips under the threshold for
		// one tick is one episode, not a resolve and a reopen.
		burnHoldMs: 10 * MIN,
	},
	tps: {
		minTps: 15,
		window: 5,
		slowTurnMs: 60_000,
		slowTurns: 3,
		minOutput: 50,
		minDurMs: 2000,
	},
	provider: {
		burst: 3,
		burstWindowMs: 60_000,
		stormCount: 3,
		stormWindowMs: 30 * MIN,
		outageHumanMs: 5 * MIN,
	},
	config: {
		autoRevert: true,
		revertErrorWindowMs: 60_000,
		lkgQuietMs: 3 * MIN,
		laneOkLookbackMs: 30 * MIN,
		revertCooldownMs: 10 * MIN,
	},
	orphans: {
		deadChildMs: 30 * MIN,
		/** Issue #93: a child whose last record is a rate/usage-limit error may be in senpi's retry sleep (usage-limit cooldown is 30 min); wait this long from the error before calling it dead. */
		retryWaitMs: 35 * MIN,
		/** Ceiling for the wait when the error text carries a provider retry time ("Soonest automatic retry: <iso>"). */
		retryWaitMaxMs: 2 * 60 * MIN,
		/** #82: a task record rewritten to `running` (revive) this recently is not judged dead yet; omo-task rewrites a running record only on discrete events, never on a timer, so each write holds at most this long. */
		reviveGraceMs: 5 * MIN,
		parentIdleMs: 15 * MIN,
		hungTurnMs: 30 * MIN,
		errorStopTurns: 3,
	},
	leftovers: { minAgeMs: 30 * MIN },
	monitorOrphans: { enabled: true, graceMs: MIN },
	/** D18 (issue #46): only a crash this recent is resumed; per session at most perHour resumes; loopCount crashes within loopWindowMs stop it; the new sensor must appear within startupMs. */
	crashResume: { maxAgeMs: 10 * MIN, perHour: 2, loopCount: 2, loopWindowMs: 30 * MIN, startupMs: 3 * MIN },
	/**
	 * C7 (plan todo 7): D21 and what omo-limitless asks about. `enabled` turns D21 on and advertises the `goal-liveness`
	 * capability in daemon.json and its `goalLiveness` block. A goal wait whose wake source is gone is woken once it has been
	 * gone for graceMs; under the omo-keepalive hold, one with no session event for livenessMs is woken; minWakeGapMs spaces wakes.
	 * 0.8.0: silent is deferred while any live work source showed progress within quietMs; a workflow node whose task already
	 * ended (or a run with nothing runnable) is a stuck wait after foldGraceMs; a live but idle monitor or background session
	 * is asked about first and woken at the latest idleWakeHoldMs after it was found.
	 */
	goalLiveness: { enabled: true, livenessMs: 3_570_000, graceMs: 120_000, minWakeGapMs: 3_570_000, quietMs: 30 * MIN, foldGraceMs: 2 * MIN, idleWakeHoldMs: 10 * MIN },
	/**
	 * D23 (0.8.0): after omo-health was down at least minGapMs (a reboot or a crash longer than D18 can resume), each main
	 * session that comes back gets one notice about the subagents and workflow runs that were live before the gap and did not
	 * survive it, settleMs after it is live again and within windowMs of the restart. Gap records are kept keepDays.
	 */
	bootGap: { enabled: true, minGapMs: 10 * MIN, settleMs: 2 * MIN, windowMs: D, keepDays: 7 },
	/** 0.8.0: eval-cell logs an analyst bundle may carry for the subject session: at most maxFiles, the last tailBytes each, written within windowMs. */
	evalLogs: { maxFiles: 3, tailBytes: 4096, windowMs: H },
	reflectionOrphans: { enabled: true, graceMs: 10 * MIN },
	// maxHoldMs (#55 C): however the judge answers, a relaunch loop is killed once it has been seen this long.
	respawn: { enabled: true, windowMs: 5 * MIN, minBirths: 6, minSnapshots: 5, presenceFrac: 0.6, maxSurvivorFrac: 0.25, confirmMs: MIN, killAfterMs: 3 * MIN, maxHoldMs: 30 * MIN },
	loops: {
		sameCallCount: 5,
		sameCallWindowMs: 10 * MIN,
		errorStormCount: 5,
		errorStormWindowMs: 60_000,
	},
	reload: { starvationMs: 10 * MIN },
	analyst: {
		enabled: true,
		lane: "deep-low",
		fallbackModel: "anthropic-subscription/claude-sonnet-5-5:high",
		command: "omo",
		timeoutMs: 5 * MIN,
		maxConcurrent: 1,
		perFinding: 2,
		perHour: 8,
		perDay: 40,
		actConfidence: 0.8,
		retryMs: 15 * MIN,
		holdToastMs: H,
		repeatWindowMs: 30 * MIN,
		reports: { perDay: 3 },
	},
	history: { retentionDays: 90, baselineDays: 7, checkpointMs: 60 * MIN },
	anomaly: { enabled: true, minShapeSamples: 20, outlierQuantile: 0.99, outlierFactor: 3, perHour: 6, windowSignal: true },
	/**
	 * #55 C: baseline-deviation signals. Per owner (a pending tool call and its process tree) and once per sampleMs:
	 * births per minute, CPU cores, private-memory growth (MB/min) and write growth (MB/min) over rateWindowMs, plus the
	 * machine's temp-file growth (files/min, every tempScanMs). A value deviates when it is above floors, above the
	 * quantile of this machine's samples of the last windowMs (at most maxSamples) and at least zMin robust z-scores above
	 * their median, for persistSamples samples in a row. Nothing fires before minSamples samples over minSpanMs (a fresh
	 * install never does). A deviation only asks the judge to look earlier; it never acts on its own.
	 */
	baseline: {
		enabled: true,
		windowMs: 7 * D,
		maxSamples: 4000,
		sampleMs: MIN,
		rateWindowMs: 5 * MIN,
		minOwnerAgeMs: 2 * MIN,
		minSamples: 200,
		minSpanMs: D,
		quantile: 0.995,
		zMin: 6,
		persistSamples: 2,
		floors: { births: 3, cpu: 1, mem: 50, writes: 20, temp: 500 },
		tempScanMs: 5 * MIN,
		saveMs: 5 * MIN,
	},
	actions: {
		kill: true,
		detach: true,
		release: true,
		relay: true,
		wake: true,
		nudge: true,
		revert: true,
		// R1-B3: off until the live stub-provider canary proves abort + resume works.
		abortHungTurn: false,
		toast: true,
		// D18: reopen a crashed session that had unfinished work in a new herdr tab.
		resume: true,
	},
	notify: { toastCooldownMs: 12 * 60 * MIN, repeatMs: 30 * MIN },
	sessions: { recentMs: 6 * 60 * MIN, tailBytes: 2 * 1024 * 1024 },
	idleExitMs: 30 * MIN,
	extraProjects: [],
	/** Session ids (a session, its parent or its root must match) that actions may touch; empty = all. For canary runs with accelerated thresholds. */
	actionScope: [],
	sensorSpawnCooldownMs: 2 * MIN,
	daemonStaleMs: 45_000,
	selfBudget: { rssBytes: 300 * 1024 * 1024, cpuFrac: 0.05 },
	/** The footer shows only subagent problems (engine onFooter); true brings back every finding. */
	footer: { showAll: false },
	align: { enabled: true, churnEdits: 8, churnWindowMs: 90 * MIN, failRepeats: 8, reviewLoops: 4, idleGapMs: 15 * MIN, stuckSteps: 12, stuckActiveMs: 20 * MIN, noDoneSteps: 40, repeatSteps: 6, afterCompleteMutations: 10, minGapMs: 45 * MIN, perDay: 4, requireVerdict: true },
});

const ENUMS = { mode: ["auto", "shadow"] };

/** The operator switches the daemon reports as effective (heartbeat `config.effective`) and the dashboard can flip. */
export const SWITCH_KEYS = Object.freeze(["mode", "actions.kill", "actions.detach", "actions.release", "monitorOrphans.enabled", "config.autoRevert", "align.enabled", "analyst.enabled", "goalLiveness.enabled", "footer.showAll"]);

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge `override` onto `base`, keeping only keys that exist in the defaults
 * and whose type matches. Invalid entries are skipped and reported, so a typo
 * in config.json never disables supervision.
 */
function mergeValidated(base, override, pathPrefix, warnings) {
	const out = Array.isArray(base) ? [...base] : { ...base };
	if (!isPlainObject(override)) return out;
	for (const [key, value] of Object.entries(override)) {
		const where = pathPrefix ? `${pathPrefix}.${key}` : key;
		if (!(key in base)) {
			warnings.push(`unknown config key ignored: ${where}`);
			continue;
		}
		const def = base[key];
		if (isPlainObject(def)) {
			if (!isPlainObject(value)) {
				warnings.push(`config ${where} must be an object; ignored`);
				continue;
			}
			out[key] = mergeValidated(def, value, where, warnings);
		} else if (Array.isArray(def)) {
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
				warnings.push(`config ${where} must be an array of strings; ignored`);
				continue;
			}
			out[key] = [...value];
		} else if (typeof def === "number") {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				warnings.push(`config ${where} must be a non-negative number; ignored`);
				continue;
			}
			out[key] = value;
		} else if (typeof def === "boolean") {
			if (typeof value !== "boolean") {
				warnings.push(`config ${where} must be a boolean; ignored`);
				continue;
			}
			out[key] = value;
		} else if (typeof def === "string") {
			if (typeof value !== "string" || (ENUMS[where] && !ENUMS[where].includes(value))) {
				warnings.push(`config ${where} has an invalid value; ignored`);
				continue;
			}
			out[key] = value;
		}
	}
	return out;
}

/** Parsed JSON, or undefined when the file is missing (ENOENT) or unreadable; unreadable files are reported in both lists. */
function readJsonFile(file, warnings, unreadable) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		if (error.code !== "ENOENT") {
			warnings.push(`config file unreadable (${file}): ${error.message}`);
			unreadable.push({ file, message: error.message });
		}
		return undefined;
	}
}

/**
 * Load the effective config: defaults <- ~/.omo-health/config.json (or its last good copy when it is unreadable)
 * <- file at $OMO_HEALTH_CONFIG <- explicit overrides (CLI). The returned config is a deep copy.
 */
export function loadConfig({ env = process.env, paths, overrides } = {}) {
	const warnings = [];
	const unreadable = [];
	let usedLastGood = false;
	let config = mergeValidated(DEFAULT_CONFIG, {}, "", warnings);
	const sources = [];
	const userFile = paths?.health?.configFile;
	if (userFile) {
		const unreadableBefore = unreadable.length;
		let user = readJsonFile(userFile, warnings, unreadable);
		let source = userFile;
		const lastGoodFile = paths.health.configLastGoodFile;
		if (unreadable.length > unreadableBefore && lastGoodFile) {
			const copy = readJsonFile(lastGoodFile, [], []);
			if (copy !== undefined) {
				user = copy;
				source = lastGoodFile;
				usedLastGood = true;
				warnings.push(`config file unreadable, using the last good copy: ${lastGoodFile}`);
			}
		}
		if (user !== undefined) {
			config = mergeValidated(config, user, "", warnings);
			sources.push(source);
		}
	}
	if (env.OMO_HEALTH_CONFIG) {
		const extra = readJsonFile(env.OMO_HEALTH_CONFIG, warnings, unreadable);
		if (extra !== undefined) {
			config = mergeValidated(config, extra, "", warnings);
			sources.push(env.OMO_HEALTH_CONFIG);
		} else {
			warnings.push(`OMO_HEALTH_CONFIG points to a missing or invalid file: ${env.OMO_HEALTH_CONFIG}`);
		}
	}
	if (overrides) config = mergeValidated(config, overrides, "", warnings);
	// mergeValidated shares untouched sub-objects with the frozen DEFAULT_CONFIG; callers mutate this copy in place.
	return { config: structuredClone(config), warnings, sources, unreadable, usedLastGood };
}

function applyInto(target, next, prefix, changed) {
	for (const key of Object.keys(target)) {
		if (Object.hasOwn(next, key)) continue;
		changed.push({ key: prefix + key, from: structuredClone(target[key]), to: undefined });
		delete target[key];
	}
	for (const [key, value] of Object.entries(next)) {
		const where = prefix + key;
		const current = target[key];
		if (isPlainObject(value) && isPlainObject(current)) {
			applyInto(current, value, `${where}.`, changed);
		} else if (Array.isArray(value) && Array.isArray(current)) {
			if (JSON.stringify(current) === JSON.stringify(value)) continue;
			changed.push({ key: where, from: structuredClone(current), to: structuredClone(value) });
			current.length = 0;
			current.push(...structuredClone(value));
		} else if (!Object.is(current, value)) {
			changed.push({ key: where, from: structuredClone(current), to: structuredClone(value) });
			target[key] = structuredClone(value);
		}
	}
}

/**
 * Make `target` deep-equal to `next` without replacing any object or array already inside it, so
 * holders of a sub-object (createConfigTracker keeps `config.config`) see the new values.
 * @returns {{ key: string, from: unknown, to: unknown }[]} leaf changes
 */
export function applyConfigInPlace(target, next) {
	const changed = [];
	applyInto(target, next, "", changed);
	return changed;
}

/** Flat `{ [SWITCH_KEYS[i]]: value }` in SWITCH_KEYS order; `mode` is the --shadow override when given. */
export function effectiveSwitches(config, mode) {
	return Object.fromEntries(SWITCH_KEYS.map((key) => [key, key === "mode" ? (mode ?? config.mode) : key.split(".").reduce((node, part) => node?.[part], config)]));
}
