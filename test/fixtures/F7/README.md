# F7: churn, a review loop without a new user request (proj-a 01a09716, 04:44-04:50Z)

Sources (redacted, see F1; thinking blocks dropped, tool output trimmed with failure/todo lines kept, user requests keep head and tail):
- `~/.omo/agent/sessions/--C--dev-proj-a--/2026-09-12T19-27-40-351Z_01a09716-f93f-7c11-829f-d94f423bec60.jsonl`: header + lines 29-162 (02:37-04:50Z). One user request (the `ulw-execute` invocation at 02:37:42.940Z) is followed by 44 tool calls and seven `task` spawns; four of them are independent verifications of successive fixes.
- The child task sessions of these spawns (st_01a098xx-st_01a09axx) are no longer in `C:/dev/proj-a/.omo/senpi-task` (pruned; only unrelated tasks remain), so churn is proven on the parent through the review-loop rule (c), not through child edits.
- The clock starts at 04:44:10Z, right after the fourth verification spawn; the session history before it is applied on the first tick. Before the age-based autonomy rule was dropped (issue 28) the same turn also met it from 04:43:49Z (40 calls over 90 min), and the window had to start where both held; the session has no todo transitions, so churn through the review-loop fallback is the only D15 signal it meets now.

Expected (plan todo 24, reviewer r1 B1): D15 `drift/churn` for 01a09716 on the first tick. No process action. Mutation (reviewer r2 B3): `align.failRepeats` and `align.reviewLoops` at 1000 in the replay config -> the churn finding disappears.
