import os from "node:os";
import path from "node:path";
import { isInside, pathKey } from "../paths.mjs";
import { makeFinding, RECENT_EVIDENCE_MS } from "./finding.mjs";

/** D14: writes in the wrong place - subagents outside their workspace, any session touching global config (IS-11). */
export const id = "D14";

const WRITE_PATTERN = /(^|[^0-9&=-])>>?(?!&)|\bsed\s+(-\w*\s+)*-i|\bcp\b|\bmv\b|\brm\b|writeFile|unlink|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item/i;
// A redirect writes only the token right after it (`x > 0` in code, `<home>` in text are not writes).
const REDIRECT_TARGET = /(^|[^0-9&=<>-])>>?(?!&)\s*["']?([^\s"'`;|&<>()]+)/g;
const OTHER_WRITE = /\bsed\s+(-\w*\s+)*-i|\bcp\b|\bmv\b|\brm\b|writeFile|unlink|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item/i;
const PLACEHOLDER = /<[a-z_][\w.:-]*>/g;

/** Does this normalized statement write a path containing needle? */
function statementWrites(statement, needle) {
	const text = statement.replace(PLACEHOLDER, " ");
	for (const match of text.matchAll(REDIRECT_TARGET)) if (match[2].includes(needle)) return true;
	return OTHER_WRITE.test(text) && text.includes(needle);
}

function protectedTargets(paths) {
	if (!paths) return [];
	const home = paths.home ? pathKey(paths.home) : undefined;
	return [paths.settingsFile, paths.omoJsonc, paths.authFile, paths.extensionsDir, paths.claudeSettingsFile]
		.filter(Boolean)
		.map((target) => {
			const key = pathKey(target);
			const needles = [key];
			if (home && key.startsWith(`${home}/`)) needles.push(`/${key.slice(home.length + 1)}`);
			return { path: target, needles };
		});
}

function absolute(p, base) {
	if (path.isAbsolute(p)) return p;
	return base ? path.resolve(base, p) : undefined;
}

function globalWrites(session, targets) {
	const hits = [];
	for (const write of session.writes ?? []) {
		const abs = absolute(write.path, session.cwd);
		if (!abs) continue;
		const target = targets.find((t) => isInside(abs, t.path));
		if (target) hits.push({ path: abs, target: target.path, tool: write.tool, ms: write.ms, via: "write" });
	}
	for (const command of session.commands ?? []) {
		if (!WRITE_PATTERN.test(command.text)) continue;
		// The protected path and a write construct must share one statement; a read of a
		// protected path next to an unrelated write elsewhere is not a config write.
		const statements = String(command.text)
			.split(/\r?\n|;|&&|\|\|/)
			.filter((statement) => WRITE_PATTERN.test(statement))
			.map((statement) => statement.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase());
		const target = targets.find((t) => t.needles.some((needle) => statements.some((statement) => statementWrites(statement, needle))));
		if (target) hits.push({ path: target.path, target: target.path, tool: command.tool, ms: command.ms, via: "command" });
	}
	return hits;
}

function outsideWrites(world, session, targets) {
	const task = session.task ?? world.tasksById.get(session.taskId);
	const roots = [task?.spawnCwd ?? session.cwd, world.parentOf(session)?.cwd, os.tmpdir(), world.paths?.healthHome].filter(Boolean);
	const base = session.cwd ?? task?.spawnCwd;
	const hits = [];
	// Sibling worktrees of the project ("<repo>-wt", "<repo>-wt/<branch>") are part of the same work.
	const siblingPrefixes = roots.slice(0, 2).map((root) => pathKey(root));
	const isSiblingWorktree = (abs) => {
		const key = pathKey(abs);
		return siblingPrefixes.some((prefix) => /^(-wt|-worktrees?|\.worktrees)(\/|$)/.test(key.startsWith(prefix) ? key.slice(prefix.length) : "#"));
	};
	for (const write of session.writes ?? []) {
		const abs = absolute(write.path, base);
		if (!abs) continue;
		if (roots.some((root) => isInside(abs, root)) || isSiblingWorktree(abs)) continue;
		// Global config writes are reported once, as global-config-write.
		if (targets.some((t) => isInside(abs, t.path))) continue;
		hits.push({ path: abs, tool: write.tool, ms: write.ms });
	}
	return { hits, roots };
}

const uniquePaths = (hits) => [...new Set(hits.map((hit) => hit.path))];

export function detect(world) {
	const targets = protectedTargets(world.paths);
	const out = [];
	const recent = (hit) => Number.isFinite(hit.ms) && world.now - hit.ms <= RECENT_EVIDENCE_MS && hit.ms <= world.now;
	for (const session of world.sessions.values()) {
		const subject = { sessionId: session.id, taskId: session.taskId, parentSessionId: session.parentSessionId };
		if (session.kind === "child") {
			const outside = outsideWrites(world, session, targets);
			const roots = outside.roots;
			const hits = outside.hits.filter(recent);
			if (hits.length) {
				const paths = uniquePaths(hits);
				out.push(
					makeFinding({
						detector: id,
						kind: "outside-workspace",
						subject: { ...subject, key: "outside" },
						evidence: hits.slice(-10).map((hit) => `write:${hit.tool}:${hit.path}`),
						titleKo: `작업 폴더 밖 수정: 서브에이전트가 ${paths.length}개 파일을 바깥에 씀`,
						detailKo: `서브에이전트 세션 ${session.id}가 작업 폴더, 부모 폴더, 임시 폴더 밖의 파일을 수정했습니다: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " 외" : ""}. 의도한 변경인지 확인이 필요합니다.`,
						data: { paths: paths.slice(0, 20), count: hits.length, tools: [...new Set(hits.map((hit) => hit.tool))], allowedRoots: roots, lastMs: hits.at(-1).ms },
					}),
				);
			}
		}
		const hits = globalWrites(session, targets).filter(recent);
		if (hits.length) {
			const paths = uniquePaths(hits);
			out.push(
				makeFinding({
					detector: id,
					kind: "global-config-write",
					subject: { ...subject, key: "global-config" },
					evidence: hits.slice(-10).map((hit) => `${hit.via}:${hit.tool}:${hit.path}`),
					titleKo: `전역 설정 수정: ${paths.length}개 보호 경로를 건드림`,
					detailKo: `세션 ${session.id}가 전역 설정 경로를 수정했습니다: ${paths.join(", ")}. 전역 설정 변경은 모든 세션에 영향을 줍니다. 의도한 변경인지 확인하세요.`,
					data: { paths, hits: hits.slice(-20), count: hits.length, tools: [...new Set(hits.map((hit) => hit.tool))], lastMs: hits.at(-1).ms },
				}),
			);
		}
	}
	return out;
}
