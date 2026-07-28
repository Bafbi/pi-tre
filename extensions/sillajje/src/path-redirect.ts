import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Rewrite tool call inputs in-place so file operations target the workspace.
 *
 * - `read` / `write` / `edit`: relative paths are resolved against the
 *   workspace path. Absolute paths are **not** remapped — the caller should
 *   inspect the returned info and decide whether to block them.
 * - `bash`: the command is prefixed with `cd <workspace> && `.
 * - All other tools (grep, find, ls, web_search, etc.) are no-ops.
 *
 * Returns metadata about what happened so the caller can log or block
 * absolute paths that point back at the original repo.
 */

export interface RedirectInfo {
	/** The original path before any redirection, or undefined if not a file tool. */
	originalPath?: string;
	/** Whether the path was rewritten. */
	wasRewritten: boolean;
	/**
	 * When an absolute path falls inside `repoRoot` (the agent is trying to
	 * operate on the original repo instead of the workspace), the relative
	 * portion that would map into the workspace. `undefined` otherwise.
	 */
	repoRelativePath?: string;
}

export function redirect(
	event: ToolCallEvent,
	workspacePath: string,
	repoRoot?: string,
): RedirectInfo {
	switch (event.toolName) {
		case "read":
		case "write":
		case "edit": {
			const input = event.input as { path: string };
			if (!input.path) return { wasRewritten: false };

			const original = input.path;
			if (!isAbsolute(original)) {
				// Relative path — resolve against workspace.
				input.path = join(workspacePath, original);
				return { originalPath: original, wasRewritten: true };
			}

			// Absolute path. Check whether it falls inside the repo root.
			if (repoRoot) {
				const resolvedOriginal = resolve(original);
				const resolvedRepo = resolve(repoRoot);
				const rel = relative(resolvedRepo, resolvedOriginal);
				const insideRepo =
					rel !== "" &&
					!rel.startsWith(`..${sep}`) &&
					!isAbsolute(rel);
				if (insideRepo) {
					// Don't remap — let the caller block with a hint.
					return {
						originalPath: original,
						wasRewritten: false,
						repoRelativePath: rel,
					};
				}
			}

			// Absolute path outside repo — leave untouched.
			return { originalPath: original, wasRewritten: false };
		}
		case "bash": {
			const input = event.input as { command: string };
			input.command = `cd ${workspacePath} && ${input.command}`;
			return { wasRewritten: true };
		}
		default:
			return { wasRewritten: false };
	}
}
