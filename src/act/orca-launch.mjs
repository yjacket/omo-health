import { spawnSync as nodeSpawnSync } from "node:child_process";

const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;

/**
 * Launch a session in Orca by creating a new terminal.
 *
 * @param {object} opts - Options
 * @param {string} opts.cwd - Working directory for the new terminal
 * @param {string} opts.sessionId - The session ID to resume (8-80 chars, alphanumeric + dash)
 * @param {string} [opts.qaCommandPrefix] - (QA only) Prefix to prepend to the command when OMO_HEALTH_QA=1
 * @param {object} [deps] - Dependency overrides for testing
 * @param {Function} [deps.spawnSync] - spawnSync function (default: node:child_process)
 * @param {object} [deps.env] - Environment variables (default: process.env)
 * @returns {object} {ok:true, handle} on success, or {ok:false, reason} on failure
 */
export function launchInOrca(
	{ cwd, sessionId, qaCommandPrefix },
	{ spawnSync = nodeSpawnSync, env = process.env } = {}
) {
	// Validate sessionId
	if (typeof sessionId !== "string" || !SESSION_ID_REGEX.test(sessionId)) {
		return { ok: false, reason: "invalid-sid" };
	}

	// Validate cwd
	if (typeof cwd !== "string" || !cwd) {
		return { ok: false, reason: "invalid-cwd" };
	}

	// Resolve the Orca CLI command
	const orcaCmd = env.ORCA_CLI_COMMAND || "orca";

	// Confirm orca status
	const statusResult = spawnSync(orcaCmd, ["status", "--json"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 15000,
		env,
	});

	if (statusResult?.error || statusResult?.status !== 0) {
		return { ok: false, reason: "orca-not-running" };
	}

	try {
		JSON.parse(statusResult.stdout);
	} catch {
		return { ok: false, reason: "orca-status-invalid" };
	}

	// Find the worktree selector for the cwd
	const worktreeResult = spawnSync(orcaCmd, ["worktree", "ps", "--json"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 15000,
		env,
	});

	if (worktreeResult?.error || worktreeResult?.status !== 0) {
		return { ok: false, reason: "orca-worktree-failed" };
	}

	let worktrees;
	try {
		worktrees = JSON.parse(worktreeResult.stdout);
	} catch {
		return { ok: false, reason: "orca-worktree-invalid" };
	}

	// Find matching worktree for cwd (normalize paths for case-insensitive comparison on Windows)
	const normalizedCwd = normalizePath(cwd);
	let selectedWorktree = null;

	if (Array.isArray(worktrees.result?.worktrees)) {
		for (const wt of worktrees.result.worktrees) {
			if (normalizePath(wt.path) === normalizedCwd) {
				selectedWorktree = wt;
				break;
			}
		}
	}

	if (!selectedWorktree) {
		return { ok: false, reason: "no-worktree-match" };
	}

	// Extract worktree selector (use the selector or path)
	const worktreeId = selectedWorktree.worktreeId ?? selectedWorktree.id;
	const wtSelector = typeof worktreeId === "string" && worktreeId
		? `id:${worktreeId}`
		: `path:${selectedWorktree.path}`;

	// Build the command - prefix with qaCommandPrefix if OMO_HEALTH_QA=1
	let command = `omo --session ${sessionId}`;
	if (env.OMO_HEALTH_QA === "1" && typeof qaCommandPrefix === "string") {
		// Orca types --command into Windows PowerShell 5.1 (no `&&`), so the prefix uses PowerShell env syntax:
		// 1-3 `$env:OMO_(LIMITLESS|HEALTH)_X='v'; ` segments, values free of quotes and shell metacharacters.
		if (/^(?:\$env:OMO_(?:LIMITLESS|HEALTH)_[A-Z_]+='[^'"`$;&|<>^%\r\n]+'; ){1,3}$/.test(qaCommandPrefix)) {
			command = qaCommandPrefix + command;
		}
	}

	// Shorten sessionId to 8 chars for display
	const sid8 = sessionId.substring(0, 8);

	// Run orca terminal create
	const terminalResult = spawnSync(
		orcaCmd,
		[
			"terminal",
			"create",
			"--worktree",
			wtSelector,
			"--title",
			`resume ${sid8}`,
			"--command",
			command,
			"--json",
		],
		{
			encoding: "utf8",
			windowsHide: true,
			timeout: 15000,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		}
	);

	if (terminalResult?.error || terminalResult?.status !== 0) {
		return { ok: false, reason: "terminal-create-failed" };
	}

	let terminalJson;
	try {
		terminalJson = JSON.parse(terminalResult.stdout);
	} catch {
		return { ok: false, reason: "terminal-create-invalid" };
	}

	// Extract handle from the response
	const handle = terminalJson.result?.terminal?.handle ?? terminalJson.result?.handle;
	if (!handle) {
		return { ok: false, reason: "no-handle-returned" };
	}

	return { ok: true, handle };
}

/**
 * Normalize a path for comparison (lowercase on Windows for case-insensitive matching).
 * @param {string} p - Path to normalize
 * @returns {string} Normalized path
 */
function normalizePath(p) {
	if (typeof p !== "string") return "";
	// Normalize separators and make lowercase on Windows
	const normalized = p.replace(/\\/g, "/").toLowerCase();
	// Remove trailing slashes
	return normalized.replace(/\/$/, "");
}
