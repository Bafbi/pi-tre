import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearInFlightClones, ensureRepoCloned } from "../../src/clone.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function mockPi(
	execImpl: (
		command: string,
		args: string[],
		options?: { signal?: AbortSignal; timeout?: number },
	) => Promise<{
		stdout: string;
		stderr: string;
		code: number;
		killed: boolean;
	}>,
) {
	return {
		exec: execImpl,
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
}

type ExecReply = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type ExecOptionsLike = { signal?: AbortSignal; timeout?: number };

const OK_REPLY: ExecReply = { stdout: "", stderr: "", code: 0, killed: false };
const NOT_A_REPO_REPLY: ExecReply = {
	stdout: "",
	stderr: "fatal: not a git repository",
	code: 128,
	killed: false,
};
const HEAD_OK_REPLY: ExecReply = {
	stdout: "abc123\n",
	stderr: "",
	code: 0,
	killed: false,
};

interface GitHandlers {
	clone?: (call: {
		args: string[];
		dest: string;
		source: string;
		options?: ExecOptionsLike;
	}) => ExecReply | Promise<ExecReply>;
	head?: (cwd: string) => ExecReply | Promise<ExecReply>;
	origin?: (cwd: string) => ExecReply | Promise<ExecReply>;
	lsRemote?: (source: string) => ExecReply | Promise<ExecReply>;
}

/**
 * One dispatcher for every `git` call a test sees: route each subcommand to a
 * handler and fall back to a sensible reply. Tests override only what they
 * care about.
 */
function fakeGit(handlers: GitHandlers = {}) {
	return mockPi(async (_cmd, args, options) => {
		if (args[0] === "clone") {
			const dest = args[args.length - 1];
			const source = args[args.length - 2];
			return (
				(await handlers.clone?.({ args, dest, source, options })) ??
				OK_REPLY
			);
		}
		if (args[0] === "ls-remote") {
			const source = args[args.length - 1];
			return (await handlers.lsRemote?.(source)) ?? NOT_A_REPO_REPLY;
		}
		const cwd = args.includes("-C") ? args[args.indexOf("-C") + 1] : "";
		if (args.includes("rev-parse")) {
			return (await handlers.head?.(cwd)) ?? NOT_A_REPO_REPLY;
		}
		if (args.includes("remote")) {
			return (await handlers.origin?.(cwd)) ?? NOT_A_REPO_REPLY;
		}
		return OK_REPLY;
	});
}

function makeRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
	return {
		raw: "owner/repo",
		host: "github",
		cloneUrl: "https://github.com/owner/repo.git",
		branch: null,
		displayName: "owner/repo",
		dirName: "repo",
		...overrides,
	};
}

describe("ensureRepoCloned", () => {
	it("returns reused when a clone target is already present", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const repoDir = join(tempspace, "repo");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(join(repoDir, ".git"), { recursive: true });

		const result = await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit({
				head: () => ({
					stdout: "abc123\n",
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("reused");
	});

	it("returns cloned when git clone succeeds", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const result = await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit(),
		);

		expect(result.status).toBe("cloned");
	});

	it("returns failed when default branch clone fails", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const result = await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit({
				clone: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Failed to clone");
		expect(result.error).toContain("fatal: not found");
	});

	it("includes stderr when the clone command rejects", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const result = await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit({
				clone: () => {
					throw Object.assign(new Error("git failed"), {
						stderr: "fatal: authentication failed",
					});
				},
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("fatal: authentication failed");
	});

	it("reports clone aborted and skips ls-remote when the signal is already aborted", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const controller = new AbortController();
		controller.abort();
		let lsRemoteCalls = 0;

		const result = await ensureRepoCloned(
			makeRepo({ raw: "owner/repo:develop", branch: "develop" }),
			tempspace,
			controller.signal,
			fakeGit({
				clone: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
				lsRemote: () => {
					lsRemoteCalls++;
					return OK_REPLY;
				},
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("aborted");
		expect(lsRemoteCalls).toBe(0);
	});

	it("fails with a collision message when the existing repo has a different origin", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const repoDir = join(tempspace, "repo");
		mkdirSync(join(repoDir, ".git"), { recursive: true });

		const result = await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit({
				head: () => ({
					stdout: "abc123\n",
					stderr: "",
					code: 0,
					killed: false,
				}),
				origin: () => ({
					stdout: "https://github.com/owner/other.git\n",
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.reason).toBe("collision");
		expect(result.error).toContain("collision");
		expect(result.error).toContain("https://github.com/owner/other.git");
		expect(result.error).toContain("https://github.com/owner/repo.git");
	});

	it("falls back to reused when the origin cannot be determined", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const repoDir = join(tempspace, "repo");
		mkdirSync(join(repoDir, ".git"), { recursive: true });

		const result = await ensureRepoCloned(
			makeRepo({ raw: "~/local-repo", cloneUrl: "~/local-repo" }),
			tempspace,
			undefined,
			fakeGit({
				head: () => ({
					stdout: "abc123\n",
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("reused");
	});

	it("tries only the explicit branch (no fallback)", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const branchesTried: string[] = [];

		const result = await ensureRepoCloned(
			makeRepo({ raw: "owner/repo:develop", branch: "develop" }),
			tempspace,
			undefined,
			fakeGit({
				clone: ({ args }) => {
					const branchIdx = args.indexOf("--branch");
					if (branchIdx !== -1) {
						branchesTried.push(args[branchIdx + 1]);
					}
					return {
						stdout: "",
						stderr: "",
						code: 1,
						killed: false,
					};
				},
			}),
		);

		expect(result.status).toBe("failed");
		expect(branchesTried).toEqual(["develop"]);
		expect(result.error).toContain("ref 'develop'");
	});

	it("suggests similar branches when explicit branch clone fails", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const lsRemoteOutput = [
			"abc12345deadbeef\trefs/heads/main",
			"def67890cafebabe\trefs/heads/develop",
			"1111222233334444\trefs/heads/feature/foo",
			"5555666677778888\trefs/heads/release/v2",
			"99990000aaaabbbb\trefs/heads/experiment",
		].join("\n");

		// git clone fails, git ls-remote succeeds with branches.
		const result = await ensureRepoCloned(
			makeRepo({ raw: "owner/repo:mian", branch: "mian" }),
			tempspace,
			undefined,
			fakeGit({
				clone: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
				lsRemote: () => ({
					stdout: lsRemoteOutput,
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'mian'");
		expect(result.error).toContain("main");
		expect(result.error).not.toContain("develop");
	});

	it("does not include suggestions when ls-remote fails", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const result = await ensureRepoCloned(
			makeRepo({ raw: "owner/repo:mian", branch: "mian" }),
			tempspace,
			undefined,
			fakeGit({
				clone: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
				lsRemote: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'mian'");
		expect(result.error).not.toContain("Did you mean");
	});

	it("excludes branches that are not fuzzy-close", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);

		const lsRemoteOutput = [
			"abc12345deadbeef\trefs/heads/main",
			"def67890cafebabe\trefs/heads/develop",
		].join("\n");

		const result = await ensureRepoCloned(
			makeRepo({ raw: "owner/repo:production", branch: "production" }),
			tempspace,
			undefined,
			fakeGit({
				clone: () => ({
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				}),
				lsRemote: () => ({
					stdout: lsRemoteOutput,
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'production'");
		// "production" is too dissimilar from "main" and "develop" → no suggestion appended
		expect(result.error).not.toContain("Did you mean");
	});

	it("omits --branch when no explicit branch is given", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let hadBranchFlag = false;

		await ensureRepoCloned(
			makeRepo(),
			tempspace,
			undefined,
			fakeGit({
				clone: ({ args }) => {
					hadBranchFlag = args.includes("--branch");
					return OK_REPLY;
				},
			}),
		);

		expect(hadBranchFlag).toBe(false);
	});

	it("expands leading tilde in local cloneUrl before passing to git", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let receivedSource = "";

		await ensureRepoCloned(
			makeRepo({ raw: "~/my-repo", cloneUrl: "~/my-repo" }),
			tempspace,
			undefined,
			fakeGit({
				clone: ({ source }) => {
					receivedSource = source;
					return OK_REPLY;
				},
			}),
		);

		expect(receivedSource.startsWith("~")).toBe(false);
		expect(receivedSource).toBe(join(homedir(), "my-repo"));
	});

	describe("atomic publish and failure classification", () => {
		const repo = makeRepo();

		it("runs one clone and resolves both callers when two callers race", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);

			let cloneCalls = 0;
			let releaseGate: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});

			const pi = fakeGit({
				clone: async ({ dest }) => {
					mkdirSync(join(dest, ".git"), { recursive: true });
					writeFileSync(join(dest, "MARKER"), "content");
					cloneCalls++;
					await gate;
					return OK_REPLY;
				},
				head: (cwd) =>
					existsSync(cwd) ? HEAD_OK_REPLY : NOT_A_REPO_REPLY,
			});

			// Create both callers before releasing the clone gate, so the second
			// joins the first's in-flight clone instead of racing it.
			const first = ensureRepoCloned(repo, tempspace, undefined, pi);
			const second = ensureRepoCloned(repo, tempspace, undefined, pi);
			releaseGate();
			const results = await Promise.all([first, second]);

			expect(cloneCalls).toBe(1);
			expect(results.map((r) => r.status)).toEqual(["cloned", "cloned"]);

			const target = join(tempspace, "repo");
			expect(existsSync(join(target, ".git"))).toBe(true);
			expect(existsSync(join(target, "MARKER"))).toBe(true);
			expect(readdirSync(tempspace)).toEqual(["repo"]);
		});

		it("reuses a valid target published by another process during the clone", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const target = join(tempspace, "repo");

			const pi = fakeGit({
				clone: () => {
					// A second process publishes the clone target while we clone.
					mkdirSync(join(target, ".git"), { recursive: true });
					writeFileSync(join(target, "WINNER"), "content");
					return OK_REPLY;
				},
				head: (cwd) =>
					existsSync(cwd) ? HEAD_OK_REPLY : NOT_A_REPO_REPLY,
			});

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				pi,
			);

			expect(result.status).toBe("reused");
			expect(existsSync(join(target, "WINNER"))).toBe(true);
			expect(readdirSync(tempspace)).toEqual(["repo"]);
		});

		it("classifies a killed clone with no abort signal as a timeout", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({
					clone: () => ({
						stdout: "",
						stderr: "",
						code: 1,
						killed: true,
					}),
				}),
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toBe("timeout");
			expect(result.error).toContain("timed out");
			expect(readdirSync(tempspace)).toEqual([]);
		});

		it("classifies a killed clone on an aborted signal as aborted", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const controller = new AbortController();
			controller.abort();

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				controller.signal,
				fakeGit({
					clone: () => ({
						stdout: "",
						stderr: "",
						code: 1,
						killed: true,
					}),
				}),
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toBe("aborted");
			expect(result.error).toContain("aborted");
			// The caller returns on abort; the shared clone cleans up after.
			await vi.waitFor(() => expect(readdirSync(tempspace)).toEqual([]));
		});

		it("redacts credentials from git stderr in the failure message", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);

			const result = await ensureRepoCloned(
				makeRepo({
					raw: "https://token:secret@github.com/owner/repo",
					cloneUrl: "https://token:secret@github.com/owner/repo.git",
				}),
				tempspace,
				undefined,
				fakeGit({
					clone: () => ({
						stdout: "",
						stderr: "fatal: could not read from https://token:secret@github.com/owner/repo.git",
						code: 128,
						killed: false,
					}),
				}),
			);

			expect(result.status).toBe("failed");
			expect(result.error).not.toContain("secret");
			expect(result.error).toContain("[credentials]");
		});

		it("removes a temporary directory that holds read-only pack files", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({
					clone: ({ dest }) => {
						const packDir = join(dest, ".git", "objects", "pack");
						mkdirSync(packDir, { recursive: true });
						const packFile = join(packDir, "pack-abc.pack");
						writeFileSync(packFile, "data");
						chmodSync(packFile, 0o444);
						return {
							stdout: "",
							stderr: "fatal: not found",
							code: 128,
							killed: false,
						};
					},
				}),
			);

			expect(result.status).toBe("failed");
			expect(readdirSync(tempspace)).toEqual([]);
		});

		it("removes its temporary directory and leaves no clone target on failure", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({
					clone: () => ({
						stdout: "",
						stderr: "fatal: not found",
						code: 128,
						killed: false,
					}),
				}),
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toBe("clone");
			expect(existsSync(repoDir)).toBe(false);
			expect(readdirSync(tempspace)).toEqual([]);
		});
	});

	describe("clone target verification", () => {
		const repo = makeRepo();

		it("does not reuse a target whose repository has no resolvable HEAD", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			mkdirSync(join(repoDir, ".git"), { recursive: true });

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({
					head: () => ({
						stdout: "",
						stderr: "",
						code: 1,
						killed: false,
					}),
				}),
			);

			expect(result.status).not.toBe("reused");
			expect(result.reason).toBe("invalidTarget");
		});

		it("reports a collision when the target holds a different origin", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			mkdirSync(join(repoDir, ".git"), { recursive: true });

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({
					head: () => HEAD_OK_REPLY,
					origin: () => ({
						stdout: "https://github.com/owner/other.git\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				}),
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toBe("collision");
			expect(result.error).toContain(
				"https://github.com/owner/other.git",
			);
			expect(result.error).toContain("https://github.com/owner/repo.git");
		});

		it("reuses a HEAD-valid target whose origin cannot be read", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			mkdirSync(join(repoDir, ".git"), { recursive: true });

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				fakeGit({ head: () => HEAD_OK_REPLY }),
			);

			expect(result.status).toBe("reused");
		});
	});

	describe("invalid clone target recovery", () => {
		const repo = makeRepo();

		/** No resolvable HEAD at the target; the clone publishes a valid one. */
		function cloneSucceeds() {
			return fakeGit({
				clone: ({ dest }) => {
					mkdirSync(join(dest, ".git"), { recursive: true });
					writeFileSync(join(dest, "README.md"), "content");
					return OK_REPLY;
				},
			});
		}

		it("heals an empty leftover target and publishes the clone there", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			// An empty leftover target from a platform quirk or a prior crash.
			mkdirSync(repoDir, { recursive: true });

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				cloneSucceeds(),
			);

			expect(result.status).toBe("cloned");
			expect(existsSync(join(repoDir, ".git"))).toBe(true);
			expect(existsSync(join(repoDir, "README.md"))).toBe(true);
		});

		it("fails with an actionable message when the target is a non-empty non-clone", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			mkdirSync(repoDir, { recursive: true });
			writeFileSync(join(repoDir, "SENTINEL"), "keep me");

			const result = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				cloneSucceeds(),
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toBe("invalidTarget");
			expect(result.error).toContain(repoDir);
			expect(result.error).toContain("must be removed");
			// No code path deletes a non-empty target.
			expect(existsSync(join(repoDir, "SENTINEL"))).toBe(true);
		});

		it("succeeds when the user removes the named path and retries", async () => {
			const tempspace = mkdtempSync(
				join(tmpdir(), "repo-query-clone-test-"),
			);
			tempDirs.push(tempspace);
			const repoDir = join(tempspace, "repo");
			mkdirSync(repoDir, { recursive: true });
			writeFileSync(join(repoDir, "SENTINEL"), "keep me");

			const first = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				cloneSucceeds(),
			);
			expect(first.status).toBe("failed");

			// The user follows the message and removes the named path.
			rmSync(repoDir, { recursive: true, force: true });

			const retry = await ensureRepoCloned(
				repo,
				tempspace,
				undefined,
				cloneSucceeds(),
			);

			expect(retry.status).toBe("cloned");
			expect(existsSync(join(repoDir, ".git"))).toBe(true);
		});
	});
});

describe("concurrent clone dedupe", () => {
	const repo = makeRepo();

	it("shares one in-flight clone between two callers for one target", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let cloneCalls = 0;
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		const pi = fakeGit({
			clone: async ({ dest }) => {
				mkdirSync(join(dest, ".git"), { recursive: true });
				cloneCalls++;
				await gate;
				return OK_REPLY;
			},
		});

		const first = ensureRepoCloned(repo, tempspace, undefined, pi);
		const second = ensureRepoCloned(repo, tempspace, undefined, pi);
		releaseGate();
		const results = await Promise.all([first, second]);

		expect(cloneCalls).toBe(1);
		expect(results.map((r) => r.status)).toEqual(["cloned", "cloned"]);
		expect(readdirSync(tempspace)).toEqual(["repo"]);
	});

	it("clones different targets in parallel", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const other = makeRepo({
			raw: "owner/other",
			cloneUrl: "https://github.com/owner/other.git",
			dirName: "other",
		});
		let cloneCalls = 0;
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		const pi = fakeGit({
			clone: async ({ dest }) => {
				mkdirSync(join(dest, ".git"), { recursive: true });
				cloneCalls++;
				if (cloneCalls === 2) releaseGate();
				await gate;
				return OK_REPLY;
			},
		});

		const [a, b] = await Promise.all([
			ensureRepoCloned(repo, tempspace, undefined, pi),
			ensureRepoCloned(other, tempspace, undefined, pi),
		]);

		expect(cloneCalls).toBe(2);
		expect([a.status, b.status]).toEqual(["cloned", "cloned"]);
		expect(readdirSync(tempspace).sort()).toEqual(["other", "repo"]);
	});

	it("retries after a shared clone fails", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let cloneCalls = 0;

		const pi = fakeGit({
			clone: ({ dest }) => {
				cloneCalls++;
				if (cloneCalls === 1) {
					return {
						stdout: "",
						stderr: "fatal: network error",
						code: 128,
						killed: false,
					};
				}
				mkdirSync(join(dest, ".git"), { recursive: true });
				return OK_REPLY;
			},
		});

		const first = await ensureRepoCloned(repo, tempspace, undefined, pi);
		expect(first.status).toBe("failed");

		const second = await ensureRepoCloned(repo, tempspace, undefined, pi);
		expect(second.status).toBe("cloned");
		expect(cloneCalls).toBe(2);
	});

	it("keeps the shared clone alive when one caller aborts", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const cloneSignals: Array<AbortSignal | undefined> = [];

		const pi = fakeGit({
			clone: async ({ dest, options }) => {
				cloneSignals.push(options?.signal);
				mkdirSync(join(dest, ".git"), { recursive: true });
				await gate;
				return OK_REPLY;
			},
		});

		const controller = new AbortController();
		const first = ensureRepoCloned(repo, tempspace, controller.signal, pi);
		const second = ensureRepoCloned(repo, tempspace, undefined, pi);
		await Promise.resolve();

		controller.abort();
		releaseGate();
		const [a, b] = await Promise.all([first, second]);

		expect(a.reason).toBe("aborted");
		expect(b.status).toBe("cloned");
		// The clone kept the shared signal; one caller's abort did not cancel it.
		expect(cloneSignals[0]?.aborted).toBe(false);
	});

	it("cancels the shared clone when every caller aborts", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let cloneSignal: AbortSignal | undefined;

		const pi = fakeGit({
			clone: async ({ dest, options }) => {
				cloneSignal = options?.signal;
				mkdirSync(join(dest, ".git"), { recursive: true });
				await gate;
				return OK_REPLY;
			},
		});

		const c1 = new AbortController();
		const c2 = new AbortController();
		const first = ensureRepoCloned(repo, tempspace, c1.signal, pi);
		const second = ensureRepoCloned(repo, tempspace, c2.signal, pi);
		await Promise.resolve();

		c1.abort();
		c2.abort();
		const [a, b] = await Promise.all([first, second]);

		expect(a.reason).toBe("aborted");
		expect(b.reason).toBe("aborted");

		releaseGate();
		await vi.waitFor(() => expect(cloneSignal?.aborted).toBe(true));
		await vi.waitFor(() => expect(readdirSync(tempspace)).toEqual([]));
	});

	it("does not share a clone between different origins for one target", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		const colliding = makeRepo({
			raw: "other/repo",
			cloneUrl: "https://github.com/other/repo.git",
		});
		let cloneCalls = 0;
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		const pi = fakeGit({
			head: (cwd) =>
				existsSync(join(cwd, ".git"))
					? HEAD_OK_REPLY
					: NOT_A_REPO_REPLY,
			clone: async ({ dest, source }) => {
				mkdirSync(join(dest, ".git"), { recursive: true });
				writeFileSync(join(dest, "origin.txt"), source);
				cloneCalls++;
				if (cloneCalls === 2) releaseGate();
				await gate;
				return OK_REPLY;
			},
			origin: (cwd) => {
				const originPath = join(cwd, "origin.txt");
				if (!existsSync(originPath)) {
					return NOT_A_REPO_REPLY;
				}
				return {
					stdout: readFileSync(originPath, "utf8"),
					stderr: "",
					code: 0,
					killed: false,
				};
			},
		});

		const [a, b] = await Promise.all([
			ensureRepoCloned(repo, tempspace, undefined, pi),
			ensureRepoCloned(colliding, tempspace, undefined, pi),
		]);

		// Different origins must not share a registry entry.
		expect(cloneCalls).toBe(2);
		const failed = [a, b].find((r) => r.status === "failed");
		expect(failed?.reason).toBe("collision");
	});

	it("aborts in-flight clones when the registry is cleared", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(tempspace);
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let cloneSignal: AbortSignal | undefined;

		const pi = fakeGit({
			clone: async ({ dest, options }) => {
				cloneSignal = options?.signal;
				mkdirSync(join(dest, ".git"), { recursive: true });
				await gate;
				return OK_REPLY;
			},
		});

		const caller = ensureRepoCloned(repo, tempspace, undefined, pi);
		await vi.waitFor(() => expect(cloneSignal).toBeDefined());
		expect(cloneSignal?.aborted).toBe(false);

		expect(clearInFlightClones()).toBe(1);
		expect(cloneSignal?.aborted).toBe(true);

		releaseGate();
		const result = await caller;
		expect(result.reason).toBe("aborted");
		await vi.waitFor(() => expect(readdirSync(tempspace)).toEqual([]));
	});
});
