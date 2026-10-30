/**
 * The 2026-10-07 incident: a main session's bash tool call resolved `bash` to the WSL launcher
 * C:\Windows\System32\bash.exe, which started wsl.exe, which ran a Windows Script Host file: wscript.exe opened a
 * visible dialog and the call never returned. Process rows in the shape `normalizeRows` takes
 * (`wv`/`wt` = window visible / title, from scripts/procs-worker.cs).
 */

export const INCIDENT_COMMAND = "report.vbs";
export const INCIDENT_PIDS = Object.freeze({ shell: 60168, wsl: 60170, wscript: 60172 });

const iso = (ms) => new Date(ms).toISOString();

/** The senpi host (bun) and the call's tree: bash.exe(system32) -> wsl.exe -> wscript.exe with a visible window. */
export function incidentRows({ host, callMs }) {
	return [
		{ p: host, pp: 1, n: "bun.exe", c: "2026-10-07T01:00:00Z", cpu: 0, pv: 1e8, cl: "C:\\Users\\u\\.bun\\bin\\bun.exe C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" },
		{ p: INCIDENT_PIDS.shell, pp: host, n: "bash.exe", c: iso(callMs + 5), cpu: 0, pv: 1e6, cl: `C:\\Windows\\System32\\bash.exe -c "${INCIDENT_COMMAND}"` },
		{ p: INCIDENT_PIDS.wsl, pp: INCIDENT_PIDS.shell, n: "wsl.exe", c: iso(callMs + 50), cpu: 0, pv: 1e6, cl: `C:\\Windows\\System32\\wsl.exe -e ${INCIDENT_COMMAND}` },
		{ p: INCIDENT_PIDS.wscript, pp: INCIDENT_PIDS.wsl, n: "wscript.exe", c: iso(callMs + 400), cpu: 0, pv: 2e6, cl: `C:\\Windows\\System32\\wscript.exe C:\\Users\\u\\${INCIDENT_COMMAND}`, wv: true, wt: "Windows Script Host" },
	];
}

/** What an ordinary idle call looks like on the same host: Git's bash -> sleep, no window. */
export function ordinaryRows({ host, callMs, command = "sleep 3000" }) {
	return [
		{ p: host, pp: 1, n: "bun.exe", c: "2026-10-07T01:00:00Z", cpu: 0, pv: 1e8, cl: "C:\\Users\\u\\.bun\\bin\\bun.exe C:\\x\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js" },
		{ p: INCIDENT_PIDS.shell, pp: host, n: "bash.exe", c: iso(callMs + 5), cpu: 0, pv: 1e6, cl: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${command}"` },
		{ p: 60170, pp: INCIDENT_PIDS.shell, n: "sleep.exe", c: iso(callMs + 50), cpu: 0, pv: 1e6, cl: command },
	];
}
