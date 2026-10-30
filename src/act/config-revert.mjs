import fs from "node:fs";
import path from "node:path";
import { lkgFiles, readLkgState, sha1Buffer, writeLkgState } from "../collect/config-files.mjs";
import { atomicWriteFile, ensureDir } from "../util/fsx.mjs";

function readSafe(file) {
	try {
		return fs.readFileSync(file);
	} catch {
		return undefined;
	}
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");

/**
 * Restore settings.json from the last-known-good copy (plan todo 13, IS-10a, R1-B4).
 *
 * The rejected file is copied to healthHome/lkg/rejected/ (never next to
 * settings.json). The current sha1 is re-read immediately before the atomic
 * rename; if it no longer equals `fromSha1` someone else wrote the file and
 * the revert is abandoned with skipped:"changed".
 *
 * @param {object} options
 * @param {object} options.paths          resolvePaths() result
 * @param {string} options.fromSha1       sha1 of the settings.json the decision was made on
 * @param {string} options.toSha1         sha1 of the LKG copy to restore
 * @param {() => number} [options.clock]
 * @param {() => void} [options.beforeCommit]  test hook, runs right before the final CAS check
 * @returns {{ok: true, rejectedCopy: string, atMs: number} | {ok: false, skipped?: "changed"|"no-lkg"|"lkg-mismatch", error?: string, rejectedCopy?: string, currentSha1?: string}}
 */
export function revertSettings({ paths, fromSha1, toSha1, clock = () => Date.now(), beforeCommit }) {
	const files = lkgFiles(paths);
	const lkg = readSafe(files.settings);
	if (!lkg) return { ok: false, skipped: "no-lkg" };
	if (sha1Buffer(lkg) !== toSha1) return { ok: false, skipped: "lkg-mismatch", lkgSha1: sha1Buffer(lkg) };

	const current = readSafe(paths.settingsFile);
	const currentSha1 = current ? sha1Buffer(current) : undefined;
	if (currentSha1 !== fromSha1) return { ok: false, skipped: "changed", currentSha1 };

	const atMs = clock();
	ensureDir(files.rejectedDir);
	let rejectedCopy = path.join(files.rejectedDir, `settings.${stamp(atMs)}.json`);
	for (let n = 1; fs.existsSync(rejectedCopy); n++) rejectedCopy = path.join(files.rejectedDir, `settings.${stamp(atMs)}.${n}.json`);
	fs.writeFileSync(rejectedCopy, current);

	beforeCommit?.();

	// R1-B4 compare-and-swap: re-read right before the rename
	const again = readSafe(paths.settingsFile);
	const againSha1 = again ? sha1Buffer(again) : undefined;
	if (againSha1 !== fromSha1) return { ok: false, skipped: "changed", currentSha1: againSha1, rejectedCopy };

	atomicWriteFile(paths.settingsFile, lkg);

	const written = readSafe(paths.settingsFile);
	const writtenSha1 = written ? sha1Buffer(written) : undefined;
	if (writtenSha1 !== toSha1) return { ok: false, error: "verify-failed", currentSha1: writtenSha1, rejectedCopy };

	const state = readLkgState(paths);
	writeLkgState(paths, { ...state, lastRevert: { atMs, fromSha1, toSha1 } });
	return { ok: true, rejectedCopy, atMs };
}
