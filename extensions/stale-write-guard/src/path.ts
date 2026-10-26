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

/**
 * Resolve a bash file operand the way the shell sees it.
 *
 * Pi's tool path resolver strips a leading '@' and expands '~' because the
 * read/write/edit tools do that. The shell does not: a quoted '@name' or
 * '~/x' is a literal filename. The command tokenizer drops quote information,
 * so expanding '~' here could record a different file than the shell read.
 * Resolve literally; a '~' operand records nothing, which fails safe.
 */
export function resolveBashPath(path: string, cwd: string): string {
	const absolute = resolve(cwd, path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
