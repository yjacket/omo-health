import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Import `file` with ?v=<mtime> so a reload picks up a changed sensor.
 * The stub loads this module with Node's own require() (require(esm)): senpi
 * evaluates extensions through jiti/vm, where a bare import() has no dynamic
 * import callback (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). An import() in a
 * module Node loaded itself always has one.
 */
export function importFresh(file) {
	return import(`${pathToFileURL(file).href}?v=${Math.round(statSync(file).mtimeMs)}`);
}
