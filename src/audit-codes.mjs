/**
 * The closed reason vocabulary of the outbound audit bundle (plan todo 11).
 * Todo 7 inlines it here so the per-session record can tag an action or an
 * analyst answer with a recognized code; todo 11 imports and re-exports it.
 *
 * Codes were extracted from the `reason:` literals and template prefixes of
 * `src/judge/analyst.mjs`, `src/engine.mjs` and `src/runner.mjs`, plus the gate
 * verdicts the engine stores as a result.
 */
export const AUDIT_REASON_CODES = Object.freeze([
	"analyst-off",
	"provider-limit",
	"analyst-failing",
	"budget-exhausted",
	"bad-output",
	"no-evidence",
	"action-not-in-candidates",
	"spawn-error",
	"timeout",
	"unavailable",
	"poll-error",
	"no-job",
	"pid-reused",
	"no-result",
	"exit",
	"unverified",
	"would",
	"skipped",
	"report-expired",
	"finding-resolved",
]);

/**
 * The first recognized code that equals `text` or prefixes it with `:` or `-`;
 * anything else non-empty is `"other"`, and an empty value is null. The rest of
 * the text is always dropped.
 */
export function reasonCode(text) {
	if (typeof text !== "string" || !text) return null;
	for (const code of AUDIT_REASON_CODES) {
		if (text === code || text.startsWith(`${code}:`) || text.startsWith(`${code}-`)) return code;
	}
	return "other";
}
