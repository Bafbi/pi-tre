import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function stripToolPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
	return path;
}

/** Resolve user-provided path to an absolute path against cwd. */
export function resolveFromCwd(path: string, cwd: string): string {
	const normalized = expandHome(stripToolPrefix(path));
	if (isAbsolute(normalized)) return normalized;
	return resolve(cwd, normalized);
}

/**
 * Canonicalize an absolute path using realpath when possible.
 * Falls back to the resolved absolute path for non-existing files.
 */
export function canonicalizePath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export function resolveCanonicalPath(path: string, cwd: string): string {
	return canonicalizePath(resolveFromCwd(path, cwd));
}
