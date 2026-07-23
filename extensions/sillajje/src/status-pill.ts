import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionState } from "./state.js";

/**
 * Shorten an absolute path using the same logic as the Pi footer's cwd display:
 * `~` for paths under the home directory, full path otherwise.
 */
function shortenPath(p: string, home: string): string {
	const resolvedPath = resolve(p);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedPath);
	const insideHome =
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return p;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Format the sillajje footer status pill.
 *
 * Returns `undefined` when no pill should be shown (inactive).
 */
export function formatPill(state: SessionState): string | undefined {
	const lifecycle = state.getLifecycle();

	if (lifecycle === "inactive") return undefined;

	if (lifecycle === "active") {
		const wsPath = state.getWorkspacePath();
		if (!wsPath) return undefined;
		return `sillajje: [active] ${shortenPath(wsPath, homedir())}`;
	}

	// archived
	const sessionId = state.getSessionId();
	const bookmark = sessionId ? `sillajje/${sessionId}` : "sillajje/?";
	return `sillajje: [archived] ${bookmark}`;
}
