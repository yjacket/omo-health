import "./helpers/tmp-root.mjs";
import { subjectOf, subjectKey } from "../src/session-subject.mjs";
const sub = (sessionId, cwd) => subjectOf({ sessionId, cwd });
const key = (sessionId, cwd) => subjectKey(sub(sessionId, cwd));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { SWITCH_KEYS } from "../src/config.mjs";
import { NUMBER_KEYS, SWITCHES } from "../src/control.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { createSessionFileLocator } from "../src/collect/session-files.mjs";
import { buildSessionRecord, loadSessionRecord } from "../src/session-record.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createUsageIndex, readUsageIndex, USAGE_INDEX_VERSION } from "../src/usage-index.mjs";
import { ACTION_LABELS, EXIT_REASON_LABELS, GOAL_STATUS_LABELS, INVESTIGATION_STATUS_LABELS, OUTCOME_LABELS, SESSION_STATE_LABELS, TASK_STATUS_LABELS, TERMINAL_LABELS, TRIGGER_LABELS } from "../src/ui/labels.mjs";
import { buildHistory } from "../src/ui/history.mjs";
import { createDetailOperations } from "../src/ui/detail-worker.mjs";
import { buildEnded, buildOverview, buildSessions, buildSettings, buildUiState, daemonStatus, endedRow, loadDaemonInputs, loadUiInputs, uiState } from "../src/ui/model.mjs";
import { buildSessionView, sessionRecordPage } from "../src/ui/session-view.mjs";
import { buildSessionSnapshot } from "../src/session-board.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { expectedSelector } from "./helpers/ended-selector.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-29T03:00:00.000Z"); // 12:00 KST
const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const EMPTY_SESSIONS = { v: 1, ts: null, stale: false, groups: [], total: 0 };
const roots = [];
after(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeHome() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-model-"));
	roots.push(root);
	const env = { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health") };
	return { env, paths: resolvePaths(env) };
}

function write(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** Lines are objects (grouped into <utc-date>.jsonl by ts) or raw strings appended to `rawFile`. */
function writeDecisions(paths, lines, rawFile = "2026-09-28.jsonl") {
	const files = new Map();
	for (const line of lines) {
		const name = typeof line === "string" ? rawFile : `${line.ts.slice(0, 10)}.jsonl`;
		files.set(name, [...(files.get(name) ?? []), typeof line === "string" ? line : JSON.stringify(line)]);
	}
	for (const [name, content] of files) write(path.join(paths.health.decisionsDir, name), `${content.join("\n")}\n`);
}

const heartbeat = (extra = {}) => ({ pid: 424242, ts: NOW - 10_000, startedMs: NOW - DAY, version: "0.3.0", mode: "auto", ...extra });
const inputsOf = (home, overrides = {}) => ({ ...loadUiInputs({ paths: home.paths, env: home.env, now: NOW }), ...overrides });
const running = (home, hbExtra, overrides = {}) => inputsOf(home, { heartbeat: heartbeat(hbExtra), pidAlive: true, ...overrides });

it("history gives every row a request selector but only shared IDs a key suffix", () => {
	const shared = { sessionId: "st_shared", taskId: "st_shared", kind: "child" };
	const ended = [
		{ ...shared, endedMs: NOW, parentSessionId: "b" },
		{ sessionId: "unique", endedMs: NOW - 1 },
		{ ...shared, endedMs: NOW - 2, parentSessionId: "a" },
	];
	const { rows } = buildEnded({ now: NOW, ended });
	assert.deepEqual(rows.map((r) => r.rowSelector), ended.map(expectedSelector));
	assert.deepEqual(rows.map((r) => [r.sessionId, r.detailRow]), [
		["st_shared", expectedSelector(ended[0])], ["unique", undefined], ["st_shared", expectedSelector(ended[2])],
	]);
	assert.equal(Object.hasOwn(rows[1], "detailRow"), false);
});

it("(plan 46) same-tick history rows have distinct selectors and browser keys by parent or cwd", () => {
	const shared = { sessionId: "st_parent", kind: "child", endedMs: NOW };
	const ended = [
		{ ...shared, parentSessionId: "parent-a" },
		{ ...shared, parentSessionId: "parent-b" },
		{ ...shared, sessionId: "st_cwd", cwd: "C:/store-a" },
		{ ...shared, sessionId: "st_cwd", cwd: "C:/store-b" },
		{ sessionId: "unique", endedMs: NOW },
	];
	const { rows } = buildEnded({ now: NOW, ended });
	const expected = ended.slice(0, -1).map(expectedSelector);
	assert.deepEqual(rows.slice(0, -1).map((row) => row.detailRow), expected);
	assert.equal(new Set(expected).size, 4);
	assert.equal(Object.hasOwn(rows.at(-1), "detailRow"), false);
	const h = endedRefreshHarness();
	assert.deepEqual(rows.map((row) => h.endedItem(row).children[0].children[0].children[0]["data-key"]), [
		`ended:st_parent:${expected[0]}`, `ended:st_parent:${expected[1]}`,
		`ended:st_cwd:${expected[2]}`, `ended:st_cwd:${expected[3]}`, "ended:unique",
	]);
});

it("(plan 35) browser history toggles and requests each row independently", async () => {
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const openEnded = new Set();
	const endedDetails = new Map();
	const urls = [];
	const el = (tag, attrs, ...children) => ({
		tag, ...attrs, children: children.flat(), classList: { toggle() {} }, setAttribute() {},
	});
	const { endedItem, loadEndedPage } = runInNewContext(
		["endedDetailId", "endedDetailUrl", "endedTokenSignature", "endedDetailSignature", "endedItem", "loadEndedDetail", "loadEndedPage"]
			.map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\t\\}`))?.[0]).join("\n") +
			"\n({ endedItem, loadEndedPage })",
		{
			el, openEnded, endedDetails, lastState: null, drawEndedDetail() {}, ENDED_COLUMNS: Array(6).fill("column"), cellClass() {},
			when() {}, endedSessionCell() {}, outcomeMark() {}, endedTokenCell() {}, show() {},
			append: (body, children) => Object.assign(body, { children }),
			getJson: (url) => { urls.push(url); return { messages: [], counts: { messages: 1 } }; },
			gone: false, busy: new Set(), errors: new Map(), detailList: (data, name) => data[name],
		},
	);
	const a = "0123456789abcdef";
	const b = "fedcba9876543210";
	const c = "0123456789fedcba";
	const rows = [
		{ sessionId: "st_shared", endedMs: NOW, detailRow: a, rowSelector: a },
		{ sessionId: "st_shared", endedMs: NOW - 1, detailRow: b, rowSelector: b },
		{ sessionId: "unique", endedMs: NOW, rowSelector: c },
	];
	const items = rows.map(endedItem);
	assert.deepEqual(items.map(({ children: [row] }) => row.children[0].children[0]["data-key"]),
		[`ended:st_shared:${a}`, `ended:st_shared:${b}`, "ended:unique"]);
	for (const { children: [row] } of items) row.onclick();
	await Promise.resolve();
	await loadEndedPage(rows[1], "messages");
	await loadEndedPage(rows[2], "messages");
	assert.deepEqual(urls, [
		`/api/session?id=st_shared&row=${a}`,
		`/api/session?id=st_shared&row=${b}`,
		`/api/session?id=unique&row=${c}`,
		`/api/session?id=st_shared&row=${b}&list=messages&offset=0`,
		`/api/session?id=unique&row=${c}&list=messages&offset=0`,
	]);
	assert.equal(openEnded.size, 3);
	assert.equal(endedDetails.size, 3);
});

function endedDetailFunctions(names, globals) {
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const functions = names.map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\t\\}`))?.[0]);
	return runInNewContext(`${functions.join("\n")}\n({ ${names.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`).join(", ")} })`, globals);
}

it("plan78: 81- and 300-character history IDs survive browser keys, detail URLs and audit bodies", () => {
	const ids = ["x".repeat(80) + "A", "x".repeat(299) + "B"];
	const posts = [];
	const { endedItem, endedDetailUrl, startAudit } = endedDetailFunctions(
		["endedDetailId", "endedDetailUrl", "endedItem", "startAudit"], {
			el: (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat() }),
			openEnded: new Set(), endedDetails: new Map(), cellClass() {},
			ENDED_COLUMNS: Array(6).fill("column"), when() {}, endedSessionCell() {}, outcomeMark() {}, endedTokenCell() {}, show() {},
			append: (body, children) => Object.assign(body, { children }),
			post: (url, body) => posts.push([url, body.sessionId, body.row]),
		},
	);
	const ended = ids.map((sessionId) => ({ sessionId, endedMs: NOW }));
	const { rows } = buildEnded({ now: NOW, ended });
	const selectors = ended.map(expectedSelector);
	const rendered = rows.map(endedItem);
	rows.forEach(startAudit);
	assert.deepEqual(rendered.map(({ children: [row] }) => row.children[0].children[0]["data-key"]), ids.map((id) => `ended:${id}`));
	assert.deepEqual(rows.map(endedDetailUrl), ids.map((id, i) => `/api/session?id=${id}&row=${selectors[i]}`));
	assert.deepEqual(posts, ids.map((id, i) => ["/api/audit", id, selectors[i]]));
});

it("IS-7: the app detail distinguishes withheld health records from an empty history", () => {
	const el = (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter(Boolean) });
	const { endedRecord } = endedDetailFunctions(["endedRecord", "detailTextNodes", "endedDetailId"], {
		el, block: (title, ...children) => el("div", { title }, children), subBlock: (title, ...children) => el("div", { title }, children),
		note: (text, tone) => el("p", { text, tone }), empty: (text) => el("p", { text }),
		detailList: (d, name) => name === "children" ? d.children : d.health[name],
		endedFacts() {}, endedTokenBlock() {}, endedModels() {}, endedChild() {}, errorSlot() {}, auditBlock() {},
		endedFinding: (finding) => finding.titleKo, endedAction: (action) => action.fp, endedInvestigation: (investigation) => investigation.fp,
	});
	const row = { sessionId: "shared-health", kind: "main", cwd: "C:/project-a", startedMs: NOW - HOUR, endedMs: NOW };
	const ledger = [row, { ...row, cwd: "C:/project-b" }];
	const noHistory = buildSessionRecord({ row, ledger });
	const fp = "withheld-record-sentinel";
	const ts = new Date(NOW - 1000).toISOString();
	const subject = { sessionId: row.sessionId };
	const sharedHistory = buildSessionRecord({
		row, ledger,
		decisions: [
			{ event: "opened", fp, ts, subject, detector: "D1", kind: "stalled", severity: "warn", titleKo: fp },
			{ fp, ts, detector: "D1", action: { kind: "notice" }, result: "execute", outcome: { delivered: true } },
			{ event: "investigation", fp, ts, analyst: { verdict: "act" } },
		],
		investigations: [{ id: fp, subject, detector: "D1" }],
	});
	const render = (record) => endedRecord(row, buildSessionView(sessionRecordPage(record, null, 0)));
	const label = "같은 id의 다른 세션이 있어 붙이지 못한 기록";
	const zeroCounts = { findings: 0, actions: 0, verdicts: 0, investigations: 0 };
	for (const record of [noHistory, { ...noHistory, truncated: { unattributedHealth: zeroCounts } }]) {
		const rendered = JSON.stringify(render(record));
		assert.ok(rendered.includes("감지 기록이 없습니다"));
		assert.ok(!rendered.includes(label));
	}

	assert.deepEqual(sharedHistory.truncated.unattributedHealth, { findings: 1, actions: 1, verdicts: 1, investigations: 1 });
	const detail = render(sharedHistory);
	assert.ok(!JSON.stringify(detail).includes(fp), "withheld record text must not be rendered");
	const healthLog = detail.find((block) => block.title === "omo-health 기록").children[0];
	assert.ok(healthLog.children.some((node) => node.tag === "p" && node.text === `${label} 4건` && node.tone === undefined), "the health area should show a muted notice with the total");
	assert.equal(JSON.stringify(detail).split(label).length - 1, 1, "the notice should appear once per detail");
});

it("IS-10 unconfirmed: the app audit block renders the overdue status when flagged", () => {
	const el = (tag, attrs, ...children) => ({ tag, attrs, children });
	const { auditBlock } = endedDetailFunctions(["auditBlock", "auditProgress"], {
		el, block: (title, body) => ({ title, body }), note: (text, tone) => ({ text, tone }),
		AUDIT_ACTIVE: new Set(["running"]), endedDetailId: (r) => r.sessionId,
		show: String, when: String, chip: String, errorSlot: () => null,
	});
	const label = "제한 시간이 지났지만 종료를 확인하지 못했습니다";
	const state = { status: "running", statusKo: "조사 중", startedMs: NOW - 930_000 };
	const render = (fields) => JSON.stringify(auditBlock({ sessionId: "audit" }, { state, ...fields }));
	assert.ok(render({ state: { ...state, terminationUnconfirmed: true, deadlineMs: NOW - 30_000 }, terminationUnconfirmedKo: label }).includes(label));
	assert.ok(!render({ terminationUnconfirmedKo: label }).includes(label), "an ordinary running audit has no overdue note");
});

it("IS-10 transition: the rendered audit offers retry only after the slot is released", () => {
	const { auditBlock } = endedDetailFunctions(["auditBlock", "auditProgress", "auditFailure", "auditStart"], {
		el: (tag, attrs, ...children) => ({ tag, attrs, children }),
		block: (title, body) => ({ title, body }), note: (text) => ({ text }),
		AUDIT_ACTIVE: new Set(["running"]), endedDetailId: (r) => r.sessionId,
		show: String, when: String, chip: String, errorSlot: () => null,
		button: (label) => ({ tag: "button", label }),
	});
	const label = "제한 시간이 지났지만 종료를 확인하지 못했습니다";
	const render = (state) => JSON.stringify(auditBlock({ sessionId: "audit" }, { state, terminationUnconfirmedKo: label }));
	const pending = render({ status: "running", terminationUnconfirmed: true });
	assert.ok(pending.includes(label));
	assert.ok(!pending.includes('"tag":"button","label":"다시 조사"'));
	for (const reason of ["model-fallback", "timeout"]) {
		const state = { status: "failed", reason };
		assert.ok(!render({ ...state, holdUntilExit: true }).includes('"tag":"button","label":"다시 조사"'), reason);
		assert.ok(render(state).includes('"tag":"button","label":"다시 조사"'), reason);
	}
});

it("(plan 37) the app disclosure uses a 300-character preview and keeps the full text", () => {
	const el = (tag, attrs, ...children) => ({ tag, attrs, children });
	const { detailText, detailTextParts } = endedDetailFunctions(["detailTextParts", "detailText"], { el, show: String });
	assert.equal(typeof detailTextParts, "function");
	const preview = "x".repeat(300);
	const full = `${preview}\nThe final sentence.`;
	const parts = detailTextParts(full);
	assert.equal(parts.preview, preview);
	assert.equal(parts.full, full);
	assert.equal(detailText(preview).tag, "span");
	const disclosure = detailText(full);
	assert.equal(disclosure.tag, "details");
	assert.equal(disclosure.attrs.open, undefined);
	const [summary, expanded] = disclosure.children;
	assert.deepEqual(Array.from(summary.children, (node) => node.attrs.text), [`${preview}…`, "전체 보기", "접기"]);
	assert.equal(expanded.attrs.text, full);
});

const pendingTokens = { tokensState: "pending", tokens: null, treeTokens: null };
const readyTokens = { tokensState: "ok", tokens: { total: 30 }, treeTokens: 40 };

for (const [label, previous, next, changed] of [
	["same signature keeps the detail", readyTokens, { ...readyTokens, tokens: { total: 30, input: 20 } }, false],
	["pending to ok refreshes the detail", pendingTokens, readyTokens, true],
	["changed ok total refreshes the detail", readyTokens, { ...readyTokens, tokens: { total: 31 } }, true],
	["missing stays missing and keeps the detail", { ...pendingTokens, tokensState: "missing" }, { ...pendingTokens, tokensState: "missing" }, false],
	["changed tree total refreshes the detail", readyTokens, { ...readyTokens, treeTokens: 41 }, true],
	["changed tree state refreshes the detail", pendingTokens, { ...pendingTokens, treeTokensState: "overflow" }, true],
]) {
	it(`(plan 36) token signature: ${label}`, () => {
		const { endedTokenSignature } = endedDetailFunctions(["endedTokenSignature"]);
		assert.equal(typeof endedTokenSignature, "function", "the detail cache needs a row token signature");
		assert.equal(endedTokenSignature(previous) !== endedTokenSignature(next), changed);
	});
}

it("detail text disclosures are found whether a list wrapper returns one node or an array (investigations return an array)", () => {
	const { detailTextNodes } = endedDetailFunctions(["detailTextNodes"]);
	const disclosure = (name) => ({ name, matches: (selector) => selector === ".detail-text", querySelectorAll: () => [] });
	const holder = (...inside) => ({ matches: () => false, querySelectorAll: (selector) => (selector === ".detail-text" ? inside : []) });
	// The extracted function runs in another realm, so copy its arrays into this one before comparing.
	const names = (nodes) => Array.from(nodes, (node) => node.name);
	assert.deepEqual(names(detailTextNodes(holder(disclosure("a"), disclosure("b")))), ["a", "b"]);
	assert.deepEqual(names(detailTextNodes([holder(disclosure("a")), [disclosure("b"), holder(disclosure("c"))], "text", null])), ["a", "b", "c"]);
	assert.deepEqual(names(detailTextNodes("no nodes")), []);
});

function endedRefreshHarness(recordsStamp) {
	const openEnded = new Set();
	const endedDetails = new Map();
	const requests = [];
	const redraws = [];
	const globals = {
		openEnded, endedDetails, hideChildren: false, AUDIT_ACTIVE: new Set(["running"]), errors: new Map(),
		seq: 0, timer: null, gone: false, token: "test", clearTimeout() {}, schedule() {},
		lastState: { recordsStamp },
		render(state) { globals.lastState = state; },
		document: { querySelectorAll: () => [] }, // The old audit poll has no active audit to read.
		fetch: async () => ({ ok: true, json: async () => ({ recordsStamp, ended: { rows: globals.rows } }) }),
		el: (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(), classList: { toggle() {} }, setAttribute() {} }),
		ENDED_COLUMNS: Array(6).fill("column"), cellClass() {},
		when() {}, endedSessionCell() {}, outcomeMark() {}, endedTokenCell() {}, show() {}, endedDetailView() {},
		append: (body, children) => Object.assign(body, { children }),
		drawEndedDetail: (id) => redraws.push(id),
		getJson: (url, headers) => {
			const result = BrowserPromise.withResolvers();
			requests.push({ url, headers, ...result });
			return result.promise;
		},
	};
	// A promise from the extracted functions' realm resumes their await on the next microtask.
	const { refresh, loadEndedDetail, endedItem, Promise: BrowserPromise } = endedDetailFunctions([
		"refresh", "pollAudits", "refreshEndedDetails", "endedDetailId", "endedDetailUrl", "endedTokenSignature", "endedDetailSignature", "loadEndedDetail", "endedItem", "Promise",
	], globals);
	return {
		openEnded, endedDetails, requests, redraws, endedItem,
		setRecordsStamp(next) { recordsStamp = next; },
		async seed(row, data) {
			const loaded = loadEndedDetail(row);
			requests.pop().resolve(data);
			await loaded;
			redraws.length = 0;
		},
		tick(...rows) {
			globals.rows = rows;
			return refresh(true);
		},
	};
}

it("(plan 36) state refresh re-reads a changed open detail and only drops a changed closed detail", async () => {
	const h = endedRefreshHarness();
	const openRow = { sessionId: "shared", detailRow: "0123456789abcdef", rowSelector: "0123456789abcdef", ...pendingTokens };
	const closedRow = { ...openRow, detailRow: "fedcba9876543210", rowSelector: "fedcba9876543210" };
	const openId = `shared:${openRow.detailRow}`;
	const closedId = `shared:${closedRow.detailRow}`;
	const old = { audit: { blocked: "models-unknown" } };
	h.openEnded.add(openId);
	await h.seed(openRow, old);
	await h.seed(closedRow, old);

	await h.tick({ ...openRow, ...readyTokens }, { ...closedRow, ...readyTokens });
	assert.deepEqual(h.requests.map(({ url }) => url), [`/api/session?id=shared&row=${openRow.detailRow}`]);
	assert.equal(h.requests[0].headers["x-omo-health-auto"], "1");
	assert.equal(h.endedDetails.has(closedId), false);
	assert.equal(h.endedDetails.get(openId).data, old);
	assert.deepEqual(h.redraws, [], "no loading redraw replaces the old panel");

	const updated = { tokens: readyTokens.tokens, audit: { blocked: null } };
	h.requests[0].resolve(updated);
	await Promise.resolve();
	assert.equal(h.endedDetails.get(openId).data, updated);
	assert.equal(h.openEnded.has(openId), true);
	assert.deepEqual(h.redraws, [openId]);
	await h.tick({ ...openRow, ...readyTokens });
	assert.equal(h.requests.length, 1, "a successful refresh caches the new signature");
});

it("(plan 40) a changed records stamp refreshes an open panel without changed tokens or an active audit", async () => {
	const h = endedRefreshHarness("before");
	const row = { sessionId: "open", rowSelector: "0123456789abcdef", ...readyTokens };
	const old = { health: { investigations: [] } };
	h.openEnded.add(row.sessionId);
	await h.seed(row, old);
	await h.tick(row);
	assert.equal(h.requests.length, 0, "an unchanged stamp does not refetch");

	h.setRecordsStamp("after");
	await h.tick(row);
	assert.deepEqual(h.requests.map(({ url }) => url), [`/api/session?id=open&row=${row.rowSelector}`]);
	assert.equal(h.requests[0].headers["x-omo-health-auto"], "1");
	assert.equal(h.endedDetails.get(row.sessionId).data, old);
	assert.deepEqual(h.redraws, [], "keep the panel in place until its replacement is ready");

	const updated = { health: { investigations: [{ status: "answered" }] } };
	h.requests[0].resolve(updated);
	await Promise.resolve();
	assert.equal(h.endedDetails.get(row.sessionId).data, updated);
	assert.equal(h.openEnded.has(row.sessionId), true);
	assert.deepEqual(h.redraws, [row.sessionId]);
	await h.tick(row);
	assert.equal(h.requests.length, 1, "the new stamp is cached");
});

it("(plan 40) a changed records stamp drops closed cache entries, including rows absent from the poll", async () => {
	const h = endedRefreshHarness("before");
	const row = { sessionId: "closed", rowSelector: "0123456789abcdef", ...readyTokens };
	const absent = { ...row, sessionId: "absent", rowSelector: "fedcba9876543210" };
	await h.seed(row, {});
	await h.seed(absent, {});
	await h.tick(row);
	assert.equal(h.endedDetails.size, 2, "an unchanged stamp keeps closed cache entries");

	h.setRecordsStamp("after");
	await h.tick(row);
	assert.equal(h.endedDetails.size, 0, "a changed stamp drops closed cache entries");
	assert.equal(h.requests.length, 0, "closed rows do not refetch in the background");
	h.endedItem(row).children[0].onclick();
	assert.deepEqual(h.requests.map(({ url }) => url), [`/api/session?id=closed&row=${row.rowSelector}`]);
});

it("(plan 40) reopening revalidates a cached detail before the next poll", async () => {
	const h = endedRefreshHarness("before");
	const row = { sessionId: "reopened", rowSelector: "0123456789abcdef", ...readyTokens };
	const old = { health: { investigations: [] } };
	h.openEnded.add(row.sessionId);
	await h.seed(row, old);
	const { children: [toggle] } = h.endedItem(row);
	toggle.onclick(); // Close.
	toggle.onclick(); // Reopen while the last polled stamp is still unchanged.
	assert.deepEqual(h.requests.map(({ url }) => url), [`/api/session?id=reopened&row=${row.rowSelector}`]);
	assert.equal(h.endedDetails.get(row.sessionId).data, old);
	assert.equal(h.openEnded.has(row.sessionId), true);
});

it("(plan 36) a failed token refetch keeps the open panel and retries on the next state refresh", async () => {
	const h = endedRefreshHarness();
	const row = { sessionId: "open", rowSelector: "0123456789abcdef", ...pendingTokens };
	const updatedRow = { ...row, ...readyTokens };
	const old = { audit: { blocked: "models-unknown" } };
	h.openEnded.add(row.sessionId);
	await h.seed(row, old);
	await h.tick(updatedRow);
	assert.equal(h.requests.length, 1, "a changed signature starts a detail refetch");
	await h.tick(updatedRow);
	assert.equal(h.requests.length, 1, "a matching in-flight request is not duplicated");

	h.requests[0].reject(new Error("temporary failure"));
	await Promise.resolve();
	assert.equal(h.endedDetails.get(row.sessionId).data, old);
	assert.deepEqual(h.redraws, []);
	await h.tick(updatedRow);
	assert.equal(h.requests.length, 2);
	const updated = { tokens: readyTokens.tokens };
	h.requests[1].resolve(updated);
	await Promise.resolve();
	assert.equal(h.endedDetails.get(row.sessionId).data, updated);
	assert.deepEqual(h.redraws, [row.sessionId]);
});

it("(gate 16) history and board show a dash with the full-index tooltip", () => {
	const id = "full-session";
	const history = endedRow({ sessionId: id }, 0, new Map([[key(id), { id, state: "full" }]]));
	const board = buildSessions({ now: NOW, sessionsSnapshot: { groups: [{ sessions: [{ sessionId: id, tokensState: "full" }] }] } }).groups[0].sessions[0];
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const readToken = runInNewContext(`(${app.match(/function tokenReading\([^]*?\n\t\}/)[0]})`, { lastState: {} });
	for (const row of [history, board]) {
		assert.equal(row.tokens, null);
		assert.equal(row.tokensState, "full");
		const reading = readToken(row.tokensState);
		assert.equal(reading.text, "-");
		assert.equal(reading.title, "토큰 색인이 가득 차 세지 않았습니다");
	}
});

it("(gate 16b) the board keeps a refused token state from the snapshot through the card and the child row", () => {
	const world = makeWorld({
		now: NOW,
		sessions: [sessionState({ id: "m-full", startedMs: NOW - 5000 })],
		tasks: [taskRecord({ taskId: "st_full", childSessionId: "c-full", parentSessionId: "m-full", name: "full child" })],
		sensors: [{ sessionId: "m-full", pid: 100, ts: NOW - 1000, idle: true, executingTools: 0 }],
		procsFresh: true,
	});
	const snapshot = buildSessionSnapshot(world, [], [], NOW, { tokensOf: ({ sessionId: id }) => (id === "m-full" || id === "c-full" ? { state: "full" } : null) });
	const board = buildSessions({ now: NOW, sessionsSnapshot: snapshot }).groups[0].sessions[0];
	assert.equal(board.tokensState, "full", "the main card keeps the snapshot's full state");
	assert.equal(board.children[0].tokensState, "full", "the child row keeps the snapshot's full state");

	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const el = (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter((child) => child != null) });
	const format = runInNewContext(
		["tokenReading", "treeTokenMark", "boardTokenMarks", "childMeta", "tree"].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))?.[0]).join("\n") +
			"\n({ tokenReading, boardTokenMarks, childMeta, tree })",
		{ el, lastState: {}, compactCount: (n) => String(n), fullCount: (n) => String(n), elapsedText: () => "1m", childTone: () => "idle" },
	);
	const tooltip = "토큰 색인이 가득 차 세지 않았습니다";
	const mainMarks = format.boardTokenMarks(board);
	assert.deepEqual([mainMarks[0].text, mainMarks[0].title], ["토큰 -", tooltip], "the main card's token line is a dash with the full-index title");
	const childMeta = format.tree(board.children).children[0].children[0].children[2];
	assert.equal(childMeta.text.endsWith("토큰 -"), true, "the child row's line is a dash");
	assert.equal(childMeta.title, tooltip, "the child row carries the full-index title");
	assert.equal(format.childMeta(board.children[0]).includes("토큰 계산 중"), false, "a full state never reads as 계산 중");
});

const overflowTitle = "토큰 합계가 표시할 수 있는 범위를 넘었습니다";

function overflowIndex(paths, rows, cwd) {
	const file = paths.health.usageIndexFile;
	const index = createUsageIndex({ file, clock: createFakeClock(NOW) });
	for (const [id, input, parentSessionId, taskId] of rows) {
		const transcript = path.join(path.dirname(file), `${id}.jsonl`);
		write(transcript, `{"type":"usage","provider":"p","model":"m","usage":{"input":${input}}}\n`);
		index.update(subjectOf({ sessionId: id, cwd, taskId }), transcript, { parentSessionId: parentSessionId ?? null });
	}
	index.save();
	return index;
}

function tokenFormatters(...names) {
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const fn = (name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))?.[0];
	const el = (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter((child) => child != null) });
	return runInNewContext(
		["tokenReading", "treeTokenMark", "compactCount", ...names].map(fn).join("\n") + `\n({ ${names.join(", ")} })`,
		{ el, lastState: {}, fullCount: (n) => Number.isFinite(n) ? String(n) : "-", childTone: () => "idle" },
	);
}

it("board overflow survives snapshot JSON and renders on the card and child row", () => {
	const { paths } = makeHome();
	const index = overflowIndex(paths, [["main", "1e309"], ["child", "1e309", "main", "st_x"], ["finite", "5"], ["negative", "-1e309", "finite"]], "C:/dev/proj");
	const tracker = createUsageTracker({ paths, index, clock: createFakeClock(NOW) });
	assert.equal(tracker.tokensOf(sub("main", "C:/dev/proj")).tokens.total, Infinity);
	const world = makeWorld({
		now: NOW,
		sessions: ["main", "finite"].map((id) => sessionState({ id, startedMs: NOW - 5000 })),
		tasks: [taskRecord({ taskId: "st_x", childSessionId: "child", parentSessionId: "main" })],
		sensors: ["main", "finite"].map((sessionId) => ({ sessionId, pid: 100, ts: NOW - 1000, idle: true, executingTools: 0 })),
		procsFresh: true,
	});
	const snapshot = buildSessionSnapshot(world, [], [], NOW, { tokensOf: (sessionId, taskId) => tracker.tokensOf(sessionId, taskId) });
	const model = buildSessions({ now: NOW, sessionsSnapshot: JSON.parse(JSON.stringify(snapshot)) });
	const [main, finite] = model.groups[0].sessions;
	const format = tokenFormatters("boardTokenMarks", "childMeta", "tree");
	const own = format.boardTokenMarks(main)[0];
	const child = format.tree(main.children).children[0].children[0].children[2];
	const tree = format.boardTokenMarks(finite)[1];
	assert.deepEqual([main.tokens.total, main.tokensState, own.text, own.title], [null, "overflow", "토큰 -", overflowTitle]);
	assert.deepEqual([main.children[0].tokens.total, main.children[0].tokensState, child.text.split(" · ").at(-1), child.title],
		[null, "overflow", "토큰 -", overflowTitle]);
	assert.deepEqual([finite.tokens.total, finite.treeTokens, finite.treeTokensState, tree?.text, tree?.title],
		[5, null, "overflow", "자식 포함 -", overflowTitle]);
});

it("history overflow survives /api/state serialization and renders for own and NaN tree totals", () => {
	const { paths, env } = makeHome();
	const row = { sessionId: "root", kind: "main", startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
	appendEnded(paths, row);
	overflowIndex(paths, [["root", "1e309"], ["child", "-1e309", "root"]]);
	const history = JSON.parse(JSON.stringify(uiState({ paths, env, now: NOW }))).ended.rows[0];
	const format = tokenFormatters("endedTokenCell");
	const cell = format.endedTokenCell(history);
	assert.deepEqual([history.tokens.total, history.tokensState, cell.children[0].text, cell.children[0].title],
		[null, "overflow", "-", overflowTitle]);
	assert.deepEqual([history.treeTokens, history.treeTokensState, cell.children[1]?.text, cell.children[1]?.title],
		[null, "overflow", "자식 포함 -", overflowTitle]);
});

it("(IS-3) history renders a second line for equal and lower tree totals, but not uncounted descendants", () => {
	const { paths, env } = makeHome();
	const rows = [
		["equal", "0", "자식 포함 10"],
		["lower", "-3", "자식 포함 7"],
		["missing", null, undefined],
	];
	const row = { kind: "main", startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
	for (const [id] of rows) appendEnded(paths, { ...row, sessionId: id }, { nowMs: NOW });
	const index = overflowIndex(paths, rows.flatMap(([id, input]) => [
		[id, "10"],
		...(input === null ? [] : [[`${id}-child`, input, id]]),
	]));
	index.markMissing(sub("missing-child"), { kind: "child", parentSessionId: "missing" });
	index.save();
	const history = new Map(JSON.parse(JSON.stringify(uiState({ paths, env, now: NOW }))).ended.rows.map((row) => [row.sessionId, row]));
	const { endedTokenCell } = tokenFormatters("endedTokenCell");
	assert.deepEqual(rows.map(([id]) => {
		const row = history.get(id);
		return [row.treeTokens, endedTokenCell(row).children[1]?.text];
	}), [[10, rows[0][2]], [7, rows[1][2]], [null, rows[2][2]]]);
});

it("(plan 61) history and audit preview reject a task-only file that stops being unique", () => {
	const { env, paths } = makeHome();
	const clock = createFakeClock(NOW);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const locator = createSessionFileLocator({ paths, clock });
	const tracker = createUsageTracker({ paths, index, locator, clock });
	const taskId = "st_changing";
	const cwd = path.join(env.USERPROFILE, "proj");
	const row = { sessionId: taskId, taskId, kind: "child", cwd, startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
	appendEnded(paths, row, { nowMs: NOW });
	const dir = path.join(cwd, ".omo", "senpi-task", "children", taskId, "sessions", taskId);
	const transcript = '{"type":"usage","provider":"p","model":"m","usage":{"input":42}}\n';
	write(path.join(dir, "first.jsonl"), transcript);
	const second = path.join(dir, "second.jsonl");
	const prepare = createDetailOperations({
		paths, env, today: () => 0,
		daemonInputs: () => ({ now: NOW, heartbeat: heartbeat(), pidAlive: true, loaded: { config: { mode: "auto", daemonStaleMs: 45_000 } } }),
		resolveModel: () => ({ model: "upper" }),
	});
	const status = () => {
		const history = uiState({ paths, env, now: NOW }).ended.rows.find(({ sessionId }) => sessionId === taskId);
		const preview = prepare({ kind: "preview", id: taskId, now: NOW, record: { session: row, analystModels: [] } });
		return [history.tokens?.total ?? null, preview.blocked, preview.planned?.model ?? null];
	};
	const world = makeWorld({ now: NOW, sessions: [] });
	tracker.queueLedger([row]);
	tracker.tick(world);
	assert.deepEqual(status(), [42, null, "upper"]);

	write(second, transcript);
	tracker.tick(world);
	assert.deepEqual(status(), [null, "models-unknown", null], "history and preview must not trust the old on-disk publication");

	fs.rmSync(second);
	assert.deepEqual(status(), [null, "models-unknown", null], "removal alone must not revive the publication before recount");
	tracker.tick(world);
	index.save();
	assert.deepEqual(status(), [42, null, "upper"]);
});

it("(IS-3) deleted task-only usage keeps its history label but blocks audit like a session-ID child", () => {
	const { env, paths } = makeHome();
	const clock = createFakeClock(NOW);
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const locator = createSessionFileLocator({ paths, clock });
	const tracker = createUsageTracker({ paths, index, locator, clock });
	const cwd = path.join(env.USERPROFILE, "proj");
	const prepare = createDetailOperations({
		paths, env, today: () => 0,
		daemonInputs: () => ({ now: NOW, heartbeat: heartbeat(), pidAlive: true, loaded: { config: { mode: "auto", daemonStaleMs: 45_000 } } }),
		resolveModel: () => ({ model: "upper" }),
	});
	const world = makeWorld({ now: NOW, sessions: [] });
	const subjects = [["st_deleted", "st_deleted"], ["st_exact", "child-exact"]].map(([taskId, sessionId]) => {
		const row = { sessionId, taskId, kind: "child", cwd, startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
		const file = path.join(cwd, ".omo", "senpi-task", "children", taskId, "sessions", taskId, `2026-09-28T12-00-00-000Z_${sessionId}.jsonl`);
		write(file, '{"type":"usage","provider":"p","model":"m","usage":{"input":42}}\n');
		appendEnded(paths, row, { nowMs: NOW });
		return { row, file };
	});
	const { endedTokenCell } = tokenFormatters("endedTokenCell");
	const status = () => {
		const history = new Map(uiState({ paths, env, now: NOW }).ended.rows.map((row) => [row.sessionId, row]));
		return subjects.map(({ row }) => {
			const entry = history.get(row.sessionId);
			const mark = endedTokenCell(entry).children[0];
			const preview = prepare({ kind: "preview", id: row.sessionId, now: NOW, record: { session: row, analystModels: [] } });
			return [entry.tokens?.total ?? null, mark.text, mark.title, preview.blocked];
		});
	};
	tracker.queueLedger(subjects.map(({ row }) => row));
	tracker.tick(world);
	assert.deepEqual(status(), [[42, "42", "42", null], [42, "42", "42", null]]);

	for (const { file } of subjects) fs.rmSync(file);
	tracker.queueLedger(subjects.map(({ row }) => row));
	tracker.tick(world);
	index.save();
	assert.deepEqual(status(), [[42, "42", "42 (파일 삭제됨)", "models-unknown"], [42, "42", "42 (파일 삭제됨)", "models-unknown"]]);
});

it("history marks a partial tree with the required text and title", () => {
	const { paths, env } = makeHome();
	const cwd = paths.healthHome;
	const row = { kind: "main", cwd, startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
	for (const id of ["partial", "complete"]) appendEnded(paths, { ...row, sessionId: id }, { nowMs: NOW });
	appendEnded(paths, { ...row, kind: "child", sessionId: "pending", taskId: "st_pending", parentSessionId: "partial", parentProjectKey: sub("partial", cwd).projectKey }, { nowMs: NOW });
	overflowIndex(paths, [["partial", "100"], ["counted-p", "20", "partial"], ["complete", "100"], ["counted-c", "20", "complete"]], cwd);
	const history = new Map(JSON.parse(JSON.stringify(uiState({ paths, env, now: NOW }))).ended.rows.map((row) => [row.sessionId, row]));
	const { endedTokenCell } = tokenFormatters("endedTokenCell");
	const actual = ["partial", "complete"].map((id) => {
		const row = history.get(id);
		const mark = endedTokenCell(row).children[1];
		return [mark.text, mark.title, row.treeTokens, row.treeTokensComplete];
	});
	assert.deepEqual(actual, [
		["자식 포함 120+", "세지 못한 자식이 있어 일부만 더한 값입니다", 120, false],
		["자식 포함 120", "120", 120, true],
	]);
});

it("(plan 51) history marks a pending parent tree partial until its read finishes", () => {
	const { paths, env } = makeHome();
	appendEnded(paths, { sessionId: "main", kind: "main", startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" }, { nowMs: NOW });
	const index = overflowIndex(paths, [["child", "20", "main"]]);
	const file = path.join(paths.health.sessionsDir, "main.jsonl");
	write(file, '{"type":"usage","provider":"p","model":"m","usage":{"input":100}}\n');
	index.update(sub("main"), file, { kind: "main" }, { maxBytes: 1 });
	const { endedTokenCell } = tokenFormatters("endedTokenCell");
	const display = () => {
		index.save();
		const [row] = uiState({ paths, env, now: NOW }).ended.rows;
		const mark = endedTokenCell(row).children[1];
		return [row.tokensState, row.treeTokens, row.treeTokensComplete, mark.text, mark.title];
	};
	const pending = display();
	index.update(sub("main"), file, { kind: "main" });
	assert.deepEqual([pending, display()], [
		["pending", 20, false, "자식 포함 20+", "세지 못한 자식이 있어 일부만 더한 값입니다"],
		["ok", 120, true, "자식 포함 120", "120"],
	]);
});

it("a completeness-only history change refreshes the detail", () => {
	const { endedTokenSignature } = endedDetailFunctions(["endedTokenSignature"]);
	assert.notEqual(
		endedTokenSignature({ ...readyTokens, treeTokensComplete: false }),
		endedTokenSignature({ ...readyTokens, treeTokensComplete: true }),
	);
});

it("(gate 17) the disk-backed full state renders a dash in history, detail, and child rows until recount", () => {
	const { paths } = makeHome();
	const file = paths.health.usageIndexFile;
	const row = { sessionId: "root", kind: "main", startedMs: NOW - HOUR, endedMs: NOW, outcome: "completed" };
	appendEnded(paths, row);
	appendEnded(paths, { ...row, sessionId: "child", kind: "child", parentSessionId: "root", taskId: "st_child", outcome: "answered" });
	write(file, `${JSON.stringify({ v: USAGE_INDEX_VERSION, full: true })}\n`);
	const clock = createFakeClock(NOW);
	const index = createUsageIndex({ file, clock });
	const transcript = path.join(path.dirname(file), "transcript.jsonl");
	write(transcript, '{"type":"usage","provider":"p","model":"m","usage":{"input":42}}\n');
	const view = () => buildSessionView(loadSessionRecord({ paths, id: "root", now: clock.now() }));
	const app = fs.readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
	const el = (tag, attrs, ...children) => ({ tag, ...attrs, children });
	const format = runInNewContext(
		["tokenReading", "endedTokenFacts", "endedChild"].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\t\\}`))[0]).join("\n") +
			"\n({ tokenReading, endedTokenFacts, endedChild })",
		{ el, empty: (text) => el("p", { text }), note: (text) => el("p", { text }), OUTCOME_TONE: {}, lastState: {} },
	);
	const history = endedRow(row, 1, readUsageIndex(file));
	const detail = view();
	const renderedDetail = format.endedTokenFacts(detail.tokens);
	const renderedChild = format.endedChild(detail.children[0]).children[0].children[2].children[1];
	const tooltip = "토큰 색인이 가득 차 세지 않았습니다";
	const reading = format.tokenReading(history.tokensState);
	assert.deepEqual(
		[history.tokensState, detail.tokens?.state, detail.children[0].tokensState, reading.text, reading.title,
			renderedDetail.text, renderedDetail.title, renderedChild.text, renderedChild.title],
		["full", "full", "full", "-", tooltip, "-", tooltip, "토큰 -", tooltip],
	);

	index.markMissing(sub("old"));
	assert.equal(index.prune(NOW + DAY, 0), 1);
	index.update(sub("root"), transcript);
	index.update(subjectOf({ sessionId: "child", taskId: "st_child" }), transcript, { parentSessionId: "root" });
	index.save();
	const recovered = view();
	assert.equal(recovered.tokens.total, 42);
	assert.equal(recovered.children[0].tokens.total, 42);
});

describe("ui model", () => {
	it("returns every section without throwing for an empty home", () => {
		const home = makeHome();
		const state = uiState({ paths: home.paths, env: home.env, now: NOW });
		assert.deepEqual(Object.keys(state), ["generatedMs", "version", "recordsStamp", "sessions", "ended", "overview", "investigations", "history", "settings", "budget", "prefs"]);
		for (const key of ["sessions", "ended", "overview", "investigations", "history", "settings"]) assert.equal(state[key].error, undefined, key);
		assert.equal(state.history.total, 0);
		assert.deepEqual(state.investigations.rows, []);
		assert.equal(state.overview.daemon.state, "off");
		assert.deepEqual(state.overview.deaths, { count: 0, last: null });
		assert.deepEqual(state.sessions, EMPTY_SESSIONS);
		assert.deepEqual(state.ended.rows, []);
		assert.equal(state.ended.total, 0);
		assert.deepEqual(state.prefs, { hideChildren: false });
		assert.deepEqual(state.ended.counts.map((c) => [c.outcome, c.count]), Object.keys(OUTCOME_LABELS).map((outcome) => [outcome, 0]));
	});

	for (const [type, dir, name, contents] of [
		["decision", "decisionsDir", "2026-09-29.jsonl", "{}\n"],
		["investigation", "investigationsDir", "child-review.json", '{"id":"child-review"}'],
	]) {
		it(`(plan 40) recordsStamp changes only with record metadata: ${type} file`, () => {
			const home = makeHome();
			const file = path.join(home.paths.health[dir], name);
			const stamp = (now = NOW) => uiState({ ...home, now }).recordsStamp;
			const before = stamp();
			write(file, contents);
			fs.utimesSync(file, new Date(NOW), new Date(NOW));
			const created = stamp();
			assert.notEqual(created, before, "a new record changes the stamp");

			const parent = path.dirname(file);
			fs.utimesSync(parent, new Date(NOW), new Date(NOW));
			const beforeEdit = stamp();
			fs.appendFileSync(file, "\n");
			fs.utimesSync(file, new Date(NOW + HOUR), new Date(NOW + HOUR));
			fs.utimesSync(parent, new Date(NOW), new Date(NOW));
			const afterEdit = stamp();
			assert.notEqual(afterEdit, beforeEdit, "an existing record changes even if the directory mtime does not");
			write(home.paths.health.sessionsSnapshotFile, { ts: NOW });
			assert.equal(stamp(NOW + DAY), afterEdit, "a clock tick and unrelated file do not change the stamp");
		});
	}

	describe("session board from the daemon's snapshot file", () => {
		const MAIN = "01a11561-1048-74da-b7b2-c4ac83217a7c";
		const health = (level = "ok", open = [], investigations = []) => ({ level, open, investigations });
		const child = (taskId, name, status, extra = {}) => ({ taskId, sessionId: null, name, category: "quick", model: null, status, startedMs: null, endedMs: null, health: health(), children: [], ...extra });
		const session = (sessionId, title, extra = {}) => ({ sessionId, title, titleSource: "name", cwd: "C:\\dev\\x", startedMs: NOW - HOUR, terminal: null, host: null, state: { kind: "idle", sinceMs: NOW - 100, tool: null }, goal: null, todo: null, lastInputMs: null, health: health(), children: [], ...extra });
		const snapshot = (ts) => ({
			v: 1,
			ts,
			groups: [
				{
					omoVersion: "5.1.19",
					sessions: [
						session(MAIN, "omo-health 후속\n토큰 sk-ant-api03-abcdefghijklmnop", {
							cwd: "C:\\Users\\user\\proj\\issue-104-logwatch",
							terminal: { kind: "orca" },
							host: { pid: 80968, ctimeMs: NOW - HOUR, omoVersion: "5.1.19" },
							state: { kind: "tool", sinceMs: NOW - 42_000, tool: "eval" },
							goal: { status: "active", objective: "세션 현황판" },
							todo: { open: 4, total: 9 },
							lastInputMs: NOW - 180_000,
							health: health("warn", [{ fp: "fp1", detector: "D1", kind: "stall", severity: "warn", titleKo: "도구 호출 멈춤", taskId: "st_01a11794" }], [{ fp: "fp1", status: "analyzing", nextLookMs: NOW + 600_000 }]),
							children: [child("st_01a11794", "ui-data", "running", { category: "unspecified-high", startedMs: NOW - 18 * 60_000, children: [child("st_probe", "probe-orca-env", "pending")] })],
						}),
						session("01a11562-0000-7000-8000-000000000002", "two", { titleSource: "goal", terminal: { kind: "herdr" } }),
					],
				},
				{ omoVersion: null, sessions: [session("01a11563-0000-7000-8000-000000000003", "three", { state: { kind: "busy", sinceMs: NOW - 5000, tool: null }, health: health("crit") })] },
			],
		});
		const sessionsOf = (home) => uiState({ paths: home.paths, env: home.env, now: NOW }).sessions;

		it("groups sessions by omo version with Korean labels, a shortened folder, redacted text and the child tree", () => {
			const home = makeHome();
			write(home.paths.health.sessionsSnapshotFile, snapshot(NOW - 5000));
			const s = sessionsOf(home);
			assert.equal(s.error, undefined);
			assert.equal(s.ts, NOW - 5000);
			assert.equal(s.stale, false);
			assert.equal(s.total, 3);
			assert.deepEqual(s.groups.map((g) => g.omoVersion), ["5.1.19", null]);
			assert.deepEqual(s.groups[0].counts, { sessions: 2, active: 1, warn: 1, crit: 0 });
			assert.deepEqual(s.groups[1].counts, { sessions: 1, active: 1, warn: 0, crit: 1 });
			const [main, two] = s.groups[0].sessions;
			assert.equal(main.sessionShort, "01a11561");
			assert.equal(main.title, "omo-health 후속 토큰 sk-ant-[REDACTED]");
			assert.equal(main.cwdShort, "…\\proj\\issue-104-logwatch");
			assert.equal(main.cwd, "C:\\Users\\user\\proj\\issue-104-logwatch");
			assert.deepEqual(main.terminal, { kind: "orca", labelKo: TERMINAL_LABELS.orca });
			assert.deepEqual(main.host, { pid: 80968, ctimeMs: NOW - HOUR, omoVersion: "5.1.19" });
			assert.deepEqual(main.state, { kind: "tool", kindKo: SESSION_STATE_LABELS.tool, sinceMs: NOW - 42_000, tool: "eval" });
			assert.deepEqual(main.goal, { status: "active", statusKo: GOAL_STATUS_LABELS.active, objective: "세션 현황판" });
			assert.deepEqual(main.todo, { open: 4, total: 9 });
			assert.equal(main.lastInputMs, NOW - 180_000);
			assert.equal(main.health.level, "warn");
			assert.deepEqual(main.health.open, [{ fp: "fp1", detector: "D1", kind: "stall", severity: "warn", severityKo: "주의", titleKo: "도구 호출 멈춤", taskId: "st_01a11794" }]);
			assert.deepEqual(main.health.investigations, [{ fp: "fp1", status: "analyzing", statusKo: INVESTIGATION_STATUS_LABELS.analyzing, nextLookMs: NOW + 600_000 }]);
			assert.equal(main.childCount, 1);
			const [uiData] = main.children;
			assert.equal(uiData.name, "ui-data");
			assert.equal(uiData.statusKo, TASK_STATUS_LABELS.running);
			assert.equal(uiData.startedMs, NOW - 18 * 60_000);
			assert.deepEqual(uiData.children.map((c) => [c.name, c.status, c.statusKo]), [["probe-orca-env", "pending", TASK_STATUS_LABELS.pending]]);
			assert.equal(two.terminal.labelKo, TERMINAL_LABELS.herdr);
			assert.equal(two.host, null);
			assert.equal(two.goal, null);
			assert.equal(two.cwdShort, "C:\\dev\\x");
			assert.equal(two.state.kindKo, SESSION_STATE_LABELS.idle);
		});

		it("flags a snapshot older than 60 s as stale and keeps its rows", () => {
			const home = makeHome();
			write(home.paths.health.sessionsSnapshotFile, snapshot(NOW - 60_000));
			assert.equal(sessionsOf(home).stale, false);
			write(home.paths.health.sessionsSnapshotFile, snapshot(NOW - 60_001));
			const stale = sessionsOf(home);
			assert.equal(stale.stale, true);
			assert.equal(stale.total, 3);
		});

		it("shows the empty snapshot for a missing, malformed or shapeless file", () => {
			const home = makeHome();
			assert.deepEqual(sessionsOf(home), EMPTY_SESSIONS);
			write(home.paths.health.sessionsSnapshotFile, "{");
			assert.deepEqual(sessionsOf(home), EMPTY_SESSIONS);
			write(home.paths.health.sessionsSnapshotFile, { v: 1, ts: "soon", groups: [{ omoVersion: 1, sessions: "none" }, 7] });
			assert.deepEqual(sessionsOf(home), { v: 1, ts: null, stale: false, groups: [{ omoVersion: null, sessions: [], counts: { sessions: 0, active: 0, warn: 0, crit: 0 } }], total: 0 });
		});
	});

	describe("ended sessions from the ledger files", () => {
		const MAIN = "01a11561-1048-74da-b7b2-c4ac83217a7c";
		const record = (sessionId, outcome, endedMs, extra = {}) => ({ v: 1, sessionId, kind: "main", parentSessionId: null, taskId: null, title: `${outcome} session`, cwd: "C:\\dev\\omo\\omo-health", terminal: { kind: "orca" }, omoVersion: "5.1.19", startedMs: endedMs - HOUR, endedMs, outcome, reason: `${outcome} reason`, childCount: 0, estimated: false, source: "live", ...extra });
		const writeLedger = (paths, day, records) => write(path.join(paths.health.sessionsDir, `ended-${day}.jsonl`), `${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
		const endedOf = (home) => uiState({ paths: home.paths, env: home.env, now: NOW }).ended;

		it("a session recorded with childCount 0 shows its explicitly linked ended children; a larger recorded count stays", () => {
			const home = makeHome();
			const parentProjectKey = subjectOf(record("desk", "closed", NOW)).projectKey;
			const child = (n, parent) => record(`c${n}`, "answered", NOW - 2 * HOUR - n * 60_000, { kind: "child", parentSessionId: parent, parentProjectKey, taskId: `st_${n}` });
			writeLedger(home.paths, "2026-09-29", [record("desk", "closed", NOW - HOUR), record("big", "closed", NOW - HOUR, { childCount: 17 }), child(1, "desk"), child(2, "desk"), child(3, "big")]);
			const rows = Object.fromEntries(endedOf(home).rows.map((r) => [r.sessionId, r.childCount]));
			assert.equal(rows.desk, 2);
			assert.equal(rows.big, 17);
			assert.equal(rows.c1, 0);
		});

		it("lists the last 30 days newest first with outcome labels, durations and counts, skipping corrupt and out-of-window lines", () => {
			const home = makeHome();
			writeLedger(home.paths, "2026-09-29", [
				record(MAIN, "goal-complete", NOW - HOUR, { startedMs: NOW - 8 * HOUR, childCount: 17 }),
				record("01a11570-0000-7000-8000-000000000001", "answered", NOW - 2 * HOUR, { kind: "child", parentSessionId: MAIN, taskId: "st_01a11794", startedMs: NOW - 2 * HOUR - 8 * 60_000, cwd: null, terminal: null }),
				"{not json",
			]);
			writeLedger(home.paths, "2026-09-28", [
				record("s3", "crash", NOW - 3 * HOUR, { omoVersion: "5.1.12" }),
				record("s4", "cancelled", NOW - 4 * HOUR, { kind: "child", parentSessionId: "s3" }),
				record("s5", "released", NOW - 5 * HOUR),
				record("s6", "closed", NOW - 6 * HOUR, { estimated: true, reason: "센서가 사라짐 sk-ant-api03-abcdefghijklmnop", startedMs: null }),
				record("s7", "failed", NOW - 7 * HOUR),
				record("s8", "unknown", NOW - 8 * HOUR),
				record("s9", "weird", NOW - 9 * HOUR),
			]);
			// The window starts 30 days ago at 03:00Z: the earlier row of that day is out, the later one in; an older file is skipped.
			writeLedger(home.paths, "2026-08-30", [record("old-in", "closed", NOW - 30 * DAY + HOUR), record("old-out", "closed", NOW - 30 * DAY - HOUR)]);
			writeLedger(home.paths, "2026-08-20", [record("older", "crash", NOW - 40 * DAY)]);
			const e = endedOf(home);
			assert.equal(e.error, undefined);
			assert.equal(e.sinceMs, NOW - 30 * DAY);
			assert.equal(e.limit, 500);
			assert.equal(e.total, 10);
			assert.deepEqual(e.rows.map((r) => r.sessionId), [MAIN, "01a11570-0000-7000-8000-000000000001", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "old-in"]);
			assert.deepEqual(e.counts.filter((c) => c.count).map((c) => [c.outcome, c.outcomeKo, c.count]), [
				["goal-complete", OUTCOME_LABELS["goal-complete"], 1],
				["answered", OUTCOME_LABELS.answered, 1],
				["crash", OUTCOME_LABELS.crash, 1],
				["cancelled", OUTCOME_LABELS.cancelled, 1],
				["failed", OUTCOME_LABELS.failed, 1],
				["released", OUTCOME_LABELS.released, 1],
				["closed", OUTCOME_LABELS.closed, 2],
				["unknown", OUTCOME_LABELS.unknown, 2],
			]);
			const [main, answered, crash, , , closed, , , weird] = e.rows;
			assert.equal(main.kind, "main");
			assert.equal(main.outcomeKo, OUTCOME_LABELS["goal-complete"]);
			assert.equal(main.durationMs, 7 * HOUR);
			assert.equal(main.childCount, 17);
			assert.equal(main.cwdShort, "C:\\dev\\omo\\omo-health");
			assert.deepEqual(main.terminal, { kind: "orca", labelKo: TERMINAL_LABELS.orca });
			assert.equal(main.estimated, false);
			assert.equal(answered.kind, "child");
			assert.equal(answered.parentShort, "01a11561");
			assert.equal(answered.taskId, "st_01a11794");
			assert.equal(answered.durationMs, 8 * 60_000);
			assert.equal(answered.cwdShort, null);
			assert.equal(answered.terminal, null);
			assert.equal(crash.omoVersion, "5.1.12");
			assert.equal(closed.estimated, true);
			assert.equal(closed.durationMs, null);
			assert.equal(closed.reason, "센서가 사라짐 sk-ant-[REDACTED]");
			assert.equal(weird.outcome, "unknown");
			assert.equal(weird.outcomeKo, OUTCOME_LABELS.unknown);
		});

		it("caps the rows at 500 while counting the whole window", () => {
			const home = makeHome();
			writeLedger(home.paths, "2026-09-28", Array.from({ length: 505 }, (_, i) => record(`s${i}`, i % 2 ? "answered" : "closed", NOW - DAY + i * 1000)));
			const e = endedOf(home);
			assert.equal(e.rows.length, 500);
			assert.equal(e.total, 505);
			assert.equal(e.rows[0].sessionId, "s504");
			assert.deepEqual(e.counts.filter((c) => c.count).map((c) => [c.outcome, c.count]), [["answered", 252], ["closed", 253]]);
		});

		it("isolates a ledger read failure to the ended section", () => {
			const home = makeHome();
			const state = buildUiState({ ...loadUiInputs({ paths: home.paths, env: home.env, now: NOW }), ended: { error: "EACCES" } });
			assert.deepEqual(state.ended, { error: "EACCES" });
			assert.deepEqual(state.sessions, EMPTY_SESSIONS);
		});
	});

	it("passes the budget office snapshot through, with denial events and no owner list", () => {
		const home = makeHome();
		const snap = { v: 1, updatedMs: NOW, enabled: true, treasury: { state: "ok", windows: [] }, projects: [{ id: "p", pending: null }], audits: [], events: [{ seq: 1, ms: NOW, projectId: "p", account: null, kind: "denied", data: { projectId: "p", requestId: "r", increaseUsd: 5, reason: "insufficient-capacity" } }] };
		write(home.paths.health.budgetSnapshotFile, snap);
		const state = uiState({ paths: home.paths, env: home.env, now: NOW });
		assert.deepEqual(state.budget, snap);
		assert.equal(Object.hasOwn(state.budget, "owner"), false);
	});

	it("surfaces the most recent death record in the overview", () => {
		const home = makeHome();
		write(path.join(home.paths.health.deathsDir, "old.json"), { kind: "hung", atMs: NOW - 1000 });
		write(path.join(home.paths.health.deathsDir, "new.json"), { kind: "unclean-exit", atMs: NOW });
		assert.deepEqual(uiState({ paths: home.paths, env: home.env, now: NOW }).overview.deaths, { count: 2, last: { kind: "unclean-exit", atMs: NOW } });
	});

	it("lists two investigation files newest first, with the retry time only on the unsettled one", () => {
		const home = makeHome();
		const inv = (id, openedMs, extra) => ({ id, openedMs, updatedMs: openedMs, trigger: "stall", subject: { sessionId: "01a0ea7f-26c7-7d5f-86d3-a44908fc8772", taskId: "st_01a0ea7f", toolCallId: null, parentSessionId: null }, detector: "D1", cls: "quiet-hang", rule: { id: "R12", v: 1, confidence: 0.6 }, evidence: ["bash sleep 999: 20m without output"], signals: [], lane: "quick", model: null, jobId: null, verdict: null, actions: [], failures: 0, retryAtMs: null, ...extra });
		write(path.join(home.paths.health.investigationsDir, "fp-old.json"), inv("fp-old", NOW - 3600_000, { status: "released", retryAtMs: NOW + 1, actions: [{ atMs: NOW - 3000_000, kind: "release-shell", quiet: true, rule: "R12", killed: ["bash(11)"], noop: [], survived: [] }] }));
		write(path.join(home.paths.health.investigationsDir, "fp-new.json"), inv("fp-new", NOW - 60_000, { status: "failed", failures: 1, retryAtMs: NOW + 600_000, verdict: { atMs: NOW - 50_000, verdict: "escalate", reason: "analyst-off", failed: true, evidence: [] } }));
		const { investigations } = uiState({ paths: home.paths, env: home.env, now: NOW });
		assert.equal(investigations.error, undefined);
		assert.deepEqual(investigations.rows.map((r) => r.id), ["fp-new", "fp-old"]);
		const [failed, released] = investigations.rows;
		assert.equal(failed.status, "failed");
		assert.equal(failed.statusKo, INVESTIGATION_STATUS_LABELS.failed);
		assert.equal(failed.triggerKo, TRIGGER_LABELS.stall);
		assert.equal(failed.retryAtMs, NOW + 600_000);
		assert.equal(failed.verdict.failed, true);
		assert.equal(failed.verdictKo, "-");
		assert.equal(released.status, "released");
		assert.equal(released.retryAtMs, null);
		assert.equal(released.action.kind, "release-shell");
		assert.equal(released.action.kindKo, ACTION_LABELS["release-shell"]);
		assert.match(released.action.detail, /killed bash\(11\)/);
		assert.equal(released.subject.kind, "child");
		assert.equal(released.subject.id, "st_01a0ea7f");
		assert.equal(released.subject.sessionShort, "01a0ea7f");
		assert.deepEqual(released.evidence, ["bash sleep 999: 20m without output"]);
	});

	it("passes a why look's mechanism, avoid and reuse through and labels any why-looked investigation 원인 조사", () => {
		const home = makeHome();
		const MECHANISM = "cmd /c with a bare /c from the drive root runs cmd.exe itself, which waits for a console that never comes.";
		const AVOID = "Run the script from its own folder with an absolute path and never pass /c without a command after it.";
		const verdict = (extra = {}) => ({ atMs: NOW - 50_000, verdict: "escalate", assessment: "suspicious", actionId: "escalate", confidence: 0.85, cause: "wrong-command", diagnosis: "The child keeps calling the same broken command.", advice: "Tell the parent what went wrong.", evidence: ["same-call-loop: 6 calls"], reason: null, failed: false, reused: false, why: true, ...extra });
		const inv = (id, openedMs, extra) => ({ id, openedMs, updatedMs: openedMs, trigger: "stall", subject: { sessionId: "01a0ea7f-26c7-7d5f-86d3-a44908fc8772", taskId: "st_01a0ea7f", toolCallId: null, parentSessionId: null }, detector: "D10", cls: null, rule: null, signature: "D10|same-call-loop|bash|abc", evidence: [], signals: [], lane: "quick", model: null, jobId: null, verdict: null, actions: [], failures: 0, retryAtMs: null, ...extra });
		write(path.join(home.paths.health.investigationsDir, "fp-why.json"), inv("fp-why", NOW - 60_000, { trigger: "why", status: "advised", verdict: verdict({ mechanism: MECHANISM, avoid: AVOID }), actions: [{ atMs: NOW - 40_000, kind: "why-notice", delivered: true }] }));
		// Opened by an R7 release (trigger stall), then given a why look: the sticky flag makes it read as a why look; its reused verdict is 700 characters long.
		write(path.join(home.paths.health.investigationsDir, "fp-r7.json"), inv("fp-r7", NOW - 120_000, { detector: "D1", cls: "inproc", rule: { id: "R7", v: 1, confidence: 0.8 }, why: true, status: "released", lane: null, verdict: verdict({ mechanism: "m".repeat(700), avoid: AVOID, reused: true }) }));
		// A verdict from before analyst-why carries neither field.
		write(path.join(home.paths.health.investigationsDir, "fp-plain.json"), inv("fp-plain", NOW - 180_000, { detector: "D1", status: "verdict", verdict: verdict({ why: false }) }));
		const { investigations } = uiState({ paths: home.paths, env: home.env, now: NOW });
		assert.equal(investigations.error, undefined);
		const [why, r7, plain] = investigations.rows;
		assert.equal(why.id, "fp-why");
		assert.equal(why.trigger, "why");
		assert.equal(why.triggerKo, "원인 조사");
		assert.equal(why.triggerKo, TRIGGER_LABELS.why);
		assert.equal(why.verdict.mechanism, MECHANISM);
		assert.equal(why.verdict.avoid, AVOID);
		assert.equal(why.verdict.reused, false);
		assert.equal(why.verdict.causeKo, "잘못된 명령");
		assert.equal(why.action.kind, "why-notice");
		assert.equal(why.action.kindKo, ACTION_LABELS["why-notice"]);
		assert.equal(why.action.kindKo, "원인 알림");
		assert.equal(r7.id, "fp-r7");
		assert.equal(r7.trigger, "why");
		assert.equal(r7.triggerKo, "원인 조사");
		assert.equal(r7.rule, "R7");
		assert.equal(r7.verdict.reused, true);
		assert.equal(r7.verdict.mechanism.length, 600);
		assert.equal(r7.verdict.avoid, AVOID);
		assert.equal(plain.id, "fp-plain");
		assert.equal(plain.trigger, "stall");
		assert.equal(plain.triggerKo, TRIGGER_LABELS.stall);
		assert.equal(plain.verdict.mechanism, null);
		assert.equal(plain.verdict.avoid, null);
		assert.equal(plain.verdict.reused, false);
	});

	describe("history from a decision log fixture", () => {
		const home = makeHome();
		const d14 = (ts, event, sessionId = "01a0ea7f-26c7-7d5f-86d3-a44908fc8772") => ({ ts, event, detector: "D14", kind: "outside-workspace", severity: "warn", subject: { sessionId, taskId: "st_01a0ea7f" }, evidence: [`write:C:/x/${ts}`] });
		const kill = (ts, result) => ({ ts, fp: "f1", detector: "D1", kind: "stall", action: { kind: "kill-pids" }, result, outcome: { killed: [{ pid: 11 }], survived: [] } });
		writeDecisions(home.paths, [
			d14("2026-09-21T01:00:00.000Z", "opened"),
			d14("2026-09-25T01:00:00.000Z", "opened"),
			d14("2026-09-26T01:00:00.000Z", "opened"),
			d14("2026-09-26T05:00:00.000Z", "resolved"),
			d14("2026-09-27T01:00:00.000Z", "reopened"),
			d14("2026-09-28T01:00:00.000Z", "opened"),
			d14("2026-09-28T02:00:00.000Z", "opened"),
			d14("2026-09-28T05:00:00.000Z", "resolved"),
			kill("2026-09-27T03:00:00.000Z", "execute"),
			kill("2026-09-27T04:00:00.000Z", "execute"),
			kill("2026-09-27T05:00:00.000Z", "would"),
			kill("2026-09-27T06:00:00.000Z", "skipped:switch-off"),
			{ ts: "2026-09-28T06:00:00.000Z", event: "care", step: "fix", result: "started", number: 8, pr: { number: 19, url: "https://github.com/yjacket/omo-health/pull/19" } },
			{ ts: "2026-09-28T07:00:00.000Z", event: "config", result: "applied", changed: [{ key: "actions.kill", from: true, to: false }], fileMtimeMs: 1 },
			"{not json",
		]);
		const history = uiState({ paths: home.paths, env: home.env, now: NOW }).history;

		it("folds opened and resolved D14 events into one finding row", () => {
			assert.equal(history.findings.length, 1);
			const row = history.findings[0];
			assert.equal(row.key, "D14/outside-workspace");
			assert.equal(row.opened, 5);
			assert.equal(row.resolved, 2);
			assert.equal(row.samples.length, 5);
			assert.equal(row.perDay.reduce((a, b) => a + b, 0), 5);
			assert.equal(row.samples[0].ts, Date.parse("2026-09-28T02:00:00.000Z"));
			assert.equal(row.samples[0].sessionShort, "01a0ea7f");
		});

		it("counts kill-pids results by result", () => {
			const row = history.actions.find((a) => a.kind === "kill-pids");
			assert.equal(row.total, 4);
			assert.deepEqual(row.results.map((r) => [r.result, r.count]), [["execute", 2], ["skipped:switch-off", 1], ["would", 1]]);
			assert.match(row.samples[0].detail, /killed 11/);
		});

		it("counts a care event of an older version under other and routes config events to configChanges", () => {
			assert.equal(history.care, undefined);
			assert.equal(history.other.events.care, 1);
			assert.equal(history.configChanges.length, 1);
			assert.equal(history.configChanges[0].changed[0].key, "actions.kill");
		});

		it("drops the corrupt line and the entry from 8 days ago", () => {
			assert.equal(history.total, 13);
			assert.equal(history.days.length, 7);
			assert.equal(history.days[6].iso, "2026-09-29");
			assert.equal(history.days[0].iso, "2026-09-23");
		});
	});

	it("counts unparseable entries under other and drops out-of-window ones", () => {
		const inWindow = new Date(NOW - 3600_000).toISOString();
		const history = buildHistory([{ event: "opened", ts: "garbage" }, 42, { event: "custom", ts: inWindow }, { event: "opened", detector: "D14", kind: "x", ts: new Date(NOW - 8 * DAY).toISOString() }], NOW);
		assert.equal(history.total, 1);
		assert.equal(history.other.malformed, 2);
		assert.equal(history.other.events.custom, 1);
		assert.equal(history.skipped.outOfWindow, 1);
		assert.deepEqual(history.findings, []);
	});

	it("keeps __proto__ event names as plain counts", () => {
		const history = buildHistory([{ event: "__proto__", ts: new Date(NOW).toISOString() }], NOW);
		assert.equal(Object.hasOwn(history.other.events, "__proto__"), true);
		assert.equal(history.other.events.__proto__, 1);
	});

	describe("settings.applied", () => {
		const home = makeHome();
		write(home.paths.health.configFile, { footer: { showAll: true } });
		const mtime = fs.statSync(home.paths.health.configFile).mtimeMs;
		const applied = (hbExtra) => buildSettings(running(home, hbExtra)).applied;

		it("is daemon-off when the daemon is not running", () => {
			assert.equal(buildSettings(inputsOf(home)).applied.state, "daemon-off");
		});
		it("is unknown when the heartbeat has no config receipt", () => {
			assert.equal(applied({}).state, "unknown");
		});
		it("is rejected with the last-good wording when the daemon runs on the last good copy", () => {
			const a = applied({ config: { source: "last-good", fileMtimeMs: null, rejected: { source: "user", error: "e", fileMtimeMs: mtime, atMs: NOW } } });
			assert.equal(a.state, "rejected");
			assert.equal(a.stateKo, "config.json을 읽을 수 없어 마지막 정상 사본으로 동작 중");
		});
		it("is rejected with the keep-previous wording for any other source", () => {
			const a = applied({ config: { source: "file", fileMtimeMs: mtime - 5000, rejected: { source: "user", error: "e", fileMtimeMs: mtime, atMs: NOW } } });
			assert.equal(a.state, "rejected");
			assert.equal(a.stateKo, "config.json을 읽을 수 없어 직전 설정을 유지하고 있습니다");
		});
		it("is applied when the daemon applied the current mtime", () => {
			const a = applied({ config: { source: "file", fileMtimeMs: mtime, loadedMs: NOW - 1000, rejected: null } });
			assert.equal(a.state, "applied");
			assert.equal(a.daemonFileMtimeMs, mtime);
			assert.equal(a.loadedMs, NOW - 1000);
		});
		it("is pending when the file changed after the daemon applied it", () => {
			assert.equal(applied({ config: { source: "file", fileMtimeMs: mtime - 5000, rejected: null } }).state, "pending");
		});
	});

	describe("settings.overriddenBy", () => {
		const home = makeHome();
		const switchOf = (inputs, key) => buildSettings(inputs).switches.find((s) => s.key === key);

		it("flags a --shadow daemon on the mode switch", () => {
			const s = switchOf(running(home, { mode: "shadow", config: { modeOverride: "shadow", effective: { mode: "shadow" } } }), "mode");
			assert.equal(s.value, "auto");
			assert.equal(s.effective, "shadow");
			assert.equal(s.overriddenBy, "shadow-flag");
			assert.equal(typeof s.overriddenKo, "string");
		});
		it("flags an extra config file that changes the effective value", () => {
			const s = switchOf(running(home, { config: { extra: { file: "x.json", fileMtimeMs: 1 }, effective: { "actions.kill": false } } }), "actions.kill");
			assert.equal(s.overriddenBy, "extra-config");
		});
	});

	describe("settings warnings", () => {
		const settingsFor = (content, lastGood) => {
			const home = makeHome();
			write(home.paths.health.configFile, content);
			if (lastGood) write(home.paths.health.configLastGoodFile, lastGood);
			return { settings: uiState({ paths: home.paths, env: home.env, now: NOW }).settings, paths: home.paths };
		};

		it("reports an unknown key", () => {
			const { settings } = settingsFor({ nope: 1 });
			assert.ok(settings.warnings.some((w) => w.includes("nope")));
			assert.deepEqual(settings.unreadable, []);
		});
		it("reports an invalid enum value and keeps the default", () => {
			const { settings } = settingsFor({ mode: "observe" });
			assert.ok(settings.warnings.some((w) => w.includes("mode")));
			assert.equal(settings.switches.find((s) => s.key === "mode").value, "auto");
		});
		it("reports a broken file as unreadable", () => {
			const { settings, paths } = settingsFor("{");
			assert.deepEqual(settings.unreadable.map((u) => u.file), [paths.health.configFile]);
			assert.equal(settings.usedLastGood, false);
		});
		it("reports the last good copy in use for a broken file", () => {
			const { settings, paths } = settingsFor("{", { footer: { showAll: true } });
			assert.equal(settings.usedLastGood, true);
			assert.equal(settings.unreadable.length, 1);
			assert.ok(settings.warnings.some((w) => w.includes(paths.health.configLastGoodFile)));
			assert.equal(settings.switches.find((s) => s.key === "footer.showAll").value, true);
		});
	});

	describe("settings numbers", () => {
		const CLAUDE = "anthropic-subscription/default:claude:7d";
		const CODEX = "chatgpt-subscription/default:codex:primary";
		const GONE = "gone/default:old:1d";
		/** The rows without their labels: what the page sends back and what it compares. */
		const rowsOf = (settings) => settings.sessionDay.rows.map(({ window, cells }) => ({ window: window ?? null, cells }));

		it("lays out the USD pair, the default percent pair, one row per snapshot window and a leftover override", () => {
			const home = makeHome();
			write(home.paths.health.configFile, { budget: { sessionDayPercent: 15, windows: { [CLAUDE]: { sessionDayInvestigatePercent: 7.5 }, [GONE]: { sessionDayPercent: 30 } } } });
			const windows = [
				{ account: "anthropic-subscription/default", windowId: "claude:7d", label: "7d", scope: null, sessionDay: { active: true, p95Percent: 3.2 } },
				{ account: "chatgpt-subscription/default", windowId: "codex:primary", label: "primary", sessionDay: { active: false, p95Percent: null } },
				{ account: "", windowId: "nameless" },
				"junk",
			];
			const settings = buildSettings(inputsOf(home, { budgetSnapshot: { treasury: { windows } } }));
			const cell = (key, value, def, applied = value) => ({ key, value, default: def, applied, shadowed: false });
			const over = (window, investigate, owner) => [
				{ key: "sessionDayInvestigatePercent", window, value: investigate, applied: investigate ?? 0, shadowed: false },
				{ key: "sessionDayPercent", window, value: owner, applied: owner ?? 15, shadowed: false },
			];
			assert.deepEqual(rowsOf(settings), [
				{ window: null, cells: [cell("budget.sessionDayInvestigateUsd", 100, 100), cell("budget.sessionDayUsd", 200, 200)] },
				{ window: null, cells: [cell("budget.sessionDayInvestigatePercent", 0, 0), cell("budget.sessionDayPercent", 15, 0)] },
				{ window: { name: CLAUDE, account: "anthropic-subscription/default", windowId: "claude:7d", label: "7d", scope: null, active: true, p95Percent: 3.2 }, cells: over(CLAUDE, 7.5, null) },
				{ window: { name: CODEX, account: "chatgpt-subscription/default", windowId: "codex:primary", label: "primary", scope: null, active: false, p95Percent: null }, cells: over(CODEX, null, null) },
				{ window: { name: GONE, missing: true }, cells: over(GONE, null, 30) },
			]);
			assert.equal(settings.sessionDay.levels.length, 2);
		});

		it("offers every number key exactly once and keeps them out of the other-values table", () => {
			const home = makeHome();
			write(home.paths.health.configFile, { budget: { sessionDayUsd: 200, shortMinBurnHours: 3, reservePercent: 11 } });
			const settings = buildSettings(inputsOf(home));
			const offered = [...settings.sessionDay.rows.flatMap((row) => row.cells), ...settings.numbers].map((c) => c.key);
			assert.deepEqual(offered.toSorted(), NUMBER_KEYS.toSorted());
			assert.deepEqual(settings.numbers.map(({ key, value, default: def, applied }) => ({ key, value, default: def, applied })), [{ key: "budget.shortMinBurnHours", value: 3, default: 6, applied: 3 }]);
			assert.deepEqual(settings.others.map((o) => o.key), ["budget.reservePercent"]);
		});

		it("shows config.json's own value and marks the one an extra config file puts in force", () => {
			const home = makeHome();
			const extra = path.join(home.paths.healthHome, "extra.json");
			write(home.paths.health.configFile, { budget: { sessionDayPercent: 15 } });
			write(extra, { budget: { sessionDayPercent: 20, windows: { [CLAUDE]: { sessionDayInvestigatePercent: 9 } } } });
			const settings = buildSettings(loadUiInputs({ paths: home.paths, env: { ...home.env, OMO_HEALTH_CONFIG: extra }, now: NOW }));
			assert.deepEqual(rowsOf(settings).slice(1, 3), [
				{
					window: null,
					cells: [
						{ key: "budget.sessionDayInvestigatePercent", value: 0, default: 0, applied: 0, shadowed: false },
						{ key: "budget.sessionDayPercent", value: 15, default: 0, applied: 20, shadowed: true },
					],
				},
				{
					window: { name: CLAUDE, missing: true },
					cells: [
						{ key: "sessionDayInvestigatePercent", window: CLAUDE, value: null, applied: 9, shadowed: true },
						{ key: "sessionDayPercent", window: CLAUDE, value: null, applied: 20, shadowed: true },
					],
				},
			]);
		});
	});

	describe("daemon state", () => {
		const home = makeHome();
		const stateOf = (overrides) => buildOverview(inputsOf(home, overrides)).daemon;
		const cases = [
			["stopped", { stopped: true, heartbeat: heartbeat(), pidAlive: true }],
			["off", { heartbeat: null }],
			["running", { heartbeat: heartbeat(), pidAlive: true }],
			["stale", { heartbeat: heartbeat({ ts: NOW - 60_000 }), pidAlive: true }],
			["crashed", { heartbeat: heartbeat(), pidAlive: false }],
		];
		for (const [expected, overrides] of cases) {
			it(`is ${expected}`, () => assert.equal(stateOf(overrides).state, expected));
		}
		it("is off with a Korean exit reason after a clean stop", () => {
			const daemon = stateOf({ heartbeat: heartbeat({ stoppedMs: NOW - 5000, exitReason: "idle-no-omo-hosts" }), pidAlive: false });
			assert.equal(daemon.state, "off");
			assert.equal(daemon.exitReasonKo, EXIT_REASON_LABELS["idle-no-omo-hosts"]);
		});
		it("marks a running shadow daemon under an auto config as mode-overridden", () => {
			assert.equal(stateOf({ heartbeat: heartbeat({ mode: "shadow" }), pidAlive: true }).modeOverridden, true);
			assert.equal(stateOf({ heartbeat: heartbeat(), pidAlive: true }).modeOverridden, false);
		});
	});

	it("reports the remaining pause time", () => {
		const home = makeHome();
		write(home.paths.health.pauseFile, { untilMs: NOW + 600_000, byCli: true });
		const { pause } = uiState({ paths: home.paths, env: home.env, now: NOW }).overview;
		assert.equal(pause.active, true);
		assert.equal(pause.remainingMs, 600_000);
	});

	it("isolates a section builder failure to that section", () => {
		const home = makeHome();
		const state = buildUiState({ ...loadUiInputs({ paths: home.paths, env: home.env, now: NOW }), decisions: { error: "EACCES" } });
		assert.deepEqual(state.history, { error: "EACCES" });
		assert.equal(state.overview.error, undefined);
	});

	it("keeps SWITCHES in SWITCH_KEYS order", () => {
		assert.deepEqual(SWITCHES.map((s) => s.key), [...SWITCH_KEYS]);
	});

	describe("tokens and preferences from the daemon's usage index", () => {
		const MAIN = "01a20000-0000-7000-8000-000000000001";
		const totals = (total, extra = {}) => ({ total, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, costUnknown: false, turns: 1, ...extra });
		const entry = (id, extra = {}) => ({ id, state: "ok", complete: true, gone: false, published: totals(100), ...extra });
		const usageLine = (total) => `${JSON.stringify({ type: "usage", provider: "fixture", model: "fixture", usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } })}\n`;
		/** Write the index as the daemon does: a complete read per session file, a byte-capped read for `maxBytes`, and `markMissing` for `state: "missing"`. */
		const writeUsage = (paths, specs) => {
			const dir = path.join(paths.health.sessionsDir, "index-fixtures");
			fs.mkdirSync(dir, { recursive: true });
			const index = createUsageIndex({ file: paths.health.usageIndexFile, clock: createFakeClock(NOW) });
			for (const spec of specs) {
				if (spec.state === "missing") {
					index.markMissing(sub(spec.id), spec.meta ?? {});
					continue;
				}
				const file = path.join(dir, `${spec.id}.jsonl`);
				write(file, usageLine(spec.total ?? 100));
				index.update(sub(spec.id, spec.cwd), file, spec.meta ?? {}, spec.maxBytes ? { maxBytes: spec.maxBytes } : {});
			}
			index.save();
		};
		const row = (sessionId, endedMs, extra = {}) => ({ v: 1, sessionId, kind: "main", parentSessionId: null, taskId: null, title: sessionId, cwd: null, terminal: null, omoVersion: null, startedMs: endedMs - 60_000, endedMs, outcome: "closed", reason: null, childCount: 0, estimated: false, source: "live", ...extra });
		const writeRows = (paths, rows) => write(path.join(paths.health.sessionsDir, "ended-2026-09-29.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const endedRows = (home) => new Map(uiState({ paths: home.paths, env: home.env, now: NOW }).ended.rows.map((r) => [r.sessionId, r]));

		it("passes board tokens, tree tokens and pending through, with a malformed number becoming null", () => {
			const home = makeHome();
			write(home.paths.health.sessionsSnapshotFile, {
				v: 1,
				ts: NOW,
				groups: [
					{
						omoVersion: "5.1.19",
						sessions: [
							{
								sessionId: MAIN,
								title: "main",
								tokens: { total: 120, input: 7, output: "NaN", cacheRead: "x", cacheWrite: 4, cost: 0.2, costUnknown: true, turns: 3 },
								treeTokens: 400,
								tokensPending: false,
								children: [{ taskId: "st_1", name: "child", tokens: { total: 80, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, costUnknown: false, turns: 2 }, treeTokens: 90, tokensPending: true, children: [] }],
							},
							{ sessionId: "01a20000-0000-7000-8000-000000000002", title: "untracked" },
						],
					},
				],
			});
			const [main, untracked] = uiState({ paths: home.paths, env: home.env, now: NOW }).sessions.groups[0].sessions;
			assert.deepEqual(main.tokens, { total: 120, input: 7, output: null, cacheRead: null, cacheWrite: 4, cost: 0.2, costUnknown: true, turns: 3 });
			assert.equal(main.treeTokens, 400);
			assert.equal(main.tokensPending, false);
			const [child] = main.children;
			assert.equal(child.tokens.total, 80);
			assert.equal(child.treeTokens, 90);
			assert.equal(child.tokensPending, true);
			assert.equal(untracked.tokens, null);
			assert.equal(untracked.treeTokens, null);
			assert.equal(untracked.tokensPending, false);
		});

		it("marks an ended row ok, pending (incomplete or unindexed) or missing", () => {
			const home = makeHome();
			writeUsage(home.paths, [
				{ id: "ok", total: 100 },
				{ id: "incomplete", maxBytes: 1 },
				{ id: "missing", state: "missing" },
			]);
			writeRows(home.paths, [row("ok", NOW - 1000), row("incomplete", NOW - 2000), row("missing", NOW - 3000), row("unindexed", NOW - 4000)]);
			const rows = endedRows(home);
			assert.equal(rows.get("ok").tokensState, "ok");
			assert.equal(rows.get("ok").tokens.total, 100);
			assert.equal(rows.get("ok").tokensGone, false);
			assert.equal(rows.get("incomplete").tokensState, "pending");
			assert.equal(rows.get("incomplete").tokens, null);
			assert.equal(rows.get("missing").tokensState, "missing");
			assert.equal(rows.get("missing").tokens, null);
			assert.equal(rows.get("unindexed").tokensState, "pending");
		});

		it("does not use a taskId alias when the session id does not match", () => {
			const home = makeHome();
			writeUsage(home.paths, [{ id: "01a20000-0000-7000-8000-0000000000aa", total: 100, meta: { taskId: "st_alias" } }]);
			writeRows(home.paths, [row("01a20000-0000-7000-8000-0000000000bb", NOW - 1000, { taskId: "st_alias" })]);
			const [r] = uiState({ paths: home.paths, env: home.env, now: NOW }).ended.rows;
			assert.equal(r.tokensState, "pending");
			assert.equal(r.tokens, null);
		});

		it("resolves only a unique taskId alias for a history row without a session id", () => {
			const r = row(null, NOW - 1000, { kind: "child", taskId: "st_x" });
			const entry = { id: "a", taskId: "st_x", state: "ok", complete: true, published: { total: 100 } };
			const index = new Map([[key("a"), entry]]);
			assert.equal(endedRow(r, 0, index).tokens.total, 100);
			index.set("b", { ...entry, id: "b" });
			assert.equal(endedRow(r, 0, index).tokensState, "pending");
		});

		it("(plan 34) ended task-only rows compete even when only one is indexed", () => {
			const home = makeHome();
			const taskId = "st_shared";
			const cwd = home.paths.healthHome;
			const parentProjectKey = sub("main-a", cwd).projectKey;
			writeUsage(home.paths, [
				{ id: taskId, meta: { kind: "child", taskId } },
				{ id: "child-session", total: 75, meta: { kind: "child", taskId } },
				{ id: "main-a", total: 100 },
				{ id: "main-b", total: 100 },
				{ id: "counted-a", total: 20, meta: { parentSessionId: "main-a" } },
				{ id: "counted-b", total: 20, meta: { parentSessionId: "main-b" } },
			].map((spec) => ({ ...spec, cwd })));
			writeRows(home.paths, [
				row(taskId, NOW - 1000, { kind: "child", taskId, parentSessionId: "main-a", parentProjectKey, title: "task A" }),
				row(taskId, NOW - 2000, { kind: "child", taskId, parentSessionId: "main-b", parentProjectKey, title: "task B" }),
				row("child-session", NOW - 3000, { kind: "child", taskId, parentSessionId: "main-c", title: "session" }),
				row("main-a", NOW - 4000),
				row("main-b", NOW - 5000),
			].map((entry) => ({ ...entry, cwd })));
			const { rows } = uiState({ paths: home.paths, env: home.env, now: NOW }).ended;
			assert.deepEqual(rows.filter((r) => r.kind === "child").map((r) => [r.title, r.tokens?.total ?? null]), [["task A", null], ["task B", null], ["session", 75]]);
			assert.deepEqual(rows.filter((r) => r.kind === "main").map((r) => [r.sessionId, r.treeTokens, r.treeTokensComplete]),
				[["main-a", 120, false], ["main-b", 120, false]]);
		});

		it("keeps the last total of a complete entry whose file was then deleted, and marks a never-found row missing", () => {
			const home = makeHome();
			const file = path.join(home.paths.health.sessionsDir, "session.jsonl");
			write(file, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } } } })}\n`);
			const index = createUsageIndex({ file: home.paths.health.usageIndexFile, clock: createFakeClock(NOW) });
			assert.ok(index.update(sub("read"), file, { kind: "main" }) > 0);
			assert.equal(index.update(sub("never"), path.join(home.paths.health.sessionsDir, "absent.jsonl"), { kind: "main" }), 0);
			fs.rmSync(file);
			assert.equal(index.update(sub("read"), file), 0);
			index.save();
			writeRows(home.paths, [row("read", NOW - 1000), row("never", NOW - 2000)]);
			const rows = endedRows(home);
			assert.equal(rows.get("read").tokensState, "ok");
			assert.equal(rows.get("read").tokens.total, 10);
			assert.equal(rows.get("read").tokens.cost, 0.1);
			assert.equal(rows.get("read").tokensGone, true);
			assert.equal(rows.get("never").tokensState, "missing");
			assert.equal(rows.get("never").tokens, null);
			assert.equal(rows.get("never").tokensGone, false);
		});

		it("shows a tree total only when descendants add tokens", () => {
			const home = makeHome();
			writeUsage(home.paths, [
				{ id: "m", total: 100 },
				{ id: "c", total: 50, meta: { kind: "child", taskId: "st_c", parentSessionId: "m" } },
				{ id: "g", total: 25, meta: { kind: "child", taskId: "st_g", parentSessionId: "c", parentKey: subjectKey(subjectOf({ sessionId: "c", taskId: "st_c" })) } },
			]);
			writeRows(home.paths, [
				row("m", NOW - 1000),
				row("c", NOW - 2000, { kind: "child", parentSessionId: "m", taskId: "st_c" }),
				row("g", NOW - 3000, { kind: "child", parentSessionId: "c", taskId: "st_g" }),
			]);
			const rows = endedRows(home);
			assert.equal(rows.get("m").tokens.total, 100);
			assert.equal(rows.get("m").treeTokens, 175);
			assert.equal(rows.get("c").treeTokens, 75);
			assert.equal(rows.get("g").tokens.total, 25);
			assert.equal(rows.get("g").treeTokens, null);
		});

		it("caps 600 main and 600 child rows to 500 each and reports shown and totals, merged newest first", () => {
			const home = makeHome();
			const rows = [];
			for (let i = 0; i < 600; i += 1) {
				const id = String(i).padStart(3, "0");
				rows.push(row(`m${id}`, NOW - 10_000 - i * 1000));
				rows.push(row(`c${id}`, NOW - 10_500 - i * 1000, { kind: "child", parentSessionId: `m${id}`, taskId: `st_${i}` }));
			}
			writeRows(home.paths, rows);
			const ended = uiState({ paths: home.paths, env: home.env, now: NOW }).ended;
			assert.equal(ended.limit, 500);
			assert.deepEqual(ended.limits, { main: 500, child: 500 });
			assert.deepEqual(ended.shown, { main: 500, child: 500 });
			assert.deepEqual(ended.totals, { main: 600, child: 600 });
			assert.equal(ended.total, 1200);
			assert.equal(ended.rows.length, 1000);
			assert.equal(ended.rows.filter((r) => r.kind === "main").length, 500);
			assert.equal(ended.rows.filter((r) => r.kind === "child").length, 500);
			assert.equal(ended.rows[0].sessionId, "m000");
			for (let i = 1; i < ended.rows.length; i += 1) assert.ok(ended.rows[i - 1].endedMs >= ended.rows[i].endedMs);
			assert.ok(ended.rows.some((r) => r.sessionId === "m499"));
			assert.ok(ended.rows.some((r) => r.sessionId === "c499"));
			assert.equal(ended.rows.some((r) => r.sessionId === "m599"), false);
			assert.equal(ended.rows.some((r) => r.sessionId === "c599"), false);
		});

		it("carries the stored preference and the empty-home default", () => {
			const home = makeHome();
			assert.deepEqual(uiState({ paths: home.paths, env: home.env, now: NOW }).prefs, { hideChildren: false });
			write(home.paths.health.uiPrefsFile, { v: 1, hideChildren: true });
			assert.deepEqual(uiState({ paths: home.paths, env: home.env, now: NOW }).prefs, { hideChildren: true });
		});

		it("loads the daemon inputs without reading decisions and reports the same status", () => {
			const home = makeHome();
			write(home.paths.health.daemonJson, heartbeat({ pid: process.pid }));
			write(home.paths.health.stoppedFile, "");
			const daemon = loadDaemonInputs({ paths: home.paths, env: home.env, now: NOW });
			assert.deepEqual(Object.keys(daemon).sort(), ["heartbeat", "loaded", "now", "pidAlive", "stopped"]);
			assert.equal(daemon.now, NOW);
			assert.equal(daemon.stopped, true);
			assert.equal(daemon.pidAlive, true);
			assert.equal("decisions" in daemon, false);
			const status = daemonStatus(daemon);
			assert.equal(status.state, "stopped");
			assert.equal(status.heartbeatAgeMs, 10_000);
		});

		it("exports the row builders for the session detail", () => {
			const r = endedRow(row(MAIN, NOW), 0, new Map([[key(MAIN), entry(MAIN)]]), new Map([[key(MAIN), 250]]));
			assert.equal(r.sessionId, MAIN);
			assert.equal(r.tokens.total, 100);
			assert.equal(r.treeTokens, 250);
		});
	});
});
