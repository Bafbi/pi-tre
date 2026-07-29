/**
 * Workspace lifecycle: creation, detection, archiving, and unarchiving of jj workspaces.
 *
 * This module wraps `jj workspace` and `jj bookmark` commands. All jj interaction
 * goes through here via an injected `ExecFn` adapter so the module stays testable.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of pi.exec result shape used by workspace operations. */
export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Exec adapter matching `ExtensionAPI.exec`. */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<ExecResult>;

export interface WorkspaceInfo {
	/** Absolute path to the workspace directory on disk. */
	workspacePath: string;
	/** jj workspace name, e.g. `sillajje-<sessionId>`. */
	workspaceName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a safe directory slug from an absolute repo root path. */
export function getRepoSlug(repoRoot: string): string {
	return basename(repoRoot);
}

/** Resolve the absolute workspace directory path without creating it. */
export function resolveWorkspacePath(
	repoRoot: string,
	sessionId: string,
	workspacesRoot: string,
): string {
	return `${workspacesRoot}/${getRepoSlug(repoRoot)}/${sessionId}`;
}

/**
 * Derive a jj workspace name from a session ID.
 * jj workspace names use `-` separators (unlike bookmarks which use `/`).
 */
export function workspaceName(sessionId: string): string {
	return `sillajje-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

/**
 * Resolve the base revision for a new workspace.
 *
 * Prefers `@-` (parent of the working copy — the last stable commit), falling
 * back to `@` (current working copy) when `@-` does not exist, which happens
 * on the first commit in a repo.
 */
async function resolveBaseRevision(
	exec: ExecFn,
	repoRoot: string,
): Promise<string> {
	const result = await exec("jj", ["log", "-r", "@-"], { cwd: repoRoot });
	return result.code === 0 ? "@-" : "@";
}

/**
 * Create a jj workspace checked out from `@-` (parent of working copy),
 * falling back to `@` when `@-` does not exist.
 *
 * Idempotent: if the workspace directory already exists on disk, skips creation
 * and returns the existing path.
 */
export async function createWorkspace(
	exec: ExecFn,
	repoRoot: string,
	sessionId: string,
	workspacesRoot: string,
): Promise<WorkspaceInfo> {
	const wsName = workspaceName(sessionId);
	const wsPath = resolveWorkspacePath(repoRoot, sessionId, workspacesRoot);

	// Idempotent: don't recreate if the workspace directory already exists
	if (existsSync(wsPath)) {
		return { workspacePath: wsPath, workspaceName: wsName };
	}

	// Create the parent directory of the workspace path.
	// jj workspace add will create the leaf directory (session-id),
	// but the repo-slug directory must already exist.
	mkdirSync(dirname(wsPath), { recursive: true });

	const baseRevision = await resolveBaseRevision(exec, repoRoot);

	const result = await exec(
		"jj",
		[
			"workspace",
			"add",
			"--name",
			wsName,
			"--revision",
			baseRevision,
			wsPath,
		],
		{ cwd: repoRoot },
	);

	if (result.code !== 0) {
		throw new Error(
			`jj workspace add failed (exit ${result.code}): ${result.stderr}`,
		);
	}

	return { workspacePath: wsPath, workspaceName: wsName };
}

/**
 * Check whether a jj workspace with the given name exists.
 */
export async function workspaceExists(
	exec: ExecFn,
	name: string,
): Promise<boolean> {
	const result = await exec("jj", ["workspace", "list"]);
	if (result.code !== 0) return false;
	return result.stdout.includes(name);
}

/**
 * Forget a jj workspace by name.
 */
export async function workspaceForget(
	exec: ExecFn,
	name: string,
): Promise<void> {
	await exec("jj", ["workspace", "forget", name]);
}

/**
 * Remove a workspace entirely: forget it in jj and delete its directory.
 * Graceful — errors are swallowed so cleanup never throws.
 */
export async function cleanupWorkspace(
	exec: ExecFn,
	workspaceName: string,
	workspacePath: string,
): Promise<void> {
	try {
		await workspaceForget(exec, workspaceName);
	} catch {
		// Workspace may already be gone — that's fine.
	}

	try {
		rmSync(workspacePath, { recursive: true, force: true });
	} catch {
		// Directory may already be deleted — that's fine.
	}
}

// ---------------------------------------------------------------------------
// Archive / unarchive helpers
// ---------------------------------------------------------------------------

/**
 * Get the workspace directory path from `jj workspace list` for a given
 * workspace name.
 *
 * Parses the output format `<name>: <path>` and returns the path when the
 * named workspace is found. Returns `undefined` when no match is found or
 * the command fails.
 */
export async function getWorkspacePathByName(
	exec: ExecFn,
	name: string,
): Promise<string | undefined> {
	const result = await exec("jj", ["workspace", "list"]);
	if (result.code !== 0) return undefined;

	for (const line of result.stdout.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const wsName = line.slice(0, colonIdx).trim();
		const wsPath = line.slice(colonIdx + 1).trim();
		if (wsName === name && wsPath.length > 0) return wsPath;
	}

	return undefined;
}

/**
 * Check whether a jj bookmark exists by scanning `jj bookmark list`.
 */
export async function bookmarkExists(
	exec: ExecFn,
	bookmarkName: string,
	repoRoot: string,
): Promise<boolean> {
	const result = await exec("jj", ["bookmark", "list"], { cwd: repoRoot });
	if (result.code !== 0) return false;
	return result.stdout
		.split("\n")
		.some((line) => line.trim().startsWith(bookmarkName));
}

/**
 * Unarchive a sillajje session: recreate a jj workspace from the session's
 * bookmark.
 *
 * Runs `jj workspace add --name <name> --revision sillajje/<id> <path>`
 * to restore the workspace from the saved bookmark. The bookmark must exist
 * before calling this.
 *
 * @throws when `jj workspace add` fails.
 */
export async function unarchiveWorkspace(
	exec: ExecFn,
	repoRoot: string,
	sessionId: string,
	workspacesRoot: string,
): Promise<WorkspaceInfo> {
	const wsName = workspaceName(sessionId);
	const wsPath = resolveWorkspacePath(repoRoot, sessionId, workspacesRoot);

	// Create the parent directory of the workspace path.
	// jj workspace add will create the leaf directory (session-id),
	// but the repo-slug directory must already exist.
	mkdirSync(dirname(wsPath), { recursive: true });

	const result = await exec(
		"jj",
		[
			"workspace",
			"add",
			"--name",
			wsName,
			"--revision",
			`sillajje/${sessionId}`,
			wsPath,
		],
		{ cwd: repoRoot },
	);

	if (result.code !== 0) {
		throw new Error(
			`jj workspace add failed (exit ${result.code}): ${result.stderr}`,
		);
	}

	return { workspacePath: wsPath, workspaceName: wsName };
}
