import { activeRun, openTodoText, REVIEW, REVIEW_AGENTS, reviewsSinceProgress, stepSignal } from "../align/steps.mjs";
import { sha1, truncate } from "../util/text.mjs";
import { makeFinding } from "./finding.mjs";

export const id = "D15";
const DAY = 24 * 3600_000;
const ASK_END = /(냐|니|나요|까요|는지|을까|ㄹ까|인가|야)\s*\??\s*$/;
const ASK_START = /^(왜|뭐|무엇|어떻게|어디|언제|설명|알려)/;
const COMMAND = /(해라|해줘|하라|하자|진행|구현|수정|고쳐|만들|추가|삭제|제거|등록|설치|적용|바꿔|반영|\bdo\b|\bfix\b|implement|\badd\b|remove|change|create|update)/i;
const IMPERATIVE_END = /(해|줘|라|자)\s*[.!]?$/;
const ACTION = /(커밋|푸시|구성|배포|정리해)/;
const SUGGESTION = /(해야|써야|봐야|넣어야|붙여야)\s*(하는|되는)?\s*(거|것)?\s*(아닌가|않나|아니야)/;

// omo-health's own notes (scope checks, stall corrections a parent forwards) arrive as user text but are not the user's request.
const OWN_NOTE = /^\s*\[?omo-health\b/i;

// Turns the host or an extension wrote in the user's place (goal continuations, task results, desk notes), for sensors that predate humanInputs.
const AUTO_TURN = /^\s*(\[?omo-health\b|Continue working toward the active thread goal|<omo-senpi-task>|\[omo-desk\]|task completion|<system-reminder>)/i;
const MATCH_MS = 2000;
const QUESTION = "Is this session still converging on its goal and the latest human request, or is it stuck in rounds that do not converge, or doing work nobody asked for? progressing = it is on track, leave it alone; stuck = it drifted: mechanism = what it keeps repeating and why that does not converge; avoid = the concrete next step it should take instead. Answer with verdict stuck or progressing and cause unknown unless one of the listed causes fits; mechanism and avoid must each be at least 20 characters.";

/** A user turn the operator actually wrote, by the same rule the request lookup uses. */
function isHumanTurn(turn, humanInputs) {
	const text = String(turn?.text ?? "");
	if (!text.trim() || OWN_NOTE.test(text)) return false;
	return Array.isArray(humanInputs)
		? humanInputs.some((t) => Math.abs(t - turn.ms) <= MATCH_MS)
		: !AUTO_TURN.test(text);
}

/**
 * The user's latest request and the turn time it came from. With `humanInputs` (sensor heartbeat timestamps of
 * operator input) it is the newest turn within 2 s of one of them, and `{ text: "", ms: null }` when none is;
 * without them the newest turn that has text and does not start with an automatic-continuation marker.
 */
export function latestTurn(session, humanInputs) {
	const turns = session.userTurns ?? [];
	for (let i = turns.length - 1; i >= 0; i--) {
		if (!isHumanTurn(turns[i], humanInputs)) continue;
		return { text: turns[i].text, ms: Number.isFinite(turns[i].ms) ? turns[i].ms : null };
	}
	if (Array.isArray(humanInputs)) return { text: "", ms: null };
	const head = String(session.lastUser?.textHead ?? "");
	if (!head.trim() || AUTO_TURN.test(head)) return { text: "", ms: null };
	return { text: head, ms: Number.isFinite(session.lastUser?.ms) ? session.lastUser.ms : null };
}

/** The user's latest request text (callers that only need the quote). */
export function latestRequest(session, humanInputs) {
	return latestTurn(session, humanInputs).text;
}

/** The last three texts the operator wrote, oldest first. */
function humanRequests(session, humanInputs) {
	return (session.userTurns ?? []).filter((turn) => isHumanTurn(turn, humanInputs)).slice(-3).map((turn) => String(turn.text));
}

export function isInformationAsk(text) {
	// Code spans hold shell syntax such as `$?`, not questions.
	const value = String(text ?? "").replace(/`[^`]*(?:`|$)/g, " ").trim();
	const question = value.includes("?") || ASK_END.test(value) || ASK_START.test(value);
	// A question that also asks for work is a request, not an information ask: one sentence is enough.
	const request = value.split(/(?<=[?!.。])\s+|\n+/).some((sentence) => {
		const line = sentence.trim();
		return COMMAND.test(line) || IMPERATIVE_END.test(line) || ACTION.test(line) || SUGGESTION.test(line);
	});
	return question && !request;
}

function signals(session, now, cfg, humanInputs, progressTimes) {
	const activity = session.activity ?? {};
	const files = activity.files instanceof Map ? activity.files.values() : Object.values(activity.files ?? {});
	let churn = 0;
	for (const file of files) {
		if (file.rounds >= cfg.churnEdits && file.failsBetween >= 2 && file.firstMs >= (activity.sinceMs ?? -Infinity) && file.lastMs - file.firstMs <= cfg.churnWindowMs) churn = Math.max(churn, file.rounds);
	}
	const checks = activity.failingChecks instanceof Map ? activity.failingChecks.values() : Object.values(activity.failingChecks ?? {});
	// Failures of one check count only inside the churn window: hours of normal fixing never add up to churn.
	if (activity.failTimes instanceof Map) {
		for (const times of activity.failTimes.values()) {
			const recent = times.filter((t) => now - t <= cfg.churnWindowMs).length;
			if (recent >= cfg.failRepeats) churn = Math.max(churn, recent);
		}
	} else for (const count of checks) if (count >= cfg.failRepeats) churn = Math.max(churn, count);
	// A review per finished todo is normal: with a step ledger only the spawns after the last todo transition count.
	const steps = session.steps ?? [];
	const reviews = reviewsSinceProgress(activeRun(steps, cfg.idleGapMs, cfg.churnWindowMs)) ?? (activity.taskSpawns ?? []).filter((spawn) => !REVIEW_AGENTS.has(spawn.agent) && REVIEW.test(spawn.summary ?? "")).length;
	if (reviews >= cfg.reviewLoops) churn = Math.max(churn, reviews);
	const out = [];
	if (churn) out.push({ signal: "churn", metric: churn });
	const lastText = latestRequest(session, humanInputs);
	// Mutations after a goal continuation or another automatic wake follow that, not the question.
	const answering = activity.mutationsBeforeAuto ?? activity.mutations;
	if (isInformationAsk(lastText) && answering >= 1) out.push({ signal: "overstep", metric: answering, request: lastText });
	// Age and tool-call counts say nothing about a long goal that keeps finishing todos; only the ledger's evidence does.
	const evidence = stepSignal(steps, now, cfg, progressTimes);
	if (evidence) out.push(evidence);
	const goal = session.anchor;
	if (goal?.status === "complete" && Number.isFinite(goal.updatedAtMs) && (session.lastUser?.ms ?? activity.sinceMs ?? -Infinity) <= goal.updatedAtMs) {
		// The aggregate is exact if this user turn started after completion. Otherwise
		// only timestamped writes provide evidence that the mutation followed completion.
		const writes = (session.writes ?? []).filter((write) => write.ms > goal.updatedAtMs);
		const writeIds = new Set(writes.map((write) => write.id));
		const shellWrites = (session.commands ?? []).filter((call) => call.ms > goal.updatedAtMs && !writeIds.has(call.id) &&
			(/(^|[^0-9&=-])>>?(?!&)/.test(call.text) || /\b(rm|mv|cp|del|mkdir|rmdir|git\s+(commit|push|reset|checkout|merge|rebase|stash)|npm\s+(install|i)\b|pnpm\s+add|pip\s+install|Set-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item)\b/i.test(call.text) ||
			(call.tool === "eval" && /writeFile|appendFile|unlink|rmSync|mkdirSync|renameSync|Bun\.write|open\(.*['"]w/.test(call.text))));
		const mutations = activity.sinceMs >= goal.updatedAtMs ? activity.mutations : new Set([...writes.map((write) => write.id), ...shellWrites.map((call) => call.id)]).size;
		if (mutations >= cfg.afterCompleteMutations) out.push({ signal: "after-complete", metric: mutations });
	}
	return out;
}

export function detect(world, memory = {}) {
	const cfg = world.config.align;
	if (!cfg?.enabled) return [];
	const findings = [];
	// The budget belongs to whoever receives the note: a child's note goes to its parent, so all children of a
	// parent (and the parent itself) draw on one budget instead of one each.
	const targetOf = (session) => (session.kind === "child" ? session.parentSessionId ?? session.id : session.id);
	const pools = new Map();
	for (const session of world.sessions.values()) {
		const target = targetOf(session);
		const pool = pools.get(target) ?? [...(memory[target] ?? [])];
		// A delivered message is also in the session transcript; keep it as evidence
		// when a daemon restart precedes the next state snapshot.
		for (const m of session.healthMessages ?? []) if (m.details?.kind === "scope-check") pool.push({ ms: m.ms, key: m.details.key });
		pools.set(target, pool);
	}
	const histories = new Map([...pools].map(([target, pool]) => [target, pool.filter((e) => Number.isFinite(e.ms) && e.ms <= world.now && world.now - e.ms < DAY)]));
	// One note per target per tick: children of one parent share the budget, but an undelivered note spends nothing.
	const emitted = new Set();
	const today = new Date(world.now).toISOString().slice(0, 10);
	for (const session of world.sessions.values()) {
		const sid = session.id;
		const target = targetOf(session);
		// A finished subagent has nothing left to reconsider; its note would only revive it through the parent.
		if (session.kind === "child" && (session.task?.terminal || session.task?.active === false)) continue;
		// A store can carry active records whose host died or was reused; their transcripts are backlog, not current work.
		if (session.kind === "child" && !world.isSessionLive(session)) continue;
		const history = histories.get(target);
		const humanInputs = world.sensorFor?.(sid)?.humanInputs;
		const progressTimes = (world.workOf?.(session)?.runs ?? []).map((run) => run.lastProgressMs).filter(Number.isFinite);
		const turn = latestTurn(session, humanInputs);
		for (const { signal, metric, evidence, request } of signals(session, world.now, cfg, humanInputs, progressTimes)) {
			if (emitted.has(target)) break;
			// An overstep belongs to one owner request; growth in mutations is the same request, not a new incident.
			const key = signal === "overstep"
				? `align:${sid}:overstep:${sha1(request).slice(0, 12)}`
				: `align:${sid}:${signal}:${Math.floor(Math.log2(metric))}`;
			if (history.some((e) => e.key === key) || history.filter((e) => new Date(e.ms).toISOString().slice(0, 10) === today).length >= cfg.perDay || history.some((e) => world.now - e.ms < cfg.minGapMs)) continue;
			const finding = makeFinding({
				detector: id, kind: "drift", severity: "info", cls: signal,
				subject: { sessionId: sid, taskId: session.taskId, parentSessionId: session.parentSessionId, key },
				titleKo: `작업 범위 점검: ${signal}`,
				detailKo: `원래 요청과 현재 작업 범위를 다시 확인하세요.${evidence ? `\n근거: ${evidence}` : ""}`,
				data: {
					signal, metric, evidence,
					goal: truncate(session.anchor?.objective ?? session.firstUserText ?? "", 300),
					lastUserText: turn.text ? truncate(turn.text, 300) : null,
					lastUserMs: turn.ms,
					question: QUESTION,
					ledger: {
						steps: (session.steps ?? []).slice(-30).map(({ ms, kind, tool, text }) => ({ ms, kind, tool, text })),
						openTodo: openTodoText(session.steps ?? []),
						requests: humanRequests(session, humanInputs),
					},
					remedy: { kind: "scope-check" },
				},
			});
			findings.push(finding);
			emitted.add(target);
		}
	}
	for (const [target, history] of histories) memory[target] = history.filter((e, i) => history.findIndex((other) => other.key === e.key && other.ms === e.ms) === i);
	// Notes older than a day, and budgets an older version kept per subject, are not evidence any more.
	for (const key of Object.keys(memory)) {
		if (histories.has(key)) continue;
		memory[key] = (memory[key] ?? []).filter((e) => Number.isFinite(e.ms) && e.ms <= world.now && world.now - e.ms < DAY);
		if (!memory[key].length) delete memory[key];
	}
	return findings;
}
