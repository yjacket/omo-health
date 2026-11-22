import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { SWITCH_KEYS } from "../src/config.mjs";
import { SWITCHES } from "../src/control.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { appendEnded } from "../src/session-ledger.mjs";
import { loadSessionRecord } from "../src/session-record.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { createUsageIndex, readUsageIndex, USAGE_INDEX_VERSION } from "../src/usage-index.mjs";
import { ACTION_LABELS, EXIT_REASON_LABELS, GOAL_STATUS_LABELS, INVESTIGATION_STATUS_LABELS, OUTCOME_LABELS, SESSION_STATE_LABELS, TASK_STATUS_LABELS, TERMINAL_LABELS, TRIGGER_LABELS } from "../src/ui/labels.mjs";
import { buildHistory } from "../src/ui/history.mjs";
import { buildEnded, buildOverview, buildSessions, buildSettings, buildUiState, daemonStatus, endedRow, loadDaemonInputs, loadUiInputs, uiState } from "../src/ui/model.mjs";
import { buildSessionView } from "../src/ui/session-view.mjs";
import { buildSessionSnapshot } from "../src/session-board.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
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

it("(plan 35) history adds a detail selector only to shared session IDs", () => {
	const shared = { sessionId: "st_shared", taskId: "st_shared", kind: "child" };
	const { rows } = buildEnded({ now: NOW, ended: [
		{ ...shared, endedMs: NOW, parentSessionId: "b" },
		{ sessionId: "unique", endedMs: NOW - 1 },
		{ ...shared, endedMs: NOW - 2, parentSessionId: "a" },
	] });
	assert.deepEqual(rows.map((r) => [r.sessionId, r.detailEndedMs]), [
		["st_shared", NOW], ["unique", undefined], ["st_shared", NOW - 2],
	]);
	assert.equal(Object.hasOwn(rows[1], "detailEndedMs"), false);
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
		["endedDetailId", "endedDetailUrl", "endedItem", "loadEndedDetail", "loadEndedPage"]
			.map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\t\\}`))?.[0]).join("\n") +
			"\n({ endedItem, loadEndedPage })",
		{
			el, openEnded, endedDetails, drawEndedDetail() {}, ENDED_COLUMNS: Array(6).fill("column"), cellClass() {},
			when() {}, endedSessionCell() {}, outcomeMark() {}, endedTokenCell() {}, show() {},
			append: (body, children) => Object.assign(body, { children }),
			getJson: (url) => { urls.push(url); return { messages: [], counts: { messages: 1 } }; },
			gone: false, busy: new Set(), errors: new Map(), detailList: (data, name) => data[name],
		},
	);
	const rows = [
		{ sessionId: "st_shared", endedMs: NOW, detailEndedMs: NOW },
		{ sessionId: "st_shared", endedMs: NOW - 1, detailEndedMs: NOW - 1 },
		{ sessionId: "unique", endedMs: NOW },
	];
	const items = rows.map(endedItem);
	assert.deepEqual(items.map(({ children: [row] }) => row.children[0].children[0]["data-key"]),
		[`ended:st_shared:${NOW}`, `ended:st_shared:${NOW - 1}`, "ended:unique"]);
	for (const { children: [row] } of items) row.onclick();
	await Promise.resolve();
	await loadEndedPage(rows[1], "messages");
	assert.deepEqual(urls, [
		`/api/session?id=st_shared&ended=${NOW}`,
		`/api/session?id=st_shared&ended=${NOW - 1}`,
		"/api/session?id=unique",
		`/api/session?id=st_shared&ended=${NOW - 1}&list=messages&offset=0`,
	]);
	assert.equal(openEnded.size, 3);
	assert.equal(endedDetails.size, 3);
});

it("(gate 16) history and board show a dash with the full-index tooltip", () => {
	const id = "full-session";
	const history = endedRow({ sessionId: id }, 0, new Map([[id, { id, state: "full" }]]));
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
	const snapshot = buildSessionSnapshot(world, [], [], NOW, { tokensOf: (id) => (id === "m-full" || id === "c-full" ? { state: "full" } : null) });
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

function overflowIndex(paths, rows) {
	const file = paths.health.usageIndexFile;
	const index = createUsageIndex({ file, clock: createFakeClock(NOW) });
	for (const [id, input, parentSessionId] of rows) {
		const transcript = path.join(path.dirname(file), `${id}.jsonl`);
		write(transcript, `{"type":"usage","provider":"p","model":"m","usage":{"input":${input}}}\n`);
		index.update(id, transcript, { parentSessionId: parentSessionId ?? null });
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
	const index = overflowIndex(paths, [["main", "1e309"], ["child", "1e309", "main"], ["finite", "5"], ["negative", "-1e309", "finite"]]);
	const tracker = createUsageTracker({ paths, index, clock: createFakeClock(NOW) });
	assert.equal(tracker.tokensOf("main").tokens.total, Infinity);
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
	index.markMissing("missing-child", { kind: "child", parentSessionId: "missing" });
	index.save();
	const history = new Map(JSON.parse(JSON.stringify(uiState({ paths, env, now: NOW }))).ended.rows.map((row) => [row.sessionId, row]));
	const { endedTokenCell } = tokenFormatters("endedTokenCell");
	assert.deepEqual(rows.map(([id]) => {
		const row = history.get(id);
		return [row.treeTokens, endedTokenCell(row).children[1]?.text];
	}), [[10, rows[0][2]], [7, rows[1][2]], [null, rows[2][2]]]);
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

	index.markMissing("old");
	assert.equal(index.prune(NOW + DAY, 0), 1);
	index.update("root", transcript);
	index.update("child", transcript, { parentSessionId: "root" });
	index.save();
	const recovered = view();
	assert.equal(recovered.tokens.total, 42);
	assert.equal(recovered.children[0].tokens.total, 42);
});

describe("ui model", () => {
	it("returns every section without throwing for an empty home", () => {
		const home = makeHome();
		const state = uiState({ paths: home.paths, env: home.env, now: NOW });
		assert.deepEqual(Object.keys(state), ["generatedMs", "version", "sessions", "ended", "overview", "investigations", "history", "settings", "prefs"]);
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

		it("a session recorded with childCount 0 shows the ended child rows that name it as parent; a larger recorded count stays", () => {
			const home = makeHome();
			const child = (n, parent) => record(`c${n}`, "answered", NOW - 2 * HOUR - n * 60_000, { kind: "child", parentSessionId: parent, taskId: `st_${n}` });
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
					index.markMissing(spec.id, spec.meta ?? {});
					continue;
				}
				const file = path.join(dir, `${spec.id}.jsonl`);
				write(file, usageLine(spec.total ?? 100));
				index.update(spec.id, file, spec.meta ?? {}, spec.maxBytes ? { maxBytes: spec.maxBytes } : {});
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
			const index = new Map([["a", entry]]);
			assert.equal(endedRow(r, 0, index).tokens.total, 100);
			index.set("b", { ...entry, id: "b" });
			assert.equal(endedRow(r, 0, index).tokensState, "pending");
		});

		it("(plan 34) ended task-only rows compete even when only one is indexed", () => {
			const home = makeHome();
			const taskId = "st_shared";
			writeUsage(home.paths, [
				{ id: taskId, meta: { kind: "child", taskId } },
				{ id: "child-session", total: 75 },
			]);
			writeRows(home.paths, [
				row(taskId, NOW - 1000, { kind: "child", taskId, parentSessionId: "main-a", title: "task A" }),
				row(taskId, NOW - 2000, { kind: "child", taskId, parentSessionId: "main-b", title: "task B" }),
				row("child-session", NOW - 3000, { kind: "child", taskId, parentSessionId: "main-c", title: "session" }),
			]);
			const { rows } = uiState({ paths: home.paths, env: home.env, now: NOW }).ended;
			assert.deepEqual(rows.map((r) => [r.title, r.tokens?.total ?? null]), [["task A", null], ["task B", null], ["session", 75]]);
		});

		it("keeps the last total of a complete entry whose file was then deleted, and marks a never-found row missing", () => {
			const home = makeHome();
			const file = path.join(home.paths.health.sessionsDir, "session.jsonl");
			write(file, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } } } })}\n`);
			const index = createUsageIndex({ file: home.paths.health.usageIndexFile, clock: createFakeClock(NOW) });
			assert.ok(index.update("read", file, { kind: "main" }) > 0);
			assert.equal(index.update("never", path.join(home.paths.health.sessionsDir, "absent.jsonl"), { kind: "main" }), 0);
			fs.rmSync(file);
			assert.equal(index.update("read", file), 0);
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
				{ id: "c", total: 50, meta: { parentSessionId: "m" } },
				{ id: "g", total: 25, meta: { parentSessionId: "c" } },
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
			const r = endedRow(row(MAIN, NOW), 0, new Map([[MAIN, entry(MAIN)]]), new Map([[MAIN, 250]]));
			assert.equal(r.sessionId, MAIN);
			assert.equal(r.tokens.total, 100);
			assert.equal(r.treeTokens, 250);
		});
	});
});
