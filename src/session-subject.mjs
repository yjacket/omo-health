import { createHash } from "node:crypto";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { projectStoreName } from "./collect/tasks.mjs";
import { safeSubjectId } from "./session-id.mjs";
import { readJsonSafe } from "./util/fsx.mjs";

// Adjacent ledger rows often share a cwd (including large audit families).
// Bound the memo to one path so walking unrelated projects does not intern them for life.
let lastCwd;
let lastProject;

/** senpi dist/core/session-manager.js, getDefaultSessionDirPath. */
export function projectKeyOf(cwd) {
	if (typeof cwd !== "string" || !cwd) return null;
	if (cwd === lastCwd) return lastProject;
	const paths = /^[A-Za-z]:[/\\]|^\\\\/.test(cwd) ? path.win32 : path;
	// Relative paths depend on process.cwd(), so only memoize absolute paths.
	const projectKey = `--${paths.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	if (cwd.length <= 32_768 && (/^[A-Za-z]:[/\\]|^\\\\/.test(cwd) || (path.sep === "/" && paths.isAbsolute(cwd)))) {
		lastCwd = cwd;
		lastProject = projectKey;
	}
	return projectKey;
}

export function subjectOf(row, parent) {
	const taskId = row?.kind === "main" ? null : row?.ledgerIds?.taskId ?? row?.taskId ?? null;
	// The ledger records this only when it resolved a project without an own cwd.
	if (row?.endedProjectKey && row.projectKey == null) {
		return { projectKey: projectKeyOf(row.cwd) ?? row.endedProjectKey, sessionId: row.sessionId ?? row.id ?? null, taskId };
	}
	return {
		projectKey: row?.projectKey ?? projectKeyOf(row?.cwd) ?? parent?.projectKey ?? null,
		sessionId: row?.sessionId ?? row?.id ?? null,
		taskId,
	};
}

/** A task can identify its child's project before the transcript reaches the live registry. */
export function childSubjectOf({ sessionId, task, world, parent, child }) {
	const taskId = task?.taskId ?? child?.taskId ?? null;
	const registered = child ?? (sessionId ? world?.sessions?.get(sessionId) : undefined);
	const live = registered?.kind === "child" &&
		(!taskId || (registered.taskId ?? registered.task?.taskId) === taskId) ? registered : undefined;
	return {
		projectKey: projectKeyOf(live?.cwd) ?? projectKeyOf((task ?? live?.task)?.spawnCwd) ?? parent?.projectKey ?? null,
		sessionId: sessionId ?? null,
		taskId: taskId ?? live?.taskId ?? live?.task?.taskId ?? null,
	};
}

/** Resolve a task's parent from its spawning store, not the child's spawn cwd. */
export function taskParentResolver(world, agentDir = world?.paths?.agentDir, knownCwds = []) {
	let userStores;
	const userStoreProject = (storeDir) => {
		if (!agentDir || path.dirname(path.dirname(storeDir)) !== path.resolve(agentDir, "projects")) return null;
		if (!userStores) {
			userStores = new Map();
			// The per-user directory name is a hash. Reverse it only against known projects.
			const cwds = new Set(world?.config?.extraProjects ?? []);
			for (const cwd of knownCwds) if (cwd) cwds.add(cwd);
			for (const row of world?.sessions?.values?.() ?? []) if (row.cwd) cwds.add(row.cwd);
			for (const sensor of world?.sensors?.values?.() ?? []) if (sensor.cwd) cwds.add(sensor.cwd);
			for (const task of world?.tasks ?? []) if (task.spawnCwd) cwds.add(task.spawnCwd);
			for (const cwd of cwds) {
				const store = path.resolve(agentDir, "projects", projectStoreName(cwd), "senpi-task");
				const key = projectKeyOf(cwd);
				userStores.set(store, !userStores.has(store) || userStores.get(store) === key ? key : null);
			}
		}
		return userStores.get(storeDir) ?? null;
	};
	return (task, legacyParent) => {
		const sessionId = task?.parentSessionId;
		if (!sessionId) return null;
		// Store-less callers have no provenance; only these may use the old fallback.
		if (!task.storeDir) return { sessionId, projectKey: legacyParent?.projectKey ?? null, taskId: legacyParent?.taskId ?? null };
		const storeDir = path.resolve(task.storeDir);
		if (path.basename(storeDir) !== "senpi-task") return null;
		const dir = path.dirname(storeDir);
		const projectKey = path.basename(dir) === ".omo" ? projectKeyOf(path.dirname(dir)) : userStoreProject(storeDir);
		const live = world?.sessions?.get(sessionId);
		const parent = subjectOf(live);
		return projectKey ? { sessionId, projectKey, taskId: parent.projectKey === projectKey ? parent.taskId : null } : null;
	};
}

/** Read exact identities, not the dashboard's redacted display paths. */
export function boardLiveOwners(paths) {
	const snapshot = readJsonSafe(paths.health.sessionsSnapshotFile);
	const owners = new Map();
	if (snapshot?.v === 1 && Array.isArray(snapshot.liveOwners)) {
		for (const row of snapshot.liveOwners) {
			if (typeof row?.sessionId !== "string" || !row.sessionId ||
				(row.projectKey !== null && typeof row.projectKey !== "string")) continue;
			const owner = subjectOf(row);
			owners.set(subjectKey(owner), owner);
		}
		return sortedOwners(owners);
	}
	const walk = (rows, parent, depth = 0) => {
		if (!Array.isArray(rows) || depth > 8) return;
		for (const row of rows) {
			if (!row) continue;
			const owner = subjectOf(row, parent);
			const active = !depth || (row.endedMs == null && ["running", "queued", "pending", "starting", "spawning"].includes(row.status));
			if (active && owner.projectKey && typeof owner.sessionId === "string" && owner.sessionId) owners.set(subjectKey(owner), owner);
			walk(row.children, owner, depth + 1);
		}
	};
	if (snapshot?.v === 1 && Array.isArray(snapshot.groups)) {
		for (const group of snapshot.groups) walk(group?.sessions);
	}
	return [...owners.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, owner]) => owner);
}

function sortedOwners(owners) {
	return [...owners.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, owner]) => owner);
}

/**
 * The live registry: one entry per {project, session id, task id}, so two live sessions that share an ID in different
 * projects stay apart. A bare ID still resolves, but only to the one session that owns it: `get` is undefined and
 * `sessionsById` lists every owner when it is shared, so an ID-only caller cannot pick one twin by accident.
 */
export class LiveSessions extends Map {
	#byId = new Map();

	static of(sessions) {
		const out = new LiveSessions();
		for (const session of sessions) out.set(subjectKey(subjectOf(session)), session);
		return out;
	}

	set(key, session) {
		this.delete(key);
		super.set(key, session);
		const id = session?.id;
		if (!this.#byId.has(id)) this.#byId.set(id, new Map());
		this.#byId.get(id).set(key, session);
		return this;
	}

	get(key) {
		if (super.has(key)) return super.get(key);
		const owners = this.#byId.get(key);
		return owners?.size === 1 ? owners.values().next().value : undefined;
	}

	has(key) {
		return super.has(key) || this.#byId.has(key);
	}

	delete(key) {
		if (!super.has(key)) return false;
		const id = super.get(key)?.id;
		super.delete(key);
		const owners = this.#byId.get(id);
		owners?.delete(key);
		if (owners && !owners.size) this.#byId.delete(id);
		return true;
	}

	clear() {
		super.clear();
		this.#byId.clear();
	}

	sessionsById(id) {
		return [...(this.#byId.get(id)?.values() ?? [])];
	}
}

/** A heartbeat names its session by ID only. When the ID is shared, it belongs to the twin of its transcript or project. */
export function heartbeatOwns(heartbeat, session, twins) {
	if (!heartbeat || !twins) return Boolean(heartbeat);
	if (heartbeat.sessionFile && heartbeat.sessionFile === session.file) return true;
	const own = projectKeyOf(heartbeat.cwd);
	return own !== null && own === subjectOf(session).projectKey;
}

/** Project the sensor's exact live transcript without changing the raw-ID runtime registry. */
export function liveSessionView(session, world) {
	const heartbeat = session?.kind !== "main" ? undefined : world?.sensorOfSession ? world.sensorOfSession(session) : world?.sensorFor?.(session.id);
	if (typeof heartbeat?.sessionFile !== "string" || !heartbeat.sessionFile) return session;
	// A heartbeat without cwd may inherit it only from the very same transcript.
	const sameFile = heartbeat.sessionFile === session.file;
	const cwd = heartbeat.cwd || (sameFile ? session.cwd : undefined);
	const projectKey = projectKeyOf(heartbeat.cwd) ?? (sameFile ? subjectOf(session).projectKey : null);
	return { ...session, file: heartbeat.sessionFile, cwd, projectKey };
}

export function worldLiveOwners(world) {
	// A shared ID's ended transcript stays in the registry beside its live twin; only a twin that is live owns its subject.
	const rows = [...(world?.sessions?.values?.() ?? [])]
		.filter((row) => !world.isSharedId?.(row.id) || world.isSessionLive(row))
		.map((row) => liveSessionView(row, world));
	return rows.map(sessionSubjects(rows, world));
}

/** Track only the requested IDs. Repeated rows of one scoped subject are one owner. */
export function rememberParentOwner(owners, subject) {
	const { sessionId } = subject;
	if (!owners.has(sessionId)) owners.set(sessionId, subject);
	else if (subjectKey(owners.get(sessionId)) !== subjectKey(subject)) owners.set(sessionId, null);
}

export function ledgerParentSubject(row, owners) {
	if (!row.parentSessionId) return null;
	const sessionId = row.parentSessionId;
	const owner = owners?.get(sessionId);
	if (row.parentProjectKey == null) return owner ?? null;
	if (row.parentTaskId == null && owner?.projectKey === row.parentProjectKey) return owner;
	return { sessionId, projectKey: row.parentProjectKey, taskId: row.parentTaskId ?? null };
}

export function subjectKey(subject) {
	return subject?.sessionId ? JSON.stringify([subject.projectKey ?? null, subject.sessionId, subject.taskId ?? null]) : null;
}

export function parseSubjectKey(key) {
	if (typeof key !== "string") return key;
	try {
		const parts = JSON.parse(key);
		if (Array.isArray(parts) && (parts.length === 2 || parts.length === 3) && (parts[0] === null || typeof parts[0] === "string") &&
			typeof parts[1] === "string" && parts[1] && (parts[2] == null || typeof parts[2] === "string")) {
			return { projectKey: parts[0], sessionId: parts[1], ...(parts.length === 3 ? { taskId: parts[2] } : {}) };
		}
	} catch {}
	return null;
}

/** undefined for no match, null for ambiguity. Never retain the candidates. */
export function uniqueMatch(candidates, select) {
	let found;
	for (const candidate of candidates) {
		const match = select(candidate);
		if (match === undefined) continue;
		if (found !== undefined) return null;
		found = match;
	}
	return found;
}

/** Keep unusually long ledger identities losslessly, including distinct paths with a common prefix. */
export function packScopedText(text) {
	if (text == null) return null;
	if (text.length > 1024) {
		const packed = deflateRawSync(Buffer.from(text, "utf16le"), { level: 1 }).toString("base64");
		if (packed.length + 2 < text.length) return `\0z${packed}`;
	}
	return text.startsWith("\0") ? `\0${text}` : text;
}

export function unpackScopedText(text) {
	if (text?.startsWith("\0z")) return inflateRawSync(Buffer.from(text.slice(2), "base64")).toString("utf16le");
	return text?.startsWith("\0\0") ? text.slice(1) : text;
}

export const PACKED_PROJECT = Symbol("packed project key");

// Most rows are mains: keep their raw ID and never repeat the project in an inner key.
function innerKey(subject) {
	const id = subject.sessionId ?? subject.id;
	if (subject.taskId != null) return `\0${JSON.stringify([id, subject.taskId])}`;
	return id?.startsWith("\0") ? `\0${id}` : id;
}

function innerSubject(key) {
	if (!key.startsWith("\0")) return { sessionId: key };
	if (key.startsWith("\0\0")) return { sessionId: key.slice(1) };
	const [sessionId, taskId] = JSON.parse(key.slice(1));
	return { sessionId, taskId };
}

/** Scope transcript IDs without storing serialized project keys in every row. */
export class SubjectMap {
	#projects = new Map();
	#order;
	#pack;
	#size = 0;

	constructor({ ordered = false, packed = false } = {}) {
		if (ordered) this.#order = new Set();
		this.#pack = packed;
	}

	get size() { return this.#size; }

	#project(subject) {
		if (!this.#pack) return subject.projectKey ?? null;
		return PACKED_PROJECT in subject ? subject[PACKED_PROJECT] : packScopedText(subject.projectKey);
	}

	canonicalProject(projectKey) {
		return this.#projects.get(projectKey)?.key ?? projectKey;
	}

	get(key) {
		const subject = parseSubjectKey(key);
		if (!subject) return undefined;
		const slot = this.#projects.get(this.#project(subject))?.ids.get(innerKey(subject));
		return this.#order ? slot?.value : slot;
	}

	/** Read-side resolution only: a null project is a bare ID, not a preferred bucket. */
	getForSubject(subject) {
		if (subject.projectKey != null) return this.get(subject);
		const id = subject.sessionId ?? subject.id;
		const key = innerKey(subject);
		if ("taskId" in subject) {
			const slot = uniqueMatch(this.#projects.values(), ({ ids }) => ids.get(key));
			return this.#order && slot != null ? slot.value : slot;
		}
		const slots = function* (projects) {
			for (const { ids, children } of projects) {
				if (ids.has(key)) yield ids.get(key);
				if (!children) continue;
				for (const [inner, value] of ids) {
					if (inner.startsWith("\0[") && innerSubject(inner).sessionId === id) yield value;
				}
			}
		};
		const slot = uniqueMatch(slots(this.#projects.values()), (slot) => slot);
		return this.#order && slot != null ? slot.value : slot;
	}

	has(key) { return this.get(key) !== undefined; }

	set(key, value) {
		const subject = parseSubjectKey(key);
		const project = this.#project(subject);
		const id = innerKey(subject);
		let bucket = this.#projects.get(project);
		if (!bucket) this.#projects.set(project, bucket = { key: project, ids: new Map(), children: 0 });
		const { ids } = bucket;
		if (!ids.has(id)) {
			this.#size++;
			if (subject.taskId != null) bucket.children++;
		}
		if (this.#order) {
			const slot = ids.get(id);
			if (slot) slot.value = value;
			else {
				const added = { project: bucket.key, id, value };
				ids.set(id, added);
				this.#order.add(added);
			}
		} else ids.set(id, value);
		return this;
	}

	delete(key) {
		const subject = parseSubjectKey(key);
		if (!subject) return false;
		const project = this.#project(subject);
		const id = innerKey(subject);
		const bucket = this.#projects.get(project);
		const ids = bucket?.ids;
		if (!ids?.has(id)) return false;
		this.#order?.delete(ids.get(id));
		ids.delete(id);
		if (subject.taskId != null) bucket.children--;
		if (!ids.size) this.#projects.delete(project);
		this.#size--;
		return true;
	}

	clear() {
		this.#projects.clear();
		this.#order?.clear();
		this.#size = 0;
	}

	*values() {
		if (this.#order) for (const slot of this.#order) yield slot.value;
		else for (const { ids } of this.#projects.values()) yield* ids.values();
	}

	*subjects() {
		const subject = (project, key) => this.#pack
			? { [PACKED_PROJECT]: project, get projectKey() { return unpackScopedText(project); }, ...innerSubject(key) }
			: { projectKey: project, ...innerSubject(key) };
		if (this.#order) {
			for (const { project, id, value } of this.#order) yield [subject(project, id), value];
		} else {
			for (const { key, ids } of this.#projects.values()) {
				for (const [id, value] of ids) yield [subject(key, id), value];
			}
		}
	}

	*[Symbol.iterator]() {
		for (const [subject, value] of this.subjects()) yield [subjectKey(subject), value];
	}
}

/** Hash only explicit subjects, never legacy raw-id records. */
export function auditFileKey(subject) {
	if (safeSubjectId(subject?.sessionId) === null ||
		(subject.taskId != null && safeSubjectId(subject.taskId) === null) ||
		(subject.projectKey !== null && (typeof subject.projectKey !== "string" || !subject.projectKey))) return null;
	return createHash("sha256").update(subjectKey(subject)).digest("hex").slice(0, 32);
}

/** Inherit only from an unambiguous parent when a child has no cwd. */
export function sessionSubjects(rows, world) {
	const byId = new Map();
	for (const row of rows) {
		const sessionId = row?.sessionId ?? row?.id;
		if (!sessionId) continue;
		const peers = byId.get(sessionId) ?? [];
		peers.push(row);
		byId.set(sessionId, peers);
	}
	const resolve = (row, remaining = 8) => {
		const sessionId = row?.sessionId ?? row?.id;
		const liveChild = row?.kind === "child" && sessionId && world?.sessions?.get(sessionId) === row;
		const own = liveChild ? childSubjectOf({ sessionId, world, child: row }) : subjectOf(row);
		if (own.projectKey || !remaining || !row?.parentSessionId) return own;
		if (row.parentProjectKey != null) return { ...own, projectKey: row.parentProjectKey };
		const parents = byId.get(row.parentSessionId) ?? [];
		const keys = new Set(parents.map((parent) => resolve(parent, remaining - 1).projectKey).filter(Boolean));
		return keys.size === 1 ? { ...own, projectKey: keys.values().next().value } : own;
	};
	return resolve;
}
