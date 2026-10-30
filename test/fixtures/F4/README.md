# F4: 401 revoked -> all Claude accounts blocked (2026-09-23 10:23:30-10:27:00Z)

Sources (redacted, see F1):
- `logs/session.log` lines 22782-22843 (62 records): close other 10:23:41.851Z -> flatten query_failed .856Z -> 401 revoked .857Z -> first "blocked" .912Z, then usage-limit fallbacks.
- `logs/fallback.log` lines 1183-1356 (174 records): the fallback chain ending in chatgpt-subscription usage limits.

Expected (design 1.1 F4, 9.1): D6 accounts-blocked, crit, humanNeeded, first seen within 15 s of 10:23:41.912Z, with a toast. No process or settings action.
