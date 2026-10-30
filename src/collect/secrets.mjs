import fs from "node:fs";

/**
 * Whitelisted readers for credential files (plan todo 13).
 *
 * Each reader parses the file and immediately projects a fixed set of
 * non-secret fields. Tokens are never returned, logged or stored; on any
 * failure the reader returns an empty result without echoing file content.
 */

const AUTH_PROVIDER = "anthropic-subscription";

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function scalar(value) {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Block state of the anthropic-subscription accounts in omo's auth.json.
 * @returns {{name: string|undefined, blockReason: string|undefined, blockedUntil: number|string|undefined}[]}
 */
export function readAuthBlocks(authFile) {
	const accounts = readJson(authFile)?.[AUTH_PROVIDER]?.accounts;
	if (!Array.isArray(accounts)) return [];
	return accounts
		.filter((account) => account && typeof account === "object")
		.map((account) => ({
			name: typeof account.name === "string" ? account.name : undefined,
			blockReason: typeof account.blockReason === "string" ? account.blockReason : undefined,
			blockedUntil: scalar(account.blockedUntil),
		}));
}

