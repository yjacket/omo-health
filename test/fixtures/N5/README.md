# N5: host-child `until ... sleep` monitor shell with no pending call (01a0cfa1, 19:06-19:40Z)

Sources (redacted, see F1):
- `~/.omo/agent/sessions/--C--dev-proj-b--/2026-09-23T18-57-58-432Z_01a0cfa1-bca0-7417-a748-ea70007558ae.jsonl`: header + lines 54-120 (19:00-19:40Z). At 19:06:41.119Z an `eval` starts `tool.monitor({command: "until [ -f '<round8>/DoneClaim.md' ]; do sleep 20; done; printf 'DONECLAIM\\n'", persistent: true})` and returns at once; the session then idles (stop 19:06:44Z, 19:36:18Z).
- `procs.ndjson` (every 20 s, reconstructed): host 43988, monitor shell 56032 (the monitor pid in plan F-7) as a direct host child running the loop, its MSYS shell and a fresh `sleep 20` each cycle.

Expected (design 9.1 / plan R1-B1): the monitor shell is never matched to anything; no D1, no action, no crit.
