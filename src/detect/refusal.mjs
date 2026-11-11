import { makeFinding } from "./finding.mjs";

/**
 * D24 refusal-orphan (issue #10): a goal session stopped by a provider policy refusal.
 *
 * On the claude-sdk-oauth lane a refusal (`Claude refused this request (...)`; OpenAI: `flagged for possible
 * cybersecurity risk`) ends the turn as a terminal error (senpi #1052), but the refused assistant message keeps
 * `stopReason: "toolUse"` and its tool calls never get a result. senpi then blocks the goal and waits for a person.
 * Everything that proves it is in the transcript, so no analyst look is needed:
 *   - the session's last entry is that assistant message (lastMessage), with the refusal text in errorMessage and
 *     stopReason toolUse (lastAssistant);
 *   - calls of that message are still pending (no toolResult);
 *   - its goal is blocked (session.anchor from the goal store);
 *   - its host is not running a turn (sensor idle).
 *
 * The finding is human-needed (one toast at once) and asks for `refusal-resume`: one turn-starting message through the
 * sensor mailbox, behind actions.resume. A goal blocked this way stays blocked after an extension message (senpi
 * goal/direct-input-lifecycle.js ignores source "extension"), so the message only restarts the work for one turn.
 * Memory: resumes (times per session), capped at RESUME_PER_HOUR so a refusal that repeats does not loop.
 */
export const id = "D24";

const REFUSAL = /Claude refused this request|flagged for possible cybersecurity risk/i;
const HOUR_MS = 3600_000;
const RESUME_PER_HOUR = 2;
const SUMMARY_CHARS = 120;

/** The refused message and its calls left without a result, or undefined. */
export function refusalOf(session) {
	const last = session?.lastAssistant;
	if (!last || last.stopReason !== "toolUse" || !REFUSAL.test(String(last.errorMessage ?? ""))) return undefined;
	if (session.lastMessage?.role !== "assistant" || session.lastMessage.ms !== last.ms) return undefined;
	const orphans = [...(session.pending?.values() ?? [])].filter((call) => call.batchId === last.entryId);
	if (!orphans.length) return undefined;
	return { last, orphans };
}

/** One line per orphaned call: tool name and its own summary argument when it has one. */
export function orphanSummary(call) {
	const args = call.args ?? {};
	const text = args.summary ?? args.task_summary ?? args.description ?? (Array.isArray(args.tasks) ? args.tasks.map((t) => t?.task_summary ?? t?.description).filter(Boolean).join("; ") : undefined);
	return { name: String(call.name ?? "?"), summary: typeof text === "string" && text ? text.slice(0, SUMMARY_CHARS) : undefined };
}

export function detect(world, memory = {}) {
	memory.resumes ??= {};
	const out = [];
	for (const session of world.sessions.values()) {
		if (session.kind !== "main") continue;
		if (session.anchor?.source !== "goal" || session.anchor.status !== "blocked") continue;
		const refusal = refusalOf(session);
		if (!refusal) continue;
		const hb = world.sensorFor(session.id);
		if (hb?.idle === false) continue;
		const sid = session.id;
		const resumes = (memory.resumes[sid] ?? []).filter((ms) => world.now - ms < HOUR_MS);
		memory.resumes[sid] = resumes;
		const capped = resumes.length >= RESUME_PER_HOUR;
		const calls = refusal.orphans.map(orphanSummary);
		const callsKo = calls.map((c) => (c.summary ? `${c.name}(${c.summary})` : c.name)).join(", ");
		const errorHead = String(refusal.last.errorMessage).slice(0, 160);
		out.push(
			makeFinding({
				detector: id,
				kind: "refusal-orphan",
				severity: "warn",
				humanNeeded: true,
				subject: { sessionId: sid, key: `refusal:${refusal.last.entryId ?? refusal.last.ms}` },
				evidence: [`stopReason:toolUse`, `orphans:${calls.length}`, `goal:blocked`, `provider:${refusal.last.provider ?? "-"}`],
				titleKo: `정책 거부로 목표 멈춤: ${session.title ?? sid}`,
				detailKo: [
					`세션 ${sid}(${session.cwd ?? "?"})의 마지막 응답이 정책 거부로 끝나 목표가 goal_blocked 상태입니다.`,
					`거부: ${errorHead}`,
					`결과를 받지 못한 도구 호출: ${callsKo}.`,
					capped ? `한 시간 안에 이미 ${RESUME_PER_HOUR}번 다시 시작했으므로 자동으로 다시 시작하지 않습니다. 직접 이어 가세요.` : `같은 호출을 그대로 다시 내지 말고 바꿔 표현해 이어 가라는 메시지로 한 턴을 시작합니다(actions.resume).`,
				].join("\n"),
				data: { refusedMs: refusal.last.ms, errorHead, calls, provider: refusal.last.provider, model: refusal.last.model, ...(capped ? {} : { remedy: { kind: "refusal-resume" } }) },
			}),
		);
	}
	return out;
}
