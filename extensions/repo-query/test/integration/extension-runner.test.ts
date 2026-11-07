import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T3_DELEGATE_TOOL } from "../../src/t3-delegate.js";
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

/** Create a committed local git repository for clone-based tests. */
function createLocalRepo(cwd: string, name = "my-local-repo"): string {
	const localRepo = join(cwd, name);
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
	execSync("git commit -m 'init'", { cwd: localRepo, stdio: "ignore" });
	return localRepo;
}

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

			const localRepo = createLocalRepo(cwd);

			// Mock only the subagent; the clone runs for real via pi.exec.
			const { getTool } = captureExtension({
				explorer: async () => ({
					answer: [
						"Mock exploration result",
						"",
						"```json",
						JSON.stringify({
							findings: [
								{
									repo: "my-local-repo",
									path: "main.ts",
									line: 1,
									claim: "The entry point.",
								},
							],
						}),
						"```",
					].join("\n"),
					usage: {
						turns: 1,
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.01,
						totalTokens: 15,
						costFromProvider: true,
					},
				}),
			});
			const repoQueryTool = getTool();
			expect(repoQueryTool).toBeDefined();
			if (!repoQueryTool) throw new Error("repo_query tool not found");
			// Code-mode scripts receive structuredContent only when the tool
			// declares an output schema.
			expect(repoQueryTool.outputSchema).toBeDefined();
			expect(repoQueryTool.annotations?.openWorldHint).toBe(true);

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

			// Code-mode scripts read this shape, not the prose.
			const structured = result.structuredContent as {
				status: string;
				answer: { text: string; complete: boolean } | null;
				repos: Array<{ status: string; localPath: string | null }>;
			};
			expect(result.isError).toBeUndefined();
			expect(structured.status).toBe("ok");
			expect(structured.answer).toEqual({
				text: "Mock exploration result",
				complete: true,
				findings: [
					{
						repo: "my-local-repo",
						path: "main.ts",
						line: 1,
						claim: "The entry point.",
						verified: true,
					},
				],
			});
			expect(text).toContain("## Findings");
			expect(text).toContain("`main.ts:1`");
			expect(structured.repos[0]?.status).toBe("success");
			expect(structured.repos[0]?.localPath).toBe(localPath);
			expect(result.usage?.cost.totalFromProvider).toBe(true);
			expect(result.usage?.totalTokens).toBe(15);

			tempspacesToClean.push(details.tempspacePath);
		},
		30000,
	);

	it.skipIf(!gitAvailable)(
		"marks an exploration failure as an error result with structured data",
		async () => {
			const cwd = makeTempDir("repo-query-ext-test-");
			tempDirs.push(cwd);
			const localRepo = createLocalRepo(cwd);

			const { getTool } = captureExtension({
				explorer: async () => ({
					answer: "",
					error: "Subagent LLM error: provider unavailable",
				}),
			});
			const repoQueryTool = getTool();
			if (!repoQueryTool) throw new Error("repo_query tool not found");

			const result = await repoQueryTool.execute(
				"test-call-fail",
				{ query: "What files are here?", repos: [localRepo] },
				undefined,
				undefined,
				minimalContext(cwd),
			);

			expect(result.isError).toBe(true);
			const structured = result.structuredContent as {
				status: string;
				answer: unknown;
				repos: Array<{ status: string; error: string | null }>;
			};
			expect(structured.status).toBe("failed");
			expect(structured.answer).toBeNull();
			expect(structured.repos[0]?.status).toBe("exploration_failed");
			expect(structured.repos[0]?.error).toContain(
				"provider unavailable",
			);

			const details = result.details as { tempspacePath: string };
			tempspacesToClean.push(details.tempspacePath);
		},
		30000,
	);

	it.skipIf(!gitAvailable)(
		"runs the exploration through a T3 delegate when the tool is available",
		async () => {
			const cwd = makeTempDir("repo-query-ext-test-");
			tempDirs.push(cwd);
			const localRepo = createLocalRepo(cwd);

			const executeTool = vi.fn(
				async (
					_name: string,
					_args: Record<string, unknown>,
					_options?: { signal?: AbortSignal },
				) => ({
					result: {
						content: [{ type: "text", text: "Delegate answer." }],
						details: {},
						structuredContent: { summary: "Delegate answer." },
					},
					isError: false,
				}),
			);
			const ctx = minimalContext(cwd, {
				tools: [{ name: T3_DELEGATE_TOOL }] as never,
				executeTool: executeTool as never,
			});

			const { getTool } = captureExtension();
			const repoQueryTool = getTool();
			if (!repoQueryTool) throw new Error("repo_query tool not found");

			const result = await repoQueryTool.execute(
				"test-call-delegate",
				{ query: "Where is the entry point?", repos: [localRepo] },
				undefined,
				undefined,
				ctx,
			);

			expect(executeTool).toHaveBeenCalledTimes(1);
			const [name, args] = executeTool.mock.calls[0] ?? [];
			expect(name).toBe(T3_DELEGATE_TOOL);
			expect(args).toMatchObject({
				mode: "wait",
				role: "research",
				runtimeMode: "approval-required",
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Delegate answer.");

			const details = result.details as {
				tempspacePath: string;
				answer?: string;
			};
			expect(details.answer).toBe("Delegate answer.");
			const structured = result.structuredContent as {
				status: string;
				answer: { text: string } | null;
			};
			expect(structured.status).toBe("ok");
			expect(structured.answer?.text).toBe("Delegate answer.");

			tempspacesToClean.push(details.tempspacePath);
		},
		30000,
	);

	it.skipIf(!gitAvailable)(
		"sends non-empty phase text so RPC clients can render progress",
		async () => {
			const cwd = makeTempDir("repo-query-ext-test-");
			tempDirs.push(cwd);
			const localRepo = createLocalRepo(cwd);
			const { getTool } = captureExtension({
				explorer: async () => ({ answer: "Done." }),
			});
			const repoQueryTool = getTool();
			if (!repoQueryTool) throw new Error("repo_query tool not found");

			const updates: string[] = [];
			const result = await repoQueryTool.execute(
				"test-call-progress",
				{ query: "What files are here?", repos: [localRepo] },
				undefined,
				(partial) => {
					const block = partial.content[0];
					const text = block?.type === "text" ? block.text : "";
					if (text.length > 0) updates.push(text);
				},
				minimalContext(cwd),
			);

			expect(updates.length).toBeGreaterThan(0);
			expect(updates.every((text) => text.trim().length > 0)).toBe(true);
			expect(updates.some((text) => text.includes("Cloning"))).toBe(true);

			const details = result.details as { tempspacePath: string };
			tempspacesToClean.push(details.tempspacePath);
		},
		30000,
	);
});
