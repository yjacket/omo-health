import "./helpers/tmp-root.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { resolvePaths } from "../src/paths.mjs";
import * as cli from "../src/ui/cli.mjs";
import { createUiServer } from "../src/ui/server.mjs";

const workerUrl = new URL("./fixtures/ui-detail-worker.mjs", import.meta.url);
const id = "st_worker";
const token = "detail-worker-test";
const now = () => Date.parse("2026-11-22T00:00:00.000Z");
const timeout = 10_000;
const headers = { "x-omo-health-token": token };

async function setup(t, mode) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omoh-ui-worker-"));
	const env = { USERPROFILE: dir, OMO_HEALTH_HOME: path.join(dir, "health") };
	const paths = resolvePaths(env);
	const gate = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
	const options = { paths, env, now };
	if (cli.createDetailWorker) {
		options.worker = cli.createDetailWorker({ paths, env, workerUrl, workerData: { mode, buffer: gate.buffer, expectedNow: now(), timeout } });
	} else {
		// Red proof: f26da4c exposes a synchronous load seam, not a worker seam.
		options.load = () => {
			if (mode !== "block") throw new Error("fixture crash on the server thread");
			Atomics.store(gate, 0, 1);
			Atomics.notify(gate, 0);
			if (Atomics.wait(gate, 1, 0, timeout) === "timed-out") Atomics.store(gate, 1, 2);
			return { found: true, id, session: { sessionId: id, title: "worker record" } };
		};
	}
	const server = createUiServer({
		paths, token, now,
		getState: () => ({ ok: true, gate: Atomics.load(gate, 1) }),
		sessionDetail: cli.createSessionDetail(options),
		startAudit: cli.createStartAudit(options),
	});
	t.after(async () => {
		await server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const { port } = await server.listen();
	const url = `http://127.0.0.1:${port}`;
	const request = async (kind) => {
		const response = kind === "detail"
			? await fetch(`${url}/api/session?id=${id}`, { headers, signal: AbortSignal.timeout(2 * timeout) })
			: await fetch(`${url}/api/audit`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }), signal: AbortSignal.timeout(2 * timeout) });
		return { status: response.status, body: await response.json() };
	};
	return { gate, url, request };
}

for (const kind of ["detail", "audit"]) {
	test(`/api/state responds before the ${kind} load is released`, { concurrency: true }, async (t) => {
		const { gate, url, request } = await setup(t, "block");
		const client = new Worker(workerUrl, { workerData: { mode: "state-client", buffer: gate.buffer, stateUrl: `${url}/api/state`, token, timeout } });
		t.after(() => client.terminate());
		const state = once(client, "message", { signal: AbortSignal.timeout(2 * timeout) });
		const pending = request(kind);
		try {
			assert.deepEqual((await state)[0], { status: 200, body: { ok: true, gate: 0 } });
		} finally {
			Atomics.store(gate, 1, 1);
			Atomics.notify(gate, 1);
			const reply = await pending;
			if (kind === "detail") {
				assert.equal(reply.status, 200);
				assert.equal(reply.body.session.title, "worker record");
			} else if (cli.createDetailWorker) {
				assert.deepEqual(reply, { status: 202, body: { ok: true, audit: { sessionId: id, status: "queued" } } });
			}
		}
	});
}

for (const mode of ["throw", "exit"]) {
	test(`worker ${mode} fails the current request and the next one uses a new worker`, async (t) => {
		const { gate, request } = await setup(t, mode);
		// Fail one route, then succeed through the other using the same manager.
		assert.deepEqual(await request("audit"), { status: 500, body: { error: "internal" } });
		const next = await request("detail");
		assert.equal(next.status, 200);
		assert.equal(next.body.session.title, "worker record");
		assert.equal(Atomics.load(gate, 2), 2, "the request after the failure used a second worker");
	});
}
