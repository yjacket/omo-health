import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { encodeClaudeProjectDir, isInside, resolvePaths } from "../src/paths.mjs";
import { atomicWriteJson, readJsonSafe } from "../src/util/fsx.mjs";
import { commandLineText, normalizeCommand, redact, splitWindowsCommandLine } from "../src/util/text.mjs";
import { kst } from "../src/util/time.mjs";

test("normalizeCommand makes a Windows command line comparable to the tool argument", () => {
	const toolArg = 'grep -o "abc" file.txt |\n  head -3';
	const cmdline = '"C:\\Program Files\\Git\\bin\\bash.exe" -c "grep -o \\"abc\\" file.txt |\n  head -3"';
	assert.ok(commandLineText(cmdline).includes(normalizeCommand(toolArg)));
});

/** libuv's quote_cmd_arg (what node's spawn writes on the Windows command line). */
function libuvQuote(arg) {
	if (arg === "") return '""';
	if (!/[ \t"]/.test(arg)) return arg;
	if (!/["\\]/.test(arg)) return `"${arg}"`;
	const out = [];
	let quoteHit = true;
	for (let i = arg.length - 1; i >= 0; i--) {
		const ch = arg[i];
		out.push(ch);
		if (quoteHit && ch === "\\") out.push("\\");
		else if (ch === '"') {
			quoteHit = true;
			out.push("\\");
		} else quoteHit = false;
	}
	return `"${out.reverse().join("")}"`;
}

test("splitWindowsCommandLine is the exact inverse of libuv quoting, including \\\" inside the command", () => {
	const commands = ['awk \'{split($2,a,"\\""); print a[1]}\' f.txt', 'echo "a\\\\" b\\c', "plain", "", 'trail\\\\', 'x"y'];
	for (const command of commands) {
		const cmdline = `"C:\\Program Files\\Git\\bin\\bash.exe" -c ${libuvQuote(command)}`;
		assert.deepEqual(splitWindowsCommandLine(cmdline), ["C:\\Program Files\\Git\\bin\\bash.exe", "-c", command], command);
	}
});

test("redact masks tokens in every supported shape", () => {
	const input = [
		"sk-ant-oat01-abcdefghijklmnop",
		"eyJhbGciOiJIUzI1NiJ9abcdefghij.eyJzdWIiOiIxIn0.sig",
		'{"accessToken":"secret-value","refresh":"r-secret"}',
		"Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
	].join(" ");
	const out = redact(input);
	assert.equal(/sk-ant-oat01|secret-value|r-secret|abcdefghijklmnopqrstuvwxyz|eyJzdWIi/.test(out), false);
});

test("atomicWriteJson round-trips and readJsonSafe falls back on bad input", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-fsx-"));
	const file = path.join(dir, "nested", "x.json");
	atomicWriteJson(file, { a: [1, 2] });
	assert.deepEqual(readJsonSafe(file), { a: [1, 2] });
	fs.writeFileSync(file, "{broken");
	assert.equal(readJsonSafe(file, "fallback"), "fallback");
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ["x.json"]);
});

test("paths honour redirection env vars and encode claude project dirs", () => {
	const p = resolvePaths({ OMO_HEALTH_HOME: "C:/tmp/h", OMO_HEALTH_OMO_HOME: "C:/tmp/o", USERPROFILE: "C:/Users/u" });
	assert.equal(p.healthHome, "C:/tmp/h");
	assert.equal(p.settingsFile, path.join("C:/tmp/o", "agent", "settings.json"));
	assert.equal(encodeClaudeProjectDir("C:\\dev\\omo\\omo-rollover"), "C--dev-omo-omo-rollover");
	assert.equal(isInside("C:/Dev/omo/omo-health/src", "c:\\dev\\omo"), true);
	assert.equal(isInside("C:/dev/omo-other", "C:/dev/omo"), false);
});

test("kst renders UTC+9", () => {
	assert.equal(kst(Date.parse("2026-09-23T15:47:05Z")), "2026-09-24 00:47:05 KST");
});

test("redact masks CLAUDE_CODE_OAUTH_TOKEN in every shell and JSON shape, and masked JSON still parses (#87 review)", () => {
	const token = "oat-9f8e7d6c5b4a3210"; // not sk-ant-: only this variable's rule can catch it
	const shapes = {
		plain: `CLAUDE_CODE_OAUTH_TOKEN=${token} claude -p`,
		spaced: `CLAUDE_CODE_OAUTH_TOKEN = ${token}`,
		export: `export CLAUDE_CODE_OAUTH_TOKEN=${token}`,
		double: `export CLAUDE_CODE_OAUTH_TOKEN="${token}"; claude`,
		single: `export CLAUDE_CODE_OAUTH_TOKEN='${token}'`,
		powershell: `$env:CLAUDE_CODE_OAUTH_TOKEN="${token}"; claude -p`,
	};
	for (const [shape, text] of Object.entries(shapes)) {
		const masked = redact(text);
		assert.ok(!masked.includes(token) && masked.includes("CLAUDE_CODE_OAUTH_TOKEN"), shape);
		assert.match(masked, /\[REDACTED\]/, shape);
	}
	for (const [shape, text] of Object.entries({ "JSON of plain": shapes.plain, "JSON of quoted": shapes.double, "JSON of single": shapes.single })) {
		const json = redact(JSON.stringify({ command: text, n: 1 }));
		assert.ok(!json.includes(token), shape);
		assert.deepEqual(JSON.parse(json).n, 1, `${shape}: still JSON`);
	}
	assert.equal(redact(JSON.stringify({ c: shapes.double })), JSON.stringify({ c: 'export CLAUDE_CODE_OAUTH_TOKEN="[REDACTED]"; claude' }));
});
