# N3: resident worker idle 59 min after `stop` (st_01a0ccfc, 11:23-12:24Z)

Sources (redacted, see F1):
- Child JSONL `children/st_01a0ccfc/sessions/st_01a0ccfc/2026-09-23T06-38-28-380Z_01a0ccfc-b41c-7721-9121-f66fa6c54769.jsonl`: header + lines 1180-1299 (11:10-12:24Z). Last entry before the gap: `assistant stop` at 11:23:55.929Z; the orchestrator re-dispatches at 12:22:58.302Z.
- Task record (resident, running, host_pid 40600) with updated_at set to the round end.
- `procs.ndjson`: host 40600 (from the task record) and its launcher (reconstructed) every 20 s.

Expected (design 9.1 N3): no D8 dead-child, no wake, no process action, no crit.
