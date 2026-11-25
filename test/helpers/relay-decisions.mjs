export function relayDecisions(ms, parentId, childId) {
	const fp = `D1:stall:${childId}`;
	const key = `relay-cancel:${fp}:0`;
	const kind = "relay-cancel";
	const common = { mode: "auto", versions: {}, fp, detector: "D1", kind: "stall", cls: "inproc-tool" };
	const subject = { sessionId: childId, taskId: `st_${childId}`, toolCallId: `call-${childId}`, parentSessionId: parentId };
	const ts = new Date(ms).toISOString();
	const evidence = [];
	return [
		{ ...common, event: "opened", severity: "warn", subject, evidence, ts },
		// engine.mjs:209,632: no subject or action object on the acted row.
		{ ...common, event: "investigation", status: "advised", trigger: "stall", result: "advised", acted: { key, kind }, delivered: true, ts },
		// engine.mjs:1216,1591: independently stamped after perform() returns.
		{ ...common, action: { key, kind, params: { targets: [], serverPids: [] } }, result: "execute", outcome: { delivered: true, via: "inbox", sessionId: parentId }, subject, evidence, ts: new Date(ms + 5).toISOString() },
	];
}
