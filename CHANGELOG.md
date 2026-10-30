# Changelog

## Unreleased

## 0.8.0 - 2026-10-20
- D21 takes over the goal backstop's liveness check while omo-keepalive holds it: an idle goal session is woken once when a wake source is provably finished (`leaked-monitor`, `leaked-task`, `leaked-workflow`, 120 s grace) or silent for `goalLiveness.livenessMs` under the hold. `goalLiveness.enabled` is a dashboard switch.
- D21 wakes only on evidence: an unfolded workflow (node task ended, run not updated) or a stalled one (nothing runnable) after `foldGraceMs`, naming run, node and task; a monitor or background session idle for `quietMs` (`goal-wait-idle`) asks the analyst first and wakes at the latest after `idleWakeHoldMs`; `silent` is deferred while live work progressed within `quietMs`. The wake lists its evidence (a finished source by its task, run or monitor id and process) and the analyst's mechanism and avoid. A persistent monitor is idle by design and keeps only the hourly check; an unreadable task store proves no progress.
- Subagent tasks and workflow runs are read from the store senpi uses (`<cwd>/.omo/senpi-task` while it holds records, else `<agentDir>/projects/<name>-<sha12>/senpi-task`) for child discovery, the session-history backfill (marker v2, runs once more) and D18. D8 ignores host-gone and error records older than `sessions.recentMs`; D5 counts only turns of the last hour and skips subagents whose host is gone.
- D15: child completions, monitor notifications and DAG progress reset the stuck window; loops of the review agents (plan-reviewer, plan-consultant, omo-native-code-reviewer, omo-native-gate-reviewer) and host-gone children are exempt; the analyst is asked first (`align.requireVerdict`) and its answer travels with the message; the nudge budget is spent only on delivery, an undelivered one retries after 5 min; the message quotes the latest human request with its age.
- D15 overstep reads per sentence: an imperative, an action word or a suggestion makes a question a request; one overstep per request.
- D23: after a downtime of `bootGap.minGapMs` (recorded in `boot-gaps/`) a returning main session gets one notice about the subagents and workflow runs the gap cut off. An idle exit is not a downtime.
- The footer shows a session parked on live work as `👀 DAG3/5` or `👀 대기N`; the board state is `작업 대기`. D16, D17 and D22 stay off the footer.
- D4 keeps a burn spike open for `tokens.burnHoldMs` (10 min) instead of resolving and reopening every tick.
- Analyst bundles carry the subject's recent eval-cell logs (`evalLogs.*`, redacted), the finding's question, live work and the alignment ledger. D15/D21 why verdicts are never reused across sessions.
- D17 (respawn) and D23 are registered in `loadDetectors`; reflection orphans have their own id D22. D17 kills only a respawner an omo session spawned; one no session owns (a browser the user runs) is reported in status only.
- The sensor heartbeat mirrors senpi's goal-wait bus channels (`wakeSources`, `holds`, `goalWait`, `goalLivenessSchema: 1`), which D21 and the waiting footer read; open sessions pick it up after a restart.

## 0.7.0 - 2026-10-17
- Installs as an omo package: `omo install git:github.com/yjacket/omo-health`. The package entry (`extension/entry.ts`) loads the sensor, and the sensor sets everything up on its own (pinned release of the package commit, `current.json` channel `package`, boot, launcher, HKCU Run value, daemon). Setup runs once per commit under an exclusive `app/setup.lock`, however many sessions start at once.
- `omo update --extensions` is picked up within a minute: the new commit is pinned, the daemon is replaced and idle sessions reload onto the new sensor.
- Moving from `install`: the package takes over the pinned install, deletes the old sensor stub and reloads idle sessions; the sensor never loads twice.
- `/health uninstall [--purge]` and `/health install` from inside omo. A package purge keeps the `stopped` marker so the package does not set itself up again.
- The daemon removes its autostart and stops (`exitReason: "package-removed"`) when the package folder has been gone for 20 minutes.
- Sensor reloads use `ctx.requestReload`; the old `ctx.reload` call never fired from event handlers, so upgrades only reached sessions through senpi's file watch.
- While `stopped` exists the sensor writes nothing under `~/.omo-health`.
- `doctor` understands the `package` channel. Test seams: `OMO_HEALTH_RUN_VALUE` (Run value name) and `OMO_HEALTH_ORPHAN_GRACE_MS`.

## 0.6.1 - 2026-10-16
- Machine-wide info findings (e.g. D2 `machine-commit`) no longer reach any footer; they stay in `/health` and the dashboard (`footer.showAll` still shows them).
- The observation footer reads `👀 관찰N` (no space).

## 0.6.0 - 2026-10-16
- Every yellow footer problem without a known cause gets one analyst look: D1 stalls, D8 `dead-child`, `child-error-unhandled` and `hung-main-turn`, D5 `hung-turn-child` and single-session `tps-collapse`, D10 `same-call-loop` and `error-storm`, D2 `process-runaway`. A child released by a concrete-evidence rule (R5, R5b, R6, R7, R8, R9) gets one look afterwards. These investigations use the trigger `why` (`원인 조사` in the dashboard).
- The analyst answer has two more required fields, `mechanism` (what the command or program actually did and why that blocks) and `avoid` (what to do instead). A `stuck` or `unrecoverable` answer without them, or with either shorter than 20 characters, is bad output.
- After an answered, non-normal verdict the supervising session (the parent of a child, the main session itself, or the host session of a D2 process) gets exactly one message with what happened, the cause, the mechanism and the avoid text. Child releases are no longer silent. Advice never says to rerun the same command unchanged.
- No analyst run for obvious causes: usage limits, quota, rate limits (429), blocked or revoked accounts, unconfigured providers, provider slowness across 2+ sessions, and D8 `stopped-on-errors`.
- A why verdict answered for the same triage signature within 24 h is reused without a new run. Analyst budget defaults are now 8 per hour and 40 per day.
- While a session's top footer problem is under investigation the footer reads `👀 조사중` in the problem's level color. The dashboard investigation detail shows mechanism (원리) and avoid (회피).

## 0.5.5 - 2026-10-16
- The footer mark is `👀`; with no problem it reads `👀 정상`, or `👀 관찰 N` while N footer findings are only observations (info).

## 0.5.4 - 2026-10-15
- An extension reload (senpi reloads on its own, e.g. on config changes) no longer counts as operator input: the sensor hands `lastInputAt` and `humanInputs` to its successor in the same host process, so the session board's last input stays at the last real input.
- The footer is `🩺` plus one word for the problem type (e.g. `🩺 멈춤`, `🩺 로그인`, `🩺 중지`), colored by level with the host theme (red crit, yellow warn, green ok, dim stopped); the level symbol and the finding title are gone from it. Details stay in the dashboard and `/health widget`.

## 0.5.3 - 2026-10-08
- D20 `park-resume`: a session that omo-limitless shut down at a usage limit is relaunched with `omo --session <id>` in its own terminal (Orca through `orca terminal create`, herdr through the D18 new-tab path) once the limit resets (`resetAt` + 60 s). Records in `~/.omo-health/parks/` move `pending` -> `claimed` -> `launched` -> `completed` (ack file or live heartbeat); `failed` after 3 attempts, a hung start or no launcher (one toast each). Gated by `actions.resume` and the D18 hourly cap.
- The daemon does not idle-exit while a park record is unfinished, D18 leaves parked sessions alone, finished records are deleted after 7 days, and truncated record files are reported as `park-invalid`.
- `daemon.json` carries `capabilities: ["park-resume"]`, so omo-limitless parks a session only when the running daemon can take it up.

## 0.5.2 - 2026-10-08
- After a new install, each session's sensor asks senpi to reload its extensions once the session is idle, so open sessions move to the new sensor without user action (senpi's own watch on the stub does not always fire). At most three requests per installed root, ten minutes apart.

## 0.5.1 - 2026-10-08
- The dashboard has three tabs: Sessions (live sessions and subagents), History (ended sessions from `sessions/ended-*.jsonl`) and Admin (the old page). Plain `/health` opens it; `/health widget` shows the old in-session summary. New files `status/_sessions.json` and `sessions/ended-*.jsonl` (`src/session-board.mjs`, `src/session-ledger.mjs`, `src/session-backfill.mjs`).
- Retention (`src/retention.mjs`): alignment, status, receipt files and empty inbox folders older than 7 days are removed automatically. Decisions, reports and snapshots are kept.
- Removed: the ambient workaround alert, the host Claude login expiry alert and the deferral-storm rule.

## 0.5.0 - 2026-10-07
- `install` installs a pinned copy of HEAD (`git archive HEAD` into `app/releases/<version>-<shortsha>`, `current.json` channel `pinned`) and refuses while a tracked file is uncommitted. Boot only starts the daemon and rewrites the sensor stub. The install removes the legacy `care/`, `app/repo.git` and unused releases, moving death records to `deaths/` and the report queue to `intake/`; `lkg/` stays.
- Removed: the self-care pipeline (care tick, issues, fixer/reviewer jobs, approvals, `care` and `/health approve|reject`), self-update with staging and rollback, rule distillation, the tier-1 `claude` judge and tier 2. The `care`, `update` and `judge` config keys are gone.
- Stall suspicions (R10x past 60 min, R11, the quiet hang) open an investigation (`investigations/<fp>.json`) and are never released on the clock. The analyst, a tool-less `omo -p` run on the first logged-in model of omo's `deep-low` lane with the redacted bundle attached as `@bundle.md`, decides: `stuck` releases, `unrecoverable` or a second `stuck` within 30 min sends the parent one `relay-cancel`, `progressing` looks again. Budgets: 5 min a run, 1 at a time, 2 per finding, 4 an hour, 20 a day, reports 3 a day. A failed, held-off or out-of-budget analyst acts on nothing and retries after 15 min; an investigation unresolved for 1 h raises one toast. New keys `analyst.*`, env `OMO_HEALTH_OMO`.
- Every process action on a child is quiet (recorded, not sent to the parent). A main session's call is released only when the analyst proves a wrong command with confidence >= `analyst.actConfidence` and quoted evidence, followed by one message; anything else is one notice. User idleness plays no part.
- A sqlite history store (`omo-health.db`) records finished tool calls, lineages and baseline samples (90-day retention). General anomaly signals (D19: unseen lineage, duration outlier, visible window, System32 `bash.exe`) open investigations after a 200-completion cold start and never release on their own. New keys `history.*`, `anomaly.*`.
- The dashboard shows the investigation list instead of the care tabs.
- D16 monitor-orphan notices carry a UTC/KST timestamp, tell the owner not to re-register persistent monitors, and are withdrawn when undelivered for 30 min or when senpi restored the monitors (#102).
- D15 anchors its scope checks on the latest human request.
- Daemon death records live in `deaths/`, are pruned after `history.retentionDays`, and `status --json` reports `deaths`.

## 0.4.2 - 2026-09-30
- D8 no longer reports a subagent as dead while senpi is plausibly waiting to retry: a child whose last record is a usage-limit, quota or rate-limit error gets 35 min (senpi's 30-min usage-limit cooldown plus margin), a stated `Soonest automatic retry` time stretches that up to 2 h, and a task whose record was just rewritten to running (a revive) is not judged for 5 min. Other errors are still reported at 30 min. New keys `orphans.retryWaitMs`, `orphans.retryWaitMaxMs`, `orphans.reviveGraceMs` (#93, #82).
- An orphaned task whose parent resumed on a host with an unknown start time no longer counts as an upstream suspect: the 5-min resume grace needs a known host start (#92).
- Release staging reruns the failing test files once (the whole suite once when a failure is reported outside the suite, e.g. from a helper module) before marking a release bad, and records the retry in `staged.json`. The boot unclean-exit tests use an injected PowerShell (`OMO_HEALTH_POWERSHELL`) instead of waiting on real PowerShell start-up (#90).
- The per-call respawn-loop rule (R5b) applies D17's guards (fresh process table, no history replay); a kill-respawner owner notice that throws is retried up to 5 times, 30 s apart, without repeating the kill; an R11 finding waiting for its no-judge release after the judge budget is spent reads `판정 예산 소진 — 자동 해제 대기` in `omo-health status` instead of `escalated`; D15 sees the todo the todo tool promotes on `done` (#82).
- `omo-health diagnose` uses the daemon's restall record (the 5-min quiet limit after a recent stall), which the daemon now keeps in `state.json` across restarts. The hourly report cap can no longer reopen past the 500-file retention of `care/intake/processed/` (only records the cap counts are protected within the hour), evidence snapshots are deduped across daemon restarts and pruned at start and every 10 min, and text is redacted before it is cut wherever it is stored (evidence snapshots, decision log, stall titles and command heads, collector heads, reports, including `/health report` text queued by the sensor). A keepwarm `v: 1` snapshot without a numeric `staleAfter` reads stale 10 min after its `ts` (#82).
- An upstream report body or title scrubs home and cwd paths longest first, so a home under a cwd (e.g. `C:\Users`) no longer leaves the user name behind, and a root cwd (`/`) no longer garbles the text (#101).

## 0.4.1 - 2026-09-30
- count only orphaned tasks left after a parent resume as upstream (#92)

## 0.4.0 - 2026-09-30
- A subagent tool call that shows no sign of life (no transcript event, no output) for 15 min is now treated as stalled whatever its rule class (R12): the parent is told the command, elapsed time and live processes, and the shell is released 5 min later. Bounded and progressing calls are re-judged at 10 and 30 min instead of being left alone for up to an hour, and the parent hears about one only when the judge itself escalates. R10x and unknown stalls release on time when the judge is off, failing or out of budget, and a task that stalled within the hour is watched closer. Reload starvation (D11) is tracked per task, a cancelled task never reopens it, and a stuck blocker wakes the parent (#52, #55).
- A result that a running sibling of the same parallel batch withholds is no longer reported as a stall: an in-process call (`write`) or an unmatched shell call next to a pending `bash`/`task` is classified `withheld` with no action, so `relay-cancel` no longer targets healthy subagents. A command that ends within its first minute reads as `exited`, an unmatched call is relayed only after its explicit bound plus grace, and calls a previous host left without a result are dropped on a `resume` scan entry or when they predate their host process (#39, #40, #41, #42).
- `omo-health diagnose <task|session>` tells, without a model and within seconds, what a subagent waits on, whether it still moves, and a verdict with advice (wait, release the shell, cancel); the dashboard shows the same under "작업 진단". `omo-health report` and `/health report` file a problem report that joins the incident of the same subject's detection (duplicates within an hour are dropped, at most 10 an hour), and a report or a subagent finding takes an evidence snapshot (process lineage, pending calls, recent events, output sizes) (#60).
- Judge CLI failures log the error code, errno, syscall and resolved `claude` path, `claude` is re-resolved on every call so a moved or reinstalled CLI recovers without a daemon restart, and 3 judge failures in a row raise a D12 `judge-failing` finding while unclassified stalls use the deterministic path until a probe succeeds (#26, #55).
- Killing a background respawn storm an agent session started no longer fails while building the owner notice (`composeRespawnNotice is not defined`), and turning `respawn.enabled` off also stops the per-call `respawn-loop` classification (#75).
- D15 scope checks no longer fire on session age or tool-call count, so sessions resumed after a usage-limit wait and long goals that keep finishing todos are left alone (#28). The collector keeps a per-session step ledger (eval summaries, subagent summaries, goal text, todo start/done/reopen) and D15 nudges only on non-convergence evidence read from it: one todo cycling fix/rerun/review, no todo finished across many steps, a reopened todo, or repeating summaries. Idle gaps do not count as active time, the nudge names the evidence, and the budget is kept per delivery target so children of one parent share the parent's (#29). `align.autonomousMs` / `autonomousCalls` are replaced by `idleGapMs`, `stuckSteps`, `stuckActiveMs`, `noDoneSteps`, `repeatSteps`.
- Info-level unknown omo log events no longer file a D12 incident or count as drift (still listed in `status --json` as `quiet`), and `compaction_queue_enqueue`, `claude_sdk_oauth_checkpoint_recovered`, `claude_sdk_oauth_restored_transcript_orphan_tail`, `resume_context_reduced` and `session_title_failed` are known events (#8).
- The care gate and the update switch wait for the operator, not for agents: "idle" means no operator input for `care.idleMs` (15 min), so sessions busy with agent work, goal continuations or subagents no longer hold care jobs and switches back for hours. A switch still needs zero running subagents, and a switch that would rewrite the sensor stub (and so reload every session) also waits until every session is agent-idle, because the host defers reloads only for subagents. The sensor adds `lastInputAt` to its heartbeat; older heartbeats keep the previous rule (#30).
- A regression rollback waits under the same switch rule and `care status` shows it as pending with the reason; rollbacks for a release that cannot run stay immediate (#32).
- Pruning keeps the release the installed sensor stub names as its fallback root, so staging a new release no longer deletes it and the next switch does not rewrite an unchanged stub (#31).
- A care job past its timeout whose process-identity lookup keeps failing (5 in a row) ends as `timeout`/`unverified` without a kill, so it can no longer hold the one-job slot and the daemon's idle exit (#33).
- A fixer round that produces a new diff resets the no-progress count, and a deferral clears it, so an issue is deferred as "no-progress" only after two consecutive rounds without progress (#35).
- `/health approve|reject` and `care approve|reject` answer an approval once, like the dashboard: a second answer is refused and the first decision stays (#56). The care tick prunes decided and superseded approvals with their decision files 30 days after their last change, keeping pending approvals and the decision log (#36).
- `/health ui` no longer puts the dashboard token into the notify text when the browser was opened: `ui --json` reports `opened`, and the sensor shows the tokenised URL only when the browser could not be opened (#57). `omo-health ui` and `/health ui` open the browser for users who set `OMO_HEALTH_CONFIG`: only `OMO_HEALTH_HOME`, `OMO_HEALTH_OMO_HOME`, `OMO_HEALTH_CLAUDE_HOME` and `NODE_TEST_CONTEXT` count as a sandbox (#58).
- `status` and `/health` show a read-only omo-keepwarm status line (`keepwarm: unknown` when the snapshot is stale or unreadable, hidden when missing); it never goes into the footer (#61).
- A rejected extra config (`--config` / `OMO_HEALTH_CONFIG`) no longer stops a valid `config.json` from being kept as `config.last-good.json`; `runDaemon` attaches its signal and error handlers to an injectable process object (tests leave nothing on the real process); the dashboard history moved to `src/ui/history.mjs` (#59). Every test file loads the temp-root helper itself, so a direct `node --test test/<file>.test.mjs` run leaves no temp dirs behind (#37).
- Ambiguous stall findings get a second, stronger model look (tier 2: sonnet, read-only on omo-health's snapshots and omo's logs, 5 min, 10 a day) whose diagnosis and advice reach the owning session, and problem reports are answered the same way from a budget of their own. An irreversible action needs a rule with an action of its own, a confident tier-2 abnormal (>= 0.8) or both tiers agreeing; an unknown-cause call's "ask the judge" never vouches for a kill. A judge call whose CLI never started no longer uses up the budget and is retried (#55, #60).
- Baseline-deviation signals (process births, CPU, memory and writes per tool call against this machine's usual values, machine temp-file growth) bring a tier-1 look forward from their own small budget and never act on their own; deviating samples never enter the shared baseline. Verdicts are cached per pattern signature for 30 min (waits for anyone, escalations per owner, never a kill). D17's respawner kill asks tier 1 first and still ends every subagent's relaunch loop within `respawn.maxHoldMs` (30 min) (#55).
- When one pattern gets the same model conclusion 5 times in 7 days, omo-health files a rule proposal (`distill: <signature> -> <conclusion>`, label `care:distill`) through the care pipeline, at most 2 a day inside the issue cap; any PR for it waits for `/health approve` whatever files it touches, and a proposal the operator closed stays closed unless the conclusion changes. A pattern judged normal that often no longer asks for early looks (`judge.distill.quietNormal`). `status --json`, `care status` and the dashboard list the candidates (#55).
- senpi's circuit-breaker events `circuit_opened` and `circuit_open_skip` in fallback.log are known events (#85).
- extension/ changed (#64, #66, #71, #74, #77), so installing this release reloads open sessions once.

## 0.3.2 - 2026-09-29
- An omo host that dies without a clean shutdown (a Bun segfault killed two mass-ulw sessions on 2026-09-29) is now recorded (D18) and, when it had unfinished work, reopened (#46). A crash is a leftover sensor heartbeat whose pid is gone, plus proof that the heartbeat stopped with the host: the daemon saw it fresh while the host lived, or senpi's live marker / crash record was last touched right before it. A heartbeat of a session the operator switched away from is only recorded. Only a crash found within 10 minutes of its last heartbeat is a resume candidate; older leftovers (39 sat in the sensors folder on 2026-09-29) are cleaned quietly in one batch. A session is reopened only when it was mid-turn or had an active goal / ulw loop; open todos (`senpi.todo-state`), subagents or workflow runs alone are recorded (a goal-achieved idle session segfaulted on exit the same day). A session someone already carries on in the same cwd (another live heartbeat there, or another session file there written after the crash) is not reopened.
- Recovery never types into an existing pane: omo-health checks that the crashed herdr pane still exists, sits at an idle shell and has the session's cwd, opens a new tab in the same workspace with that cwd, verifies its fresh shell and runs `omo --session <id>` there. Once the new sensor is up, the session gets one bilingual note (crashed, in-process subagents lost, check the worktree) without starting a turn: `nextTurn` when idle, `steer` when its goal already runs again. At most 2 resumes per session per hour; 2 crashes within 30 minutes, no controllable terminal, a refused pane or no new sensor within 3 minutes stop recovery with one human-needed toast naming the session and cwd (`crashResume`, `actions.resume`). Leftover heartbeats are removed after the outcome is recorded; ones older than 10 minutes are cleaned in one batch.
- The sensor adds the herdr pane identity (`terminal`) to its heartbeat. extension/ changed, so installing this release reloads open sessions once.

## 0.3.1 - 2026-09-29
- New detector D17 (respawn storm): a program that keeps dying and being relaunched within seconds (a crash/retry loop, e.g. a browser driver stuck relaunching a browser) is now caught from process snapshots: the same program shows up in nearly every snapshot and almost none survives to the next. Inside a pending tool call it classifies the call as `respawn-loop` and the stall ladder ends it (release-shell, then relay-cancel); a storm an omo agent spawned in the background is killed after `respawn.killAfterMs` and the owning session is notified; storms owned by anything else are reported in `status --json` only. Calls that looked busy only because each dying child wrote a little used to sit as "progressing" for up to an hour.

## 0.3.0 - 2026-09-29
- A local dashboard. `/health ui` in an omo session, or `omo-health ui` in a terminal, opens a Korean page in the default browser and returns at once. The page shows:
  - now: supervisor state, pause, mode, counts, human-needed items;
  - pending approvals;
  - 7 days of history, with repeats grouped into one row with counts and daily spread;
  - self-care;
  - settings.
- From the page you can pause (15 min, 1 h, until resumed), resume, approve or reject, and turn 10 switches on or off: `mode`, `actions.kill/detach/release`, `monitorOrphans.enabled`, `config.autoRevert`, `align.enabled`, `judge.enabled`, `care.enabled`, `footer.showAll`. It writes the same files as the CLI.
- The server runs on 127.0.0.1 only, with a new token for each launch. It exits after 30 minutes without a request (auto-refresh does not count) and nothing points at it: no toast, badge or footer text.
- The supervisor re-reads `config.json` when it changes and applies it at the next tick (about 15 s) without a restart. `daemon.json` reports which values are in effect and why a value is overridden (`--shadow`, `--config`, a self-care mitigation). Every applied or rejected change goes to the decision log.
- A broken `config.json` no longer silently falls back to the defaults:
  - while running, the previous settings stay;
  - on a restart, the last good copy (`config.last-good.json`) is used.
- `/health approve|reject` now words detection-merge approvals correctly: approve merges, tags and releases; reject closes the PR and defers the issue (#34).
- On the dashboard an approval can be decided only once; a second answer gets 409 (`/health approve|reject` and `care approve|reject` behave as before).
- Windows integrity: the daemon now acts on elevated sessions. The process worker falls back to `NtQueryInformationProcess` for the command line a non-elevated WMI read cannot see, reports every process's integrity level, and a daemon running below a live senpi host hands over: it exits and a sensor respawns it at the sensor's own integrity (at most once per 30 minutes, never mid care job). Without it, a non-elevated daemon found no D16 members and its kills were denied "Access is denied".
- A monitor's entry gone from the manifest no longer saves its leftovers: D16 remembers command-monitor entries (200 max, 30 days) and keeps reaping them. `kill-orphan-watchers` decisions now record their `name:pid` targets. An orphan notice that could not reach its owner for 30 days, or whose owner session file is gone, expires quietly instead of waiting for a toast.
- A timed-out omo memory-reflection run leaves its `node`/`bun` children alive (one busy `bun` at ~100% of a core for a day and more). These are now reaped after a 10-minute grace (`reflectionOrphans`, default on). A process counts only when its command line is a headless reflection child (`senpi dist/bundle/cli.js -p ...`) naming a run dir under `<omo>/memory/agents/*/runtime/reflection/runs/reflection-run-*` whose `final.json` already holds a terminal outcome, and the process was created before that finish time; a newer attempt or a pid reused by anything else is never touched. Identity (pid, creation time, command) is re-verified right before the kill. Info severity: no footer, no toast, no message - only a decisions-log entry.

## 0.2.18 - 2026-09-29
- A senpi command monitor leaves its inner shell and pipeline processes (`tail -F`, `grep`, ...) running when it ends, and when its session closes; six QA monitors kept 29 processes alive for about 20 hours. These are now killed after a 60 s grace (`monitorOrphans`). A watcher counts as orphaned only by process facts: its launcher shell is gone, or the launcher's parent (the senpi host) is gone. A missing sensor heartbeat never marks a live monitor as orphaned. Identity (pid, creation time, command) is checked again right before the kill.
- An owner that was not running gets one quiet, bilingual note on its next turn after it comes back (`nextTurn`, never starting a turn); it waits in the inbox instead of turning into a toast. A running owner gets no note: senpi already told it the monitor ended.

## 0.2.17 - 2026-09-29
- A detection-change approval covers only the diff it was shown: its id names the branch head, so a later round asks the operator again instead of reusing the old approve or reject (F2 re-review N1).
- A staged release is not switched in by a restart, crash respawn or CLI start while subagents run; only the care tick's update request (made with no subagent running) or a cold start switches it (N2).
- Moving a detector out of src/detect/ still needs the operator's approval (N3).
- The pipeline's npm test runs of agent-written code get the agent's credential isolation (N4).

## 0.2.16 - 2026-09-29
- A finished subagent gets no scope check: the note would only ask the parent to forward it and revive a completed task.

## 0.2.15 - 2026-09-29
The footer and release switches put subagent work first:
- The footer shows only subagent problems: stalls, hangs, dead or failing children, runaway processes and loops (D1, D2, D5, D8, D10), plus what only the operator can fix. Token spikes (D4), config reloads (D11), omo-health's self-checks (D12), writes outside the workspace (D14), scope checks (D15) and update notices appear only in `/health` and `status --json`. `"footer": { "showAll": true }` in config.json shows everything again.
- A release switch waits until no subagent is running and the operator is idle; the daemon counts running subagents of live hosts.
- A reload that a switch caused (it rewrote the sensor stub) stays self-caused until omo logs reload_completed. A reload that a live subagent holds back is by design: it shows in status and is never filed.

Self-care, simpler and safer (rest of the independent code review):
- Nothing is merged without passing CI; a fix that touches detection (src/detect/, src/config.mjs) waits for the operator's `/health approve|reject <id>`, announced with one toast.
- A fixer that returns no changes, or the same diff again, twice for one issue stops at once and the issue is deferred ("no-progress").
- A fix round whose push or PR failed resumes at publishing instead of throwing the finished fix away.
- A transient staging error (timeout, extract, rename) no longer blacklists a release; staging tests run with their temp dirs inside the staging sandbox.
- Care agents run without the operator's GitHub and git credentials.
- A post-switch regression rolls back only for a defect first seen within a day of the switch.
- Versions claimed by in-flight fixes are not reused, an existing GitHub release counts as done, and the most advanced item ships first.
- Review verdicts and upstream filings are saved before commenting, so a failed comment never repeats a review or files a second public issue; titles are redacted.
- A care job's pid lookup that fails keeps the job running without a kill; a job from an older version is never killed unverified.
- An unreadable care tick lock is taken over after its stale age, and a care observation error no longer stops the care tick.
- Fixer and reviewer failure counts reset at deferral, the upstream investigator honours the usage-limit wait, and fix summaries no longer split at "incl.", "e.g." and similar.

## 0.2.14 - 2026-09-29
From an independent code review of the self-care pipeline:
- A care job's process is re-identified (creation time and command line) before it is trusted as running or killed at its timeout; a reused pid, after a reboot for example, is never killed.
- An issue without an incident file, such as a Workaround issue, is deferred after its rounds instead of being retried every tick.
- A fix that still fails the tests after it is replayed on a newer main goes back to the fixer instead of re-running the suite every minute. A failed cherry-pick abort still restores the branch.
- A usage limit or a logged-out CLI makes the fixer and reviewer wait; it no longer counts as a failed round that could defer an issue or switch off a detector.
- Boot's post-update health check allows a slow first tick (up to the judge timeout) before it abandons a release, and marks the start healthy when it passes.
- The hung-daemon takeover no longer kills a daemon that is inside a long tick, such as the first one after resuming from sleep; each tick stamps its start in daemon.json.
- The care clone's checkout follows origin/main, so the fixer's baseline test count is current.
- Staging runs its test suite with the per-process temp root, so it leaves nothing in %TEMP%.

## 0.2.13 - 2026-09-28
- A deliberate stop (`stop`, install, uninstall) marks the start it ends as ended in app/boot-state.json. Before, a stop within a minute of a start counted as a failed start, so three quick start/stop cycles could mark the only good version bad and halt the supervisor.

## 0.2.12 - 2026-09-28
- `doctor` accepts a sensor stub from an older release while it loads the same sensor files; since 0.2.7 an update keeps such a stub on purpose, and doctor reported it as FAIL.

## 0.2.11 - 2026-09-28
- Every `npm test` process gets its own temp root and removes it on exit; about 26,000 leftover omoh-* folders had piled up in %TEMP%. (Correction: staging ran the files directly and still leaked; fixed in 0.2.14 and 0.2.15.)

## 0.2.10 - 2026-09-28
- derive d11 blockerStuck from d8's dead-child predicate incl (#14)

## 0.2.9 - 2026-09-28
- recognize the new omo session.log todo events (#8)

## 0.2.8 - 2026-09-28
- Scope checks see failing checks that omo agents run inside eval cells: the cell summary names the check, and an exit code in the result (`{"exit":1}`, a spawnSync status, "exited with code 1", `ℹ fail 2`) counts as a failure. Before, a check that failed nine times in a row through eval left churn detection blind.

## 0.2.7 - 2026-09-28
- An update rewrites the sensor stub only when the sensor files change. Every rewrite hot-reloads the extensions of all open omo sessions: an in-flight tool call fails, and a Bun session on Windows panicked right after such a reload. New sessions still load the sensor of the current release.
- Pruning keeps every release whose sensor a live session still runs, so an old sensor never loses its launcher.

## 0.2.6 - 2026-09-28
- The boot crash-loop guard judges each start by its own outcome (a minute of heartbeats from its process, or a clean return such as "already running" or a CLI stop). Before, it judged every recent start by whoever held daemon.json, so a stale holder could get a healthy version marked bad and halt the supervisor.
- A session whose detector throws only for it is quarantined and filed at once as a detector-exception incident; before, the quarantine reset the three-tick count and nobody was told.
- Failed staging tests, rollbacks and failed health checks become eligible incidents immediately, so they are filed; before, they waited for a 30-minute persistence window a one-time event never fills.
- An `OMO_HEALTH_GH` override ending in .js/.mjs runs under node, as in boot.

## 0.2.5 - 2026-09-28
- A fix round after changes requested or a failed CI run continues the open PR's branch and comments on the PR; before, it started over from main, tried to open a second PR, and the failure restarted the fixer in a loop.
- Deferring a fix closes its PR by number (a PR stored as an object made the close fail) and the next attempt opens a new PR.
- A PR that conflicts with a newer release is replayed on current main and released again under the next free version; a fix that itself conflicts goes back to the fixer, which starts over from main. Before, the rebase stopped on CHANGELOG and version conflicts for good.
- Release entries written by the pipeline keep a blank line before the next version heading.
- Scope checks no longer read omo-health's own notes (for example a stall correction a parent forwards) or shell syntax in code spans such as `$?` as an information request.

## 0.2.4 - 2026-09-28
- An issue whose fix start failed after it was labelled care:in-progress is retried; before, the leftover label hid it from the fixer for good. The pipeline's own state now decides which tracked issues need a fixer.

## 0.2.3 - 2026-09-28
- A fixer's summary is shortened into a one-line lowercase commit subject instead of rejecting an otherwise valid fix ("invalid fixer result"); the fixer prompt now states the format.
- A fix retried after a deferral starts again; before, the deleted worktree's leftover registration made every retry fail ("cannot force update the branch").
- Scope-check nudges quote the latest user turn that has text; before, a tool-result turn left "Latest user request" empty.

## 0.2.2 - 2026-09-28
- A leftover care tick lock (dead holder or older than 15 min) no longer stops the daemon from running the care tick; before, one crashed tick left the self-care pipeline silently dead.
- `doctor` warns when a running daemon's care tick has not completed for 20 minutes.

## 0.2.1 - 2026-09-28
- Release archives keep test fixtures: `.omo` is export-ignored only at the repository root, so staging tests pass (0.2.0 could not stage).
- Failed staging, health checks and rollbacks are filed as care:regression issues (they were recorded with a kind the reporter never picked up).
- `install` never falls back to a release older than the bootstrap and leaves the previous pointer untouched when it cannot install.

## 0.2.0 - 2026-09-28
- Well-formed omo log events that omo-health does not know yet are reported as information instead of degraded monitoring; only unparseable lines mark it degraded (D12).
- The degraded flag and unknown-event notices never mask a real problem in the status line.
- `doctor` reports non-fatal gaps as WARN instead of failing.
- Reopened findings are logged in the decision log.
- Self-care pipeline: incidents become issues, fixes, reviews, CI, merges and releases, with daily caps, a 15-minute user-idle gate, and dead-end mitigation with backoff retries (`omo-health care ...`).
- Verified auto-update: staging tests, a bootstrap at `~/.omo-health/app/boot.mjs`, a 3-minute health check, 30-minute probation, crash-loop rollback and a one-time update notice. `install` now installs the latest release; `install --dev` runs the checkout.
- Daemon death detection: hung and unclean exits are recorded and deliberate stops are not counted.
- Records and nudge history persist in `state.json`, so a daemon restart re-sends no wake or notice.
- D15 goal-alignment nudges (churn, overstep, autonomy, after-complete), rate limited and never triggering or aborting a turn.
- Goal ledger per session in `~/.omo-health/alignment/`, shown in `/health` and `status --json`.

## 0.1.0 - 2026-09-25
- Autocontinue supervisor and third-party anomaly monitoring (#3).
