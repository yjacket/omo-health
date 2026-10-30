import { makeFinding, RECENT_EVIDENCE_MS } from "./finding.mjs";

/** D10: repeated identical tool calls and error storms inside one session (IS-11). */
export const id = "D10";

const ERROR_HEAD_CHARS = 80;

/** Largest number of timestamps (sorted) that fit in one window; returns {count, startMs, endMs}. */
function densest(msList, windowMs) {
	let best = { count: 0 };
	let j = 0;
	for (let i = 0; i < msList.length; i += 1) {
		while (msList[i] - msList[j] > windowMs) j += 1;
		const count = i - j + 1;
		if (count >= best.count) best = { count, startMs: msList[j], endMs: msList[i] };
	}
	return best;
}

function sameCallLoops(session, cfg) {
	const history = session.toolHistory ?? [];
	const byKey = new Map();
	let run = [];
	const flush = () => {
		if (run.length < cfg.sameCallCount) return;
		const hit = densest(
			run.map((item) => item.ms ?? 0),
			cfg.sameCallWindowMs,
		);
		if (hit.count >= cfg.sameCallCount) byKey.set(`${run[0].name}:${run[0].argsHash}`, { first: run[0], runLength: run.length, ...hit });
	};
	for (const item of history) {
		const prev = run.at(-1);
		if (prev && prev.name === item.name && prev.argsHash === item.argsHash) run.push(item);
		else {
			flush();
			run = [item];
		}
	}
	flush();
	const out = [];
	for (const hit of byKey.values()) {
		const { name, argsHash } = hit.first;
		out.push(
			makeFinding({
				detector: id,
				kind: "same-call-loop",
				subject: { sessionId: session.id, taskId: session.taskId, key: `call:${name}:${String(argsHash).slice(0, 12)}` },
				evidence: [`tool:${name}`, `argsHash:${argsHash}`, `count:${hit.count}`],
				titleKo: `도구 반복 루프: ${name}를 같은 인자로 ${hit.count}회 연속 호출`,
				detailKo: `세션 ${session.id}가 ${name} 도구를 같은 인자로 ${Math.round((hit.endMs - hit.startMs) / 1000)}초 동안 ${hit.count}회 연속 호출했습니다(연속 ${hit.runLength}회). 같은 결과를 반복해서 받고 있을 가능성이 큽니다.`,
				data: { tool: name, argsHash, count: hit.count, runLength: hit.runLength, startMs: hit.startMs, endMs: hit.endMs, spanMs: hit.endMs - hit.startMs },
			}),
		);
	}
	return out;
}

function errorStorms(session, cfg) {
	const groups = new Map();
	const add = (text, ms, source) => {
		const head = String(text ?? "").trim().slice(0, ERROR_HEAD_CHARS);
		if (!head || !Number.isFinite(ms)) return;
		if (!groups.has(head)) groups.set(head, { ms: [], sources: new Set() });
		const group = groups.get(head);
		group.ms.push(ms);
		group.sources.add(source);
	};
	for (const error of session.errors ?? []) add(error.text, error.ms, "assistant");
	for (const item of session.toolHistory ?? []) if (item.isError && item.errHead) add(item.errHead, item.ms, `tool:${item.name}`);
	const out = [];
	for (const [head, group] of groups) {
		const hit = densest(
			group.ms.sort((a, b) => a - b),
			cfg.errorStormWindowMs,
		);
		if (hit.count < cfg.errorStormCount) continue;
		out.push(
			makeFinding({
				detector: id,
				kind: "error-storm",
				subject: { sessionId: session.id, taskId: session.taskId, key: `err:${head}` },
				evidence: [`error:${head}`, `count:${hit.count}`],
				titleKo: `오류 폭풍: 같은 오류 ${hit.count}회 반복`,
				detailKo: `세션 ${session.id}에서 같은 오류가 ${Math.round((hit.endMs - hit.startMs) / 1000)}초 안에 ${hit.count}회 발생했습니다. 오류 첫머리: "${head}"`,
				data: { errorHead: head, count: hit.count, total: group.ms.length, sources: [...group.sources], startMs: hit.startMs, endMs: hit.endMs },
			}),
		);
	}
	return out;
}

export function detect(world) {
	const cfg = world.config.loops;
	const out = [];
	for (const session of world.sessions.values()) out.push(...sameCallLoops(session, cfg), ...errorStorms(session, cfg));
	// Only incidents whose last occurrence is recent; old history is not news (engine drops stale atMs).
	for (const finding of out) finding.data.atMs = finding.data.endMs;
	return out.filter((finding) => world.now - finding.data.endMs <= RECENT_EVIDENCE_MS);
}
