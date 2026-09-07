import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Fuse from "fuse.js";

import { redactCredentials } from "./resolver.js";
import type { ParsedRepo } from "./types.js";

const CLONE_TIMEOUT_MS = 120_000;
const MAX_STDERR_CHARS = 200;

export interface CloneResult {
	status: "existing" | "cloned" | "failed";
	error?: string;
}

export type CloneImpl = typeof ensureRepoCloned;

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

/** Keep the tail of git's stderr — that is where the actual error lives. */
function stderrTail(stderr: string | undefined): string {
	const tail = redactCredentials(stderr ?? "")
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.slice(-3)
		.join("; ");
	if (!tail) return "";
	return tail.length > MAX_STDERR_CHARS
		? `${tail.slice(0, MAX_STDERR_CHARS)}...`
		: tail;
}

/** Extract a useful, redacted cause from an exec rejection. */
function errorDetail(err: unknown): string {
	const message =
		err instanceof Error
			? redactCredentials(err.message)
			: typeof err === "string"
				? redactCredentials(err)
				: "";
	const stderr =
		typeof err === "object" && err !== null && "stderr" in err
			? (err as { stderr?: unknown }).stderr
			: undefined;
	const tail = typeof stderr === "string" ? stderrTail(stderr) : "";
	if (tail && message && message !== tail) return `${message}: ${tail}`;
	return tail || message;
}

async function removeRepoDir(repoDir: string): Promise<void> {
	try {
		await rm(repoDir, { recursive: true, force: true });
	} catch {
		/* ignore cleanup errors */
	}
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
 *
 * `impl` is an injection seam for tests; production callers omit it.
 */
export async function ensureRepoCloned(
	repo: ParsedRepo,
	workspace: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
	impl?: CloneImpl,
): Promise<CloneResult> {
	if (impl) {
		return impl(repo, workspace, signal, pi);
	}

	const repoDir = join(workspace, repo.dirName);
	const repoLabel = redactCredentials(repo.raw);

	if (existsSync(join(repoDir, ".git"))) {
		return checkExistingOrigin(repo, repoDir, pi);
	}

	await mkdir(repoDir, { recursive: true });

	const cloneSource = expandHome(repo.cloneUrl);

	if (repo.branch) {
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

		let cloneErrorTail = "";
		try {
			const result = await pi.exec("git", args, {
				signal,
				timeout: CLONE_TIMEOUT_MS,
			});
			if (result.code === 0) {
				return { status: "cloned" };
			}
			cloneErrorTail = stderrTail(result.stderr);
		} catch (err) {
			if (signal?.aborted) {
				await removeRepoDir(repoDir);
				return {
					status: "failed",
					error: `Clone of ${repoLabel} aborted.`,
				};
			}
			cloneErrorTail = errorDetail(err);
		}

		await removeRepoDir(repoDir);

		if (signal?.aborted) {
			return {
				status: "failed",
				error: `Clone of ${repoLabel} aborted.`,
			};
		}

		// Try to find similar branch names via fuzzy matching
		let errorMsg = `Failed to clone ${repoLabel} (ref '${repo.branch}').`;
		if (cloneErrorTail) {
			errorMsg += ` git: ${cloneErrorTail}`;
		}
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
	const args = [
		"clone",
		"--depth",
		"1",
		"--single-branch",
		cloneSource,
		repoDir,
	];

	try {
		const result = await pi.exec("git", args, {
			signal,
			timeout: CLONE_TIMEOUT_MS,
		});

		if (result.code === 0) {
			return { status: "cloned" };
		}

		const tail = stderrTail(result.stderr);
		await removeRepoDir(repoDir);
		return {
			status: "failed",
			error: `Failed to clone ${repoLabel} (default branch).${tail ? ` git: ${tail}` : ""}`,
		};
	} catch (err) {
		await removeRepoDir(repoDir);
		const cause = errorDetail(err);
		return {
			status: "failed",
			error: `Failed to clone ${repoLabel} (default branch).${cause ? ` ${cause}` : ""}`,
		};
	}
}

/**
 * The directory already holds a git repo. Make sure it is the requested one:
 * sanitizeDirName can map two distinct repos to the same dirName. Compare the
 * existing origin URL with the requested clone URL. Local-path clones have no
 * origin remote, so a failed lookup falls through to "existing".
 */
async function checkExistingOrigin(
	repo: ParsedRepo,
	repoDir: string,
	pi: ExtensionAPI,
): Promise<CloneResult> {
	try {
		const origin = await pi.exec(
			"git",
			["-C", repoDir, "remote", "get-url", "origin"],
			{ timeout: 10_000 },
		);
		if (origin.code === 0 && origin.stdout.trim()) {
			const existingUrl = origin.stdout.trim();
			if (
				normalizeGitUrl(existingUrl) !==
				normalizeGitUrl(expandHome(repo.cloneUrl))
			) {
				return {
					status: "failed",
					error: `Directory collision: '${repo.dirName}' already contains ${redactCredentials(existingUrl)} but '${redactCredentials(repo.raw)}' resolved to ${redactCredentials(repo.cloneUrl)}.`,
				};
			}
		}
	} catch {
		/* no origin remote (e.g. local path clone) — treat as existing */
	}
	return { status: "existing" };
}

/** Compare URLs modulo trailing slashes and a trailing .git suffix. */
function normalizeGitUrl(url: string): string {
	return url
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
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
