import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readAuthBlocks } from "../src/collect/secrets.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const SECRET = "sk-ant-oat01-SECRETSECRETSECRET";

test("readAuthBlocks projects exactly name, blockReason, blockedUntil for anthropic-subscription", () => {
	const dir = tmpDir();
	const file = path.join(dir, "auth.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			"anthropic-subscription": {
				accounts: [
					{ name: "main", accessToken: SECRET, refreshToken: SECRET, blockReason: "revoked", blockedUntil: 1_800_000_000_000 },
					{ name: "alt", accessToken: SECRET, expires: 1 },
				],
			},
			"chatgpt-subscription": { accounts: [{ name: "gpt", blockReason: "x", accessToken: SECRET }] },
		}),
	);
	const blocks = readAuthBlocks(file);
	assert.equal(blocks.length, 2);
	for (const b of blocks) assert.deepEqual(Object.keys(b).sort(), ["blockReason", "blockedUntil", "name"]);
	assert.deepEqual(blocks[0], { name: "main", blockReason: "revoked", blockedUntil: 1_800_000_000_000 });
	assert.equal(blocks[1].blockReason, undefined);
	assert.equal(JSON.stringify(blocks).includes("SECRET"), false);
});

test("readAuthBlocks returns [] for missing or malformed files", () => {
	const dir = tmpDir();
	assert.deepEqual(readAuthBlocks(path.join(dir, "none.json")), []);
	const bad = path.join(dir, "bad.json");
	fs.writeFileSync(bad, `{"anthropic-subscription": ${SECRET}`);
	assert.deepEqual(readAuthBlocks(bad), []);
});
