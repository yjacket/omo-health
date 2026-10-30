import { procKey } from "../collect/procs.mjs";
import { commandText } from "../collect/sessions.mjs";
import { formatDuration } from "../util/time.mjs";
import { redact, truncate } from "../util/text.mjs";
import { CHILD_WAIT_TOOLS, classifyPending, HUMAN_WAIT_TOOLS, quietHang, redirectPaths, tag } from "./classify.mjs";
import { exePathOf } from "../judge/triage.mjs";
import { makeFinding } from "./finding.mjs";
import { isProtectedProcess, matchPendingCall, programName } from "./match.mjs";

export const id = "D1";

const REAP_MS = 30 * 60_000; // senpi anthropic-subscription idle_ttl (design 1.2)
const WAITING_CLASSES = new Set(["bounded", "progressing", "withheld"]);
/** Bytes a tree must write in one snapshot interval, while using CPU, to count as output (R10's activity floor). */
const OUTPUT_BYTES = 1024;
const DAY_MS = 24 * 3600_000;

export function sessionLabel(session) {
	if (session.kind === "child") {
		const task = session.task;
		const label = task?.summary || task?.description || task?.name || session.taskId;
		return `서브에이전트 ${session.taskId ?? ""}${label && label !== session.taskId ? ` (${truncate(label, 40)})` : ""}`;
	}
	return `세션 ${String(session.id).slice(0, 8)}`;
}

function titleFor(cls, call, c, ageMs, command) {
	const head = truncate(redact(command || call.name), 60);
	const age = formatDuration(ageMs);
	switch (cls) {
		case "memory-runaway":
			return `메모리 폭주: ${head} (${age}째)`;
		case "runaway-readonly":
			return `읽기 명령이 CPU만 쓰며 끝나지 않음: ${head} (${age}째)`;
		case "server-foreground":
			return `포그라운드로 뜬 서버에 도구 호출이 묶임${c.data.ports?.length ? ` (포트 ${c.data.ports.join(", ")})` : ""}: ${head}`;
		case "blocked-on-input":
			return `입력을 기다리며 멈춤: ${head} (${age}째)`;
		case "unbounded-wait":
			return `끝나지 않는 대기 명령: ${head} (${age}째)`;
		case "bounded":
			return `제한 시간이 있는 명령 대기 중: ${head}`;
		case "progressing":
			return `진행 중인 작업 대기: ${head} (${age}째)`;
		case "withheld":
			return `같은 묶음의 다른 호출 때문에 결과 보류: ${head}`;
		case "human-wait":
			return `사용자 답변 대기 ${age}째`;
		case "unknown":
			return `원인을 알 수 없는 멈춤: ${head} (${age}째)`;
		case "quiet-hang":
			return `기록도 출력도 없이 멈춤: ${head} (${formatDuration(call.ms + ageMs - c.data.quietSinceMs)}째 조용함)`;
		default:
			return `도구 호출 응답 없음: ${call.name} (${age}째)`;
	}
}

function detailFor(session, cls, call, c, ageMs) {
	const who = sessionLabel(session);
	const lines = [`${who}의 도구 호출 \`${call.name}\`이(가) ${formatDuration(ageMs)} 동안 결과를 돌려주지 않았습니다.`];
	lines.push(`분류: ${cls} (규칙 ${c.rule.id} v${c.rule.v}, 신뢰도 ${c.confidence}).`);
	if (c.evidence.length) lines.push(`근거: ${c.evidence.join(", ")}.`);
	if (c.action) lines.push(`예정된 조치: ${c.action.kind}${c.dueMs ? ` (시각 ${new Date(c.dueMs).toISOString()})` : ""}.`);
	if (session.kind === "child") lines.push(`유휴 정리(idle_ttl) 예상 시각: ${new Date(call.ms + REAP_MS).toISOString()}.`);
	return lines.join("\n");
}

/**
 * D1 host-tool stall (+D3 unbounded waits as classes): every pending tool call
 * older than 60 s in a live session is matched to its processes and classified.
 * Findings carry the planned action and when it becomes due; the policy acts.
 */
/** Live processes the engine detached as servers for this tool call (world.attributed, role detached-server). */
function detachedServersOf(world, toolCallId) {
	const out = [];
	for (const [key, att] of world.attributed ?? new Map()) {
		if (att.role !== "detached-server" || att.toolCallId !== toolCallId) continue;
		const proc = world.procs.get(Number(String(key).split("@")[0]));
		if (proc && procKey(proc) === key) out.push(proc);
	}
	return out;
}

/**
 * Last snapshot at which the tree used CPU and wrote: that is output. Writes without CPU do not count, because an
 * idle headless browser trickles IPC and profile bytes for hours (#52 stall 2).
 */
function lastOutputMs(world, members) {
	const intervals = new Map();
	for (const proc of members) {
		const samples = world.procs.tracker?.samples(proc) ?? [];
		for (let i = 1; i < samples.length; i++) {
			const dt = samples[i].t - samples[i - 1].t;
			if (dt <= 0) continue;
			const slot = intervals.get(samples[i].t) ?? { busy: false, bytes: 0 };
			slot.busy ||= (samples[i].cpuMs - samples[i - 1].cpuMs) / dt > world.config.stall.cpuIdleFrac;
			slot.bytes += Math.max(0, samples[i].wb - samples[i - 1].wb);
			intervals.set(samples[i].t, slot);
		}
	}
	let last;
	for (const [t, slot] of intervals) if (slot.busy && slot.bytes > OUTPUT_BYTES && !(t <= last)) last = t;
	return last;
}

/**
 * When the call last showed a sign of life (#52): a transcript event of its session, growth of a file it redirects
 * to, or output from its tree. Kept per call in D1 memory, since the tracker holds only ~13 min of samples. On first
 * sight the quiet clock starts at the earliest snapshot of the tree (a daemon restart knows nothing older); a call
 * without processes has only its transcript to speak for it.
 * `restall`: its task stalled on another call within stall.restallWindowMs (the engine records stalls in
 * memory.stalls); once set it stays, so a call's own stall never loosens its thresholds again.
 */
function trackQuiet(memory, { call, session, world, members, redirectInfo }) {
	const cfg = world.config.stall;
	let entry = memory.quiet.get(call.id);
	if (!entry) {
		let observedFrom = world.now;
		for (const proc of members) observedFrom = Math.min(observedFrom, world.procs.tracker?.samples(proc)[0]?.t ?? world.now);
		entry = { signMs: members.length ? Math.max(call.ms, observedFrom) : call.ms, sizes: new Map(), restall: false };
		memory.quiet.set(call.id, entry);
	}
	for (const info of redirectInfo) {
		const seen = entry.sizes.get(info.file);
		if (seen === undefined && info.mtimeMs <= world.now) entry.signMs = Math.max(entry.signMs, info.mtimeMs);
		else if (seen !== undefined && seen !== info.size) entry.signMs = world.now;
		entry.sizes.set(info.file, info.size);
	}
	entry.signMs = Math.max(entry.signMs, session.lastEntryMs ?? 0, lastOutputMs(world, members) ?? 0);
	entry.restall ||= stalledRecently(memory.stalls, session, call, cfg);
	return { sinceMs: entry.signMs, restall: entry.restall };
}

/** Its task stalled on another call within stall.restallWindowMs. Shared with `diagnose`, which reads the record from state.json (#82). */
export function stalledRecently(stalls, session, call, cfg) {
	const prior = stalls?.get(session.taskId);
	return Boolean(prior && prior.toolCallId !== call.id && call.ms - prior.atMs <= cfg.restallWindowMs);
}

/** A shell holder still runs, or a child task or question may still answer. */
function holderRuns(world, session, other, memory) {
	const name = String(other.name ?? "").toLowerCase();
	if (CHILD_WAIT_TOOLS.has(name) || HUMAN_WAIT_TOOLS.has(name)) return true;
	if (!commandText(other.name, other.args)) return false;
	return matchPendingCall({ call: other, session, world, memory }).state === "running" || detachedServersOf(world, other.id).length > 0;
}

/**
 * A withheld call whose batch has nothing left that can run (#63 review): withholding can be mutual in a live host,
 * e.g. a [read, bash] batch whose bash result was lost. Only the batch's first pending call reports it, so the
 * parent gets one relay per batch.
 */
export function batchDead(world, session, call, memory) {
	const batch = [...session.pending.values()].filter((other) => other.batchId === call.batchId);
	if (batch[0]?.id !== call.id) return false;
	return batch.every((other) => other.id === call.id || !holderRuns(world, session, other, memory));
}

/** The processes R12 watches for a call: its tree without protected ones. */
export function quietMembers(world, match) {
	return [...match.tree, ...match.orphans].filter((proc) => !isProtectedProcess(proc, world));
}

/**
 * When a call last showed a sign of life, read from one world without D1's memory (`omo-health diagnose`, evidence
 * snapshots): its session's last transcript event, the last change of a file it redirects to, and tree output in the
 * sampled window. A short window cannot tell a busy tree between writes from a spinning one, so a tree that uses CPU,
 * or has no CPU sample yet, counts as alive now: only an idle tree can read as a quiet hang.
 */
export function freshSignMs({ call, session, world, members, redirectInfo }) {
	const idleFrac = world.config.stall.cpuIdleFrac;
	if (members.some((proc) => !((world.procs.cpuFracs(proc, 1)[0] ?? Number.POSITIVE_INFINITY) <= idleFrac))) return world.now;
	let signMs = Math.max(call.ms, session.lastEntryMs ?? 0, lastOutputMs(world, members) ?? 0);
	for (const info of redirectInfo) if (info.mtimeMs <= world.now) signMs = Math.max(signMs, info.mtimeMs);
	return signMs;
}

/** A host that started after the call was issued cannot be running it: senpi repairs such calls at the next request. */
export function issuedBeforeHost(world, session, call) {
	const hostPid = world.shellParentPid(session);
	return Number.isFinite(hostPid) && world.procs.get(hostPid)?.ctimeMs > call.ms;
}

/**
 * Match one pending call to its processes and classify it. D1 and `omo-health diagnose` read a call the same way,
 * so a diagnosis never disagrees with what the daemon would do about it.
 */
export function examinePending({ session, call, world, memory }) {
	let match = matchPendingCall({ call, session, world, memory });
	if (match.state === "exited") {
		// The shells are gone but a server we detached still holds the call's output pipe (output not
		// redirected): keep the server-foreground ladder so its verify step escalates to release-shell
		// on the server itself (R1-N1) instead of waiting 20 min for relay-cancel.
		const held = detachedServersOf(world, call.id);
		if (held.length) match = { ...match, state: "running", confidence: "high", reason: "detached-server-holds-pipe", root: undefined, tree: held, orphans: [] };
	}
	const command = commandText(call.name, call.args);
	const intent = command ? world.intentFor({ session, call }) : null;
	const cwd = session.kind === "child" ? (session.task?.spawnCwd ?? session.cwd) : session.cwd;
	const redirectInfo = command
		? redirectPaths(command, cwd)
				.map((file) => ({ file, ...(world.fileProbe(file) ?? {}) }))
				.filter((info) => info.size !== undefined)
		: [];
	return { match, command, intent, cwd, redirectInfo, c: classifyPending({ call, session, match, world, intent, redirectInfo }) };
}

export function detect(world, memory) {
	memory.matches ??= new Map();
	memory.quiet ??= new Map();
	memory.stalls ??= new Map();
	for (const [key, stall] of memory.stalls) if (world.now - stall.atMs > DAY_MS) memory.stalls.delete(key);
	const attributed = new Map();
	const findings = [];
	const stalledForeground = new Map();
	for (const session of world.sessions.values()) {
		// A child whose task already ended has nothing left to continue; leftover processes are D9's.
		// Time-aware so historical scans/replays still see a child whose task ended only later.
		if (!session.pending?.size || !world.isSessionLive(session) || (session.task?.terminal && (session.task.terminalAtMs ?? 0) <= world.now)) continue;
		for (const call of session.pending.values()) {
			const ageMs = world.now - call.ms;
			if (issuedBeforeHost(world, session, call)) continue;
			if (ageMs < 60_000) {
				// Too young to classify, but remember the shell so a command that ends within the minute reads as exited.
				matchPendingCall({ call, session, world, memory });
				continue;
			}
			const examined = examinePending({ session, call, world, memory });
			const { match, command, intent, cwd, redirectInfo } = examined;
			let { c } = examined;
			if (match.confidence === "high") {
				for (const proc of [...match.tree, ...match.orphans]) attributed.set(procKey(proc), { sessionId: session.id, taskId: session.taskId, taskUid: session.task?.uid, toolCallId: call.id, sinceMs: world.now });
			}
			if (c.cls === "pending" || c.cls === "child-wait") continue;
			if (c.cls === "human-wait" && ageMs < 60 * 60_000) continue;
			if ((c.cls === "inproc" || c.cls === "unmatched") && ageMs < world.config.stall.softMs) continue;
			let restall = false;
			// Main sessions are the human's. A child's call with no sign of life is stalled whatever its class (R12).
			if (session.kind === "child") {
				const members = quietMembers(world, match);
				const quiet = trackQuiet(memory, { call, session, world, members, redirectInfo });
				restall = quiet.restall;
				c = quietHang(c, { world, sinceMs: quiet.sinceMs, restall, batchDead: c.cls === "withheld" && batchDead(world, session, call, memory) }) ?? c;
			}
			const due = c.action && c.dueMs !== undefined && world.now >= c.dueMs;
			const severity = c.cls === "memory-runaway" ? "crit" : due || (c.action && !WAITING_CLASSES.has(c.cls) && ageMs >= world.config.stall.softMs) ? "warn" : "info";
			const finding = makeFinding({
				detector: id,
				kind: "stall",
				severity,
				subject: {
					sessionId: session.id,
					taskId: session.taskId,
					parentSessionId: session.parentSessionId,
					rootSessionId: session.rootSessionId,
					hostPid: world.shellParentPid(session),
					toolCallId: call.id,
				},
				cls: c.cls,
				evidence: c.evidence,
				titleKo: titleFor(c.cls, call, c, ageMs, command),
				detailKo: detailFor(session, c.cls, call, c, ageMs),
				data: {
					call: { id: call.id, name: call.name, commandHead: truncate(redact(command), 400), ms: call.ms, batchId: call.batchId },
					ageMs,
					classification: c,
					match: {
						state: match.state,
						confidence: match.confidence,
						reason: match.reason,
						rootPid: match.root?.pid,
						rootPath: match.root ? exePathOf(match.root) : undefined,
						rootCtime: match.root?.ctime,
						tree: match.tree.map(tag),
						orphans: match.orphans.map(tag),
						orphanRejects: match.orphanRejects,
					},
					dueMs: c.dueMs,
					predictedReapMs: session.kind === "child" ? call.ms + REAP_MS : undefined,
					intent: intent ? { runInBackground: intent.runInBackground, timeoutMs: intent.timeoutMs } : null,
					sessionKind: session.kind,
					background: session.task?.backgroundMode,
					cwd,
					programs: [...new Set(match.tree.map(programName))],
				},
			});
			findings.push(finding);
			if (severity !== "info" && session.kind === "child" && session.task?.backgroundMode === "foreground" && session.parentSessionId) {
				stalledForeground.set(session.parentSessionId, { child: session, finding });
			}
		}
	}
	// D8e-style marker: a parent blocked in a foreground task whose child is stalled.
	for (const [parentId, { child, finding }] of stalledForeground) {
		const parent = world.sessions.get(parentId);
		findings.push(
			makeFinding({
				detector: id,
				kind: "parent-blocked",
				severity: "info",
				subject: { sessionId: parentId, key: `blocked-by:${child.taskId}` },
				evidence: [`child:${child.taskId}`, `childStall:${finding.cls}`],
				titleKo: `포그라운드 서브에이전트 ${child.taskId}가 멈춰 이 세션이 기다리는 중`,
				detailKo: `${parent ? sessionLabel(parent) : parentId}은(는) 포그라운드 task 호출로 ${sessionLabel(child)}를 기다리고 있으며, 그 서브에이전트는 '${finding.cls}' 상태로 멈춰 있습니다.`,
				data: { childTaskId: child.taskId, childFp: finding.fp },
			}),
		);
	}
	for (const store of [memory.matches, memory.quiet]) {
		for (const key of store.keys()) {
			let stillPending = false;
			for (const session of world.sessions.values()) if (session.pending?.has(key)) stillPending = true;
			if (!stillPending) store.delete(key);
		}
	}
	memory.attributed = attributed;
	return findings;
}
