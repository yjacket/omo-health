import { EventEmitter } from "node:events";

/**
 * In-memory stand-in for `createRunner` (src/runner.mjs) with the same
 * `start`/`poll` contract. `outcomes` maps a jobId or a job kind to either a
 * poll result or an array of poll results returned in order (the last one
 * repeats). Unscripted jobs finish as `{ status: "done", result: null }`.
 *
 * It also stands in for the analyst's process runner (src/judge/analyst.mjs),
 * where `start` gets `parse` and `unavailableReason` functions: a scripted
 * `{ status: "done", stdout }` without `result` yields `result: parse(stdout)`,
 * and a scripted `{ status: "failed", stderr?, stdout? }` becomes
 * `{ status: "unavailable", reason }` when `unavailableReason(output)` names one.
 */
export function createFakeRunner({ outcomes = {} } = {}) {
	const jobs = new Map();
	const starts = [];
	const resolveOutcome = (opts, out) => {
		if (out?.status === "done" && out.result === undefined && typeof out.stdout === "string" && typeof opts?.parse === "function") return { ...out, result: opts.parse(out.stdout) };
		if (out?.status === "failed" && (out.stderr !== undefined || out.stdout !== undefined) && typeof opts?.unavailableReason === "function") {
			const text = `${out.stderr ?? ""}\n${out.stdout ?? ""}`;
			const reason = opts.unavailableReason(text);
			if (reason) return { ...out, status: "unavailable", reason, detail: text.trim() };
		}
		return out;
	};
	return {
		starts,
		jobDir: (jobId) => `fake-jobs/${jobId}`,
		start(opts) {
			starts.push(opts);
			const script = outcomes[opts.jobId] ?? outcomes[opts.kind] ?? { status: "done", result: null, exitCode: 0 };
			if (script instanceof Error) throw script;
			jobs.set(opts.jobId, { opts, queue: Array.isArray(script) ? [...script] : [script] });
			return { jobId: opts.jobId, pid: 40000 + starts.length, dir: `fake-jobs/${opts.jobId}` };
		},
		poll(jobId) {
			const job = jobs.get(jobId);
			if (!job) return { status: "failed", reason: "no-job", result: null, exitCode: null };
			return resolveOutcome(job.opts, job.queue.length > 1 ? job.queue.shift() : job.queue[0]);
		},
	};
}

/**
 * Recording `spawnImpl`: every call is kept in `calls`; each returns a child
 * stub with a pid. `onSpawn(command, args, options)` may return a real child
 * to use instead.
 */
export function createRecordingSpawn({ onSpawn } = {}) {
	const calls = [];
	let nextPid = 70000;
	const spawnImpl = (command, args, options) => {
		calls.push({ command, args, options });
		const real = onSpawn?.(command, args, options);
		if (real) return real;
		const child = new EventEmitter();
		child.pid = nextPid++;
		child.unref = () => {};
		return child;
	};
	return { spawnImpl, calls };
}
