import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const child = fileURLToPath(new URL("./helpers/ledger-memory-child.mjs", import.meta.url));
const now = Date.UTC(2026, 10, 22, 20);
const day = 86_400_000;
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const ledgerNames = (dir) => fs.readdirSync(dir).filter((name) => /^ended-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
const ledgerDir = (root) => path.join(root, "health", "sessions");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-memory-"));
const fixture = path.join(root, "index");
let indexReady = false;
const ledgers = new Map();

function invoke(cap, ...args) {
	return spawnSync(process.execPath, [`--max-old-space-size=${cap}`, "--max-semi-space-size=1", child, ...args], {
		encoding: "utf8", timeout: 60_000,
	});
}

function assertsExit(result, message) {
	assert.equal(result.status, 0, `${message}: exit=${result.status}, signal=${result.signal ?? "-"}\n${result.stdout}${result.stderr}${result.error ?? ""}`);
}

function prepareLedger(shape) {
	if (ledgers.has(shape)) return ledgers.get(shape);
	const dir = path.join(root, shape);
	fs.mkdirSync(dir);
	const exact = process.env.OMOH_MEMORY_GATE_LEDGERS;
	let rows = 0;
	if (shape === "real-4x") {
		const snapshot = process.env.OMOH_MEMORY_REAL_SESSIONS;
		for (const name of ledgerNames(snapshot)) {
			if (name < `ended-${date(now - 30 * day)}.jsonl` || name > `ended-${date(now)}.jsonl`) continue;
			const source = fs.readFileSync(path.join(snapshot, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
				.filter((row) => Number(row.endedMs) >= now - 30 * day && Number(row.endedMs) <= now);
			const fd = fs.openSync(path.join(dir, name), "w");
			try {
				for (let copy = 0; copy < 4; copy++) {
					for (const original of source) {
						const row = { ...original };
						for (const key of ["sessionId", "taskId", "parentSessionId", "rootSessionId"]) {
							if (typeof row[key] === "string" && row[key]) row[key] += `-gate${copy}`;
						}
						// Never let lookup in a snapshot probe touch a real workspace.
						if (typeof row.cwd === "string") row.cwd = path.join(dir, "workspace", row.cwd.replace(/[^a-z0-9_-]/gi, "_"));
						fs.writeSync(fd, JSON.stringify(row) + "\n");
						rows++;
					}
				}
			} finally {
				fs.closeSync(fd);
			}
		}
		assert.ok(rows > 0, "the snapshot must cover the injected 30-day window");
	}
	if (exact && shape !== "real-4x") {
		const source = ledgerDir(path.join(exact, shape));
		for (const name of ledgerNames(source)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
	} else {
		const file = path.join(dir, `ended-${date(now)}.jsonl`);
		const fd = fs.openSync(file, "a");
		try {
			const write = (row) => fs.writeSync(fd, JSON.stringify({ v: 1, kind: "main", startedMs: now - 30_000, endedMs: now - 1_000, ...row, reason: "" }) + "\n");
			write({ sessionId: "seed" });
			if (shape !== "real-4x") {
				const prefix = path.join(dir, "작업") + "/" + ("a".repeat(194) + "/").repeat(99);
				for (let i = 0; i < 1030; i++) {
					const cwd = prefix + (shape === "distinct" ? String(i).padStart(4, "0") : "same") + "a".repeat(190);
					const links = shape === "family" ? { kind: "child", taskId: `st_${i}`, parentSessionId: "seed" } : {};
					write({ sessionId: `01aaa000-0000-7000-8000-${String(i).padStart(12, "0")}`, cwd, ...links, outcome: "completed", endedMs: now - 2_000 });
				}
				rows = 1030;
			}
		} finally {
			fs.closeSync(fd);
		}
	}
	ledgers.set(shape, dir);
	const bytes = ledgerNames(dir).reduce((n, name) => n + fs.statSync(path.join(dir, name)).size, 0);
	console.log(`LEDGER ${shape} bytes=${bytes}${rows ? ` rows=${rows}+seed` : ""}`);
	return dir;
}

function probe(operation, shape, mode, cap) {
	if (!indexReady) {
		const result = invoke(96, "build-index", fixture);
		assertsExit(result, "index fixture");
		console.log(result.stdout.trim());
		indexReady = true;
	}
	const source = prepareLedger(shape);
	const dir = fs.mkdtempSync(path.join(root, "run-"));
	try {
		const sessions = ledgerDir(dir);
		fs.mkdirSync(sessions, { recursive: true });
		for (const name of ledgerNames(source)) fs.copyFileSync(path.join(source, name), path.join(sessions, name));
		if (mode === "full") fs.copyFileSync(path.join(ledgerDir(fixture), "usage.json"), path.join(sessions, "usage.json"));
		return invoke(cap, operation, dir, mode, shape, fixture);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("IS-10: session decision join fits a 96 MiB heap with over 96 MiB of unrelated decisions", (t) => {
	const dir = fs.mkdtempSync(path.join(root, "decisions-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = invoke(96, "decision-join", dir);
	assertsExit(result, "session record decision join");
	t.diagnostic(result.stdout.trim());
});

test("IS-10: daemon audit fits a 96 MiB heap with over 96 MiB of matching decisions", (t) => {
	const dir = fs.mkdtempSync(path.join(root, "audit-own-decisions-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = invoke(96, "audit-own-decisions", dir);
	assertsExit(result, "daemon audit of matching decisions");
	t.diagnostic(result.stdout.trim());
});

test("plan38 IS-10: one 96 MiB child joins a small record from oversized unrelated sources", (t) => {
	const dir = fs.mkdtempSync(path.join(root, "all-sources-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = invoke(96, "all-sources", dir);
	assertsExit(result, "bounded session record across all sources");
	t.diagnostic(result.stdout.trim());
});

test("gate 19 memory invariant: empty at 80 MiB / full at 96 MiB", async (t) => {
	const shapes = ["orig", "distinct", "family"];
	if (process.env.OMOH_MEMORY_REAL_SESSIONS) shapes.push("real-4x");
	for (const shape of shapes) {
		for (const operation of ["append", "backfill", "tick", "save", "load", "retention", "audit"]) {
			await t.test(`${shape} ${operation}`, () => {
				const empty = probe(operation, shape, "empty", 80);
				const full = probe(operation, shape, "full", 96);
				console.log(`EXIT ${shape} ${operation} empty80=${empty.status} full96=${full.status}`);
				assertsExit(empty, `${shape} ${operation} empty at 80 MiB`);
				assertsExit(full, `${shape} ${operation} full at 96 MiB`);
			});
		}
	}
});

for (const [operation, shape, cap] of [
	["append", "orig", 96],
	["backfill", "orig", 96],
	["retention", "distinct", 66],
	["audit", "family", 66],
]) {
	test(`gate 19 regression: ${shape} ${operation} survives with a full index at ${cap} MiB`, () => {
		const empty = probe(operation, shape, "empty", cap);
		const result = probe(operation, shape, "full", cap);
		console.log(`REGRESSION ${shape} ${operation} empty${cap}=${empty.status} full${cap}=${result.status}`);
		assertsExit(empty, `${shape} ${operation} empty at ${cap} MiB`);
		assertsExit(result, `${shape} ${operation} full at ${cap} MiB`);
	});
}

test("gate 22 sparse child tick fits the same fixture at empty80 and full96", (t) => {
	const dir = fs.mkdtempSync(path.join(root, "sparse-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	assertsExit(invoke(96, "build-sparse", dir), "build sparse fixture");
	for (const operation of ["positioned-tick", "sparse-tick"]) {
		fs.copyFileSync(path.join(ledgerDir(dir), "usage.json"), path.join(dir, `full-${operation}.json`));
		const empty = invoke(80, operation, dir, "empty");
		const full = invoke(96, operation, dir, "full");
		t.diagnostic(`${operation} empty80=${empty.status} full96=${full.status}`);
		assertsExit(empty, `${operation} empty at 80 MiB`);
		assertsExit(full, `${operation} full at 96 MiB`);
	}
});
