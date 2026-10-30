# N4: old dead session with a pending apply_patch and no host

Sources (redacted, see F1):
- `~/.omo/agent/sessions/--C--dev-proj-c--/2026-09-19T19-47-14-197Z_01a0bb35-6695-73dd-a509-0974268f2f0b.jsonl`: header + lines 200-238, cut right after the `apply_patch` call of 2026-09-19T21:25:14.942Z so the call stays pending (design 1.3 lists it as pending since 09-19).
- No sensor, no process data: the host is gone.

Expected (design 9.1 N4): nothing actionable; no warn/crit, no D1, no action.
