import fs from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write via temp file + rename so readers never see a partial file. */
export function atomicWriteFile(file, data) {
	atomicWriteWith(file, (tmp) => fs.writeFileSync(tmp, data));
}

/** Publish a file only after every chunk is written and the descriptor is closed. */
export function atomicWriteChunks(file, chunks) {
	atomicWriteWith(file, (tmp) => {
		const fd = fs.openSync(tmp, "w");
		try {
			for (const chunk of chunks) fs.writeFileSync(fd, chunk);
		} finally {
			fs.closeSync(fd);
		}
	});
}

function atomicWriteWith(file, write) {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
	try {
		write(tmp);
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(tmp, file);
				return;
			} catch (error) {
				if (attempt === 5 || !RETRY_CODES.has(error.code)) throw error;
				// Windows: a reader holding the target open blocks the rename briefly.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
			}
		}
	} catch (error) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// temp file already gone
		}
		throw error;
	}
}

export function atomicWriteJson(file, value) {
	atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parse a JSON file; returns `fallback` when missing or malformed. */
export function readJsonSafe(file, fallback = undefined) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return fallback;
	}
}

export function readTextSafe(file, fallback = undefined) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return fallback;
	}
}

export function statSafe(file) {
	try {
		return fs.statSync(file);
	} catch {
		return undefined;
	}
}

export function listDirSafe(dir, { withFileTypes = false } = {}) {
	try {
		return fs.readdirSync(dir, withFileTypes ? { withFileTypes: true } : undefined);
	} catch {
		return [];
	}
}

export function appendJsonl(file, value) {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function removeSafe(file) {
	try {
		fs.rmSync(file, { force: true, recursive: true });
		return true;
	} catch {
		return false;
	}
}
