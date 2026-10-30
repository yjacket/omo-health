import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { main } from "../bin/omo-health.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

async function statusText(env) {
	const lines = [];
	const log = console.log;
	console.log = (...args) => lines.push(args.join(" "));
	try {
		assert.equal(await main(["status"], env), 0);
	} finally {
		console.log = log;
	}
	return lines.join("\n");
}

test("`omo-health status` labels an R11 finding waiting on a spent analyst budget instead of printing its raw state (#82)", async () => {
	const root = tmpDir("omoh-status-");
	const env = { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), OMO_HEALTH_CLAUDE_HOME: path.join(root, "c"), OMO_KEEPWARM_HOME: path.join(root, "kw") };
	const paths = resolvePaths(env);
	fs.mkdirSync(paths.health.statusDir, { recursive: true });
	const incident = (fp, state) => ({ fp, titleKo: `호출 ${fp}`, severity: "warn", firstSeenMs: Date.now() - 60_000, state, actions: [] });
	fs.writeFileSync(path.join(paths.health.statusDir, "_global.json"), JSON.stringify({ ts: Date.now(), level: "warn", text: "t", incidents: [incident("a", "analyst-budget-spent"), incident("b", "escalated")] }));
	const text = await statusText(env);
	assert.match(text, /호출 a \(분석 예산 소진 — 풀지 않고 대기\)/);
	assert.match(text, /호출 b \(escalated\)/, "other states print as they are");
	assert.doesNotMatch(text, /analyst-budget-spent/);
});
