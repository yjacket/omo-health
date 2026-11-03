import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readAuthBlocks, readAuthSlots } from "../src/collect/secrets.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const SECRET = "sk-ant-oat01-SECRETSECRETSECRET";
const REFRESH = "refresh-" + SECRET;
const digestOf = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

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

test("readAuthSlots projects exactly the 8 public keys and digests the refresh token", () => {
	const dir = tmpDir();
	const file = path.join(dir, "auth.json");
	const grant = digestOf(REFRESH);
	fs.writeFileSync(
		file,
		JSON.stringify({
			"anthropic-subscription": {
				accounts: [
					{
						name: "main",
						access: SECRET,
						refresh: REFRESH,
						expires: 1_800_000_000_000,
						source: "login",
						blockReason: "quota",
						blockedUntil: "2026-11-02T00:00:00Z",
						authRecoveryGrant: grant,
					},
					{ name: "other", access: SECRET, refresh: "other-" + SECRET, expires: 1, source: "relogin", authRecoveryGrant: "deadbeef" },
					{ name: "plain" },
				],
			},
			"chatgpt-subscription": { accounts: [{ name: "gpt", access: SECRET, refresh: SECRET }] },
		}),
	);
	const slots = readAuthSlots(file);
	assert.equal(slots.length, 3);
	for (const slot of slots) {
		assert.deepEqual(Object.keys(slot).sort(), [
			"blockReason",
			"blockedUntil",
			"digest",
			"expires",
			"name",
			"recoveryGrant",
			"recoveryGrantCurrent",
			"source",
		]);
	}
	assert.equal(slots[0].digest, grant);
	assert.equal(slots[0].name, "main");
	assert.equal(slots[0].source, "login");
	assert.equal(slots[0].expires, 1_800_000_000_000);
	assert.equal(slots[0].blockReason, "quota");
	assert.equal(slots[0].blockedUntil, "2026-11-02T00:00:00Z");
	assert.equal(slots[0].recoveryGrant, true);
	assert.equal(slots[0].recoveryGrantCurrent, true);
	assert.equal(slots[1].digest, digestOf("other-" + SECRET));
	assert.equal(slots[1].recoveryGrant, true);
	assert.equal(slots[1].recoveryGrantCurrent, false);
	assert.equal(slots[2].digest, undefined);
	assert.equal(slots[2].expires, undefined);
	assert.equal(slots[2].recoveryGrant, false);
	assert.equal(slots[2].recoveryGrantCurrent, false);
	assert.equal(JSON.stringify(slots).includes("SECRET"), false);
});

test("readAuthSlots returns undefined for missing or malformed files and [] without the provider", () => {
	const dir = tmpDir();
	assert.equal(readAuthSlots(path.join(dir, "none.json")), undefined);
	const bad = path.join(dir, "bad.json");
	fs.writeFileSync(bad, `{"anthropic-subscription": ${SECRET}`);
	assert.equal(readAuthSlots(bad), undefined);
	const other = path.join(dir, "other.json");
	fs.writeFileSync(other, JSON.stringify({ "chatgpt-subscription": { accounts: [{ name: "gpt", access: SECRET, refresh: SECRET }] } }));
	assert.deepEqual(readAuthSlots(other), []);
	const unreadable = path.join(dir, "dir.json");
	fs.mkdirSync(unreadable);
	assert.equal(readAuthSlots(unreadable), undefined);
});
