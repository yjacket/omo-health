import path from "node:path";
import { pathKey } from "../paths.mjs";
import { readJsonSafe } from "../util/fsx.mjs";
import { sha1 } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";

export const id = "D22";

/**
 * Outcomes omo's reflection finalizer accepts in `final.json` (omo-ai 5.1.1, plugin/extensions/omo.js, the final
 * sentinel check); `final.json` is written only after the run settled.
 */
export const TERMINAL_OUTCOMES = new Set(["merged", "no_changes", "parent_dirty", "dirty_uncommitted", "merge_conflict", "admin_tamper", "timed_out", "failed"]);
const RUNTIME_RE = /^(node|bun)(\.exe)?$/i;
const SENPI_CLI_RE = /[\\/]@code-yeongyu[\\/]senpi[\\/]dist[\\/]bundle[\\/]cli\.js$/i;
const RUN_RE = /^reflection-run-\d+$/;
const MAX_RUNS = 50;

/** Windows command line -> argv (CommandLineToArgvW: quotes group words, 2n backslashes before a quote become n). */
export function windowsArgv(cmdline) {
	const text = String(cmdline ?? "");
	const argv = [];
	let word = "";
	let started = false;
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			let count = 0;
			while (text[i] === "\\") {
				count++;
				i++;
			}
			if (text[i] === '"') {
				word += "\\".repeat(Math.floor(count / 2));
				if (count % 2) word += '"';
				else quoted = !quoted;
			} else {
				word += "\\".repeat(count);
				i--;
			}
			started = true;
		} else if (ch === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(ch)) {
			if (started) argv.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (started) argv.push(word);
	return argv;
}

function flagValue(args, flag) {
	const at = args.indexOf(flag);
	if (at < 0) return undefined;
	if (args.indexOf(flag, at + 1) >= 0 || at + 1 >= args.length) return null;
	return args[at + 1];
}

/**
 * The run dir a headless reflection child names, from its own command line only (no parent-pid inference).
 * omo starts `<runtime> <senpi cli> -p --system-prompt <D>\reflection-persona.md ... --session-dir <D> ...`
 * (fork mode: `-p --fork <file> --session-dir <D>`), and senpi's launcher re-runs the same argv under bun.
 */
export function reflectionShape(proc) {
	if (!RUNTIME_RE.test(proc?.name ?? "")) return undefined;
	const cmd = String(proc.cmd ?? "");
	if (!cmd.includes("reflection-run-")) return undefined;
	const argv = windowsArgv(cmd);
	const cli = argv.findIndex((arg) => SENPI_CLI_RE.test(arg));
	if (cli < 0) return undefined;
	const args = argv.slice(cli + 1);
	if (args[0] !== "-p") return undefined;
	const sessionDir = flagValue(args, "--session-dir");
	const prompt = flagValue(args, "--system-prompt");
	if (sessionDir === null || prompt === null) return undefined;
	const dirs = [];
	if (sessionDir !== undefined) dirs.push(sessionDir);
	if (prompt !== undefined) {
		if (path.basename(prompt).toLowerCase() !== "reflection-persona.md") return undefined;
		dirs.push(path.dirname(prompt));
	}
	if (!dirs.length || dirs.some((dir) => pathKey(dir) !== pathKey(dirs[0]))) return undefined;
	const runDir = path.resolve(dirs[0]);
	const parts = runDir.split(/[\\/]+/);
	if (parts.length < 7) return undefined;
	const [agents, agent, runtime, reflection, runs, runId] = parts.slice(-6);
	if ([agents, runtime, reflection, runs].map((part) => part.toLowerCase()).join("/") !== "agents/runtime/reflection/runs" || !RUN_RE.test(runId)) return undefined;
	return { runDir, runId, agent, key: pathKey(runDir) };
}

/** A reflection child whose run dir is `<omoHome>/memory/agents/<agent>/runtime/reflection/runs/reflection-run-<N>`. */
export function reflectionRunOf(proc, omoHome) {
	const shape = omoHome ? reflectionShape(proc) : undefined;
	if (!shape) return undefined;
	const expected = pathKey(path.join(omoHome, "memory", "agents", shape.agent, "runtime", "reflection", "runs", shape.runId));
	return shape.key === expected ? shape : undefined;
}

/**
 * Engine side (detectors never touch files): `final.json` of each run dir a live reflection child names.
 * Read-only, one read per run dir, at most MAX_RUNS dirs.
 */
export function readReflectionRuns(paths, procs) {
	const runs = new Map();
	for (const proc of procs.all()) {
		const run = reflectionRunOf(proc, paths.omoHome);
		if (!run || runs.has(run.key)) continue;
		if (runs.size >= MAX_RUNS) break;
		runs.set(run.key, { ...run, final: readJsonSafe(path.join(run.runDir, "final.json")) });
	}
	return runs;
}

/** finishedAt of a settled run, or undefined while it has no valid terminal `final.json`. */
export function finishedAtMs(run) {
	const final = run?.final;
	if (!final || typeof final !== "object" || final.runId !== run.runId || !TERMINAL_OUTCOMES.has(final.outcome) || typeof final.finishedAt !== "string") return undefined;
	const ms = Date.parse(final.finishedAt);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Children of settled runs, started before the run finished, once the grace after finishedAt has passed; oldest first. */
export function reflectionOrphans({ procs, runs, omoHome, now, graceMs }) {
	const byRun = new Map();
	for (const proc of procs.all()) {
		const shape = reflectionRunOf(proc, omoHome);
		const run = shape && runs.get(shape.key);
		const finished = finishedAtMs(run);
		if (finished === undefined || now - finished <= graceMs) continue;
		if (!(proc.ctimeMs > 0 && proc.ctimeMs < finished)) continue;
		if (!byRun.has(run.key)) byRun.set(run.key, { run, finishedMs: finished, procs: [] });
		byRun.get(run.key).procs.push(proc);
	}
	for (const entry of byRun.values()) entry.procs.sort((a, b) => a.ctimeMs - b.ctimeMs);
	return [...byRun.values()];
}

export function detect(world) {
	const cfg = world.config.reflectionOrphans;
	if (!cfg?.enabled || !world.procsFresh || world.self?.mode === "history") return [];
	return reflectionOrphans({ procs: world.procs, runs: world.reflectionRuns ?? new Map(), omoHome: world.paths?.omoHome, now: world.now, graceMs: cfg.graceMs }).map(({ run, procs }) =>
		makeFinding({ detector: id, kind: "reflection-orphan", severity: "info",
			subject: { key: `reflection:${run.key}` },
			evidence: [`run:${run.agent}/${run.runId}`, `outcome:${run.final.outcome}`, `finishedAt:${run.final.finishedAt}`],
			titleKo: "끝난 메모리 reflection 실행의 남은 프로세스 정리",
			data: { runKey: run.key, runDir: run.runDir, runId: run.runId, agent: run.agent, outcome: run.final.outcome, finishedAt: run.final.finishedAt,
				remedy: { kind: "kill-reflection-orphans", targets: procs.map((proc) => ({ pid: proc.pid, ctime: proc.ctime, cmdSha1: sha1(proc.cmd ?? ""), name: proc.name })) } },
		}));
}
