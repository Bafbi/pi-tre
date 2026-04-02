import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * stale-write-guard
 *
 * v0 scaffold.
 *
 * Planned behavior:
 * - track file read/write mtimes
 * - block edit/write when file changed externally after last agent edit
 * - force model to read file again before mutating
 */
export default function (_pi: ExtensionAPI) {
	// TODO: implement stale-write-guard behavior
}
