import crypto from "node:crypto";

export function sha1(value) {
	return crypto.createHash("sha1").update(String(value)).digest("hex");
}

/** Fold all whitespace (including newlines of multi-line commands) into single spaces. */
export function normalizeCommand(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Split a Windows command line into argv the way the MSVC runtime does
 * (CommandLineToArgvW). libuv's quote_cmd_arg, which node's spawn uses, is its
 * exact inverse, so a shell's `-c` argument comes back byte for byte.
 */
export function splitWindowsCommandLine(cmdline) {
	const s = String(cmdline ?? "");
	const args = [];
	let i = 0;
	while (i < s.length) {
		while (s[i] === " " || s[i] === "\t") i += 1;
		if (i >= s.length) break;
		let arg = "";
		let quoted = false;
		while (i < s.length && (quoted || (s[i] !== " " && s[i] !== "\t"))) {
			if (s[i] === "\\") {
				let j = i;
				while (s[j] === "\\") j += 1;
				if (s[j] === '"') {
					arg += "\\".repeat(Math.floor((j - i) / 2));
					if ((j - i) % 2) {
						arg += '"';
						j += 1;
					}
				} else {
					arg += "\\".repeat(j - i);
				}
				i = j;
			} else if (s[i] === '"') {
				if (quoted && s[i + 1] === '"') {
					arg += '"';
					i += 2;
				} else {
					quoted = !quoted;
					i += 1;
				}
			} else {
				arg += s[i];
				i += 1;
			}
		}
		args.push(arg);
	}
	return args;
}

/** A process command line as comparable text: decoded argv joined by spaces, whitespace folded. */
export function commandLineText(cmdline) {
	return normalizeCommand(splitWindowsCommandLine(cmdline).join(" "));
}

const REDACTIONS = [
	[/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]"],
	[/eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED-JWT]"],
	[/("(?:access|refresh)(?:Token|_token)?"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2"],
	[/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]"],
	// The value, after an optional (JSON-escaped) opening quote, up to whitespace, a quote or a backslash: quoted shells
	// (export X="...", $env:X='...') are masked, and text that is (or will be parsed as) JSON keeps its punctuation (#87 review).
	[/(CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(?:\\?["'])?)[^\s"'\\]+/g, "$1[REDACTED]"],
];

/** Mask anything that looks like a credential before it is logged or reported. */
export function redact(value) {
	let text = String(value ?? "");
	for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
	return text;
}

export function truncate(value, max) {
	const text = String(value ?? "");
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function shortId(value, length = 8) {
	return String(value ?? "").slice(0, length);
}
