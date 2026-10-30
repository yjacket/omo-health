# N1: ask_user_question waiting 60 min (01a0ce04, 16:46:07Z)

Sources (redacted, see F1):
- `~/.omo/agent/sessions/--C--dev-proj-b--/2026-09-23T11-27-03-154Z_01a0ce04-e7f2-74a4-bc28-c6b2c98fb442.jsonl`: header + lines 424-439 (16:40:00-16:46:07.650Z). The file is cut right after the 16:46:07.650Z `ask_user_question` batch, so the question stays unanswered for the whole 61 min window (in reality it timed out after 30 min at 17:16:07Z).
- The session has a live sensor (pid 20132, placeholder).

Expected (design 9.1 N1): class human-wait, info only after 60 min; no action, no warn/crit.
