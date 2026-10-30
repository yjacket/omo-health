# F10: browser relaunch loop inside one bash call, D17 off (#52 stall 1, st_01a0ed19, 12:25-12:46Z)

Rebuilt from issue #52 and #55 (the session files were not kept): ids are the real ones, paths, pids and byte counts are placeholders.
- Child transcript: the W5 node `t11-qa` issues `cd C:/dev/qa/t11 && node driver.mjs` at 12:25:08.300Z; the call never returns in the window (in reality it was killed by hand at about 12:46Z).
- `procs.ndjson` (every 20 s): host 41236 (senpi cli.js), the call's bash 70000 and `node driver.mjs` 70010. The driver relaunches Chrome about twice a second (omowright `connectPipe`, Chrome 154 exits after ~100 ms), so a snapshot catches a live `chrome.exe` only in every 5th snapshot, each with a new pid. The driver uses 15 % CPU and writes 12 KB per snapshot into the CDP pipe.
- `meta.config` turns D17 off, and the 20 % presence is below D17's 60 %, so neither D17 nor D1's `respawn-loop` class sees the storm (#55: "D17 없이").

Expected: the call reads as `progressing` (it writes), which used to hold it for 60 min. There is no recheck any more: no model is asked at call + 10 min, no notice goes to the parent and nothing is killed or investigated inside the window. Only the class maximum (R10x at 60 min, outside the window) would open an investigation.
