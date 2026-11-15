import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSubscriptionUsage } from "../src/collect/subscriptions.mjs";

// Producer shape and failure behavior read from
// @code-yeongyu/senpi/dist/core/subscription-limits/usage-cache.js:37-43 (`withResults` keeps the
// previous windows beside a failed reading) and usage-poller.js:85-104 (a failed/pending poll still
// advances `updatedAt`), keys `${provider}/${account}` from usage-cache.js `usageKey`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const STALE_MS = 10 * MIN;
const RESET = "2026-11-17T12:00:00.490Z";

function cacheFile(t, value) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-subscriptions-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "subscription-usage.json");
	if (value !== undefined) fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

function read(file) {
	return readSubscriptionUsage(file, { now: NOW, staleMs: STALE_MS });
}

test("a fresh cache yields both accounts with parsed windows, timestamps and scopes", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"anthropic-subscription/default": {
				plan: "max",
				updatedAt: NOW - 30_000,
				nextAt: NOW + 4 * MIN,
				windows: [
					{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 70, resetsAt: RESET },
					{ id: "claude:7d_fable", label: "7d fable", windowMinutes: 10080, usedPercent: 12, resetsAt: RESET },
				],
			},
			"chatgpt-subscription/default": {
				plan: "prolite",
				updatedAt: NOW - 60_000,
				nextAt: NOW + 90_000,
				windows: [{ id: "codex:primary", label: "7d", windowMinutes: 10080, usedPercent: 77, resetsAt: RESET }],
			},
		},
	});
	const out = read(file);
	assert.equal(out.ok, true);
	assert.deepEqual(out.accounts.map((a) => a.account), ["anthropic-subscription/default", "chatgpt-subscription/default"]);
	assert.deepEqual(out.accounts[0], {
		account: "anthropic-subscription/default",
		provider: "anthropic-subscription",
		plan: "max",
		updatedMs: NOW - 30_000,
		nextMs: NOW + 4 * MIN,
		error: null,
		pending: false,
		failed: false,
		stale: false,
		windows: [
			{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 70, resetsAtMs: Date.parse(RESET), scope: null },
			{ id: "claude:7d_fable", label: "7d fable", windowMinutes: 10080, usedPercent: 12, resetsAtMs: Date.parse(RESET), scope: "fable" },
		],
	});
	assert.equal(out.accounts[1].stale, false);
	assert.equal(out.accounts[1].windows[0].scope, null);
});

test("a reading older than staleMs is stale, and exactly staleMs old is still fresh", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"anthropic-subscription/default": { updatedAt: NOW - STALE_MS - 1, nextAt: NOW + MIN, windows: [] },
			"chatgpt-subscription/default": { updatedAt: NOW - STALE_MS, nextAt: NOW + MIN, windows: [] },
		},
	});
	const out = read(file);
	assert.equal(out.accounts[0].stale, true);
	assert.equal(out.accounts[1].stale, false);
});

test("a missing file is not ok and throws nothing", (t) => {
	const out = read(cacheFile(t, undefined));
	assert.deepEqual(out.accounts, []);
	assert.equal(out.ok, false);
	assert.equal(typeof out.error, "string");
});

test("truncated JSON is not ok and throws nothing", (t) => {
	const out = read(cacheFile(t, '{"accounts": {"anthropic-subscription/default": {"plan":'));
	assert.deepEqual(out.accounts, []);
	assert.equal(out.ok, false);
	assert.equal(typeof out.error, "string");
});

test("valid JSON without an accounts object is not ok", (t) => {
	const out = read(cacheFile(t, { fetching: {} }));
	assert.deepEqual(out.accounts, []);
	assert.equal(out.ok, false);
});

test("scope is the text after the underscore, null for plain ids", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"anthropic-subscription/default": {
				updatedAt: NOW,
				nextAt: NOW + MIN,
				windows: [
					{ id: "claude:7d_fable", label: "7d", usedPercent: 1 },
					{ id: "claude:7d", label: "7d", usedPercent: 2 },
					{ id: "claude:5h_opus_extra", label: "5h", usedPercent: 3 },
					{ id: "codex:primary", label: "7d", usedPercent: 4 },
				],
			},
		},
	});
	assert.deepEqual(read(file).accounts[0].windows.map((w) => w.scope), ["fable", null, "opus_extra", null]);
});

test("missing optional windows and window fields read as empty and null", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"anthropic-subscription/default": { updatedAt: NOW, nextAt: NOW + MIN },
			"chatgpt-subscription/default": { updatedAt: NOW, nextAt: NOW + MIN, windows: [{ id: "codex:primary", label: "7d", usedPercent: 3 }] },
		},
	});
	const out = read(file);
	assert.deepEqual(out.accounts[0].windows, []);
	assert.deepEqual(out.accounts[1].windows, [
		{ id: "codex:primary", label: "7d", windowMinutes: null, usedPercent: 3, resetsAtMs: null, scope: null },
	]);
});

test("a failed poll with a fresh timestamp is failed and stale, old windows still returned", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"anthropic-subscription/default": {
				plan: "max",
				updatedAt: NOW,
				nextAt: NOW + 2 * HOUR,
				error: "http-500",
				windows: [{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 40, resetsAt: RESET }],
			},
		},
	});
	const [account] = read(file).accounts;
	assert.equal(account.failed, true);
	assert.equal(account.stale, true);
	assert.equal(account.error, "http-500");
	assert.equal(account.pending, false);
	assert.deepEqual(account.windows.map((w) => w.usedPercent), [40]);
});

test("a pending account is stale even with a fresh timestamp", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"chatgpt-subscription/default": { plan: "prolite", updatedAt: NOW, nextAt: NOW + MIN, pending: true, windows: [] },
		},
	});
	const [account] = read(file).accounts;
	assert.equal(account.pending, true);
	assert.equal(account.failed, false);
	assert.equal(account.stale, true);
});

test("an error string is truncated to 200 characters", (t) => {
	const file = cacheFile(t, {
		accounts: {
			"chatgpt-subscription/default": { updatedAt: NOW, nextAt: NOW + MIN, error: "x".repeat(500), windows: [] },
		},
	});
	const [account] = read(file).accounts;
	assert.equal(account.error.length, 200);
	assert.equal(account.failed, true);
});
