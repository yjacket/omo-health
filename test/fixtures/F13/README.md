# F13: fake senpi host started in the foreground (st_01a0ee39, deep-high worker, 18:58-19:08Z)

Staged from the 2026-09-29 production case (parent 01a0ee28). Ids are real where known; the full session uuids, pids, paths and byte counts are placeholders. The real release was the old R11 clock release at 19:10:40Z; the worker completed at 19:29:58Z.
- Child transcript: one `bash` call `cd C:/dev/senpi-host-test && node scripts/fake-host.mjs` issued at 18:53:40.000Z that never returns until its tree is ended (the fake host waits in the foreground); the error tool result arrives at 19:04:40Z, right after the release.
- `procs.ndjson` (every 20 s): host 41236, the call's bash 72000 and the fake host `node` 72010: no CPU, no writes. The process stands in for the host and is named so that it is not a protected senpi host. The tree is gone from the 19:05:40Z snapshot on.
- `meta.analyst`: the fake analyst answers `stuck` (confidence 0.88, evidence cited) 30 s after it was started.

Expected: R11 `unknown` opens an investigation at call + 10 min (19:03:40Z) and starts the analyst; its `stuck` verdict releases the shell tree, the investigation reads `released`, and nothing is sent to the parent or the child. The quiet hang (R12) would only start at 19:13Z and is outside the window. Variants are built in test/replay.test.mjs.

2026-10-16: analyst answers carry mechanism and avoid (0.6.0 contract)
2026-10-16 (0.6.0, analyst-why IS-3): expected.json changed. A child release is no longer silent: right after the release the parent gets exactly one why message (a `relay` with `details.why`, the analyst's cause, mechanism and avoid), so `messages` is 1, `message:relay` is expected instead of forbidden, and the investigation ends `advised` (it read `released` first; the decision rows still show `verdict` and `released`). `relay-cancel` stays forbidden.
