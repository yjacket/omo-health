import path from "node:path";
import { commandText } from "../collect/sessions.mjs";
import { isOmoLauncher, isSenpiHost } from "../state.mjs";
import { reflectionShape } from "./reflection-orphans.mjs";
import { commandLineText, normalizeCommand } from "../util/text.mjs";

export const SHELL_NAMES = new Set(["bash.exe", "sh.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "bash", "sh"]);
const PROTECTED_NAME_RE = /^(claude(\.exe)?|orca.*|explorer\.exe|conhost\.exe|openconsole\.exe|windowsterminal\.exe|wt\.exe|code\.exe|wscript\.exe|csrss\.exe|winlogon\.exe|services\.exe|svchost\.exe|lsass\.exe|system|smss\.exe|dwm\.exe)$/i;
const FULL_MATCH_CHARS = 1800;
const ORPHAN_WINDOW_MS = 5_000;

/**
 * Processes omo-health must never terminate (plan D-4 / R1-B1).
 * `headlessReflection` (D17's kill only): a process whose own command line is a headless memory-reflection child
 * runs senpi's cli.js but hosts no session, so the senpi-host rule does not cover it; a host of a known session stays protected.
 */
export function isProtectedProcess(proc, world, { headlessReflection = false } = {}) {
	if (!proc) return true;
	if (world.protectedPids?.has(proc.pid)) return true;
	const reflection = headlessReflection && reflectionShape(proc) !== undefined;
	if (!reflection && world.liveHostPids?.has(proc.pid)) return true;
	for (const host of world.hosts?.values?.() ?? []) if (host.pid === proc.pid && (!reflection || host.sessionIds?.size)) return true;
	if ((!reflection && isSenpiHost(proc)) || isOmoLauncher(proc)) return true;
	return PROTECTED_NAME_RE.test(proc.name ?? "");
}

/** Split a shell command into pipeline / list segments (quote-aware, best effort). */
export function splitSegments(command) {
	const text = String(command ?? "");
	const segments = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote && text[i - 1] !== "\\") quote = null;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		// "&" is part of a redirection in "2>&1" and "&>file"; only a bare "&" separates commands.
		const isRedirectAmp = ch === "&" && (text[i - 1] === ">" || text[i + 1] === ">");
		if ((ch === "|" || ch === ";" || ch === "&" || ch === "\n") && !isRedirectAmp) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if ((ch === "|" || ch === "&") && text[i + 1] === ch) i += 1;
			continue;
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments.map(stripRedirections).filter(Boolean);
}

/** Remove trailing redirections: "node s.mjs > log 2>&1" -> "node s.mjs". */
export function stripRedirections(segment) {
	let value = String(segment).trim();
	for (let guard = 0; guard < 8; guard++) {
		const next = value.replace(/\s*(?:[0-9]?>{1,2}|&>{1,2})\s*(?:&[0-9]|"[^"]*"|'[^']*'|\S+)\s*$/, "").trim();
		if (next === value) break;
		value = next;
	}
	return value;
}

const programBase = (value) => String(value).split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
const VARIABLE_WORD = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;

/**
 * Comparable tokens of one pipeline segment: shell words with quotes and escapes
 * removed, split on whitespace (MSYS writes pipeline members' command lines
 * without quoting), program reduced to its base name, lowercased. A word that is
 * only a variable ("$f", ${f}) expands at run time and becomes a wildcard token.
 */
export function segmentArgv(segment) {
	const text = String(segment ?? "");
	const words = [];
	let word;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!quote && /\s/.test(ch)) {
			if (word) words.push(word);
			word = undefined;
			continue;
		}
		word ??= { text: "", raw: "" };
		word.raw += ch;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word.text += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) {
				word.text += text[++i];
				word.raw += text[i];
			} else word.text += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "\\" && i + 1 < text.length) {
			word.text += text[++i];
			word.raw += text[i];
		} else {
			word.text += ch;
		}
	}
	if (word) words.push(word);
	const tokens = [];
	words.forEach((w, index) => {
		if (VARIABLE_WORD.test(w.raw.replace(/^"(.*)"$/, "$1"))) tokens.push({ variable: true });
		else for (const part of (index === 0 ? programBase(w.text) : w.text).split(/\s+/).filter(Boolean)) tokens.push({ text: part.toLowerCase(), variable: false });
	});
	return tokens;
}

/** Comparable tokens of a process command line: program base name, then its arguments without quotes, lowercased. */
export function processArgv(cmdline) {
	const value = normalizeCommand(cmdline);
	let program;
	let rest;
	if (value.startsWith('"')) {
		const end = value.indexOf('"', 1);
		program = end > 0 ? value.slice(1, end) : value.slice(1);
		rest = end > 0 ? value.slice(end + 1) : "";
	} else {
		const space = value.indexOf(" ");
		program = space >= 0 ? value.slice(0, space) : value;
		rest = space >= 0 ? value.slice(space) : "";
	}
	return [programBase(program), ...rest.replace(/"/g, "").toLowerCase().split(" ").filter(Boolean)];
}

/** Same program and arguments; a variable token stands for one or more process tokens. */
export function argvMatches(tokens, argv, i = 0, j = 0) {
	if (i === tokens.length) return j === argv.length && tokens.length > 0;
	if (j >= argv.length) return false;
	if (!tokens[i].variable) return tokens[i].text === argv[j] && argvMatches(tokens, argv, i + 1, j + 1);
	for (let end = j + 1; end <= argv.length - (tokens.length - i - 1); end++) if (argvMatches(tokens, argv, i + 1, end)) return true;
	return false;
}

function bashCommandOf(call) {
	return commandText(call?.name, call?.args);
}

function shellCommandLineHas(proc, needle) {
	return commandLineText(proc.cmd).includes(needle);
}

/**
 * The shell runs exactly this command: its decoded command line ends with it (`bash -c <cmd>`,
 * `cmd /c <cmd>`), so `sleep 5` never matches a shell running `sleep 50`. A command longer than the
 * compared prefix can only be checked by containment.
 */
function shellRunsCommand(proc, needle, truncated) {
	const text = commandLineText(proc.cmd);
	return truncated ? text.includes(needle) : text === needle || text.endsWith(` ${needle}`);
}

/**
 * Match one pending tool call to the OS processes executing it (plan todo 6,
 * hardened by review R1-B1). Only a HIGH-confidence match may be acted on.
 *
 * @returns {{state: "running"|"exited"|"unmatched"|"ambiguous", confidence: "high"|"low"|"none",
 *   reason?: string, parentPid?: number, root?: object, tree: object[], orphans: object[],
 *   orphanRejects: object[], candidates: number}}
 */
export function matchPendingCall({ call, session, world, memory = {} }) {
	const result = { state: "unmatched", confidence: "none", tree: [], orphans: [], orphanRejects: [], candidates: 0 };
	const command = bashCommandOf(call);
	if (!command) return { ...result, reason: "not-a-shell-call" };
	const parentPid = world.shellParentPid(session);
	result.parentPid = parentPid;
	if (!Number.isFinite(parentPid)) return { ...result, reason: "unknown-host" };
	const procs = world.procs;
	const cfg = world.config.stall;
	const normalized = normalizeCommand(command);
	const fullNeedle = normalized.slice(0, FULL_MATCH_CHARS);
	const shortNeedle = normalized.slice(0, 60);
	const inWindow = (proc) => proc.ctimeMs >= call.ms - cfg.matchWindowBeforeMs && proc.ctimeMs <= call.ms + cfg.matchWindowAfterMs;
	const shells = procs.children(parentPid).filter((proc) => SHELL_NAMES.has(proc.name.toLowerCase()) && inWindow(proc));
	const truncated = normalized.length > FULL_MATCH_CHARS;
	const high = shells.filter((proc) => shellRunsCommand(proc, fullNeedle, truncated)).sort((a, b) => a.ctimeMs - b.ctimeMs);
	const low = shells.filter((proc) => !high.includes(proc) && shellCommandLineHas(proc, shortNeedle));
	result.candidates = high.length + low.length;

	// Every pending shell call with the same command that runs on this parent (all in-process children share a host).
	// Only calls whose own shell can fall in this call's window [ms - before, ms + after] are counted.
	const siblings = [];
	for (const other of world.sessions.values()) {
		if (world.shellParentPid(other) !== parentPid) continue;
		for (const pending of other.pending.values()) {
			if (pending.ms < call.ms - cfg.matchWindowBeforeMs || pending.ms > call.ms + cfg.matchWindowAfterMs) continue;
			if (normalizeCommand(bashCommandOf(pending)).slice(0, FULL_MATCH_CHARS) === fullNeedle) siblings.push(pending);
		}
	}
	siblings.sort((a, b) => a.ms - b.ms || a.index - b.index);

	const remembered = memory.matches?.get(call.id);
	if (!high.length) {
		if (remembered && !procs.isAlive(remembered.pid, remembered.ctime)) return { ...result, state: "exited", confidence: "high", reason: "matched-root-exited" };
		if (low.length) return { ...result, state: "running", confidence: "low", reason: "prefix-only-match", root: low[0], tree: [low[0], ...procs.descendants(low[0].pid)] };
		return { ...result, reason: "no-candidate-shell" };
	}
	// Pairing by rank is only safe when shells and pending calls correspond one to one; with fewer shells a
	// call could be paired with another session's shell (possibly a main session's).
	if (high.length !== siblings.length) {
		return { ...result, state: "ambiguous", confidence: "low", reason: `matching-shells(${high.length})-vs-pending-calls(${siblings.length})` };
	}
	const rank = Math.max(0, siblings.findIndex((pending) => pending.id === call.id));
	const root = high[Math.min(rank, high.length - 1)];
	if (remembered && (remembered.pid !== root.pid || remembered.ctime !== root.ctime)) {
		return { ...result, state: "ambiguous", confidence: "low", reason: "match-changed-between-ticks" };
	}
	if (memory.matches) memory.matches.set(call.id, { pid: root.pid, ctime: root.ctime });
	const tree = [root, ...procs.descendants(root.pid)];
	const treePids = new Set(tree.map((proc) => proc.pid));

	// MSYS orphans: pipeline members whose Windows parent already exited (F3 grep).
	const segments = splitSegments(command).map((segment) => ({ text: normalizeCommand(segment).toLowerCase(), words: segmentArgv(segment) }));
	const orphans = [];
	const orphanRejects = [];
	for (const proc of procs.all()) {
		if (treePids.has(proc.pid) || !procs.isOrphan(proc)) continue;
		if (proc.ctimeMs < root.ctimeMs || proc.ctimeMs > root.ctimeMs + ORPHAN_WINDOW_MS) continue;
		const argv = processArgv(proc.cmd);
		const segment = segments.find((s) => argvMatches(s.words, argv));
		if (!segment) continue;
		if (isProtectedProcess(proc, world)) {
			orphanRejects.push({ pid: proc.pid, reason: "protected" });
			continue;
		}
		// Another shell anywhere on the machine, created in the same window, running the same segment -> not provably ours.
		const rival = procs
			.all()
			.find(
				(other) =>
					!treePids.has(other.pid) &&
					SHELL_NAMES.has(other.name.toLowerCase()) &&
					other.ctimeMs >= proc.ctimeMs - 10_000 &&
					other.ctimeMs <= proc.ctimeMs &&
					commandLineText(other.cmd).toLowerCase().includes(segment.text),
			);
		if (rival) {
			orphanRejects.push({ pid: proc.pid, reason: `rival-shell-${rival.pid}` });
			continue;
		}
		orphans.push(proc);
	}
	return { ...result, state: "running", confidence: "high", reason: "full-command-match", root, tree, orphans, orphanRejects };
}

/** Basename helper used by classifiers ("C:\\...\\grep.exe" -> "grep"). */
export function programName(proc) {
	return path.basename(String(proc?.name ?? "")).replace(/\.exe$/i, "").toLowerCase();
}
