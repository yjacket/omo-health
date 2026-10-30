import crypto from "node:crypto";
import { formatDuration, kst } from "../util/time.mjs";
import { redact, truncate } from "../util/text.mjs";

/**
 * Messages delivered into omo sessions through the sensor inbox (plan todo 10,
 * D-8, D-12). Korean summary for the human, English text the parent forwards
 * to its child with task_send (children cannot load the sensor, R1-B2).
 */

const CLASS_KO = {
	"runaway-readonly": "CPU만 쓰며 끝나지 않는 읽기 명령",
	"memory-runaway": "메모리 폭주",
	"server-foreground": "포그라운드로 뜬 서버",
	"blocked-on-input": "입력 대기",
	"unbounded-wait": "끝나지 않는 대기",
	"respawn-loop": "프로세스를 죽고 다시 띄우기를 반복하는 명령",
	unknown: "원인 불명 멈춤",
	inproc: "응답 없는 도구 호출",
	unmatched: "프로세스를 특정할 수 없는 멈춤",
	"exited-no-result": "끝났지만 결과가 오지 않는 호출",
	"quiet-hang": "기록도 출력도 없이 멈춘 호출",
};

const ACTION_KO = {
	"kill-pids": "폭주 프로세스만 종료",
	"release-shell": "명령의 셸 트리 종료",
	"detach-server": "서버는 두고 기다리던 셸만 종료",
	"relay-cancel": "부모 세션에 취소·재기동 권고",
	notify: "알림",
};

const ADVICE = {
	"runaway-readonly": "Do not rerun it as-is. Use a bounded alternative (for example `grep -ob -F`, `rg -o --max-count`, or read a slice with `head -c`) and always pass an explicit Bash timeout.",
	"memory-runaway": "Do not rerun it as-is. Stream or bound its output (and its memory), and always pass an explicit Bash timeout.",
	"server-foreground": "It was a server whose output was tied to the tool call, so the call could not finish while it ran. Start servers with `cmd > log 2>&1 &` and poll readiness with a bounded loop.",
	"blocked-on-input": "It was waiting for interactive input. Use non-interactive flags (`--no-pager`, `-y`, `GIT_TERMINAL_PROMPT=0`, `git commit -m ...`).",
	"unbounded-wait": "It could never finish on its own. Add a bound (`timeout N ...`, a maximum number of loop iterations, `tail -n` instead of `tail -f`).",
	"respawn-loop": "It kept relaunching a program that died immediately (a crash or a broken retry loop). Run the program once by hand and read its error before retrying, and check whether it requires a browser or OS feature that changed.",
	unknown: "Find out what it waits on before retrying, and wrap it in `timeout N`.",
	"exited-no-result": "A background descendant kept the tool pipe open. Redirect output of background programs to a file (`cmd > log 2>&1 &`).",
	"quiet-hang": "It produced no output and no transcript event for many minutes, so it was treated as hung. Find out what it was waiting on (a browser, a lock, a network peer, a prompt) before retrying, give it an explicit `timeout N`, and run long waits in the background with output redirected to a file.",
};

export function newMessageId(now) {
	return `${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** omo-health killed an agent-owned background respawner; the owner session should know. */
/** Why the rule's kill ran after the analyst had its say (#55 C): Korean and English, like the rest of the notice. */
const HOLD_TEXT = {
	"max-hold": ["분석가의 판정과 관계없이 정해진 최대 대기 시간(respawn.maxHoldMs)이 지나", "it outlived the longest hold (respawn.maxHoldMs) whatever the analyst said"],
};

/** `hold`: why the rule's own kill ran (planRespawn); `triage`: the verdict that chose it, when one did. */
export function composeRespawnNotice({ finding, sessionId, now, outcome, hold, triage }) {
	const storm = finding.data?.storm ?? {};
	const killed = (outcome?.killed ?? []).map((p) => `${p.name}(${p.pid})`).join(", ") || "(없음)";
	const minutes = formatDuration(now - (storm.firstMs ?? now));
	const why = HOLD_TEXT[hold];
	const content =
		`[omo-health] 이 세션의 백그라운드 프로세스가 ${storm.name}를 ${minutes} 동안 ${storm.births}번 죽고 다시 띄우며 멈추지 않아${why ? `, ${why[0]}` : ""}, 다시 띄우던 프로세스(${killed})를 종료했습니다. ` +
		(triage?.diagnosis ? `진단: ${triage.diagnosis} ` : "") +
		`명령: \`${storm.cmdHead ?? "?"}\`. 이게 의도된 재시작 감시였으면 조건을 맞춰 다시 시작하고, 아니면 그 도구의 오류 원인을 확인하세요.\n` +
		`omo-health killed the respawner (${killed}): a background process launched from your session kept relaunching ${storm.name} ${storm.births} times over ${minutes} and it died within seconds every time${why ? `, and ${why[1]}` : ""}. Command: \`${storm.cmdHead ?? "?"}\`. If that was an intentional watcher, restart it with a bound; otherwise check the tool's error.`;
	return base({ kind: "self-notice", sessionId, now, deliverAs: "nextTurn", triggerTurn: false, content, details: { actionKind: "kill-respawner", incidentId: finding.fp, stormName: storm.name, respawnerPid: finding.data?.respawnerPid, hold: hold ?? null, tier: triage?.tier ?? null } });
}

function base({ kind, sessionId, now, deliverAs, triggerTurn, content, details }) {
	return { id: newMessageId(now), kind, sessionId, createdMs: now, customType: "omo-health", deliverAs, triggerTurn, content: redact(content), details };
}

function commandOf(finding) {
	return truncate(finding.data?.call?.commandHead ?? finding.data?.call?.name ?? "", 300);
}

function childLabel(finding) {
	const s = finding.subject ?? {};
	return s.taskId ? `서브에이전트 ${s.taskId}` : `세션 ${String(s.sessionId ?? "").slice(0, 8)}`;
}

const ASSESSMENT_KO = { normal: "정상", suspicious: "수상함", abnormal: "비정상" };
const TIER_OF = { wait: "normal", escalate: "suspicious", act: "abnormal" };

/** "분석가 판정 비정상(확신도 0.85)": what the analyst concluded and how sure. */
function triageLabel(verdict) {
	const assessment = verdict.assessment ?? TIER_OF[verdict.verdict];
	return `분석가 판정 ${ASSESSMENT_KO[assessment] ?? assessment ?? "?"}(확신도 ${verdict.confidence ?? "?"})`;
}

const METRIC_KO = { births: "프로세스 생성", cpu: "CPU", mem: "메모리 증가", writes: "쓰기", temp: "임시 파일 증가(PC 전체)" };

/** "- 이 PC의 평소 값에서 크게 벗어남: 프로세스 생성 9/min (평소 중앙값 0, z 999)": why the early look was asked for (#55 C). */
export function deviationLine(deviation) {
	const all = [...(deviation.metrics ?? []), ...(deviation.machine ?? [])];
	return `- 이 PC의 평소 값에서 크게 벗어남: ${all.map((m) => `${METRIC_KO[m.metric] ?? m.metric} ${m.value}${m.unit ?? ""} (평소 중앙값 ${m.median}, z ${m.z})`).join(", ")}`;
}

/**
 * D17 triage (#55 C): the look before the kill found the relaunch loop suspicious, or nothing vouched for the kill a
 * model chose. The owner hears what was seen (a child's parent as a relay, a session itself as a self-notice);
 * nothing was killed.
 */
export function composeRespawnTriageNotice({ finding, sessionId, now, verdict, target, parentIdle }) {
	const storm = finding.data?.storm ?? {};
	const respawner = finding.data?.remedy?.targets?.[0];
	const self = target === "self";
	const lines = [
		`[omo-health] ${self ? "이 세션" : childLabel(finding)}의 백그라운드 프로세스가 ${storm.name ?? "?"}를 ${formatDuration(now - (storm.firstMs ?? now))} 동안 ${storm.births ?? "?"}번 죽고 다시 띄우고 있습니다${respawner ? ` (다시 띄우는 프로세스 ${respawner.name}(${respawner.pid}))` : ""}.`,
		`- ${triageLabel(verdict)}${verdict.vetoed ? `. 모델이 고른 '${ACTION_KO[verdict.vetoed] ?? verdict.vetoed}'을(를) 아무것도 뒷받침하지 않아` : "."} 자동으로 종료하지 않았습니다.`,
	];
	const diagnosis = verdict.diagnosis ?? verdict.rationale;
	if (diagnosis) lines.push(`- 진단: ${diagnosis}`);
	lines.push(`- 명령: \`${storm.cmdHead ?? "?"}\``);
	const forward = verdict.advice ? adviceText(verdict.advice) : undefined;
	if (forward && !self) lines.push("아래 문장을 task_send로 서브에이전트에 그대로 전달하세요.", "```text", forward, "```");
	else if (forward) lines.push(`- 조언: ${verdict.advice}`);
	lines.push("의도된 재시작 감시가 아니면 그 프로세스를 멈추세요.");
	return base({
		kind: self ? "self-notice" : "relay",
		sessionId,
		now,
		deliverAs: self ? "nextTurn" : "followUp",
		triggerTurn: self ? false : Boolean(parentIdle),
		content: lines.join("\n"),
		details: { actionKind: "respawn-notice", incidentId: finding.fp, stormName: storm.name ?? null, respawnerPid: finding.data?.respawnerPid ?? null, tier: verdict.tier ?? 1, assessment: verdict.assessment ?? TIER_OF[verdict.verdict] ?? null, advice: verdict.advice ?? null, ...(forward ? { forwardText: forward } : {}) },
	});
}

/** The advice sentence the agent should read, in the voice of the other forwarded texts. */
function adviceText(advice) {
	return `omo-health: ${advice}`;
}

/** English text the parent should forward to the stalled child. `advice`: the analyst's sentence, which replaces the class's canned one. */
export function forwardText({ finding, actionKind, outcome, repeat, advice }) {
	const cls = finding.cls;
	const cmd = commandOf(finding);
	const minutes = Math.round((finding.data?.ageMs ?? 0) / 60_000);
	let text;
	if (actionKind === "detach-server") {
		const servers = (outcome?.serverPids ?? finding.data?.classification?.action?.serverPids ?? []).map((p) => p.pid);
		const ports = finding.data?.classification?.data?.ports ?? [];
		const unredirected = finding.data?.classification?.data?.redirected === false ? " Its output was not redirected to a file, so it may exit as soon as this call returns (its stdout was the tool pipe): check the port first, and if it is gone start it again with output redirected." : "";
		text = `omo-health: your command \`${cmd}\` started a server that kept the Bash call open (run_in_background is not honoured on this host). The waiting shell was closed; the server is still running${servers.length ? ` as pid ${servers.join(", ")}` : ""}${ports.length ? ` on port ${ports.join(", ")}` : ""}.${unredirected} Use it as is and stop it with \`taskkill /F /PID <pid>\` when you are done. Next time start servers with \`cmd > log 2>&1 &\` and poll readiness with a bounded loop.`;
	} else {
		const what = actionKind === "kill-pids" ? `the runaway process(es) ${(outcome?.killed ?? []).map((p) => `${p.name}(${p.pid})`).join(", ") || ""} were terminated` : "its shell was terminated";
		text = `omo-health: your command \`${cmd}\` did not return for ${minutes} min (${cls}); ${what}, so the tool call ended with an error. ${advice || ADVICE[cls] || ADVICE.unknown}`;
	}
	if (repeat) text += " This is the second stall of the same kind within 30 minutes: change the approach instead of retrying.";
	return text;
}

/**
 * Notice after a process action. target "parent" (child stalls) or "self" (main session with a sensor). `triage`: the
 * verdict that started the action (#55 B); the analyst's diagnosis is shown and its advice replaces the canned one.
 */
export function composeActionNotice({ finding, actionKind, outcome, target, sessionId, now, parentIdle, repeat, reportPath, triage }) {
	const who = childLabel(finding);
	const age = formatDuration(finding.data?.ageMs ?? 0);
	const clsKo = CLASS_KO[finding.cls] ?? finding.cls;
	const killed = (outcome?.killed ?? []).map((p) => `${p.name}(${p.pid})`).join(", ");
	const lines = [
		`[omo-health] ${who}의 도구 호출이 ${age} 동안 멈춰 있어 자동으로 풀었습니다.`,
		`- 멈춘 명령: \`${commandOf(finding)}\``,
		`- 판단: ${clsKo} (${(finding.evidence ?? []).slice(0, 4).join(", ")})${triage ? `, ${triageLabel(triage)}` : ""}`,
	];
	if (triage?.tier === 2 && triage.diagnosis) lines.push(`- 진단: ${triage.diagnosis}`);
	lines.push(`- 조치: ${ACTION_KO[actionKind] ?? actionKind}${killed ? ` → 종료: ${killed}` : ""}`);
	const forward = forwardText({ finding, actionKind, outcome, repeat, advice: triage?.advice });
	if (target === "parent") {
		lines.push("서브에이전트는 이 도구 호출의 오류 결과를 받고 계속 진행합니다. 같은 실수를 반복하지 않도록 아래 문장을 task_send로 그대로 전달하세요.");
		lines.push("```text", forward, "```");
		if (repeat) lines.push("이 서브에이전트는 30분 안에 같은 방식으로 다시 멈췄습니다. 재지시로 부족하면 task_cancel 후 더 명확한 지시로 다시 띄우세요.");
	} else {
		lines.push("이 도구 호출은 오류로 끝납니다. 다음 설명을 참고해 이어서 진행하세요.", forward);
	}
	if (reportPath) lines.push(`보고서: ${reportPath}`);
	return base({
		kind: target === "parent" ? "relay" : "self-notice",
		sessionId,
		now,
		deliverAs: target === "parent" ? "followUp" : "steer",
		triggerTurn: target === "parent" ? Boolean(parentIdle && finding.data?.background === "background") : false,
		content: lines.join("\n"),
		details: { incidentId: finding.fp, taskId: finding.subject?.taskId, toolCallId: finding.subject?.toolCallId, cls: finding.cls, actionKind, killed: outcome?.killed ?? [], forwardText: forward, repeat: Boolean(repeat), reportPath, ...(triage ? { tier: triage.tier, advice: triage.advice ?? null } : {}) },
	});
}

/**
 * A main session's call was released because the analyst proved it ran the wrong command: the one explanation the
 * session gets (followUp). `idle` is whether the AGENT is idle (it then starts a turn to read this); whether the human is
 * at the keyboard never enters.
 */
export function composeWrongCommandRelease({ finding, sessionId, now, outcome, triage, idle }) {
	const killed = (outcome?.killed ?? []).map((p) => `${p.name}(${p.pid})`).join(", ");
	const evidence = (triage?.evidence ?? []).slice(0, 6);
	const age = formatDuration(finding.data?.ageMs ?? 0);
	const cmd = commandOf(finding);
	const content = [
		`[omo-health] 이 세션의 도구 호출 \`${cmd}\`이(가) 의도한 도구가 아닌 엉뚱한 프로그램을 실행해 ${age} 동안 끝나지 않아, 분석가 판정(확신도 ${triage?.confidence ?? "?"})에 따라 그 셸 트리를 종료했습니다${killed ? ` → 종료: ${killed}` : ""}. 이 도구 호출은 오류로 끝납니다.`,
		triage?.diagnosis ? `- 진단: ${triage.diagnosis}` : "",
		triage?.mechanism ? `- What happened: ${triage.mechanism}` : "",
		triage?.avoid ? `- Do instead: ${triage.avoid}` : "",
		...evidence.map((line) => `- 근거: ${line}`),
		`omo-health: your command \`${cmd}\` ran the wrong program and did not return for ${Math.round((finding.data?.ageMs ?? 0) / 60_000)} min, so its process tree was terminated on the analyst's verdict (confidence ${triage?.confidence ?? "?"}) and the tool call ended with an error. Why: ${String(triage?.diagnosis ?? "see the evidence").replace(/[.\s]+$/, "")}. Evidence: ${evidence.join("; ") || "-"}. Do not rerun it as-is: call the intended program directly (for example Git bash, not the WSL launcher C:\\Windows\\System32\\bash.exe) and avoid commands that open windows or wait for input.`,
	]
		.filter(Boolean)
		.join("\n");
	return base({
		kind: "relay",
		sessionId,
		now,
		deliverAs: "followUp",
		triggerTurn: Boolean(idle),
		content,
		details: { actionKind: "release-shell", incidentId: finding.fp, toolCallId: finding.subject?.toolCallId, cls: finding.cls, cause: triage?.cause ?? null, confidence: triage?.confidence ?? null, evidence, killed: outcome?.killed ?? [] },
	});
}

/**
 * The one notice a main session gets when the analyst looked at its stalled call and did not prove a wrong command:
 * the diagnosis, nothing killed. It waits for the session's next turn.
 */
export function composeMainStallNotice({ finding, sessionId, now, verdict }) {
	const diagnosis = verdict?.diagnosis ?? verdict?.rationale;
	const evidence = (verdict?.evidence ?? []).slice(0, 4);
	const content = [
		`[omo-health] 이 세션의 도구 호출 \`${commandOf(finding)}\`이(가) ${formatDuration(finding.data?.ageMs ?? 0)} 동안 끝나지 않고 있습니다. ${triageLabel(verdict ?? {})}. 아무것도 종료하지 않았습니다.`,
		diagnosis ? `- 진단: ${diagnosis}` : "",
		verdict?.mechanism ? `- What happened: ${verdict.mechanism}` : "",
		verdict?.avoid ? `- Do instead: ${verdict.avoid}` : "",
		...evidence.map((line) => `- 근거: ${line}`),
		"omo-health: this tool call has not returned; nothing was terminated. If it is stuck, cancel it yourself.",
	]
		.filter(Boolean)
		.join("\n");
	return base({ kind: "self-notice", sessionId, now, deliverAs: "nextTurn", triggerTurn: false, content, details: { actionKind: "main-notice", incidentId: finding.fp, toolCallId: finding.subject?.toolCallId, cause: verdict?.cause ?? null, assessment: verdict?.assessment ?? TIER_OF[verdict?.verdict] ?? null, mechanism: verdict?.mechanism ?? null, avoid: verdict?.avoid ?? null } });
}

/**
 * The one explanation a supervising session gets for a yellow footer problem (C6, IS-3): the analyst's cause, the
 * mechanism (what the command/argument actually did) and what to do instead. A child's parent receives it as a relay
 * (followUp, waking an idle parent); a main session as a self-notice on its next turn.
 */
export function composeWhyNotice({ finding, sessionId, now, verdict, target, parentIdle }) {
	const self = target === "self";
	const who = self ? "this session" : childLabel(finding);
	const cmd = commandOf(finding);
	const evidence = (verdict?.evidence ?? []).slice(0, 3);
	const content = [
		`omo-health looked into ${who}: ${finding.detector} ${finding.kind}${cmd ? ` \`${cmd}\`` : ""}.`,
		verdict?.cause ? `Cause: ${verdict.cause}` : "",
		verdict?.mechanism ? `What happened: ${verdict.mechanism}` : "",
		verdict?.avoid ? `Do instead: ${verdict.avoid}` : "",
		evidence.length ? `Evidence: ${evidence.join("; ")}` : "",
		"Do not rerun the same command unchanged.",
	]
		.filter(Boolean)
		.join("\n");
	return base({
		kind: self ? "self-notice" : "relay",
		sessionId,
		now,
		deliverAs: "followUp",
		triggerTurn: !self && parentIdle === true,
		content,
		details: { why: true, fp: finding.fp, detector: finding.detector, kind: finding.kind, cause: verdict?.cause ?? null, confidence: verdict?.confidence ?? null },
	});
}

/** A notice older than this describes a state that no longer exists (#102): the sensor drops it instead. */
export const MONITOR_NOTICE_TTL_MS = 15 * 60_000;

/**
 * Delivered on the owner's next agent turn (followUp), never as a wake-up. Timestamped, and a persistent monitor is
 * never advised to be re-armed: senpi re-runs it on restart, so re-arming would duplicate it (#102).
 */
export function composeMonitorOrphanNotice({ sessionId, items, now }) {
	const count = items.reduce((sum, item) => sum + item.count, 0);
	const label = (list) => list.map((item) => `${item.description} (${item.monitorId})`).join(", ");
	const names = label(items);
	const persistent = items.filter((item) => item.persistent);
	const ephemeral = items.filter((item) => !item.persistent);
	const sessionFile = items.find((item) => item.sessionFile)?.sessionFile;
	const utc = new Date(now).toISOString();
	const ko = [`[omo-health] ${utc} (${kst(now)}) 소유자가 없는 monitor ${items.length}개(${names})의 프로세스 ${count}개를 종료했습니다.`];
	const en = [`omo-health stopped ${count} orphaned processes from ${items.length} monitor(s) at ${utc} (${kst(now)}): ${names}.`];
	if (persistent.length) {
		ko.push(`persistent monitor(${label(persistent)})는 senpi가 재시작 때 스스로 다시 실행하니 다시 등록하지 마세요.`);
		en.push(`senpi re-runs persistent monitors on restart (${label(persistent)}); do not register them again.`);
	}
	if (ephemeral.length) {
		ko.push(`아직 필요하면 감시(${label(ephemeral)})를 다시 등록하세요.`);
		en.push(`Re-arm ${persistent.length ? "the other monitors" : "the monitors"} if still needed.`);
	}
	return base({ kind: "self-notice", sessionId, now, deliverAs: "followUp", triggerTurn: false,
		content: `${ko.join(" ")}\n${en.join(" ")}`,
		// sessionFile: the owner's transcript; once it is gone the notice can never be delivered (inbox expiry).
		// killed (pid:ctime): what this notice is about; a live watcher with any other launcher means senpi restored it.
		details: { actionKind: "kill-orphan-watchers", killedAtMs: now, expiresMs: now + MONITOR_NOTICE_TTL_MS,
			killed: items.flatMap((item) => item.killed ?? []),
			monitors: items.map((item) => ({ sessionId, monitorId: item.monitorId, persistent: Boolean(item.persistent) })),
			...(sessionFile ? { sessionFile } : {}) },
	});
}

/**
 * A crashed session was reopened in a new tab (D18): one bilingual note that never starts a turn. The turn comes from
 * the resume command's own prompt (#109), and D18 sends this note only after the new sensor shows a run started since
 * the launch. idle false: that run is still going, so the note steers into it; otherwise it waits for the next turn.
 */
export function composeCrashResumeNotice({ sessionId, now, crashPid, crashTs, lostTasks = [], idle }) {
	const lost = lostTasks.join(", ");
	const content = [
		`[omo-health] 이 세션의 이전 실행이 호스트 비정상 종료(pid ${crashPid}, ${kst(crashTs)})로 끊겨 같은 작업공간의 새 탭에서 다시 열었습니다. ${lost ? `프로세스 안에서 돌던 서브에이전트(${lost})는 사라졌으니 결과를 기다리지 마세요. ` : ""}작업 트리 상태(git status, 반쯤 된 수정)를 확인하고 이어서 진행하세요.`,
		`omo-health: the previous run of this session crashed (host pid ${crashPid}, ${new Date(crashTs).toISOString()}) and was reopened in a new tab. ${lost ? `In-process subagents were lost (${lost}); do not wait for their results. ` : ""}Check the worktree state (git status, partial edits) and continue.`,
	].join("\n");
	return base({ kind: "self-notice", sessionId, now, deliverAs: idle === false ? "steer" : "nextTurn", triggerTurn: false, content, details: { actionKind: "crash-resume", crashPid, lostTasks } });
}

const GOAL_WAKE_TEXT = {
	"leaked-monitor": ["기다리던 monitor가 이미 끝났거나 사라졌습니다", "the monitor this session waits on has ended or is gone"],
	"leaked-task": ["기다리던 서브에이전트(task)가 더 이상 실행 중이 아닙니다", "the subagent task this session waits on is no longer running"],
	"leaked-workflow": ["기다리던 워크플로(dag run)가 더 이상 실행 중이 아닙니다", "the workflow run this session waits on is no longer running"],
	"unfolded-workflow": ["기다리는 워크플로가 끝난 작업을 반영하지 못해 멈춰 있습니다", "the workflow it waits on cannot advance: a node's task already ended but the run never took the result"],
	"stalled-workflow": ["기다리는 워크플로에 실행 중인 노드가 없어 진행되지 않습니다", "the workflow it waits on has nothing running or scheduled, so it will not advance"],
	"idle-monitor": ["기다리는 monitor의 프로세스가 살아 있지만 오래 아무 일도 하지 않습니다", "the monitor it waits on is alive but has done nothing for a long time"],
	"idle-background": ["기다리는 백그라운드 세션의 프로세스가 살아 있지만 오래 아무 일도 하지 않습니다", "the background session it waits on is alive but has done nothing for a long time"],
	silent: ["오랫동안 아무 진행이 없습니다", "there has been no progress for a long time"],
};

const WORKFLOW_ADVICE = "A run that cannot advance by itself never sends a completion: check it, fold or cancel it, re-run only what it still owes, then continue the goal.";
const IDLE_ADVICE = "Read its output first (bash_output or task_output); if it already printed its result or is hung, stop it and continue; do not rerun the same command unchanged.";
const WORKFLOW_REASONS = new Set(["unfolded-workflow", "stalled-workflow"]);
const IDLE_REASONS = new Set(["idle-monitor", "idle-background"]);

/** A goal session that waits on something that no longer exists, or sat silent too long (D21): wake it to check and continue. */
export function composeGoalWake({ sessionId, reason, now, sources = [], verdict }) {
	const [ko, en] = GOAL_WAKE_TEXT[reason] ?? GOAL_WAKE_TEXT.silent;
	const lines = [
		`[omo-health] 이 goal 세션이 대기 중인데 ${ko}(${reason}). 무엇을 기다리고 있는지 확인하고, 더 기다릴 필요가 없으면 이어서 진행하세요.`,
		`omo-health: this goal session is waiting, but ${en} (${reason}). Check what you are waiting for and continue the goal if there is nothing left to wait on.`,
	];
	if (sources.length) lines.push("Evidence:", ...sources.slice(0, 8).map((source) => `- ${source.text}`));
	if (verdict) {
		lines.push(`Analyst: ${verdict.mechanism ?? verdict.diagnosis}${verdict.avoid ? ` Do instead: ${verdict.avoid}` : ""}`);
	}
	if (WORKFLOW_REASONS.has(reason)) lines.push(WORKFLOW_ADVICE);
	else if (IDLE_REASONS.has(reason)) lines.push(IDLE_ADVICE);
	return base({ kind: "wake", sessionId, now, deliverAs: "followUp", triggerTurn: true, content: lines.join("\n"),
		details: { actionKind: "goal-wake", reason, expiresMs: now + 300_000, sources: sources.map((s) => s.id).filter(Boolean),
			verdict: verdict ? { cause: verdict.cause ?? null, confidence: verdict.confidence ?? null } : null } });
}

/**
 * The answer to a report (#60 item 5): what the triage found, to the owning session. A child's report goes to its
 * parent (relay, followUp, with the advice to forward); a main session's to itself (self-notice on its next turn), which
 * is all a main session ever gets: never a process action. Without a model answer it carries the rule diagnosis of the
 * report's evidence snapshot (`ruleDiagnosis`, src/diagnose.mjs).
 */
export function composeTriageNotice({ finding, sessionId, now, verdict, target, parentIdle, ruleDiagnosis, snapshotFile }) {
	const report = finding.data?.report ?? {};
	const s = finding.subject ?? {};
	const self = target === "self";
	const lines = [`[omo-health] ${self ? "이 세션" : childLabel(finding)}에 대한 보고를 확인했습니다: "${truncate(String(report.text ?? "").replace(/\s+/g, " "), 160)}"`];
	const answered = verdict && !verdict.reason;
	if (answered) {
		lines.push(`- ${triageLabel(verdict)}`);
		const diagnosis = verdict.diagnosis ?? verdict.rationale;
		if (diagnosis) lines.push(`- 진단: ${diagnosis}`);
	} else {
		const why = verdict?.reason ?? "판정기 꺼짐";
		lines.push(ruleDiagnosis?.found ? `- 모델 판정 없음(${why}). 규칙 진단: ${ruleDiagnosis.verdictKo} / ${ruleDiagnosis.adviceKo}. ${ruleDiagnosis.reasonKo}` : `- 모델 판정 없음(${why}). 대상을 진단하지 못했습니다.`);
	}
	const forward = answered && verdict.advice ? adviceText(verdict.advice) : undefined;
	if (forward && !self) lines.push("아래 문장을 task_send로 서브에이전트에 그대로 전달하세요.", "```text", forward, "```");
	else if (forward) lines.push(`- 조언: ${verdict.advice}`);
	lines.push(`다시 보려면: omo-health diagnose ${s.taskId ?? s.sessionId ?? report.subject ?? "?"}${snapshotFile ? `. 증거: ${snapshotFile}` : ""}`);
	return base({
		kind: self ? "self-notice" : "relay",
		sessionId,
		now,
		deliverAs: self ? "nextTurn" : "followUp",
		triggerTurn: self ? false : Boolean(parentIdle),
		content: lines.join("\n"),
		details: { actionKind: "triage-notice", reportId: report.id ?? null, incidentId: finding.fp, taskId: s.taskId ?? null, tier: answered ? (verdict.tier ?? 1) : null, assessment: answered ? (verdict.assessment ?? TIER_OF[verdict.verdict] ?? null) : null, advice: answered ? (verdict.advice ?? null) : null, ...(forward ? { forwardText: forward } : {}), snapshotFile: snapshotFile ?? null },
	});
}

/**
 * The stall could not be released automatically: ask the parent to cancel and re-dispatch. `triage`: the verdict that
 * started the ladder (#55 B); the analyst's diagnosis and advice go with the cancel request.
 */
export function composeRelayCancel({ finding, sessionId, now, parentIdle, reportPath, triage }) {
	const s = finding.subject ?? {};
	const diagnosis = triage?.tier === 2 ? triage.diagnosis : null;
	const advice = triage?.advice ?? null;
	const mechanism = triage?.mechanism ?? null;
	const avoid = triage?.avoid ?? null;
	const content = [
		`[omo-health] ${childLabel(finding)}의 도구 호출 \`${commandOf(finding) || finding.data?.call?.name}\`이(가) ${formatDuration(finding.data?.ageMs ?? 0)} 동안 끝나지 않았고 자동으로 풀 수 없었습니다.`,
		diagnosis ? `- 진단(${triageLabel(triage)}): ${diagnosis}` : "",
		mechanism ? `- What happened: ${mechanism}` : "",
		avoid ? `- Do instead: ${avoid}` : "",
		mechanism || avoid
			? `다음 순서로 처리하세요: task_output(${s.taskId ?? "?"})으로 상태 확인 → 멈춰 있으면 task_cancel → 다시 띄울 때는 위에 적힌 대로 바꿔서 지시하세요.`
			: `다음 순서로 처리하세요: task_output(${s.taskId ?? "?"})으로 상태 확인 → 멈춰 있으면 task_cancel.`,
		advice ? ["다시 띄울 때 이 문장을 함께 전달하세요:", "```text", adviceText(advice), "```"].join("\n") : "",
		reportPath ? `보고서: ${reportPath}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return base({ kind: "relay-cancel", sessionId, now, deliverAs: "followUp", triggerTurn: Boolean(parentIdle), content, details: { incidentId: finding.fp, taskId: s.taskId, toolCallId: s.toolCallId, reportPath, ...(triage ? { tier: triage.tier ?? 1, advice, mechanism, avoid } : {}) } });
}

/** Wake a parent whose child died, hung or errored without anyone acting. */
export function composeWake({ finding, sessionId, now, reportPath }) {
	const s = finding.subject ?? {};
	const reason = finding.data?.remedy?.reason ?? finding.kind;
	const minutes = finding.data?.idleMs ? formatDuration(finding.data.idleMs) : "";
	const content =
		reason === "child-error"
			? `[omo-health] 서브에이전트 ${s.taskId}가 오류로 끝났는데 이 세션이 ${minutes} 동안 다음 행동을 하지 않았습니다. task_output(${s.taskId})으로 결과를 확인하고 다음 단계를 진행하세요. do not relaunch it unchanged: omo-health is analysing the cause and will send what to change.${reportPath ? `\n보고서: ${reportPath}` : ""}`
			: `[omo-health] 서브에이전트 ${s.taskId}가 ${minutes} 동안 아무 진행이 없습니다(${reason}). 완료 알림이 오지 않을 수 있습니다. task_output(${s.taskId})으로 먼저 출력을 확인하세요. do not relaunch it unchanged: omo-health is analysing the cause and will send what to change.${reportPath ? `\n보고서: ${reportPath}` : ""}`;
	return base({ kind: "wake", sessionId, now, deliverAs: "followUp", triggerTurn: true, content, details: { incidentId: finding.fp, taskId: s.taskId, reason, reportPath } });
}

/** Resume a session that stopped on provider errors once the provider recovered (IS-10b). */
export function composeNudge({ finding, sessionId, now }) {
	const recoveredAt = finding.data?.recoveredAt;
	const content = `[omo-health] 앞서 공급자 오류(${finding.data?.errorClass ?? "provider error"})로 멈췄던 작업을 이어서 진행하세요.${recoveredAt ? ` 공급자는 ${kst(recoveredAt)}에 회복됐습니다.` : ""} 마지막으로 하던 단계부터 다시 시작하면 됩니다.`;
	return base({ kind: "nudge", sessionId, now, deliverAs: "followUp", triggerTurn: true, content, details: { incidentId: finding.fp, recoveredAt } });
}

/** Tell sessions that settings.json was reverted (IS-10a). */
export function composeRevertNotice({ finding, sessionId, now, outcome }) {
	const content = `[omo-health] settings.json 변경 직후 공급자 설정 오류가 연달아 발생해 직전 정상본으로 되돌렸습니다. 거부된 파일은 ${outcome?.rejectedCopy ?? "(보관 실패)"}에 보관했습니다. 의도한 변경이었다면 오류 원인(예: anthropicSubscriptionProvider.enabled:true 누락)을 고친 뒤 다시 적용하세요.`;
	return base({ kind: "revert-notice", sessionId, now, deliverAs: "followUp", triggerTurn: false, content, details: { incidentId: finding.fp, rejectedCopy: outcome?.rejectedCopy } });
}

/** A quiet scope reminder, to the session itself or forwarded through its parent. */
export function composeScopeCheck({ finding, sessionId, now, forward = false, deliverAs = "steer", verdict }) {
	const { signal, metric, evidence, goal, lastUserText, lastUserMs } = finding.data;
	const summary = {
		churn: "반복 수정과 실패를 다시 점검하세요.",
		overstep: "질문에 답하는 범위를 넘었는지 확인하세요.",
		stuck: "같은 할 일에서 진전 없이 단계를 반복하고 있는지 확인하세요.",
		reopened: "끝낸 할 일이 다시 열렸습니다. 원인을 다시 점검하세요.",
		repeat: "거의 같은 단계를 반복하고 있는지 확인하세요.",
		"after-complete": "완료 후 추가 작업이 필요한지 확인하세요.",
	}[signal];
	const sentence = {
		churn: `${metric} non-converging rounds or repeated checks`,
		overstep: `${metric} mutations after an information request`,
		stuck: evidence,
		reopened: evidence,
		repeat: evidence,
		"after-complete": `${metric} mutations after goal completion`,
	}[signal];
	const evidenceLine = `omo-health scope check (${signal}): ${sentence}. Original goal: "${goal}".`;
	const requestLine = typeof lastUserText === "string" && lastUserText.length > 0
		? `Latest user request${Number.isFinite(lastUserMs) ? ` (${ageLabel(now - lastUserMs)} ago)` : ""}: "${lastUserText}".`
		: null;
	const analystLine = verdict ? `Analyst: ${verdict.mechanism ?? verdict.diagnosis}${verdict.avoid ? ` Do instead: ${verdict.avoid}` : ""}` : null;
	const note = [
		`[omo-health 범위 점검] ${summary}`,
		evidenceLine,
		requestLine,
		analystLine,
		"Before your next step, reconsider once: (1) Is the current work required by that goal and request? (2) Is there a simpler path that satisfies it? (3) If you have been iterating without converging, stop iterating, choose the simplest acceptable option and continue, or tell the user what blocks you. Do not reply to this note; just adjust course.",
	].filter((line) => line !== null).join("\n");
	return base({ kind: "scope-check", sessionId, now, deliverAs, triggerTurn: false,
		content: forward ? `Forward this to subagent ${finding.subject.taskId} with task_send:\n${note}` : note,
		details: { kind: "scope-check", incidentId: finding.fp, subjectSessionId: finding.subject.sessionId, key: finding.subject.key, signal, metric, cause: verdict?.cause ?? null, confidence: verdict?.confidence ?? null } });
}

/** "5 min" / "5h": how long ago the quoted request was made. */
function ageLabel(ms) {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)}h`;
}

/** D23: work that was running when omo-health went down and never resumed. The session should not wait for it. */
export function composeBootGapNotice({ sessionId, now, gap, tasks = [], runs = [], goalActive = false, idle = false }) {
	const reboot = gap.kind === "reboot";
	const isoOf = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown";
	const kstOf = (ms) => Number.isFinite(ms) ? kst(ms) : "unknown";
	const lines = [
		`[omo-health] omo-health가 멈춰 있던 동안(${kstOf(gap.downSinceMs)}~${kstOf(gap.upAtMs)}) ${reboot ? "재부팅이 있었고" : "중단이 있었고"} 그 전에 실행 중이던 서브에이전트 ${tasks.length}개와 워크플로 ${runs.length}개가 이어지지 않았습니다. 아래 목록을 확인하고 필요한 것만 다시 띄우세요.`,
		`omo-health: ${reboot ? "the machine rebooted" : "omo-health was down"} between ${isoOf(gap.downSinceMs)} and ${isoOf(gap.upAtMs)}. Work that was running before it shows no progress since then; its records still say running:`,
	];
	for (const task of tasks) {
		const host = Number.isFinite(task.hostPid) ? `host pid ${task.hostPid} is gone.` : "no host pid recorded.";
		lines.push(`- task ${task.taskId} "${task.name ?? ""}" (${task.status}, created ${isoOf(task.createdAtMs)}, last progress ${isoOf(task.lastProgressMs)}): ${host}`);
	}
	for (const run of runs) {
		const nodes = (run.nodes ?? []).slice(0, 12).map((node) => `${node.id}=${node.state}`).join(", ");
		lines.push(`- workflow run ${run.runId} "${run.name ?? ""}" (${run.status}, ${run.counts?.completed ?? 0}/${run.counts?.total ?? 0} nodes done, last run event ${isoOf(run.lastEventAtMs)}): ${nodes}`);
	}
	lines.push("Do not wait for these. Read what they produced (task_output, the run's status), fold or cancel the run, re-dispatch only what is still needed, then continue.");
	return base({ kind: "self-notice", sessionId, now, deliverAs: goalActive && idle ? "followUp" : "nextTurn", triggerTurn: Boolean(goalActive && idle),
		content: lines.join("\n"),
		details: { actionKind: "boot-notice", gapKind: gap.kind, downSinceMs: gap.downSinceMs, tasks: tasks.map((task) => task.taskId), runs: runs.map((run) => run.runId) } });
}

/** Hung main-session turn: the sensor aborts, then resumes (R1-B3). */
export function composeAbortContinue({ finding, sessionId, now }) {
	const content = `[omo-health] 모델 응답이 ${formatDuration(finding.data?.idleMs ?? 0)} 동안 아무 이벤트 없이 멈춰 있어 중단 후 다시 이어갑니다. 직전 작업을 계속하세요.`;
	return base({ kind: "abort-continue", sessionId, now, deliverAs: "followUp", triggerTurn: true, content, details: { incidentId: finding.fp } });
}
