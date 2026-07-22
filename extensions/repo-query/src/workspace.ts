import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RepoQueryDetails } from "./types.js";

let cachedWorkspace: string | null = null;

/**
 * Get or create the session-persistent workspace directory.
 *
 * Repositories are cloned into subdirectories of this workspace and reused
 * across multiple repo_query tool calls in the same session.
 */
export async function getWorkspacePath(ctx: ExtensionContext): Promise<string> {
	// In-memory cache for this extension runtime
	if (cachedWorkspace) {
		if (existsSync(cachedWorkspace)) {
			return cachedWorkspace;
		}
		// Directory was cleaned (e.g., /tmp cleared); recreate
		await mkdir(cachedWorkspace, { recursive: true });
		return cachedWorkspace;
	}

	// Reconstruct from previous tool result in session branch
	const workspaceFromHistory = findWorkspaceInSession(ctx);
	if (workspaceFromHistory && existsSync(workspaceFromHistory)) {
		cachedWorkspace = workspaceFromHistory;
		return cachedWorkspace;
	}

	// First call in this session — create new workspace
	const sessionFile = ctx.sessionManager.getSessionFile();
	const hash = sessionFile
		? createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)
		: `ephemeral-${Date.now()}`;

	cachedWorkspace = join(tmpdir(), `pi-rq-${hash}`);
	await mkdir(cachedWorkspace, { recursive: true });
	return cachedWorkspace;
}

function findWorkspaceInSession(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "repo_query")
			continue;

		const details = msg.details as RepoQueryDetails | undefined;
		if (details?.workspacePath && existsSync(details.workspacePath)) {
			return details.workspacePath;
		}
	}
	return null;
}

/** Clear the in-memory cache (used on session_shutdown). */
export function clearWorkspaceCache(): void {
	cachedWorkspace = null;
}
