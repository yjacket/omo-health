// Senpi's assertValidSessionId grammar, with the dashboard's 80-character cap.
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Windows reserves these stems even when followed by an extension.
const DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** Return the exact subject ID if safe to use as a filename stem, otherwise null. */
export function safeSubjectId(id) {
	return typeof id === "string" && id.length <= 80 && SESSION_ID.test(id) && !DEVICE_STEM.test(id) ? id : null;
}
