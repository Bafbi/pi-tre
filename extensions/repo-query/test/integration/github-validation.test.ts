import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	const dir = mkdtempSync(join(tmpdir(), "repo-query-gh-test-"));
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

interface FetchMockConfig {
	/** URL -> Response body (for 200) or Error status code (for thrown errors) */
	responses: Map<string, object | number>;
}

function mockGitHubApi(config: FetchMockConfig) {
	const originalFetch = globalThis.fetch;
	const mockedFetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const match = config.responses.get(url);
		if (match === undefined) {
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		}
		if (typeof match === "number") {
			return new Response(JSON.stringify({ message: "Error" }), { status: match });
		}
		return new Response(JSON.stringify(match), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	globalThis.fetch = mockedFetch as unknown as typeof fetch;
	return {
		mockedFetch,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

describe("repo_query GitHub validation", () => {
	beforeEach(() => {
		setTestExplorerImpl(undefined);
	});

	afterEach(() => {
		setTestExplorerImpl(undefined);
	});

	it("proceeds with exploration for valid GitHub repo", async () => {
		const cwd = makeRunnerCwd();
		const gh = mockGitHubApi({
			responses: new Map([
				["https://api.github.com/repos/owner/repo", { archived: false, pushed_at: "2024-01-01T00:00:00Z" }],
			]),
		});

		setTestExplorerImpl(async () => ({ answer: "Mock exploration result" }));

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const result = await repoQueryTool.definition.execute(
			"test-call-1",
			{ query: "What is the main entry point?", repos: ["owner/repo"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		gh.restore();

		expect(result.isError).toBe(false);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Mock exploration result");
		const details = result.details as { results: Array<{ status: string }> };
		expect(details.results[0]?.status).toBe("success");
	});

	it("marks archived repo with warning but still explores", async () => {
		const cwd = makeRunnerCwd();
		const gh = mockGitHubApi({
			responses: new Map([
				["https://api.github.com/repos/owner/archived", { archived: true, pushed_at: "2020-01-01T00:00:00Z" }],
			]),
		});

		setTestExplorerImpl(async () => ({ answer: "Archived exploration result" }));

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const result = await repoQueryTool.definition.execute(
			"test-call-2",
			{ query: "What is the main entry point?", repos: ["owner/archived"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		gh.restore();

		expect(result.isError).toBe(false);
		const details = result.details as { results: Array<{ status: string; warnings: string[] }> };
		expect(details.results[0]?.status).toBe("archived");
		expect(details.results[0]?.warnings.some((w) => w.includes("archived"))).toBe(true);
	});

	it("returns not_found with suggestions for missing repo", async () => {
		const cwd = makeRunnerCwd();
		const gh = mockGitHubApi({
			responses: new Map([
				[
					"https://api.github.com/search/repositories?q=missing%20user%3Aowner&sort=stars&order=desc&per_page=5",
					{ items: [{ full_name: "owner/real-repo" }, { full_name: "other/repo" }] },
				],
			]),
		});

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const result = await repoQueryTool.definition.execute(
			"test-call-3",
			{ query: "What is the main entry point?", repos: ["owner/missing"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		gh.restore();

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("owner/missing");
		expect(text).toContain("not found");
		expect(text).toContain("owner/real-repo");
	});

	it("proceeds with clone when GitHub API fails unexpectedly", async () => {
		const cwd = makeRunnerCwd();
		const gh = mockGitHubApi({
			responses: new Map([["https://api.github.com/repos/owner/repo", 500]]),
		});

		setTestExplorerImpl(async () => ({ answer: "Fallback exploration result" }));

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const result = await repoQueryTool.definition.execute(
			"test-call-4",
			{ query: "What is the main entry point?", repos: ["owner/repo"] },
			undefined,
			undefined,
			runner.createContext(),
		);

		gh.restore();

		expect(result.isError).toBe(false);
		const details = result.details as { results: Array<{ status: string; warnings: string[] }> };
		expect(details.results[0]?.warnings.some((w) => w.includes("API check failed"))).toBe(true);
	});
});
