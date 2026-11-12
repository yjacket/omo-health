import path from "node:path";
import { atomicWriteJson, listDirSafe, readJsonSafe } from "../util/fsx.mjs";

/**
 * Owner command queue (plan C-commands, todo 8). The dashboard is the only writer; the daemon's budget office drains the
 * queue every tick. One JSON file per command in `paths.health.budgetCommandsDir`, named `<ms>-<rand>.json`, written
 * atomically so a reader never sees a partial file.
 *
 * Command kinds (exact keys, unknown keys rejected):
 *   {kind: "decide", projectId, requestId, approve: boolean}
 *   {kind: "coupons", account, count: 0..20}
 *
 * `readCommands` returns `[{file, cmd}]` ordered by file name (the leading `ms` keeps writes in time order), where
 * `file` is the absolute path the daemon deletes after applying the command. A file that does not parse yet (a
 * half-written or truncated one) is skipped and left on disk for the next read - the writer replaces it atomically.
 */

const KEYS = Object.freeze({
	decide: Object.freeze(["kind", "projectId", "requestId", "approve"]),
	coupons: Object.freeze(["kind", "account", "count"]),
});

const isText = (value) => typeof value === "string" && value.trim().length > 0;

const fail = (message) => {
	throw new Error(`invalid budget command: ${message}`);
};

/** Validate `cmd` in place; throws an Error naming the first problem. Returns `cmd`. */
function validate(cmd) {
	if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) fail("not an object");
	const allowed = KEYS[cmd.kind];
	if (!allowed) fail(`unknown kind ${JSON.stringify(cmd.kind)}`);
	for (const key of Object.keys(cmd)) {
		if (!allowed.includes(key)) fail(`unknown key ${JSON.stringify(key)} for kind ${cmd.kind}`);
	}
	if (cmd.kind === "decide") {
		if (!isText(cmd.projectId)) fail("decide needs a non-empty projectId");
		if (!isText(cmd.requestId)) fail("decide needs a non-empty requestId");
		if (typeof cmd.approve !== "boolean") fail("decide needs approve: boolean");
		return cmd;
	}
	if (!isText(cmd.account)) fail("coupons needs a non-empty account");
	if (!Number.isInteger(cmd.count) || cmd.count < 0 || cmd.count > 20) fail("coupons needs count: integer 0..20");
	return cmd;
}

/** Dashboard side: validate and write `<budgetCommandsDir>/<ms>-<rand>.json` atomically. Returns the file path. */
export function writeCommand(paths, cmd, { now = Date.now() } = {}) {
	validate(cmd);
	const dir = paths.health.budgetCommandsDir;
	const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	const file = path.join(dir, `${Math.trunc(now)}-${rand}.json`);
	atomicWriteJson(file, cmd);
	return file;
}

/** Daemon side: every complete command file, ordered by file name; unparsable files are skipped and left in place. */
export function readCommands(paths) {
	const dir = paths.health.budgetCommandsDir;
	const names = listDirSafe(dir)
		.filter((name) => name.endsWith(".json"))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const out = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const cmd = readJsonSafe(file);
		if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) continue;
		out.push({ file, cmd });
	}
	return out;
}
