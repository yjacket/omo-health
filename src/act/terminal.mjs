import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { pathKey } from "../paths.mjs";

/** True iff every foreground process of the pane is the shell itself (idle prompt). */
export function isIdleShell(processInfo) {
	if (!processInfo || typeof processInfo !== "object") return false;
	const procs = processInfo.foreground_processes;
	if (!Array.isArray(procs) || procs.length === 0) return false;
	if (!Number.isFinite(processInfo.shell_pid)) return false;
	return procs.every((p) => p && p.pid === processInfo.shell_pid);
}

/** True when both are non-empty strings naming the same directory. */
export function sameDir(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
	return pathKey(a) === pathKey(b);
}

/**
 * The first prompt of a crash-resumed session (#109). Since omo 5.1.48 a session that died mid-run reopens under an
 * interrupted-run hold: extension messages only queue until a person types, while a command-line prompt counts as that
 * input and starts the turn. Older omo starts the turn from it the same way. Plain ASCII so every shell quotes it alike.
 */
export const CRASH_RESUME_PROMPT = "[omo-health] Reopened after a host crash. Check the worktree state and continue.";

/** The shell command that resumes a session, or undefined for an unsafe id or prompt (no quotes or shell metacharacters). */
export function resumeCommand(sessionId, prompt) {
	if (typeof sessionId !== "string") return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(sessionId)) return undefined;
	if (prompt === undefined) return `omo --session ${sessionId}`;
	if (typeof prompt !== "string" || !/^[A-Za-z0-9 .,:;()[\]-]{1,200}$/.test(prompt)) return undefined;
	return `omo --session ${sessionId} "${prompt}"`;
}

function parseJsonLine(text) {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {}
	const lines = trimmed.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]);
		} catch {}
	}
	return undefined;
}

/** Creates a herdr CLI runner: call(terminal, args) -> { ok, result } | { ok:false, code, message }. */
export function createHerdrCli({ spawnSync = nodeSpawnSync, env = process.env, exists = existsSync, timeoutMs = 15_000 } = {}) {
	return {
		call(terminal, args) {
			const bp = terminal?.binPath;
			const bin = typeof bp === "string" && /^herdr(\.exe)?$/i.test(basename(bp.replace(/\\/g, "/"))) && exists(bp) ? bp : "herdr";
			const childEnv = { ...env };
			if (typeof terminal?.socketPath === "string" && terminal.socketPath) childEnv.HERDR_SOCKET_PATH = terminal.socketPath;
			const r = spawnSync(bin, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, env: childEnv });
			if (r?.error) return { ok: false, code: "spawn-error", message: String(r.error.message ?? r.error) };
			const parsed = parseJsonLine(r?.stdout) ?? parseJsonLine(r?.stderr);
			if (parsed && typeof parsed === "object" && parsed.error) {
				return { ok: false, code: parsed.error.code ?? `exit-${r.status}`, message: String(parsed.error.message ?? "") };
			}
			if (r?.status !== 0) return { ok: false, code: `exit-${r?.status}`, message: String(r?.stderr ?? "") };
			// `herdr pane run` prints nothing on success (herdr 0.9.0, live).
			if (!String(r?.stdout ?? "").trim() && !String(r?.stderr ?? "").trim()) return { ok: true, result: undefined };
			if (!parsed || typeof parsed !== "object") return { ok: false, code: "bad-json", message: "unparseable herdr output" };
			return { ok: true, result: parsed.result };
		},
	};
}

/**
 * Resumes a crashed session in a NEW herdr tab; the crashed pane is only inspected, never written to.
 * env: variables the new tab's shell must carry (herdr tabs do not inherit a workspace's --env).
 * A new tab's shell is listed as its foreground process only after a moment (live: empty list right after
 * `tab create`, the shell ~0.7 s later), so its check is retried readyTries times, readyDelayMs apart.
 */
export async function resumeInNewTab({ terminal, cwd, sessionId, prompt, label, cli, env = {}, exists = existsSync, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), readyTries = 10, readyDelayMs = 500 }) {
	if (terminal?.kind !== "herdr" || typeof terminal.workspaceId !== "string" || typeof terminal.paneId !== "string") {
		return { ok: false, reason: "no-terminal" };
	}
	const command = resumeCommand(sessionId, prompt);
	if (!command) return { ok: false, reason: "bad-session-id" };
	if (typeof cwd !== "string" || !cwd || !exists(cwd)) return { ok: false, reason: "cwd-missing" };

	const got = cli.call(terminal, ["pane", "get", terminal.paneId]);
	if (!got.ok) return { ok: false, reason: got.code === "pane_not_found" ? "pane-gone" : "herdr-error", detail: got.code };
	if (!sameDir(got.result?.pane?.cwd, cwd)) return { ok: false, reason: "pane-cwd-mismatch" };

	const info = cli.call(terminal, ["pane", "process-info", "--pane", terminal.paneId]);
	if (!info.ok) return { ok: false, reason: "herdr-error", detail: info.code };
	if (!isIdleShell(info.result?.process_info)) return { ok: false, reason: "pane-busy" };

	const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	const created = cli.call(terminal, ["tab", "create", "--workspace", terminal.workspaceId, "--cwd", cwd, "--label", label, ...envArgs, "--no-focus"]);
	if (!created.ok) return { ok: false, reason: "tab-create-failed", detail: created.code };
	const tabId = created.result?.tab?.tab_id;
	const paneId = created.result?.root_pane?.pane_id;
	if (!tabId || !paneId) return { ok: false, reason: "tab-create-failed" };

	const closeTab = () => cli.call(terminal, ["tab", "close", tabId]);
	let fresh;
	for (let attempt = 1; attempt <= readyTries; attempt++) {
		fresh = cli.call(terminal, ["pane", "process-info", "--pane", paneId]);
		if (fresh.ok && isIdleShell(fresh.result?.process_info)) break;
		if (attempt < readyTries) await sleep(readyDelayMs);
	}
	if (!fresh.ok || !isIdleShell(fresh.result?.process_info) || !sameDir(created.result?.root_pane?.cwd, cwd)) {
		closeTab();
		return { ok: false, reason: "new-tab-not-ready", tabId };
	}
	const ran = cli.call(terminal, ["pane", "run", paneId, command]);
	if (!ran.ok) {
		closeTab();
		return { ok: false, reason: "run-failed", detail: ran.code, tabId };
	}
	return { ok: true, tabId, paneId, command };
}
