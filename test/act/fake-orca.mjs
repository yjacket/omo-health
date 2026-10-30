import fs from "node:fs";

const [, , ...argv] = process.argv;
const callLog = process.env.ORCA_CALL_LOG;
const calls = callLog && fs.existsSync(callLog) ? JSON.parse(fs.readFileSync(callLog, "utf8")) : [];
calls.push({ argv, options: { shell: undefined, windowsHide: true, timeout: 15000 } });
if (callLog) fs.writeFileSync(callLog, JSON.stringify(calls));
const fixtures = JSON.parse(process.env.ORCA_FIXTURES ?? "{}");
const key = argv[0] === "status" ? "status --json"
	: argv[0] === "worktree" ? "worktree ps --json"
		: "terminal create";
const fixture = fixtures[key];
const response = typeof fixture === "string" ? { stdout: fixture } : fixture?.stdout !== undefined ? fixture : { stdout: fixture };
process.stdout.write(response?.stdout ?? "{}");
process.stderr.write(response?.stderr ?? "");
process.exitCode = response?.status ?? 0;
