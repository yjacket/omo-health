# F3: runaway grep behind a withheld git log (st_01a0ced9, 15:37-16:40Z)

Sources (redacted, see F1):
- Child JSONL `children/st_01a0ced9/sessions/st_01a0ced9/2026-09-23T15-19-09-886Z_01a0ced9-693e-72d2-b98b-994da92fef62.jsonl`: header + lines 2-20 (15:19-16:40Z). The 15:37:04.900Z batch holds `toolu_014cNEwB...` (the grep loop) and `toolu_01SVjp3F...` (git log); both stay unresolved in the window.
- Task record `tasks/st_01a0ced9.json` rewound to its running state (foreground, host_pid 25760, no terminal_at/error).
- Parent `~/.omo/agent/sessions/--C--dev-proj-b--/2026-09-23T09-34-45-438Z_01a0cd9e-18be-7b85-8c85-6127f3816238.jsonl`: header + lines 265-269 (the foreground `task` call at 15:19:09.843Z). The parent gets a busy sensor heartbeat (pid 25760).
- Claude transcript `01a0ced9-6bb9-795b-869f-c123280b3f54.jsonl`: the two tool_use items only (if present).
- `procs.ndjson` (every 60 s): host 25760 and launcher 44428 (from the 17:29Z process check), root shell 60168 (design 1.1), inner MSYS shell 60172 (reconstructed), `head.exe` 62136 with dead parent 62128 (reconstructed), and `grep.exe` 55000 with dead parent 62120, start 15:37:05.116Z and the exact command line recorded at 16:42:40Z in 01a0ce04 (`"C:\Program Files\Git\usr\bin\grep.exe" -o ".\{0,1800\}h=function(e,t,n){let r=\[" /c/Users/user/.../omo.js`). CPU = 0.99 x wall time (3,188.7 s at 16:30:45Z, 3,893 s at 16:42:40Z). Private bytes rise linearly to 13.4 GB at 16:35:59Z, then +75 MB/min (13.9 GB at 16:42:40Z). Commit: 38.7 GB base + grep private over a 52.5 GB limit (51.6/52.5 GB at the 16:34Z triage). The git log shell finished in ~0.5 s and never appears in a 60 s snapshot.

Expected (design 1.1 F3, 9.1; plan todo 18): kill-pids of grep.exe 55000 only, no later than 15:47:05Z +20 s (memory-runaway may fire earlier). The git log call is never a target; no detach-server.
