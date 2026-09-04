import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Pi's tools strip a leading '@' before touching the file
 * (normalizeToolPath in @earendil-works/pi-coding-agent). The guard must
 * resolve the same path the tool will mutate, or an '@'-prefixed edit
 * bypasses the guard entirely.
 */
function stripToolPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
	return path;
}

/**
 * Resolve a user-provided path to a canonical absolute path against cwd.
 * Falls back to the resolved absolute path for non-existing files.
 */
export function resolveCanonicalPath(path: string, cwd: string): string {
	const absolute = resolve(cwd, expandHome(stripToolPrefix(path)));
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
