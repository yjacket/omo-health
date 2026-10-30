import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/detect/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";

const T = (iso) => Date.parse(iso);
const paths = resolvePaths({ USERPROFILE: "C:\\fakehome", OMO_HEALTH_HOME: "C:\\fakehome\\.omo-health-test", OMO_HEALTH_OMO_HOME: "C:\\fakehome\\.omo-test" });
const NOT_CONFIGURED = "Provider is not configured: anthropic-subscription";

const EDIT_MS = T("2026-09-23T15:47:04.855Z");
const CHANGE_MS = T("2026-09-23T15:47:05.163Z");
const FIRST_ERR_MS = T("2026-09-23T15:47:05.230Z");
const BAD_SHA = "b".repeat(40);
const LKG_SHA = "a".repeat(40);

function settingsState(parsed, extra = {}) {
	return { file: paths.settingsFile, exists: true, sha1: BAD_SHA, mtimeMs: EDIT_MS, parsed, parseError: undefined, changedAtMs: EDIT_MS, previousSha1: LKG_SHA, ...extra };
}

/** F1 (F-15): session 01a0ce04 edits settings.json with ambient but no enabled; 12 not-configured errors follow. */
function f1World({ turns, configState = {}, now = FIRST_ERR_MS + 15_000, config, extraEvents = [] } = {}) {
	const writer = sessionState({
		id: "01a0ce04",
		writes: [{ ms: EDIT_MS - 400, tool: "edit", path: paths.settingsFile, id: "toolu_edit1" }],
		turns: turns ?? [
			{ ms: T("2026-09-23T15:40:00Z"), provider: "anthropic-subscription", stopReason: "toolUse" },
			{ ms: EDIT_MS - 400, provider: "anthropic-subscription", stopReason: "toolUse" },
		],
	});
	const events = [
		{ type: "change", ms: CHANGE_MS, paths: [paths.settingsFile] },
		...Array.from({ length: 12 }, (_, i) => ({ type: "providerError", ms: FIRST_ERR_MS + i * 500, error: NOT_CONFIGURED })),
		...extraEvents,
	];
	return makeWorld({
		now,
		paths,
		config,
		sessions: [writer],
		events,
		configState: {
			settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient" } }),
			omoJsonc: { file: paths.omoJsonc, exists: true, sha1: "c".repeat(40), parseError: undefined },
			lkg: { sha1: LKG_SHA, savedAtMs: T("2026-09-23T15:00:00Z") },
			lastRevert: undefined,
			...configState,
		},
	});
}

const broke = (findings) => findings.find((f) => f.kind === "settings-broke-provider");

test("F1 reconstruction -> revert remedy with writer attribution, plus L2", () => {
	const findings = detect(f1World());
	const f = broke(findings);
	assert.equal(f.severity, "crit");
	assert.deepEqual(f.data.remedy, { kind: "revert-settings", fromSha1: BAD_SHA, toSha1: LKG_SHA });
	assert.deepEqual(f.data.writer, { sessionId: "01a0ce04", toolCallId: "toolu_edit1", tool: "edit" });
	assert.equal(f.data.errorCount, 12);
	assert.equal(f.data.revertSkipped, undefined);
	assert.ok(findings.some((x) => x.kind === "ambient-not-enabled" && x.severity === "crit"));
});

test("historical scan: change dated from the log, writer attributed, no lint on unknown past content", () => {
	const historical = { file: paths.settingsFile, exists: true, historical: true, sha1: "history" };
	const findings = detect(f1World({ configState: { settings: historical, lkg: undefined, omoJsonc: { exists: false } } }));
	assert.deepEqual(findings.map((x) => x.kind), ["settings-broke-provider"]);
	const [f] = findings;
	assert.equal(f.data.changedAtMs, CHANGE_MS);
	assert.deepEqual(f.data.writer, { sessionId: "01a0ce04", toolCallId: "toolu_edit1", tool: "edit" });
	assert.equal(f.data.revertSkipped, "no-lkg");
	assert.equal(f.subject.key, `settings:history@${CHANGE_MS}`);
});

test("an error logged in the same millisecond as the file's sub-ms mtime still counts", () => {
	const f = broke(detect(f1World({ configState: { settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient" } }, { changedAtMs: FIRST_ERR_MS + 0.5 }) } })));
	assert.equal(f.data.errorCount, 12);
});

test("lane already failing before the change -> no revert", () => {
	const f = broke(detect(f1World({ turns: [{ ms: EDIT_MS - 60 * 60_000, provider: "anthropic-subscription", stopReason: "stop" }, { ms: EDIT_MS - 60_000, provider: "anthropic-subscription", stopReason: "error" }] })));
	assert.equal(f.data.remedy, undefined);
	assert.equal(f.data.revertSkipped, "lane-not-ok-before-change");
});

test("revert cooldown -> no revert", () => {
	const f = broke(detect(f1World({ configState: { lastRevert: { atMs: EDIT_MS - 5 * 60_000, fromSha1: "d".repeat(40), toSha1: LKG_SHA } } })));
	assert.equal(f.data.remedy, undefined);
	assert.equal(f.data.revertSkipped, "cooldown");
});

test("no LKG -> no revert with reason no-lkg; LKG equal to current -> lkg-same", () => {
	assert.equal(broke(detect(f1World({ configState: { lkg: undefined } }))).data.revertSkipped, "no-lkg");
	assert.equal(broke(detect(f1World({ configState: { lkg: { sha1: BAD_SHA, savedAtMs: 1 } } }))).data.revertSkipped, "lkg-same");
});

test("never revert a revert: errors continuing after our revert go to a human", () => {
	const f = broke(detect(f1World({ configState: { lastRevert: { atMs: EDIT_MS - 60 * 60_000, fromSha1: "d".repeat(40), toSha1: BAD_SHA } } })));
	assert.equal(f.data.revertSkipped, "is-revert");
	assert.equal(f.humanNeeded, true);
});

test("autoRevert disabled -> skipped disabled", () => {
	assert.equal(broke(detect(f1World({ config: { config: { autoRevert: false } } }))).data.revertSkipped, "disabled");
});

test("no burst after the change -> no revert finding", () => {
	const world = makeWorld({
		now: FIRST_ERR_MS + 15_000,
		paths,
		events: [{ type: "providerError", ms: FIRST_ERR_MS, error: NOT_CONFIGURED }],
		configState: { settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient", enabled: true } }), lkg: { sha1: LKG_SHA } },
	});
	assert.deepEqual(detect(world), []);
});

test("writer attribution via bash text mentioning the file", () => {
	const s = sessionState({ id: "s9", commands: [{ ms: EDIT_MS + 3000, tool: "bash", text: "sed -i 's/x/y/' ~/.omo/agent/settings.json", id: "toolu_bash" }] });
	const world = makeWorld({ now: EDIT_MS + 20_000, paths, sessions: [s], configState: { settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient" } }) } });
	const l2 = detect(world).find((f) => f.kind === "ambient-not-enabled");
	assert.deepEqual(l2.data.writer, { sessionId: "s9", toolCallId: "toolu_bash", tool: "bash" });
	const far = sessionState({ id: "s9", commands: [{ ms: EDIT_MS + 30_000, tool: "bash", text: "cat .omo/agent/settings.json", id: "t" }] });
	const world2 = makeWorld({ now: EDIT_MS + 40_000, paths, sessions: [far], configState: { settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient" } }) } });
	assert.equal(detect(world2).find((f) => f.kind === "ambient-not-enabled").data.writer, undefined);
});

test("L1 settings parse failure and L4 omo.jsonc parse failure", () => {
	const world = makeWorld({
		now: EDIT_MS,
		paths,
		configState: {
			settings: settingsState(undefined, { parseError: "Unexpected token" }),
			omoJsonc: { file: paths.omoJsonc, exists: true, sha1: "c".repeat(40), parseError: "Unexpected end" },
		},
	});
	const kinds = detect(world).map((f) => [f.kind, f.severity]);
	assert.deepEqual(kinds.sort(), [["omo-jsonc-parse-error", "warn"], ["settings-parse-error", "crit"]]);
});

test("healthy ambient settings -> no lint; empty settings -> no lint", () => {
	const good = { settings: settingsState({ anthropicSubscriptionProvider: { tokenInjection: "ambient", enabled: true } }) };
	assert.deepEqual(detect(makeWorld({ now: EDIT_MS, paths, configState: good })), []);
	const none = { settings: settingsState({}) };
	assert.deepEqual(detect(makeWorld({ now: EDIT_MS, paths, configState: none })), []);
});
