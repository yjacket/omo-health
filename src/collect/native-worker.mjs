import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** C# source of the process snapshot worker (same protocol as scripts/ps-worker.ps1). */
export const NATIVE_WORKER_SOURCE = path.resolve(fileURLToPath(new URL("../../scripts/procs-worker.cs", import.meta.url)));

/** csc.exe of .NET Framework 4, which ships with every supported Windows. */
export function findCsc(env = process.env) {
	const windows = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
	for (const framework of ["Framework64", "Framework"]) {
		const candidate = path.win32.join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Path of the compiled worker for the current source, building it on first use.
 * The file name carries the source hash, so a running older copy never blocks a
 * rebuild. Returns undefined when it cannot be built (the caller falls back to
 * the PowerShell worker).
 */
export function ensureNativeWorker({ binDir, source = NATIVE_WORKER_SOURCE, csc = findCsc(), spawnSyncImpl = spawnSync, log } = {}) {
	let text;
	try {
		text = fs.readFileSync(source);
	} catch {
		return undefined;
	}
	const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
	const dir = path.win32.normalize(binDir);
	const exe = path.win32.join(dir, `omoh-procs-${hash}.exe`);
	if (fs.existsSync(exe)) return exe;
	if (!csc) return undefined;
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.win32.join(dir, `omoh-procs-${hash}.${process.pid}.tmp.exe`);
	// csc reads "/x" as an option: every path must be a Windows path.
	const result = spawnSyncImpl(csc, ["/nologo", "/optimize+", "/target:exe", `/out:${tmp}`, "/reference:System.Management.dll", path.win32.normalize(source)], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
	if (result.status !== 0 || !fs.existsSync(tmp)) {
		log?.warn?.("native_worker_build_failed", { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 500) });
		fs.rmSync(tmp, { force: true });
		return undefined;
	}
	try {
		fs.renameSync(tmp, exe);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		if (!fs.existsSync(exe)) {
			log?.warn?.("native_worker_install_failed", { error: error.message });
			return undefined;
		}
	}
	for (const name of fs.readdirSync(dir)) {
		if (/^omoh-procs-[0-9a-f]+\.exe$/.test(name) && name !== path.win32.basename(exe)) {
			try {
				fs.rmSync(path.win32.join(dir, name), { force: true });
			} catch {
				// an older daemon still runs it; the next build cleans up
			}
		}
	}
	return exe;
}
