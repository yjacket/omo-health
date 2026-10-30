import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";
import { readParkRecords, validateParkRecord } from "../collect/parks.mjs";
import { pathKey } from "../paths.mjs";
import { atomicWriteJson, readJsonSafe, removeSafe } from "../util/fsx.mjs";
import { launchInOrca } from "./orca-launch.mjs";
import { createHerdrCli, resumeInNewTab } from "./terminal.mjs";

/**
 * park-resume (D20, plan limit-parking todo 11): relaunch `omo --session <sid>` for a usage-limit park record that
 * omo-limitless wrote before it shut the session down, once the limit has reset.
 *
 * Record lifecycle: pending -> claimed -> launched -> completed, or failed / superseded. omo-limitless writes a record
 * once; after that omo-health is its only writer, always by the episode's exact file name. The relaunched session's
 * only signal is its ack file `<sid>.<createdAt>.ack.json` ({v:1, parkId, sessionId, pid, at}).
 *
 * Every tick, for each unfinished record of kind herdr/orca/unknown:
 *   1. ack with the same parkId                        -> completed (with ack)
 *   (a pending record that is not due yet, now < resetAt + 60 s, gets no other step and no write)
 *   2. live heartbeat for the sid                      -> completed, reason already-live
 *   2a. a live process whose command has --session sid -> a launch is in flight: leave the record
 *   2c. ... and that process is older than 15 min      -> failed: hung-start, one toast, the process is not killed
 *   claimed older than 2 min / launched older than 5 min -> pending again (the attempt is used up); before the retry
 *   2b. an idle leftover launch terminal is closed.
 *   3. pending and due (resetAt + 60 s): claim, launch, then launched or pending with lastError. 3 attempts at most,
 *      then failed: relaunch-exhausted with one toast. The D18 hourly cap (crashResume.perHour, shared with D18
 *      resumes) leaves a due record pending with lastError "rate-capped", which is not an attempt.
 * Kind "self" (relaunched by omo-limitless's own scheduled task) is only housekept; kind "unknown" fails
 * (no-launcher) with one toast. Finished records and their ack files are deleted after 7 days.
 */
export const PARK_ACTIONS = new Set(["park-resume"]);

const MIN = 60_000;
export const PARK_TIMING = Object.freeze({ graceMs: MIN, claimedMs: 2 * MIN, launchedMs: 5 * MIN, hungStartMs: 15 * MIN, keepMs: 7 * 24 * 60 * MIN, maxAttempts: 3 });
const HOUR_MS = 60 * MIN;
const UNFINISHED = new Set(["pending", "claimed", "launched"]);
const FINISHED = new Set(["completed", "failed", "superseded"]);

const REASON_KO = {
	"relaunch-exhausted": "3번 다시 띄웠지만 세션이 올라오지 않음",
	"hung-start": "재개한 세션이 15분 넘게 시작을 끝내지 못함",
	"no-launcher": "다시 띄울 터미널(Orca, herdr)을 모름",
};

export function ackFileOf(file) {
	return file.replace(/\.park\.json$/, ".ack.json");
}

/** True when an episode still needs omo-health: an unfinished record that omo-health relaunches (not kind self). */
export function isUnfinishedPark(record) {
	return Boolean(record) && UNFINISHED.has(record.status) && record.terminal?.kind !== "self";
}

/** Daemon idle exit guard: a park record omo-health still has to relaunch keeps the daemon alive. */
export function hasPendingParks(paths) {
	return readParkRecords(paths).some(({ record }) => validateParkRecord(record).ok && isUnfinishedPark(record));
}

/** Session ids D18 must leave alone: they have an unfinished park episode (pending/claimed/launched). */
export function parkedSessionIds(parkRecords) {
	const ids = new Set();
	for (const { file, record } of parkRecords ?? []) {
		const selfPending = record?.terminal?.kind === "self" && UNFINISHED.has(record.status) && !readAck(file, record);
		if ((isUnfinishedPark(record) || selfPending) && typeof record.sessionId === "string") ids.add(record.sessionId);
	}
	return ids;
}

function sessionPattern(sessionId) {
	return new RegExp(`--session[\\s=]+["']?${sessionId.replace(/[^A-Za-z0-9-]/g, "\\$&")}(?![A-Za-z0-9-])`);
}

/** Live processes whose command line names `--session <sid>`; undefined when the process table cannot be trusted. */
function sessionProcesses(world, sessionId) {
	if (!world.procsFresh) return undefined;
	const pattern = sessionPattern(sessionId);
	return world.procs.all().filter((proc) => pattern.test(String(proc.cmd ?? "")));
}

function liveHeartbeat(world, sessionId) {
	const hb = world.sensorFor?.(sessionId);
	if (!hb) return undefined;
	if (world.procsFresh && Number.isFinite(hb.pid) && !world.procs.isAlive(hb.pid) && !world.liveHostPids?.has(hb.pid)) return undefined;
	return hb;
}

function readAck(file, record) {
	const ack = readJsonSafe(ackFileOf(file));
	return ack && ack.parkId === record.parkId ? ack : undefined;
}

function herdrTerminal(terminal) {
	return { ...(terminal?.herdr ?? {}), ...terminal, kind: "herdr", workspaceId: terminal?.workspaceId ?? terminal?.herdr?.workspaceId, paneId: terminal?.paneId ?? terminal?.herdr?.paneId ?? terminal?.herdr?.pane };
}

function nameOf(cwd) {
	return path.basename(String(cwd ?? "?").replace(/[\\/]+$/, "")) || "omo";
}

/** Default launchers: herdr through the D18 new-tab path, Orca through `orca terminal create` (todo 12). */
export function defaultLaunchers({ paths, herdrCli, orcaDeps } = {}) {
	return {
		herdr: async (record) => {
			const env = paths && pathKey(paths.healthHome) !== pathKey(path.join(paths.home, ".omo-health")) ? { OMO_HEALTH_HOME: paths.healthHome } : {};
			const outcome = await resumeInNewTab({ terminal: herdrTerminal(record.terminal), cwd: record.cwd, sessionId: record.sessionId, label: `${nameOf(record.cwd)} (resumed)`, env, cli: herdrCli ?? createHerdrCli() });
			return outcome.ok ? { ...outcome, handle: outcome.tabId } : outcome;
		},
		// launchInOrca applies qaCommandPrefix only when the daemon runs with OMO_HEALTH_QA=1.
		orca: async (record) => launchInOrca({ cwd: record.cwd ?? record.terminal?.orca?.cwd, sessionId: record.sessionId, qaCommandPrefix: record.qaCommandPrefix }, orcaDeps),
	};
}

function orcaCall(args, { spawnSync = nodeSpawnSync, env = process.env } = {}) {
	const r = spawnSync(env.ORCA_CLI_COMMAND || "orca", args, { encoding: "utf8", windowsHide: true, timeout: 15_000, env, stdio: ["ignore", "pipe", "pipe"] });
	return !r?.error && r?.status === 0;
}

/**
 * Default terminal handles for 2b. Only a handle this daemon's own launch returned is ever closed; a missing handle
 * closes nothing (`orca terminal close` without --terminal would close the active terminal).
 */
export function defaultTerminals({ herdrCli, spawnSync, env } = {}) {
	return {
		exists(launch) {
			if (typeof launch?.handle !== "string" || !launch.handle) return false;
			if (launch.kind === "orca") return orcaCall(["terminal", "show", "--terminal", launch.handle, "--json"], { spawnSync, env });
			if (launch.kind === "herdr" && typeof launch.paneId === "string") return (herdrCli ?? createHerdrCli()).call(launch.terminal, ["pane", "get", launch.paneId]).ok;
			return false;
		},
		close(launch) {
			if (typeof launch?.handle !== "string" || !launch.handle) return false;
			if (launch.kind === "orca") return orcaCall(["terminal", "close", "--terminal", launch.handle, "--json"], { spawnSync, env });
			if (launch.kind === "herdr") return (herdrCli ?? createHerdrCli()).call(launch.terminal, ["tab", "close", launch.handle]).ok;
			return false;
		},
	};
}

/**
 * Run the park lifecycle for one tick.
 * ctx: { paths, config, now, world (procs, procsFresh, sensorFor, liveHostPids), parkRecords ([{file, record, mtimeMs, name}]),
 *        memory (D18 memory: resumes[sid] is the shared hourly cap), gate(req, sessionId) -> verdict,
 *        launchers {herdr, orca}, terminals {exists, close}, notifier {toast}, decide(entry), log }
 * Returns the list of transitions made, for tests and the decision log.
 */
export async function runParkLifecycle(ctx) {
	const { now } = ctx;
	const out = [];
	const write = (entry, next, why) => {
		const prev = entry.record.status;
		entry.record = { ...next, updatedAt: now, ...(FINISHED.has(next.status) && !FINISHED.has(prev) ? { finishedAt: now } : {}) };
		atomicWriteJson(entry.file, entry.record);
		const t = { parkId: next.parkId, sessionId: next.sessionId, from: prev, to: next.status, why };
		out.push(t);
		ctx.decide?.({ detector: "D20", kind: "park-resume", event: "park-transition", subject: { sessionId: next.sessionId }, ...t });
	};
	const toast = (record, reason) => {
		const title = `omo-health: 사용량 한도 재개 실패: ${nameOf(record.cwd)}`;
		const body = `${REASON_KO[reason] ?? reason}. 터미널에서 직접 이어 가세요: omo --session ${record.sessionId}`;
		return ctx.notifier?.toast({ title, body, tag: `park-${record.parkId}` });
	};
	const fail = async (entry, reason, extra = {}) => {
		write(entry, { ...entry.record, ...extra, status: "failed", reason, notified: true }, reason);
		try {
			await toast(entry.record, reason);
		} catch (error) {
			ctx.log?.warn?.("park_notification_failed", { parkId: entry.record.parkId, reason, error: String(error?.message ?? error) });
		}
	};

	const entries = [];
	for (const entry of ctx.parkRecords ?? []) {
		// Re-read: the tick's snapshot may be older than this daemon's own last write.
		const record = readJsonSafe(entry.file);
		if (validateParkRecord(record).ok) entries.push({ ...entry, record });
	}

	// Housekeeping: finished records (and self records, which omo-health never relaunches) go after 7 days, ack too.
	for (const entry of entries) {
		let { record } = entry;
		if (record.terminal?.kind === "self" && UNFINISHED.has(record.status)) {
			const ack = readAck(entry.file, record);
			if (ack) {
				write(entry, { ...record, status: "completed", ack }, "ack");
				record = entry.record;
			}
		}
		const since = record.terminal?.kind === "self" ? Math.max(record.resetAt, record.createdAt) : (record.finishedAt ?? record.updatedAt ?? entry.mtimeMs);
		if ((FINISHED.has(record.status) || record.terminal?.kind === "self") && now - since > PARK_TIMING.keepMs) {
			removeSafe(entry.file);
			removeSafe(ackFileOf(entry.file));
			entry.removed = true;
			out.push({ parkId: record.parkId, sessionId: record.sessionId, from: record.status, to: "deleted", why: "keep-expired" });
		}
	}
	const live = entries.filter((e) => !e.removed && isUnfinishedPark(e.record));

	// Step 1 first for every episode, so an acked older episode completes instead of being superseded.
	for (const entry of live) {
		const ack = readAck(entry.file, entry.record);
		if (ack) write(entry, { ...entry.record, status: "completed", ack }, "ack");
	}
	// Only the newest unfinished episode per session is actionable; older ones are never launched.
	const bySession = new Map();
	for (const entry of live) {
		if (!UNFINISHED.has(entry.record.status)) continue;
		const list = bySession.get(entry.record.sessionId) ?? [];
		list.push(entry);
		bySession.set(entry.record.sessionId, list);
	}
	for (const list of bySession.values()) {
		list.sort((a, b) => b.record.createdAt - a.record.createdAt);
		for (const older of list.slice(1)) write(older, { ...older.record, status: "superseded", supersededBy: list[0].record.parkId }, "superseded");
		await advance(list[0]);
	}
	return out;

	async function advance(entry) {
		const sid = entry.record.sessionId;
		// A pending record that is not due yet is left untouched: the parking session writes it before it shuts down,
		// so its own heartbeat may still be live and must not complete the episode.
		if (entry.record.status === "pending" && now < entry.record.resetAt + PARK_TIMING.graceMs) return undefined;
		if (liveHeartbeat(ctx.world, sid)) return write(entry, { ...entry.record, status: "completed", reason: "already-live" }, "already-live");
		const procs = sessionProcesses(ctx.world, sid);
		// No trustworthy process table: nothing proves the session is not starting, so no launch this tick.
		if (!procs) return undefined;
		if (procs.length) {
			const started = Math.min(...procs.map((p) => (p.ctimeMs > 0 ? p.ctimeMs : now)));
			if (now - started > PARK_TIMING.hungStartMs) return fail(entry, "hung-start", { hungPids: procs.map((p) => p.pid) });
			return undefined;
		}
		const { record } = entry;
		if (record.status === "claimed") {
			if (now - (record.claim?.at ?? 0) <= PARK_TIMING.claimedMs) return undefined;
			write(entry, { ...record, status: "pending", attempt: record.claim?.attempt ?? (record.attempt ?? 0) + 1, lastError: "claim-lost" }, "claim-stale");
		} else if (record.status === "launched") {
			if (now - (record.launch?.at ?? 0) <= PARK_TIMING.launchedMs) return undefined;
			let closed;
			if (record.launch?.handle && ctx.terminals.exists(record.launch)) closed = ctx.terminals.close(record.launch);
			write(entry, { ...record, status: "pending", attempt: record.claim?.attempt ?? (record.attempt ?? 0) + 1, lastError: "no-ack", ...(closed !== undefined ? { closedHandle: { handle: record.launch.handle, ok: closed } } : {}) }, "launch-stale");
		}
		return launchPending(entry);
	}

	async function launchPending(entry) {
		const record = entry.record;
		const sid = record.sessionId;
		if (now < record.resetAt + PARK_TIMING.graceMs) return undefined;
		const used = record.attempt ?? 0;
		if (used >= PARK_TIMING.maxAttempts) return fail(entry, "relaunch-exhausted");
		if (record.terminal.kind === "unknown") return fail(entry, "no-launcher");
		const memory = ctx.memory;
		const verdict = ctx.gate({ key: `park-resume:${record.parkId}:${used + 1}`, kind: "park-resume", fp: record.parkId, step: used + 1 }, sid);
		if (verdict !== "execute") {
			// Switched off, paused or shadow: the record stays pending untouched; the verdict is logged once.
			memory.parkGated ??= {};
			if (memory.parkGated[record.parkId] !== verdict) {
				memory.parkGated[record.parkId] = verdict;
				ctx.decide?.({ detector: "D20", kind: "park-resume", event: "park-gated", subject: { sessionId: sid }, parkId: record.parkId, result: verdict });
			}
			return undefined;
		}
		if (memory.parkGated) delete memory.parkGated[record.parkId];
		memory.resumes ??= {};
		const recent = (memory.resumes[sid] ?? []).filter((ms) => now - ms < HOUR_MS);
		if (recent.length >= (ctx.config.crashResume?.perHour ?? 2)) {
			if (record.lastError !== "rate-capped") write(entry, { ...record, lastError: "rate-capped" }, "rate-capped");
			return undefined;
		}
		const attempt = used + 1;
		const claim = { at: now, attemptId: `${record.parkId}#${attempt}`, attempt };
		write(entry, { ...record, status: "claimed", claim }, "claim");
		const kind = record.terminal.kind;
		let result;
		try {
			const launcher = ctx.launchers[kind];
			result = launcher ? await launcher(entry.record) : { ok: false, reason: "no-launcher" };
		} catch (error) {
			result = { ok: false, reason: "launcher-threw", detail: String(error?.message ?? error) };
		}
		if (result?.ok) {
			memory.resumes[sid] = [...(memory.resumes[sid] ?? []), now];
			const launch = { at: now, kind, attempt, handle: result.handle, ...(result.tabId ? { tabId: result.tabId, paneId: result.paneId, terminal: herdrTerminal(record.terminal) } : {}) };
			return write(entry, { ...entry.record, status: "launched", attempt, launch, lastError: undefined }, "launched");
		}
		ctx.log?.warn?.("park_launch_failed", { parkId: record.parkId, reason: result?.reason, detail: result?.detail });
		return write(entry, { ...entry.record, status: "pending", attempt, lastError: `${result?.reason ?? "launch-failed"}${result?.detail ? `: ${result.detail}` : ""}` }, "launch-failed");
	}
}
