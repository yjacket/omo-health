// Provider -> subscription account mapping (C-accounts). Pure: no I/O, no clock.
// Providers without an account (github-copilot, opengateway, devin, ...) are still recorded in the
// ledger but belong to no window, so accountOf returns null for them.

const ACCOUNT_BY_PROVIDER = Object.freeze({
	"anthropic-subscription": "anthropic-subscription/default",
	"chatgpt-subscription": "chatgpt-subscription/default",
});

function aliasPairs(aliases) {
	if (!aliases) return [];
	if (Array.isArray(aliases)) return aliases;
	if (typeof aliases === "object") return Object.entries(aliases).map(([from, to]) => `${from}=${to}`);
	return [];
}

// "a=b" entries map provider a to provider b before the account lookup.
function resolveProvider(provider, aliases) {
	let resolved = provider;
	for (const entry of aliasPairs(aliases)) {
		if (typeof entry !== "string") continue;
		const at = entry.indexOf("=");
		if (at <= 0) continue;
		const from = entry.slice(0, at).trim();
		const to = entry.slice(at + 1).trim();
		if (from && to && from === resolved) {
			resolved = to;
			break;
		}
	}
	return resolved;
}

export function accountOf(provider, aliases = []) {
	if (typeof provider !== "string" || provider.length === 0) return null;
	return ACCOUNT_BY_PROVIDER[resolveProvider(provider, aliases)] ?? null;
}

// Window ids shaped "<x>:<y>_<scope>" are scoped to models whose id contains <scope>.
function scopeOf(window) {
	if (!window) return null;
	if (typeof window.scope === "string" && window.scope.length > 0) return window.scope;
	const id = typeof window.id === "string" ? window.id : null;
	if (!id) return null;
	const match = /^[^:]+:[^_]+_(.+)$/u.exec(id);
	return match ? match[1] : null;
}

function modelId(model) {
	if (typeof model === "string") return model;
	if (!model || typeof model !== "object") return null;
	if (typeof model.id === "string") return model.id;
	if (typeof model.model === "string") return model.model;
	return null;
}

export function windowApplies(window, model) {
	if (!window) return false;
	const scope = scopeOf(window);
	if (!scope) return true; // other windows of an account apply to every model of that account
	const id = modelId(model);
	if (!id) return false;
	return id.toLowerCase().includes(scope.toLowerCase());
}
