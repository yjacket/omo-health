import { spawnSync } from "node:child_process";
import { isProtectedProcess } from "../detect/match.mjs";
import { sha1 } from "../util/text.mjs";

/** Default: single-PID taskkill (never /T, never /IM; review R1-N3). */
export function taskkillRunner(pid) {
	const result = spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
	return { status: result.status, error: result.error?.message };
}

/**
 * Terminate exactly the listed processes (plan todo 9, D-4/D-5).
 *
 * Right before acting a fresh snapshot is taken and every target is
 * re-verified by pid + creation time + command-line hash; anything that
 * changed, vanished or is protected is a no-op. detach-server additionally
 * refuses to touch the server pids it is meant to keep alive.
 *
 * @param {object} options
 * @param {{kind: string, targets: object[], serverPids?: object[]}} options.request
 * @param {() => Promise<import("../collect/procs.mjs").ProcessTable>} options.snapshot  fresh snapshot provider
 * @param {object} options.guard   world-like {protectedPids, liveHostPids, hosts}
 * @param {(pid:number)=>{status:number|null,error?:string}} [options.runner]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 */
export async function executeKill({ request, snapshot, guard, runner = taskkillRunner, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), settleMs = 1500, attempts = 3 }) {
	const outcome = { kind: request.kind, killed: [], survived: [], noop: [], errors: [] };
	const keep = new Set((request.serverPids ?? []).map((proc) => proc.pid));
	const before = await snapshot();
	const verified = [];
	const seen = new Set();
	for (const target of request.targets ?? []) {
		if (seen.has(target.pid)) continue;
		seen.add(target.pid);
		const proc = before.get(target.pid);
		if (!proc) {
			outcome.noop.push({ pid: target.pid, reason: "gone" });
			continue;
		}
		if (target.ctime !== undefined && proc.ctime !== target.ctime) {
			outcome.noop.push({ pid: target.pid, reason: "pid-reused" });
			continue;
		}
		if (target.cmdSha1 && sha1(proc.cmd ?? "") !== target.cmdSha1) {
			outcome.noop.push({ pid: target.pid, reason: "command-changed" });
			continue;
		}
		if (keep.has(proc.pid)) {
			outcome.noop.push({ pid: target.pid, reason: "server-kept" });
			continue;
		}
		if (isProtectedProcess(proc, guard, { headlessReflection: request.kind === "kill-reflection-orphans" })) {
			outcome.noop.push({ pid: target.pid, reason: "protected" });
			continue;
		}
		verified.push(proc);
	}
	for (const proc of verified) {
		const result = runner(proc.pid);
		if (result.status !== 0 && result.status !== 128) outcome.errors.push({ pid: proc.pid, status: result.status, error: result.error });
	}
	if (!verified.length) return outcome;
	let after = before;
	for (let i = 0; i < attempts; i++) {
		await sleep(settleMs);
		try {
			after = await snapshot();
		} catch (error) {
			// The kills already ran; report them from the taskkill status instead of failing the whole action.
			outcome.unverified = error.message;
			break;
		}
		if (verified.every((proc) => !after.isAlive(proc.pid, proc.ctime))) break;
	}
	const failed = new Set(outcome.errors.map((e) => e.pid));
	for (const proc of verified) {
		const alive = outcome.unverified ? failed.has(proc.pid) : after.isAlive(proc.pid, proc.ctime);
		if (alive) outcome.survived.push({ pid: proc.pid, name: proc.name });
		else outcome.killed.push({ pid: proc.pid, ctime: proc.ctime, name: proc.name });
	}
	return outcome;
}
