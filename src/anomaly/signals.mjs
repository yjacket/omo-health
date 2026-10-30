import { isSystem32Bash } from "../judge/triage.mjs";
import { truncate } from "../util/text.mjs";

/**
 * General anomaly signals for one pending tool call (plan todo 10). Pure: the caller hands in the call, its process tree
 * and the history lookups. A signal never acts: the engine turns one into an investigation (`trigger: anomaly`) that
 * the analyst is asked about through the same path as a stall suspicion.
 */

/** The finding id the engine gives an anomaly investigation. */
export const ANOMALY_DETECTOR = "D19";
/** Cold start: no signal until the history holds this many finished calls. */
export const COLD_START_COMPLETIONS = 200;
/** A call younger than this raises nothing. */
export const MIN_PENDING_MS = 60_000;

/** Korean names of the signals, for the operator-facing title. */
export const SIGNAL_LABELS_KO = Object.freeze({
	"unseen-lineage": "처음 보는 프로세스 계보",
	"duration-outlier": "평소보다 훨씬 오래 걸림",
	"visible-window": "보이는 창이 열림",
	"system32-bash": "WSL 런처(System32 bash.exe) 실행",
});

const DETAIL_MAX = 240;

/**
 * @param {object} input
 * @param {{ageMs: number, shapeKey?: string, lineageFp?: string, lineage?: string}} input.pending the call
 * @param {object[]} [input.procs] the call's process tree, rows with `name`, `windowVisible`, `windowTitle`
 * @param {(shapeKey: string) => {n: number, median?: number, p99?: number}} input.shapeStats
 * @param {(fp: string) => boolean} input.lineageSeen
 * @param {number} input.completions finished calls in the history
 * @param {{enabled?: boolean, minShapeSamples: number, outlierFactor: number, windowSignal?: boolean}} input.config config.anomaly
 * @returns {{kind: string, detail: string}[]}
 */
export function signals({ pending, procs = [], shapeStats, lineageSeen, completions, config }) {
	if (!config?.enabled || !(completions >= COLD_START_COMPLETIONS) || !(pending?.ageMs >= MIN_PENDING_MS)) return [];
	const out = [];
	if (pending.lineageFp && !lineageSeen(pending.lineageFp)) out.push({ kind: "unseen-lineage", detail: truncate(pending.lineage ?? pending.lineageFp, DETAIL_MAX) });
	if (pending.shapeKey) {
		const stats = shapeStats(pending.shapeKey);
		if (stats && stats.n >= config.minShapeSamples && Number.isFinite(stats.median)) {
			const limit = Math.max(config.outlierFactor * stats.median, stats.p99 ?? 0);
			if (pending.ageMs > limit) out.push({ kind: "duration-outlier", detail: `age ${Math.round(pending.ageMs / 1000)}s > ${Math.round(limit / 1000)}s (median ${Math.round(stats.median / 1000)}s, n=${stats.n})` });
		}
	}
	// The WSL launcher C:\Windows\System32\bash.exe under an agent shell is almost never the bash the agent meant.
	const wsl = procs.find((proc) => isSystem32Bash({ name: proc.name, cmd: proc.cmd ?? proc.cmdHead }));
	if (wsl) out.push({ kind: "system32-bash", detail: truncate(`${wsl.name}${wsl.cmdHead ? `: ${wsl.cmdHead}` : ""}`, DETAIL_MAX) });
	if (config.windowSignal !== false) {
		const shown = procs.filter((proc) => proc.windowVisible === true);
		if (shown.length) out.push({ kind: "visible-window", detail: truncate(shown.slice(0, 3).map((proc) => `${proc.name}${proc.windowTitle ? `: ${proc.windowTitle}` : ""}`).join("; "), DETAIL_MAX) });
	}
	return out;
}
