import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogCollector } from "./collect/logs.mjs";
import { createFixtureSource } from "./collect/procs.mjs";
import { SessionRegistry } from "./collect/sessions.mjs";
import { createConfigTracker } from "./collect/config-files.mjs";
import { loadConfig } from "./config.mjs";
import { createBaseline } from "./baseline.mjs";
import { createEngine, loadDetectors } from "./engine.mjs";
import { createAnalyst } from "./judge/analyst.mjs";
import { createInvestigations } from "./investigations.mjs";
import { resolvePaths } from "./paths.mjs";
import { atomicWriteJson, ensureDir, listDirSafe, readJsonSafe } from "./util/fsx.mjs";
import { createFakeClock, toMs } from "./util/time.mjs";

/**
 * Replay fixtures (plan todo 16/18). Layout of a fixture directory:
 *   meta.json       {clockStart, clockEnd, tickMs?, config?, projects?: ["projects/x"], sensors?: [{sessionId, pid, idle?}],
 *                    analyst?: {result?: {verdict, cause, evidence, confidence, diagnosis, respawn_text?, recheck_after_s?}, durationMs?, status?, reason?}}
 *                   analyst runs the real analyst (src/judge/analyst.mjs) on a simulated runner job: it answers `result` (the
 *                   analyst's JSON answer, validated like a real one) or ends with `status`/`reason` (failed, unavailable,
 *                   timeout), durationMs after it started. Without it the replay has no analyst, so a suspicion is only recorded.
 *                   A `config` override such as {"analyst": {"perDay": 0}} makes the analyst refuse to start (unavailable).
 *                   baseline?: {spanMs, count, values: {births|cpu|mem|writes|temp: [v, ...]}} seeds this machine's usual
 *                   rates (#55 C): `count` samples per metric cycling through its values, spread over the spanMs before
 *                   clockStart. Without it the replay has no baseline.
: agent/logs/*.log, agent/sessions/<dir>/*.jsonl, agent/settings.json ...
 *   projects/<p>/   project dirs holding .omo/senpi-task/{tasks,children}
 *   claude/         transcripts (any layout; searched by tool_use id)
 *   procs.ndjson    [{ts, procs:[{p,pp,n,c,cpu,pv,ws,rb,wb,cl}], os?, ports?:[{port,p}]}] one JSON per line
 *   expected.json   see compareExpected()
 * The literal token __FIXTURE__ in any text file is replaced with the temp copy's path (forward slashes).
 */
export function materializeFixture(fixtureDir) {
	const target = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-replay-"));
	const root = target.replace(/\\/g, "/");
	const copy = (from, to) => {
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			const src = path.join(from, entry.name);
			const dst = path.join(to, entry.name);
			if (entry.isDirectory()) {
				fs.mkdirSync(dst, { recursive: true });
				copy(src, dst);
			} else if (/\.(jsonl?|log|ndjson|txt|md)$/i.test(entry.name) || entry.name.endsWith(".log.1")) {
				fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replaceAll("__FIXTURE__", root));
			} else {
				fs.copyFileSync(src, dst);
			}
		}
	};
	copy(fixtureDir, target);
	return target;
}

function fixtureTranscripts(dir) {
	const files = [];
	const walk = (d) => {
		for (const entry of listDirSafe(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	walk(dir);
	return {
		find({ toolCallId }) {
			for (const file of files) {
				for (const line of fs.readFileSync(file, "utf8").split("\n")) {
					if (!line.includes(toolCallId)) continue;
					try {
						const entry = JSON.parse(line);
						const use = (entry?.message?.content ?? []).find((item) => item?.type === "tool_use" && item.id === toolCallId);
						if (use) return { tool: use.name, runInBackground: use.input?.run_in_background === true, timeoutMs: use.input?.timeout, file };
					} catch {
						// skip
					}
				}
			}
			return null;
		},
	};
}

/** Run the real engine over a fixture with a fake clock and recording actors. */
export async function runReplay(fixtureDir, { detectors, keep = false } = {}) {
	const dir = materializeFixture(fixtureDir);
	const meta = readJsonSafe(path.join(dir, "meta.json"), {});
	const clock = createFakeClock(toMs(meta.clockStart));
	const endMs = toMs(meta.clockEnd);
	const env = { OMO_HEALTH_HOME: path.join(dir, "_health"), OMO_HEALTH_OMO_HOME: path.join(dir, "omo"), OMO_HEALTH_CLAUDE_HOME: path.join(dir, "claude"), USERPROFILE: dir, APPDATA: path.join(dir, "_appdata") };
	const paths = resolvePaths(env);
	const { config: base } = loadConfig({ env: {}, paths: { health: { configFile: path.join(dir, "_none.json") } }, overrides: meta.config ?? {} });
	const config = { ...base, extraProjects: (meta.projects ?? []).map((p) => path.join(dir, p)) };
	const actions = [];
	const decisions = [];
	const sent = [];
	const toasts = [];
	// #55 C: a seeded baseline.json, so the replay starts warm (a fresh install never signals).
	if (meta.baseline) seedBaseline(paths.health.baselineFile, meta.baseline, toMs(meta.clockStart));
	const analystJobs = [];
	/** The runner as the analyst sees it, on the fixture clock: no process is started. */
	const analystRunner = {
		start: (opts) => {
			const model = opts.args?.[opts.args.indexOf("--model") + 1];
			analystJobs.push({ jobId: opts.jobId, startedMs: clock.now(), model, args: opts.args });
			actions.push({ kind: "analyst-start", atMs: clock.now(), jobId: opts.jobId });
			return { jobId: opts.jobId, pid: 0, dir: "" };
		},
		poll: (jobId) => {
			const job = analystJobs.find((j) => j.jobId === jobId);
			if (!job) return { status: "failed", reason: "no-job", result: null };
			if (clock.now() - job.startedMs < (meta.analyst.durationMs ?? 60_000)) return { status: "running", result: null };
			if (!job.endedMs) {
				job.endedMs = clock.now();
				actions.push({ kind: "analyst-end", atMs: clock.now(), jobId });
			}
			const status = meta.analyst.status ?? "done";
			return status === "done" ? { status, result: meta.analyst.result ?? null, costUsd: 0 } : { status, reason: meta.analyst.reason ?? status, result: null };
		},
	};
	const procsFile = path.join(dir, "procs.ndjson");
	const procs = fs.existsSync(procsFile) ? createFixtureSource({ file: procsFile, clock }) : createFixtureSource({ records: [], clock });
	const engine = createEngine({
		paths,
		config,
		clock,
		mode: "auto",
		detectors: detectors ?? (await loadDetectors()),
		sources: {
			procs,
			registry: new SessionRegistry({ paths, config: { ...config, sessions: { ...config.sessions, tailBytes: null } }, clock, scanWindow: undefined }),
			logs: new LogCollector({ logsDir: paths.logsDir, full: true }),
			transcripts: fixtureTranscripts(path.join(dir, "claude")),
			config: createConfigTracker({ paths, clock: () => clock.now(), config: config.config }),
			secrets: () => ({ authBlocks: meta.authBlocks ?? [], loginExpiry: meta.loginExpiry }),
			versions: () => meta.versions ?? {},
			fileProbe: (file) => {
				try {
					const stat = fs.statSync(file);
					return { size: stat.size, mtimeMs: stat.mtimeMs, tail: fs.readFileSync(file, "utf8").slice(-4096) };
				} catch {
					return undefined;
				}
			},
		},
		actors: {
			kill: async ({ request }) => {
				actions.push({ kind: request.kind, atMs: clock.now(), targets: (request.targets ?? []).map((t) => t.pid), servers: (request.serverPids ?? []).map((t) => t.pid) });
				return { kind: request.kind, killed: (request.targets ?? []).filter((t) => !(request.serverPids ?? []).some((s) => s.pid === t.pid)).map((t) => ({ pid: t.pid, name: t.name })), survived: [], noop: [], errors: [] };
			},
			send: (message) => {
				sent.push({ ...message, atMs: clock.now() });
				actions.push({ kind: `message:${message.kind}`, atMs: clock.now(), sessionId: message.sessionId });
				return "replay";
			},
			notifier: {
				toast: (t) => {
					toasts.push({ ...t, atMs: clock.now() });
					actions.push({ kind: "toast", atMs: clock.now(), tag: t.tag });
					return { ok: true };
				},
			},
			...(meta.analyst ? { analyst: createAnalyst({ config, paths, clock, runner: analystRunner, env: {} }) } : {}),
			...(meta.baseline ? { baseline: createBaseline({ paths, config, clock }) } : {}),
			revert: ({ fromSha1, toSha1 }) => {
				actions.push({ kind: "revert-settings", atMs: clock.now(), fromSha1, toSha1 });
				return { ok: true, rejectedCopy: "replay" };
			},
			decide: (d) => decisions.push(d),
			sensors: (now) => new Map((meta.sensors ?? []).map((hb) => [hb.sessionId, { idle: true, executingTools: 0, lastEventAt: now, ...hb, ts: now }])),
		},
		options: { selfPid: 1, scan: false, noStatus: true, selfStats: () => ({ rssBytes: 50e6, cpuFrac: 0 }) },
	});
	// meta.mtimes: {"omo/agent/settings.json": iso} ; meta.fileWrites: [{at: iso, file: rel, from: rel}]
	for (const [rel, at] of Object.entries(meta.mtimes ?? {})) {
		const file = path.join(dir, rel);
		if (fs.existsSync(file)) fs.utimesSync(file, new Date(toMs(at)), new Date(toMs(at)));
	}
	const pendingWrites = (meta.fileWrites ?? []).map((w) => ({ ...w, ms: toMs(w.at) })).sort((a, b) => a.ms - b.ms);
	const firstSeen = new Map();
	const tickMs = meta.tickMs ?? config.tickMs;
	while (clock.now() <= endMs) {
		while (pendingWrites.length && pendingWrites[0].ms <= clock.now()) {
			const write = pendingWrites.shift();
			const file = path.join(dir, write.file);
			fs.writeFileSync(file, fs.readFileSync(path.join(dir, write.from)));
			fs.utimesSync(file, new Date(write.ms), new Date(write.ms));
		}
		const result = await engine.tick();
		for (const finding of result.findings) {
			if (!firstSeen.has(finding.fp)) firstSeen.set(finding.fp, { fp: finding.fp, detector: finding.detector, kind: finding.kind, cls: finding.cls, severity: finding.severity, humanNeeded: finding.humanNeeded, subject: finding.subject, firstAtMs: clock.now(), maxSeverity: finding.severity, data: { remedy: finding.data?.remedy, revertSkipped: finding.data?.revertSkipped } });
			const seen = firstSeen.get(finding.fp);
			if ((finding.severity === "crit") || (finding.severity === "warn" && seen.maxSeverity === "info")) seen.maxSeverity = finding.severity;
		}
		clock.advance(tickMs);
	}
	engine.close();
	const investigations = createInvestigations({ paths, clock }).list();
	if (!keep) fs.rmSync(dir, { recursive: true, force: true });
	return { findings: [...firstSeen.values()], actions, decisions, sent, toasts, analystJobs, investigations, meta };
}

/** baseline.json with `count` samples per metric, cycling through `values`, evenly spread over the `spanMs` before `endMs`. */
function seedBaseline(file, { spanMs, count, values }, endMs) {
	const samples = {};
	for (const [metric, list] of Object.entries(values ?? {})) {
		samples[metric] = Array.from({ length: count }, (_, i) => [endMs - spanMs + Math.floor((i * spanMs) / count), list[i % list.length]]);
	}
	ensureDir(path.dirname(file));
	atomicWriteJson(file, { v: 1, firstMs: endMs - spanMs, samples });
}

const inRange = (ms, range) => !range || (ms >= toMs(range[0]) && ms <= toMs(range[1]));
const subset = (actual, partial) => Object.entries(partial ?? {}).every(([k, v]) => actual?.[k] === v);

/**
 * expected.json:
 *   findings: [{detector, kind, cls?, severity?, subject?: {...}, at?: [fromIso, toIso]}]   each must appear
 *   actions: [{kind, targets?: [pid...], at?: [fromIso, toIso]}]                            each must happen
 *   forbiddenActions: ["kill-pids", ...]                                                     must not happen
 *   forbiddenFindings: [{detector?, kind?, cls?, severity?}]                                 must not appear
 *   investigations: [{status, trigger?, cls?, failed?: true, retryAtMs?: true}]               each must exist (retryAtMs: true = set)
 *   decisions: [{event, status?, result?}]                                                   each must be logged
 *   messages: N                                                                              exactly N inbox messages were sent
 */
export function compareExpected(result, expected) {
	const problems = [];
	for (const want of expected.findings ?? []) {
		const hit = result.findings.find((f) => f.detector === want.detector && f.kind === want.kind && (!want.cls || f.cls === want.cls) && (!want.severity || f.maxSeverity === want.severity || f.severity === want.severity) && subset(f.subject, want.subject) && inRange(f.firstAtMs, want.at));
		if (!hit) problems.push(`missing finding ${JSON.stringify(want)}`);
	}
	for (const want of expected.actions ?? []) {
		const hit = result.actions.find((a) => a.kind === want.kind && inRange(a.atMs, want.at) && (!want.targets || JSON.stringify([...a.targets].sort()) === JSON.stringify([...want.targets].sort())));
		if (!hit) problems.push(`missing action ${JSON.stringify(want)} (got ${JSON.stringify(result.actions.map((a) => ({ kind: a.kind, at: new Date(a.atMs).toISOString(), targets: a.targets })))})`);
	}
	for (const kind of expected.forbiddenActions ?? []) {
		const hit = result.actions.find((a) => a.kind === kind);
		if (hit) problems.push(`forbidden action ${kind} at ${new Date(hit.atMs).toISOString()}`);
	}
	for (const want of expected.investigations ?? []) {
		const hit = (result.investigations ?? []).find((inv) => inv.status === want.status && (!want.trigger || inv.trigger === want.trigger) && (!want.cls || inv.cls === want.cls) && (want.retryAtMs === undefined || Number.isFinite(inv.retryAtMs) === want.retryAtMs));
		if (!hit) problems.push(`missing investigation ${JSON.stringify(want)} (got ${JSON.stringify((result.investigations ?? []).map((inv) => ({ status: inv.status, trigger: inv.trigger, cls: inv.cls, retryAtMs: inv.retryAtMs })))})`);
	}
	for (const want of expected.decisions ?? []) {
		if (!result.decisions.some((d) => d.event === want.event && (!want.status || d.status === want.status) && (!want.result || d.result === want.result))) problems.push(`missing decision ${JSON.stringify(want)}`);
	}
	if (expected.messages !== undefined && result.sent.length !== expected.messages) problems.push(`expected ${expected.messages} message(s), got ${result.sent.length}: ${result.sent.map((m) => m.kind).join(", ")}`);
	for (const bad of expected.forbiddenFindings ?? []) {
		const hit = result.findings.find((f) => (!bad.detector || f.detector === bad.detector) && (!bad.kind || f.kind === bad.kind) && (!bad.cls || f.cls === bad.cls) && (!bad.severity || f.maxSeverity === bad.severity));
		if (hit) problems.push(`forbidden finding ${JSON.stringify(bad)}: ${hit.detector}/${hit.kind}/${hit.cls ?? ""} ${hit.maxSeverity}`);
	}
	return problems;
}
