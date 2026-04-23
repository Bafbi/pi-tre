import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ParsedRepo } from "./types.js";

const CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ["main", "master"];

const CLONE_MOCK_REGISTRY_KEY = "__repoQueryCloneMock";

function getMockClone(): typeof ensureRepoCloned | undefined {
	return (globalThis as Record<string, unknown>)[CLONE_MOCK_REGISTRY_KEY] as typeof ensureRepoCloned | undefined;
}

/** Test-only: inject a mock implementation for ensureRepoCloned. */
export function setTestCloneImpl(impl: typeof ensureRepoCloned | undefined): void {
	(globalThis as Record<string, unknown>)[CLONE_MOCK_REGISTRY_KEY] = impl;
}

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
	const mock = getMockClone();
	if (mock) {
		return mock(repo, workspace, signal, pi);
	}

	const repoDir = join(workspace, repo.dirName);

	if (existsSync(join(repoDir, ".git"))) {
		return { status: "existing" };
	}

	await mkdir(repoDir, { recursive: true });

	const branchesToTry = repo.branch ? [repo.branch, ...DEFAULT_BRANCHES] : DEFAULT_BRANCHES;
	const uniqueBranches = [...new Set(branchesToTry)];

	const cloneSource = expandHome(repo.cloneUrl);

	for (const branch of uniqueBranches) {
		try {
			const args = ["clone", "--depth", "1", "--single-branch", "--branch", branch, cloneSource, repoDir];
			const result = await pi.exec("git", args, { signal, timeout: CLONE_TIMEOUT_MS });

			if (result.code === 0) {
				return { status: "cloned" };
			}
		} catch {
			// Try next branch
		}
	}

	// All branches failed — clean up partial directory
	try {
		await rm(repoDir, { recursive: true, force: true });
	} catch {
		/* ignore cleanup errors */
	}

	const branchInfo = repo.branch ? `branch '${repo.branch}'` : "default branch";
	return {
		status: "failed",
		error: `Failed to clone ${repo.raw} (${branchInfo}). Tried: ${uniqueBranches.join(", ")}`,
	};
}

function expandHome(pathStr: string): string {
	if (pathStr.startsWith("~/")) {
		return join(homedir(), pathStr.slice(2));
	}
	if (pathStr === "~") {
		return homedir();
	}
	return pathStr;
}
