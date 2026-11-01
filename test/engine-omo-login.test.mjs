import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createEngine, loadDetectors } from "../src/engine.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const NOW_MS = Date.parse("2026-09-23T15:37:04.874Z");
const DAY = 86_400_000;

/** The smallest world the real detector set can run on; `secrets` is the only input each case varies. */
async function harness(secretsAt) {
	const root = tmpDir("omoh-omo-login-");
	const paths = resolvePaths({ OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), USERPROFILE: root });
	fs.mkdirSync(paths.healthHome, { recursive: true });
	const clock = createFakeClock(NOW_MS);
	const toasts = [];
	const engine = createEngine({
		paths,
		config: structuredClone(DEFAULT_CONFIG),
		clock,
		mode: "auto",
		detectors: await loadDetectors(),
		sources: {
			procs: {
				async snapshot() {
					return { takenAtMs: clock.now(), rows: [] };
				},
				async os() {
					return { commitFrac: 0, commitUsedBytes: 0, commitLimitBytes: 1 };
				},
				async ports() {
					return [];
				},
				restarts: 0,
				close() {},
			},
			registry: { refresh: () => ({ sessions: new Map(), tasks: [] }) },
			logs: { read() {}, drain: () => [], stats: new Map() },
			secrets: () => secretsAt(clock.now()),
		},
		actors: { notifier: { toast: (t) => (toasts.push(t), { ok: true }) } },
		options: { selfPid: 1 },
	});
	return { engine, clock, toasts };
}

test("D24: a 15-day-old omo login raises a warn footer and exactly one toast", async () => {
	const h = await harness((now) => ({ authBlocks: [{ name: "default" }], omoLogin: { slots: [{ name: "default", loginMs: now - 15 * DAY, basis: "login" }] } }));
	const { globalStatus } = await h.engine.tick();
	assert.equal(globalStatus.text, "👀 재로그인");
	assert.equal(globalStatus.level, "warn");
	assert.ok(globalStatus.humanNeeded.some((f) => f.titleKo === "omo 다시 로그인 권장"));
	await h.engine.tick();
	assert.equal(h.toasts.filter((t) => t.tag === "D24-omo-login-aging").length, 1);
});

test("D24: a 1-day-old login leaves the footer normal and shows no omo login toast", async () => {
	const h = await harness((now) => ({ authBlocks: [{ name: "default" }], omoLogin: { slots: [{ name: "default", loginMs: now - 1 * DAY, basis: "login" }] } }));
	const { globalStatus } = await h.engine.tick();
	assert.equal(globalStatus.text, "👀 정상");
	assert.equal(globalStatus.humanNeeded.length, 0);
	assert.equal(h.toasts.filter((t) => t.tag === "D24-omo-login-aging").length, 0);
});

test("D6: one blocked account is listed as a partial incident without a footer warning or toast", async () => {
	const h = await harness((now) => ({
		authBlocks: [
			{ name: "default" },
			{ name: "old", blockReason: "auth_error", blockedUntil: now + 60_000 },
		],
		omoLogin: { slots: [{ name: "default", loginMs: now - 1 * DAY, basis: "login" }] },
	}));
	const { globalStatus } = await h.engine.tick();
	assert.ok(globalStatus.open.some((f) => f.kind === "account-blocked-partial"));
	assert.ok(globalStatus.incidents.some((f) => f.titleKo === "Claude 계정 일부 차단: old"));
	assert.equal(globalStatus.text, "👀 정상");
	assert.equal(h.toasts.length, 0);
});
