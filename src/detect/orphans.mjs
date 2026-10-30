import { redact, truncate } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";
import { classifyProviderError, laneRecoveredAfter, providerOfError, retryWaitOf } from "./provider.mjs";

/**
 * D8 orphans: dead children, unhandled child errors, stopped-on-error sessions
 * and hung main turns (plan todo 14, IS-9 / IS-10(b) / IS-12).
 *
 * Engine-provided inputs relied on:
 *   world.config.orphans   { deadChildMs, parentIdleMs, hungTurnMs, errorStopTurns }
 *   world.sensorFor(id)    fresh sensor heartbeat
 *                          { sessionId, pid, ts, idle, pending, lastEventAt, executingTools, ... }
 *   world.events           EventWindow; cooldown/fallback in the last 5 min mean "waiting for retry" (R1-B3)
 *   task records           { taskId, status, active, terminal, terminalAtMs, hostPid, parentSessionId, childSessionId }
 *   session.errors         assistant messages with stopReason "error": [{ ms, text, provider }]
 *   session.turns          assistant messages with usage: [{ ms, stopReason, provider }]
 *
 * Remedies (data.remedy) are delivered to subject.sessionId: the PARENT for
 * dead-child / child-error-unhandled, the session itself for
 * stopped-on-errors / hung-main-turn. task-host-gone is report-only: omo
 * reconciles such a task when its parent is resumed, so only
 * task-host-gone-after-resume (the parent resumed elsewhere and moved on) is an upstream suspect.
 * A child whose last record is a tool result or user message is D5's
 * hung-turn-child case and is skipped here so the parent is not woken twice.
 */
export const id = "D8";

const RETRY_QUIET_MS = 5 * 60_000;
const ERROR_RUN_GAP_MS = 60_000;
const RESUMED_ACTIVE_MS = 5 * 60_000;
const RETRY_MARGIN_MS = 5 * 60_000;

const minutesOf = (ms) => Math.round(ms / 60_000);

function hostAlive(world, pid) {
	return Number.isFinite(pid) && (world.liveHostPids.has(pid) || world.procs.isAlive(pid));
}

function childSessionOf(world, task) {
	return world.children.get(task.uid ?? task.taskId)?.session ?? (task.childSessionId ? world.sessions.get(task.childSessionId) : undefined);
}

/** The D8 dead-child predicate: the child's idle ms when it is silent without a clean stop, else undefined. Shared with D11. */
export function deadChildIdleMs(world, task) {
	if (!task.active) return undefined;
	const child = childSessionOf(world, task);
	if (!child || !world.isSessionLive(child)) return undefined;
	if (child.pending?.size) return undefined;
	if (!Number.isFinite(child.lastEntryMs)) return undefined;
	const idleMs = world.now - child.lastEntryMs;
	if (idleMs < world.config.orphans.deadChildMs) return undefined;
	const last = child.lastMessage;
	// N3: a resident worker that finished its round with `stop` is healthy.
	if (last?.role === "assistant" && last.stopReason === "stop") return undefined;
	// D5 hung-turn-child owns "waiting on the model after a tool result / user message".
	if (last?.role === "toolResult" || last?.role === "user") return undefined;
	if (revivedRecently(world, task, child)) return undefined;
	if (last?.role === "assistant" && last.stopReason === "error" && idleMs < retryWaitMs(world, child, last)) return undefined;
	return idleMs;
}

/**
 * #82: omo-task's revive rewrites the record to `running` with updated_at = the revive time and no terminal_at
 * (plugin/extensions/omo-task.js, JI()). omo-task also rewrites updated_at on other discrete events (model fallback, start/continue,
 * park, residency changes, the kill marker) but never on a timer, so a fresh updated_at newer than the child's last record means
 * "the record just changed and the child has not written since"; each write holds for at most reviveGraceMs.
 */
function revivedRecently(world, task, child) {
	if (task.status !== "running" || !Number.isFinite(task.updatedAtMs)) return false;
	if (task.updatedAtMs <= child.lastEntryMs) return false;
	return world.now - task.updatedAtMs < world.config.orphans.reviveGraceMs;
}

/**
 * #93: senpi answers a retryable error by sleeping and retrying; nothing about that wait is persisted (no auto_retry_* entry in
 * the child JSONL, nothing in the task record), so it is inferred from the error text. Usage-limit/quota/rate-limit errors get
 * retryWaitMs (senpi's 30 min usage-limit cooldown plus margin) measured from the last record; a stated provider retry time
 * stretches that to reset + margin, never past retryWaitMaxMs. Any other error stays dead at deadChildMs.
 */
function retryWaitMs(world, child, last) {
	const cfg = world.config.orphans;
	const wait = retryWaitOf(last.errorMessage ?? child.errors?.at(-1)?.text);
	if (!wait) return 0;
	if (wait.resetAtMs === undefined) return cfg.retryWaitMs;
	const untilReset = wait.resetAtMs - child.lastEntryMs + RETRY_MARGIN_MS;
	return Math.min(Math.max(cfg.retryWaitMs, untilReset), cfg.retryWaitMaxMs);
}

function deadChildren(world) {
	const out = [];
	for (const task of world.tasks) {
		const idleMs = deadChildIdleMs(world, task);
		if (idleMs === undefined) continue;
		const child = childSessionOf(world, task);
		const last = child.lastMessage;
		const parentSessionId = task.parentSessionId ?? child.parentSessionId;
		if (!parentSessionId) continue;
		const minutes = minutesOf(idleMs);
		// C16: the last error text, so the skip list can recognize limit/auth causes the same way retryWaitMs does.
		const errorText = last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage ?? child.errors?.at(-1)?.text : undefined;
		out.push(
			makeFinding({
				detector: id,
				kind: "dead-child",
				subject: { sessionId: parentSessionId, taskId: task.taskId, parentSessionId, key: `dead:${child.id}@${child.lastEntryMs}` },
				evidence: [`last:${last?.role ?? "none"}:${last?.stopReason ?? ""}`, `idleMs:${idleMs}`, `task:${task.status}`],
				titleKo: `서브에이전트 정지: ${task.taskId} ${minutes}분째 기록 없음`,
				detailKo: `작업 ${task.taskId}(자식 세션 ${child.id})이 실행 중으로 표시되지만 ${minutes}분 동안 새 기록이 없고 대기 중인 도구 호출도 없습니다. 마지막 기록은 정상 종료(stop)가 아닙니다. 부모 세션 ${parentSessionId}에 알립니다.`,
				data: { idleMs, childSessionId: child.id, lastRole: last?.role, lastStopReason: last?.stopReason, taskStatus: task.status, ...(errorText ? { errorText: truncate(redact(errorText), 300) } : {}), remedy: { kind: "wake-parent", reason: "dead-child" } },
			}),
		);
	}
	return out;
}

function childErrors(world) {
	const cfg = world.config.orphans;
	const out = [];
	for (const task of world.tasks) {
		if (task.status !== "error" || !Number.isFinite(task.terminalAtMs)) continue;
		const parent = task.parentSessionId ? world.sessions.get(task.parentSessionId) : undefined;
		if (!parent) continue;
		if (Number.isFinite(parent.lastEntryMs) && parent.lastEntryMs > task.terminalAtMs) continue;
		// A days-old error in a store that just became visible is backlog, not news: the parent is not woken for it.
		if (world.now - task.terminalAtMs > world.config.sessions.recentMs) continue;
		const idleMs = world.now - task.terminalAtMs;
		if (idleMs < cfg.parentIdleMs) continue;
		const minutes = minutesOf(idleMs);
		const hb = world.sensorFor(parent.id);
		const child = childSessionOf(world, task);
		const childLast = child?.lastMessage;
		// C16: prefer the child's own final error message; fall back to the task record's error field when the child session is unknown.
		const errorText = childLast?.role === "assistant" && childLast.stopReason === "error" ? childLast.errorMessage ?? child.errors?.at(-1)?.text : task.errorMessage;
		out.push(
			makeFinding({
				detector: id,
				kind: "child-error-unhandled",
				subject: { sessionId: parent.id, taskId: task.taskId, parentSessionId: parent.id, key: `child-error@${task.terminalAtMs}` },
				evidence: [`task:${task.status}`, `idleMs:${idleMs}`],
				titleKo: `서브에이전트 오류 방치: ${task.taskId} ${minutes}분째`,
				detailKo: `작업 ${task.taskId}이 오류로 끝났지만 부모 세션 ${parent.id}에는 그 뒤 ${minutes}분 동안 아무 기록이 없습니다. 부모 세션에 알립니다.`,
				data: { idleMs, terminalAtMs: task.terminalAtMs, parentSensorIdle: hb ? hb.idle === true : undefined, ...(errorText ? { errorText: truncate(redact(errorText), 300) } : {}), remedy: { kind: "wake-parent", reason: "child-error" } },
			}),
		);
	}
	return out;
}

/**
 * The parent that was resumed on another live host and has worked there for RESUMED_ACTIVE_MS since that host
 * started, or undefined. Only then should omo core's resume_children reconcile have closed the task (#92).
 */
function resumedParent(world, task) {
	const parent = task.parentSessionId ? world.sessions.get(task.parentSessionId) : undefined;
	if (!parent || !world.isSessionLive(parent)) return undefined;
	const parentPid = world.shellParentPid(parent);
	if (!Number.isFinite(parentPid) || parentPid === task.hostPid) return undefined;
	const hostStartMs = world.procs.get(parentPid)?.ctimeMs;
	// An unknown creation time reads as ctimeMs 0 (collect/procs.mjs); it cannot prove the resume is older than RESUMED_ACTIVE_MS.
	if (!(Number.isFinite(hostStartMs) && hostStartMs > 0) || !Number.isFinite(parent.lastEntryMs)) return undefined;
	if (parent.lastEntryMs - hostStartMs <= RESUMED_ACTIVE_MS) return undefined;
	return { parent, parentPid, hostStartMs };
}

function hostsGone(world) {
	// An empty or stale process table would make every host look dead.
	if (!world.procsFresh) return [];
	const out = [];
	for (const task of world.tasks) {
		if (!task.active || !Number.isFinite(task.hostPid)) continue;
		if (hostAlive(world, task.hostPid)) continue;
		// omo reconciles a long-untouched host-gone record when the parent resumes; only recent ones are incidents now.
		if (world.now - (task.updatedAtMs ?? task.createdAtMs ?? 0) > world.config.sessions.recentMs) continue;
		const resumed = resumedParent(world, task);
		const parentId = task.parentSessionId ?? "?";
		out.push(
			makeFinding({
				detector: id,
				kind: resumed ? "task-host-gone-after-resume" : "task-host-gone",
				severity: "info",
				subject: { sessionId: task.childSessionId, taskId: task.taskId, parentSessionId: task.parentSessionId, key: `host-gone:${task.hostPid}` },
				evidence: [`hostPid:${task.hostPid}`, `task:${task.status}`, ...(resumed ? [`parentPid:${resumed.parentPid}`, `parentLastEntryMs:${resumed.parent.lastEntryMs}`] : [])],
				titleKo: resumed ? `재개 후에도 남은 고아 작업: ${task.taskId}` : `작업 호스트 종료됨: ${task.taskId}`,
				detailKo: resumed
					? `작업 ${task.taskId}은 ${task.status} 상태로 남아 있고 실행하던 omo 프로세스(pid ${task.hostPid})는 없습니다. 부모 세션 ${parentId}은 다른 프로세스(pid ${resumed.parentPid})에서 재개되어 활동 중인데도 작업이 정리되지 않았습니다.`
					: `작업 ${task.taskId}은 ${task.status} 상태로 남아 있지만 그 작업을 실행하던 omo 프로세스(pid ${task.hostPid})가 더 이상 없습니다. 부모 세션 ${parentId}을 다시 열면 omo가 이 작업을 재개하거나 정리합니다.`,
				data: { hostPid: task.hostPid, taskStatus: task.status, parentSessionId: task.parentSessionId ?? null, onceKey: `${task.taskId}@${task.hostPid}`, ...(resumed ? { parentPid: resumed.parentPid, parentHostStartMs: resumed.hostStartMs, parentLastEntryMs: resumed.parent.lastEntryMs } : {}) },
			}),
		);
	}
	return out;
}

/** The trailing run of >= n error stops, or undefined. */
function trailingErrorRun(session, n) {
	const last = session.lastMessage;
	if (last?.role !== "assistant" || last.stopReason !== "error") return undefined;
	const errors = [...(session.errors ?? [])].filter((e) => Number.isFinite(e.ms)).sort((a, b) => a.ms - b.ms);
	if (errors.length < n) return undefined;
	const run = errors.slice(-n);
	for (let i = 1; i < run.length; i++) if (run[i].ms - run[i - 1].ms > ERROR_RUN_GAP_MS) return undefined;
	const firstMs = run[0].ms;
	const lastErrorMs = run.at(-1).ms;
	if ((session.turns ?? []).some((turn) => turn.stopReason !== "error" && turn.ms > firstMs)) return undefined;
	// Extension state records (hook stop-state, rules scans on reload) are written after every turn; only conversation entries mean it moved on.
	const lastActivityMs = session.lastActivityMs ?? session.lastEntryMs;
	if (Number.isFinite(lastActivityMs) && lastActivityMs > lastErrorMs) return undefined;
	return { run, lastErrorMs };
}

function stoppedOnErrors(world, memory) {
	const cfg = world.config.orphans;
	memory.nudged ??= {};
	const out = [];
	for (const session of world.sessions.values()) {
		// A nudge is addressed to the stopped session itself. Children have no sensor to receive it (it could only
		// land in the main session), and a child that ended on errors or went silent is woken through its parent.
		if (session.kind === "child") continue;
		const found = trailingErrorRun(session, cfg.errorStopTurns);
		if (!found) continue;
		if (!world.isSessionLive(session)) continue;
		const lastErr = found.run.at(-1);
		const provider = lastErr.provider ?? providerOfError(lastErr.text);
		const recoveredAt = laneRecoveredAfter(world, provider, found.lastErrorMs);
		if (recoveredAt === undefined) continue;
		const incident = `${session.id}@${found.lastErrorMs}`;
		if (memory.nudged[session.id] === found.lastErrorMs) continue;
		memory.nudged[session.id] = found.lastErrorMs;
		const errorClass = classifyProviderError(lastErr.text);
		out.push(
			makeFinding({
				detector: id,
				kind: "stopped-on-errors",
				subject: { sessionId: session.id, taskId: session.taskId, parentSessionId: session.parentSessionId, key: `errstop:${incident}` },
				evidence: [`errors:${found.run.length}`, `class:${errorClass}`, `provider:${provider ?? "?"}`],
				titleKo: `오류로 멈춘 세션: 공급자 회복 후 재개 필요`,
				detailKo: `세션 ${session.id}이 연속 ${found.run.length}번 오류 응답 뒤 멈춰 있습니다(${errorClass}). 같은 공급자${provider ? `(${provider})` : ""}에서 이후 정상 응답이 확인되어 이 세션에 이어서 진행하라고 알립니다.`,
				data: { errorClass, recoveredAt, lastErrorMs: found.lastErrorMs, provider, remedy: { kind: "nudge" } },
			}),
		);
	}
	return out;
}

function hungMainTurns(world) {
	const cfg = world.config.orphans;
	const retrying = world.events.since(world.now - RETRY_QUIET_MS).some((event) => event.type === "cooldown" || event.type === "fallback");
	if (retrying) return [];
	const out = [];
	for (const session of world.sessions.values()) {
		if (session.kind !== "main") continue;
		const hb = world.sensorFor(session.id);
		if (!hb || hb.idle !== false || hb.executingTools !== 0) continue;
		if (session.pending?.size) continue;
		if (!Number.isFinite(hb.lastEventAt)) continue;
		const idleMs = world.now - hb.lastEventAt;
		if (idleMs < cfg.hungTurnMs) continue;
		const minutes = minutesOf(idleMs);
		out.push(
			makeFinding({
				detector: id,
				kind: "hung-main-turn",
				subject: { sessionId: session.id, key: `hung-main@${hb.lastEventAt}` },
				evidence: [`idleMs:${idleMs}`, "executingTools:0", "idle:false"],
				titleKo: `메인 세션 모델 응답 정지: ${minutes}분째 응답 없음`,
				detailKo: `세션 ${session.id}이 응답을 기다리는 중인데 실행 중인 도구 없이 ${minutes}분 동안 아무 이벤트가 없습니다. 최근 5분 안에 재시도 대기(cooldown/fallback)도 없었습니다. 현재 턴을 중단하고 이어서 진행합니다.`,
				data: { idleMs, lastEventAt: hb.lastEventAt, remedy: { kind: "abort-continue" } },
			}),
		);
	}
	return out;
}

export function detect(world, memory = {}) {
	return [...deadChildren(world), ...childErrors(world), ...hostsGone(world), ...stoppedOnErrors(world, memory), ...hungMainTurns(world)];
}
