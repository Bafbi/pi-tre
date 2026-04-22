import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	AuthStorage,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	discoverAndLoadExtensions,
} from "@mariozechner/pi-coding-agent";

import { setTestExplorerImpl } from "../../src/explorer.js";
import { clearWorkspaceCache } from "../../src/workspace.js";

const tempDirs: string[] = [];

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-query-ext-test-"));
	tempDirs.push(dir);
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

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
	setTestExplorerImpl(undefined);
	clearWorkspaceCache();
});

describe("repo-query extension", () => {
	it("loads from configured path and registers tool + command", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		expect(runner.hasHandlers("session_start")).toBe(true);

		const debugCommand = runner.getCommand("repo-query-debug");
		expect(debugCommand).toBeDefined();
		expect(debugCommand?.invocationName).toBe("repo-query-debug");
	});

	it("parses repo identifiers correctly", async () => {
		const { parseRepoIdentifier } = await import("../../src/resolver.js");

		// GitHub shorthand
		const github = parseRepoIdentifier("facebook/react");
		expect(github.host).toBe("github");
		expect(github.displayName).toBe("facebook/react");
		expect(github.branch).toBeNull();

		// With branch
		const withBranch = parseRepoIdentifier("vuejs/vue:main");
		expect(withBranch.host).toBe("github");
		expect(withBranch.branch).toBe("main");

		// Full URL
		const url = parseRepoIdentifier("https://gitlab.com/foo/bar");
		expect(url.host).toBe("gitlab");
		expect(url.cloneUrl).toBe("https://gitlab.com/foo/bar.git");

		// Local path
		const local = parseRepoIdentifier("/tmp/my-repo");
		expect(local.host).toBe("generic");
		expect(local.cloneUrl).toBe("/tmp/my-repo");
	});

	it("repo_query tool explores a local git repo successfully", async () => {
		const cwd = makeRunnerCwd();

		// Create a fake local git repo
		const localRepo = join(cwd, "my-local-repo");
		mkdirSync(localRepo, { recursive: true });
		writeFileSync(join(localRepo, "README.md"), "# My Local Repo\n\nThis is a test repo.\n", "utf8");
		writeFileSync(join(localRepo, "main.ts"), 'console.log("hello");\n', "utf8");

		// Initialize git repo
		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: localRepo });
		execSync("git config user.email 'test@test.com'", { cwd: localRepo });
		execSync("git config user.name 'Test'", { cwd: localRepo });
		execSync("git add .", { cwd: localRepo });
		execSync("git commit -m 'init'", { cwd: localRepo });

		const runner = await createRunner(cwd);

		// Get the tool and execute it directly
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		// Always mock the explorer in this test — we are inside vitest, not a real pi process,
		// so subagent spawning via getPiInvocation() would fail.
		setTestExplorerImpl(async () => ({ answer: "README.md, main.ts" }));

		const result = await repoQueryTool.definition.execute(
			"test-call-1",
			{ query: "What files are in this repo?", repos: [localRepo] },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(result).toBeDefined();
		expect(result.content).toBeDefined();
		expect(result.content.length).toBeGreaterThan(0);

		const text = result.content[0]?.text ?? "";
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain("README.md");

		const details = result.details as { results: Array<{ status: string }> };
		expect(details.results[0]?.status).toBe("success");
	}, 30000);

	it("repo_query tool clones a remote local git repo into workspace", async () => {
		const cwd = makeRunnerCwd();

		// Create a source git repo (the "remote")
		const sourceRepo = join(cwd, "source-repo");
		mkdirSync(sourceRepo, { recursive: true });
		writeFileSync(join(sourceRepo, "README.md"), "# Source Repo\n", "utf8");
		writeFileSync(join(sourceRepo, "index.js"), 'console.log("source");\n', "utf8");

		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: sourceRepo });
		execSync("git config user.email 'test@test.com'", { cwd: sourceRepo });
		execSync("git config user.name 'Test'", { cwd: sourceRepo });
		execSync("git add .", { cwd: sourceRepo });
		execSync("git commit -m 'init'", { cwd: sourceRepo });

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		setTestExplorerImpl(async () => ({ answer: "Cloned and explored" }));

		const result = await repoQueryTool.definition.execute(
			"test-call-clone",
			{ query: "What files are in this repo?", repos: [sourceRepo] },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(result.isError).toBe(false);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Cloned and explored");

		const details = result.details as {
			results: Array<{ status: string; localPath?: string }>;
			workspacePath: string;
		};
		expect(details.results[0]?.status).toBe("success");

		// Verify the repo was actually cloned into the workspace
		const clonedPath = details.results[0]?.localPath;
		expect(clonedPath).toBeDefined();
		expect(clonedPath?.startsWith(details.workspacePath)).toBe(true);
	}, 30000);
});
