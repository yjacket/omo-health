import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EventWindow } from "../src/collect/logs.mjs";
import { createConfigTracker, parseJsonc, sha1Buffer } from "../src/collect/config-files.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";
import { sessionState } from "./helpers/world.mjs";

const QUIET = DEFAULT_CONFIG.config.lkgQuietMs;

function sandbox() {
	const root = tmpDir();
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo"), OMO_HEALTH_CLAUDE_HOME: path.join(root, "claude") });
	fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
	return { root, paths };
}

function writeAt(file, text, mtimeMs) {
	fs.writeFileSync(file, text);
	fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

test("parseJsonc tolerates comments and trailing commas but not garbage", () => {
	const text = '// head\n{\n  "a": "http://x//y", /* block */\n  "b": [1, 2,],\n  "c": {"d": "/* not a comment */",},\n}\n';
	assert.deepEqual(parseJsonc(text), { a: "http://x//y", b: [1, 2], c: { d: "/* not a comment */" } });
	assert.throws(() => parseJsonc("{ a: 1 }"), SyntaxError);
});

test("tracker reports sha1, parse state and changes", () => {
	const { paths } = sandbox();
	const t0 = Date.parse("2026-09-23T15:00:00Z");
	let now = t0;
	writeAt(paths.settingsFile, '{"x":1}', t0 - 1000);
	fs.writeFileSync(paths.omoJsonc, "{ // c\n \"a\": 1,\n}");
	const tracker = createConfigTracker({ paths, clock: () => now });
	const s1 = tracker.update({ events: new EventWindow(), sessions: new Map() });
	assert.equal(s1.settings.exists, true);
	assert.equal(s1.settings.sha1, sha1Buffer(Buffer.from('{"x":1}')));
	assert.deepEqual(s1.settings.parsed, { x: 1 });
	assert.equal(s1.settings.changedAtMs, t0 - 1000);
	assert.equal(s1.omoJsonc.parseError, undefined);
	assert.equal(s1.lkg, undefined);

	now = t0 + 5000;
	writeAt(paths.settingsFile, '{"x":', t0 + 4000);
	fs.writeFileSync(paths.omoJsonc, "{ nope");
	const s2 = tracker.update({ events: new EventWindow(), sessions: new Map() });
	assert.equal(s2.settings.previousSha1, s1.settings.sha1);
	assert.equal(s2.settings.changedAtMs, t0 + 4000);
	assert.ok(s2.settings.parseError);
	assert.ok(s2.omoJsonc.parseError);
});

test("LKG promotion needs quiet time, no not-configured error and a successful turn after the change", () => {
	const { paths } = sandbox();
	const changed = Date.parse("2026-09-23T15:00:00Z");
	let now = changed + 1000;
	writeAt(paths.settingsFile, '{"good":true}', changed);
	const tracker = createConfigTracker({ paths, clock: () => now });
	const ok = sessionState({ id: "s1", turns: [{ ms: changed + 2000, provider: "anthropic-subscription", stopReason: "stop" }] });
	const sessions = new Map([["s1", ok]]);

	assert.equal(tracker.update({ events: new EventWindow(), sessions }).lkg, undefined, "not quiet yet");

	now = changed + QUIET + 1;
	const events = new EventWindow(24 * 3600_000);
	events.add([{ type: "providerError", ms: changed + 500, error: "Provider is not configured: anthropic-subscription" }], now);
	assert.equal(tracker.update({ events, sessions }).lkg, undefined, "config error since the change");

	assert.equal(tracker.update({ events: new EventWindow(), sessions: new Map() }).lkg, undefined, "no successful turn");

	const failed = new Map([["s1", sessionState({ id: "s1", turns: [{ ms: changed + 2000, stopReason: "error" }] })]]);
	assert.equal(tracker.update({ events: new EventWindow(), sessions: failed }).lkg, undefined, "only an error turn");

	const state = tracker.update({ events: new EventWindow(), sessions });
	assert.equal(state.lkg.sha1, state.settings.sha1);
	assert.equal(state.lkg.savedAtMs, now);
	assert.equal(fs.readFileSync(path.join(paths.health.lkgDir, "settings.json"), "utf8"), '{"good":true}');
});

test("an unparsable settings.json is never promoted", () => {
	const { paths } = sandbox();
	const changed = Date.parse("2026-09-23T15:00:00Z");
	writeAt(paths.settingsFile, "{bad", changed);
	const tracker = createConfigTracker({ paths, clock: () => changed + QUIET + 10 });
	const sessions = new Map([["s1", sessionState({ id: "s1", turns: [{ ms: changed + 2000, stopReason: "stop" }] })]]);
	assert.equal(tracker.update({ events: new EventWindow(), sessions }).lkg, undefined);
	assert.equal(fs.existsSync(path.join(paths.health.lkgDir, "settings.json")), false);
});
