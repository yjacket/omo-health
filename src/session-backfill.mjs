import fs from "node:fs";
import path from "node:path";
import { entryMs, idFromFileName } from "./collect/sessions.mjs";
import { normalizeTask, senpiTaskStoreDir, taskStoreDir } from "./collect/tasks.mjs";
import { pathKey } from "./paths.mjs";
import { appendEndedBatch, endedKey, streamEnded } from "./session-ledger.mjs";
import { projectKeyOf, subjectKey, subjectOf } from "./session-subject.mjs";
import { atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, readTextSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";
import { kst, toMs } from "./util/time.mjs";

const DAY_MS = 86_400_000;
const LIVE_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 2 * 60_000;
const MAX_SESSION_FILES = 2000;
const MAX_REPORTED_ERRORS = 100;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_MAX_BYTES = 64 * 1024 * 1024;
const TITLE_MAX = 200;
const RELEASE_KINDS = new Set(["kill-pids", "release-shell"]);
const FAILED_STATUSES = new Set(["error", "failed"]);

export const BACKFILL_MARKER = ".backfilled";
export const BACKFILL_VERSION = 3;

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
function scanSessionFile(file, size, budget, headerOnly = false) {
	const fd = fs.openSync(file, "r");
	try {
		const read = (offset, length) => {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, offset);
			budget.remaining -= n;
			return buf.subarray(0, n);
		};
		const whole = !headerOnly && size <= HEAD_BYTES + TAIL_BYTES;
		const head = read(0, whole ? size : Math.min(size, HEAD_BYTES));
		const headerBytes = head.subarray(0, HEAD_BYTES);
		const newline = headerBytes.indexOf(10);
		const header = parseLine(headerBytes.subarray(0, newline === -1 ? headerBytes.length : newline).toString("utf8"));
		if (header?.type !== "session" || typeof header.id !== "string") return {};
		if (headerOnly) return { header };
		const chunks = [{ text: head.toString("utf8"), partialStart: false }];
		if (!whole) chunks.push({ text: read(size - TAIL_BYTES, TAIL_BYTES).toString("utf8"), partialStart: true });
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
		return { header, lastMs, name };
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

/** Resolve each executed release to at most one child across the scanned stores. */
function readReleases(paths, sinceMs, errors, tasks) {
	const owners = { taskId: new Map(), sessionId: new Map() };
	const remember = (index, id, projectKey, task) => {
		if (typeof id !== "string" || !id) return;
		for (const scope of projectKey ? [null, projectKey] : [null]) {
			const key = subjectKey({ projectKey: scope, sessionId: id });
			index.set(key, index.has(key) ? null : task);
		}
	};
	// Even children outside the write window can make a legacy ID ambiguous.
	for (const task of tasks) {
		const projectKey = projectKeyOf(task.cwd);
		remember(owners.taskId, task.taskId, projectKey, task);
		remember(owners.sessionId, task.childSessionId, projectKey, task);
	}
	const byChild = new Map();
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
			const subjectProject = subjectOf(entry.subject).projectKey;
			const paramsProject = subjectOf(entry.action.params).projectKey;
			if (subjectProject != null && paramsProject != null && subjectProject !== paramsProject) continue;
			const projectKey = subjectProject ?? paramsProject;
			const matches = new Set();
			for (const source of [entry.subject, entry.action.params]) {
				for (const field of ["taskId", "sessionId"]) {
					const id = source?.[field];
					if (typeof id !== "string" || !id) continue;
					const owner = owners[field].get(subjectKey({ projectKey, sessionId: id }));
					if (owner) matches.add(owner);
				}
			}
			if (matches.size !== 1) continue;
			const [child] = matches;
			if (!byChild.has(child)) byChild.set(child, { kind, ms: toMs(entry.ts) });
		}
	}
	return byChild;
}

/** Read new traversal edges within the tick's allowance, with no open fd across ticks. */
function* readTaskRecord(file, budget) {
	const stat = fs.statSync(file);
	if (!stat.isFile()) throw new Error("not a regular file");
	const chunks = [];
	let offset = 0;
	while (offset < stat.size) {
		while (budget.remaining < 1) yield;
		const fd = fs.openSync(file, "r");
		try {
			while (offset < stat.size && budget.remaining >= 1) {
				const chunk = Buffer.allocUnsafe(Math.min(stat.size - offset, budget.remaining, HEAD_BYTES));
				const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
				if (!n) throw new Error("incomplete task record");
				budget.remaining -= n;
				offset += n;
				chunks.push(chunk.subarray(0, n));
			}
		} finally {
			fs.closeSync(fd);
		}
	}
	return Buffer.concat(chunks, offset).toString("utf8");
}

function* taskStep(budget) {
	while (budget.remaining < 1 || budget.taskSteps === 0) yield;
	budget.taskSteps--;
}

function* readTasks(cwd, storeDir, errors, budget) {
	const tasksDir = path.join(storeDir, "tasks");
	const parentProjectKey = projectKeyOf(cwd);
	const tasks = [];
	for (const name of listDirSafe(tasksDir).filter((n) => n.endsWith(".json"))) {
		if (budget) yield* taskStep(budget);
		const file = path.join(tasksDir, name);
		try {
			const raw = JSON.parse(budget ? yield* readTaskRecord(file, budget) : fs.readFileSync(file, "utf8"));
			if (!raw || typeof raw.task_id !== "string") throw new Error("no task_id");
			const task = normalizeTask(raw, storeDir);
			tasks.push({ ...task, cwd: typeof task.spawnCwd === "string" ? task.spawnCwd : cwd, parentProjectKey });
		} catch (error) {
			errors.push(`task ${file}: ${error.message}`);
		}
	}
	return tasks;
}

function childOutcome(task, releases) {
	if (task.status === "completed" && task.hasFinalResponse) return { outcome: "answered", reason: "작업이 최종 응답과 함께 완료로 기록되었습니다." };
	if (task.status === "cancelled") return { outcome: "cancelled", reason: "작업 기록의 상태가 취소(cancelled)입니다." };
	if (FAILED_STATUSES.has(task.status)) {
		const detail = task.errorMessage ? `: ${clean(task.errorMessage, 160)}` : ".";
		return { outcome: "failed", reason: `작업이 오류로 끝났습니다${detail}` };
	}
	const release = releases.get(task);
	if (release) return { outcome: "released", reason: `omo-health가 ${release.kind} 조치로 호출을 종료했습니다${Number.isFinite(release.ms) ? ` (${kst(release.ms)})` : ""}.` };
	return { outcome: "unknown", reason: `작업 상태가 ${clean(task.status ?? "없음", 30)}이고 끝난 이유를 알려 줄 기록이 없습니다.` };
}

function startScan(paths, nowMs, days, reconcile) {
	const sinceMs = nowMs - days * DAY_MS;
	const errors = [];

	// Keep only file metadata for the window; parsed transcripts stay in one batch.
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
	if (!reconcile && files.length > MAX_SESSION_FILES) errors.push(`session files capped at ${MAX_SESSION_FILES} of ${files.length}`);
	return {
		sinceMs, liveCutMs: nowMs - LIVE_MS, days, errors,
		sessionFiles: files.length, sessionDirs: slugDirs.length,
		files: reconcile ? files : files.slice(0, MAX_SESSION_FILES),
		census: reconcile && files.length > MAX_SESSION_FILES ? 0 : null,
		cwds: new Map(), cursor: 0, indexes: new Map(), mains: [],
		counts: emptyCounts(), errorCount: 0, reportedErrors: [],
	};
}

function addCwd(cwds, cwd) {
	if (typeof cwd === "string" && cwd) cwds.set(cwd.toLowerCase(), cwd);
}

function emptyCounts() {
	return { main: 0, child: 0, written: 0, duplicate: 0, live: 0, outcomes: {} };
}

/**
 * Reconcile only missing project-scoped rows. Pass the same `progress` object
 * across ticks, with a fresh `maxBytes` allowance for transcripts and
 * records in newly discovered task stores each time. The
 * scan is only in memory; an interrupted append is retried against the ledger.
 */
export function backfillOnce(paths, nowMs, { days = 30, maxBytes = Infinity, progress = {} } = {}) {
	const markerFile = path.join(paths.health.sessionsDir, BACKFILL_MARKER);
	if (!progress.scan) {
		const marker = readJsonSafe(markerFile);
		if (Number(marker?.v) >= BACKFILL_VERSION) return { skipped: true };
		progress.scan = startScan(paths, nowMs, days, marker != null);
	}
	const scan = progress.scan;
	const { files, indexes, mains, errors } = scan;
	const budget = scan.budget ??= {};
	budget.remaining = maxBytes;
	budget.taskSteps = Number.isFinite(maxBytes) ? MAX_SESSION_FILES : Infinity;
	// A child transcript in an early batch can belong to a task store discovered
	// in a later batch. For multi-batch upgrades, discover all task-store cwd
	// values from the heads before classifying any transcript. This pass shares
	// the same byte allowance as the full scan.
	while (scan.census !== null && scan.census < files.length) {
		const item = files[scan.census];
		if (Math.min(item.size, HEAD_BYTES) > budget.remaining) return { pending: true };
		scan.census++;
		try {
			addCwd(scan.cwds, scanSessionFile(item.file, item.size, budget, true).header?.cwd);
		} catch {
			// Report unreadable transcripts in the full scan.
		}
	}
	while (!scan.complete) {
		const batchEnd = scan.batchEnd ??= Math.min(scan.cursor + MAX_SESSION_FILES, files.length);
		while (scan.cursor < batchEnd) {
			const item = files[scan.cursor];
			if (Math.min(item.size, HEAD_BYTES + TAIL_BYTES) > budget.remaining) return { pending: true };
			scan.cursor++;
			try {
				const { header, lastMs: scannedMs, name } = scanSessionFile(item.file, item.size, budget);
				if (!header) {
					errors.push(`bad session header: ${item.file}`);
					continue;
				}
				if (scan.census === null) addCwd(scan.cwds, header.cwd);
				if (!indexes.has(item.dir)) indexes.set(item.dir, readSummaryIndex(item.dir, errors));
				const summary = indexes.get(item.dir).get(header.id);
				const lastMs = scannedMs ?? summary?.lastActivityTime ?? toMs(header.timestamp) ?? item.mtimeMs;
				mains.push({ dir: item.dir, header, lastMs, name, summary });
			} catch (error) {
				errors.push(`session ${item.file}: ${error.message}`);
			}
		}
		if (!scan.related) {
			scan.relatedScan ??= readRelated(paths, scan, budget);
			const step = scan.relatedScan.next();
			if (!step.done) return { pending: true };
			scan.related = step.value;
			delete scan.relatedScan;
		}
		const lastBatch = batchEnd === files.length;
		const batch = writeBatch(paths, nowMs, scan, lastBatch);
		if (batch.pending) return { ...scanSummary(scan, [...errors, ...batch.errors]), pending: true };
		for (const key of ["main", "child", "written", "duplicate", "live"]) scan.counts[key] += batch.counts[key];
		for (const [outcome, count] of Object.entries(batch.counts.outcomes)) {
			scan.counts.outcomes[outcome] = (scan.counts.outcomes[outcome] ?? 0) + count;
		}
		scan.errorCount += errors.length;
		for (const error of errors.slice(0, MAX_REPORTED_ERRORS - scan.reportedErrors.length)) {
			scan.reportedErrors.push(clean(error, 300));
		}
		errors.length = 0;
		mains.length = 0;
		indexes.clear();
		delete scan.batchEnd;
		scan.complete = lastBatch;
	}

	const summary = scanSummary(scan);
	try {
		ensureDir(paths.health.sessionsDir);
		atomicWriteJson(markerFile, { v: BACKFILL_VERSION, ts: nowMs, days: scan.days, counts: scan.counts, errorCount: scan.errorCount });
		delete progress.scan;
	} catch (error) {
		summary.errors.push(clean(`marker: ${error.message}`, 300));
		summary.pending = true;
	}
	return summary;
}

function scanSummary({ sinceMs, sessionFiles, sessionDirs, counts, reportedErrors }, extraErrors = []) {
	return { skipped: false, sinceMs, sessionFiles, sessionDirs, counts,
		errors: [...reportedErrors, ...extraErrors.slice(0, MAX_REPORTED_ERRORS - reportedErrors.length).map((e) => clean(e, 300))] };
}

function* readRelated(paths, { cwds, sinceMs, errors }, budget) {
	const tasks = [];
	const childSubjects = new Set();
	const childCount = new Map();
	const visited = new Set();
	const queue = new Set(cwds.values());
	function remember(t) {
		tasks.push(t);
		if (typeof t.spawnCwd === "string" && t.spawnCwd) queue.add(t.spawnCwd);
		if (t.childSessionId) childSubjects.add(subjectKey({ projectKey: projectKeyOf(t.cwd), sessionId: t.childSessionId }));
		// Parent IDs refer to sessions in the task store's project, not the child's spawn cwd.
		if (t.parentSessionId) {
			const key = subjectKey({ projectKey: t.parentProjectKey, sessionId: t.parentSessionId });
			childCount.set(key, (childCount.get(key) ?? 0) + 1);
		}
	}
	// Process the transcript seed stores first, as before. Extra store visits
	// share the transcript byte allowance and a per-tick metadata step cap.
	let seedCount = queue.size;
	for (const cwd of queue) {
		const taskBudget = seedCount-- > 0 ? undefined : budget;
		if (taskBudget) yield* taskStep(taskBudget);
		const storeDir = paths.agentDir ? senpiTaskStoreDir(cwd, paths.agentDir) : taskStoreDir(cwd);
		const key = pathKey(storeDir);
		if (visited.has(key)) continue;
		visited.add(key);
		for (const task of yield* readTasks(cwd, storeDir, errors, taskBudget)) remember(task);
	}

	return { tasks, childSubjects, childCount, crashes: readCrashes(paths, sinceMs, errors), releases: readReleases(paths, sinceMs, errors, tasks) };
}

function writeBatch(paths, nowMs, { sinceMs, liveCutMs, mains, related }, lastBatch) {
	const { tasks, childSubjects, childCount, crashes, releases } = related;
	const errors = [];
	const counts = emptyCounts();
	const pending = [];
	const write = (record) => {
		counts[record.kind] += 1;
		counts.outcomes[record.outcome] = (counts.outcomes[record.outcome] ?? 0) + 1;
		pending.push(record);
	};

	for (const m of mains) {
		const sessionId = m.header.id;
		const key = subjectKey({ projectKey: projectKeyOf(m.header.cwd), sessionId });
		if (childSubjects.has(key) || m.lastMs < sinceMs) continue;
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
			childCount: childCount.get(key) ?? 0,
			estimated: true,
			source: "backfill",
		});
	}

	for (const t of lastBatch ? tasks : []) {
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
			...(t.parentProjectKey ? { parentProjectKey: t.parentProjectKey } : {}),
			taskId: t.taskId,
			title: clean(t.name ?? t.summary ?? t.taskId, TITLE_MAX) || t.taskId,
			cwd: t.cwd,
			terminal: null,
			omoVersion: null,
			startedMs: t.startedAtMs ?? t.createdAtMs ?? null,
			endedMs,
			outcome,
			reason,
			childCount: childCount.get(subjectKey({ projectKey: projectKeyOf(t.cwd), sessionId: t.childSessionId })) ?? 0,
			estimated: true,
			source: "backfill",
		});
	}

	const childPair = (row) => JSON.stringify([row.sessionId, row.parentSessionId ?? null]);
	const childCandidates = new Map();
	for (const row of pending) {
		if (row.kind !== "child") continue;
		const key = childPair(row);
		const candidates = childCandidates.get(key) ?? [];
		candidates.push(row);
		childCandidates.set(key, candidates);
	}
	// Keep only ledger keys and identity evidence relevant to this batch.
	const wanted = new Set(pending.map(endedKey));
	const recorded = new Set();
	const existingChildren = new Map();
	for (const row of streamEnded(paths, { sinceMs })) {
		const keyOfRow = endedKey(row);
		if (wanted.has(keyOfRow)) recorded.add(keyOfRow);
		if (row.kind !== "child") continue;
		const key = childPair(row);
		if (!childCandidates.has(key)) continue;
		existingChildren.set(key, existingChildren.has(key) ? null : {
			projectKey: subjectOf(row).projectKey, parentProjectKey: row.parentProjectKey, taskId: row.taskId,
		});
	}
	const matches = (existing, candidate) =>
		(!existing.projectKey || existing.projectKey === projectKeyOf(candidate.cwd)) &&
		(!existing.parentProjectKey || existing.parentProjectKey === candidate.parentProjectKey) &&
		(!existing.taskId || existing.taskId === candidate.taskId);
	const matchedChildren = new Set();
	for (const [key, existing] of existingChildren) {
		if (!existing) continue;
		const matchesForPair = childCandidates.get(key).filter((row) => matches(existing, row));
		if (matchesForPair.length === 1) matchedChildren.add(matchesForPair[0]);
	}
	counts.duplicate += matchedChildren.size;
	const missing = pending.filter((row) => !matchedChildren.has(row));
	let appendFailed = false;
	for (const [i, { appended, error }] of appendEndedBatch(paths, missing, { nowMs, recorded }).entries()) {
		if (error) {
			appendFailed = true;
			errors.push(`append ${missing[i].sessionId}: ${error.message}`);
		} else if (appended) counts.written += 1;
		else counts.duplicate += 1;
	}
	return { counts, errors, pending: appendFailed };
}
