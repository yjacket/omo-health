import { createHash } from "node:crypto";
import path from "node:path";
import { safeSubjectId } from "./session-id.mjs";

/** senpi dist/core/session-manager.js, getDefaultSessionDirPath. */
export function projectKeyOf(cwd) {
	if (typeof cwd !== "string" || !cwd) return null;
	const paths = /^[A-Za-z]:[/\\]|^\\\\/.test(cwd) ? path.win32 : path;
	return `--${paths.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function subjectOf(row, parent) {
	return {
		projectKey: row?.projectKey ?? projectKeyOf(row?.cwd) ?? parent?.projectKey ?? null,
		sessionId: row?.sessionId ?? row?.id ?? null,
	};
}

export function subjectKey(subject) {
	return subject?.sessionId ? JSON.stringify([subject.projectKey ?? null, subject.sessionId]) : null;
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
		const { sessionId } = subjectOf(row);
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
