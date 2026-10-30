import "./helpers/tmp-root.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers/fixtures.mjs";
import { readParkRecords, validateParkRecord, deduplicateParkRecords } from "../src/collect/parks.mjs";
import { detect as detectParks } from "../src/detect/parks.mjs";

function setup() {
	const root = tmpDir("park-collect-");
	const paths = { health: { parksDir: path.join(root, "parks") } };
	fs.mkdirSync(paths.health.parksDir, { recursive: true });
	return { root, paths };
}

function putJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

function validParkRecord(overrides = {}) {
	return {
		v: 1,
		parkId: "sid-12345",
		sessionId: "sid",
		createdAt: Date.now(),
		resetAt: Date.now() + 3600000,
		status: "pending",
		terminal: { kind: "orca", cwd: "C:/work" },
		...overrides,
	};
}

test("reads valid park records from directory", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;
	putJson(path.join(dir, "old.1000.park.json"), validParkRecord({ parkId: "old-1000", sessionId: "old", createdAt: 1000 }));
	putJson(path.join(dir, "new.2000.park.json"), validParkRecord({ parkId: "new-2000", sessionId: "new", createdAt: 2000 }));
	fs.writeFileSync(path.join(dir, "bad.park.json"), "{");

	const result = readParkRecords(paths);
	assert.equal(result.length, 2);
	assert.equal(result[0].record.parkId, "new-2000");
	assert.equal(result[1].record.parkId, "old-1000");
});

test("validates required keys", () => {
	const valid = validParkRecord();
	assert.equal(validateParkRecord(valid).ok, true);

	assert.equal(validateParkRecord({ ...valid, v: 2 }).ok, false);
	assert.equal(validateParkRecord({ ...valid, parkId: undefined }).ok, false);
	assert.equal(validateParkRecord({ ...valid, sessionId: undefined }).ok, false);
	assert.equal(validateParkRecord({ ...valid, status: 123 }).ok, false);
	assert.equal(validateParkRecord({ ...valid, terminal: { kind: 123 } }).ok, false);
});

test("marks multiple episodes for same session as superseded", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;

	// Create two episodes for the same session with different times
	putJson(
		path.join(dir, "sid.1000.park.json"),
		validParkRecord({ parkId: "sid-1000", sessionId: "sid", createdAt: 1000, resetAt: Date.now() + 3600000 }),
	);
	putJson(
		path.join(dir, "sid.2000.park.json"),
		validParkRecord({ parkId: "sid-2000", sessionId: "sid", createdAt: 2000, resetAt: Date.now() + 7200000 }),
	);

	const recordsInput = readParkRecords(paths);
	const { valid, invalid, superseded } = deduplicateParkRecords(recordsInput);

	assert.equal(valid.length, 1);
	assert.equal(invalid.length, 0);
	assert.equal(superseded.length, 1);
	assert.equal(valid[0].record.parkId, "sid-2000"); // Newest is valid
	assert.equal(superseded[0].record.parkId, "sid-1000"); // Oldest is superseded
});

test("detects park-invalid for malformed records", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;

	// Write a truncated JSON
	fs.writeFileSync(path.join(dir, "bad.1000.park.json"), "{");

	const now = Date.now();
	const world = { now, paths };
	const findings = detectParks(world, {});

	const invalidFindings = findings.filter((f) => f.kind === "park-invalid");
	assert.equal(invalidFindings.length, 1);
	assert.match(invalidFindings[0].data.error, /not an object/);
});

test("detects park-due when status is pending and resetAt + grace has passed", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;

	const now = Date.now();
	const resetAt = now - 120000; // 2 minutes ago (past grace period)

	putJson(
		path.join(dir, "sid.1000.park.json"),
		validParkRecord({ parkId: "sid-1000", sessionId: "sid", createdAt: now, resetAt, status: "pending" }),
	);

	const world = { now, paths };
	const findings = detectParks(world, {});

	const dueFindings = findings.filter((f) => f.kind === "park-due");
	assert.equal(dueFindings.length, 1);
	assert.equal(dueFindings[0].data.sessionId, "sid");
});

test("does not emit park-due when status is not pending", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;

	const now = Date.now();
	const resetAt = now - 120000; // Past grace period

	putJson(
		path.join(dir, "sid.1000.park.json"),
		validParkRecord({ parkId: "sid-1000", sessionId: "sid", createdAt: now, resetAt, status: "launched" }),
	);

	const world = { now, paths };
	const findings = detectParks(world, {});

	const dueFindings = findings.filter((f) => f.kind === "park-due");
	assert.equal(dueFindings.length, 0);
});

test("park-due detector honors the 60-second grace boundary", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;
	const resetAt = 1_000_000;
	const file = path.join(dir, "sid.1000.park.json");
	putJson(file, validParkRecord({ parkId: "sid-1000", sessionId: "sid", createdAt: 1, resetAt, status: "pending" }));

	const before = detectParks({ now: resetAt + 59_000, paths }, {});
	assert.equal(before.filter((f) => f.kind === "park-due").length, 0);

	const atBoundary = detectParks({ now: resetAt + 60_000, paths }, {});
	assert.equal(atBoundary.filter((f) => f.kind === "park-due").length, 1);
});

test("emits park-invalid only once per malformed file", () => {
	const { paths } = setup();
	const dir = paths.health.parksDir;

	fs.writeFileSync(path.join(dir, "bad.1000.park.json"), "{");

	const now = Date.now();
	const world = { now, paths };
	const memory = {};

	// Run detection twice
	const findings1 = detectParks(world, memory);
	const findings2 = detectParks(world, memory);

	const invalidFindings1 = findings1.filter((f) => f.kind === "park-invalid");
	const invalidFindings2 = findings2.filter((f) => f.kind === "park-invalid");

	assert.equal(invalidFindings1.length, 1);
	assert.equal(invalidFindings2.length, 0); // Should not repeat
});
