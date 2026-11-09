import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Node runs this file directly (type stripping), so relative imports that the
// benchmark loads at runtime carry the `.ts` extension.
import { parseRepoIdentifier } from "../src/resolver.ts";
import type { ParsedRepo } from "../src/types.ts";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(BENCH_DIR, ".cache");
export const RUNS_DIR = join(BENCH_DIR, "runs");

/** A repository from `tasks.json`: `"owner/repo@<40-char sha>"`. */
export interface PinnedRepo {
	spec: string;
	sha: string;
	parsed: ParsedRepo;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Split a pinned repository spec and parse the identifier with the production
 * resolver, so `displayName` and `dirName` match what the extension builds.
 */
export function parsePinnedRepo(spec: string): PinnedRepo {
	const at = spec.lastIndexOf("@");
	if (at <= 0) {
		throw new Error(`Expected "<owner>/<repo>@<sha>", got: ${spec}`);
	}
	const sha = spec.slice(at + 1);
	if (!SHA_PATTERN.test(sha)) {
		throw new Error(`Expected a 40-character commit SHA, got: ${spec}`);
	}
	return { spec, sha, parsed: parseRepoIdentifier(spec.slice(0, at)) };
}

/** Cache path for one pinned repository. */
function cacheDirFor(pinned: PinnedRepo): string {
	const owner = pinned.parsed.owner ?? pinned.parsed.repo ?? "repo";
	const repo = pinned.parsed.repo ?? pinned.parsed.dirName;
	return join(CACHE_DIR, `${owner}__${repo}@${pinned.sha}`);
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** The commit a clone is checked out at, or `null` when it is not a clone. */
function headOf(dir: string): string | null {
	if (!existsSync(dir)) return null;
	try {
		return git(["rev-parse", "HEAD"], dir);
	} catch {
		return null;
	}
}

/**
 * Fetch a pinned commit into the cache and return the cache path.
 *
 * `git fetch --depth 1 origin <sha>` asks the server for exactly that commit,
 * so the checkout is deterministic and small. A cache entry whose HEAD already
 * matches the SHA is reused. Both steps are plain git: a failure throws, so a
 * broken network stops the benchmark instead of scoring a shallow answer.
 */
export async function ensureClone(pinned: PinnedRepo): Promise<string> {
	const dir = cacheDirFor(pinned);
	if (headOf(dir) === pinned.sha) return dir;

	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	git(["init", "-q"], dir);
	git(["remote", "add", "origin", pinned.parsed.cloneUrl], dir);
	git(["fetch", "--depth", "1", "origin", pinned.sha], dir);
	git(["checkout", "-q", "FETCH_HEAD"], dir);

	const head = headOf(dir);
	if (head !== pinned.sha) {
		throw new Error(
			`Clone of ${pinned.spec} is at ${head ?? "no commit"}, expected ${pinned.sha}`,
		);
	}
	return dir;
}

export interface PreparedRun {
	/** Child working directory: the clone root for one repo, else the parent. */
	cwd: string;
	/** Repository display name → clone path inside the run directory. */
	clones: Map<string, string>;
	/** Run directory holding one subdirectory per clone. */
	root: string;
}

/**
 * Copy the cached clones into a fresh directory for one child run.
 *
 * `--tools read,grep,find,ls,bash` still allows bash, so a child can write.
 * The copy is what keeps a run from poisoning the cache.
 */
export async function prepareRunClones(
	root: string,
	pinned: PinnedRepo[],
): Promise<PreparedRun> {
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });

	const clones = new Map<string, string>();
	for (const repo of pinned) {
		const from = await ensureClone(repo);
		const to = join(root, repo.parsed.dirName);
		await cp(from, to, { recursive: true });
		clones.set(repo.parsed.displayName, to);
	}

	// explorer.ts puts a single-repo child in the clone root and a multi-repo
	// child in the tempspace that holds every clone.
	const only = pinned.length === 1 ? pinned[0] : undefined;
	const cwd = only === undefined ? root : join(root, only.parsed.dirName);
	return { cwd, clones, root };
}
