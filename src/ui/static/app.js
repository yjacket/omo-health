"use strict";

// omo-health dashboard. Every value from the server is drawn with createElement + textContent (the page runs under
// `script-src 'self'` with no inline style). Markup follows the control-plane task-7 design note, section 5.
(() => {
	const TOKEN_KEY = "omoh-token";
	const REFRESH_MS = 10_000;
	const SVG_NS = "http://www.w3.org/2000/svg";
	const DAEMON_TONE = { running: "ok", stale: "warn", crashed: "crit" };
	const SEVERITY_TONE = { info: "info", warn: "warn", crit: "crit" };
	const APPLIED_NOTE = { applied: "info", pending: "warn", rejected: "crit" };
	const MODE_LABELS = { auto: "자동 조치", shadow: "기록만" };
	const VERDICT_TONE = { progressing: "ok", idle: "info", stalled: "warn", looping: "crit" };
	const INVESTIGATION_TONE = { analyzing: "info", verdict: "info", released: "ok", advised: "warn", noticed: "info", failed: "crit" };
	const INVESTIGATION_COLUMNS = ["시각", "대상", "계기", "판정", "조치", "상태"];
	// Session board (status/_sessions.json) and ended-session ledger: tones per terminal, child task status, health level and outcome.
	const TERMINAL_TONE = { orca: "info", herdr: "ok" };
	const TASK_TONE = { running: "ok", starting: "ok", spawning: "ok", completed: "ok", queued: "idle", pending: "idle", cancelled: "idle", interrupted: "warn", error: "crit", failed: "crit", killed: "crit", lost: "crit" };
	const LEVEL_RANK = { ok: 0, info: 1, warn: 2, crit: 3 };
	const OUTCOME_TONE = { "goal-complete": "ok", answered: "ok", crash: "crit", failed: "crit", cancelled: "warn", released: "warn", closed: "idle", unknown: "idle" };
	const ENDED_COLUMNS = [{ label: "끝난 시각", cls: "col-time" }, { label: "세션" }, { label: "결말", cls: "col-outcome" }, { label: "토큰", num: true }, { label: "이유" }, { label: "자식 · 시간 · omo", cls: "col-wide" }];
	// 상위 모델 조사 (an audit of one session): the statuses an open detail follows on the 10 s refresh, and the token judgment as a chip tone.
	const AUDIT_ACTIVE = new Set(["queued", "launching", "running"]);
	const AUDIT_TOKEN_TONE = { normal: "ok", high: "warn", wasteful: "warn" };
	// Why an audit cannot start now. The detail's audit.blocked carries only the code (src/ui/cli.mjs blockedOf), so the page words it as src/ui/labels.mjs AUDIT_REASON_LABELS does.
	const AUDIT_BLOCKED_TEXT = { disabled: "설정에서 조사가 꺼져 있습니다", "daemon-off": "감시기가 꺼져 있어 조사할 수 없습니다", cap: "오늘 조사 한도를 다 썼습니다", "models-unknown": "세션이 쓴 모델을 다 확인하지 못해 조사할 수 없습니다", "no-model": "세션과 분석가 모델과 다른 상위 모델이 없습니다" };
	const TABS = ["sessions", "ended", "admin"];

	let token = null;
	let timer = null;
	let gone = false;
	let seq = 0;
	const busy = new Set();
	const errors = new Map();
	// The diagnosis section lives outside the 10 s state refresh: a diagnosis samples processes and runs only on request.
	const diag = { subjects: null, selected: "", report: null, error: null, loading: false };
	// Ids of the investigation rows the user expanded: they stay open across the 10 s re-render.
	const openInvestigations = new Set();
	// Ids of the session cards the user expanded: they stay open across the 10 s re-render too.
	const openSessions = new Set();
	// Ids of the history rows the user expanded, and each one's detail as fetched ({state, data, error}): both outlive the 10 s re-render.
	const openEnded = new Set();
	const endedDetails = new Map();
	// The last rendered state: the history filter redraws from it at once, before the server has stored the choice.
	let lastState = null;
	// 자식 숨기기. The stored preference seeds it once; from then on this page's own choice rules, so a refresh already in flight cannot flip it back.
	let hideChildren = null;
	// The server's clock at the last state: relative times on the board are measured from it, not from the browser.
	let nowMs = Date.now();
	let tab = "sessions";

	function append(node, children) {
		for (const child of children.flat(Infinity)) {
			if (child === undefined || child === null || child === false) continue;
			node.append(child instanceof Node ? child : String(child));
		}
		return node;
	}

	function el(tag, attrs = {}, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "text") node.textContent = String(value);
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else node.setAttribute(key, value === true ? "" : String(value));
		}
		return append(node, children);
	}

	function svg(tag, attrs = {}, ...children) {
		const node = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
		return append(node, children);
	}

	const show = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
	const chip = (label, tone) => el("span", { class: tone ? `chip chip--${tone}` : "chip", text: label });
	const note = (message, tone) => el("p", { class: tone ? `note note--${tone}` : "note", text: message });
	const empty = (message) => el("p", { class: "empty", text: message });
	const mono = (v) => el("span", { class: "mono", text: show(v) });
	const plain = (v) => el("span", { text: show(v) });
	const block = (title, ...children) => el("div", { class: "block" }, el("h3", { class: "block__title", text: title }), children);
	/** A block inside a block: one level down, with the smaller title. */
	const subBlock = (title, ...children) => el("div", { class: "block" }, el("h4", { class: "block__subtitle", text: title }), children);

	function facts(rows) {
		return el(
			"dl",
			{ class: "facts" },
			rows.filter(Boolean).map(([label, ...values]) => [el("dt", { text: label }), el("dd", {}, el("div", { class: "facts__v" }, values))]),
		);
	}

	/** A column's cell class: `num` right-aligns, `cls` is the column's own class (hidden on narrow screens, nowrap). */
	const cellClass = (h) => [h?.num ? "col-n" : null, h?.cls].filter(Boolean).join(" ") || undefined;

	const tableHead = (head) => el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col", class: cellClass(h), text: h.label }))));

	function table(cls, head, rows) {
		return el(
			"div",
			{ class: "tablewrap" },
			el(
				"table",
				{ class: `table ${cls}` },
				tableHead(head),
				el(
					"tbody",
					{},
					rows.map((row) =>
						el(
							"tr",
							{ class: row.class },
							row.cells.map((cell, i) => el(i === 0 ? "th" : "td", { scope: i === 0 ? "row" : undefined, class: cellClass(head[i]) }, cell)),
						),
					),
				),
			),
		);
	}

	/** A server action: off while its group is busy and once the server is gone. `disabled` holds it off for a reason of its own (an audit that cannot start now). */
	function button(label, { group, key, primary = false, mode = false, pressed, disabled = false, onclick }) {
		const cls = ["btn", primary ? "btn--primary" : null, mode ? "btn--mode" : null].filter(Boolean).join(" ");
		return el("button", { type: "button", class: cls, "data-group": group, "data-key": key, "aria-pressed": pressed === undefined ? undefined : String(pressed), disabled: disabled || gone || busy.has(group), onclick }, label);
	}

	const errorSlot = (group) => el("p", { class: "note note--crit", role: "status", "aria-live": "polite", text: errors.get(group) ?? "" });

	/** Puts keyboard focus back on the control with this key after a redraw replaced its node; false when the redraw removed it. */
	function focusByKey(key) {
		const node = [...document.querySelectorAll("[data-key]")].find((n) => n.dataset.key === key);
		node?.focus({ preventScroll: true });
		return Boolean(node);
	}

	const pad = (n) => String(n).padStart(2, "0");
	const kstDate = (ms) => new Date(ms + 9 * 3600_000);

	function when(ms) {
		if (!Number.isFinite(ms)) return "-";
		const d = kstDate(ms);
		return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
	}

	function clockText(ms) {
		if (!Number.isFinite(ms)) return "-";
		const d = kstDate(ms);
		return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
	}

	function span(ms) {
		const minutes = Math.max(0, Math.round(ms / 60_000));
		if (minutes < 1) return "1분 미만";
		if (minutes < 60) return `${minutes}분`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`;
		const days = Math.floor(hours / 24);
		return hours % 24 ? `${days}일 ${hours % 24}시간` : `${days}일`;
	}

	function sinceText(ageMs) {
		if (!Number.isFinite(ageMs)) return "-";
		return ageMs < 60_000 ? `${Math.max(0, Math.round(ageMs / 1000))}초 전` : `${span(ageMs)} 전`;
	}

	/** An elapsed time as the board shows it: seconds under a minute, then minutes and hours. */
	function elapsedText(ms) {
		if (!Number.isFinite(ms)) return "-";
		return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}초` : span(ms);
	}

	/** HH:MM in KST, for a time within the day such as an investigation's next look. */
	function clockShort(ms) {
		if (!Number.isFinite(ms)) return "-";
		const d = kstDate(ms);
		return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
	}

	/** A decision's `ts` (ISO text) or a stored millisecond stamp, as milliseconds. */
	const toMs = (v) => (typeof v === "string" ? Date.parse(v) : v);

	/** A token count as the board and the history show it: whole under 1000, then one decimal of K, M or B with a trailing .0 dropped. */
	function compactCount(n) {
		if (!Number.isFinite(n)) return "-";
		if (n < 1000) return String(n);
		let unit = n < 1e6 ? 0 : n < 1e9 ? 1 : 2;
		let scaled = (n / 1000 ** (unit + 1)).toFixed(1);
		// 999,950 would read 1000K: it is 1M.
		if (scaled === "1000.0" && unit < 2) [unit, scaled] = [unit + 1, "1.0"];
		return `${scaled.replace(/\.0$/, "")}${"KMB"[unit]}`;
	}

	/** The exact count, for a tooltip and for the detail. */
	const fullCount = (n) => (Number.isFinite(n) ? n.toLocaleString("ko-KR") : "-");

	/** A cost in dollars at API prices; `unknown` says some turns had no price. */
	const costText = (cost, unknown) => `${Number.isFinite(cost) ? `$${cost.toFixed(3)}` : "-"}${unknown ? " + 가격 모름" : ""}`;

	/**
	 * A session's own total by what the token index knows of it: the compact count, 계산 중 until its file is read to the end,
	 * - when no file was found. `title` is the tooltip: the exact count, or why there is no number.
	 */
	function tokenReading(stateKey, total) {
		if (stateKey === "ok") return { text: compactCount(total), title: fullCount(total) };
		if (stateKey === "missing") return { text: "-", title: "세션 기록 파일을 찾지 못했습니다" };
		if (stateKey === "full") return { text: "-", title: "토큰 색인이 가득 차 세지 않았습니다" };
		return { text: "계산 중", title: lastState.overview?.daemon?.state === "running" ? "감시기가 세션 파일을 읽는 중입니다." : "감시기가 꺼져 있어 아직 계산하지 못했습니다." };
	}

	function pauseSentence(p) {
		if (p.unreadable) return "일시정지 파일을 읽을 수 없어 일시정지로 봅니다.";
		if (p.indefinite || !Number.isFinite(p.untilMs)) return "재개할 때까지 멈춰 있습니다.";
		return `${when(p.untilMs)}까지 멈춰 있습니다(남은 시간 ${span(p.remainingMs ?? 0)}).`;
	}

	function spark(perDay, days) {
		const counts = (Array.isArray(perDay) ? perDay : []).map((n) => (Number.isFinite(n) ? n : 0));
		const max = Math.max(1, ...counts);
		const described = counts.map((n, i) => `${days?.[i]?.label ?? i + 1} ${n}건`).join(", ");
		const cell = 6;
		const gap = 2;
		const height = 18;
		const width = counts.length * cell + Math.max(0, counts.length - 1) * gap;
		return svg(
			"svg",
			{ class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `일별 ${described}` },
			svg("title", {}, described),
			counts.map((n, i) => {
				if (n === 0) return svg("rect", { class: "spark__zero", x: i * (cell + gap), y: height - 1, width: cell, height: 1 });
				const h = Math.max(2, Math.round((n / max) * height));
				return svg("rect", { x: i * (cell + gap), y: height - h, width: cell, height: h, rx: 1 });
			}),
		);
	}

	function bar(value, max, warnWhenFull = false) {
		const width = 64;
		const height = 6;
		const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
		return svg(
			"svg",
			{ class: "bar", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" },
			svg("rect", { class: "bar__track", x: 0, y: 0, width, height, rx: 2 }),
			ratio > 0 ? svg("rect", { class: warnWhenFull && ratio >= 1 ? "bar__fill bar__fill--warn" : "bar__fill", x: 0, y: 0, width: Math.max(2, Math.round(ratio * width)), height, rx: 2 }) : null,
		);
	}

	function resultTone(result) {
		if (result === "execute" || result === "applied" || result === "done" || result === "ok") return "ok";
		if (result === "would") return "info";
		if (/fail|error|reject/.test(result)) return "crit";
		return undefined;
	}

	function setState(tone, main, sub) {
		document.body.className = `tone-${tone}`;
		document.getElementById("state").textContent = main;
		document.getElementById("state-sub").textContent = sub;
	}

	/** Controls that act on the server go dark; tabs and accordion toggles keep working on the last state. */
	function disableAll() {
		for (const node of document.querySelectorAll("main button:not(.inv__toggle):not(.ended__toggle):not(.tab):not(.sess__head), main input:not(.ended__filter)")) node.disabled = true;
	}

	/* ---------- tabs ---------- */

	function tabFromHash() {
		const match = /^#(sessions|ended|admin)$/.exec(location.hash);
		return match ? match[1] : null;
	}

	/** Shows one tab panel; the hash remembers the choice, so a reload or a bookmarked address opens the same tab. */
	function selectTab(key, { focus = false } = {}) {
		tab = TABS.includes(key) ? key : "sessions";
		for (const node of document.querySelectorAll(".tab")) {
			const on = node.dataset.tab === tab;
			node.setAttribute("aria-selected", String(on));
			node.tabIndex = on ? 0 : -1;
			if (on && focus) node.focus();
		}
		for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.dataset.panel !== tab;
		if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
	}

	function initTabs() {
		for (const node of document.querySelectorAll(".tab")) {
			node.addEventListener("click", () => selectTab(node.dataset.tab));
			node.addEventListener("keydown", (event) => {
				const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
				if (!step) return;
				event.preventDefault();
				selectTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], { focus: true });
			});
		}
		window.addEventListener("hashchange", () => selectTab(tabFromHash() ?? tab));
		selectTab(tabFromHash() ?? "sessions");
	}

	/* ---------- session board ---------- */

	/** The findings and investigations of a session and of every child under it (each child's prefixed with its name), and the worst level among them. */
	function collectHealth(s) {
		const rows = [];
		let level = "ok";
		const visit = (node, prefix) => {
			for (const f of node.health.open) rows.push({ kind: "finding", prefix, f });
			for (const inv of node.health.investigations) rows.push({ kind: "investigation", prefix, inv });
			if ((LEVEL_RANK[node.health.level] ?? 0) > LEVEL_RANK[level]) level = node.health.level;
			for (const child of node.children) visit(child, child.name);
		};
		visit(s, null);
		return { level, rows, findings: rows.filter((r) => r.kind === "finding").length, investigations: rows.filter((r) => r.kind === "investigation").length };
	}

	function healthRow(r) {
		if (r.kind === "finding") {
			const f = r.f;
			return el("div", { class: "item" }, chip(f.severityKo || show(f.severity), SEVERITY_TONE[f.severity]), el("span", {}, r.prefix ? `${r.prefix}: ` : null, f.titleKo, f.detector ? [" ", el("span", { class: "meta", text: f.detector })] : null));
		}
		const inv = r.inv;
		return el("div", { class: "item" }, chip("조사", INVESTIGATION_TONE[inv.status] ?? "info"), el("span", {}, r.prefix ? `${r.prefix}: ` : null, inv.statusKo, Number.isFinite(inv.nextLookMs) ? ` · 다음 확인 ${clockShort(inv.nextLookMs)}` : null));
	}

	/** A child's dot: its own health when it has a problem, else its task status. */
	function childTone(c) {
		if (c.health.level === "crit" || c.health.level === "warn") return c.health.level;
		return TASK_TONE[c.status] ?? "idle";
	}

	function childMeta(c) {
		const elapsed = Number.isFinite(c.startedMs) ? elapsedText((Number.isFinite(c.endedMs) ? c.endedMs : nowMs) - c.startedMs) : null;
		const inv = c.health.investigations[0];
		return [c.category, c.statusKo, elapsed, c.health.open[0]?.titleKo, inv ? `조사 ${inv.statusKo}` : null, c.tokens ? `토큰 ${compactCount(c.tokens.total)}` : c.tokensState === "full" ? `토큰 ${tokenReading("full").text}` : c.tokensPending ? "토큰 계산 중" : null].filter(Boolean).join(" · ");
	}

	function tree(children, depth = 0) {
		return el(
			"ul",
			{ class: depth ? "tree tree--nested" : "tree" },
			children.map((c) =>
				el(
					"li",
					{ class: "tree__item" },
					el(
						"div",
						{ class: "tree__node" },
						el("span", { class: `dot dot--${childTone(c)}`, "aria-hidden": "true" }),
						depth ? el("span", { class: "tree__branch", "aria-hidden": "true", text: "└" }) : null,
						el("span", { class: "tree__name", text: c.name }),
						el("span", { class: "tree__meta", title: c.tokens ? `토큰 ${fullCount(c.tokens.total)}` : c.tokensState === "full" ? tokenReading("full").title : undefined, text: childMeta(c) }),
					),
					c.children.length ? tree(c.children, depth + 1) : null,
				),
			),
		);
	}

	function sessionDetails(s) {
		const todo = s.todo && Number.isFinite(s.todo.total) ? `할 일 ${Math.max(0, s.todo.total - (s.todo.open ?? 0))}/${s.todo.total} 완료` : null;
		const goal = [s.goal?.statusKo, todo].filter(Boolean).join(" · ");
		const turn = [s.state.tool ?? s.state.kindKo, Number.isFinite(s.state.sinceMs) ? `${elapsedText(nowMs - s.state.sinceMs)}째` : null].filter(Boolean).join(" · ");
		return facts([
			["세션", mono(s.sessionShort)],
			["목표", plain(goal || "-"), s.goal?.objective ? el("span", { class: "sess__objective", text: s.goal.objective }) : null],
			["호스트", s.host ? [mono(`pid ${show(s.host.pid)}`), s.host.omoVersion ? plain(`omo ${s.host.omoVersion}`) : null] : plain("없음")],
			["마지막 입력", plain(Number.isFinite(s.lastInputMs) ? sinceText(nowMs - s.lastInputMs) : "-")],
			["이번 턴", plain(turn || "-")],
		]);
	}

	/** A live session's token marks: its own total (계산 중 until its file is read to the end), then the tree total when its children add to it. */
	function boardTokenMarks(s) {
		if (!s.tokens && !s.tokensPending && s.tokensState !== "full") return null;
		const own = tokenReading(s.tokens ? "ok" : s.tokensState ?? "pending", s.tokens?.total);
		return [el("span", { title: own.title, text: `토큰 ${own.text}` }), Number.isFinite(s.treeTokens) ? el("span", { title: fullCount(s.treeTokens), text: `자식 포함 ${compactCount(s.treeTokens)}` }) : null];
	}

	/** One main session: the head row is the accordion toggle; the body shows details, the child tree and the health rows. */
	function sessionCard(s) {
		const key = s.sessionId ?? s.title;
		const open = openSessions.has(key);
		const health = collectHealth(s);
		const first = health.rows.find((r) => r.kind === "finding")?.f ?? null;
		const bodyId = `sess-${String(key).replace(/[^A-Za-z0-9_-]/g, "")}`;
		const article = el("article", { class: open ? "sess sess--open" : "sess" });
		const body = el(
			"div",
			{ class: "sess__body", id: bodyId, hidden: !open },
			el("div", { class: "split" }, block("상세", sessionDetails(s)), block("자식 세션", s.children.length ? tree(s.children) : empty("자식 세션이 없습니다."))),
			block("건강 상태", health.rows.length ? health.rows.map(healthRow) : empty("열린 문제가 없습니다.")),
		);
		const head = el(
			"button",
			{
				type: "button",
				class: "sess__head",
				"aria-expanded": String(open),
				"aria-controls": bodyId,
				"data-key": `sess:${key}`,
				onclick: () => {
					const next = !openSessions.has(key);
					if (next) openSessions.add(key);
					else openSessions.delete(key);
					article.classList.toggle("sess--open", next);
					head.setAttribute("aria-expanded", String(next));
					body.hidden = !next;
				},
			},
			el("span", { class: `dot dot--${health.level}`, "aria-hidden": "true" }),
			el(
				"span",
				{ class: "sess__main" },
				el("span", { class: "sess__title", text: s.title }),
				el(
					"span",
					{ class: "sess__sub" },
					s.cwdShort ? el("span", { class: "sess__cwd", title: s.cwd, text: s.cwdShort }) : null,
					s.terminal ? chip(s.terminal.labelKo, TERMINAL_TONE[s.terminal.kind]) : null,
					el("span", { text: `자식 ${s.childCount}` }),
					el("span", { text: when(s.startedMs) }),
					boardTokenMarks(s),
				),
			),
			el(
				"span",
				{ class: "sess__right" },
				first ? chip(health.findings > 1 ? `${first.titleKo} 외 ${health.findings - 1}` : first.titleKo, SEVERITY_TONE[first.severity] ?? "warn") : null,
				health.investigations ? chip(`조사 ${health.investigations}`, "warn") : null,
				el("span", { class: "sess__state", text: s.state.kindKo }),
				el("span", { class: "sess__chevron", "aria-hidden": "true" }),
			),
		);
		return append(article, [head, body]);
	}

	function groupView(g) {
		const c = g.counts;
		const name = g.omoVersion ? `omo ${g.omoVersion}` : "omo 버전 모름";
		const counts = [`세션 ${c.sessions}`, c.active ? `실행 중 ${c.active}` : null, c.warn ? `주의 ${c.warn}` : null, c.crit ? `심각 ${c.crit}` : null].filter(Boolean).join(" · ");
		return el(
			"section",
			{ class: "vgroup", "aria-label": name },
			el("h2", { class: "vgroup__head" }, el("span", { class: "vgroup__ver", text: name }), el("span", { class: "vgroup__counts", text: counts })),
			g.sessions.map(sessionCard),
		);
	}

	function renderSessions(s) {
		const stale = s.stale ? note(`감시기가 ${sinceText(nowMs - s.ts)}에 쓴 현황입니다. 지금 모습과 다를 수 있습니다.`, "warn") : null;
		if (!s.total) return [stale, el("p", { class: "empty empty--panel", text: "실행 중인 세션이 없습니다" })];
		return [stale, s.groups.filter((g) => g.sessions.length).map(groupView)];
	}

	/* ---------- ended sessions ---------- */

	function endedSessionCell(r) {
		const child = r.kind === "child";
		const meta = [child ? (r.parentShort ? `자식 · 부모 ${r.parentShort}` : "자식") : null, r.cwdShort, r.terminal?.labelKo].filter(Boolean).join(" · ");
		return el(
			"span",
			{ class: child ? "ended__session ended__session--child" : "ended__session" },
			el("span", { class: "ended__title" }, child ? el("span", { class: "ended__branch", "aria-hidden": "true", text: "└ " }) : null, r.title),
			meta ? el("span", { class: "ended__meta", title: r.cwd ?? undefined, text: meta }) : null,
		);
	}

	const outcomeMark = (o) => el("span", { class: `outcome outcome--${OUTCOME_TONE[o.outcome] ?? "idle"}`, text: o.estimated ? `${o.outcomeKo} (추정)` : o.outcomeKo });

	/** The 토큰 cell: the session's own total, and under it the tree total when its children add to it. */
	function endedTokenCell(r) {
		const own = tokenReading(r.tokensState, r.tokens?.total);
		return el(
			"span",
			{ class: "ended__tokens" },
			el("span", { class: r.tokensState === "ok" ? undefined : "ended__none", title: r.tokensGone ? `${own.title} (파일 삭제됨)` : own.title, text: own.text }),
			r.tokensState === "ok" && Number.isFinite(r.treeTokens) ? el("span", { class: "ended__meta", title: fullCount(r.treeTokens), text: `자식 포함 ${compactCount(r.treeTokens)}` }) : null,
		);
	}

	/** One list of a session's record, wherever GET /api/session keeps it: `children` on the record, the rest under `health`. */
	const detailList = (d, name) => (name === "children" ? d.children : d.health[name]);

	/** The session as the ledger recorded it. The folder is the row's short form, with the whole path on hover. */
	function endedFacts(r, s) {
		return facts([
			["세션 id", mono(s.sessionId)],
			["작업 id", mono(s.taskId)],
			["제목", plain(s.title || r.title)],
			["폴더", el("span", { title: r.cwd, text: show(r.cwdShort) })],
			["터미널", plain(s.terminalLabel)],
			["omo", plain(s.omoVersion)],
			["시작", plain(when(s.startedMs))],
			["끝", plain(when(s.endedMs))],
			["걸린 시간", plain(Number.isFinite(s.durationMs) ? span(s.durationMs) : "-")],
			["결말", outcomeMark(s), s.reason ? plain(s.reason) : null],
		]);
	}

	/** The session's tokens, split the way omo's own /session splits them: input is the whole prompt, and the cache served part of it. */
	function endedTokenFacts(t) {
		if (!Number.isFinite(t?.total)) {
			if (t?.state === "full") {
				const reading = tokenReading("full");
				return el("span", { title: reading.title, text: reading.text });
			}
			const missing = t?.state === "missing";
			const reading = tokenReading(missing ? "missing" : "pending");
			return missing ? empty(reading.title) : [empty(reading.text), note(reading.title)];
		}
		const promptTokens = t.input + t.cacheRead + t.cacheWrite;
		const hit = promptTokens > 0 ? ` (${((t.cacheRead / promptTokens) * 100).toFixed(1)}%)` : "";
		const count = (n) => el("span", { class: "num", text: fullCount(n) });
		const sub = (text) => el("span", { class: "facts__sub", text });
		return facts([
			["입력", count(promptTokens), sub(`캐시 읽기 ${fullCount(t.cacheRead)}${hit}`)],
			["캐시 안 됨", count(t.input + t.cacheWrite), sub(`캐시 쓰기 ${fullCount(t.cacheWrite)}`)],
			["출력", count(t.output)],
			["합계", count(t.total), t.gone ? el("span", { class: "meta", text: "파일 삭제됨" }) : null],
			["턴 수", count(t.turns)],
			["비용", plain(costText(t.cost, t.costUnknown)), sub("API 가격 환산")],
		]);
	}

	function endedModels(models) {
		if (!models?.length) return empty("모델 기록이 없습니다");
		return table(
			"table--rows",
			[{ label: "모델" }, { label: "토큰", num: true }, { label: "비용", num: true }],
			models.map((m) => ({ cells: [mono(m.key), fullCount(m.tokens), costText(m.cost)] })),
		);
	}

	function endedChild(c) {
		const own = tokenReading(c.tokensState, c.tokens?.total);
		return el(
			"li",
			{ class: "tree__item" },
			el(
				"div",
				{ class: "tree__node" },
				el("span", { class: `dot dot--${OUTCOME_TONE[c.outcome] ?? "idle"}`, "aria-hidden": "true" }),
				el("span", { class: "tree__name", text: c.title ?? c.taskId ?? show(c.sessionId) }),
				el("span", { class: "tree__meta" }, `${c.outcomeKo} · `, el("span", { title: own.title, text: `토큰 ${own.text}` })),
			),
		);
	}

	/** One lifecycle row of a finding: detected (with its severity), detected again, or resolved. `(전체)` marks a machine-wide one. */
	function endedFinding(f) {
		return el(
			"div",
			{ class: "sample" },
			el("span", { class: "sample__t", text: when(toMs(f.ts)) }),
			el(
				"span",
				{ class: "sample__d" },
				f.event === "resolved" ? chip("해결", "ok") : chip(f.severityKo || show(f.severity), SEVERITY_TONE[f.severity]),
				` ${f.titleKo}${f.scope === "machine" ? " (전체)" : ""} `,
				el("span", { class: "meta", text: [f.detector, f.event === "reopened" ? "다시 감지" : null].filter(Boolean).join(" · ") }),
				f.evidence.length ? evidenceList(f.evidence) : null,
			),
		);
	}

	function endedAction(a) {
		return el(
			"div",
			{ class: "sample" },
			el("span", { class: "sample__t", text: when(toMs(a.ts)) }),
			el("span", { class: "sample__d" }, `${a.actionKo} `, chip(a.resultKo, resultTone(a.result)), a.detail ? [" ", mono(a.detail)] : null),
		);
	}

	/** One analyst answer in an investigation's history; a failed look shows its reason in place of a diagnosis. */
	function endedVerdict(v) {
		return el(
			"div",
			{ class: "sample" },
			el("span", { class: "sample__t", text: when(toMs(v.ts)) }),
			el(
				"span",
				{ class: "sample__d" },
				v.failed ? chip("실패", "crit") : chip(v.verdictKo, analystTone(v)),
				Number.isFinite(v.confidence) ? [" ", el("span", { class: "meta", text: `확신 ${Math.round(v.confidence * 100)}%` })] : null,
				" ",
				v.failed ? mono(v.reason) : show(v.diagnosis),
			),
		);
	}

	/** One investigation about the session: what its list row says, the list's own detail, then every analyst answer in order. */
	function endedInvestigation(inv) {
		return el(
			"div",
			{ class: "ended__inv" },
			el("div", { class: "wrap-row" }, mono(when(inv.openedMs)), investigationSubject(inv), plain(inv.triggerKo), verdictChip(inv), investigationState(inv)),
			investigationDetail(inv),
			block("판정 기록", inv.verdictHistory.length ? el("div", { class: "samples" }, inv.verdictHistory.map(endedVerdict)) : empty("판정 기록이 없습니다")),
		);
	}

	/** One message omo-health delivered; `sessionId` is the session the detail is about, so a descendant's message names who got it. */
	function endedMessage(m, sessionId) {
		return el(
			"div",
			{ class: "sample" },
			el("span", { class: "sample__t", text: when(m.ms) }),
			el("span", { class: "sample__d" }, show(m.text), m.recipient && m.recipient !== sessionId ? [" ", el("span", { class: "mono", text: `받은 세션 ${m.recipient.slice(0, 8)}` })] : null),
		);
	}

	/** An audit verdict as a chip tone: sound is fine, every other finding warns, and an unverifiable check stays neutral. */
	const auditTone = (judgment) => (judgment === "sound" ? "ok" : judgment === "unverifiable" ? undefined : "warn");

	/** How to start an audit: the model it would use and today's count, why it cannot start now, then 조사 (다시 조사 after a result). */
	function auditStart(id, a, label, primary = false) {
		const group = `audit:${id}`;
		const blocked = a.blocked ? (AUDIT_BLOCKED_TEXT[a.blocked] ?? a.blocked) : null;
		return el(
			"div",
			{ class: "block" },
			note(`조사 모델 ${show(a.planned?.model)} · 오늘 ${show(a.usedToday)}/${show(a.perDay)}`),
			blocked ? note(`${blocked}.`, "warn") : null,
			el("div", { class: "wrap-row" }, button(label, { group, key: group, primary, disabled: Boolean(a.blocked), onclick: () => void startAudit(id) })),
		);
	}

	/** A queued or running audit: its status with the model and since when, and a note when the daemon that runs it is off. */
	function auditProgress(a) {
		const s = a.state;
		// A queued audit has no model of its own until the daemon starts it, with the one the detail plans.
		const line = s.status === "queued" ? [show(a.planned?.model), `요청 ${when(s.requestedMs)}`] : [show(s.model), `시작 ${when(s.startedMs ?? s.launchMs)}`];
		return el(
			"div",
			{ class: "block" },
			el("div", { class: "wrap-row" }, chip(s.statusKo, "info"), el("span", { class: "meta", text: line.join(" · ") })),
			a.stalled ? note("감시기가 꺼져 있어 진행이 멈춰 있습니다.", "warn") : null,
		);
	}

	/** One check of the reviewer: its judgment, what it judged and why, and the record lines it cites. */
	function auditCheck(c) {
		return el(
			"li",
			{ class: "audit__check" },
			chip(c.judgmentKo, auditTone(c.judgment)),
			el("div", { class: "audit__what" }, el("p", { class: "audit__item", text: c.item }), c.explanation ? el("p", { text: c.explanation }) : null, c.evidence.length ? evidenceList(c.evidence) : null),
		);
	}

	/** The reviewer's answer: the verdict as facts, one row per check, then what it recommends. */
	function auditResult(s) {
		const r = s.result;
		return [
			facts([
				["종합", chip(r.overallKo, auditTone(r.overall))],
				["요약", plain(r.summary)],
				["토큰", chip(r.tokens.judgmentKo, AUDIT_TOKEN_TONE[r.tokens.judgment]), r.tokens.explanation ? plain(r.tokens.explanation) : null],
				["확신", plain(`${Math.round(r.confidence * 100)}%`)],
				["모델", el("span", {}, mono(s.model), s.independence === "family" ? " · 다른 계열" : null)],
				["조사 시각", plain(when(s.finishedMs))],
			]),
			subBlock("항목별", r.checks.length ? el("ul", { class: "audit__checks" }, r.checks.map(auditCheck)) : empty("검토 항목이 없습니다")),
			subBlock("권고", r.recommendations.length ? el("ol", { class: "audit__recs" }, r.recommendations.map((line) => el("li", { text: line }))) : empty("권고가 없습니다")),
		];
	}

	/** A failed audit: why, in Korean; then the model, the time and the stored code; then the stored detail (redacted, at most 300 characters). */
	function auditFailure(s) {
		const meta = [s.model, Number.isFinite(s.finishedMs) ? when(s.finishedMs) : null, s.reason].filter(Boolean).join(" · ");
		return el("div", { class: "block" }, note(`조사하지 못했습니다: ${show(s.reasonKo)}`, "crit"), meta ? el("p", { class: "meta", text: meta }) : null, s.detail ? evidenceList([s.detail]) : null);
	}

	/** 상위 모델 조사: start an audit of the session, follow it while it is queued or running, then show the verdict or why there is none. */
	function auditBlock(id, a) {
		const status = a.state?.status;
		let parts;
		if (AUDIT_ACTIVE.has(status)) parts = auditProgress(a);
		else if (status === "done") parts = [auditResult(a.state), auditStart(id, a, "다시 조사")];
		else if (status === "failed") parts = [auditFailure(a.state), auditStart(id, a, "다시 조사")];
		else parts = auditStart(id, a, "조사", true);
		return block("상위 모델 조사", el("div", { class: "audit" }, parts, errorSlot(`audit:${id}`), errorSlot(`audit-read:${id}`)));
	}

	/** Everything omo-health recorded about one ended session, as GET /api/session returns it. */
	function endedRecord(r, d) {
		const id = r.sessionId;
		/** One list of the record or its empty state, then 더 보기 while the server holds more of it than the page has. */
		const paged = (name, wrap, none) => {
			const items = detailList(d, name);
			const group = `more:${id}:${name}`;
			return [
				items.length ? wrap(items) : empty(none),
				items.length < d.counts[name] ? el("div", { class: "wrap-row" }, button(`더 보기 (${items.length}/${d.counts[name]})`, { group, key: group, onclick: () => void loadEndedPage(id, name) })) : null,
				errorSlot(group),
			];
		};
		const samples = (row) => (items) => el("div", { class: "samples" }, items.map(row));
		return [
			el("div", { class: "split" }, block("상세", endedFacts(r, d.session)), block("토큰", endedTokenFacts(d.tokens))),
			block("모델별", endedModels(d.tokens?.models)),
			block("자식 세션", paged("children", (items) => el("ul", { class: "tree" }, items.map(endedChild)), "자식 세션이 없습니다")),
			block(
				"omo-health 기록",
				el(
					"div",
					{ class: "ended__log" },
					// Info-level findings are logged only since a daemon recorded a coverage event before the session started.
					subBlock("감지", d.coverage.infoFindings ? null : note("이 기간에는 정보 수준 감지를 기록하지 않았습니다."), paged("findings", samples(endedFinding), "감지 기록이 없습니다")),
					subBlock("조치", paged("actions", samples(endedAction), "조치 기록이 없습니다")),
					subBlock("조사", paged("investigations", (items) => items.map(endedInvestigation), "조사 기록이 없습니다")),
					subBlock("보낸 메시지", paged("messages", samples((m) => endedMessage(m, d.session.sessionId)), "보낸 메시지가 없습니다")),
				),
			),
			auditBlock(id, d.audit),
		];
	}

	/** What an open row shows under it: the fetch in progress, its failure with a way to retry, or the session's record. */
	function endedDetailView(r) {
		const id = r.sessionId;
		const entry = endedDetails.get(id);
		const body = (...children) => el("div", { class: "ended__body" }, children);
		if (entry.state === "loading") return body(note("불러오는 중"));
		if (entry.state === "error") return body(note(`상세를 읽지 못했습니다: ${entry.error}`, "crit"), el("div", { class: "wrap-row" }, button("다시 읽기", { key: `ended-retry:${id}`, onclick: () => void loadEndedDetail(id) })));
		// A stored record of an unexpected shape costs its own cell, not the whole table.
		try {
			return body(endedRecord(r, entry.data));
		} catch (error) {
			return body(note(`상세를 그리지 못했습니다: ${error?.message ?? error}`, "crit"));
		}
	}

	/** Redraws one open row's detail cell from the map, so a finished fetch touches nothing else on the page. */
	function drawEndedDetail(id) {
		const cell = [...document.querySelectorAll("td[data-ended]")].find((n) => n.dataset.ended === id);
		if (!cell || !openEnded.has(id)) return;
		const held = cell.contains(document.activeElement) ? document.activeElement.dataset.key : null;
		cell.replaceChildren(endedDetailView(lastState.ended.rows.find((r) => r.sessionId === id)));
		// A control the redraw removed (다시 읽기, the last 더 보기) hands its focus to the row's own toggle.
		if (held && !focusByKey(held)) focusByKey(`ended:${id}`);
	}

	/** Fetches a session's record for its open row. Once per page: a later open and every re-render read the map. */
	async function loadEndedDetail(id) {
		const entry = { state: "loading", data: null, error: null };
		endedDetails.set(id, entry);
		drawEndedDetail(id);
		try {
			const data = await getJson(`/api/session?id=${encodeURIComponent(id)}`);
			// No data means a 401: the masthead already says the token is wrong.
			Object.assign(entry, data ? { state: "ready", data } : { state: "error", error: "토큰이 맞지 않습니다" });
		} catch (error) {
			Object.assign(entry, { state: "error", error: String(error?.message ?? error) });
		}
		drawEndedDetail(id);
	}

	/** Fetches the next page of one list and appends it to the stored record, so the items survive every redraw. */
	async function loadEndedPage(id, name) {
		const group = `more:${id}:${name}`;
		if (gone || busy.has(group)) return;
		const d = endedDetails.get(id).data;
		const items = detailList(d, name);
		busy.add(group);
		errors.delete(group);
		try {
			const page = await getJson(`/api/session?id=${encodeURIComponent(id)}&list=${name}&offset=${items.length}`);
			if (page) {
				items.push(...page.items);
				// An empty page means the list ends here, whatever the count said.
				d.counts[name] = page.items.length ? page.total : items.length;
			}
		} catch (error) {
			errors.set(group, `더 읽지 못했습니다: ${error?.message ?? error}`);
		}
		busy.delete(group);
		drawEndedDetail(id);
	}

	/** Asks the daemon for an audit of the session, then re-reads the row's audit block before 조사 can be pressed again. */
	function startAudit(id) {
		return post("/api/audit", { sessionId: id }, `audit:${id}`, () => loadAudit(id));
	}

	/**
	 * Re-reads one open row's audit block. The rest of the record stays as first fetched, with every page 더 보기 appended to it.
	 * `headers` marks the 10 s re-read as automatic, so following an audit does not keep the server alive.
	 */
	async function loadAudit(id, headers) {
		const entry = endedDetails.get(id);
		if (entry?.state !== "ready") return;
		const slot = `audit-read:${id}`;
		try {
			const data = await getJson(`/api/session?id=${encodeURIComponent(id)}`, headers);
			if (data) {
				// A refusal shown while the audit ran (이미 조사 중입니다) is moot once it ends.
				if (AUDIT_ACTIVE.has(entry.data.audit?.state?.status) && !AUDIT_ACTIVE.has(data.audit?.state?.status)) errors.delete(`audit:${id}`);
				entry.data.audit = data.audit;
				errors.delete(slot);
			}
		} catch (error) {
			errors.set(slot, `조사 상태를 읽지 못했습니다: ${error?.message ?? error}`);
		}
		drawEndedDetail(id);
	}

	/** On the 10 s refresh, re-reads the audit of every open row whose audit is queued or running. A closed row or a finished audit is never polled. */
	function pollAudits() {
		for (const cell of document.querySelectorAll("td[data-ended]")) {
			const id = cell.dataset.ended;
			if (openEnded.has(id) && AUDIT_ACTIVE.has(endedDetails.get(id)?.data?.audit?.state?.status)) void loadAudit(id, { "x-omo-health-auto": "1" });
		}
	}

	/** One ended session: its six-column row, and the detail row it expands into. The row is the click target; the button is the keyboard one. */
	function endedItem(r) {
		const id = r.sessionId;
		const open = openEnded.has(id);
		const toggle = el("button", { type: "button", class: "ended__toggle", "data-key": `ended:${id}`, "aria-expanded": String(open) }, el("span", { class: "row__chevron", "aria-hidden": "true" }), when(r.endedMs));
		const detail = el("tr", { class: "ended__detail", hidden: !open }, el("td", { colspan: String(ENDED_COLUMNS.length), "data-ended": id }, open ? endedDetailView(r) : null));
		const body = el("tbody", { class: open ? "ended__item ended__item--open" : "ended__item" });
		const cells = [
			toggle,
			endedSessionCell(r),
			outcomeMark(r),
			endedTokenCell(r),
			show(r.reason),
			`${r.childCount} · ${Number.isFinite(r.durationMs) ? span(r.durationMs) : "-"} · ${show(r.omoVersion)}`,
		];
		const row = el(
			"tr",
			{
				class: r.kind === "child" ? "ended__row ended__row--child" : "ended__row",
				onclick: () => {
					const next = !openEnded.has(id);
					if (next) openEnded.add(id);
					else openEnded.delete(id);
					body.classList.toggle("ended__item--open", next);
					toggle.setAttribute("aria-expanded", String(next));
					detail.hidden = !next;
					if (!next) return;
					if (endedDetails.has(id)) drawEndedDetail(id);
					else void loadEndedDetail(id);
				},
			},
			cells.map((cell, i) => el(i === 0 ? "th" : "td", { scope: i === 0 ? "row" : undefined, class: cellClass(ENDED_COLUMNS[i]) }, cell)),
		);
		return append(body, [row, detail]);
	}

	/** Draws the history again from the last state: the filter applies at once, before the server has stored it. */
	function redrawEnded() {
		const focusKey = document.activeElement?.dataset?.key;
		section("ended", lastState.ended, renderEnded);
		if (focusKey) focusByKey(focusKey);
	}

	/** Stores the 자식 숨기기 choice. The switch is never disabled, so a choice made while a save is in flight is sent when that save ends. */
	async function saveHideChildren() {
		if (gone || busy.has("prefs")) return;
		const sent = hideChildren;
		await post("/api/prefs", { hideChildren: sent }, "prefs");
		if (hideChildren !== sent) void saveHideChildren();
	}

	function renderEnded(e) {
		if (!e.rows.length) return el("p", { class: "empty empty--panel", text: "끝난 세션 기록이 없습니다" });
		const hide = hideChildren === true;
		const rows = hide ? e.rows.filter((r) => r.kind !== "child") : e.rows;
		const summary = ["최근 30일", `끝난 세션 ${e.total}`, ...e.counts.filter((c) => c.count).map((c) => `${c.outcomeKo} ${c.count}`), hide ? `자식 ${e.totals.child} 숨김` : null].filter(Boolean).join(" · ");
		// The filter only reads the last state, so it carries no group: it keeps working while a save is in flight and after the server is gone.
		const filter = el(
			"label",
			{ class: "switch" },
			el("input", {
				type: "checkbox",
				class: "switch__input ended__filter",
				checked: hide,
				"data-key": "prefs",
				onchange: (event) => {
					hideChildren = event.currentTarget.checked;
					redrawEnded();
					void saveHideChildren();
				},
			}),
			el("span", { class: "switch__text", text: "자식 숨기기" }),
		);
		return [
			el("div", { class: "wrap-row ended__bar" }, el("p", { class: "meta", text: summary }), filter),
			errorSlot("prefs"),
			rows.length
				? el("div", { class: "tablewrap" }, el("table", { class: "table table--ended" }, tableHead(ENDED_COLUMNS), rows.map(endedItem)))
				: el("p", { class: "empty empty--panel", text: "메인 세션 기록이 없습니다" }),
			e.totals.main > e.limits.main || e.totals.child > e.limits.child ? note(`최근 메인 ${e.limits.main}건 · 자식 ${e.limits.child}건까지만 보입니다.`) : null,
		];
	}

	function renderMasthead(state) {
		document.getElementById("masthead-meta").textContent = `대시보드 v${show(state.version)} · 마지막 갱신 ${clockText(state.generatedMs)}`;
		const o = state.overview;
		if (!o || "error" in o) return setState("warn", "감시기 상태를 읽지 못했습니다", show(o?.error));
		const counts = `열린 문제 ${o.openFindings.length}건 · 사람 확인 ${o.humanNeeded.length}건`;
		const respawn = "omo 세션이 열려 있으면 센서가 감시기를 다시 띄웁니다.";
		switch (o.daemon.state) {
			case "running":
				if (o.pause.active) return setState("info", "자동 조치가 일시정지되어 있습니다", `${pauseSentence(o.pause)} 감지와 기록은 계속합니다.`);
				if (o.level === "crit") return setState("crit", "감시기가 심각한 문제를 보고하고 있습니다", counts);
				if (o.humanNeeded.length) return setState("warn", `감시기가 실행 중이고, 사람이 확인할 일이 ${o.humanNeeded.length}건 있습니다`, counts);
				if (o.degraded) return setState("warn", "감시기가 실행 중이지만 일부 정보를 읽지 못했습니다", counts);
				return setState("ok", "감시기가 실행 중입니다", counts);
			case "stale":
				return setState("warn", "감시기가 응답하지 않습니다", respawn);
			case "crashed":
				return setState("crit", "감시기가 비정상 종료되었습니다", respawn);
			case "stopped":
				return setState("idle", "감시기가 중지되어 있습니다", "중지 파일이 있어 다시 시작하지 않습니다.");
			default:
				return setState("idle", "감시기가 꺼져 있습니다", o.daemon.exitReasonKo ? `종료 이유: ${o.daemon.exitReasonKo}. omo 세션이 열리면 다시 시작합니다.` : "omo 세션이 열리면 다시 시작합니다.");
		}
	}

	function renderNow(o) {
		const d = o.daemon;
		const daemonFacts = facts([
			["상태", chip(d.stateKo, DAEMON_TONE[d.state])],
			["모드", plain(MODE_LABELS[d.mode] ?? d.mode), d.modeOverridden ? chip("--shadow로 실행 중", "info") : null],
			["일시정지", plain(o.pause.active ? pauseSentence(o.pause) : "아니오")],
			["마지막 신호", plain(sinceText(d.heartbeatAgeMs))],
			["실행 버전", mono(d.version)],
			["PID", mono(d.pid)],
			["시작", plain(when(d.startedMs))],
			d.exitReasonKo ? ["종료 이유", plain(d.exitReasonKo), d.stoppedMs ? mono(when(d.stoppedMs)) : null] : null,
		]);
		const band = el(
			"ul",
			{ class: "band", "aria-label": "지금 보고 있는 것" },
			[
				["추적 중인 세션", o.counts.sessions],
				["서브에이전트 작업", o.counts.tasks],
				["omo 호스트", o.counts.liveHosts],
				["센서", o.counts.sensors],
			].map(([label, n]) => el("li", {}, el("span", { class: "band__n", text: show(n) }), el("span", { class: "band__k", text: label }))),
		);
		const human = o.humanNeeded.length
			? block(
					"사람이 확인할 일",
					o.humanNeeded.map((h) => el("div", { class: "item" }, chip("확인 필요", "warn"), plain(h.titleKo))),
				)
			: null;
		const open = block(
			`열린 문제 ${o.openFindings.length}건`,
			o.openFindings.length ? o.openFindings.map((f) => el("div", { class: "item" }, chip(f.severityKo || show(f.severity), SEVERITY_TONE[f.severity]), plain(f.titleKo))) : empty("열린 문제가 없습니다."),
		);
		return [
			el("div", { class: "split" }, block("감시기", daemonFacts), block("지금 보고 있는 것", band)),
			human,
			open,
			o.degraded ? note("감시기가 일부 정보를 읽지 못해 판단이 제한적입니다.", "warn") : null,
		];
	}

	function renderControls(o) {
		const p = o.pause;
		const group = "pause";
		const buttons = p.active
			? [button("지금 재개", { group, key: "resume", primary: true, onclick: () => post("/api/resume", {}, group) })]
			: [
					button("15분 일시정지", { group, key: "pause-15", onclick: () => post("/api/pause", { minutes: 15 }, group) }),
					button("1시간 일시정지", { group, key: "pause-60", onclick: () => post("/api/pause", { minutes: 60 }, group) }),
					button("재개할 때까지 일시정지", { group, key: "pause-open", onclick: () => post("/api/pause", { minutes: null }, group) }),
				];
		return block(
			"자동 조치",
			el("p", { text: p.active ? `자동 조치가 일시정지되어 있습니다. ${pauseSentence(p)}` : "자동 조치가 켜져 있습니다. 일시정지해도 감지와 기록은 계속합니다." }),
			el("div", { class: "wrap-row" }, buttons),
			errorSlot(group),
		);
	}

	function disclosure(key, label, meta, samples) {
		return el(
			"details",
			{ class: "row", "data-open": key },
			el("summary", { class: "row__summary", "data-key": key }, el("span", { class: "row__chevron", "aria-hidden": "true" }), el("span", { class: "row__label", text: label }), meta ? el("span", { class: "row__meta", text: meta }) : null),
			el("div", { class: "samples" }, samples?.length ? samples.map(sampleRow) : empty("예시가 없습니다.")),
		);
	}

	function sampleRow(s) {
		return el(
			"div",
			{ class: "sample" },
			el("span", { class: "sample__t", text: when(s.ts) }),
			el(
				"span",
				{ class: "sample__d" },
				show(s.detail),
				s.sessionShort ? [" ", el("span", { class: "mono", text: `세션 ${s.sessionShort}` })] : null,
				s.taskId ? [" ", mono(s.taskId)] : null,
			),
		);
	}

	function resultChips(row) {
		return el(
			"div",
			{ class: "wrap-row" },
			row.results.map((r) => chip(`${r.resultKo} ${r.count}`, resultTone(r.result))),
			row.otherCount ? chip(`기타 ${row.otherCount}`) : null,
		);
	}

	function changeText(c) {
		const fmt = (v) => (v === undefined ? "(없음)" : JSON.stringify(v));
		if (Array.isArray(c.changed) && c.changed.length) return c.changed.map((x) => `${x.key}: ${fmt(x.from)} → ${fmt(x.to)}`).join(", ");
		return show(c.message);
	}

	function renderHistory(h) {
		const days = h.days ?? [];
		const todayIso = days.at(-1)?.iso;
		const maxDay = Math.max(1, ...days.flatMap((d) => [d.opened, d.actions]));
		const cellbar = (n) => el("span", { class: "cellbar" }, bar(n, maxDay), el("span", { class: "num", text: String(n) }));
		const dayTable = table(
			"table--days",
			[{ label: "날짜" }, { label: "감지", num: true }, { label: "조치", num: true }],
			days.map((d) => ({ class: d.iso === todayIso ? "day-today" : undefined, cells: [d.iso === todayIso ? `${d.label} 오늘` : d.label, cellbar(d.opened), cellbar(d.actions)] })),
		);
		const findings = h.findings.length
			? table(
					"table--rows table--findings",
					[{ label: "종류" }, { label: "7일" }, { label: "발생", num: true }, { label: "마지막" }],
					h.findings.map((f) => ({ cells: [disclosure(`finding:${f.key}`, f.labelKo, `${f.detector} · 해결 ${f.resolved}건`, f.samples), spark(f.perDay, days), String(f.opened), when(f.lastMs)] })),
				)
			: empty("최근 7일 동안 감지된 문제가 없습니다.");
		const actions = h.actions.length
			? table(
					"table--rows table--tally",
					[{ label: "조치" }, { label: "7일" }, { label: "결과" }, { label: "합계", num: true }],
					h.actions.map((a) => ({ cells: [disclosure(`action:${a.key}`, a.labelKo, `마지막 ${when(a.lastMs)}`, a.samples), spark(a.perDay, days), resultChips(a), String(a.total)] })),
				)
			: empty("최근 7일 동안 조치가 없습니다.");
		const changes = h.configChanges.length
			? el(
					"div",
					{ class: "samples" },
					h.configChanges.map((c) => el("div", { class: "sample" }, el("span", { class: "sample__t", text: when(c.ts) }), el("span", { class: "sample__d" }, chip(c.resultKo, resultTone(c.result)), " ", changeText(c)))),
				)
			: empty("최근 설정 변경이 없습니다.");
		return [
			note(`${days[0]?.label ?? ""} ~ ${days.at(-1)?.label ?? ""} · 기록 ${h.total}건${Number.isFinite(h.readMs) ? ` · 읽는 데 ${h.readMs}ms` : ""}`),
			dayTable,
			block("감지", findings),
			block("조치", actions),
			block("설정 변경", changes),
			h.other?.total ? note(`분류하지 못한 기록 ${h.other.total}건`) : null,
		];
	}

	/** The analyst's answer as a chip tone: a progressing call is fine, a stuck one is acted on, an escalation needs the owner. */
	function analystTone(v) {
		if (!v || v.failed) return undefined;
		if (v.verdict === "wait") return "ok";
		if (v.verdict === "act") return "warn";
		if (v.verdict === "escalate") return v.assessment === "abnormal" ? "crit" : "warn";
		return undefined;
	}

	const evidenceList = (lines) => el("ul", { class: "evidence" }, lines.map((line) => el("li", { class: "mono", text: line })));

	function investigationDetail(r) {
		const v = r.verdict;
		const confidence = v && Number.isFinite(v.confidence) ? el("span", { class: "meta", text: `확신 ${Math.round(v.confidence * 100)}%` }) : null;
		const summary = facts([
			r.clsKo ? ["분류", plain(`${r.clsKo}${r.rule ? ` (${r.rule})` : ""}`)] : null,
			r.subject.taskId && r.subject.sessionShort ? ["세션", mono(r.subject.sessionShort)] : null,
			v ? (v.failed ? ["실패", mono(v.reason)] : ["진단", plain(v.diagnosis)]) : null,
			// A why look (analyst-why) explains the mechanism and what to do instead; an older or progressing verdict has neither row.
			v && !v.failed && v.mechanism ? ["원리", plain(v.mechanism)] : null,
			v && !v.failed && v.avoid ? ["회피", plain(v.avoid)] : null,
			v && !v.failed ? ["원인", plain(v.causeKo), confidence] : null,
			v?.advice ? ["조언", plain(v.advice)] : null,
			r.action ? ["조치", plain(`${r.action.kindKo} · ${when(r.action.atMs)}`), r.action.detail ? mono(r.action.detail) : null] : null,
			// A reused verdict (same signature within a day) ran no job of its own, so the row shows even without a lane.
			r.model || r.lane || v?.reused ? [v?.reused ? "분석가 (재사용)" : "분석가", mono(r.model ?? r.lane), r.failures ? plain(`실패 ${r.failures}회`) : null] : null,
		]);
		return el(
			"div",
			{ class: "inv__body" },
			summary,
			block("근거", r.evidence.length ? evidenceList(r.evidence) : empty("근거 없음")),
			v?.evidence?.length ? block("분석가 근거", evidenceList(v.evidence)) : null,
		);
	}

	// The marks an investigation shows in its list row and, for the same record, in a session detail.
	const investigationSubject = (r) => el("span", { class: "inv__subject" }, mono(r.subject.id), chip(r.subject.kindKo, r.subject.kind === "main" ? "info" : undefined));
	const verdictChip = (r) => (r.verdict && !r.verdict.failed ? chip(r.verdictKo, analystTone(r.verdict)) : null);
	const investigationState = (r) => el("span", { class: "inv__state" }, chip(r.statusKo, INVESTIGATION_TONE[r.status]), Number.isFinite(r.retryAtMs) ? el("span", { class: "inv__retry", text: `다시 시도 ${when(r.retryAtMs)}` }) : null);

	/** One investigation: its six-column row, and the detail row it expands into. The row is the click target; the button is the keyboard one. */
	function investigationBody(r) {
		const open = openInvestigations.has(r.id);
		const toggle = el("button", { type: "button", class: "inv__toggle", "data-key": `inv:${r.id}`, "aria-expanded": String(open) }, el("span", { class: "row__chevron", "aria-hidden": "true" }), el("span", { class: "mono", text: when(r.openedMs) }));
		const detail = el("tr", { class: "inv__detail", hidden: !open }, el("td", { colspan: "6" }, investigationDetail(r)));
		const body = el("tbody", { class: open ? "inv inv--open" : "inv" });
		const row = el(
			"tr",
			{
				class: "inv__row",
				onclick: () => {
					const next = !openInvestigations.has(r.id);
					if (next) openInvestigations.add(r.id);
					else openInvestigations.delete(r.id);
					body.classList.toggle("inv--open", next);
					toggle.setAttribute("aria-expanded", String(next));
					detail.hidden = !next;
				},
			},
			el("th", { scope: "row" }, toggle),
			el("td", {}, investigationSubject(r)),
			el("td", { text: r.triggerKo }),
			el("td", {}, verdictChip(r) ?? "-"),
			el("td", { text: r.action ? r.action.kindKo : "-" }),
			el("td", {}, investigationState(r)),
		);
		return append(body, [row, detail]);
	}

	function renderInvestigations(inv) {
		if (!inv.rows.length) return empty("조사 기록 없음");
		return [
			note(`최근 7일 · ${inv.total}건${inv.total >= inv.limit ? ` (최대 ${inv.limit}건)` : ""}`),
			el(
				"div",
				{ class: "tablewrap" },
				el("table", { class: "table table--inv" }, el("thead", {}, el("tr", {}, INVESTIGATION_COLUMNS.map((h) => el("th", { scope: "col", text: h })))), inv.rows.map(investigationBody)),
			),
		];
	}

	function valueText(sw, v) {
		if (v === null || v === undefined) return "-";
		if (sw.type === "enum") return sw.values?.find((x) => x.value === v)?.labelKo ?? String(v);
		return v ? "켜짐" : "꺼짐";
	}

	function switchRow(sw) {
		const group = `switch:${sw.key}`;
		const control =
			sw.type === "enum"
				? el(
						"div",
						{ class: "block" },
						el("span", { class: "switch__text", text: sw.labelKo }),
						el(
							"div",
							{ class: "modegroup", role: "group", "aria-label": sw.labelKo },
							sw.values.map((v) =>
								button(v.labelKo, { group, key: `${group}:${v.value}`, mode: true, pressed: sw.value === v.value, onclick: () => (sw.value === v.value ? undefined : post("/api/switch", { key: sw.key, value: v.value }, group)) }),
							),
						),
					)
				: el(
						"label",
						{ class: "switch" },
						el("input", {
							type: "checkbox",
							class: "switch__input",
							checked: sw.value === true,
							"data-group": group,
							"data-key": group,
							disabled: gone || busy.has(group),
							onchange: (event) => post("/api/switch", { key: sw.key, value: event.currentTarget.checked }, group),
						}),
						el("span", { class: "switch__text", text: sw.labelKo }),
					);
		const state = el(
			"div",
			{ class: "switch__state" },
			el("span", { text: `파일 값 ${valueText(sw, sw.value)}` }),
			sw.effective !== null && sw.effective !== undefined ? el("span", { text: `감시기 적용값 ${valueText(sw, sw.effective)}` }) : null,
			sw.isDefault ? null : chip("기본값과 다름", "info"),
		);
		return el("div", { class: "switchrow" }, control, el("p", { class: "switch__desc", text: sw.descKo }), state, sw.overriddenKo ? note(sw.overriddenKo, "warn") : null, errorSlot(group));
	}

	function renderSettings(s) {
		const applied = s.applied ?? {};
		const header = el(
			"div",
			{ class: "block" },
			note(show(applied.stateKo), APPLIED_NOTE[applied.state]),
			el("p", { class: "note" }, "설정 파일 ", mono(s.file)),
			s.extraConfig?.file ? el("p", { class: "note" }, "추가 설정 파일 ", mono(s.extraConfig.file)) : null,
		);
		const problems = [...(s.warnings ?? [])];
		const warnings = problems.length ? block("설정 경고", problems.map((w) => note(w, "warn"))) : null;
		const others = block(
			"config.json에서 바꾼 다른 값",
			note(s.othersNoteKo),
			s.others.length
				? table(
						"table--rows",
						[{ label: "키" }, { label: "적용값" }, { label: "기본값" }],
						s.others.map((o) => ({ cells: [mono(o.key), mono(JSON.stringify(o.value) ?? "-"), mono(JSON.stringify(o.default) ?? "-")] })),
					)
				: empty("기본값에서 바꾼 다른 값이 없습니다."),
		);
		return [header, warnings, el("div", { class: "switchlist" }, s.switches.map(switchRow)), others];
	}

	/** GETs a JSON route with the page token. `headers` adds to it: x-omo-health-auto marks a fetch the user did not ask for, so it does not keep the server alive. */
	async function getJson(path, headers = {}) {
		const res = await fetch(path, { headers: { "x-omo-health-token": token, ...headers }, cache: "no-store" });
		if (res.status === 401) {
			showTokenProblem(false);
			return null;
		}
		if (!res.ok) throw new Error(`서버가 ${res.status} 응답을 보냈습니다`);
		return res.json();
	}

	async function loadSubjects() {
		diag.loading = true;
		diag.error = null;
		renderDiagnose();
		try {
			const data = await getJson("/api/diagnose");
			if (data) {
				diag.subjects = Array.isArray(data.subjects) ? data.subjects : [];
				if (!diag.subjects.some((s) => s.id === diag.selected)) diag.selected = diag.subjects[0]?.id ?? "";
			}
		} catch (error) {
			diag.error = `목록을 읽지 못했습니다: ${error?.message ?? error}`;
		} finally {
			diag.loading = false;
			renderDiagnose();
		}
	}

	async function runDiagnosis() {
		if (!diag.selected || diag.loading) return;
		diag.loading = true;
		diag.error = null;
		renderDiagnose();
		try {
			const report = await getJson(`/api/diagnose?id=${encodeURIComponent(diag.selected)}`);
			if (report) diag.report = report;
		} catch (error) {
			diag.error = `진단하지 못했습니다: ${error?.message ?? error}`;
		} finally {
			diag.loading = false;
			renderDiagnose();
		}
	}

	function diagnosisView(r) {
		if (!r.found) return note(`${r.id}을(를) 찾지 못했습니다. 목록을 새로 읽어 보세요.`, "warn");
		const summary = facts([
			["대상", plain(r.subject.label), r.subject.taskStatus ? chip(r.subject.taskStatus) : null],
			["판정", chip(r.verdictKo, VERDICT_TONE[r.verdict]), plain(r.adviceKo)],
			["이유", plain(r.reasonKo)],
			["마지막 진척", plain(Number.isFinite(r.lastProgress?.ms) ? `${when(r.lastProgress.ms)} (${sinceText(r.lastProgress.ageMs)})` : "기록 없음")],
			["감시기", plain(r.daemon?.running ? `실행 중(pid ${show(r.daemon.pid)}). 예정된 조치는 감시기가 합니다.` : "실행 중이 아닙니다. 자동 조치가 없습니다.")],
			["조사 시각", plain(clockText(r.atMs))],
		]);
		const calls = r.waitingOn.length
			? table(
					"table--rows",
					[{ label: "도구" }, { label: "명령" }, { label: "경과" }, { label: "분류" }, { label: "판정" }],
					r.waitingOn.map((w) => ({ cells: [w.tool, mono(w.command), span(w.elapsedMs), plain(`${w.clsKo} (${w.rule})${w.rechecks ? ` · 재확인 ${w.rechecks.map(clockText).join(", ")}` : ""}`), chip(w.verdictKo, VERDICT_TONE[w.verdict])] })),
				)
			: empty("기다리는 도구 호출이 없습니다.");
		const procs = r.waitingOn.flatMap((w) => w.processes);
		const processes = procs.length
			? table(
					"table--rows",
					[{ label: "프로세스" }, { label: "PID", num: true }, { label: "CPU", num: true }, { label: "메모리", num: true }],
					procs.map((p) => ({ cells: [mono(p.name), String(p.pid), p.cpuPct === null ? "-" : `${p.cpuPct}%`, `${p.memMB}MB`] })),
				)
			: empty("딸린 프로세스가 없습니다.");
		const actions = r.actions?.length
			? block(
					"감시기가 한 조치",
					el("div", { class: "samples" }, r.actions.map((a) => el("div", { class: "sample" }, el("span", { class: "sample__t", text: when(Date.parse(a.ts)) }), el("span", { class: "sample__d" }, chip(a.kindKo, resultTone(a.result)), " ", show(a.result))))),
				)
			: null;
		return [summary, block("기다리는 것", calls), block("프로세스", processes), actions];
	}

	function renderDiagnose() {
		const list = diag.subjects ?? [];
		const select = el(
			"select",
			{ class: "select", "aria-label": "진단할 작업", disabled: gone || diag.loading || !list.length, onchange: (event) => {
				diag.selected = event.currentTarget.value;
			} },
			list.length
				? list.map((s) => el("option", { value: s.id, selected: s.id === diag.selected, text: `${s.id}${s.label ? ` · ${s.label}` : ""}` }))
				: el("option", { value: "", text: diag.subjects === null ? "불러오는 중" : "돌고 있는 작업이 없습니다" }),
		);
		const controls = el(
			"div",
			{ class: "wrap-row" },
			select,
			el("button", { type: "button", class: "btn btn--primary", "data-key": "diagnose-run", disabled: gone || diag.loading || !diag.selected, onclick: () => void runDiagnosis() }, diag.loading ? "살펴보는 중" : "진단"),
			el("button", { type: "button", class: "btn", "data-key": "diagnose-list", disabled: gone || diag.loading, onclick: () => void loadSubjects() }, "목록 새로 읽기"),
		);
		document.getElementById("diagnose-body").replaceChildren(
			...[
				note("종료하기 전에 무엇을 기다리는지, 아직 움직이는지 봅니다. 모델을 부르지 않고 프로세스를 몇 초 살펴봅니다(omo-health diagnose와 같은 결과)."),
				controls,
				diag.error ? note(diag.error, "crit") : null,
				diag.report ? diagnosisView(diag.report) : null,
			]
				.flat(Infinity)
				.filter(Boolean),
		);
		document.getElementById("diagnose").hidden = false;
	}

	function section(id, data, build, hideWhen) {
		const root = document.getElementById(id);
		const body = document.getElementById(`${id}-body`);
		if (data && typeof data === "object" && !Array.isArray(data) && "error" in data) {
			body.replaceChildren(note(`이 구역의 정보를 읽지 못했습니다: ${data.error}`, "warn"));
			root.hidden = false;
			return;
		}
		if (hideWhen?.(data)) {
			body.replaceChildren();
			root.hidden = true;
			return;
		}
		try {
			body.replaceChildren(...[build(data)].flat(Infinity).filter(Boolean));
		} catch (error) {
			body.replaceChildren(note(`이 구역을 그리지 못했습니다: ${error?.message ?? error}`, "warn"));
		}
		root.hidden = false;
	}

	function render(state) {
		const openKeys = new Set([...document.querySelectorAll("details[data-open]")].filter((d) => d.open).map((d) => d.dataset.open));
		const focusKey = document.activeElement?.dataset?.key;
		nowMs = Number.isFinite(state.generatedMs) ? state.generatedMs : Date.now();
		lastState = state;
		if (hideChildren === null && typeof state.prefs?.hideChildren === "boolean") hideChildren = state.prefs.hideChildren;
		renderMasthead(state);
		section("board", state.sessions, renderSessions);
		section("ended", state.ended, renderEnded);
		section("now", state.overview, renderNow);
		section("controls", state.overview, renderControls);
		section("investigations", state.investigations, renderInvestigations);
		section("history", state.history, renderHistory);
		section("settings", state.settings, renderSettings);
		for (const d of document.querySelectorAll("details[data-open]")) if (openKeys.has(d.dataset.open)) d.open = true;
		if (focusKey) focusByKey(focusKey);
	}

	function showServerGone() {
		gone = true;
		clearTimeout(timer);
		setState("idle", "대시보드 서버가 종료되었습니다(30분 동안 쓰지 않으면 닫힙니다)", "/health ui 또는 omo-health ui로 다시 여세요.");
		disableAll();
	}

	function showTokenProblem(missing) {
		clearTimeout(timer);
		setState("warn", missing ? "주소에 토큰이 없습니다" : "주소의 토큰이 이 대시보드와 맞지 않습니다", "터미널이나 /health ui에 나온 주소로 다시 여세요.");
		disableAll();
	}

	function schedule() {
		clearTimeout(timer);
		if (document.visibilityState === "visible" && !gone) timer = setTimeout(() => void refresh(true), REFRESH_MS);
	}

	/** Auto refreshes carry x-omo-health-auto so a forgotten tab does not keep the server alive. */
	async function refresh(auto) {
		clearTimeout(timer);
		const mine = ++seq;
		const headers = auto ? { "x-omo-health-token": token, "x-omo-health-auto": "1" } : { "x-omo-health-token": token };
		let res;
		try {
			res = await fetch("/api/state", { headers, cache: "no-store" });
		} catch {
			if (mine === seq) showServerGone();
			return;
		}
		if (mine !== seq) return;
		if (res.status === 401) return showTokenProblem(false);
		if (!res.ok) {
			setState("warn", "상태를 읽지 못했습니다", `서버가 ${res.status} 응답을 보냈습니다. 10초 뒤 다시 읽습니다.`);
			return schedule();
		}
		let state;
		try {
			state = await res.json();
		} catch {
			setState("warn", "상태를 읽지 못했습니다", "응답을 해석하지 못했습니다. 10초 뒤 다시 읽습니다.");
			return schedule();
		}
		if (mine !== seq) return;
		gone = false;
		render(state);
		schedule();
		if (auto) pollAudits();
	}

	function failureText(status, data) {
		// A refusal that names its reason (POST /api/audit) says it in Korean.
		if (data?.reasonKo) return `${data.reasonKo}.`;
		switch (data?.error) {
			case "unreadable":
				return `config.json을 읽을 수 없어 바꾸지 않았습니다${data.message ? `: ${data.message}` : "."}`;
			case "invalid":
			case "unknown-key":
			case "invalid-value":
				return "허용되지 않은 값입니다.";
			default:
				return `요청을 처리하지 못했습니다(${status}).`;
		}
	}

	/** POSTs one control action, then redraws. `after` first re-reads what the action changed outside the state (an open detail's audit), so its button stays off until then. */
	async function post(path, body, group, after) {
		if (gone || busy.has(group)) return;
		errors.delete(group);
		busy.add(group);
		for (const node of document.querySelectorAll("[data-group]")) if (node.dataset.group === group) node.disabled = true;
		let res;
		try {
			res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-omo-health-token": token }, body: JSON.stringify(body), cache: "no-store" });
		} catch {
			busy.delete(group);
			return showServerGone();
		}
		if (res.status === 401) {
			busy.delete(group);
			return showTokenProblem(false);
		}
		if (!res.ok) errors.set(group, failureText(res.status, await res.json().catch(() => ({}))));
		await after?.();
		busy.delete(group);
		await refresh(false);
	}

	function readToken() {
		const match = /^#t=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
		if (match) {
			sessionStorage.setItem(TOKEN_KEY, match[1]);
			history.replaceState(null, "", "/");
		}
		return sessionStorage.getItem(TOKEN_KEY);
	}

	token = readToken();
	initTabs();
	if (!token) {
		showTokenProblem(true);
		return;
	}
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void refresh(false);
		else clearTimeout(timer);
	});
	void refresh(false);
	void loadSubjects();
})();
