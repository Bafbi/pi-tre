import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ParsedRepo } from "./types.js";

const CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ["main", "master"];

/**
 * Ensure a repo is cloned into the workspace. Uses shallow clone.
 *
 * Returns:
 *   - "existing" if already cloned
 *   - "cloned" on success
 *   - "failed" with error message on failure
 */
export async function ensureRepoCloned(
	repo: ParsedRepo,
	workspace: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<{ status: "existing" | "cloned" | "failed"; error?: string }> {
	const repoDir = join(workspace, repo.dirName);

	if (existsSync(join(repoDir, ".git"))) {
		return { status: "existing" };
	}

	await mkdir(repoDir, { recursive: true });

	const branchesToTry = repo.branch ? [repo.branch, ...DEFAULT_BRANCHES] : DEFAULT_BRANCHES;
	const uniqueBranches = [...new Set(branchesToTry)];

	for (const branch of uniqueBranches) {
		try {
			const args = ["clone", "--depth", "1", "--single-branch", "--branch", branch, repo.cloneUrl, repoDir];
			const result = await pi.exec("git", args, { signal, timeout: CLONE_TIMEOUT_MS / 1000 });

			if (result.code === 0) {
				return { status: "cloned" };
			}
		} catch {
			// Try next branch
		}
	}

	// All branches failed — clean up partial directory
	try {
		await pi.exec("rm", ["-rf", repoDir]);
	} catch {
		/* ignore cleanup errors */
	}

	const branchInfo = repo.branch ? `branch '${repo.branch}'` : "default branch";
	return {
		status: "failed",
		error: `Failed to clone ${repo.raw} (${branchInfo}). Tried: ${uniqueBranches.join(", ")}`,
	};
}
