import { mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Fuse from "fuse.js";

import { redactCredentials } from "./resolver.js";
import type { ParsedRepo } from "./types.js";

const CLONE_TIMEOUT_MS = 120_000;
const MAX_STDERR_CHARS = 200;

/**
 * Cleanup retries. Read-only pack files written by a failed clone can block a
 * first removal attempt, especially on Windows. Retries keep cleanup from
 * throwing and masking the real error.
 */
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 100;

export type CloneFailureReason =
	| "clone"
	| "collision"
	| "invalidTarget"
	| "aborted"
	| "timeout";

export type CloneResult =
	| { status: "cloned" }
	| { status: "reused" }
	| { status: "failed"; reason: CloneFailureReason; error: string };

export type CloneImpl = typeof ensureRepoCloned;

interface SharedClone {
	controller: AbortController;
	/** Callers that have not aborted. */
	waiters: number;
	result: Promise<CloneResult>;
	/**
	 * Wait for this clone. A caller that aborts stops waiting on its own; the
	 * shared clone is cancelled only when no caller is still interested.
	 */
	wait(
		repo: ParsedRepo,
		callerSignal: AbortSignal | undefined,
	): Promise<CloneResult>;
}

/**
 * In-flight clones for this process, keyed by clone target path plus requested
 * origin. The origin in the key keeps a repository that collides on the target
 * directory from joining an unrelated clone and skipping the collision check.
 * Cross-process safety comes from the atomic publish, not from this map.
 */
const inFlightClones = new Map<string, SharedClone>();

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

/**
 * Remove a caller's own temporary directory. Failure cleanup must never throw:
 * a failed clone should report its cause, not a cleanup error.
 */
async function removeTempDir(tempDir: string): Promise<void> {
	try {
		await rm(tempDir, {
			recursive: true,
			force: true,
			maxRetries: CLEANUP_RETRIES,
			retryDelay: CLEANUP_RETRY_DELAY_MS,
		});
	} catch {
		/* ignore cleanup errors */
	}
}

function abortedResult(repoLabel: string): CloneResult {
	return {
		status: "failed",
		reason: "aborted",
		error: `Clone of ${repoLabel} aborted.`,
	};
}

function timedOutResult(repoLabel: string): CloneResult {
	return {
		status: "failed",
		reason: "timeout",
		error: `Clone of ${repoLabel} timed out after ${CLONE_TIMEOUT_MS} ms.`,
	};
}

/**
 * Publish a finished clone at its target with a single atomic rename.
 *
 * A target only ever appears as the result of this rename, so a half-written
 * or cancelled clone is never visible. When the rename fails, another caller
 * may have published a complete clone first: re-probe the target and reuse it.
 */
async function publishClone(
	tempDir: string,
	cloneTarget: string,
	repo: ParsedRepo,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<CloneResult> {
	try {
		await rename(tempDir, cloneTarget);
		return { status: "cloned" };
	} catch {
		if (await targetHasResolvableHead(cloneTarget, signal, pi)) {
			return checkExistingOrigin(repo, cloneTarget, signal, pi);
		}
		// The target is not a valid clone. Heal it only when it is empty, then
		// retry the publish once. A non-empty target is never force-replaced.
		if (await removeIfEmpty(cloneTarget)) {
			try {
				await rename(tempDir, cloneTarget);
				return { status: "cloned" };
			} catch {
				// Another caller may have published a valid clone while we
				// healed the target. Re-probe before reporting it invalid.
				if (await targetHasResolvableHead(cloneTarget, signal, pi)) {
					return checkExistingOrigin(repo, cloneTarget, signal, pi);
				}
			}
		}
		return {
			status: "failed",
			reason: "invalidTarget",
			error: `Clone target '${cloneTarget}' is not a valid git clone and must be removed before retrying.`,
		};
	}
}

/**
 * Remove a directory only when it is empty. `rmdir` refuses a non-empty
 * directory, so this never deletes a valid clone another caller published.
 */
async function removeIfEmpty(dir: string): Promise<boolean> {
	try {
		await rmdir(dir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a repo is cloned into the tempspace. Uses shallow clone.
 *
 * The clone is fetched into a private temporary directory and published at its
 * clone target with one atomic rename. A target is either a complete clone or
 * absent; failure cleanup removes only the caller's own temporary directory.
 *
 * Returns:
 *   - "reused" if a clone target is already present
 *   - "cloned" on success
 *   - "failed" with a reason and error message on failure
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
	tempspace: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
	impl?: CloneImpl,
): Promise<CloneResult> {
	if (impl) {
		return impl(repo, tempspace, signal, pi);
	}

	const cloneTarget = join(tempspace, repo.dirName);
	const key = `${cloneTarget}\n${normalizeGitUrl(expandHome(repo.cloneUrl))}`;

	const existing = inFlightClones.get(key);
	if (existing) {
		return existing.wait(repo, signal);
	}

	const controller = new AbortController();
	const result: Promise<CloneResult> = runClone(
		repo,
		tempspace,
		controller.signal,
		pi,
	).catch(
		(err): CloneResult => ({
			status: "failed",
			reason: "clone",
			error:
				errorDetail(err) ||
				`Failed to clone ${redactCredentials(repo.raw)}.`,
		}),
	);
	const shared: SharedClone = {
		controller,
		waiters: 0,
		result,
		wait(repo, callerSignal) {
			shared.waiters++;
			const repoLabel = redactCredentials(repo.raw);
			return new Promise<CloneResult>((resolve) => {
				let settled = false;
				const finish = (result: CloneResult) => {
					if (settled) return;
					settled = true;
					callerSignal?.removeEventListener("abort", onAbort);
					resolve(result);
				};
				const onAbort = () => {
					if (settled) return;
					shared.waiters--;
					if (shared.waiters === 0) {
						shared.controller.abort();
						if (inFlightClones.get(key) === shared) {
							inFlightClones.delete(key);
						}
					}
					finish(abortedResult(repoLabel));
				};

				if (callerSignal?.aborted) {
					onAbort();
					return;
				}
				callerSignal?.addEventListener("abort", onAbort, {
					once: true,
				});
				shared.result.then(finish);
			});
		},
	};
	result.finally(() => {
		if (inFlightClones.get(key) === shared) {
			inFlightClones.delete(key);
		}
	});
	inFlightClones.set(key, shared);

	return shared.wait(repo, signal);
}

/**
 * Drop every in-flight clone entry. Called on session shutdown so a session
 * boundary does not leave hidden registry state behind. Each shared clone is
 * aborted before it is forgotten, so it cannot keep running or publish after
 * its tempspace is removed. Returns the count.
 */
export function clearInFlightClones(): number {
	const cleared = inFlightClones.size;
	for (const shared of inFlightClones.values()) {
		shared.controller.abort();
	}
	inFlightClones.clear();
	return cleared;
}

/**
 * Fetch one clone and publish it. The signal is the shared-clone controller's
 * signal, not any single caller's: a caller aborting does not cancel a clone
 * another caller still needs.
 */
async function runClone(
	repo: ParsedRepo,
	tempspace: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<CloneResult> {
	const cloneTarget = join(tempspace, repo.dirName);
	const repoLabel = redactCredentials(repo.raw);
	const cloneSource = expandHome(repo.cloneUrl);

	if (await targetHasResolvableHead(cloneTarget, signal, pi)) {
		return checkExistingOrigin(repo, cloneTarget, signal, pi);
	}

	const tempDir = await mkdtemp(join(tempspace, `.${repo.dirName}-`));

	try {
		const args = repo.branch
			? [
					"clone",
					"--depth",
					"1",
					"--single-branch",
					"--branch",
					repo.branch,
					cloneSource,
					tempDir,
				]
			: [
					"clone",
					"--depth",
					"1",
					"--single-branch",
					cloneSource,
					tempDir,
				];

		let cloneErrorTail = "";
		try {
			const result = await pi.exec("git", args, {
				signal,
				timeout: CLONE_TIMEOUT_MS,
			});

			if (signal?.aborted) {
				return abortedResult(repoLabel);
			}
			if (result.killed) {
				return timedOutResult(repoLabel);
			}

			if (result.code === 0) {
				return await publishClone(
					tempDir,
					cloneTarget,
					repo,
					signal,
					pi,
				);
			}

			cloneErrorTail = stderrTail(result.stderr);
		} catch (err) {
			if (signal?.aborted) {
				return abortedResult(repoLabel);
			}
			cloneErrorTail = errorDetail(err);
		}

		if (signal?.aborted) {
			return abortedResult(repoLabel);
		}

		if (repo.branch) {
			return await branchFailure(
				repo,
				repoLabel,
				cloneSource,
				cloneErrorTail,
				signal,
				pi,
			);
		}

		return {
			status: "failed",
			reason: "clone",
			error: `Failed to clone ${repoLabel} (default branch).${cloneErrorTail ? ` git: ${cloneErrorTail}` : ""}`,
		};
	} finally {
		await removeTempDir(tempDir);
	}
}

/**
 * Build the failure for an explicit-branch clone. When the clone failed for a
 * reason other than the branch, suggest fuzzy-close branch names.
 */
async function branchFailure(
	repo: ParsedRepo,
	repoLabel: string,
	cloneSource: string,
	cloneErrorTail: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<CloneResult> {
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
		if (lsResult.code === 0 && lsResult.stdout && repo.branch) {
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
		reason: "clone",
		error: errorMsg,
	};
}

/**
 * A clone target is present only when its repository has a resolvable HEAD.
 * A `.git` directory alone is not enough: a half-written or unborn repository
 * must never reach a subagent, and an empty leftover target must be retried.
 */
async function targetHasResolvableHead(
	cloneTarget: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<boolean> {
	try {
		const result = await pi.exec(
			"git",
			["-C", cloneTarget, "rev-parse", "-q", "--verify", "HEAD"],
			{ signal, timeout: 10_000 },
		);
		return result.code === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * The directory already holds a git repo. Make sure it is the requested one:
 * sanitizeDirName can map two distinct repos to the same dirName. Compare the
 * existing origin URL with the requested clone URL. Local-path clones have no
 * origin remote, so a failed lookup falls through to "reused".
 */
async function checkExistingOrigin(
	repo: ParsedRepo,
	cloneTarget: string,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
): Promise<CloneResult> {
	try {
		const origin = await pi.exec(
			"git",
			["-C", cloneTarget, "remote", "get-url", "origin"],
			{ signal, timeout: 10_000 },
		);
		if (origin.code === 0 && origin.stdout.trim()) {
			const existingUrl = origin.stdout.trim();
			if (
				normalizeGitUrl(existingUrl) !==
				normalizeGitUrl(expandHome(repo.cloneUrl))
			) {
				return {
					status: "failed",
					reason: "collision",
					error: `Directory collision: '${repo.dirName}' already contains ${redactCredentials(existingUrl)} but '${redactCredentials(repo.raw)}' resolved to ${redactCredentials(repo.cloneUrl)}.`,
				};
			}
		}
	} catch {
		/* no origin remote (e.g. local path clone) — treat as reused */
	}
	return { status: "reused" };
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
