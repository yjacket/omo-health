import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createIngest } from "../src/budget/ingest.mjs";
import { createBudgetStore } from "../src/budget/store.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { openDb } from "../src/db/db.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { createFakeClock } from "../src/util/time.mjs";
import { appendJsonl, E, iso, tmpDir, writeJsonl } from "./helpers/fixtures.mjs";

const T0 = Date.UTC(2026, 10, 12, 6, 0, 0);
const MIN = 60_000;
const SID = "gate-main";
const ANTHROPIC = { account: "anthropic-subscription/default", window: { id: "claude:7d" } };

function modelChange(provider, ms) {
	return { type: "model_change", id: `mc-${provider}-${ms}`, timestamp: iso(ms), provider };
}

/** An assistant usage record without `message.provider`: attribution must come from the latest model_change. */
function usageEntry(id, ms, cost) {
	return {
		type: "message",
		id,
		timestamp: iso(ms),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			model: "claude-opus-5-5",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			stopReason: "stop",
			timestamp: ms,
		},
	};
}

function setup(t) {
	const root = tmpDir("omoh-ingest-restart-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	const cwd = path.join(root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const file = path.join(paths.sessionsDir, "--proj--", `2026-11-12T00-00-00-000Z_${SID}.jsonl`);
	const db = openDb({ file: ":memory:" });
	t.after(() => db.close());
	const clock = createFakeClock(T0);
	const config = structuredClone(DEFAULT_CONFIG);
	config.budget.backfillDays = 3650;
	const store = createBudgetStore(db);
	writeJsonl(file, [E.header(SID, cwd, T0), modelChange("anthropic-subscription", T0 + MIN), usageEntry("a", T0 + 2 * MIN, 12)]);
	return {
		file,
		store,
		ingest: () => createIngest({ paths, store, clock, config, readTaskStores: () => [] }),
		rows: () => db.prepare("SELECT id, provider, cost FROM usage_events ORDER BY ms, id").all().map((row) => ({ ...row })),
	};
}

test("a restarted ingest restores the provider context of the stored offset", (t) => {
	const { file, store, ingest, rows } = setup(t);
	assert.equal(ingest().run().inserted, 1);
	assert.deepEqual(rows(), [{ id: `${SID}:a`, provider: "anthropic-subscription", cost: 12 }]);
	assert.equal(store.spend({ accounts: ANTHROPIC }).costUsd, 12);

	// The process ends after the model_change and before the next usage record; the byte offset survives.
	appendJsonl(file, [usageEntry("b", T0 + 3 * MIN, 3)]);
	const restarted = ingest();
	assert.equal(restarted.run().inserted, 1);
	assert.deepEqual(rows(), [
		{ id: `${SID}:a`, provider: "anthropic-subscription", cost: 12 },
		{ id: `${SID}:b`, provider: "anthropic-subscription", cost: 3 },
	]);
	assert.equal(store.spend({ accounts: ANTHROPIC }).costUsd, 15, "the row appended after the restart belongs to the same account");
	assert.equal(store.getOffset(file).provider, "anthropic-subscription", "the offset carries the provider for the next process");
});

test("a model_change after the restart still switches the provider, durably", (t) => {
	const { file, ingest, rows } = setup(t);
	ingest().run();
	appendJsonl(file, [usageEntry("b", T0 + 3 * MIN, 3)]);
	const restarted = ingest();
	restarted.run();

	appendJsonl(file, [modelChange("chatgpt-subscription", T0 + 4 * MIN), usageEntry("c", T0 + 5 * MIN, 4)]);
	restarted.run();
	assert.deepEqual(
		rows().map((row) => [row.id, row.provider]),
		[
			[`${SID}:a`, "anthropic-subscription"],
			[`${SID}:b`, "anthropic-subscription"],
			[`${SID}:c`, "chatgpt-subscription"],
		],
	);
	assert.equal(restarted.run().inserted, 0, "a run with no new bytes inserts nothing");

	// Another process start resumes after the chatgpt model_change.
	appendJsonl(file, [usageEntry("d", T0 + 6 * MIN, 5)]);
	ingest().run();
	assert.deepEqual(rows().at(-1), { id: `${SID}:d`, provider: "chatgpt-subscription", cost: 5 });
});
