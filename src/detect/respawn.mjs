import { respawnStorms } from "../collect/procs.mjs";
import { sha1 } from "../util/text.mjs";
import { formatDuration } from "../util/time.mjs";
import { makeFinding } from "./finding.mjs";
import { isProtectedProcess, matchPendingCall, programName } from "./match.mjs";

export const id = "D17";

/**
 * Whether the world's respawn storms may be acted on: respawn is enabled, the process table is fresh (a stale one
 * shows storms that ended) and this is not a history replay. D17 and classify's R5b (`respawn-loop`) share it.
 */
export function respawnStormsUsable(world) {
	return Boolean(world.config.respawn?.enabled) && Boolean(world.procsFresh) && world.self?.mode !== "history";
}

/**
 * D17 respawn storm: a program relaunched over and over (visible in Task Manager as processes
 * blinking on and off). Covered cases: a storm whose launcher is inside a pending tool call is
 * D1's `respawn-loop` class and is released with the call's shell; one a live omo agent spawned
 * but no call is waiting on (detached/background) is killed after a grace and the owning session
 * is told; one owned by anything else is reported in status only.
 */
export function detect(world, memory = {}) {
	const cfg = world.config.respawn;
	if (!respawnStormsUsable(world)) return [];
	const storms = world.respawnStorms();
	const findings = [];
	// One relaunch often shows up as several storms of one program (launcher instance, crashpad, ...).
	const merged = new Map();
	for (const storm of storms) {
		const target = merged.get(storm.name) ?? {
			...storm,
			births: 0,
			present: 0,
			survivors: 0,
			firstMs: storm.firstMs,
			lastMs: storm.lastMs,
			ancestors: new Set(),
			respawner: undefined,
			respawnerBirths: 0,
		};
		target.births += storm.births;
		target.present = Math.max(target.present, storm.present);
		target.survivors += storm.survivors;
		target.firstMs = Math.min(target.firstMs, storm.firstMs);
		target.lastMs = Math.max(target.lastMs, storm.lastMs);
		for (const pid of storm.ancestorPids) target.ancestors.add(pid);
		if (!target.respawner || storm.respawnerBirths > target.respawnerBirths) {
			target.respawner = storm.respawner;
			target.respawnerBirths = storm.respawnerBirths;
		}
		merged.set(storm.name, target);
	}
	for (const storm of merged.values()) {
		storm.ancestorPids = [...storm.ancestors];
		const pids = new Set([storm.respawner?.pid, ...storm.ancestorPids].filter((p) => p !== undefined));
		// A pending tool call that owns the launcher gets D1's stall ladder instead of a second finding.
		if (isCallOwned(world, pids)) continue;
		const session = ownerSession(world, storm);
		// Only a storm an omo agent spawned is ever killed; one with no owner (the user's browser, a service) is status only.
		const killable = Boolean(session) && storm.respawner && !isProtectedProcess(storm.respawner, world) && (world.now - storm.firstMs) >= cfg.killAfterMs;
		findings.push(
			makeFinding({
				detector: id,
				kind: "respawn-storm",
				severity: session ? "warn" : "info",
				subject: {
					sessionId: session?.id,
					taskId: session?.taskId,
					parentSessionId: session?.parentSessionId,
					rootSessionId: session?.rootSessionId,
					key: `respawn:${storm.name}`,
					pids: storm.respawner ? [{ pid: storm.respawner.pid, ctime: storm.respawner.ctime }] : undefined,
				},
				evidence: [
					`name:${storm.name}`,
					`births:${storm.births}in${Math.round(storm.snapshots * world.config.procSnapshotMs / 1000)}s`,
					`survivors:${storm.survivors}`,
					storm.respawner ? `respawner:${storm.respawner.pid}(${programName(storm.respawner)})` : "respawner:not-caught",
					session ? `owner:${session.id}` : "owner:none",
				],
				titleKo: `재시작 폭주: ${storm.name}가 ${formatDuration(world.now - storm.firstMs)}째 계속 죽고 다시 실행됨`,
				detailKo:
					`${storm.name} 프로세스가 지난 ${formatDuration(world.now - storm.firstMs)} 동안 ${storm.births}번 죽고 다시 실행됐습니다(거의 모든 인스턴스가 스냅샷 하나 안에 사라짐). ` +
					`명령: ${storm.cmdHead || "(읽기 불가)"}. ` +
					(storm.respawner ? `다시 띄우는 프로세스: ${storm.respawner.name}(${storm.respawner.pid}). ` : "다시 띄우는 프로세스는 스냅샷에서 잡히지 않았습니다. ") +
					(session ? "omo 에이전트가 띄운 백그라운드 작업의 루프로 보입니다." : "omo 세션과 무관한 프로세스입니다.") +
					(killable ? " 재실행을 멈추기 위해 그 프로세스를 종료합니다." : ""),
				data: {
					storm: { name: storm.name, births: storm.births, snapshots: storm.snapshots, present: storm.present, survivors: storm.survivors, firstMs: storm.firstMs, cmdHead: storm.cmdHead, lineage: lineageOf(world, storm.respawner) },
					respawnerPid: storm.respawner?.pid,
					...(killable
						? { remedy: { kind: "kill-respawner", targets: [{ pid: storm.respawner.pid, ctime: storm.respawner.ctime, name: storm.respawner.name, cmdSha1: sha1(storm.respawner.cmd ?? "") }] } }
						: {}),
				},
			}),
		);
	}
	return findings;
}

/** The respawner's program and its ancestors' up to the omo host (at most 6): the lineage of the storm's signature (#55 C). */
function lineageOf(world, respawner) {
	if (!respawner) return [];
	const chain = [respawner];
	for (const proc of world.procs.ancestors(respawner.pid)) {
		if (chain.length >= 6) break;
		chain.push(proc);
		if (world.liveHostPids.has(proc.pid)) break;
	}
	return chain.map((proc) => String(proc.name ?? "").toLowerCase());
}

/** True when a pending tool call's matched tree owns one of the storm's processes (D1 handles it). */
function isCallOwned(world, pids) {
	for (const session of world.sessions.values()) {
		if (!session.pending?.size || !world.isSessionLive(session)) continue;
		for (const call of session.pending.values()) {
			const match = matchPendingCall({ call, session, world, memory: {} });
			if (match.state !== "running" || match.confidence !== "high") continue;
			if ([...match.tree, ...match.orphans].some((proc) => pids.has(proc.pid))) return true;
		}
	}
	return false;
}

/** The session whose host spawned the storm (main session of that host wins), or undefined. */
function ownerSession(world, storm) {
	const hostPid = storm.respawner ? world.procs.ancestors(storm.respawner.pid).find((proc) => world.liveHostPids.has(proc.pid))?.pid : [...storm.ancestorPids].find((pid) => world.liveHostPids.has(pid));
	if (hostPid === undefined) return undefined;
	let owner;
	for (const session of world.sessions.values()) {
		if (session.hostPid !== hostPid && session.task?.hostPid !== hostPid) continue;
		if (!world.isSessionLive(session)) continue;
		if (session.kind !== "child") return session;
		owner ??= session;
	}
	return owner;
}
