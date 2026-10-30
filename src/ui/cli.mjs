import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { listSubjectsNow, runDiagnose } from "../diagnose.mjs";
import { createLogger } from "../log.mjs";
import { uiState } from "./model.mjs";
import { createUiServer } from "./server.mjs";

const DEFAULT_IDLE_MINUTES = 30;
/** Env keys that mean "tests or staging": the launcher must not open a browser on the operator's desktop. OMO_HEALTH_CONFIG is a real user setting, so it is not one. */
const SANDBOX_MARKERS = new Set(["OMO_HEALTH_HOME", "OMO_HEALTH_OMO_HOME", "OMO_HEALTH_CLAUDE_HOME", "NODE_TEST_CONTEXT"]);
const DEFAULT_BIN_PATH = fileURLToPath(new URL("../../bin/omo-health.mjs", import.meta.url));

/** Opens url in the default browser without waiting for it: resolves to { ok, error? }. */
export function defaultOpenBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
	return new Promise((resolve) => {
		try {
			const child =
				platform === "win32"
					? spawnImpl("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: "ignore", windowsHide: true })
					: spawnImpl(platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
			child.once("error", (error) => resolve({ ok: false, error: error.message }));
			child.once("spawn", () => resolve({ ok: true }));
			child.unref();
		} catch (error) {
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

/** Reads --no-open, --json, --idle-minutes N. Returns null when the options are invalid. */
function parseOptions(args) {
	const at = args.indexOf("--idle-minutes");
	const idleMinutes = at >= 0 ? Number(args[at + 1]) : DEFAULT_IDLE_MINUTES;
	if (at >= 0 && (args[at + 1] === undefined || args[at + 1].trim() === "")) return null;
	if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return null;
	return { idleMinutes, noOpen: args.includes("--no-open"), json: args.includes("--json"), serve: args.includes("--serve") };
}

/** Resolves to { port, pid } from the child's "listening" message, or { failure } after the timeout, an error or an early exit. */
function waitForListening(child, timeoutMs) {
	return new Promise((resolve) => {
		const finish = (result) => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
			resolve(result);
		};
		const onMessage = (msg) => {
			if (msg?.type === "listening" && Number.isInteger(msg.port)) finish({ port: msg.port });
		};
		const onError = (error) => finish({ failure: error.message });
		const onExit = (code) => finish({ failure: `서버가 종료되었습니다(코드 ${code})` });
		const timer = setTimeout(() => finish({ failure: `${timeoutMs}ms 안에 응답이 없습니다` }), timeoutMs);
		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
	});
}

async function runLauncher(options, deps) {
	const { env, openBrowser, spawnImpl, execPath, binPath, stdout, stderr, startTimeoutMs } = deps;
	const token = crypto.randomBytes(32).toString("base64url");
	const child = spawnImpl(execPath, [binPath, "ui", "--serve", "--idle-minutes", String(options.idleMinutes)], {
		detached: true,
		windowsHide: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { ...env, OMO_HEALTH_UI_TOKEN: token },
	});
	const started = await waitForListening(child, startTimeoutMs);
	if (started.failure !== undefined) {
		child.kill();
		stderr.write(`대시보드 서버가 시작되지 않았습니다: ${started.failure}\n`);
		return 1;
	}
	child.disconnect();
	child.unref();
	const url = `http://127.0.0.1:${started.port}/#t=${token}`;
	const sandbox = !options.noOpen && Object.keys(env).some((key) => SANDBOX_MARKERS.has(key.toUpperCase()));
	// Open before printing so the JSON line can say whether the browser got the url (the /health ui sensor then keeps the token out of its notify text).
	const opened = options.noOpen || sandbox ? { ok: false } : await openBrowser(url);
	if (options.json) {
		stdout.write(`${JSON.stringify({ url, port: started.port, pid: child.pid, idleMs: options.idleMinutes * 60_000, opened: opened.ok === true })}\n`);
	} else {
		stdout.write(`omo-health 대시보드: ${url}\n${options.idleMinutes}분 동안 쓰지 않으면 스스로 닫힙니다.\n`);
	}
	if (sandbox) stderr.write("샌드박스 환경이라 브라우저를 열지 않았습니다.\n");
	else if (!options.noOpen && !opened.ok) stderr.write(`브라우저를 열지 못했습니다. 위 주소를 직접 여세요: ${opened.error}\n`);
	return 0;
}

async function runServer(options, { paths, env, proc }) {
	const token = env.OMO_HEALTH_UI_TOKEN;
	delete process.env.OMO_HEALTH_UI_TOKEN;
	if (!token) return 2;
	const idleMs = options.idleMinutes * 60_000;
	const logger = createLogger({ file: path.join(paths.health.logsDir, "ui.log") });
	// Diagnosis reads config.json fresh like the state does; it collects its own world (the dashboard never kills).
	const diagnose = (id) => {
		const { config } = loadConfig({ env, paths });
		return id ? runDiagnose({ paths, config, id }) : listSubjectsNow({ paths, config });
	};
	const server = createUiServer({ paths, token, idleMs, getState: () => uiState({ paths, env, now: Date.now() }), diagnose, log: (event, data) => logger.error(event, data) });
	const { port } = await server.listen();
	proc.send?.({ type: "listening", port }, () => proc.disconnect?.());
	return new Promise((resolve) => {
		const stop = async () => {
			clearInterval(timer);
			proc.off("SIGINT", stop);
			proc.off("SIGTERM", stop);
			await server.close();
			resolve(0);
		};
		const timer = setInterval(() => {
			if (server.checkIdle()) void stop();
		}, Math.min(30_000, idleMs / 2));
		timer.unref();
		proc.on("SIGINT", stop);
		proc.on("SIGTERM", stop);
	});
}

export async function runUiCli(
	args,
	{ paths, env, config, openBrowser = defaultOpenBrowser, spawnImpl = spawn, execPath = process.execPath, binPath = DEFAULT_BIN_PATH, stdout = process.stdout, stderr = process.stderr, proc = process, startTimeoutMs = 10_000 },
) {
	const options = parseOptions(args);
	if (options === null) {
		stderr.write("--idle-minutes에는 0보다 큰 숫자를 주세요.\n");
		return 2;
	}
	if (options.serve) return runServer(options, { paths, env, proc });
	return runLauncher(options, { config, env, openBrowser, spawnImpl, execPath, binPath, stdout, stderr, startTimeoutMs });
}
