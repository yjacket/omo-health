import { createSessionFileLocator } from "../../src/collect/session-files.mjs";
import { appendEnded, streamEnded } from "../../src/session-ledger.mjs";
import { createUsageIndex } from "../../src/usage-index.mjs";
import { createUsageTracker } from "../../src/usage-tracker.mjs";
import { E, writeTask } from "./fixtures.mjs";

export function indexLiveParentTranscript(paths, cwd, now, { taskOnly = false, descendant = false } = {}) {
	const clock = { now: () => now };
	const index = createUsageIndex({ file: paths.health.usageIndexFile, clock });
	const tracker = createUsageTracker({ paths, index, clock, locator: createSessionFileLocator({ paths, clock }) });
	const live = { id: "live-parent", kind: "main", cwd };
	const add = (sessionId, taskId, parentSessionId, kind, minutesAgo) => {
		const id = taskOnly ? taskId : sessionId;
		const ms = now - minutesAgo * 60_000;
		const text = `Delivered to ${sessionId}`;
		const file = writeTask(cwd, { task_id: taskId, child_session_id: sessionId, status: "completed" }, [
			E.header(sessionId, cwd, now - 3_600_000),
			E.assistant({ ms }),
			{ ...E.custom("omo-health", ms, { kind }), content: text },
		]);
		appendEnded(paths, { sessionId: id, taskId, parentSessionId, kind: "child", startedMs: now - 3_600_000, endedMs: now - 1, outcome: "completed" }, { nowMs: now });
		return { id, file, taskId, ms, kind, text };
	};
	const child = add("ended-child", "st_ended", live.id, "self-notice", 2);
	const grandchild = descendant ? add("ended-grandchild", "st_grandchild", child.id, "self-notice", 1) : null;
	tracker.queueLedger(streamEnded(paths, { withLocation: true }));
	tracker.tick({ sessions: new Map([[live.id, live]]) });
	return { index, child, grandchild };
}
