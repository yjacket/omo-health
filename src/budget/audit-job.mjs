// Todo 14: one budget audit as a detached runner job. The runner knows nothing of the audit; the job's kind and
// the parser it registered live in meta.json, so a daemon restarted while an audit ran finds `AUDIT_CONTRACT` through
// `contracts[meta.kind]` (src/runner.mjs:85) and ends the job from its files alone.
import path from "node:path";
import { unavailableReason } from "../judge/analyst.mjs";
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonSafe } from "../util/fsx.mjs";
import { auditArgs, parseOutput, validateOpinion } from "./audit.mjs";

/** The runner job kind every audit is started with. */
export const AUDIT_JOB_KIND = "budget-audit";

/**
 * The kind-level contract a polling runner is created with: `createRunner({ ..., contracts: { [AUDIT_JOB_KIND]:
 * AUDIT_CONTRACT } })`. It is what lets a runner that never called `start` for this job read its answer.
 */
export const AUDIT_CONTRACT = Object.freeze({ parse: parseOutput, unavailableReason });

/** The model reads the bundle from `<jobDir>/bundle.md` and the sidecar keeps the audit's identity. */
const BUNDLE_FILE = "bundle.md";
const META_FILE = "audit.json";

function objectEnd(src, start) {
	let depth = 0;
	let inString = false;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (inString) {
			if (ch === "\\") i += 1;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

/** The last JSON object in the answer that looks like an audit opinion (the final assistant text is the answer). */
function lastOpinion(text) {
	const src = String(text ?? "");
	let found = null;
	for (let i = src.indexOf("{"); i >= 0; i = src.indexOf("{", i + 1)) {
		const end = objectEnd(src, i);
		if (end < 0) continue;
		try {
			const value = JSON.parse(src.slice(i, end + 1));
			if (value && typeof value === "object" && !Array.isArray(value) && "assessment" in value) {
				found = value;
				i = end;
			}
		} catch {
			// not JSON: keep scanning from the next brace
		}
	}
	return found;
}

/**
 * Write the bundle into the job directory and start the detached audit run with the guarded argv of C-audit.
 * The OMO command resolves like the analyst's (`OMO_HEALTH_OMO`, else `omo`).
 * @returns {{jobId: string, pid: number, dir: string, bundleFile: string}}
 */
export function startAudit({ runner, paths, model, bundle, projectId, auditId, timeoutMs }) {
	const jobId = String(auditId);
	const dir = path.join(paths.health.jobsDir, jobId);
	ensureDir(dir);
	const bundleFile = path.join(dir, BUNDLE_FILE);
	atomicWriteFile(bundleFile, typeof bundle === "string" ? bundle : JSON.stringify(bundle ?? ""));
	// The audit's identity for a poll that only has the job directory (validateOpinion checks the answer against it).
	atomicWriteJson(path.join(dir, META_FILE), { jobId, auditId: jobId, projectId, model });
	const started = runner.start({
		jobId,
		kind: AUDIT_JOB_KIND,
		command: process.env.OMO_HEALTH_OMO ?? "omo",
		args: auditArgs({ model, bundleFile }),
		cwd: dir,
		timeoutMs,
		...AUDIT_CONTRACT,
	});
	return { ...started, bundleFile };
}

/**
 * One poll of an audit job: `running`, `done` with the validated opinion and its usage, or `failed` with reason
 * `invalid-opinion` / the runner's failure reason, `unavailable` (never retried inside the same poll) or `timeout`.
 */
export function pollAudit(runner, jobId) {
	const out = runner.poll(jobId) ?? { status: "running" };
	if (out.status === "running") return { status: "running" };
	if (out.status === "done") {
		const parsed = out.result && typeof out.result === "object" ? out.result : { opinionText: "", usage: null };
		const usage = parsed.usage ?? null;
		const opinion = lastOpinion(parsed.opinionText);
		if (!opinion) return { status: "failed", reason: "invalid-opinion", detail: "no JSON opinion in the job output", usage };
		const audit = readJsonSafe(path.join(runner.jobDir(jobId), META_FILE));
		const identity = audit && typeof audit === "object" ? { auditId: audit.auditId, projectId: audit.projectId } : {};
		const checked = validateOpinion(opinion, identity);
		if (!checked.ok) return { status: "failed", reason: "invalid-opinion", errors: checked.errors, usage };
		return { status: "done", opinion: checked.value, usage };
	}
	if (out.status === "unavailable") return { status: "unavailable", reason: out.reason ?? null, detail: out.detail ?? null };
	if (out.status === "timeout") return { status: "timeout", reason: out.reason ?? null };
	return { status: "failed", reason: out.reason ?? "no-result", detail: out.detail ?? null };
}
