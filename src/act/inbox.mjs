import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, listDirSafe, readJsonSafe, statSafe } from "../util/fsx.mjs";

/**
 * Daemon -> sensor mailbox (plan D-7): one JSON file per message under
 * healthHome/inbox/<sessionId>/; the sensor delivers it and writes
 * healthHome/receipts/<id>.json.
 */
export function sendToSession(paths, message) {
	const dir = path.join(paths.health.inboxDir, safeSegment(message.sessionId));
	const file = path.join(dir, `${message.createdMs}-${message.id}.json`);
	atomicWriteJson(file, message);
	return file;
}

export function readReceipt(paths, messageId) {
	return readJsonSafe(path.join(paths.health.receiptsDir, `${messageId}.json`));
}

export function pendingMessages(paths, sessionId) {
	const dir = path.join(paths.health.inboxDir, safeSegment(sessionId));
	return listDirSafe(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => ({ file: path.join(dir, name), message: readJsonSafe(path.join(dir, name)) }))
		.filter((entry) => entry.message);
}

/** Messages older than `maxAgeMs` with no receipt count as undelivered; they are moved aside. */
export function sweepUndelivered(paths, now, maxAgeMs = 5 * 60_000) {
	const undelivered = [];
	for (const sessionDir of listDirSafe(paths.health.inboxDir)) {
		for (const entry of pendingMessages(paths, sessionDir)) {
			// The owner can be absent for days: keep this notice until its sensor returns, unless it is a month old or
			// the owner's session file is gone. An expired notice is set aside quietly, never as a toast.
			if (entry.message.kind === "self-notice" && entry.message.details?.actionKind === "kill-orphan-watchers") {
				const sessionFile = entry.message.details.sessionFile;
				if (now - (entry.message.createdMs ?? 0) >= NOTICE_KEEP_MS || (typeof sessionFile === "string" && !statSafe(sessionFile))) setAside(paths, entry.file);
				continue;
			}
			if (now - (entry.message.createdMs ?? 0) < maxAgeMs) continue;
			if (readReceipt(paths, entry.message.id)) continue;
			undelivered.push(entry.message);
			setAside(paths, entry.file);
		}
	}
	return undelivered;
}

const NOTICE_KEEP_MS = 30 * 24 * 3600_000;

function setAside(paths, file) {
	const dead = path.join(paths.health.inboxDir, "_undelivered");
	fs.mkdirSync(dead, { recursive: true });
	try {
		fs.renameSync(file, path.join(dead, path.basename(file)));
	} catch {
		// already delivered and removed by the sensor
	}
}

function safeSegment(value) {
	return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}
