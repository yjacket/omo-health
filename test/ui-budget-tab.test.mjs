import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as labels from "../src/ui/labels.mjs";

// Runs the real src/ui/static/app.js against the real index.html in a small fake DOM: fetch answers from a seeded state,
// and the page's own setTimeout call (schedule() after every render) is the signal that a render finished.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = path.join(root, "src", "ui", "static");
const NOW = Date.parse("2026-11-12T03:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET = Date.parse("2026-11-17T12:00:00.000Z"); // 11-17 21:00 KST
const CLAUDE = "anthropic-subscription/default";
const CODEX = "chatgpt-subscription/default";
const STAGED_PROJECT = "sid-main:goal-1";
const DENIED_PROJECT = "sid-denied:goal-1";
const BUDGET_MAPS = ["BUDGET_STATE_LABELS", "BUDGET_ACCOUNT_LABELS", "BUDGET_PROJECT_STATUS_LABELS", "AUDIT_ASSESSMENT_LABELS", "AUDIT_STATUS_LABELS", "BUDGET_TRIGGER_LABELS", "BUDGET_AUDIT_DEFERRED_LABELS", "BUDGET_DENIAL_LABELS"];

/* ---------- fake DOM ---------- */

class FakeNode {
	parentNode = null;
}

class FakeText extends FakeNode {
	constructor(text) {
		super();
		this.data = String(text);
	}
	get textContent() {
		return this.data;
	}
}

class FakeElement extends FakeNode {
	constructor(doc, tag) {
		super();
		this.ownerDocument = doc;
		this.localName = tag.toLowerCase();
		this.attrs = new Map();
		this.childNodes = [];
		this.listeners = new Map();
	}
	setAttribute(name, value) {
		this.attrs.set(name, String(value));
	}
	getAttribute(name) {
		return this.attrs.get(name) ?? null;
	}
	hasAttribute(name) {
		return this.attrs.has(name);
	}
	removeAttribute(name) {
		this.attrs.delete(name);
	}
	flag(name, on) {
		if (on) this.setAttribute(name, "");
		else this.removeAttribute(name);
	}
	get id() {
		return this.getAttribute("id") ?? "";
	}
	get className() {
		return this.getAttribute("class") ?? "";
	}
	set className(value) {
		this.setAttribute("class", value);
	}
	get classList() {
		const read = () => this.className.split(/\s+/).filter(Boolean);
		return {
			contains: (c) => read().includes(c),
			toggle: (c, force) => {
				const on = force ?? !read().includes(c);
				this.className = [...read().filter((x) => x !== c), ...(on ? [c] : [])].join(" ");
				return on;
			},
		};
	}
	get dataset() {
		const out = {};
		for (const [key, value] of this.attrs) if (key.startsWith("data-")) out[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
		return out;
	}
	get hidden() {
		return this.hasAttribute("hidden");
	}
	set hidden(on) {
		this.flag("hidden", on);
	}
	get disabled() {
		return this.hasAttribute("disabled");
	}
	set disabled(on) {
		this.flag("disabled", on);
	}
	get open() {
		return this.hasAttribute("open");
	}
	set open(on) {
		this.flag("open", on);
	}
	set tabIndex(value) {
		this.setAttribute("tabindex", value);
	}
	get textContent() {
		return this.childNodes.map((n) => n.textContent).join("");
	}
	set textContent(value) {
		this.replaceChildren(String(value));
	}
	append(...nodes) {
		for (const item of nodes) {
			const node = item instanceof FakeNode ? item : new FakeText(item);
			if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
			node.parentNode = this;
			this.childNodes.push(node);
		}
	}
	replaceChildren(...nodes) {
		for (const child of this.childNodes) child.parentNode = null;
		this.childNodes = [];
		this.append(...nodes);
	}
	addEventListener(type, fn) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	click() {
		if (this.disabled) return;
		for (const fn of this.listeners.get("click") ?? []) fn({ type: "click", currentTarget: this, target: this, preventDefault() {} });
	}
	focus() {
		this.ownerDocument.activeElement = this;
	}
	querySelectorAll(selector) {
		return descendants(this).filter((n) => matches(n, selector));
	}
}

function descendants(node) {
	return node.childNodes.filter((n) => n instanceof FakeElement).flatMap((n) => [n, ...descendants(n)]);
}

/** The selectors app.js uses: tag, .class, [attr] and :not(.class) compounds, descendant chains and comma lists. */
function matchesCompound(node, compound) {
	const parsed = /^([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+\]|:not\(\.[\w-]+\))*)$/i.exec(compound);
	if (!parsed) throw new Error(`unsupported selector ${compound}`);
	if (parsed[1] && node.localName !== parsed[1].toLowerCase()) return false;
	return (parsed[2].match(/\.[\w-]+|\[[\w-]+\]|:not\(\.[\w-]+\)/g) ?? []).every((part) => {
		if (part.startsWith(".")) return node.classList.contains(part.slice(1));
		if (part.startsWith("[")) return node.hasAttribute(part.slice(1, -1));
		return !node.classList.contains(part.slice(6, -1));
	});
}

function matches(node, selector) {
	return selector.split(",").some((alternative) => {
		const parts = alternative.trim().split(/\s+/);
		if (!matchesCompound(node, parts.at(-1))) return false;
		let i = parts.length - 2;
		for (let up = node.parentNode; up && i >= 0; up = up.parentNode) if (matchesCompound(up, parts[i])) i--;
		return i < 0;
	});
}

const VOID = new Set(["meta", "link", "br", "img", "input"]);

function createDocument(html) {
	const doc = { visibilityState: "visible", addEventListener() {} };
	doc.createElement = (tag) => new FakeElement(doc, tag);
	doc.createElementNS = (_ns, tag) => new FakeElement(doc, tag);
	const top = new FakeElement(doc, "#document");
	const stack = [top];
	for (const m of html.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi)) {
		if (m[1]) {
			while (stack.length > 1 && stack.pop().localName !== m[1].toLowerCase());
		} else if (m[2]) {
			const node = doc.createElement(m[2]);
			for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) node.setAttribute(a[1], a[2] ?? "");
			stack.at(-1).append(node);
			if (!VOID.has(node.localName)) stack.push(node);
		} else if (m[4]?.trim()) stack.at(-1).append(m[4].trim());
	}
	doc.body = descendants(top).find((n) => n.localName === "body");
	doc.activeElement = doc.body;
	doc.getElementById = (id) => descendants(top).find((n) => n.id === id) ?? null;
	doc.querySelectorAll = (selector) => top.querySelectorAll(selector);
	return doc;
}

/* ---------- page harness ---------- */

/** Loads index.html, runs app.js and resolves after the first render. `page.state` is what GET /api/state answers. */
async function openPage(budget) {
	const doc = createDocument(fs.readFileSync(path.join(STATIC, "index.html"), "utf8"));
	const location = { hash: `#t=${"t".repeat(24)}` };
	const storage = new Map();
	const page = { doc, location, state: uiState(budget), posts: [], autoRefresh: null, rendered: null };
	const context = vm.createContext({
		document: doc,
		window: { addEventListener() {} },
		location,
		history: { replaceState: (_state, _title, url) => (location.hash = url.startsWith("#") ? url : "") },
		sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
		Node: FakeNode,
		console,
		clearTimeout() {},
		setTimeout: (fn) => {
			page.autoRefresh = fn;
			const done = page.rendered;
			page.rendered = null;
			done?.();
			return 1;
		},
		fetch: async (url, options = {}) => {
			if (options.method === "POST") page.posts.push({ url, body: JSON.parse(options.body) });
			const body = url === "/api/state" ? page.state : url.startsWith("/api/diagnose") ? { subjects: [] } : { ok: true };
			return { ok: true, status: 200, json: async () => structuredClone(body) };
		},
	});
	/** Resolves when the page has rendered the state after `action` (the page schedules its next refresh last). */
	page.after = (action) => {
		const done = new Promise((resolve) => (page.rendered = resolve));
		action();
		return done;
	};
	await page.after(() => vm.runInContext(fs.readFileSync(path.join(STATIC, "app.js"), "utf8"), context, { filename: "app.js" }));
	return page;
}

function uiState(budget) {
	const failed = { error: "not part of this test" };
	return { generatedMs: NOW, version: "test", overview: failed, sessions: failed, ended: failed, investigations: failed, history: failed, settings: failed, budget };
}

const byClass = (node, cls) => descendants(node).filter((n) => n.classList.contains(cls));
const text = (node) => node.textContent.replace(/\s+/g, " ").trim();
const chipText = (node) => byClass(node, "chip").map(text);
const buttonNamed = (node, name) => descendants(node).find((n) => n.localName === "button" && text(n) === name);
const rowsOf = (page, cardId) => descendants(page.doc.getElementById(`${cardId}-body`)).filter((n) => n.localName === "tr" && n.parentNode.localName === "tbody");

/* ---------- seeded snapshot (C-office shape) ---------- */

const windowState = (o) => ({
	account: CLAUDE,
	windowId: "claude:7d",
	label: "7d",
	scope: null,
	usedPercent: 70,
	resetsAtMs: RESET,
	hoursLeft: 129,
	reservePercent: 12,
	committedPercent: 8,
	freePercent: 10,
	burnPerHour: 0.2,
	projectedAtResetPercent: 95.8,
	safeDailyPercent: 3.35,
	state: "tight",
	stale: false,
	calibrated: true,
	percentPerUsd: 0.05,
	calibrationHigh: 0.06,
	coupons: 1,
	updatedMs: NOW - 3 * MIN,
	error: null,
	calibrationIntervals: 12,
	...o,
});

const project = (o) => ({ id: "sid:goal", sessionId: "sid-0123456789", objective: "objective", status: "approved", revision: 1, spentUsd: 12.4, mainUsd: 9.1, childUsd: 3.3, auditUsd: 0, missing: 0, approvedUsd: 30, estimate: { p10: 9, p50: 12, p90: 20 }, reserveUsd: 30, stage: null, indicators: null, triggers: [], lastAudit: null, rounds: [], ...o });

const audit = (o) => ({ auditId: "a1", projectId: STAGED_PROJECT, ms: NOW - 2 * HOUR, status: "done", model: "chatgpt-subscription/gpt-6-astra:high", assessment: "waste-likely", advice: "Rounds 6-8 repeat the QA rerun.\nSecond line.", costUsd: 1.84, ...o });

function snapshot({ windows, projects, audits, ingest, events } = {}) {
	return {
		v: 1,
		updatedMs: NOW,
		enabled: true,
		ingest: ingest ?? null,
		treasury: {
			state: "short",
			windows: windows ?? [
				windowState({}),
				windowState({ windowId: "claude:7d_fable", scope: "fable", usedPercent: 12, committedPercent: null, freePercent: 76, projectedAtResetPercent: null, safeDailyPercent: 14.1, state: "ok", calibrated: false, calibrationIntervals: 3 }),
				windowState({ account: CODEX, windowId: "codex:primary", usedPercent: 77, hoursLeft: 40.25, committedPercent: null, freePercent: 11, projectedAtResetPercent: null, safeDailyPercent: 6.6, state: "unknown", stale: true, error: "http-500", calibrated: false, calibrationIntervals: 0, coupons: 0, updatedMs: NOW - 2 * MIN }),
			],
			external: {},
		},
		projects: projects ?? [
			project({ id: STAGED_PROJECT, sessionId: "sid-staged", objective: "Export QA", status: "approved", revision: 2, spentUsd: 41.5, mainUsd: 18.2, childUsd: 23.3, estimate: { p10: 8, p50: 14, p90: 25 }, stage: { nextCheckpoint: "Export round 4 acceptance" } }),
			project({ id: DENIED_PROJECT, sessionId: "sid-denied", objective: "denied change", status: "approved" }),
		],
		audits: audits ?? [audit({})],
		events: events ?? [{ seq: 2, ms: NOW - 10 * MIN, projectId: DENIED_PROJECT, account: null, kind: "denied", data: { projectId: DENIED_PROJECT, requestId: "chg-3", increaseUsd: 8, reason: "cumulative-cap" } }],
	};
}

/** The rendered text of the IS-1 fields per the plan's short labels, from a window's seeded values (보정 is checked in the foot). */
function expectedFields(w) {
	const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 10) / 10}%` : "-");
	return [
		`사용 ${pct(w.usedPercent)}`,
		"리셋 11-17 21:00 KST",
		`${Math.round(w.hoursLeft * 10) / 10}시간 남음`,
		`예상 ${pct(w.projectedAtResetPercent)}`,
		`예비 ${pct(w.reservePercent)}`,
		Number.isFinite(w.committedPercent) ? `배정 ${pct(w.committedPercent)}` : "배정 미보정",
		`여유 ${pct(w.freePercent)}`,
		`하루 ${pct(w.safeDailyPercent)}`,
		`갱신 ${Math.round((NOW - w.updatedMs) / MIN)}분 전`,
		`리셋권 ${w.coupons}`,
	];
}

/** The source literals of `pattern` in one file, as the producers write them. */
const sourceLiterals = (file, pattern) => [...fs.readFileSync(path.join(root, file), "utf8").matchAll(pattern)].map((m) => m[1]);

describe("dashboard budget tab", { timeout: 20_000 }, () => {
	it("is the fourth tab, and selecting it shows only its panel and remembers it in the hash", async () => {
		const page = await openPage(snapshot());
		const tabs = page.doc.querySelectorAll(".tab");
		assert.deepEqual(
			tabs.map((t) => t.dataset.tab),
			["sessions", "ended", "admin", "budget"],
		);
		tabs[3].click();
		assert.equal(tabs[3].getAttribute("aria-selected"), "true");
		assert.equal(page.location.hash, "#budget");
		assert.deepEqual(
			page.doc.querySelectorAll(".panel").map((p) => [p.dataset.panel, p.hidden]),
			[
				["sessions", true],
				["ended", true],
				["admin", true],
				["budget", false],
			],
		);
		for (const id of ["budget-limits", "budget-projects", "budget-audits"]) assert.equal(page.doc.getElementById(id).hidden, false, id);
	});

	it("shows every IS-1 field of each window row with its seeded values", async () => {
		const seeded = snapshot();
		const page = await openPage(seeded);
		const rows = byClass(page.doc.getElementById("budget-limits-body"), "win");
		assert.equal(rows.length, seeded.treasury.windows.length);
		seeded.treasury.windows.forEach((w, i) => {
			const row = text(rows[i]);
			for (const field of expectedFields(w)) assert.ok(row.includes(field), `window ${w.windowId}: "${field}" in "${row}"`);
			const foot = text(byClass(rows[i], "win__foot")[0]);
			assert.ok(foot.includes(w.calibrated ? `보정 ${w.calibrationIntervals}건` : "미보정"), `window ${w.windowId}: calibration in "${foot}"`);
			assert.equal(text(byClass(rows[i], "win__account")[0]), labels.BUDGET_ACCOUNT_LABELS[w.account]);
			assert.equal(chipText(rows[i])[0], labels.BUDGET_STATE_LABELS[w.state], w.windowId);
			assert.equal(byClass(rows[i], "meter").length, 1, w.windowId);
		});
		assert.equal(text(byClass(rows[1], "win__window")[0]), "7d fable");
		assert.ok(chipText(page.doc.getElementById("budget-limits-body")).includes(`전체 ${labels.BUDGET_STATE_LABELS.short}`));
	});

	it("shows the backfill progress chip beside the treasury state while bytes are pending", async () => {
		const page = await openPage(snapshot({ ingest: { totalBytes: 1000, pendingBytes: 600, files: 2, pendingFiles: 1, updatedMs: NOW } }));
		const head = byClass(page.doc.getElementById("budget-limits-body"), "wrap-row")[0];
		const chips = byClass(head, "chip");
		assert.deepEqual(chips.map(text), [`전체 ${labels.BUDGET_STATE_LABELS.short}`, "수집 중 40%"]);
		assert.equal(chips[1].className, "chip", "a neutral chip, like the other state chips without a tone");
	});

	it("shows no backfill progress chip when nothing is pending or the snapshot has no ingest", async () => {
		for (const ingest of [{ totalBytes: 1000, pendingBytes: 0 }, null]) {
			const page = await openPage(snapshot({ ingest }));
			assert.equal(chipText(page.doc.getElementById("budget-limits-body")).some((c) => c.startsWith("수집 중")), false, JSON.stringify(ingest));
		}
	});

	it("marks a stale window with an error as 모름, 오래됨 and 조회 실패, and a fresh one with none of them", async () => {
		const page = await openPage(snapshot());
		const [fresh, , failed] = byClass(page.doc.getElementById("budget-limits-body"), "win");
		assert.deepEqual(chipText(failed), [labels.BUDGET_STATE_LABELS.unknown, "오래됨", "조회 실패"]);
		assert.ok(failed.classList.contains("win--stale"));
		assert.equal(byClass(failed, "stat--stale").length, 1);
		assert.deepEqual(chipText(fresh), [labels.BUDGET_STATE_LABELS.tight]);
		assert.equal(byClass(fresh, "stat--stale").length, 0);
	});

	it("renders every budget label of labels.mjs unchanged (the page keeps its own copy)", async () => {
		const statuses = Object.keys(labels.BUDGET_PROJECT_STATUS_LABELS);
		const denialReasons = Object.keys(labels.BUDGET_DENIAL_LABELS);
		const assessed = Object.keys(labels.AUDIT_ASSESSMENT_LABELS);
		const unassessed = Object.keys(labels.AUDIT_STATUS_LABELS);
		const accounts = Object.keys(labels.BUDGET_ACCOUNT_LABELS);
		const page = await openPage(
			snapshot({
				windows: Object.keys(labels.BUDGET_STATE_LABELS).map((state, i) => windowState({ state, account: accounts[i % accounts.length], windowId: `w${i}` })),
				projects: [
					...statuses.map((status, i) => project({ id: `p${i}`, status })),
					project({ id: "stage", stage: { nextCheckpoint: "Export round 4 acceptance" } }),
					...denialReasons.map((reason, i) => project({ id: `d${i}`, status: "approved" })),
				],
				audits: [...assessed.map((assessment, i) => audit({ auditId: `a${i}`, assessment })), ...unassessed.map((status, i) => audit({ auditId: `s${i}`, status, assessment: null }))],
				events: denialReasons.map((reason, i) => ({ seq: i + 1, ms: NOW, projectId: `d${i}`, account: null, kind: "denied", data: { projectId: `d${i}`, requestId: `q${i}`, increaseUsd: 5, reason } })),
			}),
		);
		const limits = page.doc.getElementById("budget-limits-body");
		const wins = byClass(limits, "win");
		Object.values(labels.BUDGET_STATE_LABELS).forEach((label, i) => assert.equal(chipText(wins[i])[0], label));
		assert.deepEqual(byClass(limits, "win__account").map(text), Object.keys(labels.BUDGET_STATE_LABELS).map((_, i) => labels.BUDGET_ACCOUNT_LABELS[accounts[i % accounts.length]]));
		const projectRows = rowsOf(page, "budget-projects");
		statuses.forEach((status, i) => assert.equal(chipText(projectRows[i])[0], labels.BUDGET_PROJECT_STATUS_LABELS[status], status));
		const staged = byClass(projectRows[statuses.length], "chip").find((c) => text(c) === labels.BUDGET_STAGE_LABEL);
		assert.ok(staged, "the staged chip is rendered");
		assert.equal(staged.getAttribute("title"), "다음 점검: Export round 4 acceptance");
		denialReasons.forEach((reason, i) => assert.equal(chipText(projectRows[statuses.length + 1 + i]).at(-1), labels.BUDGET_DENIAL_LABELS[reason], reason));
		const auditRows = rowsOf(page, "budget-audits");
		assert.deepEqual(
			auditRows.map((row) => chipText(row)[0]),
			[...Object.values(labels.AUDIT_ASSESSMENT_LABELS), ...Object.values(labels.AUDIT_STATUS_LABELS)],
		);
		const appJs = fs.readFileSync(path.join(STATIC, "app.js"), "utf8");
		for (const name of BUDGET_MAPS) assert.equal((appJs.match(new RegExp(`const ${name} = `, "g")) ?? []).length, 1, name);
		assert.equal((appJs.match(/const BUDGET_STAGE_LABEL = /g) ?? []).length, 1);
	});

	it("labels every state, status, denial reason, assessment and audit status the budget modules produce", () => {
		const cover = (map, values, what) => {
			assert.ok(values.length > 0, `${what}: the producer's values are found`);
			for (const value of values) assert.ok(Object.hasOwn(labels[map], value), `${what} ${value}`);
		};
		cover("BUDGET_STATE_LABELS", sourceLiterals("src/budget/treasury.mjs", /state = "([a-z-]+)"/g), "window state");
		cover("BUDGET_PROJECT_STATUS_LABELS", sourceLiterals("src/budget/projects.mjs", /const STATUS_[A-Z]+ = "([a-z-]+)"/g), "project status");
		cover("BUDGET_DENIAL_LABELS", sourceLiterals("src/budget/projects.mjs", /reason: "([a-z-]+)"/g), "denial reason");
		cover("AUDIT_ASSESSMENT_LABELS", JSON.parse(`[${sourceLiterals("src/budget/audit.mjs", /const ASSESSMENTS = Object\.freeze\(\[([^\]]+)\]\)/g)[0]}]`), "assessment");
		cover("AUDIT_STATUS_LABELS", sourceLiterals("src/budget/audit-job.mjs", /status: "([a-z-]+)"/g), "audit status");
	});

	it("shows spent (main/sub), approved, estimate p50 and the staged chip per project, and the audit row's time, project, advice line, model and cost", async () => {
		const page = await openPage(snapshot());
		const [staged, denied] = rowsOf(page, "budget-projects");
		const stagedText = text(staged);
		for (const part of ["Export QA", "$41.50", "메인 $18.20 · 서브 $23.30", "$30.00", "$14.00", labels.BUDGET_STAGE_LABEL]) assert.ok(stagedText.includes(part), `"${part}" in "${stagedText}"`);
		assert.equal(byClass(staged, "chip").find((c) => text(c) === labels.BUDGET_STAGE_LABEL).getAttribute("title"), "다음 점검: Export round 4 acceptance");
		assert.equal(buttonNamed(staged, "승인"), undefined);
		assert.equal(buttonNamed(staged, "거절"), undefined);
		assert.deepEqual(chipText(denied), [labels.BUDGET_PROJECT_STATUS_LABELS.approved, labels.BUDGET_DENIAL_LABELS["cumulative-cap"]]);
		const [row] = rowsOf(page, "budget-audits");
		assert.deepEqual(
			descendants(row)
				.filter((n) => n.localName === "th" || n.localName === "td")
				.map(text),
			["11-12 10:00", "Export QA", labels.AUDIT_ASSESSMENT_LABELS["waste-likely"], "Rounds 6-8 repeat the QA rerun.", "gpt-6-astra:high", "$1.84"],
		);
	});

	it("renders no approval buttons anywhere and no decide request", async () => {
		const page = await openPage(snapshot());
		const body = page.doc.getElementById("budget-projects-body");
		assert.equal(descendants(body).filter((n) => n.localName === "button").length, 0);
		assert.equal(page.posts.length, 0);
		const appJs = fs.readFileSync(path.join(STATIC, "app.js"), "utf8");
		assert.equal(appJs.includes("/api/budget/decide"), false);
		assert.equal(appJs.includes("승인 보냄"), false);
	});

	it("shows the latest denied change as 여유 부족, 누적 상한 or 진척 증거 없음", async () => {
		const page = await openPage(
			snapshot({
				projects: [project({ id: "cap" }), project({ id: "cumulative" }), project({ id: "progress" })],
				events: [
					{ seq: 5, ms: NOW - MIN, projectId: "cap", account: null, kind: "denied", data: { projectId: "cap", requestId: "r2", increaseUsd: 9, reason: "insufficient-capacity" } },
					{ seq: 4, ms: NOW - 2 * MIN, projectId: "cap", account: null, kind: "denied", data: { projectId: "cap", requestId: "r1", increaseUsd: 3, reason: "cumulative-cap" } },
					{ seq: 3, ms: NOW - 3 * MIN, projectId: "cumulative", account: null, kind: "denied", data: { projectId: "cumulative", requestId: "r3", increaseUsd: 5, reason: "cumulative-cap" } },
					{ seq: 2, ms: NOW - 4 * MIN, projectId: "progress", account: null, kind: "denied", data: { projectId: "progress", requestId: "r4", increaseUsd: 2, reason: "no-progress-evidence" } },
				],
			}),
		);
		const rows = rowsOf(page, "budget-projects");
		assert.deepEqual(
			rows.map((row) => chipText(row).at(-1)),
			[labels.BUDGET_DENIAL_LABELS["insufficient-capacity"], labels.BUDGET_DENIAL_LABELS["cumulative-cap"], labels.BUDGET_DENIAL_LABELS["no-progress-evidence"]],
		);
		assert.equal(text(rows[0]).includes(labels.BUDGET_DENIAL_LABELS["cumulative-cap"]), false, "the newest denial wins");
		assert.equal(text(page.doc.getElementById("budget-projects-body")).includes("감사 거절"), false, "removed auditor denials are gone");
	});

	it("steps the account's reset coupons with -/+ within 0..20", async () => {
		const page = await openPage(snapshot());
		const [claude, , codex] = byClass(page.doc.getElementById("budget-limits-body"), "win");
		assert.equal(buttonNamed(codex, "−").disabled, true, "no coupon below 0");
		await page.after(() => buttonNamed(claude, "+").click());
		assert.deepEqual(page.posts, [{ url: "/api/budget/coupons", body: { account: CLAUDE, count: 2 } }]);
		const rows = () => byClass(page.doc.getElementById("budget-limits-body"), "win");
		const claudeRows = rows().filter((r) => r.textContent.includes(labels.BUDGET_ACCOUNT_LABELS[CLAUDE]));
		assert.equal(claudeRows.length, 2);
		for (const row of claudeRows) {
			assert.ok(text(byClass(row, "coupons")[0]).startsWith("리셋권 2"), text(row));
			assert.ok(chipText(row).includes("반영 대기"), "a sent count is marked until a snapshot carries it");
		}
		const next = snapshot();
		for (const w of next.treasury.windows) if (w.account === CLAUDE) w.coupons = 2;
		page.state = uiState(next);
		await page.after(() => page.autoRefresh());
		assert.ok(text(rows()[0]).includes("리셋권 2"));
		assert.equal(chipText(rows()[0]).includes("반영 대기"), false);
		const top = await openPage(snapshot({ windows: [windowState({ coupons: 20 })] }));
		assert.equal(buttonNamed(byClass(top.doc.getElementById("budget-limits-body"), "win")[0], "+").disabled, true, "no coupon above 20");
	});

	it("shows one chip per crossed trigger: light neutral, heavy warn, with detail and KST time in the title", async () => {
		const page = await openPage(
			snapshot({
				projects: [
					project({
						triggers: [
							{ kind: "rounds", heavy: false, detail: "3 numbered rounds, $4.00 since round 1", firstMs: NOW - 90 * MIN },
							{ kind: "budget", heavy: true, detail: "95.0% of approved, forecast $40.00", firstMs: NOW - 30 * MIN },
						],
					}),
				],
			}),
		);
		const [row] = rowsOf(page, "budget-projects");
		const chips = byClass(byClass(row, "wrap-row")[0], "chip");
		assert.deepEqual(chips.map(text), [labels.BUDGET_TRIGGER_LABELS.rounds, labels.BUDGET_TRIGGER_LABELS.budget]);
		assert.equal(chips[0].className, "chip", "a light crossing is neutral");
		assert.equal(chips[1].className, "chip chip--warn", "a heavy crossing warns");
		assert.equal(chips[0].getAttribute("title"), "3 numbered rounds, $4.00 since round 1 · 11-12 10:30 KST");
		assert.equal(chips[1].getAttribute("title"), "95.0% of approved, forecast $40.00 · 11-12 11:30 KST");
		assert.ok(chipText(row).includes(labels.BUDGET_PROJECT_STATUS_LABELS.approved), "the status chip is still there");
	});

	it("shows the deferred audit reason as 감사 미룸: <reason>", async () => {
		const page = await openPage(snapshot({ projects: [project({ auditDeferred: { ms: NOW - 5 * MIN, reason: "no-model" } })] }));
		const [row] = rowsOf(page, "budget-projects");
		const [deferred] = byClass(row, "chip").filter((c) => text(c).startsWith("감사 미룸"));
		assert.equal(text(deferred), `감사 미룸: ${labels.BUDGET_AUDIT_DEFERRED_LABELS["no-model"]}`);
		assert.equal(deferred.className, "chip chip--warn");
		assert.equal(deferred.getAttribute("title"), "11-12 11:55 KST");
	});

	it("shows no signal chip for an empty trigger list and no deferral", async () => {
		const page = await openPage(snapshot({ projects: [project({ triggers: [], auditDeferred: null })] }));
		const [row] = rowsOf(page, "budget-projects");
		assert.equal(byClass(row, "wrap-row").length, 0);
		assert.deepEqual(chipText(row), [labels.BUDGET_PROJECT_STATUS_LABELS.approved]);
		assert.equal(text(row).includes("감사 미룸"), false);
	});

	it("renders every trigger and deferral label of labels.mjs unchanged (the page keeps its own copy)", async () => {
		const kinds = Object.keys(labels.BUDGET_TRIGGER_LABELS);
		const reasons = Object.keys(labels.BUDGET_AUDIT_DEFERRED_LABELS);
		const page = await openPage(
			snapshot({
				projects: [
					...kinds.map((kind, i) => project({ id: `t${i}`, triggers: [{ kind, heavy: i % 2 === 1, detail: "detail", firstMs: NOW }] })),
					...reasons.map((reason, i) => project({ id: `d${i}`, auditDeferred: { ms: NOW, reason } })),
				],
			}),
		);
		const rows = rowsOf(page, "budget-projects");
		const rendered = rows.flatMap((row) => byClass(row, "chip").map(text)).filter((t) => t.startsWith("감사 미룸") || !Object.values(labels.BUDGET_PROJECT_STATUS_LABELS).includes(t));
		assert.deepEqual(rendered, [...Object.values(labels.BUDGET_TRIGGER_LABELS), ...reasons.map((reason) => `감사 미룸: ${labels.BUDGET_AUDIT_DEFERRED_LABELS[reason]}`)]);
	});

	it("labels every trigger kind and deferral reason the budget modules produce", () => {
		const cover = (map, values, what) => {
			assert.ok(values.length > 0, `${what}: the producer's values are found`);
			for (const value of values) assert.ok(Object.hasOwn(labels[map], value), `${what} ${value}`);
		};
		cover("BUDGET_TRIGGER_LABELS", sourceLiterals("src/budget/metrics.mjs", /kind: "([a-z-]+)"/g), "trigger kind");
		cover("BUDGET_TRIGGER_LABELS", sourceLiterals("src/budget/projects.mjs", /reasons: \["([a-z-]+)"\]/g), "audit reason");
		cover("BUDGET_AUDIT_DEFERRED_LABELS", [...sourceLiterals("src/budget/metrics.mjs", /reason: "([a-z-]+)"/g), "no-model", "start-failed"], "deferral reason");
	});

	for (const [name, budget] of [
		["no snapshot yet", null],
		["an empty snapshot", snapshot({ windows: [], projects: [], audits: [] })],
	]) {
		it(`shows 기록 없음 in each card for ${name}, with no render error`, async () => {
			const page = await openPage(budget);
			for (const id of ["budget-limits", "budget-projects", "budget-audits"]) {
				assert.equal(page.doc.getElementById(id).hidden, false, id);
				assert.equal(text(page.doc.getElementById(`${id}-body`)), "기록 없음", id);
			}
		});
	}
});
