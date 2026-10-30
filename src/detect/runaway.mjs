import { procKey } from "../collect/procs.mjs";
import { formatDuration } from "../util/time.mjs";
import { redact, truncate } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";
import { isProtectedProcess, programName } from "./match.mjs";

export const id = "D2";

/**
 * D2 runaway processes anywhere under a live omo host that are NOT tied to a
 * pending tool call (those are D1's job and are skipped via world.attributed).
 * Report-only: nothing here is provably a hung tool call, so no automatic kill.
 */
export function detect(world, memory) {
	const findings = [];
	const mem = world.config.memory;
	const stall = world.config.stall;
	const attributed = world.attributed ?? new Map();
	const candidates = [];
	for (const hostPid of world.liveHostPids) {
		for (const proc of world.procs.descendants(hostPid)) {
			if (isProtectedProcess(proc, world) || attributed.has(procKey(proc))) continue;
			candidates.push({ proc, hostPid });
		}
	}
	let topOmo;
	for (const { proc, hostPid } of candidates) {
		const growth = world.procs.growthMBPerMin(proc, mem.growthWindowMs);
		const observed = world.procs.observedMs(proc);
		const avgCpu = world.procs.avgCpuFrac(proc, stall.runawayReadonlyMs);
		const reasons = [];
		if (observed >= mem.growthWindowMs && growth >= mem.growthMBPerMin) reasons.push(`growth:${growth.toFixed(0)}MB/min`);
		if (observed > 0 && proc.privBytes >= mem.treeMaxBytes) reasons.push(`private:${Math.round(proc.privBytes / 1048576)}MB`);
		if (observed >= stall.runawayReadonlyMs && avgCpu !== undefined && avgCpu >= stall.cpuBusyFrac) reasons.push(`cpu:${avgCpu.toFixed(2)}`);
		if (!topOmo || proc.privBytes > topOmo.proc.privBytes) topOmo = { proc, hostPid };
		if (!reasons.length) continue;
		findings.push(
			makeFinding({
				detector: id,
				kind: "process-runaway",
				severity: "warn",
				subject: { pids: [{ pid: proc.pid, ctime: proc.ctime }], hostPid, key: `proc:${proc.pid}` },
				evidence: reasons,
				titleKo: `omo 아래 프로세스 폭주: ${programName(proc)} (pid ${proc.pid})`,
				detailKo: `omo 호스트 ${hostPid} 아래의 ${programName(proc)} (pid ${proc.pid})가 비정상적으로 자원을 쓰고 있습니다: ${reasons.join(", ")}. 대기 중인 도구 호출과 연결되지 않아 자동으로 끄지는 않습니다. 필요하면 \`taskkill /F /PID ${proc.pid}\`로 종료하세요.\n명령: ${truncate(proc.cmd, 300)}\n관찰 시간: ${formatDuration(observed)}`,
				data: { pid: proc.pid, ctime: proc.ctime, name: proc.name, privBytes: proc.privBytes, growthMBPerMin: growth, avgCpu, hostPid, cmdHead: truncate(redact(proc.cmd ?? ""), 300), killCommand: `taskkill /F /PID ${proc.pid}` },
			}),
		);
	}
	if (world.os?.commitFrac >= mem.commitFrac) {
		findings.push(
			makeFinding({
				detector: id,
				kind: "machine-commit",
				severity: "info",
				subject: { key: "machine" },
				evidence: [`commit:${(world.os.commitFrac * 100).toFixed(1)}%`, topOmo ? `topOmo:${programName(topOmo.proc)}:${topOmo.proc.pid}:${Math.round(topOmo.proc.privBytes / 1048576)}MB` : "topOmo:none"],
				titleKo: `메모리 커밋 ${(world.os.commitFrac * 100).toFixed(0)}% 사용 중`,
				detailKo: `시스템 커밋 사용량이 ${(world.os.commitUsedBytes / 2 ** 30).toFixed(1)} / ${(world.os.commitLimitBytes / 2 ** 30).toFixed(1)} GB입니다. 커밋이 가득 차면 새 프로세스와 세션이 실패합니다.`,
				data: { commitFrac: world.os.commitFrac, topOmo: topOmo ? { pid: topOmo.proc.pid, name: topOmo.proc.name, privBytes: topOmo.proc.privBytes } : null },
			}),
		);
	}
	return findings;
}
