import fs from "node:fs";
import path from "node:path";
import { toMs } from "../util/time.mjs";

const cache = new Map();

function cachedJson(file) {
	const now = Date.now();
	const previous = cache.get(file);
	if (previous && now - previous.checkedMs < 60_000) return previous.value;
	let value;
	let mtimeMs;
	try {
		const stat = fs.statSync(file);
		mtimeMs = stat.mtimeMs;
		value = previous && previous.mtimeMs === mtimeMs && previous.size === stat.size
			? previous.value : JSON.parse(fs.readFileSync(file, "utf8"));
		cache.set(file, { checkedMs: now, mtimeMs, size: stat.size, value });
	} catch {
		cache.set(file, { checkedMs: now, value: undefined });
	}
	return value;
}

/** Read the senpi goal extension for this session. Timestamps in the store are epoch seconds. */
export function readGoal(sessionFile, sessionId) {
	const data = cachedJson(path.join(path.dirname(sessionFile), "extensions", "goal", `${sessionId}.json`));
	const goal = data?.goal;
	if (!goal || typeof goal.objective !== "string") return undefined;
	return { objective: goal.objective, status: goal.status, updatedAtMs: typeof goal.updatedAt === "number" ? goal.updatedAt * 1000 : toMs(goal.updatedAt) };
}

/** Return the compact goal list, not the large audit/evidence payload. */
export function readUlwGoals(cwd, sessionId) {
	const data = cachedJson(path.join(cwd, ".omo", "ulw-loop", sessionId, "goals.json"));
	return Array.isArray(data?.goals) ? data.goals.map(({ id, title, status }) => ({ id, title, status })) : [];
}
