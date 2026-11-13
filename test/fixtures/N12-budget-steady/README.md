# N12-budget-steady: a long steady goal with an approved estimate, no numbered rounds (synthetic)

Synthetic: built from fixture builders and plain JSONL; no real session content.

One goal created at 08:00Z, worked in steady slices from 09:10Z to 16:40Z ($1 per slice, $16 total). The session's
transcript carries a valid `estimate` block at 14:10Z (project id 01a0e100-0012-7000-8000-000000000012:goal-steady-12, baseRevision 0), so the budget office
records a rule-approved budget once inclusive spend passes the $10 request threshold.

The goal has no numbered QA rounds, its spend stays far below the approved budget (16 of 41.2 USD), and no audit
trigger fires. meta.budgetAudit supplies an answer the fake replay runner would give, but it must never be asked.

Expected: a budget-request/budget-decision self-notice is delivered, while no `budget-audit-start`/
`budget-audit-end` action happens and D26 emits no warn finding (IS-12: the auditor stays silent on a normal long
run).
