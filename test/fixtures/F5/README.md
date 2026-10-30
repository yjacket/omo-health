# F5: cache-write storm in session 01a0ca81 (2026-09-23 08:49-08:58Z)

Sources (redacted, see F1):
- `~/.omo/agent/sessions/--C--dev-proj-a--/2026-09-22T19-04-47-170Z_01a0ca81-9d42-7905-b519-718d4bb21306.jsonl`: header + lines 320-430 (08:40-08:58Z). Storm turns at 08:52:35.265Z (cacheRead 28,226, cacheWrite 319,300) and 08:53:40.897Z (cacheWrite 329,305).

Expected (design 1.1 F5, 9.1): D4 cache-storm on 01a0ca81 at the second storm turn (08:53:40.897Z +-15 s). Report-only: no toast, no action.
