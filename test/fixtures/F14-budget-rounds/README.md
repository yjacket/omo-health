# F14: synthetic flat-cost numbered QA rounds

All identifiers, timestamps and costs are synthetic. Twelve numbered QA rounds repeat the same
acceptance check, with costs cycling through $2, $3, $4 and $5. Three completed child tasks add
$3, $4 and $5 while the goal is active. No measured project data or transcript is copied.

Layout:
- `omo/agent/sessions/--synthetic-export--/`: one session starting at 2026-01-02 06:00 UTC,
  a synthetic user request and twelve assistant rounds at two-hour intervals from 08:00 UTC.
- `omo/agent/sessions/.../extensions/goal/`: the active `goal-export-rounds` goal.
- `projects/qa/.omo/senpi-task/`: three completed tasks and their child transcripts.
- `omo/agent/auth.json`: provider key names only; the replay never reads an auth value.

`meta.json` opts into budget governance and supplies a synthetic `waste-likely` audit answer
with a 60-second duration. The real budget office uses an in-memory database and a fake runner
on the fixture clock: no process or model is launched.

Expected: the office ingests main and child spend, sends one `budget-request` self-notice,
starts one audit for the heavy `rounds` trigger, and returns one `budget-audit-opinion` self-notice
and one D26 `audit-opinion` finding. Budget remains advisory: no process action.
