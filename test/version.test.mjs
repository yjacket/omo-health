import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { VERSION } from "../src/version.mjs";

test("VERSION matches package.json", () => {
	const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, version);
});
