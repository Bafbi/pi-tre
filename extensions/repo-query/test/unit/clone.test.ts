import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureRepoCloned } from "../../src/clone.js";
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

describe("ensureRepoCloned", () => {
	it("returns existing when .git is present", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);
		const repoDir = join(workspace, "repo");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(join(repoDir, ".git"), { recursive: true });

		const result = await ensureRepoCloned(
			{
				raw: "owner/repo",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({
				stdout: "",
				stderr: "",
				code: 0,
				killed: false,
			})),
		);

		expect(result.status).toBe("existing");
	});

	it("returns cloned when git clone succeeds", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);

		const result = await ensureRepoCloned(
			{
				raw: "owner/repo",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({
				stdout: "",
				stderr: "",
				code: 0,
				killed: false,
			})),
		);

		expect(result.status).toBe("cloned");
	});

	it("returns failed when default branch clone fails", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);

		const result = await ensureRepoCloned(
			{
				raw: "owner/repo",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({
				stdout: "",
				stderr: "fatal: not found",
				code: 128,
				killed: false,
			})),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Failed to clone");
	});

	it("tries only the explicit branch (no fallback)", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);
		const branchesTried: string[] = [];

		const result = await ensureRepoCloned(
			{
				raw: "owner/repo:develop",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
				branch: "develop",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, args) => {
				const branchIdx = args.indexOf("--branch");
				if (branchIdx !== -1) {
					branchesTried.push(args[branchIdx + 1]);
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			}),
		);

		expect(result.status).toBe("failed");
		expect(branchesTried).toEqual(["develop"]);
		expect(result.error).toContain("ref 'develop'");
	});

	it("suggests similar branches when explicit branch clone fails", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);

		const lsRemoteOutput = [
			"abc12345deadbeef\trefs/heads/main",
			"def67890cafebabe\trefs/heads/develop",
			"1111222233334444\trefs/heads/feature/foo",
			"5555666677778888\trefs/heads/release/v2",
			"99990000aaaabbbb\trefs/heads/experiment",
		].join("\n");

		// First exec call = git clone (fails), second = git ls-remote (succeeds with branches)
		let callCount = 0;
		const result = await ensureRepoCloned(
			{
				raw: "owner/repo:mian",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
				branch: "mian",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, _args) => {
				callCount++;
				if (callCount === 1) {
					// git clone fails
					return {
						stdout: "",
						stderr: "fatal: not found",
						code: 128,
						killed: false,
					};
				}
				// git ls-remote succeeds
				return {
					stdout: lsRemoteOutput,
					stderr: "",
					code: 0,
					killed: false,
				};
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'mian'");
		expect(result.error).toContain("main");
		expect(result.error).not.toContain("develop");
	});

	it("does not include suggestions when ls-remote fails", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);

		let _callCount = 0;
		const result = await ensureRepoCloned(
			{
				raw: "owner/repo:mian",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
				branch: "mian",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => {
				_callCount++;
				// Both calls fail
				return {
					stdout: "",
					stderr: "fatal: not found",
					code: 128,
					killed: false,
				};
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'mian'");
		expect(result.error).not.toContain("Did you mean");
	});

	it("excludes branches that are not fuzzy-close", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);

		const lsRemoteOutput = [
			"abc12345deadbeef\trefs/heads/main",
			"def67890cafebabe\trefs/heads/develop",
		].join("\n");

		let callCount = 0;
		const result = await ensureRepoCloned(
			{
				raw: "owner/repo:production",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
				branch: "production",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, _args) => {
				callCount++;
				if (callCount === 1) {
					return {
						stdout: "",
						stderr: "fatal: not found",
						code: 128,
						killed: false,
					};
				}
				return {
					stdout: lsRemoteOutput,
					stderr: "",
					code: 0,
					killed: false,
				};
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("ref 'production'");
		// "production" is too dissimilar from "main" and "develop" → no suggestion appended
		expect(result.error).not.toContain("Did you mean");
	});

	it("omits --branch when no explicit branch is given", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);
		let hadBranchFlag = false;

		await ensureRepoCloned(
			{
				raw: "owner/repo",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, args) => {
				hadBranchFlag = args.includes("--branch");
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
		);

		expect(hadBranchFlag).toBe(false);
	});

	it("expands leading tilde in local cloneUrl before passing to git", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);
		let receivedSource = "";

		await ensureRepoCloned(
			{
				raw: "~/my-repo",
				cloneUrl: "~/my-repo",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, args) => {
				receivedSource = args[args.length - 2] ?? "";
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
		);

		expect(receivedSource.startsWith("~")).toBe(false);
		expect(receivedSource).toBe(join(homedir(), "my-repo"));
	});

	it("removes partial repo directory on clone failure", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		tempDirs.push(workspace);
		const repoDir = join(workspace, "repo");

		const result = await ensureRepoCloned(
			{
				raw: "owner/repo",
				cloneUrl: "https://github.com/owner/repo.git",
				dirName: "repo",
			} as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({
				stdout: "",
				stderr: "fatal: not found",
				code: 128,
				killed: false,
			})),
		);

		expect(result.status).toBe("failed");
		expect(existsSync(repoDir)).toBe(false);
	});
});
