/**
 * Workspace lifecycle: creation, detection, archiving, and unarchiving of jj workspaces.
 *
 * This module wraps `jj workspace` commands. All jj interaction goes through here.
 */

import type { SessionState } from "./state.js";

export interface WorkspaceStatus {
	/** Derived lifecycle from jj workspace + bookmark presence. */
	lifecycle: "active" | "archived" | "absent";
	workspacePath: string | undefined;
}

/**
 * Determine workspace status from filesystem and jj state.
 * Stub for issue 01 — jj detection happens in session_start via `jj root`.
 */
export function detectWorkspace(
	_repoRoot: string,
	_sessionId: string,
): WorkspaceStatus {
	return { lifecycle: "absent", workspacePath: undefined };
}

/** Create a jj workspace for the session. Stub. */
export async function createWorkspace(_state: SessionState): Promise<void> {
	// Stub for issue 02
}

/** Archive a workspace: jj workspace forget + rm -rf. Stub. */
export async function archiveWorkspace(_state: SessionState): Promise<void> {
	// Stub for issue 06
}

/** Unarchive a workspace: jj workspace add. Stub. */
export async function unarchiveWorkspace(_state: SessionState): Promise<void> {
	// Stub for issue 06
}
