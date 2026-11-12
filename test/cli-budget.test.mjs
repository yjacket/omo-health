import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/omo-health.mjs", import.meta.url));
const WINDOW_KEYS = [
	"account",
	"windowId",
	"label",
	"usedPercent",
	"resetsAtMs",
	"hoursLeft",
	"projectedAtResetPercent",
	"reservePercent",
	"committedPercent",
	"freePercent",
	"safeDailyPercent",
	"state",
	"stale",
	"updatedMs",
	"error",
	"calibrated",
	"calibrationIntervals",
	"percentPerUsd",
	"coupons",
];
const HUMAN_LABELS = ["사용", "리셋", "남은 시간", "예상", "예비", "배정", "여유", "하루", "상태", "갱신", "보정", "리셋권"];

const NOW = 1_800_000_000_000;
const WINDOW = {
	account: "anthropic-subscription/default",
	windowId: "claude:7d",
	label: "7d",
	scope: null,
	usedPercent: 42.5,
	resetsAtMs: 1_800_200_000_000,
	hoursLeft: 30.5,
	reservePercent: 12,
	committedPercent: 8.25,
	freePercent: 37.25,
	burnPerHour: 1.2,
	projectedAtResetPercent: 78.5,
	safeDailyPercent: 4.5,
	state: "tight",
	stale: false,
	calibrated: true,
	calibrationHigh: 3.1,
	percentPerUsd: 2.5,
	coupons: 2,
	updatedMs: 1_799_999_700_000,
	error: null,
	calibrationIntervals: 14,
};
const SNAPSHOT = {
	v: 1,
	updatedMs: NOW,
	enabled: true,
	treasury: { state: "tight", windows: [WINDOW], external: { "claude:7d": null } },
	projects: [{ id: "p1", sessionId: "s1", objective: "예산 CLI 작업", status: "approved", revision: 1, spentUsd: 3.5, mainUsd: 2, childUsd: 1.5, auditUsd: 0, missing: 0, approvedUsd: 20, estimate: null, reserveUsd: 25, pending: null, indicators: {}, triggers: [], lastAudit: null, rounds: 0 }],
	audits: [],
	owner: [{ projectId: "p1", requestId: "r1", kind: "estimate", increaseUsd: 5, reason: "more work", sinceMs: 1 }],
	events: [],
};

/** Env with every omo/senpi variable dropped so the CLI reads only the sandbox home. */
function childEnv(root) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/^(OMO_|PI_|SENPI_|HERDR_)/.test(key)) delete env[key];
	env.USERPROFILE = root;
	env.HOME = root;
	env.APPDATA = path.join(root, "AppData");
	env.OMO_HEALTH_HOME = path.join(root, "health");
	return env;
}

function runCli(root, args) {
	const result = spawnSync(process.execPath, [BIN, ...args], { env: childEnv(root), encoding: "utf8" });
	assert.equal(result.status, 0, `exit ${result.status}\nstderr: ${result.stderr}`);
	return result.stdout;
}

function sandbox({ seed } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-cli-budget-"));
	if (seed) {
		const file = path.join(root, "health", "budget", "snapshot.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(seed === true ? SNAPSHOT : seed));
	}
	return root;
}

test("budget --json prints the whole snapshot and exits 0", () => {
	const root = sandbox({ seed: true });
	try {
		assert.deepEqual(JSON.parse(runCli(root, ["budget", "--json"])), SNAPSHOT);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("status --json budget carries every IS-1 window field with the seeded values", () => {
	const root = sandbox({ seed: true });
	try {
		const report = JSON.parse(runCli(root, ["status", "--json"]));
		assert.equal(report.budget.state, "tight");
		assert.equal(report.budget.updatedMs, NOW);
		assert.deepEqual(Object.keys(report.budget.windows[0]).sort(), [...WINDOW_KEYS].sort());
		assert.deepEqual(report.budget.windows[0], {
			account: WINDOW.account,
			windowId: WINDOW.windowId,
			label: WINDOW.label,
			usedPercent: WINDOW.usedPercent,
			resetsAtMs: WINDOW.resetsAtMs,
			hoursLeft: WINDOW.hoursLeft,
			projectedAtResetPercent: WINDOW.projectedAtResetPercent,
			reservePercent: WINDOW.reservePercent,
			committedPercent: WINDOW.committedPercent,
			freePercent: WINDOW.freePercent,
			safeDailyPercent: WINDOW.safeDailyPercent,
			state: WINDOW.state,
			stale: WINDOW.stale,
			updatedMs: WINDOW.updatedMs,
			error: WINDOW.error,
			calibrated: WINDOW.calibrated,
			calibrationIntervals: WINDOW.calibrationIntervals,
			percentPerUsd: WINDOW.percentPerUsd,
			coupons: WINDOW.coupons,
		});
		assert.deepEqual(report.budget.projects, [{ id: "p1", objective: "예산 CLI 작업", status: "approved", spentUsd: 3.5, approvedUsd: 20, pending: null }]);
		assert.deepEqual(report.budget.pendingOwner, SNAPSHOT.owner);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("human budget table prints every IS-1 field label, projects and owner-pending", () => {
	const root = sandbox({ seed: true });
	try {
		const out = runCli(root, ["budget"]);
		for (const label of HUMAN_LABELS) assert.ok(out.includes(label), `missing label ${label}\n${out}`);
		assert.match(out, /프로젝트 1건/);
		assert.match(out, /소유자 승인 대기 1건/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("human budget marks a stale failed window 오래됨 조회 실패 and leaves a fresh window unmarked", () => {
	const stale = { ...WINDOW, account: "openai/codex", windowId: "codex:primary", state: "unknown", stale: true, error: "poll failed" };
	const fresh = { ...WINDOW, stale: false, error: null };
	const root = sandbox({ seed: { ...SNAPSHOT, treasury: { state: "tight", windows: [stale, fresh] } } });
	try {
		const out = runCli(root, ["budget"]);
		const lines = out.split("\n");
		const staleLines = lines.filter((line) => line.includes("codex:primary"));
		const freshLines = lines.filter((line) => line.includes("claude:7d"));
		assert.equal(staleLines.length, 1, out);
		assert.equal(freshLines.length, 1, out);
		assert.match(staleLines[0], /오래됨/);
		assert.match(staleLines[0], /조회 실패/);
		assert.doesNotMatch(freshLines[0], /오래됨|조회 실패/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("no snapshot: budget is null and the human table says 기록 없음", () => {
	const root = sandbox();
	try {
		assert.equal(JSON.parse(runCli(root, ["status", "--json"])).budget, null);
		assert.match(runCli(root, ["budget"]), /기록 없음/);
		assert.equal(runCli(root, ["budget", "--json"]).trim(), "null");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
