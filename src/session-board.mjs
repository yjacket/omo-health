import path from "node:path";
import { listDirSafe, readTextSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";
import { toMs } from "./util/time.mjs";
import { workWakeCount } from "./util/wake-sources.mjs";

/**
 * The live session board: one snapshot per tick of every live main session with its subagent tree, health and state
 * (status/_sessions.json), and the records of the sessions that ended since the previous snapshot (sessions/ledger).
 */

const STALE_MS = 45_000;
/** A finished child stays on the board this long, so its end is seen. */
const RECENT_END_MS = 5 * 60_000;
/** A crash record this close to a disappearance names it. */
const CRASH_WINDOW_MS = 2 * 60_000;
const TITLE_MAX = 120;
const RESOLVED_INVESTIGATIONS = new Set(["released", "advised", "noticed", "closed"]);
const SEVERITY_RANK = { info: 1, warn: 2, crit: 3 };
const LEVELS = ["ok", "info", "warn", "crit"];
const ASK_TOOLS = /^(ask_user_question|ask_user|question)$/i;
const ACTIVE_STATUSES = new Set(["running", "queued", "pending", "starting", "spawning"]);
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "interrupted", "lost", "failed", "killed"]);
const FAILED_STATUSES = new Set(["error", "failed"]);
const RELEASE_KINDS = new Set(["kill-pids", "release-shell"]);

const clean = (value, max = TITLE_MAX) => truncate(redact(String(value ?? "")).replace(/\s+/g, " ").trim(), max);
const finite = (value) => (Number.isFinite(value) ? value : null);

function versionKey(version) {
	return String(version).split(/[^0-9]+/).filter(Boolean).map(Number);
}

/** Descending by version, null last. */
function compareVersionsDesc(a, b) {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	const ka = versionKey(a);
	const kb = versionKey(b);
	for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
		const d = (kb[i] ?? 0) - (ka[i] ?? 0);
		if (d) return d;
	}
	return a < b ? 1 : -1;
}

function terminalOf(world, hb, hostPid) {
	const kind = hb?.terminal?.kind;
	if (kind === "orca" || kind === "herdr") return { kind };
	if (!Number.isFinite(hostPid)) return null;
	for (const proc of world.procs?.ancestors?.(hostPid) ?? []) {
		if (/^orca(\.exe)?$/i.test(proc.name ?? "")) return { kind: "orca" };
		if (/^herdr(\.exe)?$/i.test(proc.name ?? "")) return { kind: "herdr" };
	}
	return { kind: "other" };
}

function stateOf(session, hb, nowMs) {
	if (!hb || nowMs - (hb.ts ?? 0) > STALE_MS) return { kind: "stale", sinceMs: finite(hb?.ts), tool: null };
	const pending = [...(session.pending?.values?.() ?? [])].sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
	const ask = pending.find((call) => ASK_TOOLS.test(String(call.name ?? "")));
	if (ask) return { kind: "waiting-user", sinceMs: finite(ask.ms), tool: clean(ask.name, 60) };
	if ((hb.executingTools ?? 0) > 0) {
		const call = pending[0];
		return { kind: "tool", sinceMs: finite(call?.ms), tool: call ? clean(call.name, 60) : null };
	}
	if (hb.idle === false) return { kind: "busy", sinceMs: finite(toMs(hb.lastInputAt)), tool: null };
	const count = workWakeCount(hb.wakeSources);
	if (hb.idle === true && count > 0) return { kind: "waiting", sinceMs: hb.lastEventAt, tool: null, count };
	return { kind: "idle", sinceMs: finite(session.lastActivityMs ?? hb.ts), tool: null };
}

const summaryNames = new Map();

/**
 * The session name from omo's own session list (`.session-summaries.index` beside the session file). A tracker that
 * started from the tail of a long file never saw the session_info entry, but the index keeps the current name.
 */
function summaryName(sessionFile) {
	if (!sessionFile) return undefined;
	const indexFile = path.join(path.dirname(sessionFile), ".session-summaries.index");
	const mtimeMs = statSafe(indexFile)?.mtimeMs;
	if (mtimeMs === undefined) return undefined;
	let cached = summaryNames.get(indexFile);
	if (cached?.mtimeMs !== mtimeMs) {
		const names = new Map();
		for (const line of readTextSafe(indexFile, "").split("\n")) {
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				continue; // a half-written last line is normal while omo rewrites the index
			}
			if (typeof row?.file === "string" && typeof row.summary?.name === "string") names.set(row.file, row.summary.name);
		}
		cached = { mtimeMs, names };
		summaryNames.set(indexFile, cached);
	}
	return cached.names.get(path.basename(sessionFile));
}

function titleOf(session) {
	const goal = session.anchor?.source === "goal" ? session.anchor.objective : undefined;
	for (const [value, source] of [[session.title, "name"], [summaryName(session.file), "name"], [goal, "goal"], [session.firstUserText, "first-request"]]) {
		const text = clean(value);
		if (text) return { title: text, titleSource: source };
	}
	return { title: "제목 없음", titleSource: "none" };
}

function healthOf(findings, investigations) {
	let rank = 0;
	const open = findings.map((f) => {
		rank = Math.max(rank, SEVERITY_RANK[f.severity] ?? 2);
		return { fp: f.fp, detector: f.detector, kind: f.kind, severity: f.severity ?? "warn", titleKo: clean(f.titleKo ?? "", 200), taskId: f.subject?.taskId ?? null };
	});
	return { level: LEVELS[rank], open, investigations: investigations.map((inv) => ({ fp: inv.id ?? inv.fp, status: inv.status, nextLookMs: finite(inv.retryAtMs ?? inv.nextLookMs) })) };
}

function countChildren(rows) {
	return (rows ?? []).reduce((n, row) => n + 1 + countChildren(row.children), 0);
}

/**
 * @param {object} world   buildWorld() result
 * @param {object[]} findings open findings of this tick
 * @param {object[]} investigations investigation records (createInvestigations().list())
 * @param {number} nowMs
 */
export function buildSessionSnapshot(world, findings = [], investigations = [], nowMs = world.now) {
	const openInvestigations = (investigations ?? []).filter((inv) => !RESOLVED_INVESTIGATIONS.has(inv.status));
	const healthFor = ({ sessionId, taskId }) => {
		const own = (subject) => (taskId ? subject?.taskId === taskId || (sessionId && subject?.sessionId === sessionId) : subject?.sessionId === sessionId && !subject?.taskId);
		return healthOf((findings ?? []).filter((f) => own(f.subject)), openInvestigations.filter((inv) => own(inv.subject)));
	};

	// Children by parent session id; a task seen in two stores counts once.
	const byParent = new Map();
	const seen = new Set();
	for (const task of world.tasks ?? []) {
		const key = task.uid ?? task.taskId;
		if (!task.parentSessionId || seen.has(key)) continue;
		const recent = TERMINAL_STATUSES.has(task.status) && nowMs - (task.terminalAtMs ?? task.updatedAtMs ?? 0) <= RECENT_END_MS;
		if (!ACTIVE_STATUSES.has(task.status) && !recent) continue;
		seen.add(key);
		if (!byParent.has(task.parentSessionId)) byParent.set(task.parentSessionId, []);
		byParent.get(task.parentSessionId).push(task);
	}
	const childrenOf = (parentId, depth, trail) => {
		if (depth > 8 || trail.has(parentId)) return [];
		const next = new Set(trail).add(parentId);
		return (byParent.get(parentId) ?? [])
			.map((task) => ({
				taskId: task.taskId,
				sessionId: task.childSessionId ?? null,
				name: clean(task.name ?? task.summary ?? task.taskId),
				category: task.category ?? null,
				model: task.model ?? null,
				status: task.status,
				startedMs: finite(task.startedAtMs ?? task.createdAtMs),
				endedMs: finite(task.terminalAtMs),
				health: healthFor({ sessionId: task.childSessionId, taskId: task.taskId }),
				children: task.childSessionId ? childrenOf(task.childSessionId, depth + 1, next) : [],
			}))
			.sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0));
	};

	const groups = new Map();
	for (const session of world.sessions?.values?.() ?? []) {
		if (session.kind !== "main" || !world.isSessionLive(session)) continue;
		const hb = world.sensors?.get?.(session.id);
		const hostPid = Number.isFinite(hb?.pid) ? hb.pid : session.hostPid;
		const omoVersion = Number.isFinite(hostPid) ? (world.hostExits?.liveMarkers?.get?.(hostPid)?.omoVersion ?? null) : null;
		const goal = session.anchor?.source === "goal" ? { status: session.anchor.status ?? null, objective: clean(session.anchor.objective, 300) } : null;
		const todo = session.todoState ? { open: session.todoState.open, total: session.todoState.total } : null;
		const row = {
			sessionId: session.id,
			...titleOf(session),
			cwd: session.cwd ?? hb?.cwd ?? null,
			startedMs: finite(session.startedMs),
			terminal: terminalOf(world, hb, hostPid),
			host: Number.isFinite(hostPid) ? { pid: hostPid, ctimeMs: finite(world.procs?.get?.(hostPid)?.ctimeMs), omoVersion } : null,
			state: stateOf(session, hb, nowMs),
			goal,
			todo,
			lastInputMs: finite(toMs(hb?.lastInputAt)),
			health: healthFor({ sessionId: session.id }),
			children: childrenOf(session.id, 1, new Set()),
		};
		if (!groups.has(omoVersion)) groups.set(omoVersion, []);
		groups.get(omoVersion).push(row);
	}
	return {
		v: 1,
		ts: nowMs,
		groups: [...groups.entries()]
			.sort(([a], [b]) => compareVersionsDesc(a, b))
			.map(([omoVersion, sessions]) => ({ omoVersion, sessions: sessions.sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0)) })),
	};
}

/** Executed release decisions of the last two decision files, keyed by task and session id. */
function recentReleases(paths) {
	const byId = new Map();
	const dir = paths?.health?.decisionsDir;
	if (!dir) return byId;
	const names = listDirSafe(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().slice(-2);
	for (const name of names) {
		for (const line of String(readTextSafe(path.join(dir, name), "")).split("\n")) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const kind = entry?.action?.kind;
			if (!RELEASE_KINDS.has(kind) || (entry.result !== undefined && entry.result !== "execute")) continue;
			for (const id of [entry.subject?.taskId, entry.subject?.sessionId, entry.action?.params?.taskId, entry.action?.params?.sessionId]) {
				if (typeof id === "string" && id) byId.set(id, kind);
			}
		}
	}
	return byId;
}

/** The crash record of this host: its start matches the host's creation time (a time-only match would blame every host). */
function crashFor(world, host, sinceMs, nowMs) {
	if (!Number.isFinite(host?.ctimeMs)) return undefined;
	for (const crash of world.hostExits?.crashRecords ?? []) {
		if (crash.detection && crash.detection !== "unclean_exit") continue;
		if (crash.atMs < sinceMs - CRASH_WINDOW_MS || crash.atMs > nowMs + CRASH_WINDOW_MS) continue;
		if (!Number.isFinite(crash.startedMs) || Math.abs(crash.startedMs - host.ctimeMs) > 60_000) continue;
		return crash;
	}
	return undefined;
}

function flatten(rows, parentSessionId, out = new Map()) {
	for (const row of rows ?? []) {
		out.set(row.taskId, { row, parentSessionId });
		flatten(row.children, row.sessionId, out);
	}
	return out;
}

function mainsOf(snapshot) {
	const out = new Map();
	for (const group of snapshot?.groups ?? []) for (const row of group.sessions ?? []) out.set(row.sessionId, { row, omoVersion: group.omoVersion ?? null });
	return out;
}

/**
 * Records of the sessions and tasks that ended between `prevSnapshot` and `snapshot`: a main session that left the
 * board, a child that left it or reached a terminal status. Nothing is decided without a fresh process snapshot.
 */
export function detectEnded(prevSnapshot, snapshot, world, nowMs = world.now) {
	if (!prevSnapshot || world.procsFresh === false) return [];
	const out = [];
	const prevMains = mainsOf(prevSnapshot);
	const curMains = mainsOf(snapshot);
	const curChildren = new Map();
	for (const { row } of curMains.values()) flatten(row.children, row.sessionId, curChildren);
	let releases;
	const releaseOf = (...ids) => {
		releases ??= recentReleases(world.paths);
		for (const id of ids) if (id && releases.has(id)) return releases.get(id);
		return undefined;
	};
	const mainOutcome = new Map();

	for (const [sessionId, { row, omoVersion }] of prevMains) {
		if (curMains.has(sessionId)) continue;
		const session = world.sessions?.get?.(sessionId);
		const goal = session?.anchor?.source === "goal" ? session.anchor : row.goal;
		const crash = crashFor(world, row.host, prevSnapshot.ts ?? nowMs, nowMs);
		let outcome;
		let reason;
		if (goal?.status === "complete") {
			outcome = "goal-complete";
			reason = `목표가 완료 상태에 도달한 뒤 세션이 끝났습니다: ${clean(goal.objective, 120)}`;
		} else if (crash) {
			outcome = "crash";
			reason = "omo 호스트가 비정상 종료되었습니다(process-crashes 기록).";
		} else if (row.host) {
			outcome = "closed";
			reason = "비정상 종료 기록 없이 호스트가 끝났습니다(사용자 종료 또는 창 닫기로 추정).";
		} else {
			outcome = "unknown";
			reason = "세션이 보드에서 사라졌지만 끝난 이유를 알려 줄 기록이 없습니다.";
		}
		mainOutcome.set(sessionId, outcome);
		out.push({
			v: 1,
			sessionId,
			kind: "main",
			parentSessionId: null,
			taskId: null,
			title: row.title,
			cwd: row.cwd ?? null,
			terminal: row.terminal ? { kind: row.terminal.kind } : null,
			omoVersion,
			startedMs: row.startedMs ?? null,
			endedMs: nowMs,
			outcome,
			reason,
			childCount: countChildren(row.children),
			estimated: outcome === "closed" || outcome === "unknown",
			source: "live",
		});
	}

	const prevChildren = new Map();
	const rootOf = new Map();
	for (const [sessionId, { row }] of prevMains) {
		const flat = flatten(row.children, sessionId);
		for (const [taskId, item] of flat) {
			prevChildren.set(taskId, item);
			rootOf.set(taskId, sessionId);
		}
	}
	for (const [taskId, { row, parentSessionId }] of prevChildren) {
		if (TERMINAL_STATUSES.has(row.status)) continue;
		const current = curChildren.get(taskId)?.row;
		if (current && !TERMINAL_STATUSES.has(current.status)) continue;
		const task = (world.tasks ?? []).find((t) => t.taskId === taskId && t.parentSessionId === parentSessionId) ?? (world.tasks ?? []).find((t) => t.taskId === taskId);
		const status = task?.status ?? current?.status;
		let outcome;
		let reason;
		const release = releaseOf(taskId, row.sessionId);
		if (status === "completed" && task?.hasFinalResponse !== false) {
			outcome = "answered";
			reason = "작업이 최종 응답과 함께 완료되었습니다.";
		} else if (release) {
			outcome = "released";
			reason = `omo-health가 ${release} 조치로 호출을 종료했습니다.`;
		} else if (status === "cancelled") {
			outcome = "cancelled";
			reason = "작업이 취소되었습니다.";
		} else if (FAILED_STATUSES.has(status)) {
			outcome = "failed";
			reason = `작업이 오류로 끝났습니다${task?.errorMessage ? `: ${clean(task.errorMessage, 160)}` : "."}`;
		} else if (mainOutcome.get(rootOf.get(taskId)) === "crash") {
			outcome = "crash";
			reason = "부모 세션의 omo 호스트가 비정상 종료되었습니다.";
		} else if (mainOutcome.has(rootOf.get(taskId)) && !TERMINAL_STATUSES.has(status)) {
			outcome = "closed";
			reason = "부모 세션이 끝나면서 작업도 함께 끝났습니다.";
		} else {
			outcome = "unknown";
			reason = `작업 상태가 ${clean(status ?? "없음", 30)}이고 끝난 이유를 알려 줄 기록이 없습니다.`;
		}
		out.push({
			v: 1,
			sessionId: row.sessionId ?? taskId,
			kind: "child",
			parentSessionId: parentSessionId ?? null,
			taskId,
			title: row.name,
			cwd: task?.spawnCwd ?? null,
			terminal: null,
			omoVersion: null,
			startedMs: row.startedMs ?? null,
			endedMs: finite(task?.terminalAtMs) ?? nowMs,
			outcome,
			reason,
			childCount: countChildren(row.children),
			estimated: outcome === "closed" || outcome === "unknown",
			source: "live",
		});
	}
	return out;
}
