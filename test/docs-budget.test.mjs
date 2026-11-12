import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { DEFAULT_CONFIG, SWITCH_KEYS } from "../src/config.mjs";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function hasKey(obj, dotted) {
	let cur = obj;
	for (const part of dotted.split(".")) {
		if (part === "*") return cur && typeof cur === "object";
		if (!cur || typeof cur !== "object" || !(part in cur)) return false;
		cur = cur[part];
	}
	return true;
}

test("every budget.* key named in the README and CHANGELOG exists in DEFAULT_CONFIG", () => {
	const text = read("README.md") + read("CHANGELOG.md");
	const keys = [...new Set(text.match(/(?<![-\w/])budget\.[A-Za-z]+(?:\.[A-Za-z*]+)*/g) ?? [])];
	assert.ok(keys.length > 10, `found ${keys.length} keys`);
	const missing = keys.filter((key) => !hasKey(DEFAULT_CONFIG, key));
	assert.deepEqual(missing, []);
	assert.ok(SWITCH_KEYS.includes("budget.enabled"));
	assert.ok(SWITCH_KEYS.includes("budget.audit.enabled"));
});

test("the README estimate example matches the block the request message carries", () => {
	const messages = read("src/act/messages.mjs");
	assert.match(messages, /\{"v":1,"requestId":"req-1","projectId":/);
	assert.match(read("README.md"), /<omo-budget kind="estimate">\n\{"v":1,"requestId":"req-1","projectId":"<project>","baseRevision":0,"remainingUsd":\{"p10":<p10>,"p50":<p50>,"p90":<p90>\},"workClass":"mixed","basis":\{"workUnits":\[\{"description":"<work unit>","count":<count>\}\],"assumptions":\[\]\},"nextCheckpoint":"<next checkpoint>"\}\n<\/omo-budget>/);
});

test("package version is 0.9.0 and the changelog has its entry", () => {
	assert.equal(JSON.parse(read("package.json")).version, "0.9.0");
	assert.match(read("CHANGELOG.md"), /^## 0\.9\.0 - \d{4}-\d{2}-\d{2}$/m);
});

test("every command in the README command table exists in COMMANDS", () => {
	const src = read("bin/omo-health.mjs");
	const body = src.slice(src.indexOf("export const COMMANDS = {"));
	const known = new Set([...body.slice(0, body.indexOf("\n};")).matchAll(/^\t([a-z]+):/gm)].map((m) => m[1]));
	const readme = read("README.md");
	const table = readme.slice(readme.indexOf("## 명령"), readme.indexOf("\n\n", readme.indexOf("| --- |", readme.indexOf("## 명령"))));
	const named = [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
	assert.ok(named.includes("budget"));
	assert.ok(known.has("budget"));
	assert.deepEqual(named.filter((name) => !known.has(name)), []);
});
