import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve every filesystem location omo-health reads or writes.
 * All roots can be redirected through environment variables so tests,
 * replays and sandboxes never touch the real ~/.omo or ~/.claude.
 */
export function resolvePaths(env = process.env) {
	const home = env.USERPROFILE || env.HOME || os.homedir();
	const healthHome = env.OMO_HEALTH_HOME || path.join(home, ".omo-health");
	const omoHome = env.OMO_HEALTH_OMO_HOME || path.join(home, ".omo");
	const claudeHome = env.OMO_HEALTH_CLAUDE_HOME || path.join(home, ".claude");
	const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
	const npmOmoRoot = env.OMO_HEALTH_NPM_OMO_ROOT || path.join(appData, "npm", "node_modules", "omo-ai");
	const bunOmoRoot = path.join(home, ".bun", "install", "global", "node_modules", "omo-ai");
	const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
	const agentDir = path.join(omoHome, "agent");
	const appDir = path.join(healthHome, "app");
	const careDir = path.join(healthHome, "care");
	const jobsDir = path.join(healthHome, "jobs");
	return {
		home,
		repoRoot,
		omoHome,
		claudeHome,
		npmOmoRoot,
		bunOmoRoot,
		npmOmoOverride: Boolean(env.OMO_HEALTH_NPM_OMO_ROOT),
		agentDir,
		logsDir: path.join(agentDir, "logs"),
		sessionsDir: path.join(agentDir, "sessions"),
		settingsFile: path.join(agentDir, "settings.json"),
		authFile: path.join(agentDir, "auth.json"),
		extensionsDir: path.join(agentDir, "extensions"),
		omoJsonc: path.join(omoHome, "omo.jsonc"),
		claudeProjectsDir: path.join(claudeHome, "projects"),
		claudeSettingsFile: path.join(claudeHome, "settings.json"),
		healthHome,
		health: {
			dbFile: path.join(healthHome, "omo-health.db"),
			investigationsDir: path.join(healthHome, "investigations"),
			analystJobsDir: jobsDir,
			legacyCareDir: careDir,
			configFile: path.join(healthHome, "config.json"),
			configLastGoodFile: path.join(healthHome, "config.last-good.json"),
			daemonJson: path.join(healthHome, "daemon.json"),
			lockFile: path.join(healthHome, "daemon.lock"),
			pauseFile: path.join(healthHome, "pause"),
			stoppedFile: path.join(healthHome, "stopped"),
			stateFile: path.join(healthHome, "state.json"),
			baselineFile: path.join(healthHome, "baseline.json"),
			sensorsDir: path.join(healthHome, "sensors"),
			inboxDir: path.join(healthHome, "inbox"),
			receiptsDir: path.join(healthHome, "receipts"),
			statusDir: path.join(healthHome, "status"),
			/** Live session board snapshot, written atomically by the daemon each tick. */
			sessionsSnapshotFile: path.join(healthHome, "status", "_sessions.json"),
			/** Ended-session ledger: one ended-YYYY-MM-DD.jsonl per UTC day. */
			sessionsDir: path.join(healthHome, "sessions"),
			reportsDir: path.join(healthHome, "reports"),
			decisionsDir: path.join(healthHome, "decisions"),
			lkgDir: path.join(healthHome, "lkg"),
			judgeDir: path.join(healthHome, "judge"),
			logsDir: path.join(healthHome, "logs"),
			binDir: path.join(healthHome, "bin"),
			appDir,
			currentFile: path.join(appDir, "current.json"),
			bootFile: path.join(appDir, "boot.mjs"),
			bootStateFile: path.join(appDir, "boot-state.json"),
			releasesDir: path.join(appDir, "releases"),
			// Runner jobs (src/runner.mjs): one directory per job, shared with the analyst's bundle and metadata.
			jobsDir,
			alignmentDir: path.join(healthHome, "alignment"),
			snapshotsDir: path.join(healthHome, "snapshots"),
			/** Death records: boot, the sensor and the hung-holder takeover write here; the daemon imports them. */
			deathsDir: path.join(healthHome, "deaths"),
			/** `omo-health report` and `/health report` queue here; only the daemon turns them into incidents (G05). */
			intakeDir: path.join(healthHome, "intake"),
			parksDir: path.join(healthHome, "parks"),
			/** One record per daemon downtime that crossed bootGap.minGapMs (D23). */
			bootGapsDir: path.join(healthHome, "boot-gaps"),
		},
	};
}

/** Prefer the installed bun global package; retain the npm layout and explicit npm override. */
export function installedOmoRoot(paths) {
	return !paths.npmOmoOverride && paths.bunOmoRoot && fs.existsSync(path.join(paths.bunOmoRoot, "package.json")) ? paths.bunOmoRoot : paths.npmOmoRoot;
}

/** Claude Code's per-project transcript directory name for a cwd. */
export function encodeClaudeProjectDir(cwd) {
	return String(cwd).replace(/[:\\/.]/g, "-");
}

/** Case-insensitive, slash-normalized path key for Windows comparisons. */
export function pathKey(p) {
	return path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when `child` is `parent` or inside it (Windows-insensitive). */
export function isInside(child, parent) {
	const c = pathKey(child);
	const p = pathKey(parent);
	return c === p || c.startsWith(`${p}/`);
}
