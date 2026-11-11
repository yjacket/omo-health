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
 * input and starts the turn. Older omo starts the turn from it the same way. Since omo 5.1.65 (senpi 2026.11.6-2) a
 * session that died with an active goal first asks "Resume blocked goal?" in the TUI and runs this prompt only after a
 * person answers; D18 then answers that chooser itself (answerResumeChooser). Plain ASCII so every shell quotes it alike.
 */
export const CRASH_RESUME_PROMPT = "[omo-health] Reopened after a host crash. Check the worktree state and continue.";

/**
 * The goal chooser of omo 5.1.65+ (senpi 2026.11.6-2 to 2026.11.10, goal/index.js maybePromptResumeStoppedGoal):
 * `ctx.ui.select("Resume ${goal.status} goal?\nGoal: ...", ["Resume goal", "Leave stopped"])`, drawn by
 * extension-selector.js with "→ " before the highlighted option. Selection starts at the first option.
 */
const CHOOSER_TITLE = /^\s*Resume [a-z]+ goal\?(?: \(\d+s\))?\s*$/;
const CHOOSER_DEFAULT = /^\s*→ Resume goal\s*$/;
const CHOOSER_OTHER = /^\s*(?:→ )?Leave stopped\s*$/;
/** The chooser replaces the editor, so its options sit right above the key hint, border and footer. */
const CHOOSER_TAIL_LINES = 12;

/**
 * Is the resume chooser on this screen, with "Resume goal" highlighted so Enter picks it?
 * @returns {"shown"|"absent"|"not-default"}
 */
export function resumeChooserState(screen) {
	const lines = String(screen ?? "").split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).filter(Boolean);
	const title = lines.findLastIndex((line) => CHOOSER_TITLE.test(line));
	if (title < 0) return "absent";
	const rest = lines.slice(title + 1);
	const resume = rest.findIndex((line) => /^\s*(?:→ )?Resume goal\s*$/.test(line));
	if (resume < 0 || !CHOOSER_OTHER.test(rest[resume + 1] ?? "")) return "absent";
	if (lines.length - (title + 1 + resume) > CHOOSER_TAIL_LINES) return "absent";
	return CHOOSER_DEFAULT.test(rest[resume]) ? "shown" : "not-default";
}

/**
 * The pid of this session's omo host under the pane's shell: a descendant started with `--session <sessionId>` (the
 * deepest one, the engine itself), or undefined. Read from the process table, not herdr's foreground list: on Windows
 * herdr lists only the shell while omo runs (herdr 0.9.3, live). The reopened host's sensor cannot vouch for it: the
 * chooser holds session_start, so the new sensor writes no heartbeat until it is answered (omo 5.1.68, live).
 */
export function sessionHostInPane(processInfo, table, sessionId) {
	const shell = processInfo?.shell_pid;
	if (!Number.isFinite(shell) || typeof sessionId !== "string" || !sessionId || typeof table?.descendants !== "function") return undefined;
	const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const started = new RegExp(`(?:^|\\s)--session\\s+"?${escaped}"?(?:\\s|$)`);
	const hosts = table.descendants(shell).filter((p) => started.test(p.cmd ?? ""));
	return hosts.find((p) => !hosts.some((q) => q !== p && table.ancestors(q.pid).some((a) => a.pid === p.pid)))?.pid;
}

/**
 * Answers the goal chooser of a session D18 reopened (option 2 of health#9): only in the pane D18 itself created
 * (`terminal.paneId`), only while this session's omo host runs under that pane's shell (`table`: a fresh ProcessTable),
 * and only when the chooser is on screen with "Resume goal" highlighted. Sends Enter once.
 * @returns {{state: "sent"|"no-host"|"absent"|"not-default"|"herdr-error", hostPid?: number, detail?: string}}
 */
export function answerResumeChooser({ terminal, sessionId, table, cli }) {
	const paneId = terminal?.paneId;
	if (typeof paneId !== "string" || !paneId) return { state: "no-host", detail: "pane" };
	const info = cli.call(terminal, ["pane", "process-info", "--pane", paneId]);
	if (!info.ok) return { state: "herdr-error", detail: info.code };
	const hostPid = sessionHostInPane(info.result?.process_info, table, sessionId);
	if (hostPid === undefined) return { state: "no-host" };
	const screen = cli.read(terminal, paneId);
	if (!screen.ok) return { state: "herdr-error", hostPid, detail: screen.code };
	const state = resumeChooserState(screen.text);
	if (state !== "shown") return { state, hostPid };
	const sent = cli.call(terminal, ["pane", "send-keys", paneId, "enter"]);
	if (!sent.ok) return { state: "herdr-error", hostPid, detail: sent.code };
	return { state: "sent", hostPid };
}

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

/**
 * Creates a herdr CLI runner: call(terminal, args) -> { ok, result } | { ok:false, code, message };
 * read(terminal, paneId) -> { ok, text } | { ok:false, code } (the visible screen as plain text).
 */
export function createHerdrCli({ spawnSync = nodeSpawnSync, env = process.env, exists = existsSync, timeoutMs = 15_000 } = {}) {
	const run = (terminal, args) => {
		const bp = terminal?.binPath;
		const bin = typeof bp === "string" && /^herdr(\.exe)?$/i.test(basename(bp.replace(/\\/g, "/"))) && exists(bp) ? bp : "herdr";
		const childEnv = { ...env };
		if (typeof terminal?.socketPath === "string" && terminal.socketPath) childEnv.HERDR_SOCKET_PATH = terminal.socketPath;
		return spawnSync(bin, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, env: childEnv });
	};
	return {
		read(terminal, paneId) {
			const r = run(terminal, ["pane", "read", paneId, "--source", "visible", "--format", "text"]);
			if (r?.error) return { ok: false, code: "spawn-error" };
			if (r?.status !== 0) return { ok: false, code: parseJsonLine(r?.stdout)?.error?.code ?? parseJsonLine(r?.stderr)?.error?.code ?? `exit-${r?.status}` };
			return { ok: true, text: String(r?.stdout ?? "") };
		},
		call(terminal, args) {
			const r = run(terminal, args);
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
