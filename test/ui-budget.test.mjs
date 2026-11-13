import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { readCommands } from "../src/budget/commands.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { uiState } from "../src/ui/model.mjs";
import { createUiServer } from "../src/ui/server.mjs";

const TOKEN = "test-token-budget_123";
const NOW = Date.parse("2026-11-12T03:00:00.000Z");
const SNAPSHOT = {
	v: 1,
	updatedMs: NOW,
	enabled: true,
	treasury: { state: "tight", windows: [{ account: "anthropic-subscription/default", windowId: "claude:7d", usedPercent: 70 }] },
	projects: [{ id: "sid:goal", sessionId: "sid", objective: "ship it", status: "approved", revision: 1 }],
	audits: [],
	events: [],
};

let root;
let paths;
let server;
let port;
let clock;

before(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-budget-"));
	paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	clock = NOW;
	server = createUiServer({ paths, token: TOKEN, getState: () => ({ ok: true }), now: () => clock });
	({ port } = await server.listen());
});

after(async () => {
	await server.close();
	fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(paths.health.budgetDir, { recursive: true, force: true });
});

/** One request on a fresh connection; resolves { status, headers, body } with body parsed as JSON when possible. */
function request({ method = "GET", target = "/api/state", headers = {}, body, token = TOKEN }) {
	return new Promise((resolve, reject) => {
		const allHeaders = { ...headers };
		if (token !== null) allHeaders["x-omo-health-token"] = token;
		const req = http.request({ host: "127.0.0.1", port, method, path: target, headers: allHeaders, agent: false }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let parsed = text;
				try {
					parsed = JSON.parse(text);
				} catch {
					// Not JSON: keep the text.
				}
				resolve({ status: res.statusCode, headers: res.headers, body: parsed });
			});
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const postJson = (target, value, extra = {}) =>
	request({ method: "POST", target, headers: { "content-type": "application/json", ...extra.headers }, body: JSON.stringify(value), token: Object.hasOwn(extra, "token") ? extra.token : TOKEN });

const commandFiles = () => fs.existsSync(paths.health.budgetCommandsDir) ? fs.readdirSync(paths.health.budgetCommandsDir) : [];

describe("ui budget", { timeout: 20_000 }, () => {
	describe("state", () => {
		it("includes the budget snapshot read from budgetSnapshotFile, and null without one", () => {
			const empty = uiState({ paths, env: { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") }, now: NOW });
			assert.equal(Object.hasOwn(empty, "budget"), true);
			assert.equal(empty.budget, null);
			fs.mkdirSync(path.dirname(paths.health.budgetSnapshotFile), { recursive: true });
			fs.writeFileSync(paths.health.budgetSnapshotFile, JSON.stringify(SNAPSHOT));
			const state = uiState({ paths, env: { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") }, now: NOW });
			assert.deepEqual(state.budget, SNAPSHOT);
			assert.equal(state.budget.treasury.windows[0].windowId, "claude:7d");
		});
	});

	describe("removed decide route", () => {
		it("answers 404 like any unknown route and writes nothing", async () => {
			clock = NOW + 5_000;
			const res = await postJson("/api/budget/decide", { projectId: "sid:goal", requestId: "req-1", approve: true });
			assert.equal(res.status, 404);
			assert.deepEqual(res.body, { error: "not-found" });
			assert.deepEqual(commandFiles(), []);
			const get = await request({ target: "/api/budget/decide" });
			assert.equal(get.status, 404);
			assert.deepEqual(get.body, { error: "not-found" });
		});
	});

	describe("POST /api/budget/coupons", () => {
		it("writes one coupons command file", async () => {
			clock = NOW + 10_000;
			const res = await postJson("/api/budget/coupons", { account: "anthropic-subscription/default", count: 2 });
			assert.equal(res.status, 200);
			assert.deepEqual(res.body, { ok: true });
			assert.equal(commandFiles().length, 1);
			const [command] = readCommands(paths);
			assert.deepEqual(command.cmd, { kind: "coupons", account: "anthropic-subscription/default", count: 2 });
		});

		it("rejects a bad count or shape with 400 and writes nothing", async () => {
			for (const body of [
				{ account: "anthropic-subscription/default" },
				{ account: "", count: 0 },
				{ account: "anthropic-subscription/default", count: 21 },
				{ account: "anthropic-subscription/default", count: -1 },
				{ account: "anthropic-subscription/default", count: 1.5 },
				{ account: "anthropic-subscription/default", count: "2" },
				{ account: "anthropic-subscription/default", count: 2, approve: true },
			]) {
				const res = await postJson("/api/budget/coupons", body);
				assert.equal(res.status, 400, JSON.stringify(body));
				assert.deepEqual(res.body, { error: "invalid" });
			}
			assert.deepEqual(commandFiles(), []);
		});
	});

	describe("methods and auth", () => {
		it("answers GET on the remaining POST route with 405", async () => {
			const target = "/api/budget/coupons";
			const res = await request({ target });
			assert.equal(res.status, 405, target);
			assert.deepEqual(res.body, { error: "method-not-allowed" });
			assert.equal(res.headers.allow, "GET, POST");
		});

		it("rejects a missing token exactly like the existing POST routes", async () => {
			const existing = await postJson("/api/switch", { key: "mode", value: "shadow" }, { token: null });
			assert.equal(existing.status, 401);
			assert.deepEqual(existing.body, { error: "unauthorized" });
			for (const [target, body] of [["/api/budget/coupons", { account: "anthropic-subscription/default", count: 1 }]]) {
				const res = await postJson(target, body, { token: null });
				assert.equal(res.status, existing.status, target);
				assert.deepEqual(res.body, existing.body, target);
			}
			assert.deepEqual(commandFiles(), []);
		});
	});
});
