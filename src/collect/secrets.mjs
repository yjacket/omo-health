import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

/**
 * From omo 5.1.58 the bundled Claude CLI owns the login: the auth.json slot is `{store: "claude-cli", dirId,
 * signedInAt}` and the grant lives in `<agentDir>/anthropic-subscription-claude/<dirId>/.credentials.json`.
 * Projects only the refresh expiry and whether the CLI cleared the refresh token (it does after a refused refresh).
 */
function cliCredentials(authFile, dirId) {
	if (typeof dirId !== "string" || !/^[0-9a-f]+$/i.test(dirId)) return { refreshExpiresMs: undefined, refreshCleared: false };
	const oauth = readJson(path.join(path.dirname(authFile), "anthropic-subscription-claude", dirId, ".credentials.json"))?.claudeAiOauth;
	const expires = oauth?.refreshTokenExpiresAt;
	return {
		refreshExpiresMs: Number.isFinite(expires) && expires > 0 ? expires : undefined,
		refreshCleared: oauth?.refreshToken === "",
	};
}

/**
 * Account projection of the anthropic-subscription slot in omo's auth.json.
 * `digest` is the SHA-256 hex prefix of `refresh`, the same value senpi calls
 * `authGrantDigest` (accounts.js:24); the token itself is never returned.
 * Returns undefined when the file is missing, unreadable or not JSON so callers
 * can tell "unknown" from "no accounts".
 * @returns {{name: string|undefined, source: string|undefined, expires: number|undefined, digest: string|undefined, blockReason: string|undefined, blockedUntil: number|string|undefined, recoveryGrant: boolean, recoveryGrantCurrent: boolean}[]|undefined}
 */
export function readAuthSlots(authFile) {
	const json = readJson(authFile);
	if (json === undefined) return undefined;
	const accounts = json?.[AUTH_PROVIDER]?.accounts;
	if (!Array.isArray(accounts)) return [];
	return accounts
		.filter((account) => account && typeof account === "object")
		.map((account) => {
			const digest =
				typeof account.refresh === "string" && account.refresh.length > 0
					? crypto.createHash("sha256").update(account.refresh).digest("hex").slice(0, 32)
					: undefined;
			const cli =
				account.store === "claude-cli"
					? { store: "claude-cli", signedInMs: Number.isFinite(account.signedInAt) ? account.signedInAt : undefined, ...cliCredentials(authFile, account.dirId) }
					: {};
			return {
				...cli,
				name: typeof account.name === "string" ? account.name : undefined,
				source: typeof account.source === "string" ? account.source : undefined,
				expires: Number.isFinite(account.expires) ? account.expires : undefined,
				digest,
				blockReason: typeof account.blockReason === "string" ? account.blockReason : undefined,
				blockedUntil: scalar(account.blockedUntil),
				recoveryGrant: typeof account.authRecoveryGrant === "string",
				recoveryGrantCurrent: digest !== undefined && account.authRecoveryGrant === digest,
			};
		});
}

