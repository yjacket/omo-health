import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REFRESH_LEAD_MS, createOmoLoginSource, omoLoginView, trackOmoLogins } from "../src/collect/omo-login.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 0, 1);
const FIELDS = ["basis", "blockReason", "digest", "expires", "loginMs", "recoveryGrant"];

const slot = (over = {}) => ({
	name: "account-1",
	digest: "digest-1",
	expires: BASE + 10 * HOUR,
	blockReason: undefined,
	recoveryGrant: false,
	recoveryGrantCurrent: false,
	...over,
});

const firstSeen = (nowMs, ...slots) => trackOmoLogins(undefined, slots.length ? slots : [slot()], nowMs);

const keysOf = (record) => Object.keys(record).sort();

test("first run dates every slot first-seen", () => {
	const state = trackOmoLogins(undefined, [slot(), slot({ name: "account-2", digest: "digest-2" })], BASE);
	assert.equal(state.v, 1);
	assert.equal(state.observedMs, BASE);
	assert.deepEqual(Object.keys(state.slots).sort(), ["account-1", "account-2"]);
	for (const name of ["account-1", "account-2"]) {
		const record = state.slots[name];
		assert.deepEqual(keysOf(record), FIELDS);
		assert.equal(record.loginMs, BASE);
		assert.equal(record.basis, "first-seen");
	}
	assert.equal(state.slots["account-2"].digest, "digest-2");
});

test("a newly added slot is a login at the observation time", () => {
	const prev = firstSeen(BASE);
	const now = BASE + HOUR;
	const next = trackOmoLogins(prev, [slot(), slot({ name: "account-2", digest: "digest-2" })], now);
	assert.equal(next.slots["account-1"].loginMs, BASE);
	assert.equal(next.slots["account-1"].basis, "first-seen");
	assert.equal(next.slots["account-2"].loginMs, now);
	assert.equal(next.slots["account-2"].basis, "login");
	assert.equal(next.observedMs, now);
});

test("an early digest change is a login", () => {
	const prev = firstSeen(BASE);
	const now = BASE + HOUR;
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2" })], now);
	assert.equal(next.slots["account-1"].loginMs, now);
	assert.equal(next.slots["account-1"].basis, "login");
	assert.equal(next.slots["account-1"].digest, "digest-2");
});

test("a digest change at the renewal point is a refresh and keeps the login time", () => {
	const prev = firstSeen(BASE);
	const now = BASE + 10 * HOUR - REFRESH_LEAD_MS;
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2", expires: BASE + 11 * HOUR })], now);
	const record = next.slots["account-1"];
	assert.equal(record.loginMs, BASE);
	assert.equal(record.basis, "first-seen");
	assert.equal(record.digest, "digest-2");
	assert.equal(record.expires, BASE + 11 * HOUR);
});

test("a digest change after the renewal point is also a refresh", () => {
	const prev = firstSeen(BASE);
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2" })], BASE + 10 * HOUR + HOUR);
	assert.equal(next.slots["account-1"].loginMs, BASE);
	assert.equal(next.slots["account-1"].basis, "first-seen");
});

test("a current recovery grant is not a login even early", () => {
	const prev = firstSeen(BASE);
	const now = BASE + HOUR;
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2", recoveryGrant: true, recoveryGrantCurrent: true })], now);
	const record = next.slots["account-1"];
	assert.equal(record.loginMs, BASE);
	assert.equal(record.basis, "first-seen");
	assert.equal(record.recoveryGrant, true);
	assert.equal(record.digest, "digest-2");
});

test("a clean digest after an auth_error block is a login", () => {
	const prev = firstSeen(BASE, slot({ blockReason: "auth_error" }));
	const now = BASE + 10 * HOUR;
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2" })], now);
	assert.equal(next.slots["account-1"].loginMs, now);
	assert.equal(next.slots["account-1"].basis, "login");
	assert.equal(next.slots["account-1"].blockReason, undefined);
});

test("losing a recovery grant is a login", () => {
	const prev = firstSeen(BASE, slot({ recoveryGrant: true }));
	const now = BASE + 10 * HOUR;
	const next = trackOmoLogins(prev, [slot({ digest: "digest-2", recoveryGrant: false })], now);
	assert.equal(next.slots["account-1"].loginMs, now);
	assert.equal(next.slots["account-1"].basis, "login");
});

test("an unchanged digest keeps the login time and updates the rest", () => {
	const prev = firstSeen(BASE, slot({ expires: BASE + 10 * HOUR }));
	const next = trackOmoLogins(prev, [slot({ expires: BASE + 20 * HOUR, blockReason: "rate_limit" })], BASE + HOUR);
	const record = next.slots["account-1"];
	assert.equal(record.loginMs, BASE);
	assert.equal(record.basis, "first-seen");
	assert.equal(record.expires, BASE + 20 * HOUR);
	assert.equal(record.blockReason, "rate_limit");
});

test("a slot missing from the current read is dropped", () => {
	const prev = firstSeen(BASE, slot(), slot({ name: "account-2", digest: "digest-2" }));
	const next = trackOmoLogins(prev, [slot()], BASE + HOUR);
	assert.deepEqual(Object.keys(next.slots), ["account-1"]);
});

test("slots without a string name are ignored", () => {
	const next = firstSeen(BASE, slot(), { digest: "x" }, slot({ name: 42 }));
	assert.deepEqual(Object.keys(next.slots), ["account-1"]);
});

test("undefined slots return the same object untouched", () => {
	const prev = firstSeen(BASE);
	assert.equal(trackOmoLogins(prev, undefined, BASE + HOUR), prev);
	assert.equal(trackOmoLogins(undefined, undefined, BASE), undefined);
});

test("after a long daemon gap a freshly added slot is dated now", () => {
	const then = BASE - 20 * DAY;
	const prev = { v: 1, observedMs: then, slots: { "account-1": { digest: "digest-1", expires: then + HOUR, blockReason: undefined, recoveryGrant: false, loginMs: then, basis: "login" } } };
	const now = BASE;
	const next = trackOmoLogins(prev, [slot(), slot({ name: "account-2", digest: "digest-2" })], now);
	assert.equal(next.slots["account-2"].loginMs, now);
	assert.equal(next.slots["account-2"].basis, "login");
	assert.equal(next.slots["account-1"].loginMs, then);
});

test("omoLoginView sorts slots by name and exposes only the reported fields", () => {
	assert.equal(omoLoginView(undefined), undefined);
	const state = firstSeen(BASE, slot({ name: "account-2", digest: "digest-2" }), slot());
	const view = omoLoginView(state);
	assert.deepEqual(view.slots.map((s) => s.name), ["account-1", "account-2"]);
	assert.deepEqual(Object.keys(view.slots[0]).sort(), ["basis", "blockReason", "expires", "loginMs", "name"]);
	assert.equal(view.slots[0].loginMs, BASE);
});

function source(file, read, clock) {
	return createOmoLoginSource({ file, authFile: "unused-auth.json", clock, read });
}

test("the source writes only when the slot records change", () => {
	const dir = tmpDir();
	const file = path.join(dir, "omo-login.json");
	let now = BASE;
	const clock = { now: () => now };
	const read = () => [slot()];
	const poll = source(file, read, clock);

	const first = poll();
	assert.equal(first.slots[0].basis, "first-seen");
	const written = fs.readFileSync(file, "utf8");
	assert.equal(JSON.parse(written).observedMs, BASE);

	now += 2 * HOUR;
	const second = poll();
	assert.deepEqual(second, first);
	assert.equal(fs.readFileSync(file, "utf8"), written);

	now += HOUR;
	assert.deepEqual(poll(), first);
	assert.equal(fs.readFileSync(file, "utf8"), written);
});

test("a restarted source keeps login times from the file", () => {
	const dir = tmpDir();
	const file = path.join(dir, "omo-login.json");
	let now = BASE;
	const clock = { now: () => now };
	assert.equal(source(file, () => [slot()], clock)().slots[0].loginMs, BASE);

	now = BASE + HOUR;
	const restarted = source(file, () => [slot()], clock);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).slots["account-1"].loginMs, BASE);
	const view = restarted();
	assert.equal(view.slots[0].loginMs, BASE);
	assert.equal(view.slots[0].basis, "first-seen");
});

test("a bad journal file is treated as a first run", () => {
	const dir = tmpDir();
	for (const body of ['{"v":2,"slots":{}}', "not json at all"]) {
		const file = path.join(dir, `journal-${body.length}.json`);
		fs.writeFileSync(file, body);
		const view = source(file, () => [slot()], { now: () => BASE + HOUR })();
		assert.equal(view.slots[0].loginMs, BASE + HOUR);
		assert.equal(view.slots[0].basis, "first-seen");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).v, 1);
	}
});

test("the journal never contains the refresh token", () => {
	const dir = tmpDir();
	const file = path.join(dir, "omo-login.json");
	const authFile = path.join(dir, "auth.json");
	const token = "sk-ant-oat01-FAKE-TOKEN-DO-NOT-STORE-9f8e7d";
	fs.writeFileSync(
		authFile,
		JSON.stringify({
			"anthropic-subscription": {
				accounts: [{ name: "account-1", refresh: token, expires: BASE + 10 * HOUR }],
			},
		}),
	);
	const view = createOmoLoginSource({ file, authFile, clock: { now: () => BASE } })();
	assert.equal(view.slots[0].loginMs, BASE);
	assert.equal(fs.readFileSync(file, "utf8").includes(token), false);
	assert.equal(JSON.stringify(view).includes(token), false);
	assert.deepEqual(keysOf(JSON.parse(fs.readFileSync(file, "utf8")).slots["account-1"]), ["basis", "digest", "expires", "loginMs", "recoveryGrant"]);
	for (const key of keysOf(JSON.parse(fs.readFileSync(file, "utf8")).slots["account-1"])) assert.ok(FIELDS.includes(key), key);
});

test("environment token slots are not tracked as logins", () => {
	const state = trackOmoLogins(undefined, [slot(), slot({ name: "env", source: "env", digest: undefined })], BASE);
	assert.deepEqual(Object.keys(state.slots), ["account-1"]);
});

test("a failed ledger write keeps the source answering from memory", () => {
	const dir = tmpDir();
	const blocker = path.join(dir, "not-a-dir");
	fs.writeFileSync(blocker, "x");
	const warnings = [];
	let now = BASE;
	const poll = createOmoLoginSource({ file: path.join(blocker, "omo-login.json"), authFile: "unused", clock: { now: () => now }, read: () => [slot()], log: { warn: (event) => warnings.push(event) } });
	assert.equal(poll().slots[0].loginMs, BASE);
	now += HOUR;
	assert.equal(poll().slots[0].loginMs, BASE, "the in-memory ledger survives the failed write");
	assert.deepEqual(warnings, ["omo_login_write_failed"]);
});

test("a claude-cli slot is dated by its signedInAt and carries the CLI refresh expiry (omo 5.1.58+)", () => {
	const cli = { name: "default", source: "login", store: "claude-cli", signedInMs: BASE - 3 * DAY, refreshExpiresMs: BASE + 20 * DAY, refreshCleared: false, recoveryGrant: false, recoveryGrantCurrent: false };
	const first = trackOmoLogins(undefined, [cli], BASE);
	assert.equal(first.slots.default.loginMs, BASE - 3 * DAY);
	assert.equal(first.slots.default.basis, "signed-in");
	const view = omoLoginView(trackOmoLogins(first, [{ ...cli, refreshExpiresMs: BASE + 21 * DAY }], BASE + HOUR));
	assert.deepEqual(view.slots[0], { name: "default", loginMs: BASE - 3 * DAY, basis: "signed-in", blockReason: undefined, expires: undefined, store: "claude-cli", refreshExpiresMs: BASE + 21 * DAY, refreshCleared: false });
});

test("createOmoLoginSource reads the CLI credentials file beside auth.json", () => {
	const dir = tmpDir();
	const authFile = path.join(dir, "auth.json");
	const dirId = "3f5ddd493a114772bb53016b06d21194";
	fs.writeFileSync(authFile, JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "default", source: "login", store: "claude-cli", dirId, signedInAt: BASE - DAY }] } }));
	fs.mkdirSync(path.join(dir, "anthropic-subscription-claude", dirId), { recursive: true });
	fs.writeFileSync(path.join(dir, "anthropic-subscription-claude", dirId, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "r", refreshTokenExpiresAt: BASE + 2 * DAY } }));
	const read = createOmoLoginSource({ file: path.join(dir, "ledger.json"), authFile, clock: { now: () => BASE } });
	const [slot] = read().slots;
	assert.equal(slot.refreshExpiresMs, BASE + 2 * DAY);
	assert.equal(slot.loginMs, BASE - DAY);
});
