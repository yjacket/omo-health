# F9: two children of one parent cycle at the same time (synthetic)

Synthetic, built with `test/helpers/fixtures.mjs` builders.

A main session (sensor only) delegated to two running subagents. Each finished eight todos (10:32Z-11:48Z, distinct summaries), then from 11:50Z cycles one todo ("Fix flaky check") with 14 fix/rerun/review steps. The old age rule (90 min + 40 calls) nudged both children separately at 12:00Z because the budget was kept per subject.

Expected: exactly one scope-check message, addressed to the parent, which forwards it to the child that tripped the detector.
