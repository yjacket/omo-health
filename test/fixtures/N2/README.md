# N2: timeout-bounded tail monitor (st_01a0ceff, 16:25:05Z)

Sources (redacted, see F1):
- Child JSONL `children/st_01a0ceff/sessions/st_01a0ceff/2026-09-23T16-01-16-480Z_01a0ceff-f6c0-725f-ab3e-b729eed80816.jsonl`: header + lines 87-129 (16:15-16:31:30Z). `toolu_01Jj8ma5...` (`timeout 300 tail -n 0 -F ... | grep -m1 ...`, tool timeout 330 s) runs 16:25:05.910Z-16:30:06.322Z; `toolu_014mcZ4U...` (`timeout 420 ...`) starts 16:30:21.911Z.
- Task record `tasks/st_01a0ceff.json` rewound to running. It has no host_pid; 48212 is a reconstructed host pid (the parent 01a0ce04's host, which gets the sensor).
- `procs.ndjson` (every 20 s, reconstructed): launcher shell as a direct host child with the exact command, inner MSYS shell, timeout.exe -> tail.exe (reading), grep.exe; the chain disappears when the call returns.

Expected (design 9.1 N2): class bounded (explicit 300 s bound + 60 s grace), no alert, no action.
