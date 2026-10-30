/** Korean labels for the dashboard. Unknown keys fall back to the raw key, so a new detector or step never breaks the page. */

export const FINDING_LABELS = Object.freeze({
	stall: "도구 호출 멈춤",
	"parent-blocked": "서브에이전트 때문에 세션 대기",
	"process-runaway": "omo 아래 프로세스 폭주",
	"machine-commit": "메모리 커밋 과다",
	"cache-storm": "캐시 폭풍",
	"burn-spike": "토큰 폭증",
	"full-resend": "전체 재전송",
	"context-runaway": "컨텍스트 폭주",
	"tps-collapse": "응답 속도 저하",
	"hung-turn-child": "서브에이전트 모델 응답 정지",
	"accounts-blocked": "Claude 계정 모두 차단",
	"not-configured-burst": "공급자 설정 오류 폭발",
	"usage-limit-storm": "사용량 한도 폭풍",
	"outage-human": "공급자 장애 지속",
	"settings-parse-error": "settings.json 파싱 실패",
	"ambient-not-enabled": "ambient 토큰 주입 꺼짐",
	"omo-jsonc-parse-error": "omo.jsonc 파싱 실패",
	"settings-broke-provider": "설정 변경으로 공급자 장애",
	"dead-child": "서브에이전트 정지(기록 없음)",
	"child-error-unhandled": "서브에이전트 오류 방치",
	"task-host-gone": "작업 호스트 종료 — 부모 세션 재개 대기",
	"task-host-gone-after-resume": "부모 세션 재개 후에도 남은 고아 작업",
	"stopped-on-errors": "오류로 멈춘 세션",
	"hung-main-turn": "메인 세션 모델 응답 정지",
	"leftover-process": "끝난 작업의 남은 프로세스",
	"same-call-loop": "도구 반복 루프",
	"error-storm": "오류 폭풍",
	"reload-starvation": "리로드 기아",
	"parse-drift": "기록 해석 실패 증가",
	"unknown-events": "모르는 omo 기록 이벤트",
	"session-parse-drift": "세션 기록 형식 오류",
	"version-changed": "버전 변경 감지",
	"sensor-missing": "센서 미로드",
	"self-budget": "감시기 자원 초과",
	"analyst-failing": "멈춤 분석가 연속 실패",
	"outside-workspace": "작업 폴더 밖 수정",
	"global-config-write": "전역 설정 수정",
	"orphan-monitor": "주인 없는 monitor 감시 프로세스",
	"goal-wait-stuck": "goal 대기 멈춤",
	"goal-wait-idle": "목표 대기 대상이 멈춤",
	monitor: "monitor 감시",
	background: "백그라운드 실행",
	"work-lost": "중단 전 작업이 이어지지 않음",
	"reflection-orphan": "끝난 메모리 반성 실행의 남은 프로세스",
	"respawn-storm": "재시작 폭주(죽고 다시 실행 반복)",
	"host-crash": "omo 호스트 비정상 종료",
	"host-resumed": "크래시한 세션 새 탭에서 재개됨",
	"host-crash-stopped": "크래시 세션 자동 재개 중단",
	"stale-heartbeats": "남은 센서 하트비트 정리",
	"park-invalid": "한도 대기 기록 오류",
	"park-due": "한도 대기 재개",
	drift: "작업 범위 점검 신호",
});

export const ACTION_LABELS = Object.freeze({
	"kill-pids": "원인 프로세스 종료",
	"release-shell": "기다리던 셸 해제",
	"detach-server": "포그라운드 서버 분리",
	"relay-cancel": "부모 세션에 취소 권고",
	notify: "부모 세션에 알림",
	analyze: "분석가에게 조사 요청",
	"triage-notice": "보고에 대한 판정 알림",
	"respawn-notice": "재시작 폭주 판정 알림",
	"why-notice": "원인 알림",
	"wake-parent": "부모 세션 깨우기",
	"goal-wake": "goal 세션 깨우기",
	wake: "세션 깨우기",
	nudge: "이어가기 넛지",
	"abort-continue": "응답 정지 중단 후 재개",
	"revert-settings": "settings.json 되돌리기",
	"kill-orphan-watchers": "고아 monitor 감시 프로세스 종료",
	"kill-reflection-orphans": "끝난 반성 실행의 남은 프로세스 종료",
	"kill-respawner": "재시작 폭주를 일으키는 프로세스 종료",
	"crash-resume": "크래시한 세션을 새 탭에서 다시 열기",
	"crash-cleanup": "남은 하트비트 정리(기록만)",
	"crash-notice": "재개된 세션에 크래시 안내",
	"park-resume": "한도 대기 재개",
	"park-cleanup": "비정상 한도 대기 기록 정리(기록만)",
	"boot-notice": "중단 전 작업 안내",
	"scope-check": "범위 점검 메시지",
	toast: "윈도우 알림",
});

export const RESULT_LABELS = Object.freeze({
	execute: "실행",
	would: "했을 조치(기록만)",
	"skipped:paused": "일시정지로 건너뜀",
	"skipped:switch-off": "스위치 꺼짐(설정 또는 완화 조치)",
	"skipped:main-session": "메인 세션이라 건너뜀",
	"skipped:out-of-scope": "범위 밖",
	"skipped:done": "이미 처리됨",
	applied: "반영됨",
	rejected: "거부됨(읽을 수 없는 파일)",
});

export const SEVERITY_LABELS = Object.freeze({ info: "관찰", warn: "주의", crit: "심각" });

export const EXIT_REASON_LABELS = Object.freeze({
	"stopped-file": "중지 요청",
	"idle-no-omo-hosts": "유휴 종료(omo 세션 없음)",
	update: "업데이트",
	rollback: "롤백",
	restart: "재시작",
	"cli-stop": "CLI 중지",
	install: "설치",
	uninstall: "제거",
	SIGINT: "인터럽트",
	SIGTERM: "종료 신호",
	stopped: "중지됨",
	elevate: "권한을 올린 감시기로 교체",
});

/** An incident's plan state (record.state) as `omo-health status` prints it; states without an entry print as they are. */
export const INCIDENT_STATE_LABELS = Object.freeze({ analyzing: "분석가 조사 중", "analyst-failed": "분석가 실패 — 풀지 않고 재시도 대기", "analyst-budget-spent": "분석 예산 소진 — 풀지 않고 대기", "waiting-analyst": "분석가 재확인 대기", "drift-normal": "분석가 판정 정상: 알림 없음" });

export const DAEMON_STATE_LABELS = Object.freeze({ running: "실행 중", stale: "응답 없음", crashed: "비정상 종료", stopped: "중지됨", off: "꺼짐" });

/** `omo-health diagnose`: what a subagent is doing, what to do about it, and what its pending tool call waits on (D1 classes). */
export const VERDICT_LABELS = Object.freeze({ progressing: "진행 중", stalled: "멈춤", looping: "반복", idle: "쉬는 중" });

export const ADVICE_LABELS = Object.freeze({ wait: "기다리세요", "release-shell": "셸만 풀어 주세요", cancel: "취소하세요", none: "할 일 없음" });

export const WAIT_CLASS_LABELS = Object.freeze({
	"human-wait": "사용자 답변 대기",
	"child-wait": "서브에이전트 결과 대기",
	inproc: "셸 없이 도는 도구",
	withheld: "같은 묶음의 다른 호출 때문에 결과 보류",
	"exited-no-result": "프로세스는 끝났는데 결과 없음",
	unmatched: "실행 중인 프로세스를 찾지 못함",
	bounded: "제한 시간이 있는 명령",
	"memory-runaway": "메모리 폭주",
	pending: "아직 분류 전(짧은 호출)",
	"respawn-loop": "재시작 폭주",
	"server-foreground": "포그라운드로 뜬 서버",
	"blocked-on-input": "입력을 기다리며 멈춤",
	"runaway-readonly": "CPU만 쓰는 읽기 명령",
	"unbounded-wait": "끝나지 않는 대기 명령",
	progressing: "진행 중인 작업",
	unknown: "원인을 알 수 없는 대기",
	"quiet-hang": "기록도 출력도 없이 멈춤",
});

/** An investigation (src/investigations.mjs) as the dashboard lists it: its status, what opened it, the analyst's answer and its cause. */
export const INVESTIGATION_STATUS_LABELS = Object.freeze({ open: "열림", analyzing: "분석 중", verdict: "판정됨", released: "풀림", advised: "권고함", noticed: "알림", closed: "닫힘", failed: "실패" });

/** What opened an investigation (src/investigations.mjs trigger); `why` is also the key of any investigation the analyst looked into for its cause (`why: true`). */
export const TRIGGER_LABELS = Object.freeze({ stall: "시간 초과", anomaly: "이상 징후", report: "보고", why: "원인 조사" });

/** Keyed by the summarized verdict (`wait` | `act`), or `escalate:<assessment>` for the two escalations. */
export const ANALYST_VERDICT_LABELS = Object.freeze({ wait: "진행 중", act: "멈춤", "escalate:abnormal": "복구 불가", "escalate:suspicious": "의심" });

export const CAUSE_LABELS = Object.freeze({ "wrong-command": "잘못된 명령", "blocked-input": "입력 대기", runaway: "폭주", "external-wait": "외부 대기", unknown: "원인 불명" });

/** Session board (status/_sessions.json SessionRow.state.kind): what a main session is doing right now. */
export const SESSION_STATE_LABELS = Object.freeze({ busy: "응답 중", tool: "도구 실행 중", idle: "대기", waiting: "작업 대기", "waiting-user": "사용자 대기", stale: "응답 없음" });

/** Ended-session ledger (src/session-ledger.mjs EndedRecord.outcome): how a session ended. */
export const OUTCOME_LABELS = Object.freeze({ "goal-complete": "목표 완료", answered: "응답 후 종료", crash: "비정상 종료", cancelled: "취소됨", failed: "실패", released: "omo-health 해제", closed: "종료됨", unknown: "알 수 없음" });

/** The terminal a main session runs in (SessionRow.terminal.kind), as the board's chip names it. */
export const TERMINAL_LABELS = Object.freeze({ orca: "Orca", herdr: "herdr", other: "기타" });

/** A child task's status (src/collect/tasks.mjs ACTIVE_TASK_STATUSES / TERMINAL_TASK_STATUSES). */
export const TASK_STATUS_LABELS = Object.freeze({ running: "실행 중", queued: "대기열", pending: "대기", starting: "시작 중", spawning: "시작 중", completed: "완료", error: "오류", failed: "실패", cancelled: "취소됨", interrupted: "중단됨", lost: "유실", killed: "강제 종료" });

/** A main session's goal status (SessionRow.goal.status, from the goal tool). */
export const GOAL_STATUS_LABELS = Object.freeze({ active: "진행 중", complete: "완료", blocked: "막힘" });

const label = (table, key, fallback) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : fallback);

export function findingLabel(detector, kind) {
	return label(FINDING_LABELS, kind, `${detector ?? "?"} ${kind ?? "?"}`);
}

export function actionLabel(kind) {
	return label(ACTION_LABELS, kind, String(kind ?? "?"));
}

export function resultLabel(result) {
	return label(RESULT_LABELS, result, String(result ?? "-"));
}

export function severityLabel(sev) {
	return label(SEVERITY_LABELS, sev, String(sev ?? ""));
}

export function exitReasonLabel(reason) {
	return label(EXIT_REASON_LABELS, reason, String(reason ?? ""));
}

export function incidentStateLabel(state) {
	return label(INCIDENT_STATE_LABELS, state, String(state ?? ""));
}

export function daemonStateLabel(state) {
	return label(DAEMON_STATE_LABELS, state, String(state ?? ""));
}

export function verdictLabel(verdict) {
	return label(VERDICT_LABELS, verdict, String(verdict ?? "-"));
}

export function adviceLabel(advice) {
	return label(ADVICE_LABELS, advice, String(advice ?? "-"));
}

export function waitClassLabel(cls) {
	return label(WAIT_CLASS_LABELS, cls, String(cls ?? "-"));
}

export function investigationStatusLabel(status) {
	return label(INVESTIGATION_STATUS_LABELS, status, String(status ?? "-"));
}

export function triggerLabel(trigger) {
	return label(TRIGGER_LABELS, trigger, String(trigger ?? "-"));
}

/** The analyst's answer of an investigation (src/engine.mjs summarizeVerdict); a failed look has no answer. */
export function analystVerdictLabel(verdict) {
	if (!verdict || typeof verdict !== "object" || verdict.failed) return "-";
	const key = verdict.verdict === "escalate" ? `escalate:${verdict.assessment}` : verdict.verdict;
	return label(ANALYST_VERDICT_LABELS, key, String(verdict.verdict ?? "-"));
}

export function causeLabel(cause) {
	return label(CAUSE_LABELS, cause, String(cause ?? "-"));
}

export function sessionStateLabel(kind) {
	return label(SESSION_STATE_LABELS, kind, String(kind ?? "-"));
}

export function outcomeLabel(outcome) {
	return label(OUTCOME_LABELS, outcome, String(outcome ?? "-"));
}

export function terminalLabel(kind) {
	return label(TERMINAL_LABELS, kind, TERMINAL_LABELS.other);
}

export function taskStatusLabel(status) {
	return label(TASK_STATUS_LABELS, status, String(status ?? "-"));
}

export function goalStatusLabel(status) {
	return label(GOAL_STATUS_LABELS, status, String(status ?? "-"));
}
