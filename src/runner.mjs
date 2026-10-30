import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, ensureDir, readJsonSafe, readTextSafe } from "./util/fsx.mjs";
import { redact, sha1, truncate } from "./util/text.mjs";

/**
 * Headless job runner: one detached process per job, with its stdout, stderr and metadata kept under
 * `jobs/<jobId>/` so a job survives a daemon restart and is polled from files alone. The runner knows nothing of
 * what the process says: the caller hands in `parse(stdout)` (the answer) and `unavailableReason(stderr + stdout)`
 * (why the provider cannot answer, or null), and `contracts[kind]` supplies the same two functions for a job a
 * previous daemon started.
 */

/** Identity lookups in a row that may fail after a job's timeout before it is ended as unverified. */
const IDENTITY_FAILURE_LIMIT = 5;

const STRIP_ENV = /^(CLAUDE_CODE_|ANTHROPIC_|PI_|SENPI_|OMO_)/;
const STRIP_EXACT = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);

/** The job's env: no agent, provider or GitHub token variables. */
export function childEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) if (!STRIP_ENV.test(key) && !STRIP_EXACT.has(key)) out[key] = value;
	return out;
}

function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * Creation time (epoch ms) and command-line hash of `pid` from CIM, or null when no such process exists.
 * pid + creation time is what tells the job's own process from a later owner of a reused pid. A failed lookup
 * (PowerShell error or timeout) throws: not knowing must never read as "gone" or as "someone else".
 */
export function processIdentity(pid, exec = execFileSync) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); $p.CommandLine }`;
	let out;
	try {
		out = String(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
	} catch (error) {
		throw new Error(`process identity lookup for pid ${pid} failed: ${error.message}`);
	}
	const [first = "", ...rest] = out.split(/\r?\n/);
	const ctimeMs = Number(first.trim());
	return first.trim() && Number.isFinite(ctimeMs) ? { ctimeMs, cmdSha1: sha1(rest.join("\n").trim()) } : null;
}

function quote(arg) {
	return `"${String(arg).replace(/"/g, '\\"')}"`;
}

/**
 * @returns {{start(opts): object, poll(jobId): object, jobDir(jobId): string}}
 */
export function createRunner({ paths, spawnImpl = spawn, clock, env = process.env, isAlive = defaultIsAlive, identify = processIdentity, contracts = {} }) {
	const jobsDir = paths.health.jobsDir;
	const jobDir = (jobId) => path.join(jobsDir, jobId);
	const handlers = new Map();
	const files = (jobId) => {
		const dir = jobDir(jobId);
		return {
			dir,
			out: path.join(dir, "out.txt"),
			err: path.join(dir, "err.log"),
			meta: path.join(dir, "meta.json"),
			exit: path.join(dir, "exit.json"),
		};
	};

	function finish(f, meta, outcome) {
		atomicWriteJson(f.meta, { ...meta, final: outcome });
		return outcome;
	}

	/** The outcome of a job whose process ended: its answer, an unavailable provider, or a failure. */
	function ended(f, meta, exit) {
		const handler = handlers.get(path.basename(f.dir)) ?? contracts[meta.kind] ?? {};
		const stdout = readTextSafe(f.out, "");
		const stderr = readTextSafe(f.err, "");
		const exitCode = exit?.code ?? null;
		const text = `${stderr}\n${stdout}`;
		if (exitCode === 0 || (!exit && handler.parse?.(stdout) != null)) return finish(f, meta, { status: "done", result: handler.parse ? handler.parse(stdout) : stdout, exitCode });
		const detail = truncate(redact(text.trim()), 300);
		const reason = handler.unavailableReason?.(text) ?? null;
		if (reason) return finish(f, meta, { status: "unavailable", reason, detail, result: null, exitCode });
		// The process never started (the spawn's error event): nothing reached the model.
		if (exit?.error && exitCode === null) return finish(f, meta, { status: "failed", reason: `spawn-error:${exit.error}`, detail, result: null, exitCode });
		return finish(f, meta, { status: "failed", reason: exit ? `exit-${exitCode}` : "no-result", detail, result: null, exitCode });
	}

	return {
		jobDir,
		start({ jobId, kind, command, args, cwd, timeoutMs, parse, unavailableReason }) {
			const f = files(jobId);
			ensureDir(f.dir);
			handlers.set(jobId, { parse, unavailableReason });
			// Only a .cmd/.bat shim needs cmd.exe; `omo` or a path to an .exe is spawned directly (CreateProcess finds omo.exe on PATH).
			const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
			const fds = [fs.openSync(f.out, "w"), fs.openSync(f.err, "w")];
			const options = { cwd: cwd ?? f.dir, env: childEnv(env), windowsHide: true, stdio: ["ignore", ...fds] };
			let child;
			try {
				// A shell job stays attached: DETACHED_PROCESS makes cmd.exe lose its redirected stdout and stderr. Windows does not end a
				// child with its parent, so it still survives a daemon restart.
				child = useShell ? spawnImpl([command, ...args].map(quote).join(" "), [], { ...options, detached: false, shell: true }) : spawnImpl(command, args, { ...options, detached: true, shell: false });
			} finally {
				for (const fd of fds) fs.closeSync(fd);
			}
			child.on?.("error", (error) => atomicWriteJson(f.exit, { code: null, error: error.message }));
			child.on?.("exit", (code, signal) => atomicWriteJson(f.exit, { code, signal }));
			child.unref?.();
			let identity = null;
			let identityError;
			try {
				identity = identify(child.pid);
			} catch (error) {
				// Unverifiable from the start: poll treats the job like one started by an older version (never killed).
				identityError = error.message;
			}
			const meta = { pid: child.pid, ctimeMs: identity?.ctimeMs ?? null, cmdSha1: identity?.cmdSha1 ?? null, ...(identityError ? { identityError } : {}), startedMs: clock.now(), timeoutMs, kind, command, args };
			atomicWriteJson(f.meta, meta);
			return { jobId, pid: child.pid, dir: f.dir };
		},

		poll(jobId) {
			const f = files(jobId);
			const meta = readJsonSafe(f.meta);
			if (!meta) return { status: "failed", reason: "no-job", result: null, exitCode: null };
			if (meta.final) return meta.final;
			const exit = readJsonSafe(f.exit);
			// After a reboot or a long gap the pid can name any process: only the one started for this job is killed
			// (src/act/kill.mjs re-verifies the same way). A process gone meanwhile is ended below.
			if (!exit && meta.pid && isAlive(meta.pid)) {
				const timedOut = clock.now() - meta.startedMs > meta.timeoutMs;
				if (!Number.isFinite(meta.ctimeMs)) {
					// Started by an older version (or its lookup failed at start): it cannot be verified, so it counts as
					// running until its timeout and then ends without a kill.
					if (!timedOut) return { status: "running", result: null, exitCode: null };
					return finish(f, meta, { status: "timeout", reason: "unverified", result: null, exitCode: null });
				}
				let seen;
				try {
					seen = identify(meta.pid);
				} catch (error) {
					// Not knowing is neither "gone" nor "someone else": keep the job, never kill on a guess, retry next poll.
					if (!timedOut) return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300) };
					// Past the timeout a lookup that keeps failing must not hold the one-job slot and the daemon's idle exit forever:
					// end it like an unverifiable job, without a kill. The count lives in meta (survives a restart); any successful
					// lookup past the timeout ends the job below, so the failures counted here are always consecutive.
					const failures = (meta.identityFailures ?? 0) + 1;
					if (failures >= IDENTITY_FAILURE_LIMIT) return finish(f, meta, { status: "timeout", reason: "unverified", result: null, exitCode: null });
					atomicWriteJson(f.meta, { ...meta, identityFailures: failures });
					return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300) };
				}
				if (seen) {
					if (seen.ctimeMs !== meta.ctimeMs || seen.cmdSha1 !== meta.cmdSha1) return finish(f, meta, { status: "failed", reason: "pid-reused", result: null, exitCode: null });
					if (!timedOut) return { status: "running", result: null, exitCode: null };
					// The one documented exception to the no-/T rule (AGENTS.md): the verified job's OWN tree (omo.exe ->
					// omo.exe -p -> git.exe) would be orphaned by a single-PID kill.
					spawnImpl("taskkill", ["/F", "/T", "/PID", String(meta.pid)], { windowsHide: true, stdio: "ignore" }).on?.("error", (error) => {
						// A tree that could not be killed outlives its job: leave the reason beside the job's stderr.
						fs.appendFile(f.err, `\ntaskkill /T failed: ${error.message}\n`, () => {});
					});
					return finish(f, meta, { status: "timeout", result: null, exitCode: null });
				}
			}
			return ended(f, meta, exit);
		},
	};
}
