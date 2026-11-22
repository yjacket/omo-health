import { createHash } from "node:crypto";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { safeSubjectId } from "./session-id.mjs";

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
	// The ledger records this only when it resolved a project without an own cwd.
	if (row?.endedProjectKey && row.projectKey == null) {
		return { projectKey: projectKeyOf(row.cwd) ?? row.endedProjectKey, sessionId: row.sessionId ?? row.id ?? null };
	}
	return {
		projectKey: row?.projectKey ?? projectKeyOf(row?.cwd) ?? parent?.projectKey ?? null,
		sessionId: row?.sessionId ?? row?.id ?? null,
	};
}

export function subjectKey(subject) {
	return subject?.sessionId ? JSON.stringify([subject.projectKey ?? null, subject.sessionId]) : null;
}

export function parseSubjectKey(key) {
	if (typeof key !== "string") return key;
	try {
		const parts = JSON.parse(key);
		if (Array.isArray(parts) && parts.length === 2 && (parts[0] === null || typeof parts[0] === "string") &&
			typeof parts[1] === "string" && parts[1]) return { projectKey: parts[0], sessionId: parts[1] };
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

/** Scope raw IDs without storing serialized [project, id] keys. String keys are accepted at API boundaries. */
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
		const slot = this.#projects.get(this.#project(subject))?.ids.get(subject.sessionId ?? subject.id);
		return this.#order ? slot?.value : slot;
	}

	/** Read-side resolution only: a null project is a bare ID, not a preferred bucket. */
	getForSubject(subject) {
		if (subject.projectKey != null) return this.get(subject);
		const id = subject.sessionId ?? subject.id;
		const slot = uniqueMatch(this.#projects.values(), ({ ids }) => ids.get(id));
		return this.#order && slot != null ? slot.value : slot;
	}

	has(key) { return this.get(key) !== undefined; }

	set(key, value) {
		const subject = parseSubjectKey(key);
		const project = this.#project(subject);
		const id = subject.sessionId ?? subject.id;
		let bucket = this.#projects.get(project);
		if (!bucket) this.#projects.set(project, bucket = { key: project, ids: new Map() });
		const { ids } = bucket;
		if (!ids.has(id)) this.#size++;
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
		const id = subject.sessionId ?? subject.id;
		const ids = this.#projects.get(project)?.ids;
		if (!ids?.has(id)) return false;
		this.#order?.delete(ids.get(id));
		ids.delete(id);
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
		const subject = (project, sessionId) => this.#pack
			? { [PACKED_PROJECT]: project, get projectKey() { return unpackScopedText(project); }, sessionId }
			: { projectKey: project, sessionId };
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
		(subject.projectKey !== null && (typeof subject.projectKey !== "string" || !subject.projectKey))) return null;
	return createHash("sha256").update(subjectKey(subject)).digest("hex").slice(0, 32);
}

/** Inherit only from an unambiguous parent when a child has no cwd. */
export function sessionSubjects(rows) {
	const byId = new Map();
	for (const row of rows) {
		const sessionId = row?.sessionId ?? row?.id;
		if (!sessionId) continue;
		const peers = byId.get(sessionId) ?? [];
		peers.push(row);
		byId.set(sessionId, peers);
	}
	const resolve = (row, remaining = 8) => {
		const own = subjectOf(row);
		if (own.projectKey || !remaining || !row?.parentSessionId) return own;
		const parents = byId.get(row.parentSessionId) ?? [];
		const keys = new Set(parents.map((parent) => resolve(parent, remaining - 1).projectKey).filter(Boolean));
		return keys.size === 1 ? subjectOf(row, { projectKey: keys.values().next().value }) : own;
	};
	return resolve;
}
