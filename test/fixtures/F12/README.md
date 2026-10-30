# F12: stray `python -` REPL at 98% CPU (st_01a0ee70, deep-low worker, 19:25-19:40Z)

Staged from the 2026-09-29 production case (parent 01a0ee28, #52/todo 8). Ids are real where known; the full session uuids, pids, paths and byte counts are placeholders. The real release was the old R10x clock release at 19:44:32Z; the worker "already found the cause" and completed at 19:47:51Z.
- Child transcript: one `bash` call `python -` issued at 18:32:30.000Z that never returns until its tree is ended; the error tool result arrives at 19:33:30Z, a few seconds after the release.
- `procs.ndjson` (every 20 s): host 41236, the call's bash 71000 and `python -` 71010 using 98% of a core and writing about 6 KB per snapshot, so R10 reads it as `progressing`. The tree is gone from the 19:34:00Z snapshot on (what the real release did to it).
- `meta.analyst`: the fake analyst answers `stuck` (confidence 0.9, evidence cited) 45 s after it was started.

Expected: `progressing` until the class maximum (60 min, 19:32:30Z), then R10x opens an investigation and starts the analyst. Its `stuck` verdict releases the shell tree (release-shell of 71000 and 71010), the investigation reads `released`, and NOTHING is sent to the parent or the child (a child release is recorded only). No clock release: before the analyst answered nothing was killed. Variants (analyst failed, refused, unavailable) are built in test/replay.test.mjs.

2026-10-16: analyst answers carry mechanism and avoid (0.6.0 contract)
2026-10-16 (0.6.0, analyst-why IS-3): expected.json changed. A child release is no longer silent: right after the release the parent gets exactly one why message (a `relay` with `details.why`, the analyst's cause, mechanism and avoid), so `messages` is 1, `message:relay` is expected instead of forbidden, and the investigation ends `advised` (it read `released` first; the decision rows still show `verdict` and `released`). `relay-cancel` stays forbidden.
