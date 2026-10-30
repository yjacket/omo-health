import { spawn } from "node:child_process";
import path from "node:path";

/**
 * V8 limits for the long-lived daemon. Its live heap is ~25 MB; with default
 * limits V8 let RSS reach ~180 MB, with these it stayed at ~100 MB in the same
 * 60-tick probe (task-20 footprint evidence, kept in the private archive repository).
 * Every launcher (CLI start, sensor restart, logon script) uses these.
 */
export const DAEMON_NODE_ARGS = Object.freeze(["--max-semi-space-size=1", "--max-old-space-size=96"]);

/** Node argv (after the executable) that runs the daemon from `script` (bin/omo-health.mjs). */
export function daemonArgs(script) {
	return [...DAEMON_NODE_ARGS, script, "daemon"];
}

const WMI_TIMEOUT_MS = 30_000;

/** Win32_Process.Create with a hidden window; prints "<ReturnValue> <ProcessId>". Inputs come from env to avoid quoting. */
export const WMI_CREATE_SCRIPT =
	"$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; " +
	"$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:OMOH_LAUNCH_CMD; CurrentDirectory=$env:OMOH_LAUNCH_CWD; ProcessStartupInformation=$si}; " +
	"'{0} {1}' -f $r.ReturnValue, $r.ProcessId";

function quoteArg(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Start the daemon so that it outlives the session or terminal that started it.
 *
 * `detached` alone is not enough on Windows: closing an Orca terminal ends every
 * process that terminal started, detached children included, so a daemon that a
 * session's sensor restarted died with that session. Win32_Process.Create (WMI)
 * creates the process outside the caller's process tree and job. A WMI child gets
 * the user's profile environment, not the caller's, so runs that redirect
 * omo-health through OMO_HEALTH_* variables (tests, sandboxes) keep the plain
 * detached spawn, as do other platforms and any WMI failure.
 * @returns {Promise<{via: "wmi"|"spawn", pid?: number, wmiError?: string}>}
 */
export function launchDaemon({ script, extraArgs = [], execPath = process.execPath, env = process.env, platform = process.platform, spawnImpl = spawn }) {
	const args = [...daemonArgs(script), ...extraArgs];
	const plain = (wmiError) => {
		const child = spawnImpl(execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env });
		child.unref?.();
		return { via: "spawn", pid: child.pid, ...(wmiError ? { wmiError } : {}) };
	};
	if (platform !== "win32" || Object.keys(env).some((key) => key.toUpperCase().startsWith("OMO_HEALTH_"))) return Promise.resolve(plain());
	return new Promise((resolve) => {
		let settled = false;
		let out = "";
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let ps;
		try {
			ps = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WMI_CREATE_SCRIPT], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
				env: { ...env, OMOH_LAUNCH_CMD: [execPath, ...args].map(quoteArg).join(" "), OMOH_LAUNCH_CWD: path.dirname(path.dirname(script)) },
			});
		} catch (error) {
			finish(plain(`spawn: ${error.message}`));
			return;
		}
		timer = setTimeout(() => {
			ps.kill?.();
			finish(plain("wmi: timed out"));
		}, WMI_TIMEOUT_MS);
		timer.unref?.();
		ps.stdout?.on("data", (chunk) => {
			out += chunk;
		});
		ps.on("error", (error) => finish(plain(`spawn: ${error.message}`)));
		ps.on("close", (code) => {
			const [returnValue, pid] = out.trim().split(/\s+/).map(Number);
			if (code === 0 && returnValue === 0 && pid > 0) finish({ via: "wmi", pid });
			else finish(plain(`wmi: exit ${code}, output "${out.trim()}"`));
		});
	});
}
