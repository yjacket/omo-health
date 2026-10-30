# F8: one todo cycling fix, rerun and review (synthetic)

Synthetic, built with `test/helpers/fixtures.mjs` builders.

One request at 13:50Z, the todo "Fix flaky check" starts at 14:02Z, then 16 eval steps cycle "Fix flaky check in the tokenizer" / "Rerun the tokenizer tests" / "Review the tokenizer diff" every two minutes without a todo transition.

Expected (issues #28, #29): one D15 `drift/stuck` for the session and one scope-check message that names the evidence ("12 steps on 'Fix flaky check' since 14:02Z"), sent at the 12th step (~14:26Z). No second note before the 45-minute gap ends.
