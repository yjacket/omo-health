import { endedKey } from "../../src/session-ledger.mjs";
import { sha1 } from "../../src/util/text.mjs";

// Calculate the expected selector without relying on the implementation under test.
export const expectedSelector = (row) => sha1(JSON.stringify([endedKey(row), row.endedMs])).slice(0, 16);
