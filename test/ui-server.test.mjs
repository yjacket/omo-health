import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createAuditor, readAuditState, requestAudit } from "../src/auditor.mjs";
import { loadConfig } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { emptyUsage } from "../src/collect/usage.mjs";
import { appendDecision } from "../src/decisions.mjs";
import { BACKFILL_MARKER, backfillOnce } from "../src/session-backfill.mjs";
import { appendEnded, readEnded } from "../src/session-ledger.mjs";
import { createDetailWorker, createSessionDetail, createStartAudit } from "../src/ui/cli.mjs";
import { buildEnded, daemonStatus, loadDaemonInputs, uiState } from "../src/ui/model.mjs";
import { createUiServer } from "../src/ui/server.mjs";
import { createUsageIndex, USAGE_INDEX_VERSION } from "../src/usage-index.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const TOKEN = "test-token-abc_123";
const STATE = { generatedMs: 1, overview: { level: "ok" } };
const IDLE_MS = 60_000;
const KNOWN_ID = "st_known";

const messages = Array.from({ length: 60 }, (_, i) => ({ ms: 1_000 + i, recipient: KNOWN_ID, text: `m${i}` }));
const SESSION_DETAIL = {
	found: true,
	id: KNOWN_ID,
	session: { sessionId: KNOWN_ID, kind: "child", title: "known", outcome: "answered", outcomeKo: "응답 후 종료", terminalLabel: null },
	tokens: null,
	children: Array.from({ length: 60 }, (_, i) => ({ sessionId: `c${i}`, outcomeKo: "종료됨" })),
	health: {
		findings: Array.from({ length: 55 }, (_, i) => ({ fp: `fp-${i}`, titleKo: "도구 호출 멈춤" })),
		actions: [{ actionKo: "원인 프로세스 종료", resultKo: "실행" }],
		investigations: [{ id: "fp-1", verdictKo: "의심", verdictHistory: [] }],
		messages,
		counts: { findings: 55, actions: 1, investigations: 1, messages: 60 },
	},
	audit: null,
};
const sessionDetail = async (id) => (id === KNOWN_ID ? SESSION_DETAIL : { found: false, id });

let root;
let paths;
let server;
let port;
let clock;
let auditImpl;
let auditCalls;

/** One JSON POST against an arbitrary port; the main server's helpers use the module-level `port`. */
function postAt(targetPort, target, value, extra = {}) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(value);
		const req = http.request(
			{ host: "127.0.0.1", port: targetPort, method: "POST", path: target, headers: { "x-omo-health-token": TOKEN, "content-type": "application/json", ...extra }, agent: false },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let parsed = text;
					try {
						parsed = JSON.parse(text);
					} catch {
						// keep text
					}
					resolve({ status: res.statusCode, body: parsed });
				});
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

/** One GET against an arbitrary port; resolves { status, body } with body parsed as JSON. */
function getAt(targetPort, target) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: targetPort, method: "GET", path: target, headers: { "x-omo-health-token": TOKEN }, agent: false }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let parsed = text;
				try {
					parsed = JSON.parse(text);
				} catch {
					// keep text
				}
				resolve({ status: res.statusCode, body: parsed });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

before(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-server-"));
	paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	const staticDir = path.join(root, "static");
	fs.mkdirSync(staticDir, { recursive: true });
	fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
	fs.writeFileSync(path.join(staticDir, "app.js"), "export {};\n");
	fs.writeFileSync(path.join(staticDir, "app.css"), "body{}\n");
	clock = 1_000_000;
	auditImpl = (id) => {
		auditCalls.push(id);
		return [202, { ok: true, audit: { sessionId: id, status: "queued" } }];
	};
	const diagnose = async (id) => (id ? { found: true, id } : { subjects: [{ id: "st_c" }] });
	server = createUiServer({ paths, token: TOKEN, getState: () => STATE, diagnose, sessionDetail, startAudit: (id) => auditImpl(id), idleMs: IDLE_MS, now: () => clock, staticDir });
	({ port } = await server.listen());
});

after(async () => {
	await server.close();
	fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	auditCalls = [];
	auditImpl = (id) => {
		auditCalls.push(id);
		return [202, { ok: true, audit: { sessionId: id, status: "queued" } }];
	};
	fs.rmSync(paths.health.configFile, { force: true });
	fs.rmSync(paths.health.pauseFile, { force: true });
	fs.rmSync(paths.health.uiPrefsFile, { force: true });
});

/** One request on a fresh connection; resolves { status, headers, body } with body parsed as JSON when possible. */
function request({ method = "GET", path: target = "/api/state", headers = {}, body, token = TOKEN }) {
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
					// Static files are not JSON; keep the text.
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
	request({ method: "POST", path: target, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(value) });

/** Sends raw bytes and resolves the status code of the first response line. */
function rawStatus(text) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
		let data = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			data += chunk;
			const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
			if (match) {
				socket.destroy();
				resolve(Number(match[1]));
			}
		});
		socket.on("error", reject);
		socket.on("close", () => reject(new Error(`connection closed without a status line: ${JSON.stringify(data)}`)));
	});
}

describe("ui server", { timeout: 20_000 }, () => {
	describe("host, origin and token", () => {
		it("rejects a foreign Host with 403", async () => {
			const res = await request({ headers: { host: `evil.com:${port}` } });
			assert.equal(res.status, 403);
			assert.deepEqual(res.body, { error: "forbidden-host" });
		});

		it("rejects a missing or wrong token with 401", async () => {
			assert.equal((await request({ token: null })).status, 401);
			const wrong = await request({ token: "nope" });
			assert.equal(wrong.status, 401);
			assert.deepEqual(wrong.body, { error: "unauthorized" });
		});

		it("rejects a POST from a foreign Origin with 403 and accepts one without Origin", async () => {
			const foreign = await postJson("/api/resume", {}, { origin: "http://evil.com" });
			assert.equal(foreign.status, 403);
			assert.deepEqual(foreign.body, { error: "forbidden-origin" });
			assert.equal(foreign.headers.connection, "close");
			assert.equal((await postJson("/api/resume", {})).status, 200);
		});

		it("accepts a POST from its own Origin", async () => {
			assert.equal((await postJson("/api/resume", {}, { origin: `http://127.0.0.1:${port}` })).status, 200);
		});
	});

	describe("state", () => {
		it("returns the injected state for a valid token", async () => {
			const res = await request({});
			assert.equal(res.status, 200);
			assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
			assert.deepEqual(res.body, STATE);
		});
	});

	describe("diagnose", () => {
		it("lists subjects without an id, diagnoses a well-formed id, and rejects a malformed id, a missing token and a POST", async () => {
			const list = await request({ path: "/api/diagnose" });
			assert.deepEqual([list.status, list.body], [200, { subjects: [{ id: "st_c" }] }]);
			const one = await request({ path: "/api/diagnose?id=st_c" });
			assert.deepEqual([one.status, one.body], [200, { found: true, id: "st_c" }]);
			assert.equal((await request({ path: "/api/diagnose?id=..%2Fx" })).status, 422);
			assert.equal((await request({ path: "/api/diagnose", token: null })).status, 401);
			assert.equal((await postJson("/api/diagnose", {})).status, 405);
		});
	});

	describe("input validation", () => {
		it("rejects a non-JSON media type with 415", async () => {
			const res = await request({ method: "POST", path: "/api/resume", headers: { "content-type": "text/plain" }, body: "{}" });
			assert.equal(res.status, 415);
		});

		it("accepts application/json with parameters", async () => {
			const res = await request({ method: "POST", path: "/api/resume", headers: { "content-type": "application/json; charset=utf-8" }, body: "{}" });
			assert.equal(res.status, 200);
		});

		it("rejects a 4097-byte body with 413", async () => {
			const body = JSON.stringify({ key: "mode", value: "x".repeat(4097 - 25) });
			assert.equal(Buffer.byteLength(body), 4097);
			assert.equal((await request({ method: "POST", path: "/api/switch", headers: { "content-type": "application/json" }, body })).status, 413);
		});

		it("rejects an oversized chunked body with 413", async () => {
			const status = await rawStatus(
				`POST /api/switch HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-omo-health-token: ${TOKEN}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n1001\r\n${"a".repeat(4097)}\r\n0\r\n\r\n`,
			);
			assert.equal(status, 413);
		});

		it("rejects bodies that are not a JSON object with 400", async () => {
			const bad = (body) => request({ method: "POST", path: "/api/switch", headers: { "content-type": "application/json" }, body });
			assert.equal((await bad("not json")).status, 400);
			assert.equal((await bad("[]")).status, 400);
			assert.equal((await bad("null")).status, 400);
		});

		it("rejects wrong key sets and out-of-range values with 422", async () => {
			assert.equal((await postJson("/api/switch", {})).status, 422);
			assert.equal((await postJson("/api/switch", { key: "mode", value: "x" })).status, 422);
			assert.equal((await postJson("/api/switch", { key: "care.repo", value: "a" })).status, 422);
			assert.equal((await postJson("/api/switch", { key: "mode", value: "auto", extra: 1 })).status, 422);
			assert.equal((await postJson("/api/pause", { minutes: 30 })).status, 422);
			assert.equal((await postJson("/api/resume", { x: 1 })).status, 422);
			assert.equal(fs.existsSync(paths.health.configFile), false);
		});
	});

	describe("request form", () => {
		it("rejects two Host headers with 403", async () => {
			const status = await rawStatus(
				`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\nx-omo-health-token: ${TOKEN}\r\nConnection: close\r\n\r\n`,
			);
			assert.equal(status, 403);
		});

		it("rejects an absolute-form target with 400", async () => {
			const status = await rawStatus(
				`GET http://evil.example/api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-omo-health-token: ${TOKEN}\r\nConnection: close\r\n\r\n`,
			);
			assert.equal(status, 400);
		});

		it("checks the token before the route", async () => {
			assert.equal((await request({ path: "/api/nope", token: null })).status, 401);
			assert.equal((await request({ path: "/api/nope" })).status, 404);
		});

		it("serves the static table with GET only and without a token", async () => {
			const page = await request({ path: "/", token: null });
			assert.equal(page.status, 200);
			assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
			assert.equal((await request({ path: "/app.js", token: null })).headers["content-type"], "text/javascript; charset=utf-8");
			const post = await request({ method: "POST", path: "/app.js", token: null });
			assert.equal(post.status, 405);
			assert.equal(post.headers.allow, "GET, POST");
		});

		it("answers a method on the wrong API route with 405", async () => {
			assert.equal((await request({ method: "POST", path: "/api/state", headers: { "content-type": "application/json" }, body: "{}" })).status, 405);
			assert.equal((await request({ path: "/api/pause" })).status, 405);
		});

		it("does not resolve traversal paths", async () => {
			assert.equal((await request({ path: "/../../package.json", token: null })).status, 404);
			assert.equal((await request({ path: "/..%2f..%2fpackage.json", token: null })).status, 404);
		});
	});

	describe("methods", () => {
		it("rejects OPTIONS with 405 and an Allow header", async () => {
			const res = await request({ method: "OPTIONS", path: "/api/state" });
			assert.equal(res.status, 405);
			assert.equal(res.headers.allow, "GET, POST");
		});
	});

	describe("headers", () => {
		it("sends security headers and never CORS headers", async () => {
			const responses = await Promise.all([
				request({}),
				request({ path: "/", token: null }),
				request({ token: null }),
				request({ headers: { host: "evil.com" } }),
				request({ method: "OPTIONS" }),
				request({ path: "/missing", token: null }),
				postJson("/api/switch", {}),
			]);
			for (const res of responses) {
				assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith("access-control-")), [], `status ${res.status}`);
				assert.match(res.headers["content-security-policy"], /^default-src 'none'; script-src 'self';/);
				assert.equal(res.headers["x-content-type-options"], "nosniff");
				assert.equal(res.headers["x-frame-options"], "DENY");
				assert.equal(res.headers["cache-control"], "no-store");
			}
		});
	});

	describe("control", () => {
		it("pauses for 15 minutes and resumes through the pause file", async () => {
			const paused = await postJson("/api/pause", { minutes: 15 });
			assert.equal(paused.status, 200);
			assert.deepEqual(paused.body, { ok: true, pause: { untilMs: clock + 15 * 60_000, byCli: true } });
			assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.pauseFile, "utf8")), { untilMs: clock + 15 * 60_000, byCli: true });
			assert.equal((await postJson("/api/resume", {})).status, 200);
			assert.equal(fs.existsSync(paths.health.pauseFile), false);
		});

		it("pauses until resumed for minutes null", async () => {
			const res = await postJson("/api/pause", { minutes: null });
			assert.deepEqual(res.body, { ok: true, pause: { byCli: true } });
		});

		it("writes a switch to config.json", async () => {
			const res = await postJson("/api/switch", { key: "actions.kill", value: false });
			assert.equal(res.status, 200);
			assert.deepEqual(res.body, { ok: true, value: false, isDefault: false });
			assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.configFile, "utf8")), { actions: { kill: false } });
		});

		it("refuses to overwrite an unreadable config.json with 409", async () => {
			fs.mkdirSync(path.dirname(paths.health.configFile), { recursive: true });
			fs.writeFileSync(paths.health.configFile, "{broken");
			const res = await postJson("/api/switch", { key: "actions.kill", value: false });
			assert.equal(res.status, 409);
			assert.equal(res.body.error, "unreadable");
			assert.equal(fs.readFileSync(paths.health.configFile, "utf8"), "{broken");
		});

		it("answers 404 for the removed approval route", async () => {
			assert.equal((await postJson("/api/approval", { id: "ap1", decision: "approve" })).status, 404);
		});
	});

	describe("idle", () => {
		it("ignores auto-refresh for lastRequestMs and counts a normal request", async () => {
			const before = server.lastRequestMs;
			clock = before + 5_000;
			assert.equal((await request({ headers: { "x-omo-health-auto": "1" } })).status, 200);
			assert.equal(server.lastRequestMs, before);
			assert.equal((await request({})).status, 200);
			assert.equal(server.lastRequestMs, clock);
		});

		it("does not count unauthorized requests", async () => {
			const before = server.lastRequestMs;
			clock = before + 7_000;
			await request({ token: "nope" });
			assert.equal(server.lastRequestMs, before);
		});

		it("is idle only after idleMs without requests", () => {
			const last = server.lastRequestMs;
			assert.equal(server.checkIdle(last + IDLE_MS - 1), false);
			assert.equal(server.checkIdle(last + IDLE_MS), true);
			clock = last + IDLE_MS + 1;
			assert.equal(server.checkIdle(), true);
		});
	});

	describe("session detail", () => {
		it("returns the first 50 items of every list with whole-record counts", async () => {
			const res = await request({ path: `/api/session?id=${KNOWN_ID}` });
			assert.equal(res.status, 200);
			assert.equal(res.body.session.title, "known");
			assert.equal(res.body.health.messages.length, 50);
			assert.deepEqual(res.body.health.messages.map((m) => m.text), messages.slice(0, 50).map((m) => m.text));
			assert.deepEqual(res.body.counts, { children: 60, findings: 55, actions: 1, investigations: 1, messages: 60 });
			assert.equal(res.body.children.length, 50);
			assert.equal(res.body.health.findings.length, 50);
		});

		it("pages one list with list and offset", async () => {
			const res = await request({ path: `/api/session?id=${KNOWN_ID}&list=messages&offset=50` });
			assert.equal(res.status, 200);
			assert.equal(res.body.list, "messages");
			assert.equal(res.body.offset, 50);
			assert.equal(res.body.total, 60);
			assert.deepEqual(res.body.items.map((m) => m.text), messages.slice(50).map((m) => m.text));
			const empty = await request({ path: `/api/session?id=${KNOWN_ID}&list=actions&offset=400` });
			assert.deepEqual([empty.status, empty.body.items.length, empty.body.total], [200, 0, 1]);
		});

		it("rejects an unknown list, a bad offset and unknown query params with 422", async () => {
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}&list=secrets` })).status, 422);
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}&list=messages&offset=-1` })).status, 422);
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}&list=messages&offset=1.5` })).status, 422);
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}&offset=1` })).status, 422);
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}&extra=1` })).status, 422);
		});

		it("rejects a malformed or missing id with 422", async () => {
			assert.equal((await request({ path: "/api/session" })).status, 422);
			assert.equal((await request({ path: "/api/session?id=..%2Fx" })).status, 422);
			assert.equal((await request({ path: "/api/session?id=COM1x%2F.." })).status, 422);
		});

		it("answers 404 for an unknown id and when no callback is injected", async () => {
			const missing = await request({ path: "/api/session?id=st_nope" });
			assert.equal(missing.status, 404);
			assert.deepEqual(missing.body, { error: "not-found" });
			const bare = createUiServer({ paths, token: TOKEN, getState: () => STATE });
			const { port: barePort } = await bare.listen();
			try {
				const res = await new Promise((resolve, reject) => {
					const req = http.request({ host: "127.0.0.1", port: barePort, path: `/api/session?id=${KNOWN_ID}`, headers: { "x-omo-health-token": TOKEN }, agent: false }, (r) => {
						const chunks = [];
						r.on("data", (c) => chunks.push(c));
						r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					});
					req.on("error", reject);
					req.end();
				});
				assert.deepEqual([res.status, res.body], [404, { error: "not-found" }]);
			} finally {
				await bare.close();
			}
		});

		it("checks the token before the route and rejects a POST with 405", async () => {
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}`, token: null })).status, 401);
			const post = await postJson("/api/session", { id: KNOWN_ID });
			assert.equal(post.status, 405);
			assert.equal(post.headers.allow, "GET, POST");
		});

		it("does not extend idle for an auto GET but counts a plain GET", async () => {
			const before = server.lastRequestMs;
			clock = before + 4_000;
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}`, headers: { "x-omo-health-auto": "1" } })).status, 200);
			assert.equal(server.lastRequestMs, before);
			assert.equal((await request({ path: `/api/session?id=${KNOWN_ID}` })).status, 200);
			assert.equal(server.lastRequestMs, clock);
		});
	});

	describe("prefs", () => {
		it("writes ui-prefs.json for hideChildren", async () => {
			const res = await postJson("/api/prefs", { hideChildren: true });
			assert.equal(res.status, 200);
			assert.deepEqual(res.body, { ok: true, hideChildren: true });
			assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.uiPrefsFile, "utf8")), { v: 1, hideChildren: true });
			assert.equal((await postJson("/api/prefs", { hideChildren: false })).status, 200);
			assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.uiPrefsFile, "utf8")), { v: 1, hideChildren: false });
		});

		it("rejects a non-boolean value and extra keys with 422 without writing", async () => {
			assert.equal((await postJson("/api/prefs", { hideChildren: "yes" })).status, 422);
			assert.equal((await postJson("/api/prefs", { hideChildren: true, extra: 1 })).status, 422);
			assert.equal((await postJson("/api/prefs", {})).status, 422);
			assert.equal(fs.existsSync(paths.health.uiPrefsFile), false);
		});

		it("rejects a foreign origin with 403 without writing", async () => {
			const res = await postJson("/api/prefs", { hideChildren: true }, { origin: "http://evil.com" });
			assert.equal(res.status, 403);
			assert.deepEqual(res.body, { error: "forbidden-origin" });
			assert.equal(fs.existsSync(paths.health.uiPrefsFile), false);
		});
	});

	describe("session detail memo", () => {
		const fakeRecord = (id) => ({ found: true, id, session: { sessionId: id, kind: "main", title: id, outcome: "closed" }, children: [], health: { findings: [], actions: [], investigations: [], messages: [], counts: { findings: 0, actions: 0, investigations: 0, messages: 0 } }, audit: null });

		it("reuses one record while nothing changes and invalidates when a decision file changes", () => {
			let calls = 0;
			const load = ({ id }) => {
				calls += 1;
				return fakeRecord(id);
			};
			const detail = createSessionDetail({ paths, load });
			assert.equal(detail("st_memo").session.title, "st_memo");
			assert.equal(detail("st_memo").session.title, "st_memo");
			assert.equal(calls, 1);
			const file = path.join(paths.health.decisionsDir, "2026-11-21.jsonl");
			fs.mkdirSync(paths.health.decisionsDir, { recursive: true });
			fs.writeFileSync(file, "{}\n");
			fs.utimesSync(file, clock + 10_000, clock + 10_000);
			assert.equal(detail("st_memo").session.title, "st_memo");
			assert.equal(calls, 2);
			assert.equal(detail("st_memo").session.title, "st_memo");
			assert.equal(calls, 2);
		});

		it("invalidates when a line is appended to an existing ledger file", () => {
			let calls = 0;
			const load = ({ id }) => {
				calls += 1;
				return fakeRecord(id);
			};
			fs.mkdirSync(paths.health.sessionsDir, { recursive: true });
			const ledger = path.join(paths.health.sessionsDir, "ended-2026-11-21.jsonl");
			fs.writeFileSync(ledger, "{}\n");
			fs.utimesSync(ledger, clock, clock);
			const detail = createSessionDetail({ paths, load });
			detail("st_ledger");
			detail("st_ledger");
			assert.equal(calls, 1);
			// An append changes the file's mtime but not the directory's, which is why the key reads file mtimes.
			fs.appendFileSync(ledger, "{}\n");
			fs.utimesSync(ledger, clock + 20_000, clock + 20_000);
			detail("st_ledger");
			assert.equal(calls, 2);
		});

		it("invalidates when the session file itself grows", () => {
			let calls = 0;
			const load = ({ id }) => {
				calls += 1;
				return fakeRecord(id);
			};
			const slug = path.join(paths.sessionsDir, "slug");
			fs.mkdirSync(slug, { recursive: true });
			const file = path.join(slug, "2026-11-21T00-00-00-000Z_grow01.jsonl");
			fs.writeFileSync(file, "{}\n");
			const detail = createSessionDetail({ paths, load });
			detail("grow01");
			detail("grow01");
			assert.equal(calls, 1);
			fs.appendFileSync(file, "{\"type\":\"session\"}\n");
			detail("grow01");
			assert.equal(calls, 2);
		});
	});

	describe("audit", () => {
		it("rejects extra keys, a non-string id, a malformed id and a reserved device name with 422", async () => {
			assert.equal((await postJson("/api/audit", { sessionId: KNOWN_ID, extra: 1 })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: 12345 })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: "..%2Fx" })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: "COM1" })).status, 422);
			assert.equal((await postJson("/api/audit", {})).status, 422);
			assert.deepEqual(auditCalls, []);
		});

		it("rejects a foreign origin with 403 and a non-JSON body with 415", async () => {
			const foreign = await postJson("/api/audit", { sessionId: KNOWN_ID }, { origin: "http://evil.com" });
			assert.deepEqual([foreign.status, foreign.body], [403, { error: "forbidden-origin" }]);
			const media = await request({ method: "POST", path: "/api/audit", headers: { "content-type": "text/plain" }, body: JSON.stringify({ sessionId: KNOWN_ID }) });
			assert.equal(media.status, 415);
			assert.deepEqual(auditCalls, []);
		});

		it("returns the injected [status, body] and passes a refusal with its reasonKo", async () => {
			const accepted = await postJson("/api/audit", { sessionId: KNOWN_ID });
			assert.equal(accepted.status, 202);
			assert.deepEqual(accepted.body, { ok: true, audit: { sessionId: KNOWN_ID, status: "queued" } });
			auditImpl = (id) => {
				auditCalls.push(id);
				return [409, { error: "running", reasonKo: "이미 조사 중입니다" }];
			};
			const refused = await postJson("/api/audit", { sessionId: KNOWN_ID });
			assert.deepEqual([refused.status, refused.body], [409, { error: "running", reasonKo: "이미 조사 중입니다" }]);
			assert.deepEqual(auditCalls, [KNOWN_ID, KNOWN_ID]);
		});

		it("answers 404 when no startAudit callback is injected", async () => {
			const bare = createUiServer({ paths, token: TOKEN, getState: () => STATE });
			const { port: barePort } = await bare.listen();
			try {
				assert.equal((await postAt(barePort, "/api/audit", { sessionId: KNOWN_ID })).status, 404);
			} finally {
				await bare.close();
			}
		});

		describe("real startAudit and detail", () => {
			const AUDIT_ID = "s_audit01";

			function writeJson(file, value) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify(value));
			}

			function writeIndexRow(file, row) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `${JSON.stringify({ v: USAGE_INDEX_VERSION })}\n${JSON.stringify(row)}\n`);
			}

			function makeWorld({ daemon = "running", enabled = true, usedModels = { "anthropic/claude-used": true }, lanes = { ultrabrain: ["anthropic/claude-used"], architect: ["openai/gpt-review:high"] }, providers = ["anthropic", "openai"], growFile = false, budgetCount = null, entries } = {}) {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-ui-"));
				const env = { USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") };
				const worldPaths = resolvePaths(env);
				const nowMs = Date.parse("2026-11-22T00:00:00.000Z");
				const now = () => nowMs;
				const sessionFile = path.join(worldPaths.sessionsDir, "slug", "2026-11-22T00-00-00-000Z_s_audit01.jsonl");
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				const sessionLines = [{ type: "session", id: AUDIT_ID }, ...(entries ?? [])];
				fs.writeFileSync(sessionFile, `${sessionLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
				const stat = fs.statSync(sessionFile);
				fs.mkdirSync(worldPaths.health.sessionsDir, { recursive: true });
				fs.writeFileSync(
					path.join(worldPaths.health.sessionsDir, "ended-2026-11-22.jsonl"),
					`${JSON.stringify({ v: 1, sessionId: AUDIT_ID, taskId: null, kind: "main", outcome: "answered", startedMs: nowMs - 1_000, endedMs: nowMs })}\n`,
				);
				writeIndexRow(worldPaths.health.usageIndexFile, {
							id: AUDIT_ID,
							file: sessionFile,
							kind: "main",
							taskId: null,
							parentSessionId: null,
							rootSessionId: null,
							state: "ok",
							complete: true,
							gone: false,
							size: stat.size,
							mtimeMs: stat.mtimeMs,
							offset: stat.size,
							ino: stat.ino,
							birthtimeMs: stat.birthtimeMs,
							head: "",
							headLen: 0,
							tail: "",
							evaluatedTo: stat.size,
							checkedMs: nowMs,
							usage: emptyUsage(),
							overlay: emptyUsage(),
							published: { ...emptyUsage(), usedModels },
				});
				writeJson(worldPaths.omoJsonc, { "[native]": { categories: Object.fromEntries(Object.entries(lanes).map(([lane, models]) => [lane, { models }])) } });
				writeJson(worldPaths.authFile, Object.fromEntries(providers.map((provider) => [provider, {}])));
				if (daemon === "running") writeJson(worldPaths.health.daemonJson, { ts: nowMs, pid: process.pid, mode: "auto", version: "test" });
				if (daemon === "stale") writeJson(worldPaths.health.daemonJson, { ts: nowMs - 120_000, pid: process.pid, mode: "auto", version: "test" });
				if (enabled !== true) writeJson(worldPaths.health.configFile, { audit: { enabled: false } });
				if (budgetCount !== null) writeJson(worldPaths.health.auditBudgetFile, { day: "2026-11-22", count: budgetCount, jobs: [] });
				if (growFile) fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", role: "assistant" })}\n`);
				const worker = createDetailWorker({ paths: worldPaths, env });
				return {
					dir,
					env,
					paths: worldPaths,
					now,
					nowMs,
					sessionFile,
					detail: createSessionDetail({ paths: worldPaths, env, now, worker }),
					startAudit: createStartAudit({ paths: worldPaths, env, now, worker }),
				};
			}

			function requestFileOf(world) {
				return path.join(world.paths.health.auditRequestsDir, `${AUDIT_ID}.json`);
			}

			it("isolates ended children with task id st_x in two project stores", async () => {
				const world = makeWorld();
				try {
					const children = ["child-a", "child-b"].map((sessionId) => ({
						sessionId, kind: "child", taskId: "st_x", cwd: path.join(world.dir, sessionId),
						startedMs: world.nowMs - 1_000, endedMs: world.nowMs, outcome: "answered",
					}));
					const [a, b] = children;
					const files = children.map((child) => {
						appendEnded(world.paths, child, { nowMs: world.nowMs });
						return writeTask(child.cwd, { task_id: child.taskId, child_session_id: child.sessionId, status: "completed" }, [
							{ type: "session", id: child.sessionId },
							{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: 42 }, stopReason: "stop" } },
						]);
					});
					const index = createUsageIndex({ file: world.paths.health.usageIndexFile, clock: { now: world.now } });
					index.update(a.sessionId, files[0], { kind: "child", taskId: a.taskId });
					index.save();
					appendDecision(world.paths, { event: "opened", fp: "finding-a", detector: "D8", kind: "dead-child", severity: "warn", subject: { sessionId: a.sessionId, taskId: a.taskId }, ts: new Date(world.nowMs).toISOString() });

					const history = new Map(uiState({ paths: world.paths, env: world.env, now: world.nowMs }).ended.rows.map((row) => [row.sessionId, row]));
					const indexed = await world.detail(a.sessionId);
					const unindexed = await world.detail(b.sessionId);
					assert.deepEqual({
						indexed: [history.get(a.sessionId).tokens?.total, indexed.tokens?.total, indexed.health.counts.findings, indexed.audit.planned?.model],
						unindexed: [history.get(b.sessionId).tokensState, history.get(b.sessionId).tokens, unindexed.tokens, unindexed.health.counts.findings, unindexed.audit.blocked],
					}, {
						indexed: [42, 42, 1, "openai/gpt-review:high"],
						unindexed: ["pending", null, null, 0, "models-unknown"],
					});
				} finally {
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("blocks reviewer preview when a fresh task-keyed entry belongs to a child in another store", async () => {
				const world = makeWorld();
				try {
					const taskId = "st_shared";
					const children = ["child-a", "child-b"].map((sessionId) => ({
						sessionId, taskId, kind: "child", cwd: path.join(world.dir, sessionId),
						startedMs: world.nowMs - 1_000, endedMs: world.nowMs, outcome: "answered",
					}));
					const files = children.map((child) => {
						appendEnded(world.paths, child, { nowMs: world.nowMs });
						return writeTask(child.cwd, { task_id: taskId, child_session_id: child.sessionId, status: "completed" }, [
							{ type: "session", id: child.sessionId },
							{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: 42 }, stopReason: "stop" } },
						]);
					});
					const index = createUsageIndex({ file: world.paths.health.usageIndexFile, clock: { now: world.now } });
					index.update(taskId, files[0], { kind: "child", taskId });
					assert.equal(index.fresh(index.get(taskId)), true);
					assert.equal(index.has(children[1].sessionId), false);
					index.save();

					const { audit } = await world.detail(children[1].sessionId);
					assert.deepEqual([audit.blocked, audit.planned], ["models-unknown", null]);
					const [status, body] = await world.startAudit(children[1].sessionId);
					assert.deepEqual([status, body.error], [409, "models-unknown"]);
				} finally {
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			function writeTaskOnlyCollision(world, { sameTick = false } = {}) {
				const taskId = "st_shared";
				const children = ["a", "b"].map((id, i) => ({
					v: 1, kind: "child", sessionId: taskId, taskId, parentSessionId: `main-${id}`,
					title: `task ${id}`, cwd: path.join(world.dir, id), outcome: "answered",
					startedMs: world.nowMs - 2000, endedMs: world.nowMs + (sameTick ? 0 : i), reason: "", source: "live",
				}));
				// Seed both rows directly to isolate read-side collision behavior.
				const ledger = path.join(world.paths.health.sessionsDir, "ended-2026-11-22.jsonl");
				fs.appendFileSync(ledger, children.map((row) => `${JSON.stringify(row)}\n`).join(""));
				const file = writeTask(children[0].cwd, { task_id: taskId, status: "completed" }, [
					{ type: "session", id: "child-a" },
					{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: 42 }, stopReason: "stop" } },
				]);
				const index = createUsageIndex({ file: world.paths.health.usageIndexFile, clock: { now: world.now } });
				index.update(taskId, file, { kind: "child", taskId });
				index.save();
				return children;
			}

			it("(plan 34) task-only ledger collisions leave detail and reviewer facts unknown", async () => {
				const world = makeWorld();
				try {
					const [{ taskId }] = writeTaskOnlyCollision(world);
					const detail = await world.detail(taskId);
					const cached = await world.detail(taskId);
					const [status, body] = await world.startAudit(taskId);
					const facts = (r) => [r.session.title, r.tokens?.total ?? null, r.audit.blocked, r.audit.planned?.model ?? null];
					assert.deepEqual([facts(detail), facts(cached), [status, body.error]], [
						["task b", null, "models-unknown", null],
						["task b", null, "models-unknown", null],
						[409, "models-unknown"],
					]);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("(plan 46) HTTP selects same-tick rows and paginates each row's own messages", async () => {
				const world = makeWorld();
				const ui = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now: world.now });
				try {
					const rows = writeTaskOnlyCollision(world, { sameTick: true });
					for (const row of rows) {
						writeTask(row.cwd, { task_id: row.taskId, status: "completed" }, Array.from({ length: 51 }, (_, i) => ({
							type: "custom_message", customType: "omo-health", id: `msg-${i}`,
							timestamp: new Date(row.startedMs + i).toISOString(),
							content: `${row.title} notice ${i}`,
						})));
					}
					const { port } = await ui.listen();
					for (const row of [...rows, rows[0]]) {
						const url = `/api/session?id=${row.sessionId}&row=${expectedSelector(row)}`;
						const { status, body } = await getAt(port, url);
						assert.deepEqual([status, body.session?.title, body.session?.parentSessionId, body.tokens, body.audit?.blocked, body.audit?.planned], [
							200, row.title, row.parentSessionId, null, "models-unknown", null,
						]);
						assert.equal(body.counts.messages, 51);
						assert.equal(body.health.messages.length, 50);
						assert.equal(body.health.messages[0].text, `${row.title} notice 50`);
						const page = await getAt(port, `${url}&list=messages&offset=50`);
						assert.equal(page.status, 200);
						assert.deepEqual([page.body.list, page.body.offset, page.body.total, page.body.items.map((item) => item.text)], [
							"messages", 50, 51, [`${row.title} notice 0`],
						]);
					}
				} finally {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("(plan 35) HTTP row selector isolates shared-ID details and cached audit previews", async () => {
				const world = makeWorld();
				const ui = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now: world.now });
				try {
					const [a, b] = writeTaskOnlyCollision(world);
					const { port } = await ui.listen();
					const get = (query = "") => getAt(port, `/api/session?id=${a.sessionId}${query}`);
					const facts = ({ status, body }) => [status, body.session?.title, body.session?.parentSessionId, body.tokens, body.audit?.blocked, body.audit?.planned];
					const expect = (row) => [200, row.title, row.parentSessionId, null, "models-unknown", null];
					assert.deepEqual(facts(await get()), expect(b));
					assert.deepEqual(facts(await get(`&row=${expectedSelector(a)}`)), expect(a));
					assert.deepEqual(facts(await get(`&row=${expectedSelector(b)}`)), expect(b));
					assert.deepEqual(facts(await get(`&row=${expectedSelector(a)}`)), expect(a), "cached detail and preview");
					assert.deepEqual(facts(await get()), expect(b), "unqualified cache entry still selects the newest");
					assert.deepEqual(await get(`&row=${expectedSelector(a)}&list=children&offset=0`), {
						status: 200, body: { list: "children", offset: 0, total: 0, items: [] },
					});
					assert.deepEqual(await get("&row=0000000000000000"), { status: 404, body: { error: "not-found" } });
					const duplicate = expectedSelector(a);
					for (const query of ["&row=", "&row=0123456789abcde", "&row=0123456789abcdef0", "&row=0123456789abcdeg",
						"&row=0123456789ABCDEF", "&row=0123456789abcdef%0A", `&Row=${duplicate}`, `&row=${duplicate}&row=${duplicate}`,
						`&ended=${a.endedMs}`, "&ended=", "&ended=-1", "&ended=1.5", "&ended=1e3", "&ended=9007199254740993", "&Ended=1", "&ended=0&ended=-1"]) {
						assert.deepEqual(await get(query), { status: 422, body: { error: "invalid" } }, query);
					}
				} finally {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("(plan 45) backfill writes both task-only children for history and HTTP row selection", async () => {
				const world = makeWorld();
				const { paths, now, nowMs } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now });
				try {
					const taskId = "st_x";
					const children = ["a", "b"].map((id, i) => ({
						parentSessionId: `main-${id}`, title: `task ${id}`, cwd: path.join(world.dir, id),
						endedMs: nowMs - 3_600_000 - i,
					}));
					for (const { parentSessionId, title, cwd, endedMs } of children) {
						const timestamp = new Date(endedMs).toISOString();
						const file = path.join(paths.sessionsDir, parentSessionId, `${timestamp.replace(/[:.]/g, "-")}_${parentSessionId}.jsonl`);
						writeJsonl(file, [{ type: "session", version: 3, id: parentSessionId, cwd, timestamp }]);
						fs.utimesSync(file, endedMs / 1000, endedMs / 1000);
						writeTask(cwd, {
							task_id: taskId, parent_session_id: parentSessionId, name: title,
							terminal_at: timestamp, status: "completed", final_response: "done",
						});
					}
					assert.deepEqual(backfillOnce(paths, nowMs).errors, []);
					const ledger = () => readEnded(paths);
					const facts = ({ sessionId, parentSessionId, title, endedMs }) => [sessionId, parentSessionId, title, endedMs];
					const expected = children.map((row) => facts({ ...row, sessionId: taskId }));
					assert.deepEqual(ledger().filter((row) => row.sessionId === taskId).map(facts), expected);
					fs.unlinkSync(path.join(paths.health.sessionsDir, BACKFILL_MARKER));
					const repeated = backfillOnce(paths, nowMs);
					assert.deepEqual(repeated.errors, []);
					assert.equal(repeated.counts.written, 0);
					assert.deepEqual(ledger().filter((row) => row.sessionId === taskId).map(facts), expected);
					const history = buildEnded({ ended: ledger(), now: nowMs }).rows.filter((row) => row.sessionId === taskId);
					assert.deepEqual(history.map(facts), expected);
					assert.deepEqual(history.map((row) => row.detailRow), children.map((row) => expectedSelector({ ...row, sessionId: taskId })));
					const { port } = await ui.listen();
					for (const row of history) {
						const { status, body } = await getAt(port, `/api/session?id=${row.sessionId}&row=${row.detailRow}`);
						assert.equal(status, 200);
						assert.deepEqual(facts(body.session), facts(row));
					}
				} finally {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("shows a request as queued, stalls on a stale heartbeat and shows the finished record as done", async () => {
				const world = makeWorld();
				try {
					writeJson(requestFileOf(world), { v: 1, sessionId: AUDIT_ID, requestedMs: world.nowMs });
					const queued = (await world.detail(AUDIT_ID)).audit;
					assert.equal(queued.state.status, "queued");
					assert.equal(queued.state.statusKo, "대기 중");
					assert.equal(queued.stalled, false);
					assert.equal(queued.blocked, null);
					assert.equal(queued.planned.model, "openai/gpt-review:high");

					writeJson(world.paths.health.daemonJson, { ts: world.nowMs - 120_000, pid: process.pid, mode: "auto", version: "test" });
					const stalled = (await world.detail(AUDIT_ID)).audit;
					assert.equal(stalled.state.status, "queued");
					assert.equal(stalled.stalled, true);

					fs.rmSync(requestFileOf(world), { force: true });
					writeJson(path.join(world.paths.health.auditsDir, `${AUDIT_ID}.json`), {
						v: 1,
						sessionId: AUDIT_ID,
						status: "done",
						requestedMs: world.nowMs - 60_000,
						finishedMs: world.nowMs,
						model: "openai/gpt-review:high",
						result: { overall: "sound", summary: "조사 결과입니다", tokens: { judgment: "normal", explanation: "적절합니다" }, checks: [{ item: "D1", judgment: "sound", explanation: "근거가 있습니다", evidence: ["F1"] }], recommendations: [], confidence: 0.8 },
					});
					const done = (await world.detail(AUDIT_ID)).audit;
					assert.equal(done.state.status, "done");
					assert.equal(done.state.statusKo, "완료");
					assert.equal(done.state.result.overallKo, "적절");
					assert.equal(done.stalled, false);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("plans around every analyst model a selected investigation used, not only the latest", async () => {
				const world = makeWorld({ lanes: { ultrabrain: ["openai/alpha-review"], architect: ["openai/beta-review"], "deep-high": ["openai/gamma-review"] } });
				try {
					writeJson(path.join(world.paths.health.investigationsDir, "F1.json"), {
						id: "F1",
						openedMs: world.nowMs - 300_000,
						updatedMs: world.nowMs - 60_000,
						trigger: "stall",
						subject: { sessionId: AUDIT_ID },
						status: "verdict",
						model: "openai/beta-review",
						verdict: null,
					});
					fs.mkdirSync(world.paths.health.decisionsDir, { recursive: true });
					fs.appendFileSync(
						path.join(world.paths.health.decisionsDir, "2026-11-22.jsonl"),
						`${JSON.stringify({ ts: new Date(world.nowMs - 240_000).toISOString(), fp: "F1", event: "investigation", status: "analyzing", model: "openai/alpha-review" })}\n`,
					);
					assert.equal((await world.detail(AUDIT_ID)).audit.planned.model, "openai/gamma-review", "the first look's model is excluded too");
					const posted = await world.startAudit(AUDIT_ID);
					assert.deepEqual([posted[0], posted[1].audit.planned.model], [202, "openai/gamma-review"]);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			for (const source of ["recorded", "retained", "missing", "no-job-id"]) it(`IS-9 provenance: preview and POST check ${source} analyst evidence`, async () => {
				const fallback = "openai/alpha-review";
				const next = "openai/beta-review";
				const requested = "openai/other-analyst";
				const world = makeWorld({ lanes: { ultrabrain: [fallback], architect: [next] } });
				try {
					const jobId = "analyst-fallback";
					const ts = new Date(world.nowMs - 120_000).toISOString();
					const fp = "fallback-fp";
					const rows = [
						{ ts, fp, jobId, event: "investigation", status: "analyzing", subject: { sessionId: AUDIT_ID }, model: requested },
						{ ts, fp, event: "investigation", status: "failed", analyst: { verdict: "escalate" },
							...(source === "no-job-id" ? {} : { jobId }),
							...(source === "recorded" ? { usedModels: [requested, fallback] } : {}) },
					];
					fs.mkdirSync(world.paths.health.decisionsDir, { recursive: true });
					fs.writeFileSync(path.join(world.paths.health.decisionsDir, "2026-11-22.jsonl"), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
					if (source === "retained") {
						const dir = path.join(world.paths.health.jobsDir, jobId);
						fs.mkdirSync(dir, { recursive: true });
						fs.writeFileSync(path.join(dir, "err.log"), `Model fallback: ${requested} -> ${fallback} (transient)\n`);
					}
					const unknown = source === "missing" || source === "no-job-id";
					for (const pass of ["initial", "cached"]) {
						const { blocked, planned } = (await world.detail(AUDIT_ID)).audit;
						assert.deepEqual([blocked, planned?.model ?? null], unknown ? ["models-unknown", null] : [null, next], pass);
					}
					const [status, body] = await world.startAudit(AUDIT_ID);
					if (unknown) {
						assert.deepEqual([status, body.error], [409, "models-unknown"]);
						assert.equal(fs.existsSync(requestFileOf(world)), false);
						assert.equal(fs.existsSync(world.paths.health.auditBudgetFile), false);
					} else assert.deepEqual([status, body.audit.planned.model], [202, next]);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("excludes a decision-only fp's analyzing model from the detail and the POST", async () => {
				const world = makeWorld({ lanes: { ultrabrain: ["openai/alpha-review"], architect: ["openai/beta-review"] } });
				try {
					fs.mkdirSync(world.paths.health.decisionsDir, { recursive: true });
					fs.appendFileSync(
						path.join(world.paths.health.decisionsDir, "2026-11-22.jsonl"),
						[
							{ ts: new Date(world.nowMs - 290_000).toISOString(), fp: "F9", event: "opened", subject: { sessionId: AUDIT_ID } },
							{ ts: new Date(world.nowMs - 240_000).toISOString(), fp: "F9", event: "investigation", status: "analyzing", model: "openai/alpha-review" },
						]
							.map((entry) => JSON.stringify(entry))
							.join("\n") + "\n",
					);
					const detail = (await world.detail(AUDIT_ID)).audit;
					assert.equal(detail.planned.model, "openai/beta-review", "the decision-only fp's analyst model is not offered");
					const posted = await world.startAudit(AUDIT_ID);
					assert.equal(posted[0], 202);
					assert.equal(posted[1].audit.planned.model, "openai/beta-review", "the POST must not launch the analyst model either");
					assert.notEqual(posted[1].audit.planned.model, "openai/alpha-review");
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			function aliasWorld() {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-alias-"));
				const env = { USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") };
				const worldPaths = resolvePaths(env);
				const nowMs = Date.parse("2026-11-22T00:00:00.000Z");
				const sessionId = "s_child01";
				const taskId = "st_child01";
				const sessionFile = path.join(worldPaths.sessionsDir, "slug", `2026-11-22T00-00-00-000Z_${sessionId}.jsonl`);
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
				const stat = fs.statSync(sessionFile);
				writeIndexRow(worldPaths.health.usageIndexFile, {
							id: sessionId,
							file: sessionFile,
							kind: "child",
							taskId,
							parentSessionId: null,
							rootSessionId: null,
							state: "ok",
							complete: true,
							gone: false,
							size: stat.size,
							mtimeMs: stat.mtimeMs,
							offset: stat.size,
							ino: stat.ino,
							birthtimeMs: stat.birthtimeMs,
							head: "",
							headLen: 0,
							tail: "",
							evaluatedTo: stat.size,
							checkedMs: nowMs,
							usage: emptyUsage(),
							overlay: emptyUsage(),
							published: { ...emptyUsage(), usedModels: { "anthropic/claude-used": true } },
				});
				writeJson(worldPaths.omoJsonc, { "[native]": { categories: { ultrabrain: { models: ["openai/gpt-review:high"] } } } });
				writeJson(worldPaths.authFile, { anthropic: {}, openai: {} });
				writeJson(worldPaths.health.daemonJson, { ts: nowMs, pid: process.pid, mode: "auto", version: "test" });
				const record = { found: true, id: sessionId, session: { sessionId, taskId, kind: "child", title: "child" }, tokens: null, children: [], health: { findings: [], actions: [], investigations: [], messages: [], counts: { findings: 0, actions: 0, investigations: 0, messages: 0 } }, audit: null };
				return { dir, env, paths: worldPaths, now: () => nowMs, sessionId, taskId, load: () => record };
			}

			it("resolves a task-id request to the ledger session id so the second request for the same child gets 409 running", async () => {
				for (const [first, second] of [["s_child01", "st_child01"], ["st_child01", "s_child01"]]) {
					const world = aliasWorld();
					const auditServer = createUiServer({
						paths: world.paths,
						token: TOKEN,
						getState: () => STATE,
						startAudit: createStartAudit({ paths: world.paths, env: world.env, now: world.now, load: world.load }),
						now: world.now,
					});
					const { port: auditPort } = await auditServer.listen();
					try {
						const accepted = await postAt(auditPort, "/api/audit", { sessionId: first });
						assert.deepEqual([accepted.status, accepted.body.audit.sessionId], [202, world.sessionId], `${first} must be accepted as the canonical session`);
						const refused = await postAt(auditPort, "/api/audit", { sessionId: second });
						assert.deepEqual([refused.status, refused.body.error], [409, "running"], `${second} must find the first request`);
						assert.deepEqual(fs.readdirSync(world.paths.health.auditRequestsDir), [`${world.sessionId}.json`]);
					} finally {
						await auditServer.close();
						fs.rmSync(world.dir, { recursive: true, force: true });
					}
				}
			});

			it("shows a child's pending request as queued through both the task id and the session id", async () => {
				const world = aliasWorld();
				fs.mkdirSync(world.paths.health.sessionsDir, { recursive: true });
				fs.writeFileSync(
					path.join(world.paths.health.sessionsDir, "ended-2026-11-22.jsonl"),
					`${JSON.stringify({ v: 1, sessionId: world.sessionId, taskId: world.taskId, kind: "child", outcome: "answered", startedMs: world.now() - 1_000, endedMs: world.now() })}\n`,
				);
				writeJson(path.join(world.paths.health.auditRequestsDir, `${world.sessionId}.json`), { v: 1, sessionId: world.sessionId, requestedMs: world.now() - 1_000 });
				const auditServer = createUiServer({
					paths: world.paths,
					token: TOKEN,
					getState: () => STATE,
					sessionDetail: createSessionDetail({ paths: world.paths, env: world.env, now: world.now }),
					now: world.now,
				});
				const { port: auditPort } = await auditServer.listen();
				try {
					const byTask = await getAt(auditPort, `/api/session?id=${world.taskId}`);
					const bySession = await getAt(auditPort, `/api/session?id=${world.sessionId}`);
					assert.deepEqual([byTask.status, bySession.status], [200, 200]);
					assert.equal(byTask.body.audit.state.status, "queued", "the task id resolves to the ledger session's request");
					assert.equal(bySession.body.audit.state.status, "queued");
					assert.deepEqual([byTask.body.audit.state.status, byTask.body.audit.state.statusKo], ["queued", "대기 중"]);
				} finally {
					await auditServer.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("POST returns 202 through the real daemon status path and writes only the request file", async () => {
				const world = makeWorld();
				const auditServer = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now: world.now });
				const { port: auditPort } = await auditServer.listen();
				try {
					assert.equal(daemonStatus(loadDaemonInputs({ paths: world.paths, env: world.env, now: world.nowMs })).state, "running");
					const accepted = await postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					assert.equal(accepted.status, 202);
					assert.equal(accepted.body.ok, true);
					assert.equal(accepted.body.audit.status, "queued");
					assert.equal(accepted.body.audit.planned.model, "openai/gpt-review:high");
					const pending = JSON.parse(fs.readFileSync(requestFileOf(world), "utf8"));
					assert.deepEqual(pending, { v: 1, sessionId: AUDIT_ID, requestedMs: world.nowMs, claimId: pending.claimId });
					assert.equal(typeof pending.claimId, "string");
					const again = await postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					assert.deepEqual([again.status, again.body.error], [409, "running"]);
					assert.deepEqual(fs.readdirSync(world.paths.health.auditRequestsDir), [`${AUDIT_ID}.json`]);
				} finally {
					await auditServer.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("two dashboards racing for one audit return 202 and 409, then the daemon launches and charges once", async (t) => {
				const world = makeWorld();
				const { paths, env, now, nowMs } = world;
				const servers = [];
				t.after(async () => {
					await Promise.all(servers.map((server) => server.close()));
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const gate = Promise.withResolvers();
				let arrived = 0;
				const ports = await Promise.all([0, 1].map(async () => {
					// Both dashboards observe the state before either publishes. Inject
					// that read into their independent synchronous detail operations.
					let observed;
					const startAudit = createStartAudit({ paths, env, now, readState: () => observed });
					const dashboard = createUiServer({
						paths, token: TOKEN, getState: () => STATE, now,
						startAudit: async (id) => {
							observed = readAuditState(paths, id);
							if (++arrived === 2) gate.resolve();
							await gate.promise;
							return startAudit(id);
						},
					});
					servers.push(dashboard);
					return (await dashboard.listen()).port;
				}));
				const replies = await Promise.all(ports.map((port) => postAt(port, "/api/audit", { sessionId: AUDIT_ID })));
				assert.deepEqual(replies.map((reply) => reply.status).sort(), [202, 409]);
				assert.deepEqual(replies.find((reply) => reply.status === 409).body, { error: "running", reasonKo: "이미 조사 중입니다" });
				assert.equal(replies.find((reply) => reply.status === 202).body.audit.sessionId, AUDIT_ID);

				const starts = [];
				const { config } = loadConfig({ paths, env });
				const auditor = createAuditor({ paths, env, config, clock: { now }, runner: { start: (job) => starts.push(job) } });
				auditor.tick(nowMs);
				await auditor.preparing();
				auditor.tick(nowMs);
				assert.equal(starts.length, 1);
				assert.equal(readAuditState(paths, AUDIT_ID).status, "running");
				assert.equal(fs.existsSync(requestFileOf(world)), false);
				assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.auditBudgetFile, "utf8")), {
					day: "2026-11-22", count: 1, jobs: [starts[0].jobId],
				});
			});

			it("accepts the dashboard's own claim when the daemon takes it before the dashboard rereads", async (t) => {
				const world = makeWorld();
				const { paths, env, now } = world;
				const { config } = loadConfig({ paths, env });
				const starts = [];
				const auditor = createAuditor({ paths, env, config, clock: { now }, runner: { start: (job) => starts.push(job) } });
				let claimed;
				const startA = createStartAudit({
					paths, env, now,
					request: (...args) => {
						const claim = requestAudit(...args);
						assert.equal(claim.created, true);
						claimed = claim.request;
						auditor.tick(now());
						assert.equal(readAuditState(paths, AUDIT_ID).status, "queued");
						assert.equal(fs.existsSync(requestFileOf(world)), false);
						return claim;
					},
				});
				const dashboard = (startAudit) => createUiServer({ paths, token: TOKEN, getState: () => STATE, now, startAudit });
				const a = dashboard(startA);
				const b = dashboard(world.startAudit);
				t.after(async () => {
					await Promise.all([a.close(), b.close(), world.detail.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const [{ port: aPort }, { port: bPort }] = await Promise.all([a.listen(), b.listen()]);
				const accepted = await postAt(aPort, "/api/audit", { sessionId: AUDIT_ID });
				assert.equal(accepted.status, 202);
				assert.equal(accepted.body.audit.sessionId, AUDIT_ID);
				assert.equal(readAuditState(paths, AUDIT_ID).claimId, claimed.claimId);
				const refused = await postAt(bPort, "/api/audit", { sessionId: AUDIT_ID });
				assert.deepEqual([refused.status, refused.body], [409, { error: "running", reasonKo: "이미 조사 중입니다" }]);
				await auditor.preparing();
				auditor.tick(now());
				assert.equal(readAuditState(paths, AUDIT_ID).status, "running");
				assert.equal(fs.existsSync(requestFileOf(world)), false);
				assert.equal(starts.length, 1);
				assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.auditBudgetFile, "utf8")), {
					day: "2026-11-22", count: 1, jobs: [starts[0].jobId],
				});
			});

			it("two dashboards refuse a duplicate after intake, even when B checked before A posted", async () => {
				for (const interleave of [false, true]) {
					const world = makeWorld();
					const { paths, env, now } = world;
					const { config } = loadConfig({ paths, env });
					const starts = [];
					const auditor = createAuditor({ paths, env, config, clock: { now }, runner: {
						start(job) {
							starts.push(job);
							throw new Error("spawn result uncertain");
						},
						adoptJob: () => "running",
						poll: () => ({ status: "failed", reason: "test-finish" }),
					} });
					const dashboard = (startAudit) => createUiServer({ paths, token: TOKEN, getState: () => STATE, now, startAudit });
					const a = dashboard(world.startAudit);
					const intake = () => {
						auditor.tick(now());
						assert.equal(readAuditState(paths, AUDIT_ID).status, "queued");
						assert.equal(fs.existsSync(requestFileOf(world)), false);
					};
					let firstRead = interleave;
					// For the interleaving, capture B's initial read before A posts.
					const observed = readAuditState(paths, AUDIT_ID);
					const b = dashboard(createStartAudit({
						paths, env, now: () => now() + 1,
						readState: (...args) => {
							if (!firstRead) return readAuditState(...args);
							firstRead = false;
							return observed;
						},
						request: (...args) => {
							assert.equal(interleave, true, "B must not claim when it reads A's active record");
							assert.equal(readAuditState(paths, AUDIT_ID).status, "requested");
							intake();
							const claim = requestAudit(...args);
							assert.equal(claim.created, true, "B claims the slot released by intake");
							return claim;
						},
					}));
					try {
						const [{ port: aPort }, { port: bPort }] = await Promise.all([a.listen(), b.listen()]);
						assert.equal(observed, null);
						assert.equal((await postAt(aPort, "/api/audit", { sessionId: AUDIT_ID })).status, 202);
						if (!interleave) intake();
						const refused = await postAt(bPort, "/api/audit", { sessionId: AUDIT_ID });
						assert.deepEqual([refused.status, refused.body], [409, { error: "running", reasonKo: "이미 조사 중입니다" }]);
						assert.equal(fs.existsSync(requestFileOf(world)), false);
						await auditor.preparing();
						auditor.tick(now());
						assert.equal(readAuditState(paths, AUDIT_ID).status, "launching");
						auditor.tick(now() + 30_000);
						auditor.tick(now() + 60_000);
						assert.equal(starts.length, 1);
						assert.deepEqual(fs.readdirSync(paths.health.auditsDir).filter((name) => !name.startsWith("_") && name.endsWith(".json")), [`${AUDIT_ID}.json`]);
						assert.equal(readAuditState(paths, AUDIT_ID).requestedMs, now());
						assert.equal(readAuditState(paths, AUDIT_ID).status, "failed");
						assert.deepEqual(JSON.parse(fs.readFileSync(paths.health.auditBudgetFile, "utf8")), {
							day: "2026-11-22", count: 1, jobs: [starts[0].jobId],
						});
					} finally {
						await Promise.all([a.close(), b.close(), world.detail.close()]);
						fs.rmSync(world.dir, { recursive: true, force: true });
					}
				}
			});

			it("treats a file that grew after the index read as models-unknown for a POST and never plans a model", async () => {
				const world = makeWorld({ growFile: true });
				const auditServer = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now: world.now });
				const { port: auditPort } = await auditServer.listen();
				try {
					const detail = (await world.detail(AUDIT_ID)).audit;
					assert.equal(detail.blocked, "models-unknown");
					assert.equal(detail.planned, null);
					const posted = await postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					assert.deepEqual([posted.status, posted.body], [409, { error: "models-unknown", reasonKo: "세션이 쓴 모델을 다 확인하지 못해 조사할 수 없습니다" }]);
					assert.equal(fs.existsSync(requestFileOf(world)), false);
				} finally {
					await auditServer.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("refuses a launching audit with 409 running and writes no request", async () => {
				const world = makeWorld();
				const auditServer = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, startAudit: world.startAudit, now: world.now });
				const { port: auditPort } = await auditServer.listen();
				try {
					writeJson(path.join(world.paths.health.auditsDir, `${AUDIT_ID}.json`), { v: 1, sessionId: AUDIT_ID, status: "launching", requestedMs: world.nowMs - 1_000, jobId: "audit-1", model: "openai/gpt-review:high" });
					const posted = await postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					assert.deepEqual([posted.status, posted.body], [409, { error: "running", reasonKo: "이미 조사 중입니다" }]);
					assert.equal(fs.existsSync(requestFileOf(world)), false);
				} finally {
					await auditServer.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("never plans a model the session used only for prewarming", async () => {
				const world = makeWorld({
					usedModels: { "anthropic/claude-prewarm": true },
					lanes: { ultrabrain: ["anthropic/claude-prewarm"], architect: ["openai/gpt-review:high"] },
				});
				try {
					const planned = (await world.detail(AUDIT_ID)).audit.planned;
					assert.equal(planned.model, "openai/gpt-review:high");
					assert.equal(planned.independence, "family");
					assert.notEqual(planned.model, "anthropic/claude-prewarm");
					assert.equal((await world.startAudit(AUDIT_ID))[0], 202);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			for (const kind of ["toolResult", "compaction"]) {
				it(`(plan 24) preview and POST exclude a model seen only in a ${kind}`, async () => {
					const model = `grok-${kind}-carrier`;
					const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
					const entry = kind === "toolResult"
						? { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: false, provider: "xai", model, usage } }
						: { type: "compaction", provider: "xai", model, usage };
					const world = makeWorld({ usedModels: {}, entries: [entry], providers: ["xai", "google"], lanes: { ultrabrain: [`xai/${model}`], architect: ["google/gemini-review"] } });
					try {
						const planned = (await world.detail(AUDIT_ID)).audit.planned;
						assert.equal(planned.model, "google/gemini-review");
						assert.notEqual(planned.model, `xai/${model}`);
						const posted = await world.startAudit(AUDIT_ID);
						assert.equal(posted[0], 202);
						assert.equal(posted[1].audit.planned.model, "google/gemini-review");
					} finally {
						await world.detail.close();
						fs.rmSync(world.dir, { recursive: true, force: true });
					}
				});
			}

			it("(plan 25) a compaction that carries usage without a model id blocks the preview as models-unknown", async () => {
				const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
				const entry = { type: "compaction", provider: "xai", usage };
				const world = makeWorld({ usedModels: {}, entries: [entry], providers: ["xai", "google"], lanes: { ultrabrain: ["xai/grok-5"], architect: ["google/gemini-review"] } });
				try {
					const detail = (await world.detail(AUDIT_ID)).audit;
					assert.equal(detail.blocked, "models-unknown");
					assert.equal(detail.planned, null);
					const posted = await world.startAudit(AUDIT_ID);
					assert.equal(posted[1].error, "models-unknown");
					assert.equal(fs.existsSync(requestFileOf(world)), false);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("(gate 15) preview and POST exclude an identity missing only from published.usedModels", async () => {
				const world = makeWorld({
					usedModels: { "openai/alpha-review": true },
					lanes: { ultrabrain: ["openai/alpha-review"], architect: ["openai/beta-review"] },
				});
				try {
					const file = world.paths.health.usageIndexFile;
					const entry = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[1]);
					entry.usage.usedModels = { ...entry.published.usedModels };
					delete entry.published.usedModels["openai/alpha-review"];
					writeIndexRow(file, entry);
					assert.equal((await world.detail(AUDIT_ID)).audit.planned.model, "openai/beta-review");
					assert.equal((await world.startAudit(AUDIT_ID))[1].audit.planned.model, "openai/beta-review");
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			for (const incomplete of ["timeline", "index"]) {
				it(`(gate 14) preview and POST refuse when only the ${incomplete} lost model identities`, async () => {
					const world = makeWorld();
					try {
						const indexFile = world.paths.health.usageIndexFile;
						const entry = JSON.parse(fs.readFileSync(indexFile, "utf8").split("\n")[1]);
						if (incomplete === "index") entry.published.modelsIncomplete = true;
						else {
							const row = { type: "message", message: { role: "assistant", provider: "openai", model: "x".repeat(257) } };
							fs.appendFileSync(world.sessionFile, `${JSON.stringify(row)}\n`);
							// Keep the simulated index fresh, while only the full timeline sees the loss.
							const stat = fs.statSync(world.sessionFile);
							entry.size = entry.offset = entry.evaluatedTo = stat.size;
							entry.mtimeMs = stat.mtimeMs;
						}
						writeIndexRow(indexFile, entry);
						const detail = (await world.detail(AUDIT_ID)).audit;
						assert.equal(detail.blocked, "models-unknown");
						assert.equal(detail.planned, null);
						assert.equal((await world.startAudit(AUDIT_ID))[1].error, "models-unknown");
						assert.equal(fs.existsSync(requestFileOf(world)), false);
					} finally {
						await world.detail.close();
						fs.rmSync(world.dir, { recursive: true, force: true });
					}
				});
			}

			it("reports the first block in order: disabled, daemon-off, cap, then no-model", async () => {
				const disabled = makeWorld({ daemon: "off", enabled: false });
				const daemonOff = makeWorld({ daemon: "off" });
				const capped = makeWorld({ budgetCount: 20 });
				const noModel = makeWorld({ lanes: {} });
				try {
					assert.equal((await disabled.detail(AUDIT_ID)).audit.blocked, "disabled");
					assert.equal((await daemonOff.detail(AUDIT_ID)).audit.blocked, "daemon-off");
					assert.equal((await daemonOff.detail(AUDIT_ID)).audit.planned.model, "openai/gpt-review:high");
					assert.equal((await capped.detail(AUDIT_ID)).audit.blocked, "cap");
					assert.equal((await capped.detail(AUDIT_ID)).audit.usedToday, 20);
					assert.equal((await noModel.detail(AUDIT_ID)).audit.blocked, "no-model");
					assert.equal((await noModel.detail(AUDIT_ID)).audit.planned, null);
					assert.equal((await noModel.startAudit(AUDIT_ID))[0], 409);
				} finally {
					for (const world of [disabled, daemonOff, capped, noModel]) {
						await world.detail.close();
						fs.rmSync(world.dir, { recursive: true, force: true });
					}
				}
			});
		});
	});

	describe("errors", () => {
		it("answers 500 without the error detail when getState throws, and logs it", async () => {
			const logged = [];
			const failing = createUiServer({
				paths,
				token: TOKEN,
				getState: () => {
					throw new Error("boom");
				},
				log: (event, fields) => logged.push({ event, fields }),
			});
			const { port: failingPort, url } = await failing.listen();
			try {
				assert.equal(url, `http://127.0.0.1:${failingPort}/#t=${TOKEN}`);
				const res = await new Promise((resolve, reject) => {
					const req = http.request(
						{ host: "127.0.0.1", port: failingPort, path: "/api/state", headers: { "x-omo-health-token": TOKEN }, agent: false },
						(r) => {
							const chunks = [];
							r.on("data", (c) => chunks.push(c));
							r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
						},
					);
					req.on("error", reject);
					req.end();
				});
				assert.equal(res.status, 500);
				assert.deepEqual(res.body, { error: "internal" });
				assert.deepEqual(logged.map((l) => l.event), ["ui_request_failed"]);
				assert.equal(JSON.stringify(logged).includes(TOKEN), false);
			} finally {
				await failing.close();
			}
		});
	});
});
