import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.mjs";

const SECTIONS = ["align", "monitorOrphans", "reflectionOrphans", "crashResume", "analyst", "baseline", "respawn"];

function sampleConfigText() {
	const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const blocks = [...readme.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]);
	assert.equal(blocks.length, 1, "README.md must contain exactly one ```json block");
	return blocks[0];
}

function leafPaths(value, prefix) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
	return Object.entries(value).flatMap(([key, child]) => leafPaths(child, `${prefix}.${key}`));
}

function valueAt(root, dotted) {
	return dotted.split(".").reduce((node, key) => (node !== null && typeof node === "object" ? node[key] : undefined), root);
}

test("README sample config loads without warnings", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-health-readme-"));
	try {
		const configFile = path.join(dir, "config.json");
		fs.writeFileSync(configFile, sampleConfigText());
		const { warnings, sources } = loadConfig({ env: {}, paths: { health: { configFile } } });
		assert.deepEqual(sources, [configFile]);
		assert.deepEqual(warnings, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("README sample config lists every align, analyst and baseline key with its default", () => {
	const sample = JSON.parse(sampleConfigText());
	for (const section of SECTIONS) {
		for (const leaf of leafPaths(valueAt(DEFAULT_CONFIG, section), section)) {
			const actual = valueAt(sample, leaf);
			assert.notEqual(actual, undefined, `README sample config is missing ${leaf}`);
			assert.deepEqual(actual, valueAt(DEFAULT_CONFIG, leaf), `README sample config has a non-default value for ${leaf}`);
		}
	}
});
