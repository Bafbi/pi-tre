import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTempspaceCache } from "../../src/tempspace.js";
import {
	captureExtension,
	cleanupDirs,
	createRunner,
	makeTempDir,
	minimalContext,
} from "../helpers/create-runner.js";

let gitAvailable = false;
try {
	execSync("git --version", { stdio: "ignore" });
	gitAvailable = true;
} catch {
	/* git not available */
}

const tempDirs: string[] = [];
const tempspacesToClean: string[] = [];

afterEach(async () => {
	await cleanupDirs(tempDirs);
	await cleanupDirs(tempspacesToClean);
	clearTempspaceCache();
});

describe("repo-query extension", () => {
	it("loads from configured path and registers tool + command", async () => {
		const cwd = makeTempDir("repo-query-ext-test-");
		tempDirs.push(cwd);
		const runner = await createRunner(cwd);

		expect(runner.hasHandlers("session_start")).toBe(true);

		const debugCommand = runner.getCommand("repo-query-debug");
		expect(debugCommand).toBeDefined();
		expect(debugCommand?.invocationName).toBe("repo-query-debug");
	});

	it.skipIf(!gitAvailable)(
		"repo_query tool explores a local git repo successfully",
		async () => {
			const cwd = makeTempDir("repo-query-ext-test-");
			tempDirs.push(cwd);

			// Create a fake local git repo
			const localRepo = join(cwd, "my-local-repo");
			mkdirSync(localRepo, { recursive: true });
			writeFileSync(
				join(localRepo, "README.md"),
				"# My Local Repo\n\nThis is a test repo.\n",
				"utf8",
			);
			writeFileSync(
				join(localRepo, "main.ts"),
				'console.log("hello");\n',
				"utf8",
			);

			// Initialize git repo
			execSync("git init", { cwd: localRepo, stdio: "ignore" });
			execSync("git config user.email 'test@test.com'", {
				cwd: localRepo,
				stdio: "ignore",
			});
			execSync("git config user.name 'Test'", {
				cwd: localRepo,
				stdio: "ignore",
			});
			execSync("git add .", { cwd: localRepo, stdio: "ignore" });
			execSync("git commit -m 'init'", {
				cwd: localRepo,
				stdio: "ignore",
			});

			// Mock only the subagent; the clone runs for real via pi.exec.
			const { getTool } = captureExtension({
				explorer: async () => ({ answer: "Mock exploration result" }),
			});
			const repoQueryTool = getTool();
			expect(repoQueryTool).toBeDefined();
			if (!repoQueryTool) throw new Error("repo_query tool not found");

			const result = await repoQueryTool.execute(
				"test-call-1",
				{ query: "What files are in this repo?", repos: [localRepo] },
				undefined,
				undefined,
				minimalContext(cwd),
			);

			expect(result).toBeDefined();
			expect(result.content).toBeDefined();
			expect(result.content.length).toBeGreaterThan(0);

			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			expect(text).toContain("Mock exploration result");
			expect(text).toContain("# Answer");

			const details = result.details as {
				results: Array<{ status: string; localPath?: string }>;
				tempspacePath: string;
				answer?: string;
			};
			expect(details.results[0]?.status).toBe("success");
			expect(details.answer).toBe("Mock exploration result");

			// The tempspace holds a real clone of the local repo
			const localPath = details.results[0]?.localPath;
			expect(localPath).toBeDefined();
			expect(localPath?.startsWith(details.tempspacePath)).toBe(true);
			expect(existsSync(join(localPath ?? "", ".git"))).toBe(true);

			tempspacesToClean.push(details.tempspacePath);
		},
		30000,
	);
});
