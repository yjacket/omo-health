import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir(prefix = "omoh-") {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const iso = (ms) => new Date(ms).toISOString();

let counter = 0;
const nextId = () => (++counter).toString(16).padStart(8, "0");

/** Builders for senpi v3 session JSONL entries (F-6). */
export const E = {
	header(id, cwd, ms) {
		return { type: "session", version: 3, id, timestamp: iso(ms), cwd };
	},
	user(text, ms) {
		return { type: "message", id: nextId(), timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }], timestamp: ms } };
	},
	assistant({ ms, startMs = ms - 2000, calls = [], text = "", stopReason, usage, provider = "anthropic-subscription", model = "claude-opus-5-5", errorMessage, id }) {
		const content = [];
		if (text) content.push({ type: "text", text });
		for (const call of calls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} });
		return {
			type: "message",
			id: id ?? nextId(),
			timestamp: iso(ms),
			message: {
				role: "assistant",
				content,
				provider,
				model,
				usage: usage ?? { input: 2, output: 300, cacheRead: 50_000, cacheWrite: 1000, totalTokens: 51_302, cost: { total: 0.03 } },
				stopReason: stopReason ?? (calls.length ? "toolUse" : "stop"),
				timestamp: startMs,
				...(errorMessage ? { errorMessage } : {}),
			},
		};
	},
	toolResult(toolCallId, ms, { name = "bash", text = "ok", isError = false } = {}) {
		return { type: "message", id: nextId(), timestamp: iso(ms), message: { role: "toolResult", toolCallId, toolName: name, content: [{ type: "text", text }], isError, timestamp: ms } };
	},
	custom(customType, ms, details = {}) {
		return { type: "custom_message", customType, id: nextId(), timestamp: iso(ms), content: "x", details };
	},
};

export function writeJsonl(file, entries) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

export function appendJsonl(file, entries) {
	fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Create a task store record + child session file under <cwd>/.omo/senpi-task (or an explicit store dir). */
export function writeTask(cwd, task, childEntries, { storeDir } = {}) {
	const store = storeDir ?? path.join(cwd, ".omo", "senpi-task");
	fs.mkdirSync(path.join(store, "tasks"), { recursive: true });
	fs.writeFileSync(path.join(store, "tasks", `${task.task_id}.json`), JSON.stringify(task));
	if (childEntries) {
		const file = path.join(store, "children", task.task_id, "sessions", task.task_id, `2026-09-23T14-20-50-579Z_${task.child_session_id}.jsonl`);
		writeJsonl(file, childEntries);
		return file;
	}
	return undefined;
}
