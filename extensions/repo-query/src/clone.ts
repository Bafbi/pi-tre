import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Fuse from "fuse.js";

import type { ParsedRepo } from "./types.js";

const CLONE_TIMEOUT_MS = 120_000;

const CLONE_MOCK_REGISTRY_KEY = "__repoQueryCloneMock";

function getMockClone(): typeof ensureRepoCloned | undefined {
	return (globalThis as Record<string, unknown>)[CLONE_MOCK_REGISTRY_KEY] as
		| typeof ensureRepoCloned
		| undefined;
}

/** Test-only: inject a mock implementation for ensureRepoCloned. */
export function setTestCloneImpl(
	impl: typeof ensureRepoCloned | undefined,
): void {
	(globalThis as Record<string, unknown>)[CLONE_MOCK_REGISTRY_KEY] = impl;
}

/**
 * Parse `git ls-remote --heads` output and return up to `maxResults` branch names
 * that are fuzzy-close to the requested branch, using Fuse.js Bitap search.
 */
function getBranchSuggestions(
	requestedBranch: string,
	lsRemoteStdout: string,
	maxResults: number,
): string[] {
	const branches: string[] = [];
	for (const line of lsRemoteStdout.split("\n")) {
		const match = line.match(/^[a-f0-9]+\s+refs\/heads\/(.+)$/);
		if (match) {
			branches.push(match[1]);
		}
	}
	if (branches.length === 0) return [];

	const fuse = new Fuse(branches, {
		threshold: 0.5,
		ignoreLocation: true,
	});

	return fuse
		.search(requestedBranch)
		.slice(0, maxResults)
		.map((r) => r.item);
}

/**
 * Ensure a repo is cloned into the workspace. Uses shallow clone.
 *
 * Returns:
 *   - "existing" if already cloned
 *   - "cloned" on success
 *   - "failed" with error message on failure
 *
 * Branch behavior:
 *   - Explicit branch: only that branch is attempted (no fallback).
 *     On failure, `git ls-remote --heads` is used to suggest similar branches.
 *   - No branch: clones the remote default branch without --branch.
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

	const cloneSource = expandHome(repo.cloneUrl);

	if (repo.branch) {
		try {
			const args = [
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--branch",
				repo.branch,
				cloneSource,
				repoDir,
			];
			const result = await pi.exec("git", args, {
				signal,
				timeout: CLONE_TIMEOUT_MS,
			});

			if (result.code === 0) {
				return { status: "cloned" };
			}
		} catch {
			/* requested branch failed */
		}

		try {
			await rm(repoDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup errors */
		}

		// Try to find similar branch names via fuzzy matching
		let errorMsg = `Failed to clone ${repo.raw} (ref '${repo.branch}').`;
		try {
			const lsResult = await pi.exec(
				"git",
				["ls-remote", "--heads", cloneSource],
				{
					signal,
					timeout: 30_000,
				},
			);
			if (lsResult.code === 0 && lsResult.stdout) {
				const suggestions = getBranchSuggestions(
					repo.branch,
					lsResult.stdout,
					5,
				);
				if (suggestions.length > 0) {
					errorMsg += ` Did you mean one of these branches: ${suggestions.join(", ")}?`;
				}
			}
		} catch {
			/* ls-remote failed — no suggestions available */
		}

		return {
			status: "failed",
			error: errorMsg,
		};
	}

	// No explicit branch: clone the remote default
	try {
		const args = [
			"clone",
			"--depth",
			"1",
			"--single-branch",
			cloneSource,
			repoDir,
		];
		const result = await pi.exec("git", args, {
			signal,
			timeout: CLONE_TIMEOUT_MS,
		});

		if (result.code === 0) {
			return { status: "cloned" };
		}
	} catch {
		/* default branch failed */
	}

	try {
		await rm(repoDir, { recursive: true, force: true });
	} catch {
		/* ignore cleanup errors */
	}

	return {
		status: "failed",
		error: `Failed to clone ${repo.raw} (default branch).`,
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
