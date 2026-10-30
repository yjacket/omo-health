# F1: provider outage after a settings.json edit (2026-09-23 15:46:50-15:57:30Z)

Sources (redacted: user paths -> `__FIXTURE__`/`user`, secrets masked; long text fields trimmed to 300 chars). Before the repository went public, every real transcript in these fixtures was made synthetic: other projects' names became `proj-a`..`proj-d`, and every free-text word became a same-length pseudo-word, except for the words the detectors match on; structure, ids, times, usage, tool names and models are unchanged:
- `~/.omo/agent/sessions/--C--dev-proj-b--/2026-09-23T11-27-03-154Z_01a0ce04-e7f2-74a4-bc28-c6b2c98fb442.jsonl`: header + lines 235-327 (15:30:00-15:57:30Z). The `edit` of settings.json is at 15:47:04.855Z; the first ok turn after recovery is at 15:56:57.893Z.
- `~/.omo/agent/sessions/--C--dev-proj-b--/2026-09-22T19-17-57-731Z_01a0ca8d-ad63-7b58-922c-de67b8ca3d4b.jsonl`: header + lines 754-805 (15:24:00-15:57:30Z). Nine `Provider is not configured` errors from 15:47:05.935Z.
- `logs/session.log` lines 24750-24789, `logs/fallback.log` lines 1421-1426 (15:46:50-15:57:30Z); `logs/config-reload.log` lines 5293-5323 (15:46:50-15:47:10Z).
- `omo/agent/settings.json` = `settings.json.bak-pre-ambient-2026-09-23T16-24-29-538Z` (the file without the ambient block, i.e. the pre-edit content); `_writes/settings.broken.json` = `settings.json.error` (ambient without `enabled`). `meta.fileWrites` swaps it in at 15:47:05.100Z; `meta.mtimes` keeps the good file quiet from 15:00Z so it becomes the LKG.
- Sensors: both main sessions get a heartbeat (pids reconstructed: 40600 is the host of 01a0ca8d's worker, 20132 is a placeholder for 01a0ce04's host).

Expected (design 1.1 F1, 9.1, plan todo 18): D6 not-configured burst at the first tick after 15:47:05.230Z, D7 settings-broke-provider with an automatic revert to the LKG, D14 global-config-write for 01a0ce04 (the writer), and a nudge to 01a0ca8d once the lane answers again (15:56:57.893Z). No process action.
