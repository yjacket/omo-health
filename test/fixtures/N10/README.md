# N10: two writes left by a dead host, session resumed 66 min later (main, 2026-09-28T17:47Z)

Source: care issue #41 sample B (rebuilt, not a copy: ids, paths and file contents are placeholders).
- Transcript: one assistant message with two `write` calls at 16:41:09.960Z that never got a toolResult, then `pi-rules.scan {reason:"resume"}` and `senpi-memory.session-binding` at 17:47:43Z.
- The live host (sensor pid 25872, `procs.ndjson`) started at 17:47:29Z, after the calls were issued.

Expected: no D1 stall finding at all, so no notify or relay-cancel: the calls belong to a host that is gone, and senpi repairs them at the next request.
