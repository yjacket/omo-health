import { actionLabel, findingLabel, resultLabel } from "./labels.mjs";

/** The 7-day decision-log history of the local dashboard: pure functions, no I/O. */

const DAY = 24 * 3600_000;
const KST = 9 * 3600_000;
const FINDING_EVENTS = new Set(["opened", "reopened", "resolved"]);
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (v) => (typeof v === "string" && v ? v.slice(0, 80) : "unknown");
const short = (id) => (typeof id === "string" ? id.slice(0, 8) : null);
const detail = (parts) => parts.filter(Boolean).join("; ").slice(0, 200);

/** Start of the 7-day window: KST midnight six days before today's. */
export function historyStart(now) {
	return Math.floor((now + KST) / DAY) * DAY - KST - 6 * DAY;
}

function dayOf(startMs) {
	const kstDate = new Date(startMs + KST);
	return { iso: kstDate.toISOString().slice(0, 10), label: `${kstDate.getUTCMonth() + 1}/${kstDate.getUTCDate()} (${WEEKDAYS[kstDate.getUTCDay()]})`, opened: 0, actions: 0 };
}

function rowIn(map, key) {
	let row = map.get(key);
	if (!row) {
		row = { key, total: 0, opened: 0, resolved: 0, lastMs: 0, perDay: Array(7).fill(0), samples: [], results: new Map() };
		map.set(key, row);
	}
	return row;
}

function countResults(row, result) {
	const key = clip(typeof result === "string" ? result : undefined);
	row.total++;
	row.results.set(key, (row.results.get(key) ?? 0) + 1);
}

function actionDetail(entry) {
	const o = isRecord(entry.outcome) ? entry.outcome : {};
	const pids = (list) => (Array.isArray(list) && list.length ? list.map((p) => p?.pid ?? p).join(",") : null);
	return detail([pids(o.killed) && `killed ${pids(o.killed)}`, pids(o.survived) && `survived ${pids(o.survived)}`, o.delivered !== undefined && `delivered ${o.delivered}`, o.via && `via ${o.via}`, o.error && `error ${o.error}`, entry.rule && `rule ${isRecord(entry.rule) ? entry.rule.id : entry.rule}`]);
}

function sampleOf(entry, ts, kind) {
	const subject = isRecord(entry.subject) ? entry.subject : {};
	const base = { ts, sessionShort: short(subject.sessionId ?? entry.outcome?.sessionId), taskId: subject.taskId ?? null };
	switch (kind) {
		case "finding":
			return { ...base, detail: detail(Array.isArray(entry.evidence) ? [entry.evidence.join(" ")] : []) };
		case "action":
			return { ...base, detail: actionDetail(entry) };
	}
}

const byCountThenRecent = (a, b) => b.count - a.count || b.lastMs - a.lastMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function finishRow(row, labelResult = resultLabel) {
	const all = [...row.results].map(([result, count]) => ({ result, resultKo: labelResult(result), count })).sort((a, b) => b.count - a.count || (a.result < b.result ? -1 : 1));
	const results = all.slice(0, 20);
	const otherCount = all.slice(20).reduce((sum, r) => sum + r.count, 0);
	return { key: row.key, total: row.total, results, otherCount, lastMs: row.lastMs, perDay: row.perDay, samples: row.samples.slice(-5).reverse(), count: row.total };
}

const strip = ({ count, ...row }) => row;

/** Group the decision log into the 7-day KST window: findings, actions, config changes, other events. */
export function buildHistory(decisions, now) {
	if (!Array.isArray(decisions)) throw new Error(decisions?.error ?? "decision log unavailable");
	const fromMs = historyStart(now);
	const toMs = fromMs + 7 * DAY;
	const skipped = { malformed: 0, outOfWindow: 0 };
	const items = [];
	for (const entry of decisions) {
		const ts = isRecord(entry) && typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
		if (!Number.isFinite(ts)) skipped.malformed++;
		else if (ts < fromMs || ts >= toMs) skipped.outOfWindow++;
		else items.push({ ts, entry });
	}
	items.sort((a, b) => a.ts - b.ts);
	const days = Array.from({ length: 7 }, (_, i) => dayOf(fromMs + i * DAY));
	const findings = new Map();
	const actions = new Map();
	const other = new Map();
	const configChanges = [];
	for (const { ts, entry } of items) {
		const i = Math.floor((ts - fromMs) / DAY);
		if (isRecord(entry.action)) {
			const row = rowIn(actions, clip(entry.action.kind));
			countResults(row, entry.result);
			row.lastMs = ts;
			row.perDay[i]++;
			days[i].actions++;
			row.samples.push(sampleOf(entry, ts, "action"));
		} else if (FINDING_EVENTS.has(entry.event)) {
			const [detector, kind] = [clip(entry.detector), clip(entry.kind)];
			const row = rowIn(findings, `${detector}/${kind}`);
			Object.assign(row, { detector, kind, lastMs: ts });
			if (entry.event === "resolved") row.resolved++;
			else {
				row.opened++;
				row.perDay[i]++;
				days[i].opened++;
				row.samples.push(sampleOf(entry, ts, "finding"));
			}
		} else if (entry.event === "config") {
			configChanges.push({ ts, result: entry.result ?? null, resultKo: resultLabel(entry.result), changed: Array.isArray(entry.changed) ? entry.changed : [], message: entry.message ?? null });
		} else {
			const key = clip(entry.event);
			other.set(key, (other.get(key) ?? 0) + 1);
		}
	}
	const findingRows = [...findings.values()]
		.map((row) => ({ key: row.key, detector: row.detector, kind: row.kind, labelKo: findingLabel(row.detector, row.kind), opened: row.opened, resolved: row.resolved, lastMs: row.lastMs, perDay: row.perDay, samples: row.samples.slice(-5).reverse(), count: row.opened }))
		.sort(byCountThenRecent)
		.map(strip);
	const actionRows = [...actions.values()].map((row) => finishRow(row)).sort(byCountThenRecent).map((row) => strip({ ...row, kind: row.key, labelKo: actionLabel(row.key) }));
	const otherTotal = [...other.values()].reduce((sum, n) => sum + n, 0) + skipped.malformed;
	return { fromMs, toMs, readMs: null, total: items.length, other: { total: otherTotal, events: Object.fromEntries(other), malformed: skipped.malformed }, skipped, days, findings: findingRows, actions: actionRows, configChanges: configChanges.reverse().slice(0, 20) };
}
