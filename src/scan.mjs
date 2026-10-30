import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogCollector } from "./collect/logs.mjs";
import { createFixtureSource } from "./collect/procs.mjs";
import { SessionRegistry } from "./collect/sessions.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import { createEngine, loadDetectors } from "./engine.mjs";
import { resolvePaths } from "./paths.mjs";
import { createFakeClock } from "./util/time.mjs";

/**
 * Historical scan (plan todo 16, QA-L15): replay the real omo logs and session
 * files between fromMs and toMs through the detectors in history mode (no
 * process data: stalls show as unmatched/pending, nothing is judged dead),
 * actions disabled. Findings whose evidence predates fromMs are left out.
 */
export async function runScan({ fromMs, toMs: endMs, env = process.env, stepMs = 15_000, detectorNames } = {}) {
	const paths = resolvePaths({ ...env, OMO_HEALTH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "omoh-scan-")) });
	const config = { ...DEFAULT_CONFIG, mode: "shadow", sessions: { ...DEFAULT_CONFIG.sessions, tailBytes: null } };
	const clock = createFakeClock(fromMs);
	const all = await loadDetectors();
	const detectors = detectorNames ? all.filter((d) => detectorNames.includes(d.name)) : all;
	const recorded = [];
	const engine = createEngine({
		paths,
		config,
		clock,
		mode: "shadow",
		detectors,
		sources: {
			procs: createFixtureSource({ records: [], clock }),
			registry: new SessionRegistry({ paths, config, clock, scanWindow: { fromMs, toMs: endMs } }),
			logs: new LogCollector({ logsDir: paths.logsDir, full: true }),
			transcripts: { find: () => null },
			versions: () => ({}),
			// No past file contents: D7 dates the change from the logs and finds its writer in the sessions.
			config: { update: () => ({ settings: { file: paths.settingsFile, exists: fs.existsSync(paths.settingsFile), historical: true, sha1: "history" }, omoJsonc: { exists: false } }) },
		},
		actors: { decide: () => {}, send: () => "scan", notifier: { toast: () => ({ ok: true }) }, revert: () => ({ ok: false }), kill: async () => ({ killed: [], survived: [], noop: [], errors: [] }), sensors: () => new Map() },
		options: { selfPid: 1, scan: true, noStatus: true, liveness: "history", selfStats: () => ({ rssBytes: 0, cpuFrac: 0 }) },
	});
	const firstSeen = new Set();
	try {
		while (clock.now() <= endMs) {
			const result = await engine.tick();
			for (const finding of result.findings) {
				if (firstSeen.has(finding.fp)) continue;
				firstSeen.add(finding.fp);
				const evidenceMs = finding.data?.atMs ?? finding.data?.eventMs;
				if (Number.isFinite(evidenceMs) && evidenceMs < fromMs) continue;
				recorded.push({ at: new Date(clock.now()).toISOString(), detector: finding.detector, kind: finding.kind, cls: finding.cls, severity: finding.severity, humanNeeded: finding.humanNeeded, subject: finding.subject, titleKo: finding.titleKo, data: { writer: finding.data?.writer, remedy: finding.data?.remedy, revertSkipped: finding.data?.revertSkipped, atMs: finding.data?.atMs, eventMs: finding.data?.eventMs } });
			}
			clock.advance(stepMs);
		}
	} finally {
		engine.close();
		fs.rmSync(paths.healthHome, { recursive: true, force: true });
	}
	return recorded;
}
