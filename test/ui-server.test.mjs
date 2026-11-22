import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { createSessionDetail } from "../src/ui/cli.mjs";
import { createUiServer } from "../src/ui/server.mjs";

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

before(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-server-"));
	paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") });
	const staticDir = path.join(root, "static");
	fs.mkdirSync(staticDir, { recursive: true });
	fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
	fs.writeFileSync(path.join(staticDir, "app.js"), "export {};\n");
	fs.writeFileSync(path.join(staticDir, "app.css"), "body{}\n");
	clock = 1_000_000;
	const diagnose = async (id) => (id ? { found: true, id } : { subjects: [{ id: "st_c" }] });
	server = createUiServer({ paths, token: TOKEN, getState: () => STATE, diagnose, sessionDetail, idleMs: IDLE_MS, now: () => clock, staticDir });
	({ port } = await server.listen());
});

after(async () => {
	await server.close();
	fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
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
