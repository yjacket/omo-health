import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, SWITCH_KEYS } from "../config.mjs";
import { getPath, pauseState, SWITCHES } from "../control.mjs";
import { readDecisions } from "../decisions.mjs";
import { createInvestigations, RESOLVED } from "../investigations.mjs";
import { readEnded } from "../session-ledger.mjs";
import { listDirSafe, readJsonSafe, statSafe } from "../util/fsx.mjs";
import { redact, truncate } from "../util/text.mjs";
import { VERSION } from "../version.mjs";
import { buildHistory, historyStart } from "./history.mjs";
import { actionLabel, analystVerdictLabel, causeLabel, daemonStateLabel, exitReasonLabel, findingLabel, goalStatusLabel, investigationStatusLabel, OUTCOME_LABELS, outcomeLabel, sessionStateLabel, severityLabel, taskStatusLabel, terminalLabel, triggerLabel, waitClassLabel } from "./labels.mjs";

/** Read model of the local dashboard: one I/O loader, pure section builders. */

/** The investigation list shows the suspicions touched in the last 7 days, newest first, at most this many. */
const INVESTIGATION_WINDOW_MS = 7 * 24 * 3600_000;
const INVESTIGATION_LIMIT = 200;
const MAX_LINES = 12;
const LINE_MAX = 300;
/** The session board draws the daemon's snapshot (status/_sessions.json); one older than this is flagged stale. */
const SESSIONS_STALE_MS = 60_000;
/** Child trees deeper than this are cut: a snapshot never nests further, so anything deeper is malformed. */
const CHILD_DEPTH_MAX = 8;
/** The ended-session ledger shows the last 30 days, newest first, at most this many rows. */
const ENDED_WINDOW_MS = 30 * 24 * 3600_000;
const ENDED_LIMIT = 500;
const TITLE_MAX = 200;
/** A folder longer than this is shown as its last two segments. */
const PATH_SHORT_MAX = 32;
const HEALTH_LEVELS = new Set(["ok", "info", "warn", "crit"]);

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function pidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

export function loadUiInputs({ paths, env, now = Date.now() }) {
	const heartbeat = readJsonSafe(paths.health.daemonJson) ?? null;
	const loaded = loadConfig({ env, paths });
	let decisions;
	let decisionsReadMs = null;
	const started = performance.now();
	try {
		decisions = readDecisions(paths, historyStart(now));
		decisionsReadMs = Math.round((performance.now() - started) * 10) / 10;
	} catch (error) {
		decisions = { error: error.message };
	}
	let ended;
	try {
		ended = readEnded(paths, { sinceMs: now - ENDED_WINDOW_MS });
	} catch (error) {
		ended = { error: error.message };
	}
	return {
		now,
		version: VERSION,
		paths,
		heartbeat,
		// Read-only: the daemon writes the board snapshot each tick and the ledger when a session ends.
		sessionsSnapshot: readJsonSafe(paths.health.sessionsSnapshotFile) ?? null,
		ended,
		stopped: Boolean(statSafe(paths.health.stoppedFile)),
		pidAlive: pidAlive(heartbeat?.pid),
		pause: pauseState(paths, now),
		global: readJsonSafe(path.join(paths.health.statusDir, "_global.json")) ?? null,
		deaths: listDeathRecords(paths.health.deathsDir),
		// Read-only: the engine is the only writer of the investigation files.
		investigations: createInvestigations({ paths, clock: { now: () => now } }).list({ sinceMs: now - INVESTIGATION_WINDOW_MS, limit: INVESTIGATION_LIMIT }),
		decisions,
		decisionsReadMs,
		loaded,
		rawUserConfig: readJsonSafe(paths.health.configFile) ?? null,
		configStat: statSafe(paths.health.configFile) ?? null,
	};
}

function listDeathRecords(dir) {
	return listDirSafe(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).flatMap((entry) => {
		const record = readJsonSafe(path.join(dir, entry.name));
		const atMs = Number.isFinite(record?.atMs) ? record.atMs : Number(/^(\d+)-/.exec(entry.name)?.[1]);
		return record && typeof record.kind === "string" && Number.isFinite(atMs) ? [{ ...record, atMs }] : [];
	});
}

const short = (id) => (typeof id === "string" && id ? id.slice(0, 8) : null);
const text = (v, max = LINE_MAX) => (typeof v === "string" && v ? v.slice(0, max) : null);
const lines = (list) => (Array.isArray(list) ? list.filter((line) => typeof line === "string" && line).slice(0, MAX_LINES).map((line) => line.slice(0, LINE_MAX)) : []);
/** Free text from the snapshot or the ledger as the page shows it: whitespace folded, credentials masked, bounded. */
const clean = (v, max = LINE_MAX) => {
	const folded = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
	return folded ? truncate(redact(folded), max) : null;
};
const num = (v) => (Number.isFinite(v) ? v : null);

/** A folder as the board shows it: the whole path when short, else its last two segments after an ellipsis. */
function shortPath(cwd) {
	if (!cwd || cwd.length <= PATH_SHORT_MAX) return cwd ?? null;
	const sep = cwd.includes("\\") ? "\\" : "/";
	const parts = cwd.split(/[\\/]+/).filter(Boolean);
	return parts.length > 2 ? `\u2026${sep}${parts.slice(-2).join(sep)}` : cwd;
}

function terminalOf(terminal) {
	if (!isRecord(terminal)) return null;
	const kind = typeof terminal.kind === "string" && terminal.kind ? terminal.kind.slice(0, 20) : "other";
	return { kind, labelKo: terminalLabel(kind) };
}

/** A session's or a child task's health as the snapshot carries it: the level and the open findings and investigations behind it. */
function healthOf(health) {
	const h = isRecord(health) ? health : {};
	const open = (Array.isArray(h.open) ? h.open : []).filter(isRecord).map((f) => ({
		fp: text(f.fp, 80),
		detector: text(f.detector, 20),
		kind: text(f.kind, 80),
		severity: typeof f.severity === "string" ? f.severity.slice(0, 20) : null,
		severityKo: severityLabel(f.severity),
		titleKo: clean(f.titleKo, 200) ?? findingLabel(f.detector, f.kind),
		taskId: text(f.taskId, 80),
	}));
	const investigations = (Array.isArray(h.investigations) ? h.investigations : []).filter(isRecord).map((inv) => ({ fp: text(inv.fp, 80), status: typeof inv.status === "string" ? inv.status.slice(0, 30) : null, statusKo: investigationStatusLabel(inv.status), nextLookMs: num(inv.nextLookMs) }));
	return { level: HEALTH_LEVELS.has(h.level) ? h.level : "ok", open, investigations };
}

/** One ChildRow of the snapshot, recursively; the status keeps its raw key so the page can tone it. */
function childRow(c, depth = 0) {
	const children = depth < CHILD_DEPTH_MAX && Array.isArray(c.children) ? c.children.filter(isRecord).map((child) => childRow(child, depth + 1)) : [];
	return {
		taskId: text(c.taskId, 80),
		sessionId: text(c.sessionId, 80),
		sessionShort: short(c.sessionId),
		name: clean(c.name, 120) ?? text(c.taskId, 80) ?? "?",
		category: clean(c.category, 60),
		model: clean(c.model, 80),
		status: typeof c.status === "string" ? c.status.slice(0, 30) : null,
		statusKo: taskStatusLabel(c.status),
		startedMs: num(c.startedMs),
		endedMs: num(c.endedMs),
		health: healthOf(c.health),
		children,
	};
}

/** One SessionRow of the snapshot as the board card shows it. */
function sessionRow(s) {
	const state = isRecord(s.state) ? s.state : {};
	const stateKind = typeof state.kind === "string" ? state.kind.slice(0, 20) : null;
	const cwd = clean(s.cwd, 300);
	const children = (Array.isArray(s.children) ? s.children : []).filter(isRecord).map((c) => childRow(c));
	return {
		sessionId: text(s.sessionId, 80),
		sessionShort: short(s.sessionId),
		title: clean(s.title, TITLE_MAX) ?? short(s.sessionId) ?? "(제목 없음)",
		titleSource: typeof s.titleSource === "string" ? s.titleSource.slice(0, 20) : "none",
		cwd,
		cwdShort: shortPath(cwd),
		startedMs: num(s.startedMs),
		terminal: terminalOf(s.terminal),
		host: isRecord(s.host) ? { pid: num(s.host.pid), ctimeMs: num(s.host.ctimeMs), omoVersion: clean(s.host.omoVersion, 40) } : null,
		state: { kind: stateKind, kindKo: sessionStateLabel(stateKind), sinceMs: num(state.sinceMs), tool: clean(state.tool, 80) },
		goal: isRecord(s.goal) ? { status: typeof s.goal.status === "string" ? s.goal.status.slice(0, 20) : null, statusKo: goalStatusLabel(s.goal.status), objective: clean(s.goal.objective, LINE_MAX) } : null,
		todo: isRecord(s.todo) ? { open: num(s.todo.open), total: num(s.todo.total) } : null,
		lastInputMs: num(s.lastInputMs),
		health: healthOf(s.health),
		children,
		childCount: children.length,
	};
}

/** One omo-version group: its sessions and the counts the group header shows. */
function groupRow(g) {
	const sessions = (Array.isArray(g.sessions) ? g.sessions : []).filter(isRecord).map(sessionRow);
	const count = (test) => sessions.filter(test).length;
	return {
		omoVersion: clean(g.omoVersion, 40),
		sessions,
		counts: { sessions: sessions.length, active: count((s) => s.state.kind === "busy" || s.state.kind === "tool"), warn: count((s) => s.health.level === "warn"), crit: count((s) => s.health.level === "crit") },
	};
}

/** The live session board: the daemon's snapshot as written, with Korean labels; the empty snapshot when the file is missing or unreadable. */
export function buildSessions(inputs) {
	const snap = isRecord(inputs.sessionsSnapshot) ? inputs.sessionsSnapshot : null;
	const ts = num(snap?.ts);
	const groups = (Array.isArray(snap?.groups) ? snap.groups : []).filter(isRecord).map(groupRow);
	return { v: 1, ts, stale: ts !== null && inputs.now - ts > SESSIONS_STALE_MS, groups, total: groups.reduce((n, g) => n + g.sessions.length, 0) };
}

/**
 * One EndedRecord of the ledger as the history table shows it. `childRows` is the number of ended child rows in the
 * window that name this session as parent: a session recorded before its children were visible keeps childCount 0.
 */
function endedRow(r, childRows = 0) {
	const outcome = typeof r.outcome === "string" && Object.hasOwn(OUTCOME_LABELS, r.outcome) ? r.outcome : "unknown";
	const startedMs = num(r.startedMs);
	const endedMs = num(r.endedMs);
	const cwd = clean(r.cwd, 300);
	return {
		sessionId: text(r.sessionId, 80),
		sessionShort: short(r.sessionId),
		kind: r.kind === "child" ? "child" : "main",
		parentSessionId: text(r.parentSessionId, 80),
		parentShort: short(r.parentSessionId),
		taskId: text(r.taskId, 80),
		title: clean(r.title, TITLE_MAX) ?? short(r.sessionId) ?? "(제목 없음)",
		cwd,
		cwdShort: shortPath(cwd),
		terminal: terminalOf(r.terminal),
		omoVersion: clean(r.omoVersion, 40),
		startedMs,
		endedMs,
		durationMs: startedMs !== null && endedMs !== null && endedMs >= startedMs ? endedMs - startedMs : null,
		outcome,
		outcomeKo: outcomeLabel(outcome),
		reason: clean(r.reason, LINE_MAX),
		childCount: Math.max(num(r.childCount) ?? 0, childRows),
		estimated: r.estimated === true,
		source: r.source === "backfill" ? "backfill" : "live",
	};
}

/** The ended-session history: the last 30 days newest first (as `readEnded` returns them), capped, with counts per outcome over the whole window. */
export function buildEnded(inputs) {
	if (isRecord(inputs.ended) && "error" in inputs.ended) throw new Error(inputs.ended.error);
	const all = (Array.isArray(inputs.ended) ? inputs.ended : []).filter((r) => isRecord(r) && Number.isFinite(r.endedMs));
	const tally = new Map(Object.keys(OUTCOME_LABELS).map((outcome) => [outcome, 0]));
	for (const r of all) {
		const outcome = typeof r.outcome === "string" && tally.has(r.outcome) ? r.outcome : "unknown";
		tally.set(outcome, tally.get(outcome) + 1);
	}
	const childRows = new Map();
	for (const r of all) if (r.kind === "child" && typeof r.parentSessionId === "string") childRows.set(r.parentSessionId, (childRows.get(r.parentSessionId) ?? 0) + 1);
	return {
		sinceMs: inputs.now - ENDED_WINDOW_MS,
		limit: ENDED_LIMIT,
		total: all.length,
		counts: [...tally].map(([outcome, count]) => ({ outcome, outcomeKo: outcomeLabel(outcome), count })),
		rows: all.slice(0, ENDED_LIMIT).map((r) => endedRow(r, childRows.get(r.sessionId))),
	};
}

/** What the engine attached to an investigation's last action (src/engine.mjs): a kill's outcome, or a delivery. */
function actionDetailOf(action) {
	const names = (list) => (Array.isArray(list) && list.length ? list.map((p) => (isRecord(p) ? (p.pid ?? "?") : p)).join(", ") : null);
	const parts = [names(action.killed) && `killed ${names(action.killed)}`, names(action.noop) && `noop ${names(action.noop)}`, names(action.survived) && `survived ${names(action.survived)}`, action.delivered !== undefined && action.delivered !== null && `delivered ${action.delivered}`, action.rule && `rule ${action.rule}`];
	return parts.filter(Boolean).join("; ").slice(0, LINE_MAX) || null;
}

/** One investigation file as a list row: the six columns, then what the expanded row shows. */
function investigationRow(inv) {
	const subject = isRecord(inv.subject) ? inv.subject : {};
	const child = Boolean(subject.taskId || subject.parentSessionId);
	const verdict = isRecord(inv.verdict) ? inv.verdict : null;
	const actions = Array.isArray(inv.actions) ? inv.actions.filter(isRecord) : [];
	const last = actions.at(-1) ?? null;
	// A why look is sticky (src/investigations.mjs): an investigation a rule release opened reads as a why look once the analyst looked into the cause.
	const trigger = inv.why === true ? "why" : (inv.trigger ?? null);
	return {
		id: inv.id,
		openedMs: Number.isFinite(inv.openedMs) ? inv.openedMs : null,
		status: inv.status ?? null,
		statusKo: investigationStatusLabel(inv.status),
		trigger,
		triggerKo: triggerLabel(trigger),
		subject: { id: text(subject.taskId, 80) ?? short(subject.sessionId), kind: child ? "child" : "main", kindKo: child ? "하위" : "메인", sessionShort: short(subject.sessionId), taskId: text(subject.taskId, 80) },
		detector: inv.detector ?? null,
		cls: inv.cls ?? null,
		clsKo: inv.cls ? waitClassLabel(inv.cls) : null,
		rule: isRecord(inv.rule) ? (inv.rule.id ?? null) : (inv.rule ?? null),
		verdictKo: analystVerdictLabel(verdict),
		verdict: verdict
			? { verdict: verdict.verdict ?? null, assessment: verdict.assessment ?? null, confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : null, cause: verdict.cause ?? null, causeKo: verdict.cause ? causeLabel(verdict.cause) : null, diagnosis: text(verdict.diagnosis, 600), mechanism: text(verdict.mechanism, 600), avoid: text(verdict.avoid, 600), advice: text(verdict.advice), reason: text(verdict.reason, 120), failed: Boolean(verdict.failed), reused: Boolean(verdict.reused), atMs: Number.isFinite(verdict.atMs) ? verdict.atMs : null, evidence: lines(verdict.evidence) }
			: null,
		action: last ? { kind: last.kind ?? null, kindKo: actionLabel(last.kind), atMs: Number.isFinite(last.atMs) ? last.atMs : null, detail: actionDetailOf(last), advice: text(last.advice) } : null,
		actionCount: actions.length,
		failures: Number.isFinite(inv.failures) ? inv.failures : 0,
		// A failed or held investigation says when the analyst looks again; a settled one never does.
		retryAtMs: !RESOLVED.has(inv.status) && Number.isFinite(inv.retryAtMs) ? inv.retryAtMs : null,
		lane: text(inv.lane, 80),
		model: text(inv.model, 80),
		evidence: lines(inv.evidence),
	};
}

/** The investigation list: newest first, as `list()` returns them. */
export function buildInvestigations(inputs) {
	const rows = (inputs.investigations ?? []).filter((inv) => isRecord(inv) && typeof inv.id === "string").map(investigationRow);
	return { sinceMs: inputs.now - INVESTIGATION_WINDOW_MS, limit: INVESTIGATION_LIMIT, total: rows.length, rows };
}

function daemonStateOf({ stopped, heartbeat: hb, pidAlive: alive, loaded }, ageMs) {
	if (stopped) return "stopped";
	if (!hb || hb.stoppedMs) return "off";
	if (alive) return ageMs !== null && ageMs <= loaded.config.daemonStaleMs ? "running" : "stale";
	return "crashed";
}

function daemonStatus(inputs) {
	const hb = inputs.heartbeat;
	const heartbeatAgeMs = Number.isFinite(hb?.ts) ? inputs.now - hb.ts : null;
	const state = daemonStateOf(inputs, heartbeatAgeMs);
	const configMode = inputs.loaded.config.mode;
	return {
		state,
		stateKo: daemonStateLabel(state),
		pid: hb?.pid ?? null,
		version: hb?.version ?? null,
		mode: hb?.mode ?? null,
		configMode,
		modeOverridden: state === "running" && hb.mode !== configMode,
		heartbeatAgeMs,
		startedMs: hb?.startedMs ?? null,
		exitReason: hb?.exitReason ?? null,
		exitReasonKo: hb?.exitReason ? exitReasonLabel(hb.exitReason) : null,
		stoppedMs: hb?.stoppedMs ?? null,
	};
}

export function buildOverview(inputs) {
	const { pause, now, global } = inputs;
	const counts = global?.counts ?? {};
	const deaths = [...(inputs.deaths ?? [])].sort((a, b) => b.atMs - a.atMs);
	return {
		daemon: daemonStatus(inputs),
		pause: { active: pause.active, untilMs: pause.untilMs, indefinite: pause.indefinite, remainingMs: pause.active && pause.untilMs !== null ? pause.untilMs - now : null, unreadable: pause.unreadable },
		level: global?.level ?? null,
		text: global?.text ?? null,
		counts: { sessions: counts.sessions ?? null, tasks: counts.tasks ?? null, liveHosts: counts.liveHosts ?? null, sensors: counts.sensors ?? null },
		deaths: { count: deaths.length, last: deaths.length ? { kind: deaths[0].kind, atMs: deaths[0].atMs } : null },
		humanNeeded: (global?.humanNeeded ?? []).map((h) => ({ titleKo: h.titleKo })),
		openFindings: (global?.open ?? []).map((f) => ({ severity: f.severity, severityKo: severityLabel(f.severity), titleKo: f.titleKo })),
		degraded: Boolean(global?.degraded),
	};
}

function overrideOf({ key, value, effective, running, hbConfig }) {
	if (key === "mode" && running && hbConfig?.modeOverride && effective !== value) return ["shadow-flag", "감시기가 --shadow로 실행되어 조치하지 않고 기록만 합니다."];
	if (hbConfig?.extra && effective !== null && effective !== value) return ["extra-config", `추가 설정 파일(${hbConfig.extra.file})이 이 값을 덮어씁니다.`];
	return [null, null];
}

function appliedOf(running, hb, configStat) {
	const mtime = configStat?.mtimeMs ?? null;
	const c = isRecord(hb?.config) ? hb.config : null;
	const receipt = { fileMtimeMs: mtime, daemonFileMtimeMs: c?.fileMtimeMs ?? null, loadedMs: c?.loadedMs ?? null, source: c?.source ?? null };
	if (!running) return { state: "daemon-off", stateKo: "감시기가 꺼져 있어 다음 시작 때 반영됩니다", ...receipt };
	if (!c) return { state: "unknown", stateKo: "이 감시기 버전은 설정을 시작할 때만 읽습니다", ...receipt };
	if (isRecord(c.rejected) && c.rejected.fileMtimeMs === mtime) {
		return { state: "rejected", stateKo: c.source === "last-good" ? "config.json을 읽을 수 없어 마지막 정상 사본으로 동작 중" : "config.json을 읽을 수 없어 직전 설정을 유지하고 있습니다", ...receipt };
	}
	if ((c.fileMtimeMs ?? null) === mtime) return { state: "applied", stateKo: c.source === "last-good" ? "마지막 정상 사본으로 동작 중" : "감시기에 반영됨", ...receipt };
	return { state: "pending", stateKo: "다음 확인(약 15초 안)에 반영됩니다", ...receipt };
}

function othersOf(config, defaults, prefix = "") {
	return Object.entries(defaults).flatMap(([key, def]) => {
		const where = prefix + key;
		if (isRecord(def)) return othersOf(config?.[key], def, `${where}.`);
		const value = config?.[key];
		return SWITCH_KEYS.includes(where) || JSON.stringify(value) === JSON.stringify(def) ? [] : [{ key: where, value, default: def }];
	});
}

export function buildSettings(inputs) {
	const { loaded, heartbeat: hb } = inputs;
	const running = daemonStatus(inputs).state === "running";
	const hbConfig = running && isRecord(hb.config) ? hb.config : null;
	const switches = SWITCHES.map((s) => {
		const value = getPath(loaded.config, s.key);
		const def = getPath(DEFAULT_CONFIG, s.key);
		const effective = hbConfig?.effective?.[s.key] ?? null;
		const [overriddenBy, overriddenKo] = overrideOf({ key: s.key, value, effective, running, hbConfig });
		return { key: s.key, labelKo: s.labelKo, descKo: s.descKo, type: s.type, values: s.values, value, default: def, isDefault: value === def, effective, overriddenBy, overriddenKo };
	});
	return {
		file: inputs.paths.health.configFile,
		switches,
		others: othersOf(loaded.config, DEFAULT_CONFIG),
		othersNoteKo: "일부 값은 감시기를 다시 시작할 때 반영됩니다.",
		warnings: loaded.warnings,
		unreadable: loaded.unreadable,
		usedLastGood: loaded.usedLastGood,
		applied: appliedOf(running, hb, inputs.configStat),
		extraConfig: hb?.config?.extra ?? null,
	};
}

function section(build) {
	try {
		return build();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function buildUiState(inputs) {
	return {
		generatedMs: inputs.now,
		version: inputs.version,
		sessions: section(() => buildSessions(inputs)),
		ended: section(() => buildEnded(inputs)),
		overview: section(() => buildOverview(inputs)),
		investigations: section(() => buildInvestigations(inputs)),
		history: section(() => ({ ...buildHistory(inputs.decisions, inputs.now), readMs: inputs.decisionsReadMs })),
		settings: section(() => buildSettings(inputs)),
	};
}

export function uiState({ paths, env, now = Date.now() }) {
	return buildUiState(loadUiInputs({ paths, env, now }));
}
