import fs from "node:fs";
import path from "node:path";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { actionDetail, readDecisions } from "./decisions.mjs";
import { streamEnded } from "./session-ledger.mjs";
import { compactUsage, readUsageIndex, treeTotals } from "./usage-index.mjs";
import { reasonCode } from "./audit-codes.mjs";
import { listDirSafe, readJsonSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * The per-session record (plan todo 7, GAP-6): everything omo-health itself
 * recorded about one ended session and its descendants. The loader reads the
 * 30-day ledger, the token index, the full decision log, every investigation
 * file and the `omo-health` transcript entries of the session and its
 * descendants; `buildSessionRecord` is pure and does the joining.
 *
 * Selection is by ids and fps only, never by time, so a child that keeps
 * running after its parent ends keeps its actions and verdicts. Only the
 * machine-wide overlap check uses the parent's [startedMs, endedMs] window.
 */

const DAY_MS = 86_400_000;
const DEPTH_MAX = 8;
const LINE_MAX = 300;
const EVIDENCE_LINE_MAX = 200;
const EVIDENCE_LINES_MAX = 6;
const RECORD_LINES_MAX = 12;
const MESSAGE_TEXT_MAX = 300;
const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const FINDING_EVENTS = new Set(["opened", "reopened", "resolved"]);

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** `redact` plus the GitHub token shape it does not mask yet. */
const scrub = (value) => redact(String(value ?? "")).replace(/ghp_[A-Za-z0-9]{8,}/g, "ghp_[REDACTED]");
const clean = (value, max = LINE_MAX) => (typeof value === "string" && value ? truncate(scrub(value), max) : null);
const msOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : Number.NaN);
const timeOf = (entry) => msOf(entry?.ts);

/** Every string of a stored record through `redact`, every value bounded (a raw investigation keeps its shape). */
function cleanValue(value, depth = 0) {
	if (typeof value === "string") return truncate(scrub(value), TEXT_MAX);
	if (Array.isArray(value)) return depth >= 6 ? [] : value.slice(0, 500).map((item) => cleanValue(item, depth + 1));
	if (!isRecord(value)) return value;
	if (depth >= 6) return {};
	const out = {};
	for (const [key, item] of Object.entries(value)) out[scrub(key)] = cleanValue(item, depth + 1);
	return out;
}

function cleanLines(lines, max = RECORD_LINES_MAX, lineMax = LINE_MAX) {
	if (!Array.isArray(lines)) return [];
	return lines.filter((line) => typeof line === "string" && line).slice(0, max).map((line) => truncate(scrub(line), lineMax));
}

function byNewest(a, b) {
	const am = msOf(a?.ts);
	const bm = msOf(b?.ts);
	return (Number.isFinite(bm) ? bm : 0) - (Number.isFinite(am) ? am : 0);
}

/**
 * Descendant sessions and tasks, recursively over `parentSessionId` in the
 * ledger rows and the usage index (depth <= 8). A parent may be named by its
 * session id or its task id, so both join the frontier.
 */
function collectDescendants(row, ledger, usageEntries) {
	const nodes = new Map();
	const discovered = new Set([row.sessionId, row.taskId].filter(nonEmpty));
	const all = [];
	for (const r of ledger) if (isRecord(r)) all.push({ sessionId: r.sessionId ?? null, taskId: r.taskId ?? null, parentSessionId: r.parentSessionId ?? null, title: r.title ?? null, outcome: r.outcome ?? null, endedMs: msOf(r.endedMs), cwd: r.cwd ?? null, ledgerRow: r });
	for (const e of usageEntries) if (nonEmpty(e?.parentSessionId)) all.push({ sessionId: e.id ?? null, taskId: e.taskId ?? null, parentSessionId: e.parentSessionId, title: null, outcome: null, endedMs: msOf(e.checkedMs), cwd: null });
	let frontier = new Set(discovered);
	for (let depth = 1; depth <= DEPTH_MAX && frontier.size; depth += 1) {
		const next = new Set();
		for (const n of all) {
			const parent = n.parentSessionId;
			if (!nonEmpty(parent) || !frontier.has(parent)) continue;
			const key = nonEmpty(n.sessionId) ? n.sessionId : nonEmpty(n.taskId) ? `task:${n.taskId}` : null;
			if (!key || discovered.has(key)) continue;
			discovered.add(key);
			nodes.set(key, {
				sessionId: nonEmpty(n.sessionId) ? n.sessionId : null,
				taskId: nonEmpty(n.taskId) ? n.taskId : null,
				parentSessionId: parent,
				title: n.title,
				outcome: n.outcome,
				endedMs: Number.isFinite(n.endedMs) ? n.endedMs : null,
				cwd: n.cwd,
				depth,
				ledgerRow: n.ledgerRow,
			});
			if (nonEmpty(n.sessionId)) next.add(n.sessionId);
			if (nonEmpty(n.taskId)) next.add(n.taskId);
		}
		frontier = next;
	}
	return [...nodes.values()];
}

function subjectMatches(subject, allowed) {
	if (!isRecord(subject)) return false;
	return ["sessionId", "taskId", "parentSessionId", "rootSessionId"].some((key) => nonEmpty(subject[key]) && allowed.has(subject[key]));
}

/** Per fp: the [opened, resolved] intervals built from the lifecycle rows, oldest first. */
function intervalsOf(rows) {
	const intervals = [];
	let start = null;
	for (const { ts, event } of rows) {
		if (event === "opened" || event === "reopened") {
			if (start === null) start = ts;
		} else if (event === "resolved" && start !== null) {
			intervals.push({ start, end: ts });
			start = null;
		}
	}
	if (start !== null) intervals.push({ start, end: null });
	return intervals;
}

/**
 * Machine-wide incidents (no subject session or task) whose active interval
 * overlaps [startedMs, endMs]. Each is returned once, with its opened row.
 */
function machineFindings(decisions, startedMs, endMs) {
	const byFp = new Map();
	for (const entry of decisions) {
		if (!isRecord(entry) || !FINDING_EVENTS.has(entry.event) || !nonEmpty(entry.fp)) continue;
		const ts = timeOf(entry);
		if (!Number.isFinite(ts)) continue;
		const rows = byFp.get(entry.fp) ?? [];
		rows.push({ ts, event: entry.event, entry });
		byFp.set(entry.fp, rows);
	}
	const out = [];
	for (const [fp, rows] of byFp) {
		rows.sort((a, b) => a.ts - b.ts);
		const subject = rows.find((r) => isRecord(r.entry.subject))?.entry.subject;
		if (isRecord(subject) && (nonEmpty(subject.sessionId) || nonEmpty(subject.taskId))) continue;
		const overlap = intervalsOf(rows).some(({ start, end }) => start <= endMs && (end === null || end >= startedMs));
		if (!overlap) continue;
		const opened = rows.find((r) => r.event === "opened") ?? rows[0];
		out.push(machineRow(opened.entry, fp, opened.ts));
	}
	return out;
}

function machineRow(entry, fp, ts) {
	return {
		fp,
		ts: new Date(ts).toISOString(),
		event: entry.event ?? "opened",
		detector: clean(entry.detector, 20),
		kind: clean(entry.kind, 80),
		severity: clean(entry.severity, 20),
		titleKo: clean(entry.titleKo, TITLE_MAX),
		subject: cleanValue(entry.subject ?? {}),
		scope: "machine",
		evidence: cleanLines(entry.evidence, EVIDENCE_LINES_MAX, EVIDENCE_LINE_MAX),
	};
}

function factsOf(entry) {
	const outcome = isRecord(entry.outcome) ? entry.outcome : {};
	const count = (list) => (Array.isArray(list) ? list.length : 0);
	const reason = outcome.reason ?? entry.reason ?? (entry.result !== "execute" ? entry.result : null);
	return {
		delivered: typeof outcome.delivered === "boolean" ? outcome.delivered : null,
		via: clean(outcome.via, 80),
		killed: count(outcome.killed),
		survived: count(outcome.survived),
		error: outcome.error !== undefined && outcome.error !== null && outcome.error !== false,
		reasonCode: reasonCode(typeof reason === "string" ? reason : null),
	};
}

function actionRow(entry) {
	const recipient = isRecord(entry.outcome) && nonEmpty(entry.outcome.sessionId) ? entry.outcome.sessionId : isRecord(entry.subject) && nonEmpty(entry.subject.sessionId) ? entry.subject.sessionId : null;
	return {
		ts: entry.ts ?? null,
		detector: clean(entry.detector, 20),
		// An engine action decision carries the finding's kind at top level and the action's kind under `action`.
		kind: clean(entry.action.kind, 80),
		findingKind: clean(entry.kind, 80),
		result: clean(entry.result, 120),
		detail: actionDetail(entry),
		recipient,
		subject: cleanValue(entry.subject ?? {}),
		facts: factsOf(entry),
	};
}

function verdictRows(decisions, fp) {
	const rows = [];
	for (const entry of decisions) {
		if (!isRecord(entry) || entry.fp !== fp || entry.event !== "investigation") continue;
		const a = entry.analyst;
		if (!isRecord(a) || !nonEmpty(a.verdict)) continue;
		rows.push({
			ts: entry.ts ?? null,
			verdict: a.verdict,
			assessment: a.assessment ?? null,
			cause: a.cause ?? null,
			confidence: Number.isFinite(a.confidence) ? a.confidence : null,
			failed: a.failed === true || entry.result === "analyst-failed",
			reason: clean(a.reason, LINE_MAX),
			diagnosis: clean(a.diagnosis, TEXT_MAX),
		});
	}
	return rows.sort((a, b) => (msOf(a.ts) || 0) - (msOf(b.ts) || 0));
}

function investigationRow(record, decisions) {
	const raw = cleanValue(record);
	return {
		...raw,
		evidence: cleanLines(record.evidence, RECORD_LINES_MAX, LINE_MAX),
		signals: cleanLines(record.signals, RECORD_LINES_MAX, LINE_MAX),
		verdictHistory: verdictRows(decisions, record.id),
	};
}

function modelRows(published) {
	const models = isRecord(published?.models) ? published.models : {};
	return Object.entries(models)
		.map(([key, value]) => ({ key: clean(key, 120) ?? key, tokens: Number.isFinite(value?.tokens) ? value.tokens : 0, cost: Number.isFinite(value?.cost) ? value.cost : 0 }))
		.sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function usageEntryOf(usage, row) {
	const bySession = nonEmpty(row.sessionId) ? usage.get(row.sessionId) : undefined;
	if (bySession && bySession.state !== "full") return bySession;
	// A task id is an alias only when it is a non-empty string: two main rows both carry null and must not match.
	if (nonEmpty(row.taskId)) {
		const byTask = usage.get(row.taskId) ?? (usage instanceof Map ? [...usage.values()].find((entry) => entry?.taskId === row.taskId) : null);
		if (byTask) return byTask;
	}
	// The disk-backed Map carries saturation on the index, not on an absent row.
	return bySession ?? (usage.full === true ? FULL_USAGE : null);
}

const FULL_USAGE = Object.freeze({ state: "full" });

/**
 * Join every stored record about `inputs.row` and its descendants. Pure: the
 * loader supplies already-read inputs, so tests can drive a fixture directly.
 */
export function buildSessionRecord(inputs = {}) {
	const { id, row } = inputs;
	const ledger = Array.isArray(inputs.ledger) ? inputs.ledger : [];
	const usage = typeof inputs.usage?.get === "function" && typeof inputs.usage?.values === "function" ? inputs.usage : new Map();
	const decisions = Array.isArray(inputs.decisions) ? inputs.decisions : [];
	const investigations = Array.isArray(inputs.investigations) ? inputs.investigations : [];
	const messagesIn = Array.isArray(inputs.messages) ? inputs.messages : [];
	const truncated = isRecord(inputs.truncated) ? inputs.truncated : { messagesSkipped: [] };
	if (!isRecord(row)) return { found: false, id };

	const startedMs = msOf(row.startedMs);
	const endedMs = msOf(row.endedMs);
	const descendants = inputs.descendants ?? collectDescendants(row, ledger, usage.values());
	const descSessionIds = new Set(descendants.map((node) => node.sessionId).filter(nonEmpty));
	const descTaskIds = new Set(descendants.map((node) => node.taskId).filter(nonEmpty));
	const sessionAllowed = new Set([row.sessionId, ...descSessionIds].filter(nonEmpty));
	const taskAllowed = new Set([row.taskId, ...descTaskIds].filter(nonEmpty));
	const allAllowed = new Set([...sessionAllowed, ...taskAllowed]);
	// Step 4's `{S}∪D` is the session plus the descendants' session and task ids; T alone is not a delivery target.
	const deliveredAllowed = new Set([row.sessionId, ...descSessionIds, ...descTaskIds].filter(nonEmpty));

	// 1. investigations about the session or its descendants
	const selectedInvestigations = investigations.filter((record) => {
		if (!isRecord(record)) return false;
		const subject = isRecord(record.subject) ? record.subject : {};
		return (nonEmpty(subject.sessionId) && sessionAllowed.has(subject.sessionId)) || (nonEmpty(subject.taskId) && taskAllowed.has(subject.taskId)) || (nonEmpty(subject.parentSessionId) && subject.parentSessionId === row.sessionId);
	});

	// 2. the fp set: selected investigations plus lifecycle rows whose subject matches
	const fpSet = new Set(selectedInvestigations.map((record) => record.id).filter(nonEmpty));
	for (const entry of decisions) if (isRecord(entry) && FINDING_EVENTS.has(entry.event) && nonEmpty(entry.fp) && subjectMatches(entry.subject, allAllowed)) fpSet.add(entry.fp);

	// 2b. every model that may have analyzed a selected fp: each selected investigation file's current model plus
	// the analyzing decisions recorded for the fp. An fp known only from decisions has no investigation file, so the
	// decision rows are the only source for its analyst model.
	const analystModels = [];
	const addAnalystModel = (model) => {
		if (!nonEmpty(model) || analystModels.includes(model)) return;
		analystModels.push(model);
	};
	for (const record of selectedInvestigations) addAnalystModel(record.model);
	for (const entry of decisions) {
		if (!isRecord(entry) || entry.event !== "investigation" || !fpSet.has(entry.fp)) continue;
		addAnalystModel(entry.model);
	}

	// 3. decisions about the session; 4. decisions delivered to it or its descendants
	const about = decisions.filter((entry) => isRecord(entry) && ((nonEmpty(entry.fp) && fpSet.has(entry.fp)) || subjectMatches(entry.subject, allAllowed) || entry.sessionId === row.sessionId));
	const delivered = decisions.filter((entry) => isRecord(entry) && isRecord(entry.outcome) && nonEmpty(entry.outcome.sessionId) && deliveredAllowed.has(entry.outcome.sessionId));
	const selected = [...new Set([...about, ...delivered])];

	const findings = selected
		.filter((entry) => FINDING_EVENTS.has(entry.event))
		.map((entry) => ({
			fp: entry.fp ?? null,
			ts: entry.ts ?? null,
			event: entry.event,
			detector: clean(entry.detector, 20),
			kind: clean(entry.kind, 80),
			severity: clean(entry.severity, 20),
			titleKo: clean(entry.titleKo, TITLE_MAX),
			subject: cleanValue(entry.subject ?? {}),
			scope: "session",
			evidence: cleanLines(entry.evidence, EVIDENCE_LINES_MAX, EVIDENCE_LINE_MAX),
		}));
	const machine = machineFindings(decisions, Number.isFinite(startedMs) ? startedMs : -Infinity, Number.isFinite(endedMs) ? endedMs : Number.isFinite(startedMs) ? startedMs : Infinity);
	const allFindings = [...findings, ...machine].sort(byNewest);

	const actions = selected
		.filter((entry) => isRecord(entry.action))
		.map(actionRow)
		.sort(byNewest);

	const investigationRows = selectedInvestigations.map((record) => investigationRow(record, decisions)).sort((a, b) => (b.openedMs ?? 0) - (a.openedMs ?? 0));

	const messages = messagesIn
		.filter(isRecord)
		.map((message) => ({ ms: Number.isFinite(message.ms) ? message.ms : null, recipient: clean(message.recipient, 200), text: clean(typeof message.text === "string" ? message.text : "", MESSAGE_TEXT_MAX) }))
		.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));

	const entry = usageEntryOf(usage, row);
	const compact = compactUsage(entry);
	const trees = treeTotals(usage.values());
	const tokens = entry
		? {
				...(compact ?? { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, costUnknown: false, turns: null }),
				models: modelRows(entry.published),
				state: typeof entry.state === "string" ? entry.state : null,
				complete: entry.complete === true,
				treeTotal: trees.get(entry.id) ?? null,
				gone: entry.gone === true,
			}
		: null;

	const children = descendants
		.map((node) => {
			const childEntry = usageEntryOf(usage, node);
			const childCompact = compactUsage(childEntry);
			return {
				sessionId: node.sessionId,
				taskId: node.taskId,
				title: clean(node.title, TITLE_MAX),
				outcome: clean(node.outcome, 40),
				endedMs: node.endedMs,
				depth: node.depth,
				tokens: childCompact,
				tokensState: childCompact ? "ok" : ["missing", "full"].includes(childEntry?.state) ? childEntry.state : "pending",
			};
		})
		.sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));

	const startedForCoverage = Number.isFinite(startedMs) ? startedMs : Number.isFinite(endedMs) ? endedMs : Infinity;
	const coverage = { infoFindings: decisions.some((d) => isRecord(d) && d.event === "coverage" && d.infoFindings === true && Number.isFinite(timeOf(d)) && timeOf(d) < startedForCoverage) };

	const session = cleanValue(row);
	session.durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;

	return {
		found: true,
		id: row.sessionId,
		session,
		tokens,
		children,
		coverage,
		analystModels,
		truncated: { messagesSkipped: Array.isArray(truncated.messagesSkipped) ? truncated.messagesSkipped : [] },
		health: {
			findings: allFindings,
			actions,
			investigations: investigationRows,
			messages,
			counts: { findings: allFindings.length, actions: actions.length, investigations: investigationRows.length, messages: messages.length },
		},
	};
}

const SCAN_CHUNK = 4 * 1024 * 1024;
const SCAN_LINE_MAX = 1024 * 1024;
const SCAN_NEWLINE = 0x0a;
const SCAN_MARKER = Buffer.from('"customType":"omo-health"', "utf8");

/**
 * Only lines naming the `omo-health` custom type are parsed; the rest of the
 * transcript is never decoded as content. The file is read in 4 MiB chunks so
 * a session file larger than the daemon heap (96 MiB) cannot exhaust it, and a
 * line over 1 MiB is dropped without being buffered past the limit (an
 * `omo-health` message line is small, so it is never one).
 */
export function scanOmoHealthMessages(file) {
	const out = [];
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return out;
	}
	const consume = (bytes) => {
		if (!bytes.length || !bytes.includes(SCAN_MARKER)) return;
		let entry;
		try {
			entry = JSON.parse(bytes.toString("utf8"));
		} catch {
			return;
		}
		if (!isRecord(entry) || (entry.type !== "custom_message" && entry.type !== "custom") || entry.customType !== "omo-health") return;
		const ms = msOf(entry.timestamp);
		const text = typeof entry.content === "string" ? entry.content : isRecord(entry.content) ? JSON.stringify(entry.content) : "";
		out.push({ ms: Number.isFinite(ms) ? ms : null, text });
	};
	try {
		const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
		let carry = null;
		let overlong = false;
		for (;;) {
			const n = fs.readSync(fd, chunk, 0, SCAN_CHUNK, null);
			if (n === 0) break;
			const view = chunk.subarray(0, n);
			let pos = 0;
			while (pos < n) {
				const newline = view.indexOf(SCAN_NEWLINE, pos);
				const piece = view.subarray(pos, newline === -1 ? n : newline);
				if (newline === -1) {
					if (!overlong) {
						if ((carry?.length ?? 0) + piece.length > SCAN_LINE_MAX) {
							overlong = true;
							carry = null;
						} else {
							carry = carry ? Buffer.concat([carry, piece]) : Buffer.from(piece);
						}
					}
					break;
				}
				if (overlong) {
					overlong = false;
					carry = null;
				} else if ((carry?.length ?? 0) + piece.length > SCAN_LINE_MAX) {
					carry = null;
				} else {
					consume(carry ? Buffer.concat([carry, piece]) : piece);
					carry = null;
				}
				pos = newline + 1;
			}
		}
		if (!overlong && carry) consume(carry);
	} catch {
		return out;
	} finally {
		fs.closeSync(fd);
	}
	return out;
}

function readAllInvestigations(paths) {
	const dir = paths.health.investigationsDir;
	const out = [];
	for (const name of listDirSafe(dir)) {
		if (!name.endsWith(".json")) continue;
		const record = readJsonSafe(path.join(dir, name));
		if (isRecord(record) && nonEmpty(record.id)) out.push(record);
	}
	return out;
}

function cwdsOf(node, ancestors) {
	const out = [];
	let current = node;
	const seen = new Set();
	for (let depth = 0; depth < DEPTH_MAX && isRecord(current); depth += 1) {
		if (nonEmpty(current.cwd) && !out.includes(current.cwd)) out.push(current.cwd);
		const parentId = current.parentSessionId;
		if (!nonEmpty(parentId) || seen.has(parentId)) break;
		seen.add(parentId);
		current = ancestors.get(parentId);
	}
	return out;
}

function recordLedger(rows, id, usage, descendantScanMax) {
	// First pass: keep only identities, links and ordering. In particular, an
	// unrelated row's cwd must not stay resident alongside the usage index.
	const links = [];
	for (const { sessionId, taskId, parentSessionId, endedMs } of rows()) links.push({ sessionId, taskId, parentSessionId, endedMs });
	links.sort((a, b) => Number(b.endedMs) - Number(a.endedMs));
	const byId = new Map();
	for (const link of links) {
		for (const alias of [link.sessionId, link.taskId]) if (nonEmpty(alias) && !byId.has(alias)) byId.set(alias, link);
	}
	const subject = byId.get(id);
	if (!subject) return null;
	const descendants = collectDescendants(subject, links, usage.values());
	const newest = [...descendants].sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));
	const scanned = Number.isFinite(descendantScanMax) ? newest.slice(0, descendantScanMax) : newest;
	const selected = new Map();
	const select = (link) => {
		if (!selected.has(link.sessionId)) selected.set(link.sessionId, new Set());
		selected.get(link.sessionId).add(link);
	};
	select(subject);
	const children = new Map();
	for (const node of descendants) {
		if (!node.ledgerRow) continue;
		select(node.ledgerRow);
		children.set(node.ledgerRow, node);
	}
	const ancestors = new Map();
	const directories = new Set();
	for (const node of [subject, ...scanned]) {
		if (!nonEmpty(node.taskId)) continue;
		directories.add(node.ledgerRow ?? node);
		let parentId = node.parentSessionId;
		const seen = new Set();
		for (let depth = 1; depth < DEPTH_MAX && nonEmpty(parentId) && !seen.has(parentId); depth += 1) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) break;
			select(parent);
			directories.add(parent);
			ancestors.set(parentId, parent);
			parentId = parent.parentSessionId;
		}
	}
	// Second pass: hydrate only the subject, descendant details and ancestor
	// directories. Match by ledger identity, not offsets that appends can shift.
	let row;
	for (const rec of rows()) {
		const candidates = selected.get(rec.sessionId);
		if (!candidates) continue;
		for (const link of candidates) {
			if (link.endedMs !== rec.endedMs || link.taskId !== rec.taskId || link.parentSessionId !== rec.parentSessionId) continue;
			candidates.delete(link);
			if (link === subject) row = rec;
			if (directories.has(link)) link.cwd = rec.cwd;
			const child = children.get(link);
			if (child) {
				child.title = rec.title ?? null;
				child.outcome = rec.outcome ?? null;
				if (directories.has(link)) child.cwd = rec.cwd;
			}
		}
		if (!candidates.size) selected.delete(rec.sessionId);
		if (!selected.size) break;
	}
	return row ? { row, descendants, ancestors, scanned } : null;
}

/**
 * Read everything the record needs and join it. Message scanning is bounded
 * per file: a file larger than `messageScanMaxBytes` is never opened for
 * messages and is listed in `truncated.messagesSkipped`; the dashboard default
 * is Infinity, only the daemon's audit preparation passes a limit.
 */
export function loadSessionRecord({ paths, id, now = Date.now(), messageScanMaxBytes = Infinity, descendantScanMax = Infinity, scanMessages = scanOmoHealthMessages, locator, index } = {}) {
	if (!nonEmpty(id)) return { found: false, id };
	const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
	const joined = recordLedger(() => streamEnded(paths, { sinceMs: now - 30 * DAY_MS }), id, usage, descendantScanMax);
	if (!joined) return { found: false, id };
	const { row, descendants, ancestors, scanned } = joined;
	const startedMs = msOf(row.startedMs);
	const decisions = readDecisions(paths, (Number.isFinite(startedMs) ? startedMs : now) - 30 * DAY_MS);
	const investigations = readAllInvestigations(paths);
	const loc = locator ?? createSessionFileLocator({ paths, clock: { now: () => now } });

	const files = [];
	const own = nonEmpty(row.taskId)
		? loc.childFile({ taskId: row.taskId, sessionId: row.sessionId, cwds: cwdsOf(row, ancestors) })
		: loc.mainFile(row.sessionId);
	if (own) files.push({ sessionId: row.sessionId, file: own });
	for (const node of scanned) {
		const file = nonEmpty(node.taskId) ? loc.childFile({ taskId: node.taskId, sessionId: node.sessionId, cwds: cwdsOf(node, ancestors) }) : loc.mainFile(node.sessionId);
		if (file) files.push({ sessionId: node.sessionId, file });
	}

	const messages = [];
	const skipped = [];
	for (const { sessionId, file } of files) {
		const stat = statSafe(file);
		if (!stat?.isFile()) continue;
		if (stat.size > messageScanMaxBytes) {
			skipped.push(file);
			continue;
		}
		for (const message of scanMessages(file) ?? []) messages.push({ ...message, recipient: sessionId });
	}

	return buildSessionRecord({ id, row, descendants, usage, decisions, investigations, messages, truncated: { messagesSkipped: skipped } });
}
