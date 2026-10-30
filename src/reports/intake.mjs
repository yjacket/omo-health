import fs from "node:fs";
import path from "node:path";
import { SEVERITY_RANK } from "../detect/finding.mjs";
import { resolveSubject } from "../diagnose.mjs";
import { atomicWriteJson, ensureDir, listDirSafe, readJsonSafe, removeSafe } from "../util/fsx.mjs";
import { redact, sha1, truncate } from "../util/text.mjs";

/**
 * Report intake (issue #60): `omo-health report` and the sensor's `/health report` queue one file per report in
 * `paths.health.intakeDir`; the daemon judges them in order and keeps each outcome in `processed/`. This module owns
 * the queue, the dedupe, the hourly cap and the daemon's acceptance, which hands each recorded report to the engine's triage.
 */

const HOUR = 60 * 60_000;

/** Reports from `omo-health report` and `/health report` (issue #60): the same subject and words count once an hour. */
export const REPORT_DEDUPE_MS = HOUR;
/** An agent stuck in a loop must not flood incidents, and through them issues. */
export const REPORTS_PER_HOUR = 10;
export const REPORT_TEXT_MAX = 2000;
const REPORT_KEEP_MS = 7 * 24 * HOUR;
const REPORT_KEEP_FILES = 500;
const SUBJECT_RE = /^[A-Za-z0-9_-]{4,80}$/;
export const REPORT_NAME_RE = /^\d+-.+\.json$/;

export const processedDir = (paths) => path.join(paths.health.intakeDir, "processed");
const byTime = (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || (a < b ? -1 : a > b ? 1 : 0);

/** Same subject, same words (case and spacing aside): what a duplicate report shares. */
export function reportKey(report) {
	return sha1(`${report.subject}|${String(report.text ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`).slice(0, 16);
}

export function reportProblem(report) {
	if (!report || typeof report !== "object") return "unreadable report";
	if (!SUBJECT_RE.test(String(report.subject ?? ""))) return "the subject must be a task id or a session id";
	if (typeof report.text !== "string" || !report.text.trim()) return "the report has no text";
	return null;
}

/** Report files of a directory, oldest first (names start with the report time). */
export function readReports(dir) {
	return listDirSafe(dir)
		.filter((name) => REPORT_NAME_RE.test(name))
		.sort(byTime)
		.map((name) => ({ name, report: readJsonSafe(path.join(dir, name)) }));
}

/**
 * What happens to a report given the reports before it (`recent`: processed ones, plus queued ones when the CLI asks):
 * an identical recorded or queued one within REPORT_DEDUPE_MS makes it a duplicate, and REPORTS_PER_HOUR recorded or
 * queued within the hour rate-limit it.
 */
export function reportOutcome(report, recent, now) {
	const counted = recent.filter((r) => r.outcome === undefined || r.outcome === "recorded");
	const key = reportKey(report);
	if (counted.some((r) => now - (r.processedMs ?? r.atMs) <= REPORT_DEDUPE_MS && reportKey(r) === key)) return "duplicate";
	if (counted.filter((r) => now - (r.processedMs ?? r.atMs) <= HOUR).length >= REPORTS_PER_HOUR) return "rate-limited";
	return "recorded";
}

/**
 * Queue one report for the daemon (`omo-health report`; the sensor writes the same file itself). Only the daemon writes
 * incidents (G05), so this checks duplicates and the hourly cap early for a prompt answer and leaves the rest to it.
 * @returns {{ok: boolean, outcome: "queued"|"duplicate"|"rate-limited"|"invalid", report: object, file?: string, problem?: string}}
 */
export function queueReport(paths, { subject, text, via, reporterSessionId = null, now = Date.now() }) {
	const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const report = { v: 1, id, atMs: now, via, subject: String(subject ?? ""), reporterSessionId, text: truncate(redact(String(text ?? "").trim()), REPORT_TEXT_MAX) };
	const problem = reportProblem(report);
	if (problem) return { ok: false, outcome: "invalid", problem, report };
	const recent = [...readReports(processedDir(paths)), ...readReports(paths.health.intakeDir)].map((entry) => entry.report).filter(Boolean);
	const outcome = reportOutcome(report, recent, now);
	if (outcome !== "recorded") return { ok: false, outcome, report };
	const file = path.join(paths.health.intakeDir, `${now}-${id}.json`);
	atomicWriteJson(file, report);
	return { ok: true, outcome: "queued", report, file };
}

/**
 * Retention of `processed/`: records older than a week go, and over the file cap the oldest go first (#82), except a
 * record the hourly cap still counts: recorded within the last hour (reportOutcome ignores duplicate, rate-limited and
 * invalid ones). Trimming a counted one would reopen the cap; there are at most REPORTS_PER_HOUR of them, so the
 * directory stays within REPORT_KEEP_FILES + that.
 */
export function trimProcessed(paths, atMs) {
	const dir = processedDir(paths);
	const names = listDirSafe(dir).filter((name) => REPORT_NAME_RE.test(name)).sort(byTime);
	const old = names.filter((name) => atMs - Number.parseInt(name, 10) > REPORT_KEEP_MS);
	const rest = names.filter((name) => !old.includes(name));
	const overflow = [];
	let excess = rest.length - REPORT_KEEP_FILES;
	for (const name of rest) {
		if (excess <= 0) break;
		const record = readJsonSafe(path.join(dir, name));
		if (record && (record.outcome === undefined || record.outcome === "recorded") && atMs - (record.processedMs ?? record.atMs ?? Number.parseInt(name, 10)) <= HOUR) continue;
		overflow.push(name);
		excess -= 1;
	}
	for (const name of [...old, ...overflow]) removeSafe(path.join(dir, name));
}

/** Current findings about the subject a report names, most severe first: its session, its task, and a named session's subagents. */
function subjectFindings(world, findings, id) {
	const found = resolveSubject(world, id);
	const ids = new Set([id, found?.session?.id, found?.task?.taskId].filter(Boolean));
	return findings.filter((f) => ids.has(f.subject?.sessionId) || ids.has(f.subject?.taskId) || ids.has(f.subject?.parentSessionId)).sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

/** The session and task a report names, as the engine's report triage delivers to them (#60 item 5). */
function reportSubject(world, id) {
	const found = resolveSubject(world, id);
	if (!found) return null;
	const { session, task } = found;
	return {
		sessionId: session?.id ?? task?.childSessionId ?? null,
		taskId: task?.taskId ?? session?.taskId ?? null,
		parentSessionId: session?.parentSessionId ?? task?.parentSessionId ?? null,
		rootSessionId: session?.rootSessionId ?? null,
		kind: session?.kind ?? (task ? "child" : null),
		cwd: session?.cwd ?? null,
	};
}

/**
 * Daemon side of the report queue: judge each queued report in order and keep its outcome in `processed/`. The
 * processed file claims a report first, so a retry never accepts it twice; a claim that cannot be written leaves the
 * report queued for the next tick, and a claim whose queue file outlived it only needs that file removed. Reports need
 * the tick's world to find their subject; without one (a failed tick) they wait.
 * @returns {{failures: {id: string, subject: string|null, error: string}[], accepted: {report: object, snapshot: string|null, subject: object|null, top: object|undefined}[]}}
 */
export function acceptReports({ paths, atMs, tickResult, capture }) {
	const failures = [];
	const accepted = [];
	if (!tickResult?.world) return { failures, accepted };
	const queued = readReports(paths.health.intakeDir);
	if (!queued.length) return { failures, accepted };
	const dir = processedDir(paths);
	const recent = readReports(dir).map((entry) => entry.report).filter(Boolean);
	for (const { name, report: queuedReport } of queued) {
		// The sensor queues `/health report` text unredacted (it imports only node built-ins, with a margin past the cap):
		// redact, then cut, before the text reaches processed/ or the triage (#82).
		const report = typeof queuedReport?.text === "string" ? { ...queuedReport, text: truncate(redact(queuedReport.text), REPORT_TEXT_MAX) } : queuedReport;
		const queuedFile = path.join(paths.health.intakeDir, name);
		const claim = path.join(dir, name);
		if (fs.existsSync(claim)) {
			removeSafe(queuedFile);
			continue;
		}
		const record = { ...(report && typeof report === "object" ? report : {}), processedMs: atMs };
		record.outcome = reportProblem(report) ? "invalid" : reportOutcome(report, recent, atMs);
		const recorded = record.outcome === "recorded";
		const top = recorded ? subjectFindings(tickResult.world, tickResult.findings ?? [], report.subject)[0] : undefined;
		if (recorded) {
			record.snapshot = null;
			try {
				record.snapshot = capture ? capture(tickResult.world, report.subject, { kind: "report", reportId: report.id, via: report.via, text: report.text }) : null;
			} catch (error) {
				// The report still counts; the record says why its evidence is missing.
				record.snapshotError = error.message;
			}
		}
		try {
			atomicWriteJson(claim, record);
		} catch (error) {
			failures.push({ id: record.id ?? name, subject: record.subject ?? null, error: error.message });
			continue;
		}
		if (recorded) accepted.push({ report, snapshot: record.snapshot, subject: reportSubject(tickResult.world, report.subject), top });
		recent.push(record);
		removeSafe(queuedFile);
	}
	trimProcessed(paths, atMs);
	return { failures, accepted };
}

/**
 * One-time import of an intake directory from the old layout (the daemon names it): queued reports join the
 * queue and processed records join `processed/` (so the dedupe and the hourly cap still see them), a name already
 * present wins, and the legacy directory is removed. Returns how many files were imported.
 */
export function importLegacyIntake(paths, legacyDir) {
	if (!fs.existsSync(legacyDir)) return 0;
	let imported = 0;
	const move = (from, toDir) => {
		for (const { name } of readReports(from)) {
			const target = path.join(toDir, name);
			if (fs.existsSync(target)) continue;
			ensureDir(toDir);
			fs.renameSync(path.join(from, name), target);
			imported++;
		}
	};
	move(path.join(legacyDir, "processed"), processedDir(paths));
	move(legacyDir, paths.health.intakeDir);
	fs.rmSync(legacyDir, { recursive: true, force: true });
	return imported;
}
