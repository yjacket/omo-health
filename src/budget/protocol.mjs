// C-protocol: extract and validate the budget blocks a goal session emits at the end of a reply.
// Grammar: a line-start `<omo-budget kind="estimate">` (or `kind="change"`), a JSON body, `</omo-budget>`.
// Blocks inside ``` fences are ignored; a body longer than 8192 characters is not a block.

export const MAX_BODY_CHARS = 8192;

export const WORK_CLASSES = Object.freeze([
	"implementation",
	"debugging",
	"research",
	"verification",
	"documentation",
	"mixed",
]);

export const CHANGE_REASONS = Object.freeze([
	"estimate-error",
	"new-evidence",
	"external-blocker",
	"owner-scope-change",
	"model-mix-change",
]);

const BLOCK_KINDS = new Set(["estimate", "change"]);
const ESTIMATE_KEYS = ["v", "requestId", "projectId", "baseRevision", "remainingUsd", "workClass", "basis", "nextCheckpoint"];
const CHANGE_KEYS = [...ESTIMATE_KEYS, "reason", "justification", "alternatives"];
const QUANTILE_KEYS = ["p10", "p50", "p90"];
const BASIS_KEYS = ["workUnits", "assumptions"];
const WORK_UNIT_KEYS = ["description", "count"];
const ALTERNATIVE_KEYS = ["description", "remainingUsd", "tradeoff"];

const OPEN_TAG = /^<omo-budget\s+kind\s*=\s*"(estimate|change)"\s*>\s*$/;
const CLOSE_TAG = /^\s*<\/omo-budget>\s*$/;
const FENCE_LINE = /^\s*```/;

/**
 * Extract every well-formed budget block from one assistant text.
 * Fenced examples, unterminated blocks, and bodies over MAX_BODY_CHARS are skipped.
 */
export function extractBlocks(text) {
	const blocks = [];
	if (typeof text !== "string" || text.length === 0) return blocks;
	const lines = text.split(/\r?\n/);
	let fence = false;
	let current = null;
	for (const line of lines) {
		if (current !== null) {
			if (CLOSE_TAG.test(line)) {
				const body = current.lines.join("\n").trim();
				if (body.length <= MAX_BODY_CHARS) blocks.push({ kind: current.kind, body });
				current = null;
				continue;
			}
			current.lines.push(line);
			continue;
		}
		if (FENCE_LINE.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const open = OPEN_TAG.exec(line);
		if (open) current = { kind: open[1], lines: [] };
	}
	return blocks;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushUnknownKeys(errors, obj, allowed, prefix) {
	for (const key of Object.keys(obj)) {
		if (allowed.includes(key)) continue;
		errors.push(prefix ? `${prefix}: unknown key "${key}"` : `unknown key "${key}"`);
	}
}

function checkString(errors, label, value, maxChars, minChars = 0) {
	if (typeof value !== "string") {
		errors.push(`${label} must be a string`);
		return;
	}
	if (value.length < minChars) errors.push(`${label} must be at least ${minChars} characters`);
	if (value.length > maxChars) errors.push(`${label} must be at most ${maxChars} characters`);
}

function checkInteger(errors, label, value, min, max) {
	if (!Number.isInteger(value)) {
		errors.push(`${label} must be an integer`);
		return;
	}
	if (value < min || value > max) errors.push(`${label} must be between ${min} and ${max}`);
}

// exact keys {p10, p50, p90}; finite, 0 <= p10 <= p50 <= p90 <= 100000.
function checkQuantiles(errors, label, value) {
	if (!isPlainObject(value)) {
		errors.push(`${label} must be an object with p10, p50, p90`);
		return;
	}
	pushUnknownKeys(errors, value, QUANTILE_KEYS, label);
	const numbers = {};
	for (const key of QUANTILE_KEYS) {
		const n = value[key];
		if (typeof n !== "number" || !Number.isFinite(n)) {
			errors.push(`${label}.${key} must be a finite number`);
			continue;
		}
		if (n < 0 || n > 100000) errors.push(`${label}.${key} must be between 0 and 100000`);
		numbers[key] = n;
	}
	if (numbers.p10 !== undefined && numbers.p50 !== undefined && numbers.p10 > numbers.p50) {
		errors.push(`${label}: p10 must be <= p50`);
	}
	if (numbers.p50 !== undefined && numbers.p90 !== undefined && numbers.p50 > numbers.p90) {
		errors.push(`${label}: p50 must be <= p90`);
	}
}

function checkEstimateFields(errors, obj) {
	if (obj.v !== 1) errors.push("v must be 1");

	if (typeof obj.requestId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(obj.requestId)) {
		errors.push("requestId must be 1-64 characters of [A-Za-z0-9._-]");
	}

	checkQuantiles(errors, "remainingUsd", obj.remainingUsd);

	if (!WORK_CLASSES.includes(obj.workClass)) {
		errors.push(`workClass must be one of ${WORK_CLASSES.join(", ")}`);
	}

	const basis = obj.basis;
	if (!isPlainObject(basis)) {
		errors.push("basis must be an object with workUnits and assumptions");
	} else {
		pushUnknownKeys(errors, basis, BASIS_KEYS, "basis");
		const units = basis.workUnits;
		if (!Array.isArray(units) || units.length < 1 || units.length > 20) {
			errors.push("basis.workUnits must be an array of 1-20 items");
		} else {
			for (let i = 0; i < units.length; i += 1) {
				const unit = units[i];
				const label = `basis.workUnits[${i}]`;
				if (!isPlainObject(unit)) {
					errors.push(`${label} must be an object with description and count`);
					continue;
				}
				pushUnknownKeys(errors, unit, WORK_UNIT_KEYS, label);
				checkString(errors, `${label}.description`, unit.description, 200);
				checkInteger(errors, `${label}.count`, unit.count, 1, 1000);
			}
		}
		const assumptions = basis.assumptions;
		if (!Array.isArray(assumptions) || assumptions.length > 10) {
			errors.push("basis.assumptions must be an array of at most 10 items");
		} else {
			for (let i = 0; i < assumptions.length; i += 1) {
				checkString(errors, `basis.assumptions[${i}]`, assumptions[i], 200);
			}
		}
	}

	checkString(errors, "nextCheckpoint", obj.nextCheckpoint, 200);
}

function checkChangeFields(errors, obj) {
	if (!CHANGE_REASONS.includes(obj.reason)) {
		errors.push(`reason must be one of ${CHANGE_REASONS.join(", ")}`);
	}
	checkString(errors, "justification", obj.justification, 1000, 40);

	const alternatives = obj.alternatives;
	if (!Array.isArray(alternatives) || alternatives.length < 1 || alternatives.length > 3) {
		errors.push("alternatives must be an array of 1-3 items");
	} else {
		for (let i = 0; i < alternatives.length; i += 1) {
			const alt = alternatives[i];
			const label = `alternatives[${i}]`;
			if (!isPlainObject(alt)) {
				errors.push(`${label} must be an object with description, remainingUsd, tradeoff`);
				continue;
			}
			pushUnknownKeys(errors, alt, ALTERNATIVE_KEYS, label);
			checkString(errors, `${label}.description`, alt.description, 200);
			checkQuantiles(errors, `${label}.remainingUsd`, alt.remainingUsd);
			checkString(errors, `${label}.tradeoff`, alt.tradeoff, 200);
		}
	}
}

/**
 * Validate one parsed block against the project and revision it answers.
 * Returns {ok: true, value} or {ok: false, errors: [string]}; every error names its field path.
 */
export function validateBlock(kind, obj, { projectId, revision } = {}) {
	const errors = [];
	if (!BLOCK_KINDS.has(kind)) {
		return { ok: false, errors: [`kind must be "estimate" or "change"`] };
	}
	if (!isPlainObject(obj)) {
		return { ok: false, errors: ["block must be a JSON object"] };
	}
	if (JSON.stringify(obj).length > MAX_BODY_CHARS) {
		return { ok: false, errors: [`block body exceeds ${MAX_BODY_CHARS} characters`] };
	}

	pushUnknownKeys(errors, obj, kind === "change" ? CHANGE_KEYS : ESTIMATE_KEYS, "");
	const required = kind === "change" ? CHANGE_KEYS : ESTIMATE_KEYS;
	for (const key of required) {
		if (!(key in obj)) errors.push(`${key} is required`);
	}

	if ("projectId" in obj && obj.projectId !== projectId) {
		errors.push(`projectId must equal "${projectId}"`);
	}
	if ("baseRevision" in obj) {
		if (!Number.isInteger(obj.baseRevision) || obj.baseRevision < 0) {
			errors.push("baseRevision must be an integer >= 0");
		} else if (obj.baseRevision !== revision) {
			errors.push(`baseRevision must equal current revision ${revision}`);
		}
	}

	checkEstimateFields(errors, obj);
	if (kind === "change") checkChangeFields(errors, obj);

	return errors.length === 0 ? { ok: true, value: obj } : { ok: false, errors };
}
