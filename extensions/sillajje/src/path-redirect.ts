/**
 * Redirect file paths from cwd-relative to workspace-absolute.
 *
 * Pure functions — issue 03 will implement the full redirection.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Rewrite tool call inputs in-place to point at the workspace directory.
 * No-op for issue 01 (path redirection will be wired in issue 03).
 */
export function redirect(_event: ToolCallEvent, _workspacePath: string): void {
	// Stub
}
