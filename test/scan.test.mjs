import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/paths.mjs";
import { runScan } from "../src/scan.mjs";
import { E, iso, tmpDir, writeJsonl, writeTask } from "./helpers/fixtures.mjs";

const NOT_CONFIGURED = "Provider is not configured: anthropic-subscription";

/** A small F1: session m1 edits settings.json, the config watcher fires, 12 not-configured errors follow. */
function f1Sandbox() {
	const root = tmpDir("omoh-scan-test-");
	const env = { USERPROFILE: root, APPDATA: path.join(root, "AppData", "Roaming"), OMO_HEALTH_OMO_HOME: path.join(root, "o"), OMO_HEALTH_CLAUDE_HOME: path.join(root, "c") };
	const paths = resolvePaths(env);
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
	fs.writeFileSync(paths.settingsFile, "{}");
	const now = Math.floor(Date.now() / 1000) * 1000;
	const edit = now - 10 * 60_000;
	writeJsonl(path.join(paths.sessionsDir, "--proj--", `${iso(edit - 600_000).replace(/[:.]/g, "-")}_m1.jsonl`), [
		E.header("m1", proj, edit - 600_000),
		E.user("fix settings", edit - 590_000),
		E.assistant({ ms: edit - 120_000, text: "ok" }),
		E.assistant({ ms: edit, calls: [{ id: "toolu_edit", name: "edit", args: { path: paths.settingsFile, edits: [] } }] }),
		E.toolResult("toolu_edit", edit + 50, { name: "edit" }),
	]);
	writeTask(proj, { task_id: "st_dead", status: "running", host_pid: 999_999, parent_session_id: "m1", root_session_id: "m1", created_at: iso(edit - 480_000), updated_at: iso(edit - 480_000) });
	fs.mkdirSync(paths.logsDir, { recursive: true });
	fs.writeFileSync(path.join(paths.logsDir, "config-reload.log"), `${JSON.stringify({ ts: iso(edit + 300), level: "info", event: "change_detected", paths: [paths.settingsFile], deferred: false })}\n`);
	const errors = Array.from({ length: 12 }, (_, i) => JSON.stringify({ ts: iso(edit + 400 + i * 500), level: "warn", event: "provider_error", kind: "error", error: NOT_CONFIGURED }));
	fs.writeFileSync(path.join(paths.logsDir, "session.log"), `${errors.join("\n")}\n`);
	return { root, env, now, edit };
}

test("scan: F1 in history mode yields D6 burst, D7 with writer, D14 and no process-based findings", async () => {
	const { root, env, now, edit } = f1Sandbox();
	try {
		const found = await runScan({ fromMs: edit - 5 * 60_000, toMs: now + 30_000, env });
		const one = (detector, kind) => found.find((f) => f.detector === detector && f.kind === kind);
		const burst = one("D6", "not-configured-burst");
		assert.ok(burst, JSON.stringify(found.map((f) => `${f.detector}/${f.kind}`)));
		assert.ok(Date.parse(burst.at) >= edit && Date.parse(burst.at) <= edit + 30_000);
		const d7 = one("D7", "settings-broke-provider");
		assert.deepEqual(d7.data.writer, { sessionId: "m1", toolCallId: "toolu_edit", tool: "edit" });
		assert.equal(d7.data.revertSkipped, "no-lkg");
		assert.equal(one("D14", "global-config-write").subject.sessionId, "m1");
		assert.deepEqual(found.filter((f) => f.detector === "D8"), [], "no process data in a scan: nothing is judged dead");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("scan: a window before the incident sees none of its later log events", async () => {
	const { root, env, edit } = f1Sandbox();
	try {
		assert.deepEqual(await runScan({ fromMs: edit - 5 * 60_000, toMs: edit - 10_000, env }), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
