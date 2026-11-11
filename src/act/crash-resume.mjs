import path from "node:path";
import { removeHeartbeat } from "../collect/crashes.mjs";
import { pathKey } from "../paths.mjs";
import { readJsonSafe } from "../util/fsx.mjs";
import { composeCrashResumeNotice } from "./messages.mjs";
import { answerResumeChooser, CRASH_RESUME_PROMPT, createHerdrCli, resumeInNewTab } from "./terminal.mjs";

/** Remedies of D18 host crashes (issue #46), run by the engine. */
export const CRASH_ACTIONS = new Set(["crash-resume", "crash-cleanup", "crash-notice", "crash-answer"]);

function safeSegment(value) {
	return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

function nameOf(cwd) {
	return path.basename(String(cwd ?? "?").replace(/[\\/]+$/, "")) || "omo";
}

/**
 * crash-cleanup: remove the leftover heartbeat(s) once the outcome is recorded.
 * crash-resume:  re-check that the host is still gone and its heartbeat unchanged, reopen the session in a new herdr
 *                tab (src/act/terminal.mjs) with a prompt that starts its turn (#109), then remove the heartbeat. A launch waits in memory.pending for the new
 *                sensor; a refusal goes to memory.stopped, which D18 turns into one human-needed toast.
 * crash-notice:  the new sensor is up: one notice to the resumed session, never starting a turn.
 * crash-answer:  launched, no run yet (omo 5.1.65+ "Resume blocked goal?"): read the pane D18 created and press Enter
 *                once this session's host runs there and the chooser shows "Resume goal" highlighted; until then look
 *                again next tick.
 * ctx: { paths, config, memory (D18 memory), now, snapshot: async () => ProcessTable, deliver, actors: { resume?, herdr? } }
 */
export async function performCrashAction(req, finding, record, world, ctx) {
	const { paths, config, memory, now } = ctx;
	const sessionId = finding.subject?.sessionId;
	const d = finding.data ?? {};
	record.remedyDone = true;
	if (req.kind === "crash-cleanup") {
		const list = d.heartbeats ?? [{ sessionId, pid: d.pid, ts: d.hbTs }];
		const removed = list.filter((hb) => removeHeartbeat(paths, hb)).length;
		record.history.push({ atMs: now, kind: req.kind, status: removed ? "execute" : "no-effect", detail: `${d.outcome ?? finding.kind}: removed ${removed}/${list.length} heartbeat file(s)` });
		return { removed };
	}
	if (req.kind === "crash-notice") {
		const message = composeCrashResumeNotice({ sessionId, now, crashPid: d.crashPid, crashTs: d.crashTs, lostTasks: d.lostTasks, idle: d.idle });
		const delivery = ctx.deliver(world, sessionId, message, finding, record, { selfOnly: true });
		if (delivery.delivered) delete memory.pending?.[sessionId];
		record.history.push({ atMs: now, kind: req.kind, status: delivery.delivered ? "delivered" : "not-delivered", detail: `${delivery.via} -> ${sessionId} (${message.deliverAs})` });
		return { delivery };
	}
	if (req.kind === "crash-answer") {
		const pending = memory.pending?.[sessionId];
		if (!pending?.terminal || pending.answeredMs !== undefined || pending.answerRefused || pending.terminal.paneId !== d.paneId) {
			record.history.push({ atMs: now, kind: req.kind, status: "skipped", detail: "no launch waiting for an answer" });
			return { skipped: "not-pending" };
		}
		const table = await ctx.snapshot();
		const answer = (ctx.actors?.answerChooser ?? answerResumeChooser)({ terminal: pending.terminal, sessionId, table, cli: ctx.actors?.herdr ?? createHerdrCli() });
		if (Number.isFinite(answer.hostPid)) pending.hostPid = answer.hostPid;
		if (answer.state === "sent") pending.answeredMs = now;
		// The chooser moved off "Resume goal" (a person is choosing): never press anything; the stop notice follows at startupMs.
		else if (answer.state === "not-default") pending.answerRefused = answer.state;
		else {
			// No host of this session in that pane yet, no chooser on screen yet, or herdr failed: look again next tick.
			record.remedyDone = false;
			record.executed.delete(req.key);
		}
		record.history.push({ atMs: now, kind: req.kind, status: answer.state === "sent" ? "execute" : answer.state, detail: `pane ${pending.paneId}${answer.detail ? ` (${answer.detail})` : ""}` });
		return { answer };
	}
	const hb = { sessionId, pid: d.pid, ts: d.hbTs };
	// The decision is up to a tick old: the host must still be gone and nobody may have reopened the session since.
	const fresh = await ctx.snapshot();
	if (fresh?.isAlive?.(d.pid)) {
		record.history.push({ atMs: now, kind: req.kind, status: "skipped", detail: `host pid ${d.pid} is alive` });
		return { outcome: { ok: false, reason: "host-alive" } };
	}
	const current = readJsonSafe(path.join(paths.health.sensorsDir, `${safeSegment(sessionId)}.json`));
	if (current?.pid !== d.pid || current?.ts !== d.hbTs) {
		record.history.push({ atMs: now, kind: req.kind, status: "skipped", detail: "the heartbeat changed: the session was reopened" });
		return { outcome: { ok: false, reason: "heartbeat-changed" } };
	}
	let outcome;
	if (now - d.hbTs > config.crashResume.maxAgeMs) outcome = { ok: false, reason: "expired" };
	else {
		// A daemon on a non-default home (sandbox, canary) must hear from the resumed sensor too; herdr tabs do not inherit a workspace's env.
		const env = pathKey(paths.healthHome) === pathKey(path.join(paths.home, ".omo-health")) ? {} : { OMO_HEALTH_HOME: paths.healthHome };
		outcome = await (ctx.actors?.resume ?? resumeInNewTab)({ terminal: d.terminal, cwd: d.cwd, sessionId, prompt: CRASH_RESUME_PROMPT, label: `${nameOf(d.cwd)} (resumed)`, env, cli: ctx.actors?.herdr ?? createHerdrCli() });
	}
	if (outcome.ok) {
		memory.resumes[sessionId] = [...(memory.resumes[sessionId] ?? []), now];
		memory.pending[sessionId] = { crashPid: d.pid, crashTs: d.hbTs, launchedMs: now, cwd: d.cwd, tabId: outcome.tabId, paneId: outcome.paneId, terminal: { ...d.terminal, tabId: outcome.tabId, paneId: outcome.paneId }, lostTasks: d.lostTasks ?? [] };
	} else if (outcome.reason === "expired" || (outcome.reason === "pane-gone" && !d.senpi)) {
		// Expired: too old to reopen unasked. Pane gone without any senpi crash trace: the operator closed it
		// (senpi removes its live marker on a close signal), so there is nothing to ask a human about.
	} else {
		memory.stopped[sessionId] = { atMs: now, reason: outcome.reason, cwd: d.cwd, pid: d.pid };
	}
	const removed = removeHeartbeat(paths, hb);
	record.history.push({
		atMs: now,
		kind: req.kind,
		status: outcome.ok ? "execute" : `failed:${outcome.reason}`,
		detail: `${outcome.ok ? `new tab ${outcome.tabId} pane ${outcome.paneId}: ${outcome.command}` : `${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`}; heartbeat removed: ${removed}`,
	});
	return { outcome };
}
