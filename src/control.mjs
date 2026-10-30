import path from "node:path";
import { DEFAULT_CONFIG } from "./config.mjs";
import { atomicWriteJson, readJsonSafe, removeSafe, statSafe } from "./util/fsx.mjs";

/** True while automatic actions are paused (an unreadable pause file counts as paused). */
export function readPause(paths, now) {
	const pause = readJsonSafe(paths.health.pauseFile);
	if (pause === undefined) {
		if (!statSafe(paths.health.pauseFile)) return false;
		return true;
	}
	return !Number.isFinite(pause?.untilMs) || now < pause.untilMs;
}

export function pauseState(paths, now) {
	const pause = readJsonSafe(paths.health.pauseFile);
	if (pause === undefined) {
		const present = Boolean(statSafe(paths.health.pauseFile));
		return { active: present, untilMs: null, indefinite: present, unreadable: present };
	}
	if (!Number.isFinite(pause?.untilMs)) return { active: true, untilMs: null, indefinite: true, unreadable: false };
	return { active: now < pause.untilMs, untilMs: pause.untilMs, indefinite: false, unreadable: false };
}

export function writePause(paths, { minutes, now = Date.now() } = {}) {
	const pause = Number.isFinite(minutes) && minutes > 0 ? { untilMs: now + minutes * 60_000, byCli: true } : { byCli: true };
	atomicWriteJson(paths.health.pauseFile, pause);
	return pause;
}

export function clearPause(paths) {
	return removeSafe(paths.health.pauseFile);
}

const flag = (key, labelKo, descKo) => ({ key, type: "boolean", values: null, labelKo, descKo });

export const SWITCHES = Object.freeze([
	{
		key: "mode",
		type: "enum",
		values: [
			{ value: "auto", labelKo: "자동 조치" },
			{ value: "shadow", labelKo: "기록만" },
		],
		labelKo: "동작 모드",
		descKo: 'auto는 조치를 실행하고, shadow는 조치하지 않고 "했을 조치"만 기록합니다.',
	},
	flag("actions.kill", "원인 프로세스 종료", "멈춘 도구 호출의 원인 프로세스와, 주인이 사라진 monitor 감시 프로세스를 종료합니다."),
	flag("actions.detach", "포그라운드 서버 분리", "서버는 그대로 두고 그 서버를 기다리던 셸만 종료합니다."),
	flag("actions.release", "기다리던 셸 해제", "끝나지 않는 대기나 입력 대기에 걸린 셸 트리를 종료합니다."),
	flag("monitorOrphans.enabled", "고아 monitor 정리", '주인이 사라진 tool.monitor 감시 프로세스를 60초 유예 뒤 정리합니다(종료에는 "원인 프로세스 종료"도 켜져 있어야 합니다).'),
	flag("config.autoRevert", "settings.json 자동 복구", "설정을 바꾼 직후 공급자 오류가 이어지면 직전 정상본으로 되돌립니다."),
	flag("align.enabled", "범위 점검 넛지", "세션이 원래 요청에서 멀어지면 범위를 다시 확인하라는 짧은 메시지를 보냅니다."),
	flag("analyst.enabled", "멈춤 분석가", "원인을 알 수 없는 멈춤과 조용한 멈춤을 읽기 전용 분석가(omo -p)가 판정합니다. 끄면 이런 호출은 아무것도 종료되지 않습니다."),
	flag("goalLiveness.enabled", "목표 대기 확인", "목표를 기다리는 세션의 깨움 소스가 끝났거나 오래 조용하면 그 세션을 깨웁니다. 끄면 keepalive도 백스톱을 붙잡지 않습니다."),
	flag("footer.showAll", "하단 상태줄에 모두 표시", "끄면(기본) 서브에이전트 문제와 사람만 고칠 수 있는 문제만 표시합니다."),
].map((s) => Object.freeze(s)));

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function getPath(obj, dottedKey) {
	let cur = obj;
	for (const part of dottedKey.split(".")) {
		if (!isPlainObject(cur) || !Object.hasOwn(cur, part)) return undefined;
		cur = cur[part];
	}
	return cur;
}

export function setSwitch(paths, key, value) {
	const spec = SWITCHES.find((s) => s.key === key);
	if (!spec) return { ok: false, reason: "unknown-key" };
	const valid = spec.type === "boolean" ? typeof value === "boolean" : spec.values.some((v) => v.value === value);
	if (!valid) return { ok: false, reason: "invalid-value" };
	const file = paths.health.configFile;
	let root = {};
	if (statSafe(file)) {
		root = readJsonSafe(file);
		if (!isPlainObject(root)) return { ok: false, reason: "unreadable", message: `${file} is not a valid JSON object` };
	}
	const parts = key.split(".");
	const isDefault = getPath(DEFAULT_CONFIG, key) === value;
	const chain = [root];
	for (const part of parts.slice(0, -1)) {
		let next = chain.at(-1)[part];
		if (!isPlainObject(next)) {
			if (isDefault) break;
			next = {};
			chain.at(-1)[part] = next;
		}
		chain.push(next);
	}
	const leaf = parts.at(-1);
	if (chain.length === parts.length) {
		if (isDefault) delete chain.at(-1)[leaf];
		else chain.at(-1)[leaf] = value;
	}
	for (let i = chain.length - 1; i > 0; i--) {
		if (Object.keys(chain[i]).length > 0) break;
		delete chain[i - 1][parts[i - 1]];
	}
	atomicWriteJson(file, root);
	return { ok: true, file, value, isDefault };
}
