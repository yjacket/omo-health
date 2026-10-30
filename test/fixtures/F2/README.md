# F2: CPA child stalled on two foreground servers (st_01a0cea6, 14:34-15:10Z)

Sources (redacted, see F1):
- Child JSONL `proj-b/.omo/senpi-task/children/st_01a0cea6/sessions/st_01a0cea6/2026-09-23T14-20-50-579Z_01a0cea4-0413-719f-824a-0e978b551d39.jsonl`: header + lines 94-159 (14:28-15:10Z; the last entry is the 14:34:29.416Z batch with two unresolved `bash` calls).
- Task record `tasks/st_01a0cea6.json`, rewound to its state during the stall: status running, updated_at 14:20:50.572Z, no terminal_at. The record carries no host_pid; 32552 is the host pid from design 1.1.
- Claude transcript `~/.claude/projects/C--dev-proj-b/01a0cea4-0624-70c7-a7db-48b3dbc7744e.jsonl`: only the two `tool_use` items (both `run_in_background: true`).
- `logs/session.log`: the 10 `claude_sdk_oauth_session_close` records in 14:34-15:10Z (the idle_ttl reap at 15:04:29.443Z).
- `procs.ndjson`: reconstructed every 60 s from design 1.1/9.1: host 32552 (senpi cli.js), launcher shells 25628 (mock) and 56924 (cpa) as direct host children whose command lines hold the exact tool command, inner MSYS shells 25640/56936, node 60496 LISTENING 127.0.0.1:18080 and cpa.exe 59336 on 18317. CPU (cumulative ms) and memory from the 17:44Z check (node 0.2 s/25 MB, cpa 0.9 s/59 MB). Inner shell pids 25640/56936 and the launcher 32540 are reconstructed.
- The parent 01a0ce4f gets a sensor heartbeat so the relay goes through its inbox.

Expected: D1 server-foreground at 14:36:29Z (call + 2 min), detach-server of each launcher shell chain (servers kept), recorded quietly in the investigation list: no message to the parent. Never kill-pids. Replay caveat: the snapshots are historical, so after the detach the shells stay in the data and the ladder later escalates (release-shell); that is not asserted.
