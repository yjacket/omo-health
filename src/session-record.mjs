import fs from "node:fs";
import path from "node:path";
import { createSessionFileLocator } from "./collect/session-files.mjs";
import { actionDetail, readDecisions, streamDecisions } from "./decisions.mjs";
import { streamEnded } from "./session-ledger.mjs";
import { compactUsage, readUsageIndex, treeTotals, usageEntryFor } from "./usage-index.mjs";
import { reasonCode } from "./audit-codes.mjs";
import { listDirSafe, readJsonSafe, statSafe } from "./util/fsx.mjs";
import { redact, truncate } from "./util/text.mjs";

/**
 * The per-session record (plan todo 7, GAP-6): everything omo-health itself
 * recorded about one ended session and its descendants. The loader reads the
 * 30-day ledger, the token index, recent decisions plus retained machine
 * incident and coverage history, every investigation
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
 * session id or its task id, so unambiguous parent links join the frontier.
 */
function collectDescendants(row, ledger, usageEntries) {
	const nodes = new Map();
	const all = [];
	for (const r of ledger) if (isRecord(r)) all.push({ sessionId: r.sessionId ?? null, taskId: r.taskId ?? null, parentSessionId: r.parentSessionId ?? null, title: r.title ?? null, outcome: r.outcome ?? null, endedMs: msOf(r.endedMs), cwd: r.cwd ?? null, ledgerRow: r });
	for (const e of usageEntries) if (nonEmpty(e?.taskId) || nonEmpty(e?.parentSessionId)) all.push({ sessionId: e.id ?? null, taskId: e.taskId ?? null, parentSessionId: e.parentSessionId, title: null, outcome: null, endedMs: msOf(e.checkedMs), cwd: null });
	const owners = new Map();
	const sessionIds = new Set();
	const remember = (link) => {
		if (nonEmpty(link.sessionId)) sessionIds.add(link.sessionId);
		if (nonEmpty(link.taskId)) trackOwner(owners, link.taskId, link.sessionId ?? "");
	};
	remember(row);
	for (const link of all) remember(link);
	const addLinks = (ids, link) => {
		if (nonEmpty(link.sessionId)) ids.add(link.sessionId);
		if (nonEmpty(link.taskId) && owners.get(link.taskId) !== null && !sessionIds.has(link.taskId)) ids.add(link.taskId);
	};
	const keyOf = (link) => nonEmpty(link.sessionId) ? link.sessionId : nonEmpty(link.taskId) ? `task:${link.taskId}` : null;
	const discovered = new Set([keyOf(row)]);
	let frontier = new Set();
	addLinks(frontier, row);
	for (let depth = 1; depth <= DEPTH_MAX && frontier.size; depth += 1) {
		const next = new Set();
		for (const n of all) {
			const parent = n.parentSessionId;
			if (!nonEmpty(parent) || !frontier.has(parent)) continue;
			const key = keyOf(n);
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
			addLinks(next, n);
		}
		frontier = next;
	}
	return [...nodes.values()];
}

function trackOwner(owners, taskId, identity) {
	if (!owners.has(taskId)) owners.set(taskId, identity);
	else if (owners.get(taskId) !== identity) owners.set(taskId, null);
}

/**
 * Machine-wide incidents (no subject session or task) whose active interval
 * overlaps the session window, and the latest info coverage marker before it.
 * Consume lifecycle rows oldest first and keep only the open intervals and
 * the first overlapping opener per fingerprint.
 */
function scanDecisionHistory(decisions, row) {
	const startedMs = msOf(row.startedMs);
	const endedMs = msOf(row.endedMs);
	const startMs = Number.isFinite(startedMs) ? startedMs : -Infinity;
	const endMs = Number.isFinite(endedMs) ? endedMs : Number.isFinite(startedMs) ? startedMs : Infinity;
	const open = new Map();
	const matched = new Map();
	const coverageEnd = Number.isFinite(startedMs) ? startedMs : Number.isFinite(endedMs) ? endedMs : Infinity;
	let coverageMs = -Infinity;
	for (const entry of decisions) {
		if (!isRecord(entry)) continue;
		const { fp, event, subject } = entry;
		const ts = timeOf(entry);
		if (!Number.isFinite(ts)) continue;
		if (event === "coverage" && entry.infoFindings === true && ts < coverageEnd && ts > coverageMs) coverageMs = ts;
		if (!FINDING_EVENTS.has(event) || !nonEmpty(fp) || matched.has(fp)) continue;
		if (event === "resolved") {
			const opened = open.get(fp);
			if (opened && ts >= startMs) matched.set(fp, opened);
			open.delete(fp);
		} else if (ts <= endMs && !open.has(fp) && !nonEmpty(subject?.sessionId) && !nonEmpty(subject?.taskId)) {
			open.set(fp, machineRow(entry, fp, ts));
		}
	}
	return { machine: [...matched.values(), ...open.values()], infoFindings: Number.isFinite(coverageMs) };
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

const sortRank = (tokens) => (Number.isNaN(tokens) ? Infinity : tokens);

function modelRows(published) {
	const models = isRecord(published?.models) ? published.models : {};
	return Object.entries(models)
		// A non-finite value (counters are added as supplied) is kept; JSON and the dashboard show it as "-".
		.map(([key, value]) => ({ key: clean(key, 120) ?? key, tokens: typeof value?.tokens === "number" ? value.tokens : 0, cost: typeof value?.cost === "number" ? value.cost : 0 }))
		.sort((a, b) => sortRank(b.tokens) - sortRank(a.tokens) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function usageEntryOf(usage, row) {
	return usageEntryFor(usage, row.sessionId, row.taskId) ?? (usage.full === true ? FULL_USAGE : null);
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
	const nodes = [row, ...descendants];
	const sessionAllowed = new Set(nodes.map((node) => node.sessionId).filter(nonEmpty));
	const taskOnly = new Set(nodes.filter((node) => !nonEmpty(node.sessionId)).map((node) => node.taskId).filter(nonEmpty));
	const taskSubjects = new Map();
	if (taskOnly.size) {
		const countSubject = ({ subject } = {}) => {
			if (!isRecord(subject) || !taskOnly.has(subject.taskId)) return;
			const identity = nonEmpty(subject.sessionId) ? `session:${subject.sessionId}` : `parent:${subject.parentSessionId ?? subject.rootSessionId ?? ""}`;
			trackOwner(taskSubjects, subject.taskId, identity);
		};
		for (const entry of decisions) if (isRecord(entry)) countSubject(entry);
		for (const record of investigations) if (isRecord(record)) countSubject(record);
	}
	const subjectMatches = (subject) => isRecord(subject) && (sessionAllowed.has(subject.sessionId) ||
		(typeof taskSubjects.get(subject.taskId) === "string") ||
		sessionAllowed.has(subject.parentSessionId) || sessionAllowed.has(subject.rootSessionId));

	// 1. investigations about the session or its descendants
	const selectedInvestigations = investigations.filter((record) => isRecord(record) && subjectMatches(record.subject));

	// 2. the fp set: selected investigations plus lifecycle rows whose subject matches
	const fpSet = new Set(selectedInvestigations.map((record) => record.id).filter(nonEmpty));
	for (const entry of decisions) if (isRecord(entry) && FINDING_EVENTS.has(entry.event) && nonEmpty(entry.fp) && subjectMatches(entry.subject)) fpSet.add(entry.fp);

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
	const about = decisions.filter((entry) => isRecord(entry) && ((nonEmpty(entry.fp) && fpSet.has(entry.fp)) || subjectMatches(entry.subject) || (nonEmpty(row.sessionId) && entry.sessionId === row.sessionId)));
	const delivered = decisions.filter((entry) => isRecord(entry) && sessionAllowed.has(entry.outcome?.sessionId));
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
	const { machine, infoFindings } = inputs.decisionHistory ?? scanDecisionHistory(decisions.filter((entry) => Number.isFinite(timeOf(entry))).sort((a, b) => timeOf(a) - timeOf(b)), row);
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

	const session = cleanValue(row);
	session.durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;

	return {
		found: true,
		id: row.sessionId,
		session,
		tokens,
		children,
		coverage: { infoFindings },
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
	const byTask = new Map();
	for (const link of links) {
		if (!byId.has(link.sessionId)) byId.set(link.sessionId, link);
		if (!nonEmpty(link.taskId)) continue;
		if (!byTask.has(link.taskId)) byTask.set(link.taskId, link);
		else if (byTask.get(link.taskId)?.sessionId !== link.sessionId) byTask.set(link.taskId, null);
	}
	const linkFor = (id) => byId.get(id) ?? byTask.get(id);
	const subject = linkFor(id);
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
			const parent = linkFor(parentId);
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
 * Read everything the record needs and join it. A file that exceeds the
 * per-file limit or the remaining total message scan budget is skipped and
 * listed in `truncated.messagesSkipped`. The dashboard defaults to no limits.
 */
export function loadSessionRecord({ paths, id, now = Date.now(), messageScanMaxBytes = Infinity, messageScanTotalBytes = Infinity, descendantScanMax = Infinity, scanMessages = scanOmoHealthMessages, locator, index } = {}) {
	if (!nonEmpty(id)) return { found: false, id };
	const usage = index ?? readUsageIndex(paths.health.usageIndexFile);
	const joined = recordLedger(() => streamEnded(paths, { sinceMs: now - 30 * DAY_MS }), id, usage, descendantScanMax);
	if (!joined) return { found: false, id };
	const { row, descendants, ancestors, scanned } = joined;
	const startedMs = msOf(row.startedMs);
	const decisions = readDecisions(paths, (Number.isFinite(startedMs) ? startedMs : now) - 30 * DAY_MS);
	const decisionHistory = scanDecisionHistory(streamDecisions(paths), row);
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
	let scannedBytes = 0;
	for (const { sessionId, file } of files) {
		const stat = statSafe(file);
		if (!stat?.isFile()) continue;
		if (stat.size > messageScanMaxBytes || scannedBytes + stat.size > messageScanTotalBytes) {
			skipped.push(file);
			continue;
		}
		scannedBytes += stat.size;
		for (const message of scanMessages(file) ?? []) messages.push({ ...message, recipient: sessionId });
	}

	return buildSessionRecord({ id, row, descendants, usage, decisions, decisionHistory, investigations, messages, truncated: { messagesSkipped: skipped } });
}
