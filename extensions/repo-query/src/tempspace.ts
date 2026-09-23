import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const LEGACY_TEMPSPACE_KEY = "workspacePath";

let cachedTempspace: string | null = null;

/**
 * Get or create the session-persistent tempspace directory.
 *
 * Clone targets live in subdirectories of this tempspace and are reused
 * across multiple repo_query tool calls in the same session.
 */
export async function getTempspacePath(ctx: ExtensionContext): Promise<string> {
	// In-memory cache for this extension runtime
	if (cachedTempspace) {
		if (existsSync(cachedTempspace)) {
			return cachedTempspace;
		}
		// Directory was cleaned (e.g., /tmp cleared); recreate
		await mkdir(cachedTempspace, { recursive: true });
		return cachedTempspace;
	}

	// Reconstruct from previous tool result in session branch
	const tempspaceFromHistory = findTempspaceInSession(ctx);
	if (tempspaceFromHistory && existsSync(tempspaceFromHistory)) {
		cachedTempspace = tempspaceFromHistory;
		return cachedTempspace;
	}

	// First call in this session — create new tempspace
	const sessionFile = ctx.sessionManager.getSessionFile();
	const hash = sessionFile
		? createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)
		: `ephemeral-${Date.now()}`;

	cachedTempspace = join(tmpdir(), `pi-rq-${hash}`);
	await mkdir(cachedTempspace, { recursive: true });
	return cachedTempspace;
}

/**
 * Read the tempspace path from an earlier repo_query tool result.
 *
 * Accepts `tempspacePath` and the pre-rename `workspacePath`, so sessions
 * recorded before the rename still reuse their tempspace.
 */
function findTempspaceInSession(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry === undefined) continue;
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "repo_query")
			continue;

		const details = msg.details as
			| { tempspacePath?: string; workspacePath?: string }
			| undefined;
		const path = details?.tempspacePath ?? details?.[LEGACY_TEMPSPACE_KEY];
		if (path && existsSync(path)) {
			return path;
		}
	}
	return null;
}

/** Clear the in-memory cache (used on session_shutdown). */
export function clearTempspaceCache(): void {
	cachedTempspace = null;
}
