# F14: flat-cost numbered QA rounds, the hwp-birsom shape (synthetic)

No real transcript is copied here. The fixture is generated synthetically from the measured hwp-birsom
round/cost table in the token-budget-governance plan's Findings: session
`01a1a72c-8292-793b-8966-70b8670b893a`, goal 2 created 2026-11-05 08:32 KST, twelve numbered QA rounds
with a flat $2-6 main-session cost each, three subagent task records with child transcripts, and no
private content (no user text, paths masked to `__FIXTURE__`, no tokens).

Layout:
- `omo/agent/sessions/--C--dev-hwp-birsom--/2026-11-04T23-32-00-000Z_01a1a72c-....jsonl`: header, one
  synthetic user request, then twelve assistant turns labelled `QA round 1` .. `QA round 12`, each
  costing $2-6. The round times mirror the measured first-appearance table's shape (spread over two
  days), not the exact incident minutes.
- `omo/agent/sessions/.../extensions/goal/01a1a72c-....json`: the goal store entry (goal `goal-hwp-rounds`).
- `projects/qa/.omo/senpi-task/`: three completed task records and their child session transcripts
  (child spend $3.50-5.50), created while the goal was active.
- `omo/agent/auth.json`: key names only (`chatgpt-subscription`), so the audit model's provider looks
  logged in; the replay never reads a value.

`meta.json` sets `config.budget.enabled: true` and carries the fake audit answer under `budgetAudit`
(a `waste-likely` opinion, `durationMs` 60000, validated by the real C-audit parser). The replay runs the
real budget office on an in-memory db with a fake runner on the fixture clock: no process and no model
is launched, and `OMO_HEALTH_OMO` may point at a nonexistent path.

Expected (plan todo 22, IS-7/IS-8/IS-12): with budget governance on, the office ingests the rounds and
the child spend, sends one `budget-request` self-notice at the $10 crossing, starts one audit
(`budget-audit-start`, heavy `rounds` trigger: 12 rounds and well over $10 since round 1), and returns
the parsed opinion (`budget-audit-end`, one `budget-audit-opinion` self-notice, one D26 `audit-opinion`
info finding). Budget stays advisory: no process action.
