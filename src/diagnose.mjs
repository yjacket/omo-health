import { createProcessSource, ProcessTracker } from "./collect/procs.mjs";
import { SessionRegistry } from "./collect/sessions.mjs";
import { createTranscriptIndex } from "./collect/transcripts.mjs";
import { readDecisions } from "./decisions.mjs";
import { quietHang } from "./detect/classify.mjs";
import * as loops from "./detect/loops.mjs";
import { batchDead, examinePending, freshSignMs, issuedBeforeHost, quietMembers, sessionLabel, stalledRecently } from "./detect/stall.mjs";
import { probeFile, readSensors, restoreStalls } from "./engine.mjs";
import { buildWorld } from "./state.mjs";
import { actionLabel, adviceLabel, resultLabel, verdictLabel, waitClassLabel } from "./ui/labels.mjs";
import { readJsonSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";
import { formatDuration, kst } from "./util/time.mjs";

/**
 * `omo-health diagnose <task|session>` (issue #60): what a subagent waits on, whether it is still moving, and what to
 * do about it, without a model call. The D1 matcher and classifier read the pending calls exactly as the daemon does;
 * the verdict turns the class the daemon acts on into advice for the person (or agent) about to cancel it.
 */

const MB = 1024 * 1024;
const DAY_MS = 24 * 3600_000;
/** Gap between the two process snapshots: long enough for a CPU share, short enough for an agent to wait on. */
export const DIAGNOSE_SAMPLE_MS = 3000;
const VERDICT_RANK = { idle: 0, progressing: 1, stalled: 2, looping: 3 };
const ADVICE_RANK = { none: 0, wait: 1, cancel: 2, "release-shell": 3 };
/** Classes whose process tree is the whole problem: ending it hands the call its result (the daemon's release, detach or kill). */
const RELEASE_CLASSES = new Set(["server-foreground", "blocked-on-input", "unbounded-wait", "runaway-readonly", "memory-runaway"]);

const judged = (verdict, advice, reasonKo, extra) => ({ verdict, advice, reasonKo, ...extra });
/** R11 and R12 read CPU and output from a short sample (3 s for the CLI): the verdict is an estimate, and says so. */
const HEURISTIC = { heuristic: true };
const SHORT_SAMPLE = "짧은 표본으로 본 추정입니다.";
const adviceText = (v) => `${adviceLabel(v.advice)}${v.judgePending ? " (판정 대기)" : ""}`;

/** Verdict and advice for one pending call from its D1 class: what the daemon would do, said to a person. */
function judgeCall(c, { ageMs, now, cfg, children, analystOn }) {
	const age = formatDuration(ageMs);
	switch (c.cls) {
		case "human-wait":
			return judged("progressing", "wait", `사용자 답변을 ${age}째 기다립니다.`);
		case "child-wait":
			return judged("progressing", "wait", children.length ? `서브에이전트 결과를 기다립니다: ${children.map((t) => t.taskId).join(", ")} (각각 diagnose로 보세요).` : "서브에이전트 결과를 기다립니다.");
		case "pending":
			return judged("progressing", "wait", `호출한 지 ${age}라 아직 판단하기 이릅니다.`);
		case "bounded":
			return judged("progressing", "wait", `명령에 제한 시간이 있어 ${kst(c.dueMs)}까지 기다립니다.`);
		case "withheld":
			return judged("progressing", "wait", "같은 묶음의 다른 호출이 끝나야 결과가 옵니다. 그 호출을 보세요.");
		case "progressing":
			return judged("progressing", "wait", "프로세스가 CPU를 쓰거나 파일을 쓰고 있습니다.");
		case "respawn-loop":
			return judged("looping", "release-shell", `프로그램이 죽고 다시 뜨기를 반복합니다(${c.data.stormName}).`);
		case "inproc":
			if (ageMs >= cfg.inprocToolRelayMs) return judged("stalled", "cancel", `셸 없이 도는 도구가 ${age}째 결과를 주지 않습니다. 풀어 줄 셸이 없어 취소해야 합니다.`);
			return judged("progressing", "wait", `셸 없이 도는 도구가 ${age}째 실행 중입니다.`);
		case "exited-no-result":
			return judged("stalled", "cancel", "명령 프로세스는 끝났는데 결과가 오지 않았습니다.");
		case "unmatched":
			if (ageMs >= cfg.softMs) return judged("stalled", "cancel", `명령을 실행하는 프로세스를 찾지 못한 채 ${age}가 지났습니다.`);
			return judged("progressing", "wait", "명령을 실행하는 프로세스를 아직 찾지 못했습니다.");
		case "quiet-hang": {
			const quiet = formatDuration(now - c.data.quietSinceMs);
			if (c.action.kind === "relay-cancel") return judged("stalled", "cancel", `같은 묶음에 결과를 줄 호출이 남아 있지 않은 채 ${quiet}째 조용합니다. 풀어 줄 셸이 없어 취소해야 합니다.`, HEURISTIC);
			return judged("stalled", "release-shell", `대화 기록도 출력도 없이 ${quiet}째 조용합니다. 감시기는 분석가에게 묻고, 멈춤으로 판정될 때만 셸을 풉니다. ${SHORT_SAMPLE}`, HEURISTIC);
		}
		case "unknown": {
			if (c.rule.id === "R10x") return judged("stalled", "release-shell", `조금씩 쓰기는 하지만 ${age}째 끝나지 않습니다. 감시기는 분석가에게 묻고, 멈춤으로 판정될 때만 셸을 풉니다.`);
			// #52: no CPU, no writes and no transcript event is the quiet hang the operator had to find by hand.
			if (c.data.idle && ageMs >= cfg.noProgressMs) return judged("stalled", "release-shell", `프로세스가 CPU도 쓰기도 없이 ${age}째 조용합니다. ${SHORT_SAMPLE}`, HEURISTIC);
			if (c.data.idle) return judged("progressing", "wait", `프로세스가 조용하지만 ${age}째라 아직 판단하기 이릅니다. ${SHORT_SAMPLE}`, HEURISTIC);
			// Busy, or not sampled yet (a daemon that just started has one process snapshot): the daemon asks the analyst, and
			// only an analyst verdict releases it (judge/policy.mjs); no clock does.
			const state = c.data.cpuSampled ? "프로세스가 CPU를 쓰고 있습니다" : "CPU를 아직 재지 못했습니다";
			if (!analystOn) return judged("progressing", "wait", `${state}. 분석가가 꺼져 있어 감시기는 이 호출을 풀지 않습니다. ${SHORT_SAMPLE}`, HEURISTIC);
			return judged("progressing", "wait", `${state}. 감시기가 ${kst(c.dueMs)}부터 분석가에게 묻고, 멈춤으로 판정될 때만 셸을 풉니다. ${SHORT_SAMPLE}`, { ...HEURISTIC, judgePending: true });
		}
		default:
			if (RELEASE_CLASSES.has(c.cls)) return judged("stalled", "release-shell", `${waitClassLabel(c.cls)}: 이 호출은 스스로 끝나지 않습니다.`);
			return judged("progressing", "wait", waitClassLabel(c.cls));
	}
}

/** A session with no pending call: between turns, generating a reply, or done. */
function judgeQuiet(session, world) {
	const lastMs = session.lastActivityMs ?? session.lastEntryMs;
	const quietMs = Number.isFinite(lastMs) ? world.now - lastMs : undefined;
	const quiet = quietMs === undefined ? "기록 없이" : `${formatDuration(quietMs)}째`;
	const turnEnded = session.lastMessage?.role === "assistant" && session.lastMessage.stopReason !== "toolUse";
	if (session.kind === "main") {
		if (turnEnded || world.sensorFor(session.id)?.idle) return judged("idle", "none", "세션이 사용자 입력을 기다립니다.");
	} else if (turnEnded) {
		if (quietMs >= world.config.orphans.deadChildMs) return judged("stalled", "cancel", `마지막 응답 뒤 ${quiet} 작업이 끝나지 않았습니다.`);
		return judged("progressing", "wait", "응답을 마쳤고 작업이 마무리되기를 기다립니다.");
	}
	if (quietMs >= world.config.orphans.hungTurnMs) return judged("stalled", "cancel", `모델 응답이 ${quiet} 없습니다.`);
	return judged("progressing", "wait", "모델이 다음 응답을 만드는 중입니다.");
}

/**
 * The daemon's next step for a call and when (judge/policy.mjs): an R10x, R11 or quiet-hang call opens an investigation
 * at its due time and is released only on an analyst verdict; with the analyst off nothing is planned for it.
 */
function plannedAction(c, analystOn) {
	if (!c.action) return null;
	if (c.action.kind === "analyze" && !analystOn) return null;
	return { kind: c.action.kind, labelKo: actionLabel(c.action.kind), dueMs: c.dueMs ?? null };
}

function procView(procs, proc) {
	const frac = procs.cpuFracs(proc, 1)[0];
	return { pid: proc.pid, ppid: proc.ppid, name: proc.name, cpuPct: frac === undefined ? null : Math.round(frac * 100), memMB: Math.round((proc.privBytes ?? 0) / MB), cmd: truncate(redact(proc.cmd), 200) };
}

const onlyOne = (list) => (list.length === 1 ? list[0] : undefined);

/**
 * The session and task an id names: a task id, a session id, or the unique session whose id starts with it (8+ chars).
 * A task whose transcript is not tracked still resolves, so a finished or orphaned task can be told apart.
 */
export function resolveSubject(world, id) {
	const key = String(id ?? "").trim();
	if (!key) return undefined;
	const sessions = [...world.sessions.values()];
	const byTask = sessions.filter((s) => s.taskId === key);
	if (byTask.length) {
		const session = byTask.find((s) => s.task?.active) ?? byTask[0];
		return { session, task: session.task ?? world.tasksById.get(key) };
	}
	const task = world.tasks.filter((t) => t.taskId === key).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0];
	if (task) return { session: sessions.find((s) => s.id === task.childSessionId), task };
	const session = world.sessions.get(key) ?? (key.length >= 8 ? onlyOne(sessions.filter((s) => String(s.id).startsWith(key))) : undefined);
	if (session) return { session, task: session.task ?? (session.taskId ? world.tasksById.get(session.taskId) : undefined) };
	const child = key.length >= 8 ? onlyOne(world.tasks.filter((t) => String(t.childSessionId ?? "").startsWith(key))) : undefined;
	return child ? { session: undefined, task: child } : undefined;
}

/** Subjects worth diagnosing: running subagents, then sessions with a live sensor. */
export function listSubjects(world) {
	const out = [];
	const seen = new Set();
	for (const task of world.tasks) {
		if (!task.active || seen.has(task.taskId)) continue;
		seen.add(task.taskId);
		out.push({ id: task.taskId, kind: "task", label: truncate(task.summary ?? task.name ?? "", 60), status: task.status ?? null, parentSessionId: task.parentSessionId ?? null });
	}
	for (const hb of world.sensors.values()) {
		if (world.sensorFor(hb.sessionId)) out.push({ id: hb.sessionId, kind: "session", label: truncate(hb.cwd ?? "", 60), status: hb.idle ? "idle" : "busy", parentSessionId: null });
	}
	return out;
}

/** The daemon's recent actions on this subject, from the decision log (history, so it holds whether or not the daemon runs). */
function subjectActions(decisions, ids) {
	const fps = new Set(decisions.filter((d) => d.subject && (ids.has(d.subject.sessionId) || ids.has(d.subject.taskId))).map((d) => d.fp));
	return decisions
		.filter((d) => d.action && fps.has(d.fp))
		.slice(-5)
		.map((d) => ({ ts: d.ts, kind: d.action.kind, kindKo: actionLabel(d.action.kind), result: d.result }));
}

function worst(items) {
	return items.reduce((a, b) => (VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] || (VERDICT_RANK[b.verdict] === VERDICT_RANK[a.verdict] && ADVICE_RANK[b.advice] > ADVICE_RANK[a.advice]) ? b : a));
}

/**
 * Diagnose one subject in a world (pure). `memory` is D1's match memory; `decisions` (optional) adds the daemon's
 * recent actions on the subject.
 */
export function diagnose(world, id, { memory = { matches: new Map() }, decisions, stalls } = {}) {
	const found = resolveSubject(world, id);
	if (!found) return { v: 1, id, found: false, atMs: world.now, candidates: listSubjects(world) };
	const { session, task } = found;
	const cfg = world.config.stall;
	const children = session ? world.tasks.filter((t) => t.active && t.parentSessionId === session.id).map((t) => ({ taskId: t.taskId, status: t.status, label: truncate(t.summary ?? t.name ?? "", 60) })) : [];
	const calls = session ? [...session.pending.values()].filter((call) => !issuedBeforeHost(world, session, call)).sort((a, b) => a.ms - b.ms) : [];
	const live = session ? world.isSessionLive(session) : Boolean(task && world.liveHostPids.has(task.hostPid));
	// Without a fresh process table every host looks dead; the other rules still hold.
	const hostGone = world.procsFresh && !live && !task?.terminal;
	const HOST_GONE = judged("stalled", "cancel", "작업을 돌리던 omo 호스트 프로세스가 없습니다.");
	const analystOn = world.config.analyst?.enabled !== false;
	const waitingOn = calls.map((call) => {
		const ex = examinePending({ session, call, world, memory });
		let c = ex.c;
		// R12 as D1 applies it to a child's call, with the quiet clock read from this world alone. The restall
		// record (a recent stall of the task, so the 5 min limit) is the daemon's, read from its state.json.
		let restall = false;
		if (session.kind === "child") {
			const sinceMs = freshSignMs({ call, session, world, members: quietMembers(world, ex.match), redirectInfo: ex.redirectInfo });
			restall = stalledRecently(stalls, session, call, cfg);
			c = quietHang(c, { world, sinceMs, restall, batchDead: c.cls === "withheld" && batchDead(world, session, call, memory) }) ?? c;
		}
		const ageMs = world.now - call.ms;
		// No host, no result: a withheld or still-young call would never finish either.
		const verdict = hostGone ? HOST_GONE : judgeCall(c, { ageMs, now: world.now, cfg, children, analystOn });
		const targets = c.action?.targets ?? (ex.match.confidence === "high" && ex.match.root ? [ex.match.root] : []);
		const planned = plannedAction(c, analystOn);
		return {
			toolCallId: call.id,
			tool: call.name,
			command: ex.command ? truncate(redact(ex.command), 400) : null,
			startedMs: call.ms,
			elapsedMs: ageMs,
			cls: c.cls,
			clsKo: waitClassLabel(c.cls),
			rule: c.rule.id,
			confidence: c.confidence,
			evidence: c.evidence,
			match: { state: ex.match.state, confidence: ex.match.confidence, reason: ex.match.reason ?? null },
			plannedAction: planned?.kind ?? null,
			plannedActionKo: planned?.labelKo ?? null,
			dueMs: planned?.dueMs ?? null,
			releaseTargets: verdict.advice === "release-shell" ? targets.map((p) => ({ pid: p.pid, name: p.name })) : [],
			processes: [...ex.match.tree, ...ex.match.orphans].map((proc) => procView(world.procs, proc)),
			outputs: ex.redirectInfo.map(({ file, size, mtimeMs }) => ({ file, size, mtimeMs })),
			...verdict,
			verdictKo: verdictLabel(verdict.verdict),
			adviceKo: adviceText(verdict),
		};
	});
	const loopFindings = session ? loops.detect({ ...world, sessions: new Map([[session.id, session]]) }) : [];
	let verdict;
	if (task?.terminal) verdict = judged("idle", "none", `작업이 이미 끝났습니다(${task.status}).`);
	else if (hostGone) verdict = HOST_GONE;
	else if (loopFindings.length) verdict = judged("looping", "cancel", `${loopFindings[0].titleKo}.`);
	else if (waitingOn.length) verdict = worst(waitingOn);
	else if (session) verdict = judgeQuiet(session, world);
	else verdict = judged("progressing", "wait", "작업 기록은 있지만 대화 기록을 아직 찾지 못했습니다.");
	const eventMs = session?.lastActivityMs ?? session?.lastEntryMs;
	const outputMs = Math.max(-Infinity, ...waitingOn.flatMap((w) => w.outputs.map((o) => o.mtimeMs)).filter(Number.isFinite));
	const lastMs = Math.max(Number.isFinite(eventMs) ? eventMs : -Infinity, outputMs);
	const ids = new Set([session?.id, task?.taskId, session?.taskId].filter(Boolean));
	// null when no process has a CPU sample yet: a 0 would read as an idle tree.
	const cpus = waitingOn.flatMap((w) => w.processes.map((p) => p.cpuPct)).filter((pct) => pct !== null);
	return {
		v: 1,
		id,
		found: true,
		atMs: world.now,
		subject: {
			kind: session?.kind ?? "child",
			label: session ? sessionLabel(session) : `서브에이전트 ${task.taskId}`,
			sessionId: session?.id ?? task?.childSessionId ?? null,
			taskId: task?.taskId ?? session?.taskId ?? null,
			taskStatus: task?.status ?? null,
			parentSessionId: session?.parentSessionId ?? task?.parentSessionId ?? null,
			hostPid: (session ? world.shellParentPid(session) : task?.hostPid) ?? null,
			hostAlive: live,
			sessionFile: session?.file ?? null,
		},
		verdict: verdict.verdict,
		verdictKo: verdictLabel(verdict.verdict),
		advice: verdict.advice,
		adviceKo: adviceText(verdict),
		reasonKo: verdict.reasonKo,
		// The verdict leans on a short CPU and output sample (R11, R12): an estimate, not a rule.
		heuristic: Boolean(verdict.heuristic),
		// The advice is to wait because the daemon's judge has yet to weigh in on the call.
		judgePending: Boolean(verdict.judgePending),
		waitingOn,
		lastProgress: { eventMs: eventMs ?? null, outputMs: Number.isFinite(outputMs) ? outputMs : null, ms: Number.isFinite(lastMs) ? lastMs : null, ageMs: Number.isFinite(lastMs) ? world.now - lastMs : null },
		cpuPct: cpus.length ? cpus.reduce((sum, pct) => sum + pct, 0) : null,
		loops: loopFindings.map((f) => ({ kind: f.kind, titleKo: f.titleKo })),
		children,
		actions: decisions ? subjectActions(decisions, ids) : [],
	};
}

/**
 * A world collected now with the daemon's own collectors: session registry, sensor heartbeats and two process
 * snapshots `sampleMs` apart. It never reads the daemon's status files: they are only current while a daemon runs,
 * and they never held process trees or CPU samples, so a stopped daemon would make them describe the past. The one
 * thing read from the daemon (in runDiagnose) is the timestamped restall record in state.json.
 */
export async function collectWorld({ paths, config, procs, clock = { now: () => Date.now() }, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), sampleMs = DIAGNOSE_SAMPLE_MS }) {
	// One sample window stands in for the daemon's two 20 s intervals, so the classifier reads one CPU sample.
	const cfg = { ...config, stall: { ...config.stall, cpuSamples: 1 } };
	const failures = [];
	const tracker = new ProcessTracker();
	tracker.update(await procs.snapshot());
	await sleep(sampleMs);
	const table = tracker.update(await procs.snapshot());
	if (!table.size) throw new Error("the process snapshot is empty");
	const now = clock.now();
	const sensors = readSensors(paths, now);
	const registry = new SessionRegistry({ paths, config: cfg, clock }).refresh({ sensors });
	const shellWaits = [...registry.sessions.values()].some((s) => [...s.pending.values()].some((call) => /^(bash|shell)$/i.test(call.name)));
	// OS memory and ports only sharpen a class (memory pressure, a listening server); their failure is reported, not fatal.
	const optional = (name, fn) => fn().catch((error) => void failures.push(`${name}:${error.message}`));
	const os = await optional("os", () => procs.os());
	const ports = shellWaits && procs.ports ? await optional("ports", () => procs.ports()) : undefined;
	const transcripts = createTranscriptIndex({ claudeProjectsDir: paths.claudeProjectsDir, clock });
	return buildWorld({
		now,
		config: cfg,
		paths,
		registry,
		procs: table,
		procsFresh: true,
		os,
		ports,
		sensors,
		self: { pid: process.pid, failures },
		intentFor: ({ session, call }) => transcripts.find({ toolCallId: call.id, cwd: session.kind === "child" ? (session.task?.spawnCwd ?? session.cwd) : session.cwd, sinceMs: call.ms }) ?? null,
		fileProbe: probeFile,
	});
}

/** Whether a daemon heartbeats now (the sensor's own staleness rule); its absence means no automatic action follows. */
function daemonStatus(paths, config, now) {
	const hb = readJsonSafe(paths.health.daemonJson);
	const running = Boolean(hb && !hb.stoppedMs && Number.isFinite(hb.ts) && now - hb.ts <= config.daemonStaleMs);
	return { running, pid: running ? hb.pid : null, mode: running ? (hb.mode ?? null) : null, heartbeatAgeMs: Number.isFinite(hb?.ts) ? now - hb.ts : null };
}

/** `omo-health diagnose` and the dashboard: collect a fresh world, diagnose `id`, and always close the process worker. */
export async function runDiagnose({ paths, config, id, procs = createProcessSource({ binDir: paths.health.binDir }), clock = { now: () => Date.now() }, sleep, sampleMs = DIAGNOSE_SAMPLE_MS }) {
	try {
		const world = await collectWorld({ paths, config, procs, clock, sleep, sampleMs });
		// The daemon saves its restall record ({taskId: {atMs, toolCallId}}) in state.json every minute; the timestamps make it history that holds whether or not the daemon runs.
		const stalls = restoreStalls(readJsonSafe(paths.health.stateFile)?.memories?.stall?.stalls);
		const report = diagnose(world, id, { decisions: readDecisions(paths, world.now - DAY_MS), stalls });
		return { ...report, daemon: daemonStatus(paths, config, world.now), source: { world: "fresh", sampleMs, failures: world.self.failures } };
	} finally {
		procs.close?.();
	}
}

/** The dashboard's subject list: read without a process snapshot, so opening the page costs no worker. */
export function listSubjectsNow({ paths, config, clock = { now: () => Date.now() } }) {
	const now = clock.now();
	const sensors = readSensors(paths, now);
	const registry = new SessionRegistry({ paths, config, clock }).refresh({ sensors });
	return { subjects: listSubjects(buildWorld({ now, config, paths, registry, sensors })) };
}

/** Korean text for a person; the JSON (`--json`) carries the same fields for agents. */
export function formatDiagnosis(r) {
	if (!r.found) {
		const lines = [`진단할 대상을 찾지 못했습니다: ${r.id}`];
		if (r.candidates.length) lines.push("진단할 수 있는 대상:", ...r.candidates.map((c) => `  ${c.id}${c.label ? `  ${c.label}` : ""}`));
		else lines.push("돌고 있는 서브에이전트나 세션이 없습니다.");
		return lines.join("\n");
	}
	const lines = [`대상: ${r.subject.label}${r.subject.taskStatus ? ` (상태 ${r.subject.taskStatus})` : ""}`, `판정: ${r.verdictKo} / 권고: ${r.adviceKo}`, `이유: ${r.reasonKo}`];
	if (r.waitingOn.length) lines.push("기다리는 것:");
	for (const w of r.waitingOn) {
		lines.push(`  - ${w.tool}${w.command ? ` \`${truncate(w.command.replace(/\s+/g, " "), 160)}\`` : ""}: ${formatDuration(w.elapsedMs)}째, ${w.clsKo} (규칙 ${w.rule}) → ${w.verdictKo}`);
		for (const p of w.processes) lines.push(`      프로세스 ${p.name} ${p.pid}: CPU ${p.cpuPct ?? "?"}%, 메모리 ${p.memMB}MB`);
		for (const o of w.outputs) lines.push(`      출력 파일 ${o.file}: ${o.size}바이트, 마지막 변경 ${kst(o.mtimeMs)}`);
		if (w.releaseTargets.length) lines.push(`      풀 대상: ${w.releaseTargets.map((p) => `${p.name} ${p.pid}`).join(", ")} (이 프로세스만 끝내면 호출이 결과를 돌려받고 작업은 이어집니다)`);
		if (w.plannedAction && w.dueMs) lines.push(`      감시기 조치 예정: ${w.plannedActionKo} (${kst(w.dueMs)})`);
	}
	if (r.loops.length) lines.push(`반복: ${r.loops.map((l) => l.titleKo).join("; ")}`);
	if (r.children.length) lines.push(`돌고 있는 서브에이전트: ${r.children.map((c) => `${c.taskId}${c.label ? ` (${c.label})` : ""}`).join(", ")}`);
	lines.push(`마지막 진척: ${r.lastProgress.ms === null ? "기록 없음" : `${kst(r.lastProgress.ms)} (${formatDuration(r.lastProgress.ageMs)} 전)`}`);
	if (r.daemon) lines.push(r.daemon.running ? `감시기: 실행 중 (pid ${r.daemon.pid}, 모드 ${r.daemon.mode ?? "?"}). 예정된 조치는 감시기가 합니다.` : "감시기: 실행 중이 아닙니다. 자동 조치가 없으니 권고대로 직접 처리하세요.");
	for (const a of r.actions) lines.push(`감시기 조치 기록: ${kst(Date.parse(a.ts))} ${a.kindKo} ${resultLabel(a.result)}`);
	if (r.source) lines.push(`근거: 지금 모은 기록(프로세스 스냅샷 2회, ${r.source.sampleMs / 1000}초 간격). 감시기 상태 파일에서는 재정체 기록(state.json)만 읽습니다.${r.source.failures?.length ? ` 읽지 못한 것: ${r.source.failures.join(", ")}` : ""}`);
	return lines.join("\n");
}
