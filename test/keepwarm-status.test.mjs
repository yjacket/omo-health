import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { keepwarmStatus, statusReport } from "../bin/omo-health.mjs";
import sensor from "../extension/sensor.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const NOW = 1_790_000_000_000;

function fixture(content) {
	const home = tmpDir("omoh-kw-");
	if (content !== undefined) {
		fs.mkdirSync(path.join(home, "status"), { recursive: true });
		fs.writeFileSync(path.join(home, "status", "_global.json"), typeof content === "string" ? content : JSON.stringify(content));
	}
	return { OMO_KEEPWARM_HOME: home };
}

const fresh = { v: 1, ts: NOW - 60_000, staleAfter: NOW + 600_000, level: "ok", text: "keepwarm: shadow, 2 sessions" };

test("missing snapshot -> null", () => {
	assert.equal(keepwarmStatus({ env: fixture(), now: NOW }), null);
});

test("fresh snapshot -> level, snapshot text, ts", () => {
	assert.deepEqual(keepwarmStatus({ env: fixture(fresh), now: NOW }), { level: "ok", text: fresh.text, ts: fresh.ts });
});

test("now past staleAfter -> unknown (stale); exactly staleAfter is still fresh", () => {
	const env = fixture({ ...fresh, staleAfter: NOW - 1 });
	assert.deepEqual(keepwarmStatus({ env, now: NOW }), { level: "unknown", text: "keepwarm: unknown (stale)" });
	assert.equal(keepwarmStatus({ env: fixture({ ...fresh, staleAfter: NOW }), now: NOW }).level, "ok");
});

test("corrupt json or v !== 1 -> unknown (unreadable)", () => {
	const unreadable = { level: "unknown", text: "keepwarm: unknown (unreadable)" };
	assert.deepEqual(keepwarmStatus({ env: fixture("{bad"), now: NOW }), unreadable);
	assert.deepEqual(keepwarmStatus({ env: fixture({ ...fresh, v: 2 }), now: NOW }), unreadable);
});

test("statusReport carries the keepwarm field", () => {
	const paths = resolvePaths({ OMO_HEALTH_HOME: tmpDir("omoh-kwh-") });
	assert.equal(statusReport(paths, NOW, fixture()).keepwarm, null);
	assert.equal(statusReport(paths, NOW, fixture(fresh)).keepwarm.text, fresh.text);
});

function fakeUi() {
	const widgets = [];
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		cwd: "C:\dev\proj",
		sessionKind: "interactive",
		on: (e, h) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		sendMessage() {},
		registerCommand: (n, s) => commands.set(n, s),
	};
	const ctx = {
		cwd: pi.cwd,
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
		sessionManager: { getSessionId: () => "s-1", getSessionFile: () => "C:/s/s-1.jsonl" },
		ui: { setStatus() {}, setWidget: (k, l) => widgets.push([k, l]), notify() {} },
	};
	return { pi, ctx, widgets, commands };
}

async function healthLines(env) {
	const { pi, ctx, widgets, commands } = fakeUi();
	sensor(pi, {
		healthHome: tmpDir("omoh-kws-"),
		repoRoot: tmpDir("omoh-kwr-"),
		now: () => NOW,
		setInterval: () => ({ unref() {} }),
		clearInterval() {},
		spawn: () => ({ unref() {} }),
		env,
		platform: "linux",
	});
	await commands.get("health").handler("", ctx);
	return widgets.at(-1)[1];
}

test("/health shows the keepwarm line for fresh and stale snapshots, none when missing", async () => {
	assert.ok((await healthLines(fixture(fresh))).includes(fresh.text));
	assert.ok((await healthLines(fixture({ ...fresh, staleAfter: NOW - 1 }))).includes("keepwarm: unknown (stale)"));
	assert.ok((await healthLines(fixture("{bad"))).includes("keepwarm: unknown (unreadable)"));
	assert.ok(!(await healthLines(fixture())).some((l) => l.startsWith("keepwarm")));
});

test("status --json carries the baseline's deviation fires and paid looks from the global status (#86 review)", () => {
	const root = tmpDir("omoh-status-baseline-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), USERPROFILE: root });
	fs.mkdirSync(paths.health.statusDir, { recursive: true });
	const baseline = { fires: { lastHour: 2, lastDay: 5 }, metrics: { births: { samples: 240, ready: true } }, looks: { hour: 2, day: 5, perHour: 4, perDay: 20 } };
	fs.writeFileSync(path.join(paths.health.statusDir, "_global.json"), JSON.stringify({ ts: Date.parse("2026-09-30T10:00:00Z"), level: "ok", baseline }));
	assert.deepEqual(statusReport(paths, Date.parse("2026-09-30T10:00:05Z"), { OMO_KEEPWARM_HOME: path.join(root, "keepwarm") }).baseline, baseline);
});

test("a snapshot without a numeric staleAfter goes stale 10 min after its ts (#82)", async () => {
	const { staleAfter, ...bare } = fresh;
	const stale = { level: "unknown", text: "keepwarm: unknown (stale)" };
	assert.equal(keepwarmStatus({ env: fixture(bare), now: NOW }).level, "ok", "1 min old is fresh");
	const old = { ...bare, ts: NOW - 11 * 60_000 };
	assert.deepEqual(keepwarmStatus({ env: fixture(old), now: NOW }), stale);
	assert.deepEqual(keepwarmStatus({ env: fixture({ ...old, staleAfter: "soon" }), now: NOW }), stale, "a non-numeric bound is no bound");
	assert.deepEqual(keepwarmStatus({ env: fixture({ ...bare, ts: undefined }), now: NOW }), { level: "unknown", text: "keepwarm: unknown (unreadable)" }, "with no ts either the snapshot cannot be judged");
	assert.ok((await healthLines(fixture(old))).includes("keepwarm: unknown (stale)"), "the /health line follows the same rule");
	assert.ok((await healthLines(fixture(bare))).includes(fresh.text));
});
