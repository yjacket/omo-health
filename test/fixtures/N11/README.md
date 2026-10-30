# N11: a session resumed after a usage-limit pause, todos advancing (synthetic)

Synthetic, built with `test/helpers/fixtures.mjs` builders; no real session content.

One user request at 09:00Z, five todos finished by 10:12Z, then nothing for about three hours (usage limit), then three more todos finished from 13:00Z. The old autonomy rule (90 min since the last request plus 40 tool calls) nudged it at 13:00Z although every todo was advancing.

Expected (issue #28): no D15 finding and no scope-check message.
