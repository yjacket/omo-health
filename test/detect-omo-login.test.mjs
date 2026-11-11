import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDetectors } from "../src/engine.mjs";
import { detect } from "../src/detect/omo-login.mjs";
import { makeWorld } from "./helpers/world.mjs";

const D = 86_400_000;
const H = 3600_000;
const NOW = Date.parse("2026-11-01T00:00:00Z");

const slot = (name, ageMs, extra = {}) => ({ name, loginMs: NOW - ageMs, basis: "login", ...extra });
const world = (slots, config) => makeWorld({ now: NOW, secrets: { omoLogin: { slots } }, ...(config ? { config } : {}) });

test("13d23h of login age is under 14d -> no finding", () => {
	assert.deepEqual(detect(world([slot("main", 13 * D + 23 * H)])), []);
});

test("14d of login age -> one D25 warn finding for the operator", () => {
	const findings = detect(world([slot("main", 14 * D)]));
	assert.equal(findings.length, 1);
	const [finding] = findings;
	assert.equal(finding.detector, "D25");
	assert.equal(finding.kind, "omo-login-aging");
	assert.equal(finding.severity, "warn");
	assert.equal(finding.humanNeeded, true);
	assert.equal(finding.titleKo, "omo 다시 로그인 권장");
	assert.match(finding.detailKo, /14일/);
	assert.equal(finding.data.slot, "main");
	assert.deepEqual(finding.evidence, ["ageDays:14", "basis:login", "slots:1"]);
});

test("the newest working slot decides: old 20d + fresh 1d -> no finding", () => {
	assert.deepEqual(detect(world([slot("old", 20 * D), slot("fresh", 1 * D)])), []);
});

test("an auth_error slot is not usable: blocked fresh 1d + ok 15d -> finding names the 15d slot", () => {
	const findings = detect(world([slot("blocked", 1 * D, { blockReason: "auth_error" }), slot("ok", 15 * D)]));
	assert.equal(findings.length, 1);
	assert.equal(findings[0].data.slot, "ok");
	assert.equal(findings[0].data.loginMs, NOW - 15 * D);
});

test("every slot auth_error -> no finding", () => {
	assert.deepEqual(detect(world([slot("a", 20 * D, { blockReason: "auth_error" }), slot("b", 30 * D, { blockReason: "auth_error" })])), []);
});

test("first-seen basis says the login was first seen, not performed", () => {
	const [finding] = detect(world([slot("main", 20 * D, { basis: "first-seen" })]));
	assert.match(finding.detailKo, /처음 확인한 지 20일/);
	assert.equal(finding.data.basis, "first-seen");
});

test("warnAfterMs 0 turns the warning off", () => {
	assert.deepEqual(detect(world([slot("main", 40 * D)], { omoLogin: { warnAfterMs: 0 } })), []);
});

test("no secrets -> no finding", () => {
	assert.deepEqual(detect(makeWorld({ now: NOW })), []);
});

test("loadDetectors registers D25", async () => {
	const detectors = await loadDetectors();
	assert.ok(detectors.some((detector) => detector.id === "D25"));
});
