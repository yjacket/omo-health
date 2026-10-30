import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detect } from "../src/detect/offtrack.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { makeWorld, sessionState, taskRecord } from "./helpers/world.mjs";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const PATHS = resolvePaths({ USERPROFILE: "C:\\Users\\tester", APPDATA: "C:\\Users\\tester\\AppData\\Roaming" });
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

const write = (p, tool = "write") => ({ ms: NOW - 1000, tool, path: p, id: `w-${p}` });

function world(childWrites, extra = {}) {
	const task = taskRecord({ taskId: "st_w", parentSessionId: "p1", spawnCwd: "C:\\dev\\wt\\a" });
	const parent = sessionState({ id: "p1", kind: "main", cwd: "C:\\dev\\proj", writes: extra.parentWrites, commands: extra.parentCommands });
	const child = sessionState({ id: "c1", kind: "child", taskId: "st_w", parentSessionId: "p1", cwd: "C:\\dev\\wt\\a", task, writes: childWrites, commands: extra.childCommands });
	return makeWorld({ now: NOW, paths: PATHS, sessions: [parent, child] });
}

test("outside-workspace: child writes outside spawnCwd, parent cwd, temp and healthHome", () => {
	const writes = [write("C:\\dev\\wt\\a\\src\\x.mjs"), write("C:\\dev\\proj\\notes.md", "edit"), write(path.join(os.tmpdir(), "scratch.txt")), write(path.join(PATHS.healthHome, "x.json")), write("C:\\Windows\\evil.txt", "edit")];
	const findings = ofKind(detect(world(writes)), "outside-workspace");
	assert.equal(findings.length, 1);
	const [finding] = findings;
	assert.equal(finding.detector, "D14");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, false);
	assert.ok(finding.titleKo.length > 0 && finding.detailKo.length > 0);
	assert.equal(finding.subject.sessionId, "c1");
	assert.deepEqual(finding.data.paths, ["C:\\Windows\\evil.txt"]);
	assert.deepEqual(finding.data.tools, ["edit"]);
	assert.ok(finding.evidence.includes("write:edit:C:\\Windows\\evil.txt"));
});

test("outside-workspace: sibling folder sharing a name prefix is outside; relative paths resolve inside", () => {
	const inside = ofKind(detect(world([write("src/rel.mjs")])), "outside-workspace");
	assert.equal(inside.length, 0);
	const [sibling] = ofKind(detect(world([write("C:\\dev\\wt\\a-other\\f.mjs")])), "outside-workspace");
	assert.deepEqual(sibling.data.paths, ["C:\\dev\\wt\\a-other\\f.mjs"]);
});

test("outside-workspace: worktree writes and main-session writes are not flagged", () => {
	const findings = detect(world([write("C:\\dev\\wt\\a\\deep\\file.mjs")], { parentWrites: [write("D:\\elsewhere\\file.txt")] }));
	assert.equal(ofKind(findings, "outside-workspace").length, 0);
});

test("global-config-write: any session writing settings.json or an extension file", () => {
	const findings = detect(world([write(path.join(PATHS.extensionsDir, "foo", "index.ts"))], { parentWrites: [write(PATHS.settingsFile, "edit")] }));
	const global = ofKind(findings, "global-config-write");
	assert.equal(global.length, 2);
	const parent = global.find((f) => f.subject.sessionId === "p1");
	assert.deepEqual(parent.data.paths, [PATHS.settingsFile]);
	assert.equal(parent.data.hits[0].tool, "edit");
	assert.ok(parent.evidence.includes(`write:edit:${PATHS.settingsFile}`));
	const child = global.find((f) => f.subject.sessionId === "c1");
	assert.equal(child.data.hits[0].target, PATHS.extensionsDir);
	assert.equal(ofKind(findings, "outside-workspace").length, 0, "protected paths are reported once, as global-config-write");
});

test("global-config-write: bash command writing a protected path", () => {
	const commands = [{ ms: NOW - 1000, tool: "bash", text: "sed -i 's/\"a\"/\"b\"/' ~/.omo/agent/settings.json", id: "b1" }];
	const [finding] = ofKind(detect(world([], { parentCommands: commands })), "global-config-write");
	assert.equal(finding.subject.sessionId, "p1");
	assert.equal(finding.data.hits[0].via, "command");
	assert.equal(finding.data.hits[0].tool, "bash");
	assert.deepEqual(finding.data.paths, [PATHS.settingsFile]);
});

test("global-config-write: reading a protected path or writing elsewhere is not flagged", () => {
	const commands = [
		{ ms: NOW - 3000, tool: "bash", text: "cat ~/.omo/agent/settings.json 2>&1", id: "b1" },
		{ ms: NOW - 2000, tool: "bash", text: "echo hi > C:/dev/proj/out.txt", id: "b2" },
	];
	assert.equal(ofKind(detect(world([], { parentCommands: commands })), "global-config-write").length, 0);
});

test("global-config-write: reading a protected path next to an unrelated write is not a config write", async () => {
	const { detect } = await import("../src/detect/offtrack.mjs");
	const { resolvePaths } = await import("../src/paths.mjs");
	const { makeWorld, sessionState } = await import("./helpers/world.mjs");
	const paths = resolvePaths({ USERPROFILE: "C:/Users/u", OMO_HEALTH_HOME: "C:/Users/u/.omo-health" });
	const now = Date.parse("2026-09-24T00:00:00Z");
	const code = "const extDir = 'C:/Users/u/.omo/agent/extensions';\nconst list = fs.readdirSync(extDir);\nfs.writeFileSync('C:/tmp/out.txt', list.join());";
	const s = sessionState({ id: "m", kind: "main", commands: [{ ms: now - 1000, tool: "eval", text: code, id: "e" }] });
	assert.deepEqual(detect(makeWorld({ now, sessions: [s], paths })).filter((f) => f.kind === "global-config-write"), []);
	const bad = sessionState({ id: "m2", kind: "main", commands: [{ ms: now - 1000, tool: "bash", text: "echo '{}' > C:/Users/u/.omo/agent/settings.json", id: "b" }] });
	assert.equal(detect(makeWorld({ now, sessions: [bad], paths })).filter((f) => f.kind === "global-config-write").length, 1);
});

test("global-config-write: placeholders and comparisons next to a protected path are not redirects", () => {
	const commands = [
		{ ms: NOW - 3000, tool: "eval", text: "const doctor=`  <home>/.omo/omo.jsonc: invalid omo config at <home>/.omo/omo.jsonc`;", id: "e1" },
		{ ms: NOW - 2000, tool: "eval", text: "if (fs.statSync('C:/Users/tester/.omo/agent/settings.json').size > 0) console.log('ok')", id: "e2" },
	];
	assert.equal(ofKind(detect(world([], { parentCommands: commands })), "global-config-write").length, 0);
	const redirect = [{ ms: NOW - 1000, tool: "bash", text: "echo '{}' >> \"$HOME/.omo/omo.jsonc\"", id: "b1" }];
	const [finding] = ofKind(detect(world([], { parentCommands: redirect })), "global-config-write");
	assert.deepEqual(finding.data.paths, [PATHS.omoJsonc]);
});

test("outside-workspace: sibling worktrees of the project are allowed", async () => {
	const { detect } = await import("../src/detect/offtrack.mjs");
	const { makeWorld, sessionState, taskRecord } = await import("./helpers/world.mjs");
	const now = Date.parse("2026-09-24T00:00:00Z");
	const task = taskRecord({ taskId: "st_w", spawnCwd: "C:\\dev\\omo\\omo-rollover", parentSessionId: "p" });
	const child = sessionState({ id: "c", kind: "child", taskId: "st_w", parentSessionId: "p", cwd: "C:\\dev\\omo\\omo-rollover", task, writes: [{ ms: now - 1000, tool: "write", path: "C:/dev/omo/omo-rollover-wt/w1/.omo/x.md" }, { ms: now - 900, tool: "write", path: "C:/dev/other-repo/y.md" }] });
	const found = detect(makeWorld({ now, sessions: [child] })).filter((f) => f.kind === "outside-workspace");
	assert.equal(found.length, 1);
	assert.deepEqual(found[0].data.paths.map((p) => p.replace(/\\/g, "/")), ["C:/dev/other-repo/y.md"]);
});
