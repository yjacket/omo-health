import fs from "node:fs";
import path from "node:path";
import { procKey } from "./collect/procs.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import { commandText } from "./collect/sessions.mjs";
import { diagnose, resolveSubject } from "./diagnose.mjs";
import { atomicWriteJson, listDirSafe, readJsonSafe, removeSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * Instant evidence snapshots (issue #60): the process tree, pending calls and recent transcript events are gone within
 * minutes, long before a person or a model looks. When a report arrives or a finding that can stop subagent work opens,
 * the daemon writes what it sees now to `<health>/snapshots/<ms>-<reason>-<subject>.json`, then samples the subject's
 * output files for a minute so the snapshot shows whether they still grow. No model is called.
 */

/** Detectors whose opening means subagent work may have stopped (the footer's set) plus D17 relaunch loops. */
export const SNAPSHOT_DETECTORS = new Set(["D1", "D2", "D5", "D8", "D10", "D17"]);
export const SNAPSHOT_KEEP_FILES = 200;
export const SNAPSHOT_KEEP_MS = 7 * 24 * 3600_000;
const FOLLOW_MS = 60_000;
/** A finding that flaps (resolves and reopens) snapshots at most this often. */
const REFIRE_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const MAX_LINEAGE = 200;
const EVENT_COUNT = 30;
const TAIL_BYTES = 256 * 1024;
const EVAL_SECRET_LINE = /(api[_-]?key|token|secret|passw(or)?d|authorization|cookie)\s*[:=]/i;
const MB = 1024 * 1024;

const safeName = (value) => String(value ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);

/** The last transcript entries of a session file, reduced to what an investigator reads first (no tool output bodies). */
export function recentEvents(file, count = EVENT_COUNT) {
	const st = statSafe(file);
	if (!st?.isFile()) return [];
	const length = Math.min(TAIL_BYTES, st.size);
	const buf = Buffer.alloc(length);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buf, 0, length, st.size - length);
	} finally {
		fs.closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	// A read that starts mid-file starts mid-line.
	if (length < st.size) lines.shift();
	const out = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const m = entry.message ?? {};
		const event = { ts: entry.timestamp ?? null, type: entry.type };
		if (entry.type === "message") {
			const content = Array.isArray(m.content) ? m.content : [];
			event.role = m.role;
			const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
			// Redact before truncating: a token cut at the limit can fall below a pattern's minimum length and pass unmasked (#82).
			if (text) event.text = truncate(redact(text), 300);
			const calls = content.filter((item) => item?.type === "toolCall");
			if (calls.length) event.calls = calls.map((call) => ({ id: call.id, name: call.name, command: truncate(redact(commandText(call.name, call.arguments) || JSON.stringify(call.arguments ?? {})), 300) }));
			if (m.role === "toolResult") Object.assign(event, { toolCallId: m.toolCallId, isError: Boolean(m.isError) });
			if (m.stopReason) event.stopReason = m.stopReason;
		} else if (entry.customType) event.customType = entry.customType;
		// The header and model or thinking-level changes say nothing about progress.
		else continue;
		out.push(event);
	}
	return out.slice(-count);
}

/** The session host's ancestors, the host, and everything under it, with the tool call the daemon attributed each to. */
function lineage(world, session) {
	const hostPid = session ? world.shellParentPid(session) : undefined;
	const host = Number.isFinite(hostPid) ? world.procs.get(hostPid) : undefined;
	if (!host) return [];
	const row = (proc, role) => {
		const frac = world.procs.cpuFracs(proc, 1)[0];
		const owner = world.attributed?.get(procKey(proc));
		return { role, pid: proc.pid, ppid: proc.ppid, name: proc.name, ctime: proc.ctime, cpuPct: frac === undefined ? null : Math.round(frac * 100), memMB: Math.round((proc.privBytes ?? 0) / MB), writeBytes: proc.writeBytes ?? null, ...(proc.windowVisible === undefined ? {} : { windowVisible: proc.windowVisible, ...(proc.windowTitle ? { windowTitle: proc.windowTitle } : {}) }), cmd: truncate(redact(proc.cmd), 300), ...(owner ? { owner: { sessionId: owner.sessionId, toolCallId: owner.toolCallId, role: owner.role ?? null } } : {}) };
	};
	return [...world.procs.ancestors(hostPid).reverse().map((proc) => row(proc, "ancestor")), row(host, "host"), ...world.procs.descendants(hostPid).slice(0, MAX_LINEAGE).map((proc) => row(proc, "descendant"))];
}

/** The last bytes of a file as text, or "" when it cannot be read. */
function tailOf(file, maxBytes) {
	const st = statSafe(file);
	if (!st?.isFile()) return { sizeBytes: null, mtimeMs: null, tail: "", truncated: false };
	const length = Math.min(maxBytes, st.size);
	const buf = Buffer.alloc(length);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buf, 0, length, st.size - length);
	} finally {
		fs.closeSync(fd);
	}
	return { sizeBytes: st.size, mtimeMs: st.mtimeMs, tail: buf.toString("utf8"), truncated: length < st.size };
}

/** Secret-looking lines are dropped whole before the tail is redacted (plan todo 8, GAP-13). */
function safeTail(text, truncated) {
	const lines = String(text ?? "").split(/\r?\n/);
	// A read that starts mid-file starts mid-line: the fragment can be the tail of a secret whose key was cut away.
	if (truncated) lines.shift();
	return redact(lines.filter((line) => !EVAL_SECRET_LINE.test(line)).join("\n"));
}

/** The subject session's recent eval-cell and detached-eval logs, newest first. */
function evalLogs(session, now, settings) {
	if (!session?.file) return [];
	const dir = `${session.file.replace(/\.jsonl$/i, "")}-artifacts`;
	if (!statSafe(dir)?.isDirectory()) return [];
	const files = new Set();
	for (const call of session.pending?.values?.() ?? []) {
		if (call?.id) files.add(path.join(dir, "local", `detached-eval-${call.id}.log`));
	}
	const pending = [...(session.pending?.values?.() ?? [])].filter((call) => Number.isFinite(call?.ms));
	const oldestMs = pending.length ? Math.min(...pending.map((call) => call.ms)) : undefined;
	const since = (Number.isFinite(oldestMs) ? oldestMs : now - settings.windowMs) - 5000;
	for (const name of listDirSafe(dir)) {
		if (!/^eval-.*\.log$/.test(name)) continue;
		const file = path.join(dir, name);
		const st = statSafe(file);
		if (st?.isFile() && st.mtimeMs >= since) files.add(file);
	}
	return [...files]
		.map((file) => ({ file, ...tailOf(file, settings.tailBytes) }))
		.filter((entry) => entry.mtimeMs !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, settings.maxFiles)
		.map(({ file, sizeBytes, mtimeMs, tail, truncated }) => ({ file, sizeBytes, mtimeMs, tail: safeTail(tail, truncated) }));
}

const sample = (file, atMs) => {
	const st = statSafe(file);
	return { atMs, size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null };
};

/** Snapshot writer for the daemon: `capture` on a report, `tick(result)` for opened findings and output follow-ups. */
export function createEvidence({ paths, config = DEFAULT_CONFIG }) {
	const dir = paths.health.snapshotsDir;
	const following = new Map();
	/** Capture time of a finding's last snapshot, by the first 8 characters of its fp (the file name carries no more). */
	const lastByFp = new Map();
	let startedMs;
	let prunedMs = Number.NEGATIVE_INFINITY;

	/**
	 * A restarted daemon knows no finding it already snapshotted, so re-opened findings would each snapshot again. The
	 * finding snapshots on disk (`<ms>-finding-<subject>-<fp8>.json`) are the persisted record: read it back once.
	 */
	function seed() {
		for (const name of listDirSafe(dir)) {
			const match = /^(\d+)-finding-.+-([0-9a-f]{8})\.json$/.exec(name);
			if (match) lastByFp.set(match[2], Math.max(lastByFp.get(match[2]) ?? -Infinity, Number(match[1])));
		}
	}

	/** Newest SNAPSHOT_KEEP_FILES within SNAPSHOT_KEEP_MS; names start with the capture time, so they sort by age. */
	function prune(now) {
		prunedMs = now;
		const names = listDirSafe(dir).filter((name) => /^\d+-.+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
		const stale = names.filter((name) => now - Number.parseInt(name, 10) > SNAPSHOT_KEEP_MS);
		const kept = names.filter((name) => !stale.includes(name));
		for (const name of [...stale, ...kept.slice(0, Math.max(0, kept.length - SNAPSHOT_KEEP_FILES))]) {
			removeSafe(path.join(dir, name));
			following.delete(path.join(dir, name));
		}
	}

	/** Write one snapshot of `subjectId` as `world` shows it; returns the file. */
	function capture(world, subjectId, reason) {
		const now = world.now;
		const { session } = resolveSubject(world, subjectId) ?? {};
		const diagnosis = diagnose(world, subjectId);
		const files = [...new Set([session?.file, ...(diagnosis.waitingOn ?? []).flatMap((w) => w.outputs.map((o) => o.file))].filter(Boolean))];
		// The daemon calls createEvidence({ paths }) without config; the world carries the live, reloadable config.
		const settings = world.config?.evalLogs ?? config.evalLogs;
		const snapshot = {
			v: 1,
			atMs: now,
			at: new Date(now).toISOString(),
			reason,
			subject: subjectId,
			diagnosis,
			lineage: lineage(world, session),
			recentEvents: session?.file ? recentEvents(session.file) : [],
			artifacts: { evalLogs: evalLogs(session, now, settings) },
			outputs: files.map((file) => ({ file, samples: [sample(file, now)] })),
		};
		const suffix = reason.fp ? `-${String(reason.fp).slice(0, 8)}` : reason.reportId ? `-${safeName(reason.reportId)}` : "";
		const file = path.join(dir, `${now}-${reason.kind}-${safeName(subjectId)}${suffix}.json`);
		// Same masking as the decision log: command lines and transcript text can carry tokens.
		atomicWriteJson(file, JSON.parse(redact(JSON.stringify(snapshot))));
		following.set(file, { lastMs: now, untilMs: now + FOLLOW_MS });
		prune(now);
		return file;
	}

	/** One sample per tick of every followed snapshot's output files, until a minute after its capture. */
	function followUp(now) {
		for (const [file, entry] of following) {
			if (now <= entry.lastMs) continue;
			const snapshot = readJsonSafe(file);
			if (!snapshot) {
				following.delete(file);
				continue;
			}
			for (const output of snapshot.outputs ?? []) output.samples.push(sample(output.file, now));
			atomicWriteJson(file, snapshot);
			entry.lastMs = now;
			if (now >= entry.untilMs) following.delete(file);
		}
	}

	function tick(result) {
		const world = result?.world;
		if (!world) return;
		// Startup, then every PRUNE_EVERY_MS: old snapshots go even when nothing new is captured.
		if (startedMs === undefined) {
			startedMs = world.now;
			seed();
			prune(world.now);
		} else if (world.now - prunedMs >= PRUNE_EVERY_MS) prune(world.now);
		for (const finding of result.opened ?? []) {
			if (!SNAPSHOT_DETECTORS.has(finding.detector)) continue;
			const subjectId = finding.subject?.taskId ?? finding.subject?.sessionId;
			const key = String(finding.fp).slice(0, 8);
			if (!subjectId || world.now - (lastByFp.get(key) ?? -Infinity) < REFIRE_MS) continue;
			lastByFp.set(key, world.now);
			capture(world, subjectId, { kind: "finding", fp: finding.fp, detector: finding.detector, findingKind: finding.kind, cls: finding.cls ?? null, severity: finding.severity, titleKo: finding.titleKo ?? null });
		}
		for (const [key, atMs] of lastByFp) if (world.now - atMs >= REFIRE_MS) lastByFp.delete(key);
		followUp(world.now);
	}

	return { capture, tick };
}
