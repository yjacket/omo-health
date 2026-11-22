import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearPause, setSwitch, writePause } from "../control.mjs";
import { writeUiPrefs } from "./prefs.mjs";

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./static", import.meta.url));
const MAX_BODY_BYTES = 4096;

const SECURITY_HEADERS = Object.freeze({
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
});

// The only files the server ever reads: request paths are looked up here, never joined onto a directory.
const STATIC_FILES = Object.freeze({
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
});

const API_ROUTES = Object.freeze({
	"/api/state": "GET",
	"/api/pause": "POST",
	"/api/resume": "POST",
	"/api/switch": "POST",
	"/api/diagnose": "GET",
	"/api/session": "GET",
	"/api/audit": "POST",
	"/api/prefs": "POST",
});
/** A task id or session id, as `omo-health diagnose` takes it. */
const SUBJECT_ID = /^[A-Za-z0-9_-]{4,80}$/;
/** Windows device names cannot be file names under audits/ even though they look like ids. */
const RESERVED_ID = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
/** The session detail lists, as the record names them; `children` lives on the record, the rest under `health`. */
const SESSION_LISTS = Object.freeze(["children", "findings", "actions", "investigations", "messages"]);
const SESSION_QUERY_KEYS = Object.freeze(new Set(["id", "list", "offset"]));
const SESSION_PAGE = 50;
const NON_NEGATIVE_INT = /^\d+$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasExactKeys = (obj, keys) => {
	const own = Object.keys(obj);
	return own.length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
};
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

class HttpFailure extends Error {
	constructor(status, body) {
		super(body.error);
		this.status = status;
		this.body = body;
	}
}

const SWITCH_STATUS = Object.freeze({ "unknown-key": 422, "invalid-value": 422, unreadable: 409 });

/** Validates a parsed POST body for its route and runs the control action: returns [status, body]. */
function runAction(paths, route, body, nowMs, startAudit) {
	const invalid = new HttpFailure(422, { error: "invalid" });
	switch (route) {
		case "/api/audit": {
			if (!hasExactKeys(body, ["sessionId"]) || typeof body.sessionId !== "string" || !SUBJECT_ID.test(body.sessionId) || RESERVED_ID.test(body.sessionId)) throw invalid;
			if (!startAudit) throw new HttpFailure(404, { error: "not-found" });
			return startAudit(body.sessionId);
		}
		case "/api/pause": {
			if (!hasExactKeys(body, ["minutes"]) || ![15, 60, null].includes(body.minutes)) throw invalid;
			return [200, { ok: true, pause: writePause(paths, { minutes: body.minutes ?? undefined, now: nowMs }) }];
		}
		case "/api/resume": {
			if (!hasExactKeys(body, [])) throw invalid;
			clearPause(paths);
			return [200, { ok: true }];
		}
		case "/api/prefs": {
			if (!hasExactKeys(body, ["hideChildren"]) || typeof body.hideChildren !== "boolean") throw invalid;
			if (!writeUiPrefs(paths, body).ok) throw invalid;
			return [200, { ok: true, hideChildren: body.hideChildren }];
		}
		case "/api/switch": {
			if (!hasExactKeys(body, ["key", "value"])) throw invalid;
			const result = setSwitch(paths, body.key, body.value);
			if (result.ok) return [200, { ok: true, value: result.value, isDefault: result.isDefault }];
			const payload = result.message === undefined ? { error: result.reason } : { error: result.reason, message: result.message };
			return [SWITCH_STATUS[result.reason] ?? 500, payload];
		}
		default:
			throw new HttpFailure(404, { error: "not-found" });
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const onData = (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.off("data", onData);
				reject(new HttpFailure(413, { error: "too-large" }));
				return;
			}
			chunks.push(chunk);
		};
		req.on("data", onData);
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export function createUiServer({ paths, token, getState, diagnose, sessionDetail, startAudit, idleMs = 30 * 60_000, now = Date.now, staticDir = DEFAULT_STATIC_DIR, log = () => {} }) {
	const expectedDigest = digest(token);
	let lastRequestMs = now();
	let port = 0;

	const send = (res, status, body, extra = {}) => {
		res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra });
		res.end(JSON.stringify(body));
	};

	async function servePost(req, res, route) {
		const origin = req.headers.origin;
		if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) throw new HttpFailure(403, { error: "forbidden-origin" });
		const mediaType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
		if (mediaType !== "application/json") throw new HttpFailure(415, { error: "unsupported-media-type" });
		if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new HttpFailure(413, { error: "too-large" });
		const text = await readBody(req);
		let body;
		try {
			body = JSON.parse(text);
		} catch (error) {
			if (error instanceof SyntaxError) throw new HttpFailure(400, { error: "bad-json" });
			throw error;
		}
		if (!isPlainObject(body)) throw new HttpFailure(400, { error: "bad-json" });
		const [status, payload] = await runAction(paths, route, body, now(), startAudit);
		send(res, status, payload);
	}

	/** GET /api/diagnose lists what can be diagnosed; ?id=<task|session> runs the same diagnosis as the CLI. */
	async function serveDiagnose(req, res) {
		const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
		const id = new URLSearchParams(query).get("id");
		if (id !== null && !SUBJECT_ID.test(id)) throw new HttpFailure(422, { error: "invalid" });
		if (!diagnose) throw new HttpFailure(404, { error: "not-found" });
		send(res, 200, await diagnose(id ?? undefined));
	}

	/** `/api/session` params: exact id, an optional known list and a page offset. Anything else is invalid. */
	function parseSessionQuery(url) {
		const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
		const params = new URLSearchParams(query);
		for (const key of params.keys()) if (!SESSION_QUERY_KEYS.has(key)) throw new HttpFailure(422, { error: "invalid" });
		const id = params.get("id");
		if (id === null || !SUBJECT_ID.test(id)) throw new HttpFailure(422, { error: "invalid" });
		const list = params.get("list");
		const offsetText = params.get("offset");
		if (list === null) {
			if (offsetText !== null) throw new HttpFailure(422, { error: "invalid" });
			return { id, list: null, offset: 0 };
		}
		if (!SESSION_LISTS.includes(list)) throw new HttpFailure(422, { error: "invalid" });
		if (offsetText !== null && !NON_NEGATIVE_INT.test(offsetText)) throw new HttpFailure(422, { error: "invalid" });
		return { id, list, offset: offsetText === null ? 0 : Number(offsetText) };
	}

	/** One list of the detail, wherever the record keeps it. */
	function sessionList(detail, name) {
		const health = isPlainObject(detail.health) ? detail.health : {};
		const items = name === "children" ? detail.children : health[name];
		return Array.isArray(items) ? items : [];
	}

	/** The default response: the first page of every list plus the whole-record counts. */
	function sessionFirstPage(detail) {
		const health = isPlainObject(detail.health) ? detail.health : {};
		const lists = Object.fromEntries(SESSION_LISTS.map((name) => [name, sessionList(detail, name)]));
		return {
			...detail,
			children: lists.children.slice(0, SESSION_PAGE),
			health: {
				...health,
				findings: lists.findings.slice(0, SESSION_PAGE),
				actions: lists.actions.slice(0, SESSION_PAGE),
				investigations: lists.investigations.slice(0, SESSION_PAGE),
				messages: lists.messages.slice(0, SESSION_PAGE),
			},
			counts: Object.fromEntries(SESSION_LISTS.map((name) => [name, lists[name].length])),
		};
	}

	/** GET /api/session?id=<task|session>[&list=<name>&offset=<n>]. */
	async function serveSession(req, res) {
		const query = parseSessionQuery(req.url);
		if (!sessionDetail) throw new HttpFailure(404, { error: "not-found" });
		const detail = await sessionDetail(query.id);
		if (!isPlainObject(detail) || detail.found === false) throw new HttpFailure(404, { error: "not-found" });
		if (query.list === null) return send(res, 200, sessionFirstPage(detail));
		const all = sessionList(detail, query.list);
		send(res, 200, { list: query.list, offset: query.offset, total: all.length, items: all.slice(query.offset, query.offset + SESSION_PAGE) });
	}

	async function serveStatic(req, res, pathname) {
		const entry = Object.hasOwn(STATIC_FILES, pathname) ? STATIC_FILES[pathname] : undefined;
		if (!entry) throw new HttpFailure(404, { error: "not-found" });
		if (req.method !== "GET") throw new HttpFailure(405, { error: "method-not-allowed" });
		let data;
		try {
			data = await fs.readFile(path.join(staticDir, entry.file));
		} catch (error) {
			if (error?.code === "ENOENT") throw new HttpFailure(404, { error: "not-found" });
			throw error;
		}
		res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": entry.type });
		res.end(data);
	}

	async function handle(req, res) {
		const hosts = req.headersDistinct.host;
		if (hosts?.length !== 1 || hosts[0] !== `127.0.0.1:${port}`) throw new HttpFailure(403, { error: "forbidden-host" });
		if (!req.url.startsWith("/")) throw new HttpFailure(400, { error: "bad-request" });
		if (req.method !== "GET" && req.method !== "POST") throw new HttpFailure(405, { error: "method-not-allowed" });
		const pathname = req.url.split("?")[0];
		if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);
		const provided = req.headers["x-omo-health-token"] ?? "";
		if (!crypto.timingSafeEqual(digest(provided), expectedDigest)) throw new HttpFailure(401, { error: "unauthorized" });
		const isAutoRefresh = req.method === "GET" && pathname === "/api/state" && req.headers["x-omo-health-auto"] === "1";
		const isSessionAuto = req.method === "GET" && pathname === "/api/session" && req.headers["x-omo-health-auto"] === "1";
		if (!isAutoRefresh && !isSessionAuto) lastRequestMs = now();
		const method = Object.hasOwn(API_ROUTES, pathname) ? API_ROUTES[pathname] : undefined;
		if (!method) throw new HttpFailure(404, { error: "not-found" });
		if (req.method !== method) throw new HttpFailure(405, { error: "method-not-allowed" });
		if (pathname === "/api/diagnose") return serveDiagnose(req, res);
		if (pathname === "/api/session") return serveSession(req, res);
		if (method === "GET") return send(res, 200, getState());
		return servePost(req, res, pathname);
	}

	const server = http.createServer((req, res) => {
		// The request boundary: every failure becomes one JSON response.
		handle(req, res).catch((error) => {
			const failure = error instanceof HttpFailure ? error : null;
			if (!failure) log("ui_request_failed", { method: req.method, message: String(error?.message ?? error) });
			const status = failure?.status ?? 500;
			const extra = {};
			if (status === 405) extra.Allow = "GET, POST";
			if (req.method === "POST") extra.Connection = "close";
			if (res.headersSent) {
				res.destroy();
				return;
			}
			send(res, status, failure?.body ?? { error: "internal" }, extra);
		});
	});

	return {
		listen() {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					port = server.address().port;
					resolve({ port, url: `http://127.0.0.1:${port}/#t=${token}` });
				});
			});
		},
		async close() {
			const httpClosed = new Promise((resolve, reject) => {
				if (!server.listening) return resolve();
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
			const closeHandlers = new Set([sessionDetail?.close, startAudit?.close]);
			await Promise.all([httpClosed, ...Array.from(closeHandlers, (close) => close?.())]);
		},
		checkIdle(nowMs = now()) {
			return nowMs - lastRequestMs >= idleMs;
		},
		get lastRequestMs() {
			return lastRequestMs;
		},
	};
}
