import { exec } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	AuthStorage,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { setTestExplorerImpl } from "../../src/explorer.js";
import { clearWorkspaceCache } from "../../src/workspace.js";

const execAsync = promisify(exec);

async function checkGitAvailable(): Promise<boolean> {
	try {
		await execAsync("git --version", { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

async function checkGitHubReachable(): Promise<boolean> {
	try {
		await execAsync("git ls-remote --exit-code https://github.com/biomejs/biome.git HEAD", {
			timeout: 15000,
		});
		return true;
	} catch {
		return false;
	}
}

const skipRemote = !(await checkGitAvailable()) || !(await checkGitHubReachable());

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-query-remote-clone-"));
	return dir;
}

async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolve(process.cwd(), "extensions/repo-query/src/index.ts");
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRegistry = ModelRegistry.create(AuthStorage.create(join(cwd, "auth.json")));
	return new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, modelRegistry);
}

describe.skipIf(skipRemote)("repo_query remote clone", () => {
	const tempDirs: string[] = [];
	const workspacesToClean: string[] = [];

	afterEach(async () => {
		setTestExplorerImpl(undefined);
		clearWorkspaceCache();
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
		for (const ws of workspacesToClean.splice(0)) {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("clones biomejs/biome from GitHub into workspace", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		setTestExplorerImpl(async () => ({ answer: "Mock exploration result" }));

		const result = await repoQueryTool.definition.execute(
			"test-remote-clone-1",
			{ query: "What is the main entry point?", repos: ["biomejs/biome"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(result.isError).toBe(false);

		const details = result.details as {
			results: Array<{ status: string; localPath?: string }>;
			workspacePath: string;
		};

		expect(details.results[0]?.status).toBe("success");
		expect(details.results[0]?.localPath).toBeDefined();

		const localPath = details.results[0]?.localPath;
		expect(localPath).toBeDefined();
		const workspacePath = details.workspacePath;

		// Track workspace for cleanup
		workspacesToClean.push(workspacePath);

		// localPath must be inside workspace
		expect(localPath?.startsWith(workspacePath)).toBe(true);

		// Real git repo present
		expect(existsSync(join(localPath ?? "", ".git"))).toBe(true);

		// Shallow clone confirmed
		expect(existsSync(join(localPath ?? "", ".git", "shallow"))).toBe(true);

		// Content sanity check
		expect(existsSync(join(localPath ?? "", "package.json"))).toBe(true);
	}, 120_000);

	it("reuses workspace on second query for same repo", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		setTestExplorerImpl(async () => ({ answer: "Mock exploration result" }));

		// First call — triggers clone
		const result1 = await repoQueryTool.definition.execute(
			"test-remote-clone-2a",
			{ query: "First query", repos: ["biomejs/biome"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(result1.isError).toBe(false);

		const details1 = result1.details as {
			results: Array<{ status: string; localPath?: string }>;
			workspacePath: string;
		};
		const workspace1 = details1.workspacePath;
		workspacesToClean.push(workspace1);

		// Second call in same process — should reuse via in-memory cache
		const result2 = await repoQueryTool.definition.execute(
			"test-remote-clone-2b",
			{ query: "Second query", repos: ["biomejs/biome"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(result2.isError).toBe(false);

		const details2 = result2.details as {
			results: Array<{ status: string; localPath?: string }>;
			workspacePath: string;
		};

		// Same workspace reused
		expect(details2.workspacePath).toBe(workspace1);

		// Same local path
		expect(details2.results[0]?.localPath).toBe(details1.results[0]?.localPath);

		// Repo still valid (was not re-cloned, just reused)
		const reusedPath = details2.results[0]?.localPath;
		expect(reusedPath).toBeDefined();
		expect(existsSync(join(reusedPath ?? "", ".git"))).toBe(true);
	}, 120_000);
});
