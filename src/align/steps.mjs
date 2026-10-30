import { truncate } from "../util/text.mjs";

/** Review / verification / rewrite spawns: the "another round of checking" half of a non-converging loop. */
export const REVIEW = /review|verify|audit|re-?check|re-?write|리뷰|검토|재작성|검증/i;

/** Designed review subagents: their spawns are the workflow, not evidence that a session is cycling. */
export const REVIEW_AGENTS = new Set(["plan-reviewer", "plan-consultant", "omo-native-code-reviewer", "omo-native-gate-reviewer"]);

// Steps that do work (they carry an intent line) versus todo transitions, which mark progress.
const WORK = new Set(["eval", "task", "goal"]);
const TRANSITIONS = new Set(["start", "done", "reopen"]);

/** "Run land_stage23.py --check" and "Run land_stage24.py --check" are the same step: digits and punctuation fold away. */
const normalize = (text) => String(text).toLowerCase().replace(/\d+/g, "#").replace(/[^\p{L}\p{N}#]+/gu, " ").trim().slice(0, 80);
const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;
const quote = (text) => `'${truncate(String(text), 60)}'`;

/**
 * The trailing steps that form one continuous run of work: it ends at the newest work step, never reaches across a
 * gap longer than `idleGapMs` (a usage-limit wait or a night is not active time), and spans at most `spanMs`.
 * Progress steps (a child completion, a monitor notification) never extend the run; they only sit inside it.
 */
export function activeRun(steps, idleGapMs, spanMs) {
	const work = steps.filter((step) => step.kind !== "progress");
	if (!work.length) return [];
	const end = work.at(-1).ms;
	let start = work.length - 1;
	while (start > 0 && work[start].ms - work[start - 1].ms <= idleGapMs && end - work[start - 1].ms <= spanMs) start--;
	const from = work[start].ms;
	return steps.filter((step) => step.ms >= from && step.ms <= end);
}

/** Review spawns since the run's last todo transition; null when the run holds no transition, so the caller falls back. */
export function reviewsSinceProgress(run) {
	const last = run.findLastIndex((step) => TRANSITIONS.has(step.kind));
	if (last < 0) return null;
	return run.slice(last + 1).filter((step) => step.kind === "task" && !REVIEW_AGENTS.has(step.agent) && REVIEW.test(step.text)).length;
}

/**
 * The todo the todo tool moved to in_progress by itself when a `done` finished the previous one (no `start` call):
 * the result lists it as "- <task> [in_progress] (<phase>)". The tree part of the result marks it "(in progress)"
 * without brackets, so only this line matches.
 */
export function promotedTodo(resultText) {
	return String(resultText ?? "").match(/^\s*- (.+?) \[in_progress\](?: \([^()\r\n]*\))?\s*$/m)?.[1].trim() || undefined;
}

/** The latest todo that was started (or reopened) and not finished since. */
function openTodo(steps) {
	const finished = new Set();
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step.kind === "done") finished.add(step.text);
		else if ((step.kind === "start" || step.kind === "reopen") && !finished.has(step.text)) return step;
	}
	return undefined;
}

/** The text of the latest todo started and not finished, or null (finding data). */
export function openTodoText(steps) {
	return openTodo(steps)?.text ?? null;
}

/** "'A' x5, 'B' x4": the summaries that repeat most, so the nudge can show what the cycle is made of. */
function topRepeats(steps) {
	const groups = new Map();
	for (const step of steps) {
		const key = normalize(step.text);
		const group = groups.get(key) ?? { text: step.text, count: 0 };
		group.count++;
		groups.set(key, group);
	}
	return [...groups.values()].filter((group) => group.count > 1).sort((a, b) => b.count - a.count).slice(0, 2).map((group) => `${quote(group.text)} x${group.count}`).join(", ");
}

/**
 * Non-convergence evidence from one session's step ledger, or undefined. Only the newest run of work counts and
 * only while it is still going (a session that has been quiet for `idleGapMs` has nothing left to reconsider).
 * Age or call counts never fire on their own: each signal needs a todo that does not move or steps that repeat.
 * A progress marker (child completion, monitor notification, DAG run activity) resets the stuck window; it is not a
 * work step, does not extend the run, and does not reset review-loop counting.
 * @param {number[]} [progressTimes] DAG run last-progress times from world.workOf(session).runs
 * @returns {{ signal: "stuck" | "reopened" | "repeat", metric: number, evidence: string } | undefined}
 */
export function stepSignal(steps, now, cfg, progressTimes = []) {
	const last = steps.findLast((step) => step.kind !== "progress");
	if (!last || now - last.ms > cfg.idleGapMs) return undefined;
	const run = activeRun(steps, cfg.idleGapMs, cfg.churnWindowMs);
	if (!run.length) return undefined;
	const work = run.filter((step) => WORK.has(step.kind));
	const done = run.filter((step) => step.kind === "done");
	const progressSteps = run.filter((step) => step.kind === "progress");
	const lastProgressMs = [
		...progressSteps.map((step) => step.ms),
		...progressTimes.filter(Number.isFinite),
	].reduce((max, ms) => Math.max(max, ms), -Infinity);
	const progressInRun = lastProgressMs >= run[0].ms;
	const open = openTodo(steps);
	if (open) {
		const since = Math.max(open.ms, run[0].ms, lastProgressMs);
		const onTodo = work.filter((step) => step.ms >= since);
		const distinct = new Set(onTodo.map((step) => normalize(step.text))).size;
		// The same todo for many steps whose summaries come around again (fix -> rerun -> review), over real active time.
		if (onTodo.length >= cfg.stuckSteps && last.ms - since >= cfg.stuckActiveMs && distinct * 3 <= onTodo.length * 2) {
			return { signal: "stuck", metric: onTodo.length, evidence: `${onTodo.length} steps on ${quote(open.text)} since ${hhmm(since)}, most repeated: ${topRepeats(onTodo)}` };
		}
		// No todo finished and no progress marker across a long stretch of work while one stays open.
		if (!done.length && !progressInRun && work.length >= cfg.noDoneSteps && last.ms - run[0].ms >= cfg.stuckActiveMs) {
			return { signal: "stuck", metric: work.length, evidence: `${work.length} steps without a finished todo since ${hhmm(run[0].ms)} (open: ${quote(open.text)})` };
		}
	}
	const reopened = run.filter((step) => step.kind === "reopen");
	if (reopened.length) {
		return { signal: "reopened", metric: reopened.length, evidence: `${quote(reopened.at(-1).text)} was reopened after it was done (${reopened.length}x since ${hhmm(reopened[0].ms)})` };
	}
	const groups = new Map();
	for (const step of work) {
		const key = normalize(step.text);
		if (!key) continue;
		const group = groups.get(key) ?? { first: step, count: 0 };
		group.count++;
		groups.set(key, group);
	}
	let best;
	for (const group of groups.values()) if (!best || group.count > best.count) best = group;
	// A finished todo or a progress marker after the first occurrence explains a repeated step.
	if (best && best.count >= cfg.repeatSteps && !done.some((step) => step.ms > best.first.ms)
		&& !progressSteps.some((step) => step.ms > best.first.ms) && !progressTimes.some((ms) => ms > best.first.ms)) {
		return { signal: "repeat", metric: best.count, evidence: `${quote(best.first.text)} repeated ${best.count}x since ${hhmm(best.first.ms)} with no todo finished` };
	}
	return undefined;
}
