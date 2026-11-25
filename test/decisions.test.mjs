import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as decisions from "../src/decisions.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

test("streamDecisions yields retained days in order and tolerates malformed and partial rows", (t) => {
	const decisionsDir = tmpDir("omoh-decisions-");
	t.after(() => fs.rmSync(decisionsDir, { recursive: true, force: true }));
	const paths = { health: { decisionsDir } };
	const older = { ts: "2026-09-01T12:00:00Z", evidence: ["a".repeat(65_490) + "가나다".repeat(20)] };
	const newer = { ts: "2026-10-10T12:00:00Z", event: "resolved" };
	fs.writeFileSync(path.join(decisionsDir, "2026-10-10.jsonl"), `not JSON\n${JSON.stringify(newer)}\n{"ts":`);
	fs.writeFileSync(path.join(decisionsDir, "2026-09-01.jsonl"), JSON.stringify(older));
	fs.writeFileSync(path.join(decisionsDir, "ignore.txt"), JSON.stringify(newer));
	assert.deepEqual([...decisions.streamDecisions(paths)], [older, newer]);
});
