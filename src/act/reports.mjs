import path from "node:path";
import { atomicWriteFile } from "../util/fsx.mjs";
import { redact } from "../util/text.mjs";
import { iso, kst } from "../util/time.mjs";

/** Stable section headings (machine anchors; the text under them is prose). */
export const REPORT_SECTIONS = ["## 무슨 일이 있었나", "## 왜 그렇게 판단했나", "## 무엇을 했나", "## 결과", "## 사용자가 할 일"];

export function reportPathFor(paths, finding, firstSeenMs) {
	const stamp = iso(firstSeenMs);
	const day = stamp.slice(0, 10);
	const hms = stamp.slice(11, 19).replace(/:/g, "");
	return path.join(paths.health.reportsDir, day, `${hms}-${finding.detector}-${finding.fp.slice(0, 8)}.md`);
}

function userTodo(finding, record) {
	if (finding.data?.userTodoKo) return finding.data.userTodoKo;
	if (finding.humanNeeded) return "위 내용을 확인하고 직접 조치하세요. 이 항목은 자동으로 해결할 수 없습니다.";
	const acted = (record.history ?? []).some((h) => h.status === "execute");
	if (acted) return "없음. 자동으로 처리했습니다. 같은 문제가 반복되면 해당 세션의 지시나 명령 방식을 점검하세요.";
	if (finding.data?.killCommand) return `필요하면 다음 명령으로 정리하세요: \`${finding.data.killCommand}\``;
	return "없음. 기록용 관찰입니다.";
}

/**
 * Render (or re-render) the Korean incident report for one finding.
 * record.history: [{atMs, kind, status, detail}]; record.resolvedMs; record.analyst.verdict (the latest analyst look).
 */
export function renderReport(finding, record, now) {
	const lines = [];
	lines.push(`# ${finding.titleKo ?? `${finding.detector} ${finding.kind}`}`);
	lines.push("");
	lines.push(`- 처음 감지: ${kst(record.firstSeenMs)} (${iso(record.firstSeenMs)})`);
	lines.push(`- 마지막 갱신: ${kst(now)}`);
	const s = finding.subject ?? {};
	const subject = [s.taskId && `task ${s.taskId}`, s.sessionId && `session ${s.sessionId}`, s.parentSessionId && `parent ${s.parentSessionId}`, s.toolCallId && `toolCall ${s.toolCallId}`].filter(Boolean).join(", ");
	if (subject) lines.push(`- 대상: ${subject}`);
	lines.push(`- 심각도: ${finding.severity}, 사람 조치 필요: ${finding.humanNeeded ? "예" : "아니오"}`);
	lines.push(`- 사건 ID: ${finding.fp}`);
	lines.push("");
	lines.push(REPORT_SECTIONS[0]);
	lines.push(finding.detailKo ?? "(설명 없음)");
	lines.push("");
	lines.push(REPORT_SECTIONS[1]);
	lines.push(`- 탐지기 ${finding.detector}, 종류 ${finding.kind}${finding.cls ? `, 분류 ${finding.cls}` : ""}`);
	const rule = finding.data?.classification?.rule;
	if (rule) lines.push(`- 규칙 ${rule.id} v${rule.v}, 신뢰도 ${finding.data.classification.confidence}`);
	if ((finding.evidence ?? []).length) lines.push(`- 근거: ${finding.evidence.join(", ")}`);
	const analyst = record.analyst?.verdict;
	if (analyst) lines.push(analyst.failed || analyst.notReached ? `- 분석가 판정: 없음 (${analyst.reason})` : `- 분석가 판정: ${analyst.assessment ?? analyst.verdict}${analyst.actionId ? ` → ${analyst.actionId}` : ""} (신뢰도 ${analyst.confidence ?? "?"})${analyst.diagnosis ? `\n  - 진단: ${analyst.diagnosis}` : ""}${analyst.advice ? `\n  - 조언: ${analyst.advice}` : ""}`);
	if (finding.data?.call?.commandHead) lines.push("- 명령:", "```bash", finding.data.call.commandHead, "```");
	lines.push("");
	lines.push(REPORT_SECTIONS[2]);
	const history = record.history ?? [];
	if (!history.length) lines.push("- 자동 조치 없음(알림만).");
	for (const h of history) lines.push(`- ${kst(h.atMs)} ${h.kind}: ${h.status}${h.detail ? ` - ${h.detail}` : ""}`);
	lines.push("");
	lines.push(REPORT_SECTIONS[3]);
	if (record.resolvedMs) lines.push(`- ${kst(record.resolvedMs)}에 해소됨${record.resolution ? `: ${record.resolution}` : ""}.`);
	else lines.push(`- 아직 열려 있음 (상태: ${record.state ?? "open"}).`);
	lines.push("");
	lines.push(REPORT_SECTIONS[4]);
	lines.push(userTodo(finding, record));
	lines.push("");
	return redact(lines.join("\n"));
}

export function writeReport(paths, finding, record, now) {
	record.reportPath ??= reportPathFor(paths, finding, record.firstSeenMs ?? now);
	atomicWriteFile(record.reportPath, renderReport(finding, record, now));
	return record.reportPath;
}
