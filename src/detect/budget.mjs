import { makeFinding } from "./finding.mjs";

/**
 * D26 budget: the budget snapshot written by the budget office (IS-2, IS-8).
 *
 * Pure and advisory. It reads only `world.budget` (the snapshot's own `enabled`
 * flag decides), never stops a session, edits a goal or writes anything.
 * Findings:
 *   treasury-short  warn, human needed - a window reaches its reserve by reset
 *   treasury-tight  info               - a window is close to the reserve
 *   audit-opinion   info               - the auditor judged spend waste-likely
 * Nothing needs a human: there is no owner route.
 * An unknown or stale reading emits nothing: the snapshot has no basis yet.
 */
export const id = "D26";

const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : "?");
const hours = (value) => (Number.isFinite(value) ? `${Math.round(value * 10) / 10}시간` : "?");

function windowFinding(window) {
        const account = String(window.account ?? "");
        const windowId = String(window.windowId ?? "");
        if (!account || !windowId) return null;
        const resetsAtMs = Number.isFinite(window.resetsAtMs) ? window.resetsAtMs : "none";
        const subject = { key: `budget:${window.state}:${account}:${windowId}:${resetsAtMs}` };
        const evidence = [
                `window:${account}:${windowId}`,
                `state:${window.state}`,
                `usedPercent:${window.usedPercent ?? "?"}`,
                `freePercent:${window.freePercent ?? "?"}`,
                `projectedAtResetPercent:${window.projectedAtResetPercent ?? "?"}`,
                `resetsAt:${resetsAtMs}`,
        ];
        const label = window.label || windowId;
        const data = {
                treasury: {
                        account,
                        windowId,
                        label,
                        scope: window.scope ?? null,
                        usedPercent: window.usedPercent ?? null,
                        resetsAtMs: Number.isFinite(window.resetsAtMs) ? window.resetsAtMs : null,
                        hoursLeft: window.hoursLeft ?? null,
                        reservePercent: window.reservePercent ?? null,
                        freePercent: window.freePercent ?? null,
                        burnPerHour: window.burnPerHour ?? null,
                        projectedAtResetPercent: window.projectedAtResetPercent ?? null,
                        safeDailyPercent: window.safeDailyPercent ?? null,
                        state: window.state,
                        stale: window.stale === true,
                        calibrated: window.calibrated === true,
                },
        };
        if (window.state === "short") {
                return makeFinding({
                        detector: id,
                        kind: "treasury-short",
                        severity: "warn",
                        humanNeeded: true,
                        subject,
                        evidence,
                        titleKo: `예산 부족: ${label} ${pct(window.usedPercent)} 사용, 남은 ${hours(window.hoursLeft)}`,
                        detailKo: `계정 ${account}의 ${label} 한도는 리셋 시점에 ${pct(window.projectedAtResetPercent)}까지 오를 것으로 보입니다(현재 ${pct(window.usedPercent)}, 여유 ${pct(window.freePercent)}). 이번 주 작업을 줄이거나 다음 주기로 미루세요.`,
                        data,
                });
        }
        if (window.state === "tight") {
                return makeFinding({
                        detector: id,
                        kind: "treasury-tight",
                        severity: "info",
                        subject,
                        evidence,
                        titleKo: `예산 주의: ${label} ${pct(window.usedPercent)} 사용, 여유 ${pct(window.freePercent)}`,
                        detailKo: `계정 ${account}의 ${label} 한도는 리셋 시점에 ${pct(window.projectedAtResetPercent)}까지 오를 것으로 보입니다(현재 ${pct(window.usedPercent)}, 남은 ${hours(window.hoursLeft)}). 지금 속도대로면 여유가 줄어듭니다.`,
                        data,
                });
        }
        return null;
}

function auditFinding(audit) {
        if (audit.assessment !== "waste-likely") return null;
        const auditId = String(audit.auditId ?? "");
        if (!auditId) return null;
        const projectId = String(audit.projectId ?? "");
        const findings = Array.isArray(audit.findings) ? audit.findings : [];
        return makeFinding({
                detector: id,
                kind: "audit-opinion",
                severity: "info",
                subject: { key: `budget:audit:${auditId}` },
                evidence: [
                        `audit:${auditId}`,
                        `project:${projectId}`,
                        `assessment:${audit.assessment}`,
                        `confidence:${audit.confidence ?? "?"}`,
                        ...findings.slice(0, 5).map((finding) => `pattern:${finding.pattern ?? "other"}`),
                ],
                titleKo: `예산 감사 의견: 낭비 가능성 (${projectId})`,
                detailKo: `프로젝트 ${projectId}의 지출 감사 결과가 '낭비 가능성'입니다(신뢰도 ${audit.confidence ?? "?"}, 지적 ${findings.length}개). 의견은 조언이며 지시가 아닙니다. 자세한 내용은 대시보드 예산 탭에서 확인하세요.`,
                data: {
                        auditId,
                        projectId,
                        assessment: audit.assessment,
                        confidence: audit.confidence ?? null,
                        advice: audit.advice ?? null,
                },
        });
}

export function detect(world) {
        const budget = world?.budget;
        if (!budget || budget.enabled === false) return [];
        const out = [];
        for (const window of budget.treasury?.windows ?? []) {
                const finding = windowFinding(window ?? {});
                if (finding) out.push(finding);
        }
        for (const audit of budget.audits ?? []) {
                const finding = auditFinding(audit ?? {});
                if (finding) out.push(finding);
        }
        return out;
}
