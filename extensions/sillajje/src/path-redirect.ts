import { isAbsolute, join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Rewrite tool call inputs in-place so file operations target the workspace.
 *
 * - `read` / `write` / `edit`: relative paths are resolved against the
 *   workspace path; absolute paths are left untouched.
 * - `bash`: the command is prefixed with `cd <workspace> && `.
 * - All other tools (grep, find, ls, web_search, etc.) are no-ops.
 */

export function redirect(event: ToolCallEvent, workspacePath: string): void {
	switch (event.toolName) {
		case "read":
		case "write":
		case "edit": {
			const input = event.input as { path: string };
			if (input.path && !isAbsolute(input.path)) {
				input.path = join(workspacePath, input.path);
			}
			break;
		}
		case "bash": {
			const input = event.input as { command: string };
			input.command = `cd ${workspacePath} && ${input.command}`;
			break;
		}
		default:
			// no-op for unlisted tools
			break;
	}
}
