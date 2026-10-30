import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "../src/collect/tasks.mjs";
import * as labels from "../src/ui/labels.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every capture of `pattern` in the .mjs files of `dir`, so a new detector, step or stage without a label fails here. */
function sourceLiterals(dir, pattern) {
	return fs
		.readdirSync(path.join(root, dir))
		.filter((file) => file.endsWith(".mjs"))
		.flatMap((file) => [...fs.readFileSync(path.join(root, dir, file), "utf8").matchAll(pattern)].map((match) => match[1]));
}

test("finding kinds in detector sources have finding or action labels", () => {
	for (const kind of sourceLiterals("src/detect", /kind:\s*"([a-z-]+)"/g)) assert.ok(labels.FINDING_LABELS[kind] || labels.ACTION_LABELS[kind], kind);
});

test("park labels use usage-limit waiting terminology", () => {
	assert.equal(labels.findingLabel("D20", "park-invalid"), "한도 대기 기록 오류");
	assert.equal(labels.findingLabel("D20", "park-due"), "한도 대기 재개");
	assert.equal(labels.actionLabel("park-resume"), "한도 대기 재개");
	assert.equal(labels.actionLabel("park-cleanup"), "비정상 한도 대기 기록 정리(기록만)");
});

test("detector severities have labels", () => {
	for (const severity of sourceLiterals("src/detect", /severity:\s*"([a-z]+)"/g)) assert.ok(labels.SEVERITY_LABELS[severity], severity);
});

test("unknown labels use fallbacks without throwing", () => {
	assert.equal(labels.findingLabel(undefined, "nope"), "? nope");
	assert.equal(labels.findingLabel("D14", "outside-workspace"), "작업 폴더 밖 수정");
	assert.equal(labels.actionLabel(null), "?");
	assert.equal(labels.actionLabel("__proto__"), "__proto__");
	assert.equal(labels.resultLabel(undefined), "-");
	assert.equal(labels.severityLabel(undefined), "");
	assert.equal(labels.exitReasonLabel(null), "");
	assert.equal(labels.daemonStateLabel(undefined), "");
});

test("the session board and the ended-session ledger vocabularies have Korean labels; removed finding kinds have none", () => {
	assert.deepEqual(labels.OUTCOME_LABELS, { "goal-complete": "목표 완료", answered: "응답 후 종료", crash: "비정상 종료", cancelled: "취소됨", failed: "실패", released: "omo-health 해제", closed: "종료됨", unknown: "알 수 없음" });
	assert.deepEqual(labels.SESSION_STATE_LABELS, { busy: "응답 중", tool: "도구 실행 중", idle: "대기", waiting: "작업 대기", "waiting-user": "사용자 대기", stale: "응답 없음" });
	assert.deepEqual(Object.keys(labels.TERMINAL_LABELS), ["orca", "herdr", "other"]);
	for (const status of [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES]) assert.ok(labels.TASK_STATUS_LABELS[status], status);
	for (const kind of ["ambient-workaround-missing", "deferral-storm", "host-login-expired", "host-login-expiring"]) assert.equal(Object.hasOwn(labels.FINDING_LABELS, kind), false, kind);
	assert.equal(labels.outcomeLabel("goal-complete"), labels.OUTCOME_LABELS["goal-complete"]);
	assert.equal(labels.outcomeLabel("nope"), "nope");
	assert.equal(labels.sessionStateLabel(undefined), "-");
	assert.equal(labels.terminalLabel("weird"), labels.TERMINAL_LABELS.other);
	assert.equal(labels.terminalLabel(undefined), labels.TERMINAL_LABELS.other);
	assert.equal(labels.taskStatusLabel("running"), labels.TASK_STATUS_LABELS.running);
	assert.equal(labels.taskStatusLabel(null), "-");
	assert.equal(labels.goalStatusLabel("complete"), labels.GOAL_STATUS_LABELS.complete);
	assert.equal(labels.goalStatusLabel("paused"), "paused");
});

test("diagnose verdicts and advice, and every wait class of the D1 classifier, have Korean labels", () => {
	const classes = [...fs.readFileSync(path.join(root, "src", "detect", "classify.mjs"), "utf8").matchAll(/(?:result\(|cls: )"([a-z-]+)"/g)].map((match) => match[1]);
	assert.ok(classes.includes("unbounded-wait") && classes.includes("respawn-loop") && classes.includes("quiet-hang"), "the classifier's classes are found");
	for (const cls of classes) assert.ok(labels.WAIT_CLASS_LABELS[cls], cls);
	const judged = [...fs.readFileSync(path.join(root, "src", "diagnose.mjs"), "utf8").matchAll(/judged\("([a-z-]+)", "([a-z-]+)"/g)];
	assert.ok(judged.length >= 4, "the diagnosis verdicts are found");
	for (const [, verdict, advice] of judged) {
		assert.ok(labels.VERDICT_LABELS[verdict], verdict);
		assert.ok(labels.ADVICE_LABELS[advice], advice);
	}
	assert.equal(labels.verdictLabel("nope"), "nope");
	assert.equal(labels.adviceLabel(undefined), "-");
});
