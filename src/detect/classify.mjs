import path from "node:path";
import { commandText } from "../collect/sessions.mjs";
import { sha1 } from "../util/text.mjs";
import { isProtectedProcess, programName, SHELL_NAMES } from "./match.mjs";
import { respawnStormsUsable } from "./respawn.mjs";

/**
 * Ordered, versioned rules that decide what a pending tool call is waiting on
 * (plan todo 7, design section 5.2, review R1-B5 / R1-N1 / R1-N2).
 * Every decision records the rule id + version.
 */
export const RULES_VERSION = 4;

export const HUMAN_WAIT_TOOLS = new Set(["ask_user_question", "question", "ask_user", "ask", "ask-user"]);
export const CHILD_WAIT_TOOLS = new Set(["task", "task_output", "team_create", "wait"]);
const READONLY_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "find", "sed", "awk", "gawk", "cat", "head", "tail", "sort", "uniq", "wc", "jq", "yes", "xargs", "ls", "tr", "cut", "less", "strings", "od", "xxd", "base64"]);
const READONLY_GIT = /\bgit\s+(log|show|diff|grep|blame|rev-list|ls-files|cat-file|status)\b/;
const INTERACTIVE_PROGRAMS = new Set(["less", "more", "vim", "vi", "nano", "emacs", "ssh", "sftp", "ftp", "telnet", "sudo", "passwd", "top", "htop", "man"]);
const SERVER_RE = /(createServer|\.listen\(|\bserve\b|\bserver\b|uvicorn|gunicorn|flask\s+run|http\.server|npm\s+(run\s+)?(dev|start|serve)|pnpm\s+(run\s+)?(dev|start)|yarn\s+(dev|start)|\bvite\b|next\s+dev|webpack-dev-server|nodemon|live-server|\.exe\s+-config|--port\b)/i;
const LISTENING_RE = /(listening|started successfully|server (is )?running|running on|ready in|local:\s+http|serving at)/i;
const PROGRESS_RE = /\b(npm|pnpm|yarn|bun|npx|uv|pip|pip3|poetry|pytest|tox|cargo|go\s+(build|test|mod)|dotnet|msbuild|gradle|gradlew|mvn|make|cmake|ninja|tsc|vitest|jest|mocha|node\s+--test|deno\s+test|git\s+(clone|fetch|pull|push|gc)|curl\s+.*-[oO]\b|wget|docker\s+(build|pull))\b/;

/** `timeout 300 cmd`, `--max-time 60`, tool arg timeout (seconds), transcript timeout (ms). Returns ms or undefined. */
export function explicitBoundMs(call, intent) {
	const bounds = [];
	const argTimeout = call.args?.timeout;
	if (typeof argTimeout === "number" && argTimeout > 0) bounds.push(argTimeout * 1000);
	if (intent?.timeoutMs > 0) bounds.push(intent.timeoutMs);
	const text = commandText(call.name, call.args);
	for (const m of text.matchAll(/(?:^|[;&|(]\s*)timeout\s+(?:-[a-zA-Z]+\s+\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
		const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
		bounds.push(Number(m[1]) * unit * 1000);
	}
	for (const m of text.matchAll(/--max-time\s+(\d+)/g)) bounds.push(Number(m[1]) * 1000);
	return bounds.length ? Math.min(...bounds) : undefined;
}

/** Files a shell command redirects stdout into ("> f", ">> f", "&> f", "| tee f"). */
export function redirectTargets(command) {
	const text = String(command ?? "");
	// Operators inside quotes (e.g. an arrow function in `node -e "..."`) are not redirects. Quoted spans are
	// masked to equal-length filler, so a quoted target still matches as one token and is read back from `text`.
	const masked = text.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (span) => "\u0001".repeat(span.length));
	const out = [];
	const collect = (re, keep) => {
		for (const m of masked.matchAll(re)) {
			const start = m.index + m[0].length - m[1].length;
			const target = text.slice(start, start + m[1].length).replace(/^["']|["']$/g, "");
			if (keep(target)) out.push(target);
		}
	};
	collect(/(?:^|[^0-9&<>])(?:1?>{1,2}|&>{1,2})\s*([^\s;&|]+)/g, (t) => t && !t.startsWith("&") && t !== "/dev/null" && t.toLowerCase() !== "nul");
	collect(/\|\s*tee\s+(?:-a\s+)?([^\s;&|]+)/g, (t) => Boolean(t));
	return out;
}

export function isUnboundedWait(command, sleepUnboundedSec) {
	const text = String(command ?? "");
	if (/\btail\s+(-[a-zA-Z]*[fF]|--follow)/.test(text) && !/\b(timeout|-m\s*\d|--max-count)/.test(text)) return "tail-follow";
	for (const m of text.matchAll(/\bsleep\s+(\d+|infinity)\b/g)) if (m[1] === "infinity" || Number(m[1]) >= sleepUnboundedSec) return "long-sleep";
	if (/\b(until|while)\b[\s\S]*\bsleep\b/.test(text) && !/\b(timeout|seq\s|for\s+\w+\s+in|\$\(\(|-lt\s|-le\s|-gt\s|-ge\s|count|tries|attempt|max)\b/i.test(text)) return "poll-loop";
	if (/(^|\s)watch\s|--watch\b|\binotifywait\s+-m\b|\bping\s+-t\b/.test(text)) return "watcher";
	return undefined;
}

function isReadonlyProc(proc, command) {
	const name = programName(proc);
	if (READONLY_PROGRAMS.has(name)) {
		if (name === "sed" && /\bsed\s+(-[a-z]*i|--in-place)/.test(proc.cmd)) return false;
		if (name === "tail" && /\s-[a-zA-Z]*[fF]\b/.test(proc.cmd)) return false;
		return true;
	}
	if (name === "git") return READONLY_GIT.test(proc.cmd) || READONLY_GIT.test(command);
	return false;
}

function isInteractiveProc(proc) {
	const name = programName(proc);
	if (INTERACTIVE_PROGRAMS.has(name)) return true;
	if (name === "git" && /\bgit\s+(commit(?![^\n]*\s-(m|F|-message|-file))|rebase\s+-i|add\s+-p)/.test(proc.cmd)) return true;
	// bare REPLs: "python", "node", "python3" with no script argument
	if (/^(python|python3|node|irb|ghci)$/.test(name)) {
		const args = String(proc.cmd ?? "")
			.trim()
			.replace(/^"[^"]*"|^\S+/, "")
			.trim();
		if (!args) return true;
	}
	return false;
}

export function tag(proc) {
	return { pid: proc.pid, ctime: proc.ctime, name: proc.name, cmdSha1: sha1(proc.cmd ?? ""), cmdHead: String(proc.cmd ?? "").slice(0, 160) };
}

/**
 * Classify one pending call.
 * @returns {{cls, rule:{id,v}, confidence, dueMs, action: null|{kind, targets?, serverPids?}, evidence: string[], data: object}}
 */
export function classifyPending({ call, session, match, world, intent, redirectInfo = [] }) {
	const cfg = world.config.stall;
	const mem = world.config.memory;
	const now = world.now;
	const age = now - call.ms;
	const name = String(call.name ?? "").toLowerCase();
	const evidence = [];
	const result = (cls, ruleId, confidence, dueMs, action, data = {}) => ({ cls, rule: { id: ruleId, v: RULES_VERSION }, confidence, dueMs, action, evidence, data });

	if (HUMAN_WAIT_TOOLS.has(name)) return result("human-wait", "R0", 1, undefined, null);
	if (CHILD_WAIT_TOOLS.has(name)) return result("child-wait", "R1", 1, undefined, null);
	const command = commandText(call.name, call.args);
	if (!command) {
		// senpi persists a batch's toolResults together once its slowest call ends, so a finished in-process call
		// waits for a sibling that can run long (shell, task, question). Nothing to kill or cancel then.
		const holders = [...session.pending.values()].filter((other) => other.batchId === call.batchId && other.id !== call.id && (commandText(other.name, other.args) || CHILD_WAIT_TOOLS.has(String(other.name ?? "").toLowerCase()) || HUMAN_WAIT_TOOLS.has(String(other.name ?? "").toLowerCase())));
		if (holders.length) {
			evidence.push(`sibling-pending:${holders.map((other) => other.id).join(",")}`);
			return result("withheld", "R2w", 0.95, undefined, null, { note: "in-process result held back by a running sibling in the same batch" });
		}
		// In-process tool: nothing to kill. Children: ask the parent to cancel/re-dispatch; main: notify.
		const relay = session.kind === "child" ? { kind: "relay-cancel" } : { kind: "notify" };
		return result("inproc", "R2", 0.9, call.ms + (session.kind === "child" ? cfg.inprocToolRelayMs : cfg.mainNotifyMs), relay);
	}

	if (match.state === "exited") {
		const siblingsPending = [...session.pending.values()].some((other) => other.batchId === call.batchId && other.id !== call.id);
		if (siblingsPending) return result("withheld", "R3", 0.95, undefined, null, { note: "result held back by a sibling call in the same batch" });
		return result("exited-no-result", "R3b", 0.7, call.ms + cfg.inprocToolRelayMs, session.kind === "child" ? { kind: "relay-cancel" } : { kind: "notify" });
	}
	if (match.state !== "running" || match.confidence !== "high") {
		evidence.push(`match:${match.state}:${match.reason ?? ""}`);
		// No shell was found, which is what a finished call looks like too: a pending sibling explains the missing result.
		const siblings = [...session.pending.values()].filter((other) => other.batchId === call.batchId && other.id !== call.id);
		if (siblings.length) {
			evidence.push(`sibling-pending:${siblings.map((other) => other.id).join(",")}`);
			return result("withheld", "R3", 0.9, undefined, null, { note: "result held back by a sibling call in the same batch", matchReason: match.reason });
		}
		// Relay only once the explicit bound the model set (+grace) has passed too.
		const bound = explicitBoundMs(call, intent);
		const waitMs = Math.max(cfg.inprocToolRelayMs, bound === undefined ? 0 : bound + cfg.boundGraceMs);
		return result("unmatched", "R2b", 0.5, call.ms + waitMs, session.kind === "child" ? { kind: "relay-cancel" } : { kind: "notify" }, { matchReason: match.reason, batch: { id: call.batchId, size: call.batchSize } });
	}

	const procs = world.procs;
	const members = [...match.tree, ...match.orphans].filter((proc) => !isProtectedProcess(proc, world));
	const workers = members.filter((proc) => !SHELL_NAMES.has(proc.name.toLowerCase()));
	const sampled = (proc) => procs.cpuFracs(proc, cfg.cpuSamples);
	const busy = (proc) => {
		const fracs = sampled(proc);
		return fracs.length >= cfg.cpuSamples && fracs.every((f) => f >= cfg.cpuBusyFrac);
	};
	const treeCpu = members.reduce((sum, proc) => sum + (sampled(proc)[0] ?? 0), 0);
	const treeCpuSampled = members.some((proc) => sampled(proc).length >= cfg.cpuSamples);
	const treeIdle = treeCpuSampled && members.every((proc) => (sampled(proc).length ? Math.max(...sampled(proc)) : 0) <= cfg.cpuIdleFrac);
	const treeWrites = members.reduce((sum, proc) => sum + procs.writeBytesDelta(proc, cfg.cpuSamples), 0);
	const treePriv = members.reduce((sum, proc) => sum + (proc.privBytes ?? 0), 0);
	evidence.push(`tree:${members.length}`, `treeCpu:${treeCpu.toFixed(2)}`, `treePrivMB:${Math.round(treePriv / 1048576)}`);

	// R4 bounded: an explicit bound the model set; wait for it (+grace).
	const bound = explicitBoundMs(call, intent);
	if (bound !== undefined && age < bound + cfg.boundGraceMs) {
		evidence.push(`bound:${bound}`);
		return result("bounded", "R4", 0.95, call.ms + bound + cfg.boundGraceMs, null, { boundMs: bound });
	}

	// R5 memory runaway (hard caps skip softMs; still needs >= 2 snapshots).
	const growers = workers.filter((proc) => procs.observedMs(proc) >= Math.min(mem.growthWindowMs, 60_000) && procs.growthMBPerMin(proc, mem.growthWindowMs) >= mem.growthMBPerMin && procs.observedMs(proc) >= mem.growthWindowMs);
	const heavy = workers.filter((proc) => sampled(proc).length >= 1 && (proc.privBytes ?? 0) >= mem.treeMaxBytes);
	const commitPressure = world.os?.commitFrac >= mem.commitFrac && treePriv >= mem.pressureMinBytes && workers.some((proc) => sampled(proc).length >= 1) && isLargestOmoTree(treePriv, match, world);
	if (growers.length || heavy.length || commitPressure) {
		const targets = growers.length ? growers : heavy.length ? heavy : [workers.slice().sort((a, b) => b.privBytes - a.privBytes)[0]];
		for (const proc of targets) evidence.push(`mem:${proc.pid}:${Math.round(proc.privBytes / 1048576)}MB:${procs.growthMBPerMin(proc, mem.growthWindowMs).toFixed(0)}MB/min`);
		if (commitPressure) evidence.push(`commit:${(world.os.commitFrac * 100).toFixed(1)}%`);
		return result("memory-runaway", "R5", 0.9, now, { kind: "kill-pids", targets: targets.filter(Boolean).map(tag) });
	}

	// Classification starts at the earliest class threshold (server 2 min, blocked 3 min, others 5 min).
	const classifyFromMs = Math.min(cfg.softMs, cfg.serverForegroundMs, cfg.blockedInputMs);
	if (age < classifyFromMs) return result("pending", "R-soft", 1, call.ms + classifyFromMs, null);

	// R5b respawn loop: the tree keeps launching a program that dies at once (D17 storm owned by this call).
	// It looks active (each child writes a little), so it must be decided before R10 progressing swallows it.
	// Under D17's own guards (respawnStormsUsable): off with respawn.enabled=false, and no storm from a stale process
	// table or a history replay, so turning D17 off or replaying old logs never ends a call as a respawn loop.
	const storm = !respawnStormsUsable(world) ? undefined : world.respawnStorms?.().find((s) => s.respawner && members.some((proc) => proc.pid === s.respawner.pid));
	if (storm) {
		evidence.push(`respawn:${storm.name}:${storm.births}`, `respawner:${storm.respawner.pid}`);
		const due = Math.max(call.ms + classifyFromMs, storm.firstMs + (world.config.respawn?.confirmMs ?? 60_000));
		return result("respawn-loop", "R5b", 0.9, due, { kind: "release-shell" }, { stormName: storm.name, stormBirths: storm.births });
	}

	// R6 foreground server: a listening port in the tree or a "listening" line in its log (strong),
	// or a server-looking non-read-only command the model meant to background (weak).
	const treePids = members.map((proc) => proc.pid);
	const ports = world.portsOfTree(treePids) ?? [];
	const logSaysListening = redirectInfo.some((info) => LISTENING_RE.test(info.tail ?? ""));
	const backgroundIntent = Boolean(intent?.runInBackground) || /&\s*$/.test(command.trim());
	const weakServer = SERVER_RE.test(command) && backgroundIntent && workers.some((proc) => !isReadonlyProc(proc, command));
	if (ports.length || logSaysListening || weakServer) {
		const serverPids = new Set(ports.map((row) => row.pid));
		if (!serverPids.size) for (const proc of workers) if (SERVER_RE.test(proc.cmd) || /^(node|python|python3|java|dotnet|deno|bun|ruby|php)$/.test(programName(proc)) || /\.exe$/i.test(proc.name)) serverPids.add(proc.pid);
		const servers = workers.filter((proc) => serverPids.has(proc.pid));
		const chain = new Map();
		for (const server of servers) for (const ancestor of procs.ancestors(server.pid)) if (match.tree.some((p) => p.pid === ancestor.pid) && SHELL_NAMES.has(ancestor.name.toLowerCase())) chain.set(ancestor.pid, ancestor);
		if (!chain.size && match.root) chain.set(match.root.pid, match.root);
		for (const row of ports) evidence.push(`port:${row.port}->${row.pid}`);
		if (logSaysListening) evidence.push("log:listening");
		if (intent?.runInBackground) evidence.push("intent:run_in_background");
		const redirected = redirectTargets(command).length > 0;
		return result("server-foreground", "R6", ports.length || logSaysListening ? 0.9 : 0.7, call.ms + cfg.serverForegroundMs, { kind: "detach-server", targets: [...chain.values()].map(tag), serverPids: servers.map(tag) }, { ports: ports.map((row) => row.port), redirected, runInBackground: Boolean(intent?.runInBackground) });
	}

	// R7 blocked on input: idle tree with an interactive program.
	const interactive = members.filter(isInteractiveProc);
	if (treeIdle && interactive.length) {
		for (const proc of interactive) evidence.push(`interactive:${programName(proc)}`);
		return result("blocked-on-input", "R7", 0.85, call.ms + cfg.blockedInputMs, { kind: "release-shell" });
	}

	// R8 read-only runaway: CPU-bound read-only programs (grep, yes, find ...).
	const busyReadonly = workers.filter((proc) => isReadonlyProc(proc, command) && sampled(proc).length >= cfg.cpuSamples && sampled(proc).every((f) => f >= 0.1));
	const busyReadonlyCpu = busyReadonly.reduce((sum, proc) => sum + (sampled(proc)[0] ?? 0), 0);
	const nonReadonlyBusy = workers.some((proc) => !isReadonlyProc(proc, command) && busy(proc));
	if (busyReadonly.length && busyReadonlyCpu >= cfg.cpuBusyFrac && !nonReadonlyBusy) {
		for (const proc of busyReadonly) evidence.push(`busy:${programName(proc)}:${proc.pid}`);
		return result("runaway-readonly", "R8", 0.9, call.ms + cfg.runawayReadonlyMs, { kind: "kill-pids", targets: busyReadonly.map(tag) });
	}

	// R9 unbounded waits.
	const unbounded = isUnboundedWait(command, cfg.sleepUnboundedSec);
	if (unbounded) {
		evidence.push(`unbounded:${unbounded}`);
		return result("unbounded-wait", "R9", 0.85, call.ms + cfg.unboundedWaitMs, { kind: "release-shell" }, { pattern: unbounded });
	}

	// R10 progressing: builds/tests/installs with activity, or any tree that keeps writing (R1-B5).
	const active = treeCpu > 0.05 || treeWrites > 1024;
	if ((PROGRESS_RE.test(command) && active) || treeWrites > 1024) {
		evidence.push(`writes:${treeWrites}`);
		if (age < cfg.progressingMaxMs) return result("progressing", "R10", 0.8, call.ms + cfg.progressingMaxMs, null, { writeBytes: treeWrites });
		// The class maximum only opens an investigation: the analyst decides whether it is stuck, the clock never releases.
		return result("unknown", "R10x", 0.4, now, { kind: "analyze" }, { reason: "progressing beyond progressingMaxMs" });
	}

	// R11 unknown: at its due time it opens an investigation and the analyst decides; nothing releases it on the clock.
	return result("unknown", "R11", 0.3, call.ms + cfg.unknownJudgeMs, { kind: "analyze" }, { idle: treeIdle, cpuSampled: treeCpuSampled });
}

/** Rule classes that only wait or ask the analyst: R12 may overrule them. */
const QUIET_CLASSES = new Set(["bounded", "progressing", "unknown"]);

/**
 * R12 quiet hang (#52, #55 A), applied by D1 to a child's call after classifyPending. A call that has shown no sign
 * of life (see stall.mjs) for stall.quietMs, or stall.restallMs when its task stalled within the hour, is stalled
 * whatever the waiting class said. With processes it is a suspicion only: the action is `analyze`, due at the quiet
 * threshold, and only an analyst verdict releases the shell tree. A withheld call of a batch with nothing left running
 * (`batchDead`) has nothing to release, so the parent is asked to cancel.
 * @returns the replacing classification, or undefined when `c` stands
 */
export function quietHang(c, { world, sinceMs, restall, batchDead }) {
	const cfg = world.config.stall;
	const withheld = c.cls === "withheld" && batchDead;
	if (!QUIET_CLASSES.has(c.cls) && !withheld) return undefined;
	const limit = restall ? cfg.restallMs : cfg.quietMs;
	if (world.now - sinceMs < limit) return undefined;
	const quietAtMs = sinceMs + limit;
	const evidence = [...c.evidence, `quiet:${Math.round((world.now - sinceMs) / 60_000)}m`, `was:${c.cls}`, ...(restall ? ["restall"] : [])];
	const action = withheld ? { kind: "relay-cancel" } : { kind: "analyze" };
	return { cls: "quiet-hang", rule: { id: "R12", v: RULES_VERSION }, confidence: 0.8, dueMs: quietAtMs, action, evidence, data: { quietSinceMs: sinceMs, quietAtMs, was: c.cls, wasRule: c.rule.id, restall: Boolean(restall) } };
}

function isLargestOmoTree(treePriv, match, world) {
	// Compare with every other process tree hanging off a live senpi host.
	let largestOther = 0;
	const own = new Set([...match.tree, ...match.orphans].map((proc) => proc.pid));
	for (const hostPid of world.liveHostPids) {
		for (const child of world.procs.children(hostPid)) {
			if (own.has(child.pid)) continue;
			const tree = [child, ...world.procs.descendants(child.pid)].filter((proc) => !isProtectedProcess(proc, world));
			largestOther = Math.max(largestOther, tree.reduce((sum, proc) => sum + (proc.privBytes ?? 0), 0));
		}
	}
	return treePriv > largestOther;
}

/** Resolve redirect targets of a command against the session's cwd. */
export function redirectPaths(command, cwd) {
	return redirectTargets(command).map((target) => (path.isAbsolute(target) || /^[A-Za-z]:/.test(target) ? target : path.resolve(cwd ?? ".", target.replace(/^\/([a-z])\//i, "$1:/"))));
}
