import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ensureRepoCloned } from "../../src/clone.js";
import type { ParsedRepo } from "../../src/types.js";

function mockPi(
	execImpl: (
		command: string,
		args: string[],
	) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>,
) {
	return {
		exec: execImpl,
	} as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;
}

describe("ensureRepoCloned", () => {
	it("returns existing when .git is present", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		const repoDir = join(workspace, "repo");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(join(repoDir, ".git"), { recursive: true });

		const result = await ensureRepoCloned(
			{ raw: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		);

		expect(result.status).toBe("existing");
	});

	it("returns cloned when git clone succeeds", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));

		const result = await ensureRepoCloned(
			{ raw: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => {
				// Simulate successful clone by creating .git
				mkdirSync(join(workspace, "repo", ".git"), { recursive: true });
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
		);

		expect(result.status).toBe("cloned");
	});

	it("returns failed when git clone fails for all branches", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));

		const result = await ensureRepoCloned(
			{ raw: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async () => ({ stdout: "", stderr: "fatal: not found", code: 128, killed: false })),
		);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Failed to clone");
	});

	it("tries only the explicit branch (no fallback)", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
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
		expect(result.error).toContain("branch 'develop'");
	});

	it("omits --branch when no explicit branch is given", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		let hadBranchFlag = false;

		await ensureRepoCloned(
			{ raw: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, args) => {
				hadBranchFlag = args.includes("--branch");
				// Simulate success by creating .git so next call returns existing
				mkdirSync(join(workspace, "repo", ".git"), { recursive: true });
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
		);

		expect(hadBranchFlag).toBe(false);
	});

	it("expands leading tilde in local cloneUrl before passing to git", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		let receivedSource = "";

		await ensureRepoCloned(
			{ raw: "~/my-repo", cloneUrl: "~/my-repo", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (_cmd, args) => {
				receivedSource = args[args.length - 2] ?? "";
				// Simulate success by creating .git so next call returns existing
				mkdirSync(join(workspace, "repo", ".git"), { recursive: true });
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
		);

		expect(receivedSource.startsWith("~")).toBe(false);
		expect(receivedSource).toBe(join(homedir(), "my-repo"));
	});

	it("cleans up with fs.rm instead of pi.exec rm on failure", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-clone-test-"));
		const execCalls: Array<{ cmd: string; args: string[] }> = [];

		const result = await ensureRepoCloned(
			{ raw: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", dirName: "repo" } as ParsedRepo,
			workspace,
			undefined,
			mockPi(async (cmd, args) => {
				execCalls.push({ cmd, args });
				return { stdout: "", stderr: "fatal: not found", code: 128, killed: false };
			}),
		);

		expect(result.status).toBe("failed");
		// Ensure pi.exec was never called with "rm" command
		const rmCalls = execCalls.filter((c) => c.cmd === "rm");
		expect(rmCalls).toHaveLength(0);
	});
});
