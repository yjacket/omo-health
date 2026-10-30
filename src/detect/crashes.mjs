import path from "node:path";
import { pathKey } from "../paths.mjs";
import { kst } from "../util/time.mjs";
import { parkedSessionIds } from "../act/park-resume.mjs";
import { makeFinding } from "./finding.mjs";

/**
 * D18 host crashes (issue #46): an omo host that died without a clean shutdown, and whether its run must be resumed.
 *
 * The sensor deletes its heartbeat on session_shutdown, so a heartbeat whose pid is gone means the host died uncleanly.
 * That alone is not enough: a session the operator switched away from (/new, /resume) leaves a heartbeat that stopped
 * long before its host exited. A crash therefore also needs proof that the heartbeat stopped with the host:
 *   - observed: this daemon saw the heartbeat fresh with its host alive within OBSERVE_MS before the death, or
 *   - senpi: senpi's own trace of the same death, its live marker (process-crashes/live/<pid>.json, touched every 60 s
 *     and deleted on a clean exit) or a swept crash record, last touched right before the heartbeat stopped.
 *
 * Engine-provided inputs relied on:
 *   world.hostExits     { heartbeats: [{ hb, file, mtimeMs, dagRuns? }], crashRecords: [{ atMs, kind, detection }], liveMarkers: Map<pid, { mtimeMs }> }
 *   world.config.crashResume  { maxAgeMs, perHour, loopCount, loopWindowMs, startupMs }
 *   session.anchor (goal / ulw status), session.todoState (senpi.todo-state), session.activity.lastTodo, world.tasks
 *
 * Memory (persisted by the engine): alive (last fresh sighting per session), seen (the decision per crash, made once),
 * crashes (crash times per session), and, written by the engine's crash actions, resumes (launch times), pending
 * (launched, waiting for the new sensor) and stopped (recovery given up; drives one human-needed toast).
 */
export const id = "D18";

const FRESH_HB_MS = 45_000;
const SILENT_MS = 30_000;
const OBSERVE_MS = 2 * 60_000;
/** hb.ts - evidence: the sensor beats every 10 s and senpi touches its marker every 60 s. */
const EVIDENCE_MIN_MS = -15_000;
const EVIDENCE_MAX_MS = 75_000;
const HOUR_MS = 3600_000;
const STOP_SHOW_MS = HOUR_MS;
const KEEP_MS = 24 * HOUR_MS;
const DAG_DONE = new Set(["completed", "failed", "cancelled"]);
const STOP_OUTCOMES = new Set(["crash-loop", "rate-limit", "resume-off", "no-terminal"]);

export const REASON_KO = {
	"crash-loop": "30분 안에 반복 크래시",
	"rate-limit": "시간당 재개 한도 초과",
	"resume-off": "자동 재개가 꺼져 있음(actions.resume)",
	"no-terminal": "제어할 수 있는 터미널 없음(herdr 밖에서 실행)",
	"pane-gone": "원래 pane이 닫힘",
	"pane-busy": "원래 pane에서 다른 프로그램이 실행 중",
	"pane-cwd-mismatch": "원래 pane의 작업 폴더가 바뀜",
	"cwd-missing": "작업 폴더가 없음",
	"bad-session-id": "세션 id 형식 오류",
	"herdr-error": "herdr 호출 실패",
	"tab-create-failed": "새 탭을 만들지 못함",
	"new-tab-not-ready": "새 탭의 셸이 준비되지 않음",
	"run-failed": "재개 명령을 실행하지 못함",
	"no-new-sensor": "재개 명령 뒤 세션이 다시 뜨지 않음",
	"no-turn": "다시 열린 세션이 작업을 시작하지 않음",
};

const WORK_KO = { turn: "진행 중인 턴", goal: "활성 목표", ulw: "ulw 루프", todos: "열린 할 일", subagents: "실행 중인 서브에이전트", workflow: "실행 중인 워크플로" };
const OUTCOME_KO = {
	resume: "같은 작업공간의 새 탭에서 재개합니다",
	idle: "진행 중인 턴도 활성 목표도 없어 기록만 합니다",
	"taken-over": "같은 작업 폴더에서 다른 세션이 이미 이어받아 기록만 합니다",
	unconfirmed: "호스트보다 하트비트가 먼저 멈췄습니다(세션 전환 등). 기록만 합니다",
	"not-interactive": "대화형 세션이 아니라 기록만 합니다",
};

function hostAlive(world, pid) {
	return Number.isFinite(pid) && (world.procs.isAlive(pid) || world.liveHostPids.has(pid));
}

function nameOf(cwd) {
	return path.basename(String(cwd ?? "?").replace(/[\\/]+$/, "")) || String(cwd ?? "?");
}

/** senpi's own trace of the death that stopped this heartbeat: "live-marker", "crash-record" or undefined. */
export function senpiEvidence(hostExits, hb) {
	const near = (ms) => Number.isFinite(ms) && hb.ts - ms >= EVIDENCE_MIN_MS && hb.ts - ms <= EVIDENCE_MAX_MS;
	const marker = hostExits?.liveMarkers?.get?.(hb.pid);
	if (marker && near(marker.mtimeMs)) return "live-marker";
	const kind = hb.kind ?? "interactive";
	if ((hostExits?.crashRecords ?? []).some((r) => r.detection === "unclean_exit" && r.kind === kind && near(r.atMs))) return "crash-record";
	return undefined;
}

/** What the session still had to do when its host died; no reasons means it crashed idle. */
export function unfinishedWork(world, hb, session, dagRuns = []) {
	const sid = hb.sessionId;
	const reasons = [];
	if (hb.idle === false || hb.executingTools > 0 || hb.pending === true || session?.pending?.size > 0) reasons.push("turn");
	if (session?.anchor && session.anchor.source !== "task" && session.anchor.status === "active") reasons.push(session.anchor.source === "ulw" ? "ulw" : "goal");
	const todoOpen = session?.todoState ? session.todoState.open : session?.activity?.lastTodo?.open;
	if (todoOpen > 0) reasons.push("todos");
	const lostTasks = (world.tasks ?? []).filter((t) => t.active && (t.parentSessionId === sid || t.rootSessionId === sid)).map((t) => t.taskId);
	if (lostTasks.length) reasons.push("subagents");
	if (dagRuns.some((run) => (run.rootSessionId === sid || run.parentSessionId === sid) && typeof run.status === "string" && !DAG_DONE.has(run.status))) reasons.push("workflow");
	return { reasons, lostTasks };
}

/** Reasons that make a crashed session worth reopening: it was mid-turn or pursuing a goal. Todos, subagents and workflow runs alone are not. */
const ACTIVE_WORK = new Set(["turn", "goal", "ulw"]);

/**
 * Someone already carries on in the crashed session's cwd: another live host's fresh heartbeat there, or another
 * main session there written to after the crash. Returns that session id.
 */
export function takenOverBy(world, hb) {
	if (typeof hb.cwd !== "string" || !hb.cwd) return undefined;
	const cwd = pathKey(hb.cwd);
	const same = (other) => typeof other === "string" && other && pathKey(other) === cwd;
	for (const { hb: other } of world.hostExits?.heartbeats ?? []) {
		if (other.sessionId !== hb.sessionId && same(other.cwd) && world.now - other.ts <= FRESH_HB_MS && hostAlive(world, other.pid)) return other.sessionId;
	}
	for (const session of world.sessions.values()) {
		if (session.kind === "main" && session.id !== hb.sessionId && same(session.cwd) && session.lastEntryMs > hb.ts) return session.id;
	}
	return undefined;
}

/** Made once per crash; the outcome never changes while its heartbeat file waits for removal. */
function decide(world, memory, entry, cfg) {
	const hb = entry.hb;
	const sid = hb.sessionId;
	const now = world.now;
	const alive = memory.alive[sid];
	const observed = alive?.pid === hb.pid && now - alive.atMs <= OBSERVE_MS;
	const senpi = senpiEvidence(world.hostExits, hb);
	const { reasons, lostTasks } = unfinishedWork(world, hb, world.sessions.get(sid), entry.dagRuns);
	const takenOver = takenOverBy(world, hb);
	let outcome;
	if (!observed && !senpi) outcome = "unconfirmed";
	else {
		// A crash of a resumed host supersedes the notice still waiting for it.
		delete memory.pending[sid];
		const crashes = [...(memory.crashes[sid] ?? []), hb.ts];
		memory.crashes[sid] = crashes;
		if ((hb.kind ?? "interactive") !== "interactive" || hb.hasUI === false) outcome = "not-interactive";
		else if (takenOver) outcome = "taken-over";
		else if (!reasons.some((reason) => ACTIVE_WORK.has(reason))) outcome = "idle";
		else if (crashes.filter((ts) => hb.ts - ts <= cfg.loopWindowMs).length >= cfg.loopCount) outcome = "crash-loop";
		else if ((memory.resumes[sid] ?? []).filter((ms) => now - ms < HOUR_MS).length >= cfg.perHour) outcome = "rate-limit";
		else if (world.config.actions?.resume === false) outcome = "resume-off";
		else if (hb.terminal?.kind !== "herdr") outcome = "no-terminal";
		else outcome = "resume";
	}
	if (STOP_OUTCOMES.has(outcome)) memory.stopped[sid] = { atMs: now, reason: outcome, cwd: hb.cwd, pid: hb.pid };
	return { firstMs: now, observed, senpi, outcome, reasons, lostTasks, takenOver };
}

function crashFinding(entry, decision) {
	const hb = entry.hb;
	const { observed, senpi, outcome, reasons, lostTasks, takenOver } = decision;
	const confirmKo = [observed ? "감시기가 직전까지 살아 있는 호스트를 확인" : "", senpi ? `senpi ${senpi === "live-marker" ? "생존 표식" : "크래시 기록"}` : ""].filter(Boolean).join(", ") || "없음";
	const judgementKo = OUTCOME_KO[outcome] ?? `재개하지 않습니다: ${REASON_KO[outcome] ?? outcome}`;
	return makeFinding({
		detector: id,
		kind: "host-crash",
		severity: "info",
		subject: { sessionId: hb.sessionId, hostPid: hb.pid, key: `crash:${hb.pid}@${hb.ts}` },
		evidence: [`pid:${hb.pid}`, `observed:${observed}`, `senpi:${senpi ?? "-"}`, `outcome:${outcome}`, ...reasons.map((r) => `work:${r}`), ...(takenOver ? [`takenOver:${takenOver}`] : [])],
		titleKo: `omo 호스트 비정상 종료: ${nameOf(hb.cwd)}`,
		detailKo: [
			`세션 ${hb.sessionId}(${hb.cwd})의 omo 호스트(pid ${hb.pid})가 정상 종료 없이 사라졌습니다. 마지막 하트비트 ${kst(hb.ts)}.`,
			`확인: ${confirmKo}.`,
			`남은 작업: ${reasons.map((r) => WORK_KO[r] ?? r).join(", ") || "없음"}${lostTasks.length ? ` (사라진 서브에이전트: ${lostTasks.join(", ")})` : ""}.`,
			...(takenOver ? [`이어받은 세션: ${takenOver}.`] : []),
			`판단: ${judgementKo}.`,
		].join("\n"),
		data: {
			pid: hb.pid,
			hbTs: hb.ts,
			cwd: hb.cwd,
			terminal: hb.terminal,
			observed,
			senpi,
			outcome,
			reasons,
			lostTasks,
			takenOver,
			remedy: { kind: outcome === "resume" ? "crash-resume" : "crash-cleanup" },
		},
	});
}

function resumedFindings(world, memory, cfg) {
	const out = [];
	for (const [sid, pending] of Object.entries(memory.pending)) {
		const hb = world.sensorFor(sid);
		const reopened = hb && hb.pid !== pending.crashPid;
		// #109: a reopened session may sit on omo's interrupted-run hold instead of running. A sensor that reports
		// lastAgentStartAt (null until a run starts) is believed only once a run started after the launch; an older
		// sensor without the field counts as running, as before.
		const started = reopened && (!("lastAgentStartAt" in hb) || hb.idle === false || (Number.isFinite(hb.lastAgentStartAt) && hb.lastAgentStartAt >= pending.launchedMs));
		if (started) {
			out.push(
				makeFinding({
					detector: id,
					kind: "host-resumed",
					severity: "info",
					subject: { sessionId: sid, key: `resumed:${pending.crashPid}@${pending.launchedMs}` },
					evidence: [`crashPid:${pending.crashPid}`, `newPid:${hb.pid}`, `tab:${pending.tabId ?? "-"}`],
					titleKo: `omo 세션 재개됨: ${nameOf(pending.cwd)}`,
					detailKo: `크래시한 세션 ${sid}을(를) 새 탭(${pending.tabId ?? "?"})에서 다시 열었고 새 호스트(pid ${hb.pid})의 센서가 올라왔습니다. 이어서 진행하라는 안내를 한 번 보냅니다.`,
					data: { crashPid: pending.crashPid, crashTs: pending.crashTs, newPid: hb.pid, idle: hb.idle, lostTasks: pending.lostTasks ?? [], tabId: pending.tabId, remedy: { kind: "crash-notice" } },
				}),
			);
		} else if (world.now - pending.launchedMs > cfg.startupMs) {
			delete memory.pending[sid];
			// No turn: the stop belongs to the new host, so its own heartbeat does not clear it.
			memory.stopped[sid] = reopened
				? { atMs: world.now, reason: "no-turn", cwd: pending.cwd, pid: hb.pid, tabId: pending.tabId }
				: { atMs: world.now, reason: "no-new-sensor", cwd: pending.cwd, pid: pending.crashPid };
		}
	}
	return out;
}

function stoppedFindings(world, memory) {
	const out = [];
	for (const [sid, stopped] of Object.entries(memory.stopped)) {
		const hb = world.sensorFor(sid);
		const turnSince = hb && (hb.idle === false || (Number.isFinite(hb.lastAgentStartAt) && hb.lastAgentStartAt >= stopped.atMs));
		if (world.now - stopped.atMs > STOP_SHOW_MS || (hb && hb.pid !== stopped.pid) || (stopped.reason === "no-turn" && turnSince)) {
			delete memory.stopped[sid];
			continue;
		}
		const reasonKo = REASON_KO[stopped.reason] ?? stopped.reason;
		// A session left open without a turn must be continued where it is: a second `omo --session` would run it twice.
		const detailKo =
			stopped.reason === "no-turn"
				? `${stopped.cwd} 세션 ${sid}: ${reasonKo}. 새 탭(${stopped.tabId ?? "?"})에서 열린 세션에 입력하거나 /resume 하세요.\n호스트가 비정상 종료되어 omo-health가 세션을 다시 열었지만 새 호스트(pid ${stopped.pid})가 사람 입력을 기다리고 있습니다.`
				: `${stopped.cwd} 세션 ${sid}: ${reasonKo}. 터미널에서 직접 이어 가세요: omo --session ${sid}\n호스트(pid ${stopped.pid})가 비정상 종료되었고 남은 작업이 있지만 omo-health가 자동으로 다시 열지 않았습니다.`;
		out.push(
			makeFinding({
				detector: id,
				kind: "host-crash-stopped",
				severity: "warn",
				humanNeeded: true,
				subject: { sessionId: sid, key: `stopped:${stopped.atMs}` },
				evidence: [`reason:${stopped.reason}`, `pid:${stopped.pid}`],
				titleKo: `omo 세션 자동 재개 중단: ${nameOf(stopped.cwd)} (${reasonKo})`,
				detailKo,
				data: { reason: stopped.reason, cwd: stopped.cwd, toastTag: `crash-stop-${sid}` },
			}),
		);
	}
	return out;
}

function staleFinding(stale, maxAgeMs) {
	const oldest = Math.min(...stale.map((hb) => hb.ts));
	return makeFinding({
		detector: id,
		kind: "stale-heartbeats",
		severity: "info",
		subject: { key: `stale:${stale.length}@${oldest}` },
		evidence: [`count:${stale.length}`],
		titleKo: `남은 센서 하트비트 ${stale.length}개 정리`,
		detailKo: `호스트가 이미 없고 마지막 기록이 ${Math.round(maxAgeMs / 60_000)}분보다 오래된 센서 하트비트 파일 ${stale.length}개를 지웁니다. 재개 대상이 아닙니다.`,
		data: { heartbeats: stale.map((hb) => ({ sessionId: hb.sessionId, pid: hb.pid, ts: hb.ts })), remedy: { kind: "crash-cleanup" } },
	});
}

function prune(memory, now) {
	for (const [sid, alive] of Object.entries(memory.alive)) if (now - alive.atMs > KEEP_MS) delete memory.alive[sid];
	for (const [key, seen] of Object.entries(memory.seen)) if (now - seen.firstMs > KEEP_MS) delete memory.seen[key];
	for (const bucket of [memory.crashes, memory.resumes]) {
		for (const [sid, times] of Object.entries(bucket)) {
			const kept = times.filter((ms) => now - ms <= KEEP_MS);
			if (kept.length) bucket[sid] = kept;
			else delete bucket[sid];
		}
	}
}

export function detect(world, memory = {}) {
	const cfg = world.config.crashResume;
	const exits = world.hostExits;
	if (!cfg || !exits) return [];
	for (const key of ["alive", "seen", "crashes", "resumes", "pending", "stopped"]) memory[key] ??= {};
	const now = world.now;
	const out = [];
	// An empty or stale process table would make every host look dead.
	if (world.procsFresh) {
		const stale = [];
		// A session with an unfinished usage-limit park episode belongs to D20 park-resume, never to crash-resume.
		const parked = parkedSessionIds(world.parkRecords);
		for (const entry of exits.heartbeats ?? []) {
			const hb = entry.hb;
			const sid = hb.sessionId;
			if (hostAlive(world, hb.pid)) {
				if (now - hb.ts <= FRESH_HB_MS) memory.alive[sid] = { pid: hb.pid, atMs: now };
				continue;
			}
			if (now - hb.ts < SILENT_MS) continue;
			const key = `${sid}|${hb.pid}|${hb.ts}`;
			if (!memory.seen[key] && now - hb.ts > cfg.maxAgeMs) {
				stale.push(hb);
				continue;
			}
			if (parked.has(sid)) continue;
			memory.seen[key] ??= decide(world, memory, entry, cfg);
			out.push(crashFinding(entry, memory.seen[key]));
		}
		if (stale.length) out.push(staleFinding(stale, cfg.maxAgeMs));
	}
	out.push(...resumedFindings(world, memory, cfg), ...stoppedFindings(world, memory));
	prune(memory, now);
	return out;
}
