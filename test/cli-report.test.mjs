import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { main } from "../bin/omo-health.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

async function captured(fn) {
	const lines = [];
	const [log, error] = [console.log, console.error];
	console.log = (...args) => lines.push(args.join(" "));
	console.error = (...args) => lines.push(args.join(" "));
	try {
		return { code: await fn(), text: lines.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

test("`report` queues a report for the daemon, refuses an identical one, and needs a subject and text", async () => {
	const root = tmpDir("omoh-report-");
	const env = { USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "h") };
	const first = await captured(() => main(["report", "st_c", "subagent", "hangs", "--json"], env));
	assert.equal(first.code, 0);
	const out = JSON.parse(first.text);
	assert.deepEqual([out.outcome, out.subject, out.text], ["queued", "st_c", "subagent hangs"]);
	const queued = JSON.parse(fs.readFileSync(out.file, "utf8"));
	assert.deepEqual([queued.via, queued.subject, queued.text], ["cli", "st_c", "subagent hangs"]);
	const again = await captured(() => main(["report", "st_c", "subagent", "hangs"], env));
	assert.equal(again.code, 0, "a duplicate is not an error for the agent that sent it");
	assert.match(again.text, /이미/);
	assert.deepEqual(fs.readdirSync(resolvePaths(env).health.intakeDir).filter((name) => name.endsWith(".json")), [path.basename(out.file)]);
	assert.equal((await captured(() => main(["report", "st_c"], env))).code, 2);
});
