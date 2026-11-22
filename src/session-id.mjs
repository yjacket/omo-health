import { createHash } from "node:crypto";

// Senpi's assertValidSessionId grammar, with a dashboard route bound.
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Return the exact subject ID if valid, otherwise null. */
export function safeSubjectId(id) {
	return typeof id === "string" && id.length <= 1024 && SESSION_ID.test(id) ? id : null;
}

/** A fixed-length, case-insensitive-filesystem-safe key for the exact ID. */
export function auditFileKey(id) {
	return safeSubjectId(id) === null ? null : createHash("sha256").update(id).digest("hex").slice(0, 32);
}
