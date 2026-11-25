import { parentPort, workerData } from "node:worker_threads";

const { buffer, mode, stateUrl, token, expectedNow, timeout } = workerData;
const gate = new Int32Array(buffer);

if (mode === "state-client") {
	// An independent client can initiate the request even when the old dashboard
	// executes the load in the same thread as the test and HTTP listeners.
	if (Atomics.wait(gate, 0, 0, timeout) === "timed-out") throw new Error("load never entered its gate");
	const response = await fetch(stateUrl, { headers: { "x-omo-health-token": token }, signal: AbortSignal.timeout(2 * timeout) });
	parentPort.postMessage({ status: response.status, body: await response.json() });
} else {
	const generation = Atomics.add(gate, 2, 1);
	parentPort.on("message", ({ kind, id, now }) => {
		if (now !== expectedNow) throw new Error("the injected clock was not passed to the worker");
		if (mode === "throw" && generation === 0) throw new Error("fixture crash");
		if (mode === "exit" && generation === 0) process.exit(0);
		if (mode === "block") {
			Atomics.store(gate, 0, 1);
			Atomics.notify(gate, 0);
			if (Atomics.wait(gate, 1, 0, timeout) === "timed-out") {
				Atomics.store(gate, 1, 2);
				throw new Error("load gate expired before the state response");
			}
		}
		const result = kind === "detail"
			? { record: { found: true, id, session: { sessionId: id, title: "worker record" } }, audit: null }
			: [202, { ok: true, audit: { sessionId: id, status: "queued" } }];
		parentPort.postMessage({ result });
	});
}
