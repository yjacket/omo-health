import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readWarmup } from "../src/collect/warmup.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const segment = (ts, fields) => JSON.stringify({ v: 1, ts, type: "segment_open", session: "s1", episode: 1, segment: 1, reason: "idle", ...fields });

test("readWarmup returns the newest segment_open of the newest month, and no record when keepalive wrote none", () => {
	const home = tmpDir("omoh-warm-");
	assert.deepEqual(readWarmup(home, "s1"), { record: false });
	for (const [month, lines] of [
		["2026-10", [segment("2026-10-30T10:00:00Z", { eligible: true, disabledReason: null })]],
		["2026-11", [segment("2026-11-06T10:00:00Z", { eligible: true, disabledReason: null }), JSON.stringify({ v: 1, ts: "2026-11-06T10:05:00Z", type: "warm_fire", session: "s1" }), segment("2026-11-06T12:00:00Z", { eligible: false, disabledReason: "prefix_unsafe", disabledDetail: "prompt prefix skipped" })]],
	]) {
		fs.mkdirSync(path.join(home, "records", month), { recursive: true });
		fs.writeFileSync(path.join(home, "records", month, "s1.jsonl"), `${lines.join("\n")}\n`);
	}
	assert.deepEqual(readWarmup(home, "s1"), { record: true, eligible: false, disabledReason: "prefix_unsafe", disabledDetail: "prompt prefix skipped", ms: Date.parse("2026-11-06T12:00:00Z") });
	assert.deepEqual(readWarmup(home, "other"), { record: false });
});
