import "./helpers/tmp-root.mjs";
import { projectKeyOf, subjectKey, subjectOf } from "../src/session-subject.mjs";
const sub = (sessionId, cwd, taskId) => subjectOf({ sessionId, cwd, taskId });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it as nodeIt } from "node:test";

// Each case gets its own hang guard; a suite-wide timeout cancels healthy cases on a slow runner once the file grows.
const it = (name, options, fn) => typeof options === "function"
	? nodeIt(name, { timeout: 20_000 }, options)
	: nodeIt(name, { timeout: 20_000, ...options }, fn);
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { createAuditor, readAuditState, requestAudit } from "../src/auditor.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { senpiTaskStoreDir } from "../src/collect/tasks.mjs";
import { loadConfig } from "../src/config.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { emptyUsage } from "../src/collect/usage.mjs";
import { appendDecision } from "../src/decisions.mjs";
import { BACKFILL_MARKER, backfillOnce } from "../src/session-backfill.mjs";
import { ANALYST_POLL_MS } from "../src/judge/analyst.mjs";
import { auditFileKey } from "../src/session-subject.mjs";
import { appendEnded, appendEndedBatch, readEnded } from "../src/session-ledger.mjs";
import { createDetailWorker, createSessionDetail, createStartAudit } from "../src/ui/cli.mjs";
import { buildEnded, daemonStatus, loadDaemonInputs, uiState } from "../src/ui/model.mjs";
import { createUiServer } from "../src/ui/server.mjs";
import { createUsageIndex, USAGE_INDEX_VERSION } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { E, appendJsonl, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

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
const sessionDetail = async (id, _row, { list, offset }) => {
	if (id !== KNOWN_ID) return { found: false, id };
	const lists = { ...SESSION_DETAIL.health, children: SESSION_DETAIL.children };
	if (list !== null) return { list, offset, total: lists[list].length, items: lists[list].slice(offset, offset + 50) };
	return {
		...SESSION_DETAIL,
		children: lists.children.slice(0, 50),
		health: { ...SESSION_DETAIL.health, findings: lists.findings.slice(0, 50), messages: lists.messages.slice(0, 50) },
		counts: { children: lists.children.length, ...SESSION_DETAIL.health.counts },
	};
};

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
function getAt(targetPort, target, signal) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: targetPort, method: "GET", path: target, headers: { "x-omo-health-token": TOKEN }, agent: false, signal }, (res) => {
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

describe("ui server", () => {
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

		it("IS-4 serves live and ended state without touching session stores", async (t) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-state-index-"));
			const env = { USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") };
			const paths = resolvePaths(env);
			const nowMs = Date.parse("2026-11-22T12:00:00.000Z");
			const now = () => nowMs;
			const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
			const ended = new Map();
			const liveId = "s_state_live";
			const canonicalPath = (file) => {
				const resolved = path.resolve(file);
				return process.platform === "win32" ? resolved.toLowerCase() : resolved;
			};
			t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

			for (const [id, total] of [[liveId, 11], ["s_state_done1", 22], ["s_state_done2", 33], ["s_state_done3", 44]]) {
				const file = path.join(paths.sessionsDir, projectKeyOf(dir), `2026-11-22T11-59-59-000Z_${id}.jsonl`);
				writeJsonl(file, [
					{ type: "session", id, cwd: dir },
					{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: total }, stopReason: "stop" } },
				]);
				index.update(sub(id, dir), file, { kind: "main" });
				if (id === liveId) continue;
				appendEnded(paths, { sessionId: id, kind: "main", cwd: dir, startedMs: nowMs - 1_000, endedMs: nowMs, outcome: "answered" }, { nowMs });
				ended.set(id, total);
			}
			const taskId = "st_state_child";
			const store = senpiTaskStoreDir(dir, paths.agentDir);
			const childDir = path.join(store, "children", taskId, "sessions", taskId);
			const first = path.join(childDir, "2026-11-22T11-59-59-000Z_child-one.jsonl");
			const second = path.join(childDir, "2026-11-22T12-00-00-000Z_child-two.jsonl");
			writeJsonl(first, [
				{ type: "session", id: "child-one", cwd: dir },
				{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: 55 }, stopReason: "stop" } },
			]);
			const row = { sessionId: taskId, taskId, kind: "child", cwd: dir, startedMs: nowMs - 1_000, endedMs: nowMs, outcome: "answered" };
			appendEnded(paths, row, { nowMs });
			ended.set(taskId, 55);
			const tracker = createUsageTracker({ paths, index, locator: createSessionFileLocator({ paths, clock: { now } }), clock: { now } });
			tracker.queueLedger([row]);
			tracker.tick();
			index.save();
			fs.mkdirSync(path.dirname(paths.health.sessionsSnapshotFile), { recursive: true });
			fs.writeFileSync(paths.health.sessionsSnapshotFile, JSON.stringify({
				ts: nowMs, groups: [{ omoVersion: "test", sessions: [{ sessionId: liveId, tokens: { total: 11 } }] }],
			}));

			const ui = createUiServer({ paths, token: TOKEN, getState: () => uiState({ paths, env, now: now() }), now });
			try {
				const { port } = await ui.listen();
				const transcriptOpens = [];
				const storeAccesses = [];
				const roots = [paths.sessionsDir, path.join(store, "children")].map(canonicalPath);
				let servingState = false;
				for (const [target, methods] of [
					[fs, ["openSync", "readFileSync", "createReadStream", "open", "readFile", "opendirSync", "readdirSync", "opendir", "readdir", "statSync"]],
					[fs.promises, ["open", "readFile", "opendir", "readdir", "stat"]],
				]) {
					for (const method of methods) {
						const original = target[method];
						t.mock.method(target, method, function (file, ...args) {
							const filename = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
							if (servingState && typeof filename === "string") {
								const resolved = canonicalPath(filename);
								if (roots.some((item) => resolved === item || resolved.startsWith(item + path.sep))) {
									const accesses = /^(open|readFile|createReadStream)(Sync)?$/.test(method) ? transcriptOpens : storeAccesses;
									accesses.push({ method, file: filename });
								}
							}
							return original.call(this, file, ...args);
						});
					}
				}
				syncBuiltinESMExports();
				const checkState = async () => {
					servingState = true;
					const { status, body } = await getAt(port, "/api/state");
					servingState = false;
					assert.equal(status, 200);
					assert.deepEqual(body.sessions.groups[0].sessions.map((row) => [row.sessionId, row.tokens?.total]), [[liveId, 11]]);
					assert.deepEqual(new Map(body.ended.rows.map((row) => [row.sessionId, row.tokens?.total])), ended);
					assert.deepEqual(transcriptOpens, [], "/api/state opened a session transcript on the server thread");
					assert.deepEqual(storeAccesses, [], "/api/state accessed a session directory or transcript on the server thread");
				};
				await checkState();
				writeJsonl(second, [{ type: "session", id: "child-two", cwd: dir }]);
				tracker.tick();
				ended.set(taskId, undefined);
				await checkState();
			} finally {
				t.mock.reset();
				syncBuiltinESMExports();
				await ui.close();
			}
		});
	});

	it("/api/state never opens retained ledger files on the HTTP thread", async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-state-retained-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const env = { USERPROFILE: dir, OMO_HEALTH_HOME: dir, OMO_HEALTH_OMO_HOME: path.join(dir, ".omo") };
		const paths = resolvePaths(env);
		const nowMs = Date.UTC(2026, 10, 22, 12);
		const now = () => nowMs;
		const day = 86_400_000;
		const endedMs = nowMs - 29 * day;
		const projectA = path.join(dir, "a");
		const projectB = path.join(dir, "b");
		const visible = { sessionId: "visible", kind: "main", cwd: projectA, startedMs: endedMs - 1_000, endedMs, outcome: "answered" };
		const right = { ...visible, sessionId: "right", endedMs: endedMs - 1 };
		const ambiguousChild = { ...visible, sessionId: "ambiguous-child", kind: "child", cwd: projectB, parentSessionId: visible.sessionId, endedMs: endedMs - 2 };
		const resolvedChild = { ...ambiguousChild, sessionId: "resolved-child", parentSessionId: right.sessionId, endedMs: endedMs - 3 };
		const visibleFile = path.join(paths.health.sessionsDir, `ended-${new Date(endedMs).toISOString().slice(0, 10)}.jsonl`);
		writeJsonl(visibleFile, [visible, right, ambiguousChild, resolvedChild].map((row) => ({ ...row, v: 1 })));

		const retained = new Set();
		for (const age of [31, 32, 33]) {
			const olderMs = nowMs - age * day;
			const file = path.join(paths.health.sessionsDir, `ended-${new Date(olderMs).toISOString().slice(0, 10)}.jsonl`);
			retained.add(file);
			writeJsonl(file, [{ ...visible, v: 1, sessionId: age === 31 ? visible.sessionId : `old-${age}`, cwd: projectB, endedMs: olderMs }]);
		}

		const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
		for (const [row, input] of [[visible, 10], [right, 20], [ambiguousChild, 30], [resolvedChild, 40]]) {
			const transcript = path.join(dir, `${row.sessionId}.jsonl`);
			writeJsonl(transcript, [{ type: "usage", provider: "p", model: "m", usage: { input } }]);
			index.update(subjectOf(row), transcript, { parentSessionId: row.parentSessionId ?? null, parentKey: row.parentSessionId ? "" : null });
		}
		index.save();

		const ui = createUiServer({ paths, token: TOKEN, getState: () => uiState({ paths, env, now: now() }), now });
		try {
			const { port } = await ui.listen();
			const opened = new Set();
			for (const [target, methods] of [
				[fs, ["openSync", "readFileSync", "createReadStream", "open", "readFile"]],
				[fs.promises, ["open", "readFile"]],
			]) for (const method of methods) {
				const original = target[method];
				t.mock.method(target, method, function (file, ...args) {
					const name = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
					if (typeof name === "string" && retained.has(path.resolve(name))) opened.add(path.basename(name));
					return original.call(this, file, ...args);
				});
			}
			syncBuiltinESMExports();
			const checkState = async (rightTree, rightChildren) => {
				const { status, body } = await getAt(port, "/api/state");
				assert.equal(status, 200);
				assert.deepEqual(body.ended.rows.map((row) => row.sessionId), ["visible", "right", "ambiguous-child", "resolved-child"]);
				assert.deepEqual([...opened], [], "/api/state opened retained ledger files");
				assert.deepEqual(body.ended.rows.map((row) => [row.tokens?.total, row.treeTokens, row.childCount]), [
					[10, null, 0], [20, rightTree, rightChildren], [30, null, 0], [40, null, 0],
				]);
			};
			await checkState(null, 0);
			// Publish the resolved link and leave the ambiguous one explicitly unlinked.
			assert.equal(index.recordParentLink(subjectOf(resolvedChild), subjectKey(subjectOf(right))), true);
			index.save();
			await checkState(60, 1);
		} finally {
			t.mock.reset();
			syncBuiltinESMExports();
			await ui.close();
		}
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
				return { ...fakeRecord(id), session: { ...fakeRecord(id).session, cwd: paths.sessionsDir } };
			};
			const slug = path.join(paths.sessionsDir, projectKeyOf(paths.sessionsDir));
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
		it("rejects extra keys, a non-string id, a malformed id and an over-limit id with 422", async () => {
			assert.equal((await postJson("/api/audit", { sessionId: KNOWN_ID, extra: 1 })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: 12345 })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: "..%2Fx" })).status, 422);
			assert.equal((await postJson("/api/audit", { sessionId: "x".repeat(1025) })).status, 422);
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

			function makeWorld({ sessionId = AUDIT_ID, total = 0, daemon = "running", enabled = true, usedModels = { "anthropic/claude-used": true }, lanes = { ultrabrain: ["anthropic/claude-used"], architect: ["openai/gpt-review:high"] }, providers = ["anthropic", "openai"], growFile = false, budgetCount = null, entries } = {}) {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-audit-ui-"));
				const env = { USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") };
				const worldPaths = resolvePaths(env);
				const nowMs = Date.parse("2026-11-22T00:00:00.000Z");
				const now = () => nowMs;
				// Seed the usage index with a short transcript path when the ID cannot fit in a Windows path component.
				const sessionFile = path.join(worldPaths.sessionsDir, projectKeyOf(dir), `2026-11-22T00-00-00-000Z_${sessionId.length > 200 ? "indexed" : sessionId}.jsonl`);
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				const sessionLines = [{ type: "session", id: sessionId }, ...(entries ?? [])];
				fs.writeFileSync(sessionFile, `${sessionLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
				const stat = fs.statSync(sessionFile);
				fs.mkdirSync(worldPaths.health.sessionsDir, { recursive: true });
				fs.writeFileSync(
					path.join(worldPaths.health.sessionsDir, "ended-2026-11-22.jsonl"),
					`${JSON.stringify({ v: 1, sessionId, taskId: null, cwd: dir, kind: "main", outcome: "answered", startedMs: nowMs - 1_000, endedMs: nowMs })}\n`,
				);
				writeIndexRow(worldPaths.health.usageIndexFile, {
							id: sessionId,
							projectKey: projectKeyOf(dir),
							parentKey: null,
							rootKey: null,
							file: sessionFile,
							kind: "main",
							parentSessionId: null,
							rootSessionId: null,
							state: "ok",
							complete: true,
							gone: false,
							size: stat.size,
							mtimeMs: stat.mtimeMs,
							offset: stat.size,
							ino: fs.statSync(sessionFile, { bigint: true }).ino.toString(),
							birthtimeMs: stat.birthtimeMs,
							head: "",
							headLen: 0,
							tail: "",
							evaluatedTo: stat.size,
							checkedMs: nowMs,
							usage: emptyUsage(),
							overlay: emptyUsage(),
							published: { ...emptyUsage(), total, usedModels },
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
				return path.join(world.paths.health.auditRequestsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`);
			}

			it("plan87: same-ID projects keep their detail, review bundle, reviewer and saved result separate", async (t) => {
				const sessionId = "review.1";
				const models = ["openai/gpt-review", "google/gemini-review"];
				const world = makeWorld({
					sessionId, lanes: { ultrabrain: [models[0]], architect: [models[1]] },
					providers: ["openai", "google"],
				});
				const { paths, env, now, nowMs, dir } = world;
				const rows = [dir, path.join(dir, "other")].map((cwd) => ({
					sessionId, cwd, kind: "main", startedMs: nowMs - 1000, endedMs: nowMs, outcome: "answered",
				}));
				const index = createUsageIndex({ file: path.join(dir, "fresh-index"), clock: { now } });
				for (const [i, row] of rows.entries()) {
					appendEnded(paths, row, { nowMs });
					const file = i === 0 ? world.sessionFile : path.join(paths.sessionsDir, projectKeyOf(row.cwd), `2026-11-22T00-00-00-000Z_${sessionId}.jsonl`);
					writeJsonl(file, [
						E.header(sessionId, row.cwd, nowMs - 1000),
						E.assistant({ ms: nowMs - 500, provider: models[i].split("/")[0], model: models[i].split("/")[1], usage: { input: (i + 1) * 17, output: 0 } }),
						{ type: "custom_message", customType: "omo-health", timestamp: new Date(nowMs - 100 + i).toISOString(), content: `project ${i}`, details: { kind: "self-notice" } },
					]);
					index.update(subjectOf(row), file, { kind: "main" });
				}
				index.save();
				fs.copyFileSync(path.join(dir, "fresh-index"), paths.health.usageIndexFile);
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, diagnose: () => ({}), now });
				let tickMs = nowMs;
				const starts = [];
				const summaries = ["첫 번째 프로젝트 조사 결과입니다", "두 번째 프로젝트 조사 결과입니다"];
				const runner = {
					start(job) { starts.push(job); return { jobId: job.jobId, pid: 5000 }; },
					poll(jobId) {
						return { status: "done", exitCode: 0, result: {
							overall: "sound", summary: summaries[starts.findIndex((start) => start.jobId === jobId)],
							tokens: { judgment: "normal", explanation: "Normal." },
							checks: [{ item: "Tokens", judgment: "unverifiable", explanation: "No further evidence.", evidence: [] }],
							recommendations: [], confidence: 0.8,
						} };
					},
				};
				const makeAuditor = () => createAuditor({ paths, config: loadConfig({ paths, env }).config, clock: { now: () => tickMs }, runner, env });
				let auditor = makeAuditor();
				t.after(async () => {
					await Promise.all([ui.close(), auditor.close()]);
					fs.rmSync(dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				for (const response of [await postAt(port, "/api/audit", { sessionId }), await getAt(port, `/api/session?id=${sessionId}`), await getAt(port, `/api/diagnose?id=${sessionId}`)]) {
					assert.deepEqual([response.status, response.body.error], [409, "ambiguous-session"]);
				}
				assert.equal(fs.existsSync(paths.health.auditRequestsDir), false);
				assert.equal(fs.existsSync(paths.health.auditBudgetFile), false);
				const open = (row) => getAt(port, `/api/session?id=${sessionId}&row=${expectedSelector(row)}`);
				for (const [i, row] of rows.entries()) {
					const selected = await open(row);
					assert.equal(selected.status, 200);
					assert.equal(selected.body.tokens.total, (i + 1) * 17);
					assert.deepEqual(selected.body.tokens.models.map(({ key }) => key), [models[i]]);
					assert.deepEqual(selected.body.health.messages.map((message) => message.text), [`project ${i}`]);
					const posted = await postAt(port, "/api/audit", { sessionId, row: expectedSelector(row) });
					assert.deepEqual([posted.status, posted.body.audit?.planned?.model], [202, models[1 - i]]);
					auditor.tick(tickMs);
					await auditor.preparing();
					auditor.tick(tickMs);
					const start = starts[i];
					assert.ok(start, JSON.stringify(readAuditState(paths, subjectOf(row))));
					const bundle = JSON.parse(fs.readFileSync(path.join(start.cwd, "bundle.md"), "utf8").split("\n").find((line) => line.startsWith('{"session":')));
					assert.equal(bundle.tokens.total, (i + 1) * 17);
					assert.deepEqual(bundle.omo_health_record.messages.map((message) => message.ms), [nowMs - 100 + i]);
					tickMs += ANALYST_POLL_MS;
					auditor.tick(tickMs);
				}
				await auditor.close();
				auditor = makeAuditor();
				assert.equal(auditor.busy(), false);
				for (const [i, row] of rows.entries()) {
					const state = (await open(row)).body.audit.state;
					assert.deepEqual([state.status, state.projectKey, state.result?.summary], ["done", projectKeyOf(row.cwd), summaries[i]], state.detail ?? state.reason);
				}
			});

			it("plan86: a redacted display ID still opens and queues an audit for the exact ledger ID", async (t) => {
				const sessionId = "ghp_review1234";
				const world = makeWorld({ sessionId, total: 37 });
				const { paths, env, now } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => uiState({ paths, env, now: now() }), sessionDetail: world.detail, startAudit: world.startAudit, now });
				t.after(async () => {
					await Promise.all([ui.close(), world.detail.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				const state = await getAt(port, "/api/state");
				const row = state.body.ended.rows.find((entry) => entry.sessionId === sessionId);
				const detailUrl = `/api/session?id=${encodeURIComponent(row.sessionId)}`;
				const detail = await getAt(port, detailUrl);
				const posted = await postAt(port, "/api/audit", { sessionId: row.sessionId });
				assert.deepEqual(
					[detail.status, detail.body.id, detail.body.tokens?.total, detail.body.audit?.blocked, posted.status],
					[200, sessionId, 37, null, 202],
				);
				assert.equal(row.sessionShort, "ghp_[REDACTED]");
				assert.equal(row.title, "ghp_[REDACTED]");
				assert.equal(detail.body.session.sessionId, "ghp_[REDACTED]");
				assert.equal(posted.body.audit.sessionId, sessionId);
				const name = `${createHash("sha256").update(subjectKey(sub(sessionId, world.dir))).digest("hex").slice(0, 32)}.json`;
				assert.deepEqual(fs.readdirSync(paths.health.auditRequestsDir), [name]);
				assert.equal(JSON.parse(fs.readFileSync(path.join(paths.health.auditRequestsDir, name), "utf8")).sessionId, sessionId);
				const queued = await getAt(port, detailUrl);
				assert.deepEqual([queued.body.audit.state.sessionId, queued.body.audit.state.status], [sessionId, "queued"]);
			});

			for (const length of [81, 300]) {
				it(`${length === 300 ? "plan79" : "plan78"}: ${length}-character history ID opens and ${length === 300 ? "completes an audit for" : "queues"} that exact session`, async (t) => {
					const sessionId = "x".repeat(length - 1) + "Z";
					const world = makeWorld({ sessionId });
					const { paths, env, now } = world;
					const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now });
					const starts = [];
					const result = {
						overall: "sound",
						summary: "토큰 사용과 점검이 모두 적절했습니다.",
						tokens: { judgment: "normal", explanation: "정상 범위입니다." },
						checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
						recommendations: [],
						confidence: 0.8,
					};
					let nowMs = now();
					const runner = {
						start(options) {
							starts.push(options);
							return { jobId: options.jobId, pid: 5000 };
						},
						poll(jobId) {
							assert.equal(jobId, starts[0].jobId);
							return { status: "done", result, exitCode: 0 };
						},
					};
					const auditor = createAuditor({ paths, config: loadConfig({ paths, env }).config, clock: { now: () => nowMs }, runner, env });
					t.after(async () => {
						await Promise.all([ui.close(), world.detail.close(), auditor.close()]);
						fs.rmSync(world.dir, { recursive: true, force: true });
					});
					const { port } = await ui.listen();
					const detail = await getAt(port, `/api/session?id=${sessionId}`);
					const posted = await postAt(port, "/api/audit", { sessionId });
					assert.deepEqual([detail.status, posted.status], [200, 202]);
					assert.equal(detail.body.session.sessionId, sessionId);
					assert.equal(posted.body.audit.sessionId, sessionId);
					auditor.tick(now());
					const state = readAuditState(paths, sub(sessionId, world.dir));
					assert.deepEqual([state?.status, state?.sessionId], ["queued", sessionId]);
					assert.deepEqual(fs.readdirSync(paths.health.auditRequestsDir), []);
					if (length !== 300) return;

					await auditor.preparing();
					auditor.tick(nowMs);
					const running = readAuditState(paths, sub(sessionId, world.dir));
					assert.equal(running.status, "running", running.detail ?? running.reason);
					assert.equal(starts.length, 1);
					assert.equal(starts[0].jobId, running.jobId);
					const bundleFile = path.join(starts[0].cwd, "bundle.md");
					assert.ok(starts[0].args.includes(`@${bundleFile}`));
					const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8").split("\n").find((line) => line.startsWith('{"session":')));
					assert.equal(bundle.session.sessionId, sessionId);

					nowMs += ANALYST_POLL_MS;
					auditor.tick(nowMs);
					const done = readAuditState(paths, sub(sessionId, world.dir));
					assert.deepEqual([done.status, done.sessionId, done.result?.overall], ["done", sessionId, "sound"]);
				});
			}

			for (const length of [121, 256]) {
				it(`plan82: an accounted ${length}-character model key previews and completes an independent audit`, async (t) => {
					const provider = "anthropic";
					const model = "x".repeat(length - provider.length - 1);
					const key = `${provider}/${model}`;
					const reviewer = "openai/gpt-review:high";
					const world = makeWorld({
						lanes: { ultrabrain: [key], architect: [reviewer] },
						entries: [E.assistant({ provider, model, ms: Date.parse("2026-11-21T23:59:59.500Z"), usage: { input: 4, output: 1 } })],
					});
					const { paths, env, now, sessionFile } = world;
					const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now });
					const starts = [];
					let nowMs = now();
					const runner = {
						start(options) {
							starts.push(options);
							return { jobId: options.jobId, pid: 5000 };
						},
						poll() {
							return { status: "done", exitCode: 0, result: {
								overall: "sound",
								summary: "토큰 사용과 점검이 모두 적절했습니다.",
								tokens: { judgment: "normal", explanation: "정상 범위입니다." },
								checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
								recommendations: [],
								confidence: 0.8,
							} };
						},
					};
					const auditor = createAuditor({ paths, config: loadConfig({ paths, env }).config, clock: { now: () => nowMs }, runner, env });
					t.after(async () => {
						await Promise.all([ui.close(), world.detail.close(), auditor.close()]);
						fs.rmSync(world.dir, { recursive: true, force: true });
					});

					// Replace the fixture's seeded index row with one produced by accounting.
					fs.unlinkSync(paths.health.usageIndexFile);
					const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
					index.update(sub(AUDIT_ID, world.dir), sessionFile, { kind: "main" });
					const { models, usedModels, modelsIncomplete } = index.get(subjectKey(sub(AUDIT_ID, world.dir))).published;
					assert.deepEqual([Object.keys(models), Object.keys(usedModels), modelsIncomplete], [[key], [key], false]);
					index.save();

					const { port } = await ui.listen();
					const detail = await getAt(port, `/api/session?id=${AUDIT_ID}`);
					assert.deepEqual([detail.status, detail.body.audit.blocked, detail.body.audit.planned?.model], [200, null, reviewer]);
					const posted = await postAt(port, "/api/audit", { sessionId: AUDIT_ID });
					assert.deepEqual([posted.status, posted.body.audit?.planned?.model], [202, reviewer]);
					auditor.tick(nowMs);
					await auditor.preparing();
					auditor.tick(nowMs);
					const running = readAuditState(paths, sub(AUDIT_ID, world.dir));
					assert.equal(running.status, "running", running.detail ?? running.reason);
					assert.equal(starts.length, 1);
					assert.equal(starts[0].args[starts[0].args.indexOf("--model") + 1], reviewer);
					const bundleFile = path.join(starts[0].cwd, "bundle.md");
					assert.ok(starts[0].args.includes(`@${bundleFile}`));
					const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8").split("\n").find((line) => line.startsWith('{"session":')));
					assert.deepEqual(bundle.tokens.models.map(({ key }) => key), [key]);
					assert.deepEqual(bundle.tokens.topTurns.map(({ key }) => key), [key]);

					nowMs += ANALYST_POLL_MS;
					auditor.tick(nowMs);
					const done = readAuditState(paths, sub(AUDIT_ID, world.dir));
					assert.deepEqual([done.status, done.model, done.result?.overall], ["done", reviewer, "sound"]);
				});
			}

			it("plan79: COM1 history accepts audit requests but COM1/.. writes no file", async (t) => {
				const sessionId = "COM1";
				const world = makeWorld({ sessionId });
				const { paths, now } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now });
				t.after(async () => {
					await Promise.all([ui.close(), world.detail.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				const invalidId = "COM1/..";
				const invalid = { status: 422, body: { error: "invalid" } };
				assert.deepEqual(await getAt(port, `/api/session?id=${encodeURIComponent(invalidId)}`), invalid);
				assert.deepEqual(await postAt(port, "/api/audit", { sessionId: invalidId }), invalid);
				for (const dir of [paths.health.auditRequestsDir, paths.health.auditsDir]) {
					assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], dir);
				}
				const detail = await getAt(port, `/api/session?id=${sessionId}`);
				const posted = await postAt(port, "/api/audit", { sessionId });
				assert.deepEqual([detail.status, posted.status], [200, 202]);
				assert.equal(detail.body.session.sessionId, sessionId);
				assert.equal(posted.body.audit.sessionId, sessionId);
				assert.deepEqual(fs.readdirSync(paths.health.auditRequestsDir), [`${auditFileKey(sub(sessionId, world.dir))}.json`]);
			});

			it("plan78: the dashboard shows each case-distinct row its own saved verdict", async (t) => {
				const ids = ["Review.1", "review.1"];
				const summaries = ["Uppercase verdict", "Lowercase verdict"];
				const world = makeWorld({ sessionId: ids[0] });
				const { paths, now } = world;
				appendEnded(paths, { sessionId: ids[1], kind: "main", outcome: "answered", endedMs: now() }, { nowMs: now() });
				for (const [i, id] of ids.entries()) {
					assert.equal(requestAudit(paths, sub(id, id === ids[0] ? world.dir : null), now()).created, true);
					const [name] = fs.readdirSync(paths.health.auditRequestsDir);
					fs.unlinkSync(path.join(paths.health.auditRequestsDir, name));
					writeJson(path.join(paths.health.auditsDir, name), {
						v: 1, ...sub(id, id === ids[0] ? world.dir : null), status: "done", result: { overall: "sound", summary: summaries[i] },
					});
				}
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now });
				t.after(async () => {
					await Promise.all([ui.close(), world.detail.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				const replies = await Promise.all(ids.map((id) => getAt(port, `/api/session?id=${id}`)));
				assert.deepEqual(replies.map(({ status, body }) => [status, body.session?.sessionId, body.audit?.state?.sessionId, body.audit?.state?.result?.summary]),
					ids.map((id, i) => [200, id, id, summaries[i]]));
			});

			it("plan77: dotted history opens and queues an audit without accepting unsafe IDs", async (t) => {
				const sessionId = "review.1";
				const world = makeWorld({ sessionId });
				const { paths, env, now } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now });
				t.after(async () => {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				const invalid = { status: 422, body: { error: "invalid" } };
				for (const id of ["..", ".", "../x", "a/b", "a\\b", "%2e%2e", "x.", "review ", "review\0x", "review\n", "x".repeat(1025)]) {
					assert.deepEqual(await getAt(port, `/api/session?id=${encodeURIComponent(id)}`), invalid, JSON.stringify(id));
					assert.deepEqual(await postAt(port, "/api/audit", { sessionId: id }), invalid, JSON.stringify(id));
				}
				assert.deepEqual(await getAt(port, "/api/session?id=%2e%2e"), invalid, "reject decoded dot segments");
				assert.equal(fs.existsSync(paths.health.auditsDir), false, "unsafe requests write no audit artifacts");

				const detail = await getAt(port, `/api/session?id=${encodeURIComponent(sessionId)}`);
				const posted = await postAt(port, "/api/audit", { sessionId });
				assert.deepEqual([detail.status, posted.status], [200, 202], "detail and audit must accept the same Senpi ID");
				assert.equal(detail.body.session.sessionId, sessionId);
				assert.equal(posted.body.audit.sessionId, sessionId);
				assert.equal(readAuditState(paths, sub(sessionId, world.dir)).status, "requested");
				const auditor = createAuditor({ paths, config: loadConfig({ paths, env }).config, clock: { now }, runner: {}, env });
				try {
					auditor.tick(now());
					assert.deepEqual(fs.readdirSync(paths.health.auditRequestsDir), []);
					const record = readAuditState(paths, sub(sessionId, world.dir));
					assert.deepEqual([record.sessionId, record.status], [sessionId, "queued"]);
				} finally {
					await auditor.close();
				}
			});

			it("plan88: a history row with an older same-ID project selects its own detail, page, and audit", async (t) => {
				const sessionId = "review.1";
				const world = makeWorld({ sessionId, total: 17 });
				const { paths, env, now } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => uiState({ paths, env, now: now() }),
					sessionDetail: world.detail, startAudit: world.startAudit, diagnose: () => assert.fail("ambiguous ID reached diagnosis"), now });
				const starts = [];
				const auditor = createAuditor({ paths, env, clock: { now }, config: loadConfig({ paths, env }).config,
					runner: { start(job) { starts.push(job); return { jobId: job.jobId, pid: 5000 }; } } });
				t.after(async () => {
					await Promise.all([ui.close(), world.detail.close(), auditor.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const oldCwd = path.join(world.dir, "old-project");
				const oldEnd = now() - 31 * 86_400_000;
				assert.equal(appendEnded(paths, { sessionId, cwd: oldCwd, kind: "main",
					startedMs: oldEnd - 1000, endedMs: oldEnd }, { nowMs: now() }), true);
				assert.equal(readEnded(paths).filter((row) => row.sessionId === sessionId).length, 2);
				for (let i = 0; i <= 50; i++) {
					appendEnded(paths, { sessionId: `child-${i}`, parentSessionId: sessionId, parentProjectKey: projectKeyOf(world.dir), kind: "child", cwd: world.dir,
						startedMs: now() - 900, endedMs: now() - 100 + i }, { nowMs: now() });
				}
				const { port } = await ui.listen();
				const { status: stateStatus, body: state } = await getAt(port, "/api/state");
				assert.equal(stateStatus, 200);
				const history = state.ended.rows.filter((row) => row.sessionId === sessionId);
				assert.equal(history.length, 1);
				const [row] = history;
				assert.equal(Object.hasOwn(row, "detailRow"), false);

				const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
				const urlOf = runInNewContext(`(${app.match(/function endedDetailUrl\([^]*?\n\t\}/)[0]})`);
				const url = urlOf(row);
				const bareUrl = `/api/session?id=${sessionId}`;
				for (const { status, body } of [
					await getAt(port, bareUrl),
					await getAt(port, `/api/diagnose?id=${sessionId}`),
					await postAt(port, "/api/audit", { sessionId }),
				]) assert.deepEqual([status, body.error], [409, "ambiguous-session"]);
				auditor.tick(now());
				assert.equal(starts.length, 0);
				assert.equal(fs.existsSync(paths.health.auditRequestsDir), false);
				assert.equal(fs.existsSync(paths.health.auditBudgetFile), false);
				const { status, body } = await getAt(port, url);
				assert.deepEqual([status, body.tokens?.total, body.counts?.children, body.children?.length], [200, 17, 51, 50]);
				const selector = expectedSelector({ sessionId, cwd: world.dir, endedMs: now() });
				assert.equal(url, `${bareUrl}&row=${selector}`, `opening ${url} returned HTTP ${status}; history must send the row selector`);
				const page = await getAt(port, `${url}&list=children&offset=${body.children.length}`);
				assert.deepEqual([page.status, page.body.list, page.body.offset, page.body.total, page.body.items?.map((item) => item.sessionId)],
					[200, "children", 50, 51, ["child-0"]]);
				const posted = await postAt(port, "/api/audit", { sessionId, row: row.rowSelector });
				assert.deepEqual([posted.status, posted.body.audit?.status], [202, "queued"]);
				assert.ok(fs.existsSync(path.join(paths.health.auditRequestsDir, `${auditFileKey(sub(sessionId, world.dir))}.json`)));
				auditor.tick(now());
				await auditor.preparing();
				auditor.tick(now());
				assert.equal(starts.length, 1, JSON.stringify(readAuditState(paths, sub(sessionId, world.dir))));
				assert.equal(readAuditState(paths, sub(sessionId, world.dir)).status, "running");
				assert.equal(readAuditState(paths, sub(sessionId, oldCwd)), null);

				// A twin inside the server's lookup window still makes a bare ID ambiguous.
				assert.equal(appendEnded(paths, { sessionId, cwd: oldCwd, kind: "main",
					startedMs: now() - 3000, endedMs: now() - 2000 }, { nowMs: now() }), true);
				const ambiguous = await getAt(port, bareUrl);
				assert.deepEqual([ambiguous.status, ambiguous.body.error], [409, "ambiguous-session"]);
				const bareAudit = await postAt(port, "/api/audit", { sessionId });
				assert.deepEqual([bareAudit.status, bareAudit.body.error], [409, "ambiguous-session"]);
			});

			it("plan95: a live twin makes every bare-ID route ambiguous before it ends", async (t) => {
				const sessionId = "review.1";
				const { dir, paths, now, nowMs, detail, startAudit } = makeWorld({ sessionId, total: 17 });
				const ended = sub(sessionId, dir);
				const liveTwin = sub(sessionId, path.join(dir, "live-project"));
				let diagnoses = 0;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: detail, startAudit,
					diagnose: (id) => { diagnoses++; return { id }; }, now });
				t.after(async () => {
					await ui.close();
					fs.rmSync(dir, { recursive: true, force: true });
				});
				const setOwner = (owner) => writeJson(paths.health.sessionsSnapshotFile,
					{ v: 1, ts: nowMs, groups: [], liveOwners: [owner] });
				const { port } = await ui.listen();
				const bareUrl = `/api/session?id=${sessionId}`;
				const diagnoseUrl = `/api/diagnose?id=${sessionId}`;

				setOwner(ended);
				const sameOwner = await getAt(port, bareUrl);
				assert.deepEqual([sameOwner.status, sameOwner.body.tokens?.total], [200, 17]);
				assert.deepEqual(await getAt(port, diagnoseUrl), { status: 200, body: { id: sessionId } });

				// Only the live-owner list changes; the ended ledger and cached detail key do not.
				setOwner(liveTwin);
				assert.deepEqual(readEnded(paths).filter((row) => row.sessionId === sessionId).map(subjectOf), [ended]);
				const replies = {
					detail: await getAt(port, bareUrl),
					diagnose: await getAt(port, diagnoseUrl),
					audit: await postAt(port, "/api/audit", { sessionId }),
				};
				assert.deepEqual(Object.fromEntries(Object.entries(replies).map(([route, { status, body }]) => [route, [status, body.error]])), {
					detail: [409, "ambiguous-session"], diagnose: [409, "ambiguous-session"], audit: [409, "ambiguous-session"],
				});
				assert.equal(diagnoses, 1);
				assert.equal(fs.existsSync(paths.health.auditRequestsDir), false);
				assert.equal(fs.existsSync(paths.health.auditBudgetFile), false);

				const row = expectedSelector({ sessionId, cwd: dir, endedMs: nowMs });
				const selected = await getAt(port, `${bareUrl}&row=${row}`);
				assert.deepEqual([selected.status, selected.body.tokens?.total], [200, 17]);
				const posted = await postAt(port, "/api/audit", { sessionId, row });
				assert.deepEqual([posted.status, posted.body.audit?.status], [202, "queued"]);
				const requests = fs.readdirSync(paths.health.auditRequestsDir);
				assert.deepEqual(requests, [`${auditFileKey(ended)}.json`]);
				assert.deepEqual(subjectOf(JSON.parse(fs.readFileSync(path.join(paths.health.auditRequestsDir, requests[0]), "utf8"))), ended);
			});

			it("plan92: a live twin's finding is withheld in cached detail and the daemon audit bundle before it ends", async (t) => {
				const sessionId = "review.1";
				const world = makeWorld({ sessionId, total: 17 });
				const { paths, env, now, nowMs, dir } = world;
				const starts = [];
				const auditor = createAuditor({ paths, env, clock: { now }, config: loadConfig({ paths, env }).config,
					runner: { start(job) { starts.push(job); return { jobId: job.jobId, pid: 5000 }; } } });
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, startAudit: world.startAudit, now });
				t.after(async () => {
					await Promise.all([ui.close(), auditor.close()]);
					fs.rmSync(dir, { recursive: true, force: true });
				});
				appendDecision(paths, { ts: new Date(nowMs).toISOString(), event: "opened", detector: "D1", severity: "warn",
					fp: "live-twin-finding", subject: { sessionId } });
				const { port } = await ui.listen();
				const row = expectedSelector({ sessionId, cwd: dir, endedMs: nowMs });
				const detail = () => getAt(port, `/api/session?id=${sessionId}&row=${row}`);
				assert.deepEqual((await detail()).body.health.findings.map(({ fp }) => fp), ["live-twin-finding"]);

				const cwd = path.join(dir, "live-project");
				writeJson(paths.health.sessionsSnapshotFile, { v: 1, ts: nowMs, groups: [{ sessions: [{ sessionId, cwd }] }] });
				assert.equal(readEnded(paths).filter((entry) => entry.sessionId === sessionId).length, 1);
				const { status, body } = await detail();
				const withheld = { findings: 1, actions: 0, verdicts: 0, investigations: 0 };
				assert.equal(status, 200);
				assert.deepEqual(body.health.findings, []);
				assert.deepEqual(body.truncated.unattributedHealth, withheld);
				assert.equal((await postAt(port, "/api/audit", { sessionId, row })).status, 202);
				auditor.tick(now());
				await auditor.preparing();
				auditor.tick(now());
				assert.equal(starts.length, 1, JSON.stringify(readAuditState(paths, sub(sessionId, dir))));
				const bundle = JSON.parse(fs.readFileSync(path.join(starts[0].cwd, "bundle.md"), "utf8").split("\n").find((line) => line.startsWith('{"session":')));
				assert.deepEqual(bundle.omo_health_record.findings, []);
				assert.equal(bundle.truncated.findings, true);
				assert.deepEqual(bundle.truncated.unattributedHealth, withheld);
			});

			it("plan87: same-ID projects get separate transcript bundles and audit results after restart", async (t) => {
				const sessionId = "review.1";
				const models = ["openai/project-a", "openai/project-b"];
				const totals = [17, 29];
				const world = makeWorld({ sessionId, lanes: { ultrabrain: [models[0]], architect: [models[1]] } });
				const { paths, env, now } = world;
				const cwds = [world.dir, path.join(world.dir, "project-b")];
				const ui = createUiServer({ paths, token: TOKEN, getState: () => uiState({ paths, env, now: now() }),
					sessionDetail: world.detail, startAudit: world.startAudit, diagnose: () => ({ ok: true }), now });
				let tickMs = now();
				let auditor;
				t.after(async () => {
					await Promise.all([ui.close(), auditor?.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				fs.unlinkSync(paths.health.usageIndexFile);
				const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
				const subjects = cwds.map((cwd) => sub(sessionId, cwd));
				for (const [i, cwd] of cwds.entries()) {
					const file = i === 0 ? world.sessionFile : path.join(paths.sessionsDir, projectKeyOf(cwd), `2026-11-22T00-00-00-000Z_${sessionId}.jsonl`);
					writeJsonl(file, [E.header(sessionId, cwd, now() - 1000),
						E.assistant({ provider: "openai", model: models[i].split("/")[1], ms: now() - 500, usage: { input: totals[i], output: 0 } })]);
					index.update(subjects[i], file, { kind: "main" });
					if (i) appendEnded(paths, { sessionId, cwd, kind: "main", startedMs: now() - 1000, endedMs: now(), outcome: "answered" }, { nowMs: now() });
					appendEnded(paths, { sessionId: `child-${i}`, parentSessionId: sessionId, parentProjectKey: projectKeyOf(cwd), taskId: `st_child_${i}`, cwd,
						kind: "child", startedMs: now() - 800, endedMs: now() - 400 }, { nowMs: now() });
				}
				const unique = "unique-review";
				const uniqueFile = path.join(paths.sessionsDir, projectKeyOf(cwds[0]), `2026-11-22T00-00-00-000Z_${unique}.jsonl`);
				writeJsonl(uniqueFile, [E.header(unique, cwds[0], now() - 1000),
					E.assistant({ provider: "openai", model: "project-a", ms: now() - 500, usage: { input: 1, output: 0 } })]);
				index.update(sub(unique, cwds[0]), uniqueFile, { kind: "main" });
				appendEnded(paths, { sessionId: unique, cwd: cwds[0], kind: "main", startedMs: now() - 1000, endedMs: now() }, { nowMs: now() });
				index.save();
				const { port } = await ui.listen();
				const ambiguous = { status: 409, body: { error: "ambiguous-session", reasonKo: "같은 id의 세션이 여러 프로젝트에 있어 고를 수 없습니다" } };
				assert.deepEqual(await postAt(port, "/api/audit", { sessionId }), ambiguous);
				assert.deepEqual(await getAt(port, `/api/session?id=${sessionId}`), ambiguous);
				assert.deepEqual(await getAt(port, `/api/diagnose?id=${sessionId}`), ambiguous);
				assert.equal((await getAt(port, `/api/diagnose?id=${unique}`)).status, 200);
				assert.equal(fs.existsSync(paths.health.auditRequestsDir), false);
				assert.equal(fs.existsSync(paths.health.auditBudgetFile), false);
				const { body: state } = await getAt(port, "/api/state");
				const rows = totals.map((total) => state.ended.rows.find((row) => row.sessionId === sessionId && row.tokens?.total === total));
				assert.ok(rows.every((row) => /^[0-9a-f]{16}$/.test(row?.detailRow)));
				const urls = rows.map(({ detailRow }) => `/api/session?id=${sessionId}&row=${detailRow}`);
				for (const [i, { detailRow }] of rows.entries()) {
					const { status, body } = await getAt(port, urls[i]);
					assert.deepEqual([status, body.tokens?.total, body.tokens?.models.map(({ key }) => key), body.children?.map(({ sessionId }) => sessionId)],
						[200, totals[i], [models[i]], [`child-${i}`]]);
					const posted = await postAt(port, "/api/audit", { sessionId, row: detailRow });
					assert.deepEqual([posted.status, posted.body.audit?.planned?.model], [202, models[1 - i]]);
					tickMs += 1;
				}
				const calls = [];
				const summaries = ["첫 프로젝트 조사 결과", "두 번째 프로젝트 조사 결과"];
				const runner = {
					start(job) {
						calls.push(job);
						return { jobId: job.jobId, pid: 5000 + calls.length };
					},
					poll(jobId) {
						const i = calls.findIndex((job) => job.jobId === jobId);
						return { status: "done", exitCode: 0, result: {
							overall: "sound", summary: summaries[i], tokens: { judgment: "normal", explanation: "정상 범위입니다." },
							checks: [{ item: "토큰", judgment: "unverifiable", explanation: "자료가 부족합니다.", evidence: [] }],
							recommendations: [], confidence: 0.8,
						} };
					},
				};
				const openAuditor = () => createAuditor({ paths, config: loadConfig({ paths, env }).config, clock: { now: () => tickMs }, runner, env });
				auditor = openAuditor();
				// Requests were made at the same injected time; their disk order is deliberately irrelevant.
				const byReviewer = new Map(models.map((model, i) => [model, 1 - i]));
				const resultForSubject = [];
				for (let n = 0; n < 2; n++) {
					auditor.tick(tickMs);
					await auditor.preparing();
					auditor.tick(tickMs);
					const job = calls[n];
					assert.ok(job, JSON.stringify(subjects.map((subject) => readAuditState(paths, subject))));
					const i = byReviewer.get(job.args[job.args.indexOf("--model") + 1]);
					const bundle = JSON.parse(fs.readFileSync(path.join(job.cwd, "bundle.md"), "utf8").split("\n").find((line) => line.startsWith('{"session":')));
					assert.deepEqual(bundle.tokens.topTurns.map(({ key }) => key), [models[i]]);
					assert.deepEqual(bundle.children.map(({ sessionId }) => sessionId), [`child-${i}`]);
					resultForSubject[i] = summaries[n];
					tickMs += ANALYST_POLL_MS;
					auditor.tick(tickMs);
				}
				await auditor.close();
				auditor = openAuditor();
				auditor.tick(tickMs);
				assert.equal(calls.length, 2, "completed audits are not relaunched on daemon restart");
				for (const [i, url] of urls.entries()) {
					const { status, body } = await getAt(port, url);
					assert.deepEqual([status, body.audit?.state?.status, body.audit?.state?.result?.summary],
						[200, "done", resultForSubject[i]]);
				}
				assert.notEqual(resultForSubject[0], resultForSubject[1]);
				const resultFiles = subjects.map((subject) => path.join(paths.health.auditsDir, `${auditFileKey(subject)}.json`));
				fs.copyFileSync(resultFiles[1], resultFiles[0]);
				assert.equal(readAuditState(paths, subjects[0]), null, "a result with the wrong stored project is never read");
				assert.equal(readAuditState(paths, subjects[1])?.result.summary, resultForSubject[1]);
				assert.equal((await postAt(port, "/api/audit", { sessionId: unique })).status, 202);
			});

			it("IS-4 keeps state responsive across bounded worker replies for a large detail and every next page", async (t) => {
				const totals = { children: 51, findings: 5_000, actions: 5_000, investigations: 51, messages: 20_000 };
				const timestamp = (i) => new Date(Date.UTC(2026, 10, 22) - totals.messages + i).toISOString();
				const world = makeWorld({ entries: Array.from({ length: totals.messages }, (_, i) => ({
					type: "custom_message", customType: "omo-health", timestamp: timestamp(i), content: `notice ${i}`,
				})) });
				const { paths, env, now } = world;
				const worker = createDetailWorker({ paths, env });
				let onDispatch;
				const replies = [];
				const detail = createSessionDetail({
					paths, env, now,
					worker: {
						async run(job) {
							const reply = worker.run(job);
							const proceed = onDispatch();
							const [result] = await Promise.all([reply, proceed]);
							replies.push(result);
							return result;
						},
						close: worker.close,
					},
				});
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: detail, now });
				t.after(async () => {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const subject = { sessionId: AUDIT_ID };
				writeJsonl(path.join(paths.health.decisionsDir, "2026-11-21.jsonl"), Array.from({ length: totals.findings }, (_, i) => ({
					event: "opened", fp: `finding-${i}`, detector: "D8", kind: "dead-child", severity: "warn",
					subject, ts: timestamp(i), action: { kind: "kill" }, result: "execute",
				})));
				for (let i = 0; i < totals.children; i++) {
					appendEnded(paths, { sessionId: `s_child${i}`, kind: "child", parentSessionId: AUDIT_ID, outcome: "answered", endedMs: now() }, { nowMs: now() });
				}
				for (let i = 0; i < totals.investigations; i++) {
					const id = `inv-${i}`;
					writeJson(path.join(paths.health.investigationsDir, `${id}.json`), { id, subject, openedMs: Date.parse(timestamp(i)), status: "open" });
				}
				const { port } = await ui.listen();
				const url = `/api/session?id=${AUDIT_ID}`;
				async function getWhilePollingState(query = "") {
					const dispatched = Promise.withResolvers();
					const stateAnswered = Promise.withResolvers();
					onDispatch = () => {
						dispatched.resolve();
						return stateAnswered.promise;
					};
					let inFlight = true;
					const pending = getAt(port, `${url}${query}`, AbortSignal.timeout(10_000)).finally(() => { inFlight = false; });
					try {
						await Promise.race([dispatched.promise, pending.then(() => assert.fail("detail completed without dispatching a worker job"))]);
						const started = performance.now();
						assert.equal(inFlight, true, `${query}: detail in flight before polling state`);
						const state = await getAt(port, "/api/state", AbortSignal.timeout(1_000));
						const elapsed = performance.now() - started;
						assert.equal(inFlight, true, `${query}: state answered before the detail completed`);
						assert.deepEqual(state, { status: 200, body: STATE });
						assert.ok(elapsed < 1_000, `${query}: /api/state took ${elapsed.toFixed(1)} ms`);
					} finally {
						stateAnswered.resolve();
					}
					return pending;
				}

				const first = await getWhilePollingState();
				assert.equal(first.status, 200);
				assert.deepEqual(first.body.counts, totals);
				const listOf = (record, name) => name === "children" ? record.children : record.health[name];
				for (const [name, total] of Object.entries(totals)) {
					assert.equal(listOf(first.body, name).length, 50);
					const page = await getWhilePollingState(`&list=${name}&offset=50`);
					assert.deepEqual([page.status, page.body.list, page.body.offset, page.body.total, page.body.items.length],
						[200, name, 50, total, Math.min(total - 50, 50)]);
					assert.notDeepEqual(page.body.items[0], listOf(first.body, name)[0], `${name}: different page`);
					if (name === "messages") assert.equal(page.body.items[0].text, `notice ${total - 51}`);
				}
				const [firstReply, ...pageReplies] = replies;
				assert.deepEqual(Object.fromEntries(Object.keys(totals).map((name) => [name, listOf(firstReply.record, name).length])),
					Object.fromEntries(Object.keys(totals).map((name) => [name, 50])), "items that crossed the worker boundary");
				assert.deepEqual(firstReply.record.counts, totals, "whole-list totals cross the worker boundary");
				for (const [i, [name, total]] of Object.entries(totals).entries()) {
					assert.deepEqual(Object.keys(pageReplies[i].page).sort(), ["items", "list", "offset", "total"]);
					assert.equal(pageReplies[i].record, undefined, `${name}: no record accompanies the worker's list page`);
					assert.equal(pageReplies[i].page.items.length, Math.min(total - 50, 50));
				}
			});

			it("IS-4 / IS-7: cold History detail opens only the selected session tree's transcripts", async (t) => {
				const selected = "selected";
				const world = makeWorld({ sessionId: selected });
				const { paths, env, now, nowMs, sessionFile } = world;
				const { port1, port2 } = new MessageChannel();
				const worker = new Worker(new URL("./helpers/observe-detail-worker.mjs", import.meta.url), {
					workerData: { paths, env, detailWorker: true, observed: port2 },
					transferList: [port2],
				});
				t.after(async () => {
					await worker.terminate();
					port1.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				});

				const child = "child";
				const taskId = "st_detail";
				const unindexed = "filename-match";
				const headerOnly = "unindexed-header";
				const message = (content) => ({ type: "custom_message", customType: "omo-health", timestamp: new Date(nowMs).toISOString(), content });
				const usage = (input) => ({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input }, stopReason: "stop" } });
				const dir = path.dirname(sessionFile);
				const childFile = path.join(dir, "custom-child.jsonl");
				const unindexedFile = path.join(dir, `2026-11-22T08-06-20-378Z_${unindexed}.jsonl`);
				appendJsonl(sessionFile, [message("selected message"), usage(42)]);
				writeJsonl(childFile, [{ type: "session", id: child }, message("child message"), usage(7)]);
				writeJsonl(unindexedFile, [{ type: "session", id: unindexed }, message("filename message")]);
				writeJsonl(path.join(dir, "custom-miss.jsonl"), [{ type: "session", id: headerOnly }, message("header-only message")]);
				for (let i = 0; i < 24; i++) {
					writeJsonl(path.join(dir, `custom-${i}.jsonl`), [{ type: "session", id: `unrelated-${i}` }]);
				}
				for (const row of [
					{ kind: "child", sessionId: child, taskId, parentSessionId: selected },
					{ kind: "main", sessionId: unindexed },
					{ kind: "main", sessionId: headerOnly },
				]) appendEnded(paths, { ...row, cwd: world.dir, endedMs: nowMs, outcome: "answered" }, { nowMs });
				fs.unlinkSync(paths.health.usageIndexFile);
				const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
				index.update(sub(selected, world.dir), sessionFile, { kind: "main" });
				index.update(sub(child, world.dir), childFile, { kind: "child", taskId, parentSessionId: selected });
				assert.equal(index.save(), true);

				async function open(id) {
					const reply = once(worker, "message");
					worker.postMessage({ kind: "detail", id, now: nowMs });
					const [{ result, error }] = await reply;
					assert.equal(error, undefined);
					const opened = new Set();
					for (let entry; (entry = receiveMessageOnPort(port1));) opened.add(entry.message);
					assert.equal(result.record.found, true);
					return { record: result.record, opened: [...opened].sort() };
				}
				const selectedDetail = await open(selected);
				assert.deepEqual(selectedDetail.record.health.messages.map(({ text }) => text).sort(), ["child message", "selected message"]);
				assert.deepEqual([selectedDetail.record.tokens.total, selectedDetail.record.tokens.treeTotal], [42, 49]);
				assert.deepEqual(selectedDetail.opened, [sessionFile, childFile].sort(), "the worker opened transcripts outside the selected tree");

				const fallback = await open(unindexed);
				assert.deepEqual(fallback.record.health.messages.map(({ text }) => text), ["filename message"]);
				assert.equal(fallback.record.tokens, null);
				assert.deepEqual(fallback.opened, [unindexedFile]);

				const missing = await open(headerOnly);
				assert.deepEqual(missing.record.health.messages, []);
				assert.equal(missing.record.tokens, null);
				assert.deepEqual(missing.opened, []);
			});

			it("IS-7 refreshes cached parent detail after a child-only transcript change", async (t) => {
				const world = makeWorld();
				const { paths, env, now, nowMs } = world;
				const childId = "s_cachechild";
				const taskId = "st_cachechild";
				const cwd = world.dir;
				appendEnded(paths, {
					sessionId: childId, taskId, kind: "child", parentSessionId: AUDIT_ID, cwd,
					startedMs: nowMs - 500, endedMs: nowMs, outcome: "answered",
				}, { nowMs });
				const childFile = writeTask(cwd, { task_id: taskId, child_session_id: childId, status: "completed" }, [
					{ type: "session", id: childId, cwd },
				]);
				const reads = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
				const worker = createDetailWorker({
					paths, env,
					workerUrl: new URL("./helpers/observe-detail-worker.mjs", import.meta.url),
					workerData: { transcript: childFile, reads: reads.buffer },
				});
				const detail = createSessionDetail({ paths, env, now, worker });
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: detail, now });
				t.after(async () => {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				});
				const { port } = await ui.listen();
				const open = async () => {
					const { status, body } = await getAt(port, `/api/session?id=${AUDIT_ID}`);
					assert.equal(status, 200);
					assert.equal(body.session.sessionId, AUDIT_ID);
					assert.equal(body.children[0]?.sessionId, childId);
					assert.equal(JSON.stringify(body).includes(JSON.stringify(childFile).slice(1, -1)), false, "no transcript path in the response");
					return body.health.messages.map(({ recipient, text }) => [recipient, text]);
				};
				assert.deepEqual(await open(), []);
				const initialReads = Atomics.load(reads, 0);
				assert.ok(initialReads > 0, "instrumentation observed the child transcript load");
				assert.deepEqual(await open(), []);
				assert.equal(Atomics.load(reads, 0), initialReads, "an unchanged reopen does not load the record");

				const message = { type: "custom_message", customType: "omo-health", timestamp: new Date(nowMs).toISOString(), content: "delivered to child" };
				appendJsonl(childFile, [message]);
				const mtime = nowMs / 1000;
				fs.utimesSync(childFile, mtime, mtime);
				assert.deepEqual(await open(), [[childId, message.content]], "child-only append must refresh the parent's messages");
				const refreshedReads = Atomics.load(reads, 0);
				assert.ok(refreshedReads > initialReads, "the append invalidated the cache");
				assert.deepEqual(await open(), [[childId, message.content]]);
				assert.equal(Atomics.load(reads, 0), refreshedReads, "the refreshed record is cached");

				const original = fs.statSync(childFile);
				const replacement = `${childFile}.tmp`;
				const text = "replaced child msg";
				fs.writeFileSync(replacement, fs.readFileSync(childFile, "utf8").replace(message.content, text));
				fs.utimesSync(replacement, mtime, mtime);
				fs.renameSync(replacement, childFile);
				const replaced = fs.statSync(childFile);
				assert.deepEqual([replaced.size, replaced.mtimeMs], [original.size, original.mtimeMs]);
				assert.notDeepEqual([replaced.ino, replaced.birthtimeMs], [original.ino, original.birthtimeMs]);
				assert.deepEqual(await open(), [[childId, text]], "same-size, same-mtime child replacement must also refresh");
				assert.ok(Atomics.load(reads, 0) > refreshedReads, "the replacement invalidated the cache");
			});

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
					index.update(subjectOf(a), files[0], { kind: "child", taskId: a.taskId });
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
					index.update(sub(taskId, children[0].cwd), files[0], { kind: "child", taskId });
					assert.equal(index.fresh(index.get(subjectKey(sub(taskId, children[0].cwd, taskId)))), true);
					assert.equal(index.has(subjectKey(subjectOf(children[1]))), false);
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
				index.update(sub(taskId, children[0].cwd), file, { kind: "child", taskId });
				index.save();
				return children;
			}

			it("(plan 34) task-only ledger collisions leave detail and reviewer facts unknown", async () => {
				const world = makeWorld();
				try {
					const [, selected] = writeTaskOnlyCollision(world);
					const { taskId } = selected;
					const selector = expectedSelector(selected);
					const detail = await world.detail(taskId, selector);
					const cached = await world.detail(taskId, selector);
					const [status, body] = await world.startAudit(taskId, selector);
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
					assert.equal((await get()).body.error, "ambiguous-session");
					assert.deepEqual(facts(await get(`&row=${expectedSelector(a)}`)), expect(a));
					assert.deepEqual(facts(await get(`&row=${expectedSelector(b)}`)), expect(b));
					assert.deepEqual(facts(await get(`&row=${expectedSelector(a)}`)), expect(a), "cached detail and preview");
					assert.equal((await get()).status, 409, "cached selections do not disambiguate a bare ID");
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

			it("(plan 90) batch append preserves shared parent and child IDs across projects in history and detail", async () => {
				const world = makeWorld();
				const { paths, now, nowMs } = world;
				const ui = createUiServer({ paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now });
				try {
					const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: { now } });
					const children = [42, 73].map((total, i) => {
						const cwd = path.join(world.dir, `project-${i}`);
						const endedMs = nowMs - (i + 1) * 86_400_000;
						const parent = { sessionId: "review.1", kind: "main", cwd, endedMs };
						const child = {
							sessionId: "check.1", parentSessionId: parent.sessionId, kind: "child",
							taskId: "st_check", title: `child ${i}`, cwd, endedMs, outcome: "answered",
						};
						appendEndedBatch(paths, [parent, child], { nowMs });
						const file = writeTask(cwd, { task_id: child.taskId, child_session_id: child.sessionId, status: "completed" }, [
							{ type: "session", id: child.sessionId },
							{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-used", usage: { input: total }, stopReason: "stop" } },
						]);
						index.update(subjectOf(child), file, { kind: "child", taskId: child.taskId });
						return child;
					});
					index.save();
					const facts = ({ title, endedMs }) => [title, endedMs];
					const ledgerChildren = () => readEnded(paths).filter(({ sessionId }) => sessionId === "check.1");
					assert.deepEqual(ledgerChildren().map(facts), children.map(facts));
					assert.equal(appendEndedBatch(paths, [{ ...children[0], endedMs: nowMs }], { nowMs })[0].appended, false);
					assert.deepEqual(ledgerChildren().map(facts), children.map(facts));

					const history = uiState({ paths, env: world.env, now: nowMs }).ended.rows.filter(({ sessionId }) => sessionId === "check.1");
					assert.deepEqual(history.map(facts), children.map(facts));
					assert.notEqual(history[0].detailRow, history[1].detailRow);
					assert.deepEqual(history.map(({ detailRow, rowSelector }) => detailRow === rowSelector && /^[a-f0-9]{16}$/.test(detailRow)), [true, true]);
					assert.deepEqual(history.map(({ tokens }) => tokens?.total), [42, 73]);
					const { port } = await ui.listen();
					for (const [i, row] of history.entries()) {
						const { status, body } = await getAt(port, `/api/session?id=${row.sessionId}&row=${row.detailRow}`);
						assert.equal(status, 200);
						assert.deepEqual(facts(body.session), facts(children[i]));
						assert.equal(body.tokens?.total, [42, 73][i]);
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
					assert.deepEqual(history.map((row) => row.detailRow), children.map((row) => expectedSelector({ ...row, sessionId: taskId, taskId })));
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
					writeJson(requestFileOf(world), { v: 1, ...sub(AUDIT_ID, world.dir), requestedMs: world.nowMs });
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
					writeJson(path.join(world.paths.health.auditsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`), {
						v: 1,
						...sub(AUDIT_ID, world.dir),
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

			it("IS-10 unconfirmed: HTTP detail exposes the persisted overdue flag and status label", async () => {
				const world = makeWorld();
				const ui = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now: world.now });
				try {
					const deadlineMs = world.nowMs - 30_000;
					writeJson(path.join(world.paths.health.auditsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`), {
						v: 1, ...sub(AUDIT_ID, world.dir), status: "running", startedMs: deadlineMs - 900_000,
						terminationUnconfirmed: true, deadlineMs,
					});
					const { port } = await ui.listen();
					const { status, body } = await getAt(port, `/api/session?id=${AUDIT_ID}`);
					assert.equal(status, 200);
					assert.equal(body.audit.state.status, "running");
					assert.equal(body.audit.state.terminationUnconfirmed, true);
					assert.equal(body.audit.state.deadlineMs, deadlineMs);
					assert.equal(body.audit.terminationUnconfirmedKo, "제한 시간이 지났지만 종료를 확인하지 못했습니다");
				} finally {
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("IS-10 missing meta: HTTP detail warns after a failed overdue adoption lookup", async () => {
				const world = makeWorld();
				const { config } = loadConfig({ paths: world.paths, env: world.env });
				const deadlineMs = world.nowMs - 1;
				writeJson(path.join(world.paths.health.auditsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`), {
					v: 1, ...sub(AUDIT_ID, world.dir), status: "running", startedMs: deadlineMs - config.audit.timeoutMs,
					jobId: "audit-lost-meta", model: "openai/gpt-review:high", laneSessionId: "audit-lane",
				});
				const auditor = createAuditor({
					paths: world.paths, config, clock: { now: world.now }, env: world.env,
					runner: {
						poll: () => ({ status: "failed", reason: "no-job" }),
						adoptJob: async () => { throw new Error("cim down"); },
					},
				});
				const ui = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now: world.now });
				try {
					auditor.tick(world.now());
					await Promise.resolve();
					auditor.tick(world.now());
					const { port } = await ui.listen();
					const { status, body } = await getAt(port, `/api/session?id=${AUDIT_ID}`);
					assert.equal(status, 200);
					assert.equal(body.audit.state.status, "running");
					assert.equal(body.audit.terminationUnconfirmedKo, "제한 시간이 지났지만 종료를 확인하지 못했습니다");
					assert.equal(body.audit.state.deadlineMs, deadlineMs);
				} finally {
					await auditor.close();
					await ui.close();
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("IS-10 launching: HTTP detail warns after repeated overdue adoption failures", async () => {
				const world = makeWorld();
				const { config } = loadConfig({ paths: world.paths, env: world.env });
				const deadlineMs = world.nowMs - 1;
				writeJson(path.join(world.paths.health.auditsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`), {
					v: 1, ...sub(AUDIT_ID, world.dir), status: "launching", launchMs: deadlineMs - config.audit.timeoutMs,
					jobId: "audit-interrupted-launch", model: "openai/gpt-review:high", laneSessionId: "audit-lane",
				});
				let lookups = 0;
				const auditor = createAuditor({
					paths: world.paths, config, clock: { now: world.now }, env: world.env,
					runner: { adoptJob: async () => { lookups++; throw new Error("cim down"); } },
				});
				const ui = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, sessionDetail: world.detail, now: world.now });
				try {
					for (let i = 0; i < 3; i++) {
						await Promise.resolve();
						auditor.tick(world.now());
					}
					assert.equal(lookups, 2);
					const { port } = await ui.listen();
					const { status, body } = await getAt(port, `/api/session?id=${AUDIT_ID}`);
					assert.equal(status, 200);
					assert.equal(body.audit.state.status, "launching");
					assert.equal(body.audit.terminationUnconfirmedKo, "제한 시간이 지났지만 종료를 확인하지 못했습니다");
					assert.equal(body.audit.state.terminationUnconfirmed, true);
					assert.equal(body.audit.state.deadlineMs, deadlineMs);
				} finally {
					await auditor.close();
					await ui.close();
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
						assert.deepEqual([blocked, planned?.model ?? null], unknown ? ["analyst-models-unknown", null] : [null, next], pass);
					}
					const [status, body] = await world.startAudit(AUDIT_ID);
					if (unknown) {
						assert.deepEqual([status, body], [409, {
							error: "analyst-models-unknown", reasonKo: "분석가가 쓴 모델을 다 확인하지 못해 조사할 수 없습니다",
						}]);
						assert.equal(fs.existsSync(requestFileOf(world)), false);
						assert.equal(fs.existsSync(world.paths.health.auditBudgetFile), false);
					} else assert.deepEqual([status, body.audit.planned.model], [202, next]);
				} finally {
					await world.detail.close();
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("IS-9 unfinished analyst run: preview and POST refuse until the fallback history is recorded", async () => {
				const world = makeWorld({ providers: ["p"], lanes: { ultrabrain: ["p/b"], architect: ["p/c"] } });
				const auditServer = createUiServer({ paths: world.paths, token: TOKEN, getState: () => STATE, startAudit: world.startAudit, now: world.now });
				try {
					const { port: auditPort } = await auditServer.listen();
					const posted = () => postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					const ts = new Date(world.nowMs - 120_000).toISOString();
					const run = { event: "investigation", ts, fp: "current-fp", jobId: "analyst-current" };
					const dir = path.join(world.paths.health.jobsDir, run.jobId);
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, "err.log"), "Model fallback: p/a -> p/b\n");
					appendDecision(world.paths, { ...run, status: "analyzing", subject: { sessionId: AUDIT_ID }, model: "p/a" });
					const refused = await posted();
					assert.deepEqual([refused.status, refused.body], [409, {
						error: "analyst-models-unknown", reasonKo: "분석가가 쓴 모델을 다 확인하지 못해 조사할 수 없습니다",
					}]);
					for (const pass of ["initial", "cached"]) {
						const { blocked, planned } = (await world.detail(AUDIT_ID)).audit;
						assert.deepEqual([blocked, planned], ["analyst-models-unknown", null], pass);
					}
					assert.equal(fs.existsSync(requestFileOf(world)), false);
					assert.equal(fs.existsSync(world.paths.health.auditBudgetFile), false);
					appendDecision(world.paths, { ...run, status: "verdict", analyst: { verdict: "act" }, usedModels: ["p/a", "p/b"] });
					const { blocked, planned } = (await world.detail(AUDIT_ID)).audit;
					assert.deepEqual([blocked, planned?.model], [null, "p/c"]);
					const { status, body } = await posted();
					assert.deepEqual([status, body.audit.planned.model], [202, "p/c"]);
				} finally {
					await Promise.all([auditServer.close(), world.detail.close()]);
					fs.rmSync(world.dir, { recursive: true, force: true });
				}
			});

			it("IS-9 unknown session models take precedence over an unfinished analyst run in preview and POST", async () => {
				const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
				const world = makeWorld({ entries: [{ type: "compaction", provider: "openai", usage }] });
				try {
					appendDecision(world.paths, {
						ts: new Date(world.nowMs - 120_000).toISOString(), event: "investigation", fp: "current-fp", jobId: "analyst-current",
						status: "analyzing", subject: { sessionId: AUDIT_ID }, model: "openai/other-analyst",
					});
					const { blocked, planned } = (await world.detail(AUDIT_ID)).audit;
					assert.deepEqual([blocked, planned], ["models-unknown", null]);
					assert.deepEqual(await world.startAudit(AUDIT_ID), [409, {
						error: "models-unknown", reasonKo: "세션이 쓴 모델을 다 확인하지 못해 조사할 수 없습니다",
					}]);
					assert.equal(fs.existsSync(requestFileOf(world)), false);
					assert.equal(fs.existsSync(world.paths.health.auditBudgetFile), false);
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
				const sessionFile = path.join(worldPaths.sessionsDir, projectKeyOf(dir), `2026-11-22T00-00-00-000Z_${sessionId}.jsonl`);
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
				const stat = fs.statSync(sessionFile);
				writeIndexRow(worldPaths.health.usageIndexFile, {
							id: sessionId,
							projectKey: projectKeyOf(dir),
							parentKey: null,
							rootKey: null,
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
							ino: fs.statSync(sessionFile, { bigint: true }).ino.toString(),
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
				const record = { found: true, id: sessionId, session: { sessionId, taskId, cwd: dir, kind: "child", title: "child" }, tokens: null, children: [], health: { findings: [], actions: [], investigations: [], messages: [], counts: { findings: 0, actions: 0, investigations: 0, messages: 0 } }, audit: null };
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
						assert.deepEqual(fs.readdirSync(world.paths.health.auditRequestsDir), [`${auditFileKey(sub(world.sessionId, world.dir, world.taskId))}.json`]);
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
					`${JSON.stringify({ v: 1, sessionId: world.sessionId, taskId: world.taskId, cwd: world.dir, kind: "child", outcome: "answered", startedMs: world.now() - 1_000, endedMs: world.now() })}\n`,
				);
				const subject = sub(world.sessionId, world.dir, world.taskId);
				writeJson(path.join(world.paths.health.auditRequestsDir, `${auditFileKey(subject)}.json`), { v: 1, ...subject, requestedMs: world.now() - 1_000 });
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
					assert.deepEqual(pending, { v: 1, ...sub(AUDIT_ID, world.dir), requestedMs: world.nowMs, claimId: pending.claimId });
					assert.equal(typeof pending.claimId, "string");
					const again = await postAt(auditPort, "/api/audit", { sessionId: AUDIT_ID });
					assert.deepEqual([again.status, again.body.error], [409, "running"]);
					assert.deepEqual(fs.readdirSync(world.paths.health.auditRequestsDir), [`${auditFileKey(sub(AUDIT_ID, world.dir))}.json`]);
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
				assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "running");
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
						assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "queued");
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
				assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).claimId, claimed.claimId);
				const refused = await postAt(bPort, "/api/audit", { sessionId: AUDIT_ID });
				assert.deepEqual([refused.status, refused.body], [409, { error: "running", reasonKo: "이미 조사 중입니다" }]);
				await auditor.preparing();
				auditor.tick(now());
				assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "running");
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
						assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "queued");
						assert.equal(fs.existsSync(requestFileOf(world)), false);
					};
					let firstRead = interleave;
					// For the interleaving, capture B's initial read before A posts.
					const observed = readAuditState(paths, sub(AUDIT_ID, world.dir));
					const b = dashboard(createStartAudit({
						paths, env, now: () => now() + 1,
						readState: (...args) => {
							if (!firstRead) return readAuditState(...args);
							firstRead = false;
							return observed;
						},
						request: (...args) => {
							assert.equal(interleave, true, "B must not claim when it reads A's active record");
							assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "requested");
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
						assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "launching");
						auditor.tick(now() + 30_000);
						auditor.tick(now() + 60_000);
						assert.equal(starts.length, 1);
						assert.deepEqual(fs.readdirSync(paths.health.auditsDir).filter((name) => !name.startsWith("_") && name.endsWith(".json")), [`${auditFileKey(sub(AUDIT_ID, world.dir))}.json`]);
						assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).requestedMs, now());
						assert.equal(readAuditState(paths, sub(AUDIT_ID, world.dir)).status, "failed");
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
					writeJson(path.join(world.paths.health.auditsDir, `${auditFileKey(sub(AUDIT_ID, world.dir))}.json`), { v: 1, ...sub(AUDIT_ID, world.dir), status: "launching", requestedMs: world.nowMs - 1_000, jobId: "audit-1", model: "openai/gpt-review:high" });
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
