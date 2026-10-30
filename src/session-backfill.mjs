import fs from "node:fs";
import path from "node:path";
import { entryMs, idFromFileName, readSessionHeader } from "./collect/sessions.mjs";
import { normalizeTask, senpiTaskStoreDir, taskStoreDir } from "./collect/tasks.mjs";
import { appendEnded, readEnded } from "./session-ledger.mjs";
import { atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, readTextSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";
import { kst, toMs } from "./util/time.mjs";

const DAY_MS = 86_400_000;
const LIVE_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 2 * 60_000;
const MAX_SESSION_FILES = 2000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_MAX_BYTES = 64 * 1024 * 1024;
const TITLE_MAX = 200;
const RELEASE_KINDS = new Set(["kill-pids", "release-shell"]);
const FAILED_STATUSES = new Set(["error", "failed"]);

export const BACKFILL_MARKER = ".backfilled";
export const BACKFILL_VERSION = 2;

function clean(value, max) {
	return truncate(redact(String(value ?? "")).replace(/\s+/g, " ").trim(), max);
}

function parseLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Head and tail of a session file without loading a huge file: last entry time and last session name. */
function scanSessionFile(file, size) {
	const fd = fs.openSync(file, "r");
	try {
		const read = (offset, length) => {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, offset);
			return buf.subarray(0, n).toString("utf8");
		};
		const chunks = [];
		if (size <= HEAD_BYTES + TAIL_BYTES) chunks.push({ text: read(0, size), partialStart: false });
		else {
			chunks.push({ text: read(0, HEAD_BYTES), partialStart: false });
			chunks.push({ text: read(size - TAIL_BYTES, TAIL_BYTES), partialStart: true });
		}
		let lastMs;
		let name;
		for (const { text, partialStart } of chunks) {
			const lines = text.split("\n");
			if (partialStart) lines.shift();
			for (const line of lines) {
				if (!line.trim()) continue;
				const entry = parseLine(line);
				if (!entry || typeof entry !== "object") continue;
				const ms = entryMs(entry);
				if (Number.isFinite(ms) && (lastMs === undefined || ms > lastMs)) lastMs = ms;
				if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name;
			}
		}
		return { lastMs, name };
	} finally {
		fs.closeSync(fd);
	}
}

/** `.session-summaries.index` of one slug dir: sessionId -> { name, firstUserMessage, lastActivityTime }. */
function readSummaryIndex(dir, errors) {
	const file = path.join(dir, ".session-summaries.index");
	const stat = statSafe(file);
	const out = new Map();
	if (!stat) return out;
	if (stat.size > INDEX_MAX_BYTES) {
		errors.push(`index too large: ${file}`);
		return out;
	}
	for (const line of String(readTextSafe(file, "")).split("\n")) {
		if (!line.trim()) continue;
		const rec = parseLine(line);
		const summary = rec?.summary;
		if (!summary || typeof summary !== "object") continue;
		const id = summary.header?.id ?? (typeof rec.file === "string" ? idFromFileName(rec.file) : undefined);
		if (typeof id === "string") out.set(id, { name: summary.name, firstUserMessage: summary.firstUserMessage, lastActivityTime: toMs(summary.lastActivityTime) });
	}
	return out;
}

function readCrashes(paths, sinceMs, errors) {
	const file = path.join(paths.agentDir, "process-crashes", "crashes.jsonl");
	const out = [];
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") errors.push(`crashes: ${error.message}`);
		return out;
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const rec = parseLine(line);
		const atMs = toMs(rec?.at);
		if (!Number.isFinite(atMs) || atMs < sinceMs || rec.detection !== "unclean_exit") continue;
		out.push({ atMs, omoVersion: typeof rec.productVersion === "string" ? clean(rec.productVersion, 40) : null });
	}
	return out.sort((a, b) => a.atMs - b.atMs);
}

/** Executed kill-pids / release-shell decisions, keyed by the task and session ids they name. */
function readReleases(paths, sinceMs, errors) {
	const byId = new Map();
	for (const name of listDirSafe(paths.health.decisionsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
		if (Date.parse(`${name.slice(0, 10)}T23:59:59.999Z`) < sinceMs) continue;
		let text;
		try {
			text = fs.readFileSync(path.join(paths.health.decisionsDir, name), "utf8");
		} catch (error) {
			errors.push(`decisions ${name}: ${error.message}`);
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const entry = parseLine(line);
			const kind = entry?.action?.kind;
			if (!RELEASE_KINDS.has(kind) || (entry.result !== undefined && entry.result !== "execute")) continue;
			const ms = toMs(entry.ts);
			const hit = { kind, ms };
			for (const id of [entry.subject?.taskId, entry.subject?.sessionId, entry.action?.params?.taskId, entry.action?.params?.sessionId]) {
				if (typeof id === "string" && id && !byId.has(id)) byId.set(id, hit);
			}
		}
	}
	return byId;
}

function readTasks(cwd, errors, agentDir) {
	const storeDir = agentDir ? senpiTaskStoreDir(cwd, agentDir) : taskStoreDir(cwd);
	const tasksDir = path.join(storeDir, "tasks");
	const out = [];
	for (const name of listDirSafe(tasksDir).filter((n) => n.endsWith(".json"))) {
		const file = path.join(tasksDir, name);
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!raw || typeof raw.task_id !== "string") throw new Error("no task_id");
			out.push({ ...normalizeTask(raw, storeDir), projectCwd: cwd });
		} catch (error) {
			errors.push(`task ${file}: ${error.message}`);
		}
	}
	return out;
}

function childOutcome(task, releases) {
	if (task.status === "completed" && task.hasFinalResponse) return { outcome: "answered", reason: "작업이 최종 응답과 함께 완료로 기록되었습니다." };
	if (task.status === "cancelled") return { outcome: "cancelled", reason: "작업 기록의 상태가 취소(cancelled)입니다." };
	if (FAILED_STATUSES.has(task.status)) {
		const detail = task.errorMessage ? `: ${clean(task.errorMessage, 160)}` : ".";
		return { outcome: "failed", reason: `작업이 오류로 끝났습니다${detail}` };
	}
	const release = releases.get(task.taskId) ?? (task.childSessionId ? releases.get(task.childSessionId) : undefined);
	if (release) return { outcome: "released", reason: `omo-health가 ${release.kind} 조치로 호출을 종료했습니다${Number.isFinite(release.ms) ? ` (${kst(release.ms)})` : ""}.` };
	return { outcome: "unknown", reason: `작업 상태가 ${clean(task.status ?? "없음", 30)}이고 끝난 이유를 알려 줄 기록이 없습니다.` };
}

/**
 * One-time reconstruction of the last `days` of ended sessions into the ended-session ledger (estimated:true,
 * source:"backfill"). A `.backfilled` marker with v >= BACKFILL_VERSION makes every later call a no-op; a missing,
 * unreadable or older marker re-runs the backfill, and the ledger's existing duplicate check keeps prior entries.
 * Never throws on a bad source file: problems are collected into the returned summary.
 */
export function backfillOnce(paths, nowMs, { days = 30 } = {}) {
	const markerFile = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	const marker = readJsonSafe(markerFile);
	if (Number(marker?.v) >= BACKFILL_VERSION) return { skipped: true };
	const sinceMs = nowMs - days * DAY_MS;
	const liveCutMs = nowMs - LIVE_MS;
	const errors = [];
	const counts = { main: 0, child: 0, written: 0, duplicate: 0, live: 0, outcomes: {} };

	// Main session files, newest first, bounded.
	const files = [];
	const slugDirs = [];
	for (const slug of listDirSafe(paths.sessionsDir)) {
		const dir = path.join(paths.sessionsDir, slug);
		if (!statSafe(dir)?.isDirectory()) continue;
		slugDirs.push(dir);
		for (const name of listDirSafe(dir).filter((n) => n.endsWith(".jsonl"))) {
			const file = path.join(dir, name);
			const stat = statSafe(file);
			if (stat?.isFile() && stat.mtimeMs >= sinceMs) files.push({ dir, file, size: stat.size, mtimeMs: stat.mtimeMs });
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (files.length > MAX_SESSION_FILES) errors.push(`session files capped at ${MAX_SESSION_FILES} of ${files.length}`);

	const indexes = new Map();
	const mains = [];
	for (const item of files.slice(0, MAX_SESSION_FILES)) {
		try {
			const header = readSessionHeader(item.file);
			if (!header || typeof header.id !== "string") {
				errors.push(`bad session header: ${item.file}`);
				continue;
			}
			const { lastMs: scannedMs, name } = scanSessionFile(item.file, item.size);
			if (!indexes.has(item.dir)) indexes.set(item.dir, readSummaryIndex(item.dir, errors));
			const summary = indexes.get(item.dir).get(header.id);
			const lastMs = scannedMs ?? summary?.lastActivityTime ?? toMs(header.timestamp) ?? item.mtimeMs;
			mains.push({ dir: item.dir, header, lastMs, name, summary });
		} catch (error) {
			errors.push(`session ${item.file}: ${error.message}`);
		}
	}

	// Child tasks from every project a session ran in.
	const cwds = new Map();
	for (const m of mains) if (typeof m.header.cwd === "string" && m.header.cwd) cwds.set(m.header.cwd.toLowerCase(), m.header.cwd);
	const tasks = [];
	for (const cwd of cwds.values()) tasks.push(...readTasks(cwd, errors, paths.agentDir));
	const childSessionIds = new Set(tasks.map((t) => t.childSessionId).filter(Boolean));
	const childCount = new Map();
	for (const t of tasks) if (t.parentSessionId) childCount.set(t.parentSessionId, (childCount.get(t.parentSessionId) ?? 0) + 1);

	const crashes = readCrashes(paths, sinceMs, errors);
	const releases = readReleases(paths, sinceMs, errors);
	const recorded = new Set(readEnded(paths, { sinceMs }).map((r) => r.sessionId));

	const write = (record) => {
		counts[record.kind] += 1;
		counts.outcomes[record.outcome] = (counts.outcomes[record.outcome] ?? 0) + 1;
		if (recorded.has(record.sessionId)) {
			counts.duplicate += 1;
			return;
		}
		try {
			if (appendEnded(paths, record)) {
				counts.written += 1;
				recorded.add(record.sessionId);
			} else counts.duplicate += 1;
		} catch (error) {
			errors.push(`append ${record.sessionId}: ${error.message}`);
		}
	};

	for (const m of mains) {
		const sessionId = m.header.id;
		if (childSessionIds.has(sessionId) || m.lastMs < sinceMs) continue;
		if (m.lastMs > liveCutMs) {
			counts.live += 1;
			continue;
		}
		const goalFile = path.join(m.dir, "extensions", "goal", `${sessionId}.json`);
		const goal = readJsonSafe(goalFile)?.goal;
		const crash = crashes.find((c) => c.atMs >= m.lastMs && c.atMs <= m.lastMs + CRASH_WINDOW_MS);
		let outcome;
		let reason;
		if (goal?.status === "complete") {
			outcome = "goal-complete";
			reason = `목표가 완료 상태로 기록되었습니다: ${clean(goal.objective, 120)}`;
		} else if (crash) {
			outcome = "crash";
			reason = `마지막 기록 ${Math.round((crash.atMs - m.lastMs) / 1000)}초 뒤 omo 비정상 종료가 crashes.jsonl에 기록되었습니다.`;
		} else {
			outcome = "closed";
			reason = "비정상 종료 기록 없이 활동이 끝났습니다(사용자 종료 또는 창 닫기로 추정).";
		}
		const title = m.name ?? m.summary?.name ?? goal?.objective ?? m.summary?.firstUserMessage ?? "";
		write({
			v: 1,
			sessionId,
			kind: "main",
			parentSessionId: null,
			taskId: null,
			title: clean(title, TITLE_MAX) || "(제목 없음)",
			cwd: typeof m.header.cwd === "string" ? m.header.cwd : null,
			terminal: null,
			omoVersion: crash?.omoVersion ?? null,
			startedMs: toMs(m.header.timestamp) ?? null,
			endedMs: m.lastMs,
			outcome,
			reason,
			childCount: childCount.get(sessionId) ?? 0,
			estimated: true,
			source: "backfill",
		});
	}

	for (const t of tasks) {
		if (!t.terminal) continue;
		const endedMs = t.terminalAtMs ?? t.updatedAtMs;
		if (!Number.isFinite(endedMs) || endedMs < sinceMs) continue;
		if (endedMs > liveCutMs) {
			counts.live += 1;
			continue;
		}
		const { outcome, reason } = childOutcome(t, releases);
		write({
			v: 1,
			sessionId: t.childSessionId || t.taskId,
			kind: "child",
			parentSessionId: t.parentSessionId ?? null,
			taskId: t.taskId,
			title: clean(t.name ?? t.summary ?? t.taskId, TITLE_MAX) || t.taskId,
			cwd: typeof t.spawnCwd === "string" ? t.spawnCwd : t.projectCwd,
			terminal: null,
			omoVersion: null,
			startedMs: t.startedAtMs ?? t.createdAtMs ?? null,
			endedMs,
			outcome,
			reason,
			childCount: childCount.get(t.childSessionId) ?? 0,
			estimated: true,
			source: "backfill",
		});
	}

	const summary = { skipped: false, sinceMs, sessionFiles: files.length, sessionDirs: slugDirs.length, counts, errors: errors.map((e) => clean(e, 300)) };
	try {
		ensureDir(paths.health.sessionsDir);
		atomicWriteJson(markerFile, { v: BACKFILL_VERSION, ts: nowMs, days, counts, errorCount: errors.length });
	} catch (error) {
		summary.errors.push(clean(`marker: ${error.message}`, 300));
	}
	return summary;
}
