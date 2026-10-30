import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after } from "node:test";

const EVENTS = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];
const counts = () => EVENTS.map((event) => process.listenerCount(event));

/** Stand-in for `process` in runDaemon({ proc }): a daemon test must not leave its handlers on the real test process. */
export const fakeProc = () => new EventEmitter();

/** Call once at the top of a test file that runs the daemon: fails the file if any test left listeners on the real process. */
export function guardProcessListeners() {
	// node:test attaches its own uncaughtException/unhandledRejection handlers on first use: register the hook first, then measure.
	let before;
	after(() => assert.deepEqual(counts(), before, "runDaemon left listeners on the real process; pass proc: fakeProc()"));
	before = counts();
}
