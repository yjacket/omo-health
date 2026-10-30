import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { revertSettings } from "../src/act/config-revert.mjs";
import { createConfigTracker, readLkgState, sha1Buffer, writeLkgState } from "../src/collect/config-files.mjs";
import { resolvePaths } from "../src/paths.mjs";
import { tmpDir } from "./helpers/fixtures.mjs";

const GOOD = '{"anthropicSubscriptionProvider":{"tokenInjection":"ambient","enabled":true}}\n';
const BAD = '{"anthropicSubscriptionProvider":{"tokenInjection":"ambient"}}\n';
const sha = (text) => sha1Buffer(Buffer.from(text));
const NOW = Date.parse("2026-09-23T15:47:20.000Z");

function sandbox({ lkg = GOOD } = {}) {
	const root = tmpDir();
	const paths = resolvePaths({ USERPROFILE: root, OMO_HEALTH_HOME: path.join(root, "health"), OMO_HEALTH_OMO_HOME: path.join(root, "omo") });
	fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
	fs.writeFileSync(paths.settingsFile, BAD);
	if (lkg !== null) {
		fs.mkdirSync(paths.health.lkgDir, { recursive: true });
		fs.writeFileSync(path.join(paths.health.lkgDir, "settings.json"), lkg);
		writeLkgState(paths, { sha1: sha(lkg), savedAtMs: NOW - 3600_000 });
	}
	return { root, paths };
}

test("revert restores the LKG, keeps the rejected copy under healthHome/lkg/rejected and records lastRevert", () => {
	const { paths } = sandbox();
	const result = revertSettings({ paths, fromSha1: sha(BAD), toSha1: sha(GOOD), clock: () => NOW });
	assert.equal(result.ok, true);
	assert.equal(fs.readFileSync(paths.settingsFile, "utf8"), GOOD);
	assert.equal(path.dirname(result.rejectedCopy), path.join(paths.health.lkgDir, "rejected"));
	assert.equal(fs.readFileSync(result.rejectedCopy, "utf8"), BAD);
	assert.deepEqual(fs.readdirSync(path.dirname(paths.settingsFile)), ["settings.json"], "nothing left next to settings.json");
	assert.deepEqual(readLkgState(paths).lastRevert, { atMs: NOW, fromSha1: sha(BAD), toSha1: sha(GOOD) });

	const state = createConfigTracker({ paths, clock: () => NOW }).update({});
	assert.deepEqual(state.lastRevert, { atMs: NOW, fromSha1: sha(BAD), toSha1: sha(GOOD) });
	assert.equal(state.lkg.sha1, sha(GOOD));
});

test("CAS: the file changes between the decision and the write -> skipped changed, file untouched", () => {
	const { paths } = sandbox();
	const USER = '{"userEdit":true}\n';
	const result = revertSettings({
		paths,
		fromSha1: sha(BAD),
		toSha1: sha(GOOD),
		clock: () => NOW,
		beforeCommit: () => fs.writeFileSync(paths.settingsFile, USER),
	});
	assert.equal(result.ok, false);
	assert.equal(result.skipped, "changed");
	assert.equal(fs.readFileSync(paths.settingsFile, "utf8"), USER);
	assert.equal(readLkgState(paths).lastRevert, undefined);
});

test("CAS: already changed before the call -> skipped changed without copying", () => {
	const { paths } = sandbox();
	fs.writeFileSync(paths.settingsFile, '{"other":1}');
	const result = revertSettings({ paths, fromSha1: sha(BAD), toSha1: sha(GOOD), clock: () => NOW });
	assert.equal(result.skipped, "changed");
	assert.equal(fs.readFileSync(paths.settingsFile, "utf8"), '{"other":1}');
	assert.equal(fs.existsSync(path.join(paths.health.lkgDir, "rejected")), false);
});

test("no LKG -> skipped no-lkg; LKG content not matching toSha1 -> skipped lkg-mismatch", () => {
	const none = sandbox({ lkg: null });
	assert.equal(revertSettings({ paths: none.paths, fromSha1: sha(BAD), toSha1: sha(GOOD), clock: () => NOW }).skipped, "no-lkg");
	assert.equal(fs.readFileSync(none.paths.settingsFile, "utf8"), BAD);
	const other = sandbox({ lkg: '{"different":1}' });
	assert.equal(revertSettings({ paths: other.paths, fromSha1: sha(BAD), toSha1: sha(GOOD), clock: () => NOW }).skipped, "lkg-mismatch");
	assert.equal(fs.readFileSync(other.paths.settingsFile, "utf8"), BAD);
});
