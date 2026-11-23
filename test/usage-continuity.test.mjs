import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers/fixtures.mjs";
import { makeWorld, sessionState } from "./helpers/world.mjs";
import { subjectKey, subjectOf } from "../src/session-subject.mjs";
import { createUsageIndex, USAGE_TICK_BYTES } from "../src/usage-index.mjs";
import { createUsageTracker } from "../src/usage-tracker.mjs";
import { createFakeClock } from "../src/util/time.mjs";

const MiB = 1024 * 1024;
const T0 = Date.UTC(2026, 8, 28, 12);

function setup(t) {
	const dir = tmpDir("omoh-usage-continuity-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const id = "abcdef01";
	const file = path.join(dir, `2026-09-28T12-00-00-000Z_${id}.jsonl`);
	const clock = createFakeClock(T0);
	const cwd = path.join(dir, "project");
	const subject = subjectOf({ sessionId: id, cwd });
	const world = makeWorld({ now: T0, sessions: [sessionState({ id, file, kind: "main", cwd })] });
	const open = () => {
		const index = createUsageIndex({ file: path.join(dir, "usage.json"), clock });
		const tracker = createUsageTracker({ index, clock });
		return {
			index,
			entry: () => index.get(subjectKey(subject)),
			tick: () => tracker.tick(world).bytesRead,
			publication: () => {
				const visible = tracker.tokensOf(subject);
				return [visible?.tokens?.total, visible?.pending === true];
			},
		};
	};
	return { dir, file, open };
}

const line = (input) => `${JSON.stringify({ type: "usage", provider: "p", model: "m", usage: { input } })}\n`;

function appendLarge(file, input) {
	const chunk = "x".repeat(MiB);
	fs.appendFileSync(file, '{"type":"usage","provider":"p","model":"m","unused":"');
	for (let i = 0; i < 40; i++) fs.appendFileSync(file, chunk);
	fs.appendFileSync(file, `","usage":{"input":${input}}}\n`);
}

test("(IS-1, IS-2, IS-12) tick two publishes a 40 MiB append amid 4,097 unrelated directory entries", (t) => {
	const { dir, file, open } = setup(t);
	const live = open();
	for (let i = 0; i < 4097; i++) {
		fs.writeFileSync(path.join(dir, `${path.basename(file)}-other.torn-${i}`), "");
	}
	fs.writeFileSync(file, line(10));
	assert.equal(live.tick(), Buffer.byteLength(line(10)));

	appendLarge(file, 42);
	assert.equal(live.tick(), USAGE_TICK_BYTES);
	assert.deepEqual(live.publication(), [10, true], "the partial record must not displace the prior total");

	fs.appendFileSync(file, line(1));
	assert.ok(live.tick() <= USAGE_TICK_BYTES, "tick two is still budgeted");
	assert.deepEqual(live.publication(), [53, false], "tick two must publish the full record and the next line once");
});

test("(IS-1, IS-12) a new matching torn backup still rewinds a growing fragment", (t) => {
	const { file, open } = setup(t);
	const live = open();
	fs.writeFileSync(file, line(10));
	assert.equal(live.tick(), Buffer.byteLength(line(10)));

	appendLarge(file, 42);
	assert.equal(live.tick(), USAGE_TICK_BYTES);
	fs.writeFileSync(`${file}.torn-${T0}-00000001`, "");
	fs.appendFileSync(file, line(1));

	assert.equal(live.tick(), USAGE_TICK_BYTES, "the backup forces a rescan even though the fragment bytes did not change");
	assert.deepEqual(live.publication(), [10, true], "the rewound record cannot publish yet");
	assert.ok(live.tick() < USAGE_TICK_BYTES, "the rest of the rewound record fits on tick three");
	assert.deepEqual(live.publication(), [53, false]);
});

test("(IS-1, IS-2, IS-12) a restart keeps the old total visible until a 40 MiB replacement finishes", (t) => {
	const { file, open } = setup(t);
	const original = open();
	fs.writeFileSync(file, line(10));
	assert.equal(original.tick(), Buffer.byteLength(line(10)));
	assert.deepEqual(original.publication(), [10, false]);
	assert.equal(original.index.save(), true);

	const replacement = `${file}.new`;
	appendLarge(replacement, 42);
	fs.renameSync(replacement, file);
	const restarted = open();
	assert.deepEqual(restarted.publication(), [10, false], "restore the old total from disk before scanning");

	assert.equal(restarted.tick(), USAGE_TICK_BYTES);
	assert.deepEqual(restarted.publication(), [10, true], "keep the old total while the replacement is pending");
	assert.equal(restarted.index.fresh(restarted.entry()), false, "do not treat the old total as fresh for audit");

	assert.ok(restarted.tick() < USAGE_TICK_BYTES);
	assert.deepEqual(restarted.publication(), [42, false], "publish the replacement, not the sum of both files");
	assert.equal(restarted.index.fresh(restarted.entry()), true);
});
