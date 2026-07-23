/**
 * Workspace lifecycle: creation, detection, archiving, and unarchiving of jj workspaces.
 *
 * This module wraps `jj workspace` commands. All jj interaction goes through here
 * via an injected `ExecFn` adapter so the module stays testable.
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
 * Create a jj workspace checked out from the current working copy (`@`).
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

	const result = await exec(
		"jj",
		["workspace", "add", "--name", wsName, "--revision", "@", wsPath],
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
