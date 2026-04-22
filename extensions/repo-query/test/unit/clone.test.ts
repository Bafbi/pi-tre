import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

	it("tries explicit branch then falls back to defaults", async () => {
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
		expect(branchesTried).toEqual(["develop", "main", "master"]);
	});
});
