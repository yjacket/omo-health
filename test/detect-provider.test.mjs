import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProviderError, detect, laneRecoveredAfter, providerHealth } from "../src/detect/provider.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const T = (iso) => Date.parse(iso);
const perr = (ms, error, extra = {}) => ({ type: "providerError", ms, error, ...extra });
const NOT_CONFIGURED = "Provider is not configured: anthropic-subscription";
const BLOCKED = "All Anthropic Subscription accounts are blocked";
const REVOKED = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}';

test("classifyProviderError covers every class", () => {
	assert.equal(classifyProviderError(NOT_CONFIGURED), "not-configured");
	assert.equal(classifyProviderError(BLOCKED), "blocked");
	assert.equal(classifyProviderError("All Claude accounts are currently blocked (auth)"), "blocked");
	assert.equal(classifyProviderError(REVOKED), "revoked");
	assert.equal(classifyProviderError("Codex error: The usage limit has been reached"), "usage-limit");
	assert.equal(classifyProviderError("socket hang up"), "other");
});

test("F1: 12 not-configured errors -> crit burst; provider and affected sessions come from the events", () => {
	const start = T("2026-09-23T15:47:05.230Z");
	const events = Array.from({ length: 12 }, (_, i) => perr(start + i * 400, NOT_CONFIGURED, { provider: "anthropic-subscription", sessionId: i % 2 ? "sB" : "sA" }));
	const world = makeWorld({ now: start + 10_000, events });
	const burst = detect(world).find((f) => f.kind === "not-configured-burst");
	assert.equal(burst.severity, "crit");
	assert.equal(burst.data.provider, "anthropic-subscription");
	assert.equal(burst.data.count, 12);
	assert.deepEqual(burst.data.affectedSessions, ["sA", "sB"]);
	assert.equal(burst.data.recoveredAt, undefined);
});

test("below the burst threshold -> no finding; recovery marks recoveredAt", () => {
	const start = T("2026-09-23T15:47:05.230Z");
	assert.equal(detect(makeWorld({ now: start + 5000, events: [perr(start, NOT_CONFIGURED), perr(start + 100, NOT_CONFIGURED)] })).length, 0);
	const ok = sessionState({ id: "s1", turns: [{ ms: start + 9 * 60_000, provider: "anthropic-subscription", stopReason: "stop" }] });
	const events = [0, 1, 2].map((i) => perr(start + i * 100, NOT_CONFIGURED, { provider: "anthropic-subscription" }));
	const world = makeWorld({ now: start + 10 * 60_000, events, sessions: [ok] });
	const findings = detect(world);
	const burst = findings.find((f) => f.kind === "not-configured-burst");
	assert.equal(burst.data.recoveredAt, start + 9 * 60_000);
	assert.equal(burst.severity, "info");
	assert.equal(findings.some((f) => f.kind === "outage-human"), false);
});

test("an unrecovered burst lasting > outageHumanMs escalates to outage-human", () => {
	const start = T("2026-09-23T15:47:05.230Z");
	const events = [0, 1, 2].map((i) => perr(start + i * 100, NOT_CONFIGURED));
	const outage = detect(makeWorld({ now: start + 6 * 60_000, events })).find((f) => f.kind === "outage-human");
	assert.equal(outage.humanNeeded, true);
	assert.equal(outage.data.sinceMs, start);
});

test("F4: blocked errors are humanNeeded, list their sessions, and carry no #8762 annotation", () => {
	const r = T("2026-09-23T10:23:41.857Z");
	const events = [
		perr(r, REVOKED, { sessionId: "sR" }),
		...Array.from({ length: 18 }, (_, i) => perr(T("2026-09-23T10:23:41.912Z") + i * 1000, BLOCKED, { sessionId: i % 3 ? "sA" : "sB" })),
	];
	const f = detect(makeWorld({ now: r + 60_000, events })).find((x) => x.kind === "accounts-blocked");
	assert.equal(f.severity, "crit");
	assert.equal(f.humanNeeded, true);
	assert.equal(f.data.count, 18);
	assert.deepEqual(f.data.affectedSessions, ["sA", "sB"]);
	assert.equal("signature8762" in f.data, false);
	assert.equal(f.evidence.some((e) => e.includes("8762")), false);
});

test("blockReason from auth.json alone", () => {
	const b = T("2026-09-23T10:23:41.912Z");
	const fromAuth = detect(makeWorld({ now: b, secrets: { authBlocks: [{ name: "main", blockReason: "revoked", blockedUntil: undefined }] } })).find((x) => x.kind === "accounts-blocked");
	assert.equal(fromAuth.humanNeeded, true);
	assert.deepEqual(fromAuth.data.accounts.map((a) => a.name), ["main"]);
	assert.equal(detect(makeWorld({ now: b, secrets: { authBlocks: [{ name: "main" }] } })).length, 0);
});

test("usage-limit storm: >= stormCount cooldown/fallback for one selector within the window", () => {
	const now = T("2026-09-23T21:06:00Z");
	const sel = "chatgpt-subscription/gpt-6-luna-fast";
	const events = [];
	for (const m of [20, 10, 1]) {
		events.push({ type: "cooldown", ms: now - m * 60_000, selector: sel, error: "Codex error: The usage limit has been reached" });
		events.push({ type: "fallback", ms: now - m * 60_000 + 2, from: sel, to: "anthropic-subscription/claude-haiku-4-5", reason: "billing" });
	}
	events.push({ type: "cooldown", ms: now - 40 * 60_000, selector: "other/x", error: "usage limit" });
	const storms = detect(makeWorld({ now, events })).filter((f) => f.kind === "usage-limit-storm");
	assert.equal(storms.length, 1);
	assert.equal(storms[0].severity, "warn");
	assert.equal(storms[0].data.selector, sel);
	assert.equal(storms[0].data.count, 3);
	const old = events.map((e) => ({ ...e, ms: e.ms - 40 * 60_000 }));
	assert.equal(detect(makeWorld({ now, events: old })).some((f) => f.kind === "usage-limit-storm"), false);
});

test("providerHealth and laneRecoveredAfter", () => {
	const t0 = T("2026-09-23T15:00:00Z");
	const s = sessionState({
		id: "s1",
		turns: [
			{ ms: t0, provider: "anthropic-subscription", stopReason: "stop" },
			{ ms: t0 + 1000, provider: "anthropic-subscription", stopReason: "error" },
			{ ms: t0 + 5000, provider: "anthropic-subscription", stopReason: "toolUse" },
			{ ms: t0 + 6000, provider: "chatgpt-subscription", stopReason: "stop" },
		],
		errors: [{ ms: t0 + 1000, text: NOT_CONFIGURED, provider: "anthropic-subscription" }],
	});
	const world = makeWorld({ now: t0 + 10_000, sessions: [s], events: [perr(t0 + 2000, NOT_CONFIGURED, { provider: "anthropic-subscription" })] });
	const health = providerHealth(world);
	assert.deepEqual(health.get("anthropic-subscription"), { lastErrorMs: t0 + 2000, lastErrorClass: "not-configured", lastOkMs: t0 + 5000 });
	assert.equal(health.get("chatgpt-subscription").lastOkMs, t0 + 6000);
	assert.equal(laneRecoveredAfter(world, "anthropic-subscription", t0 + 2000), t0 + 5000);
	assert.equal(laneRecoveredAfter(world, "anthropic-subscription", t0 + 5000), undefined);
});
