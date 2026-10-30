# N9: write batched with a 5 min bash (child, 2026-09-28T00:16:45Z)

Source: care issue #41 sample A (rebuilt, not a copy: ids, paths and the command are placeholders).
- Child transcript: one assistant message with `[write, bash]` at 00:16:45.920Z. senpi persists both toolResults together when the bash ends (00:22:08Z in reality), so the finished `write` has no result for 5 min.
- `procs.ndjson` (every 20 s): the bash runs as a direct host child (`timeout 600 sleep 500`). The task record has host_pid 48212, the parent's sensor pid.

Expected: the `write` is `withheld` (no action), the bash is `bounded`. Never `inproc`, never a relay-cancel.
