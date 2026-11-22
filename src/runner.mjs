import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertGuardFlags } from "./judge/lane.mjs";
import { atomicWriteJson, ensureDir, readJsonSafe, readTextSafe } from "./util/fsx.mjs";
import { redact, sha1, truncate } from "./util/text.mjs";

/**
 * Headless job runner: one detached process per job, with its stdout, stderr and metadata kept under
 * `jobs/<jobId>/` so a job survives a daemon restart and is polled from files alone. The runner knows nothing of
 * what the process says: the caller hands in `parse(stdout)` (the answer) and `unavailableReason(stderr + stdout)`
 * (why the provider cannot answer, or null), and `contracts[kind]` supplies the same two functions for a job a
 * previous daemon started.
 *
 * A job's argv carries `jobs/<jobId>/bundle.md`, so a job whose `meta.json` is missing (or was written before its
 * identity could be read) is adopted by finding the one process that runs that job's own argv.
 */

/** Identity lookups in a row that may fail after a job's timeout before it is ended as unverified. */
const IDENTITY_FAILURE_LIMIT = 5;
/** How far before `startedMs` an adopted process's creation time may be (the shim starts a moment after the spawn). */
const ADOPT_SKEW_MS = 5_000;
/** Job kinds whose argv must pass the analyst guard flags (no session file, no extensions/skills/context, no tools). */
const GUARDED_KINDS = new Set(["analyst", "audit"]);
// Print mode writes this prefix only for an applied switch, not exhaustion or reversion.
const APPLIED_FALLBACK = /^Model fallback:/m;

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

/** The lane session id a job's argv names after `--session-id`. */
function sessionIdOf(args) {
	const at = Array.isArray(args) ? args.indexOf("--session-id") : -1;
	return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : null;
}

/**
 * One CIM query for the processes whose command line contains the job's bundle path; the rows that carry this job's
 * full argv are the job's. A `.cmd` shim's `cmd.exe` and its `node` child both match, so a parent-child chain is one
 * job tree and its root is returned. Two independent roots are `ambiguous` (throws with `code:"ambiguous"`); a
 * process that merely mentions the bundle path (an editor) does not match; a failed query throws.
 */
export function findJobProcess({ jobsDir, jobId, args, exec = execFileSync }) {
	const bundleFile = path.join(jobsDir, jobId, "bundle.md");
	const laneSessionId = sessionIdOf(args);
	if (!laneSessionId) return null;
	const literal = bundleFile.replace(/'/g, "''");
	const script = [
		`$bs = '${literal}'`,
		"$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($bs) }",
		'foreach ($x in $p) { "$($x.ProcessId)`t$($x.ParentProcessId)`t$(([DateTimeOffset]$x.CreationDate).ToUnixTimeMilliseconds())`t$($x.CommandLine)" }',
	].join("; ");
	let out;
	try {
		out = String(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
	} catch (error) {
		throw new Error(`job process lookup for ${jobId} failed: ${error.message}`);
	}
	const needleBundle = bundleFile.toLowerCase();
	const matches = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [pidText, parentText, ctimeText, ...rest] = line.split("\t");
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		const ctimeMs = Number(ctimeText);
		const commandLine = rest.join("\t").trim();
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(ctimeMs) || !commandLine) continue;
		const lower = commandLine.toLowerCase();
		if (!lower.includes(needleBundle) || !lower.includes(`@${needleBundle}`)) continue;
		if (!commandLine.includes("-p") || !commandLine.includes("--no-tools") || !commandLine.includes("--session-id")) continue;
		if (!commandLine.includes(laneSessionId)) continue;
		matches.push({ pid, parentPid: Number.isSafeInteger(parentPid) ? parentPid : null, ctimeMs, cmdSha1: sha1(commandLine) });
	}
	if (!matches.length) return null;
	const pids = new Set(matches.map((match) => match.pid));
	const roots = matches.filter((match) => match.parentPid === null || !pids.has(match.parentPid));
	if (roots.length !== 1) {
		const error = new Error(`job process lookup for ${jobId} is ambiguous: ${roots.length} roots`);
		error.code = "ambiguous";
		throw error;
	}
	const root = roots[0];
	return { pid: root.pid, ctimeMs: root.ctimeMs, cmdSha1: root.cmdSha1 };
}

/** An error thrown by `start` says whether a process may exist: after a successful spawn, its pid is kept. */
function spawnError(error, pid) {
	error.spawned = pid !== undefined && pid !== null;
	if (error.spawned) error.pid = pid;
	return error;
}

/**
 * @returns {{start(opts): object, poll(jobId): object, jobDir(jobId): string, adoptJob(jobId, opts): string, alive(jobId): boolean, terminate(jobId): string}}
 */
export function createRunner({ paths, spawnImpl = spawn, clock, env = process.env, isAlive = defaultIsAlive, identify = processIdentity, contracts = {}, writeJson = atomicWriteJson, findJobProcess: findProcess = (jobId, args) => findJobProcess({ jobsDir: paths.health.jobsDir, jobId, args }) }) {
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
		writeJson(f.meta, { ...meta, final: outcome });
		return outcome;
	}

	function fallbackFailure(f, meta, exitCode, holdUntilExit = false, stderr) {
		if (meta.kind !== "audit" || !APPLIED_FALLBACK.test(stderr ?? readTextSafe(f.err, ""))) return null;
		return finish(f, meta, {
			status: "failed", reason: "model-fallback", result: null, exitCode,
			...(holdUntilExit ? { holdUntilExit: true } : {}),
		});
	}

	/** The outcome of a job whose process ended: its answer, an unavailable provider, or a failure. */
	function ended(f, meta, exit) {
		const handler = handlers.get(path.basename(f.dir)) ?? contracts[meta.kind] ?? {};
		const stdout = readTextSafe(f.out, "");
		const stderr = readTextSafe(f.err, "");
		const exitCode = exit?.code ?? null;
		const fallback = fallbackFailure(f, meta, exitCode, false, stderr);
		if (fallback) return fallback;
		const text = `${stderr}\n${stdout}`;
		if (exitCode === 0 || (!exit && handler.parse?.(stdout) != null)) return finish(f, meta, { status: "done", result: handler.parse ? handler.parse(stdout) : stdout, exitCode });
		const detail = truncate(redact(text.trim()), 300);
		// A child error alone is not proof: Node can also emit it after assigning a pid.
		const errored = Boolean(exit?.error) && exitCode === null;
		const notSpawned = errored && (meta.pid === undefined || meta.pid === null);
		const reason = notSpawned ? null : handler.unavailableReason?.(text) ?? null;
		if (reason) return finish(f, meta, { status: "unavailable", reason, detail, result: null, exitCode });
		if (errored) return finish(f, meta, { status: "failed", reason: `spawn-error:${exit.error}`, ...(notSpawned ? { spawned: false } : {}), detail, result: null, exitCode });
		return finish(f, meta, { status: "failed", reason: exit ? `exit-${exitCode}` : "no-result", detail, result: null, exitCode });
	}

	/** The verified timeout path: kill the job's own tree (the one documented /T exception) and end as timeout. */
	function timeoutKill(f, meta) {
		spawnImpl("taskkill", ["/F", "/T", "/PID", String(meta.pid)], { windowsHide: true, stdio: "ignore" }).on?.("error", (error) => {
			// A tree that could not be killed outlives its job: leave the reason beside the job's stderr.
			fs.appendFile(f.err, `\ntaskkill /T failed: ${error.message}\n`, () => {});
		});
		return fallbackFailure(f, meta, null, true) ?? finish(f, meta, { status: "timeout", result: null, exitCode: null });
	}

	/**
	 * Can this job's verified pid still be trusted? Throws when the lookup fails (not knowing is never "gone").
	 * `meta.final` is not consulted: a timed-out job is finalized the moment taskkill is sent, so its process may still
	 * live after the record says `timeout`; only a fresh pid+creation time+command hash can say it is gone.
	 */
	function stillOurs(meta) {
		if (!meta || !meta.pid || !Number.isFinite(meta.ctimeMs)) return false;
		const seen = identify(meta.pid);
		return Boolean(seen && seen.ctimeMs === meta.ctimeMs && seen.cmdSha1 === meta.cmdSha1);
	}

	return {
		jobDir,
		start({ jobId, kind, command, args, cwd, timeoutMs, parse, unavailableReason }) {
			if (GUARDED_KINDS.has(kind)) {
				try {
					assertGuardFlags(args);
				} catch (error) {
					throw spawnError(error, undefined);
				}
			}
			const f = files(jobId);
			try {
				ensureDir(f.dir);
			} catch (error) {
				throw spawnError(error, undefined);
			}
			handlers.set(jobId, { parse, unavailableReason });
			// Only a .cmd/.bat shim needs cmd.exe; `omo` or a path to an .exe is spawned directly (CreateProcess finds omo.exe on PATH).
			const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
			const fds = [];
			let child;
			try {
				try {
					fds.push(fs.openSync(f.out, "w"));
					fds.push(fs.openSync(f.err, "w"));
				} catch (error) {
					throw spawnError(error, undefined);
				}
				const jobEnv = childEnv(env);
				if (kind === "audit") jobEnv.SENPI_NO_FALLBACK = "1";
				const options = { cwd: cwd ?? f.dir, env: jobEnv, windowsHide: true, stdio: ["ignore", ...fds] };
				try {
					// A shell job stays attached: DETACHED_PROCESS makes cmd.exe lose its redirected stdout and stderr. An attached child is in
					// libuv's kill-on-close job object, so a .cmd job ends with the daemon (seen in QA, 2026-11-22); only an .exe command such as
					// omo.exe runs detached and survives a daemon restart.
					child = useShell ? spawnImpl([command, ...args].map(quote).join(" "), [], { ...options, detached: false, shell: true }) : spawnImpl(command, args, { ...options, detached: true, shell: false });
				} catch (error) {
					throw spawnError(error, undefined);
				}
			} finally {
				for (const fd of fds) fs.closeSync(fd);
			}
			// The job exists from here on. Write its pid first so a crash before the identity lookup can still be adopted.
			let meta = { pid: child.pid, ctimeMs: null, cmdSha1: null, startedMs: clock.now(), timeoutMs, kind, command, args };
			try {
				writeJson(f.meta, meta);
			} catch (error) {
				throw spawnError(error, child.pid);
			}
			child.on?.("error", (error) => atomicWriteJson(f.exit, { code: null, error: error.message }));
			child.on?.("exit", (code, signal) => atomicWriteJson(f.exit, { code, signal }));
			child.unref?.();
			let identity = null;
			let identityError;
			try {
				identity = identify(child.pid);
			} catch (error) {
				// Unverifiable from the start: poll adopts it through the bundle path.
				identityError = error.message;
			}
			meta = { ...meta, ctimeMs: identity?.ctimeMs ?? null, cmdSha1: identity?.cmdSha1 ?? null, ...(identityError ? { identityError } : {}) };
			try {
				writeJson(f.meta, meta);
			} catch (error) {
				throw spawnError(error, child.pid);
			}
			return { jobId, pid: child.pid, dir: f.dir };
		},

		poll(jobId) {
			const f = files(jobId);
			let meta = readJsonSafe(f.meta);
			if (!meta) return { status: "failed", reason: "no-job", result: null, exitCode: null };
			if (meta.final) {
				// A runner from before the fallback guard may have finalized before the auditor saved the outcome.
				return meta.final.reason === "model-fallback" ? meta.final :
					fallbackFailure(f, meta, meta.final.exitCode, meta.final.status === "timeout") ?? meta.final;
			}
			const exit = readJsonSafe(f.exit);
			if (exit) return ended(f, meta, exit);
			// After a reboot or a long gap the pid can name any process: only the one started for this job is killed
			// (src/act/kill.mjs re-verifies the same way). A process gone meanwhile is ended below.
			if (!meta.pid || !isAlive(meta.pid)) return ended(f, meta, exit);
			const timedOut = clock.now() - meta.startedMs > meta.timeoutMs;
			if (!Number.isFinite(meta.ctimeMs)) {
				// Started before the identity could be read (or by an older version): find the job by its own argv.
				let found;
				try {
					found = findProcess(jobId, meta.args ?? []);
				} catch (error) {
					// Audits keep retrying; other jobs release their slot at the deadline without killing an unverified pid.
					if (timedOut && meta.kind !== "audit") return finish(f, meta, { status: "timeout", reason: "unverified", result: null, exitCode: null });
					return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300) };
				}
				if (!found || !Number.isFinite(found.ctimeMs) || found.ctimeMs < meta.startedMs - ADOPT_SKEW_MS) return ended(f, meta, exit);
				meta = { ...meta, ctimeMs: found.ctimeMs, cmdSha1: found.cmdSha1 };
				try {
					writeJson(f.meta, meta);
				} catch (error) {
					return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300) };
				}
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
				// An audit job is held by its own timeout and a retryable terminate(): it never finalizes on a failed lookup.
				if (meta.kind === "audit") {
					atomicWriteJson(f.meta, { ...meta, identityFailures: failures });
					return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300), identityFailures: failures };
				}
				if (failures >= IDENTITY_FAILURE_LIMIT) return finish(f, meta, { status: "timeout", reason: "unverified", result: null, exitCode: null });
				atomicWriteJson(f.meta, { ...meta, identityFailures: failures });
				return { status: "running", result: null, exitCode: null, detail: truncate(error.message, 300) };
			}
			if (seen) {
				if (seen.ctimeMs !== meta.ctimeMs || seen.cmdSha1 !== meta.cmdSha1) return fallbackFailure(f, meta, null) ?? finish(f, meta, { status: "failed", reason: "pid-reused", result: null, exitCode: null });
				if (!timedOut) return { status: "running", result: null, exitCode: null };
				// The one documented exception to the no-/T rule (AGENTS.md): the verified job's OWN tree (omo.exe ->
				// omo.exe -p -> git.exe) would be orphaned by a single-PID kill.
				return timeoutKill(f, meta);
			}
			return ended(f, meta, exit);
		},

		/** Recover a job whose meta.json is missing: `running` (meta written), `absent`, or a lookup error. */
		adoptJob(jobId, { command, args, startedMs, timeoutMs, kind }) {
			const found = findProcess(jobId, args ?? []);
			if (!found) return "absent";
			const f = files(jobId);
			try {
				ensureDir(f.dir);
			} catch (error) {
				throw spawnError(error, undefined);
			}
			try {
				writeJson(f.meta, { pid: found.pid, ctimeMs: found.ctimeMs, cmdSha1: found.cmdSha1, startedMs: startedMs ?? clock.now(), timeoutMs, kind, command, args: args ?? [] });
			} catch (error) {
				throw spawnError(error, found.pid);
			}
			return "running";
		},

		/** True while the verified pid of the job is still the same process; a failed lookup throws. */
		alive(jobId) {
			return stillOurs(readJsonSafe(files(jobId).meta));
		},

		/** Re-verify and send `taskkill /F /T` to the job's own tree: `sent`, `gone`, or a lookup error. */
		terminate(jobId) {
			const meta = readJsonSafe(files(jobId).meta);
			if (!stillOurs(meta)) return "gone";
			spawnImpl("taskkill", ["/F", "/T", "/PID", String(meta.pid)], { windowsHide: true, stdio: "ignore" }).on?.("error", (error) => {
				fs.appendFile(files(jobId).err, `\ntaskkill /T failed: ${error.message}\n`, () => {});
			});
			return "sent";
		},
	};
}
