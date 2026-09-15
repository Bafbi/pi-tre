import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTempspaceCache } from "../../src/tempspace.js";
import {
	captureExtension,
	cleanupDirs,
	makeTempDir,
	minimalContext,
} from "../helpers/create-runner.js";

// These tests use the real GitHub service. `mise run ... --no-service`
// excludes this file for hermetic, fast iteration.
const SERVICE_TIMEOUT_MS = 15_000;

const tempDirs: string[] = [];
const tempspacesToClean: string[] = [];

afterEach(async () => {
	await cleanupDirs(tempDirs);
	await cleanupDirs(tempspacesToClean);
	clearTempspaceCache();
});

function makeTool() {
	// Mock only the subagent; the clone runs for real against GitHub.
	const { getTool } = captureExtension({
		explorer: async () => ({ answer: "Mock exploration result" }),
	});
	const tool = getTool();
	if (!tool) throw new Error("repo_query tool not found");
	return tool;
}

function isServiceUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Could not resolve|unable to access|Failed to connect|timed out|rate limit|API check failed|No repositories could be explored|Failed to clone|\b(?:403|429)\b/i.test(
		message,
	);
}

async function executeRemote(
	tool: ReturnType<typeof makeTool>,
	callId: string,
	params: { query: string; repos: string[] },
	context: ReturnType<typeof minimalContext>,
	ctx: { skip: (reason?: string) => unknown },
) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		const signal = AbortSignal.timeout(SERVICE_TIMEOUT_MS);
		try {
			return await tool.execute(
				callId,
				params,
				signal,
				undefined,
				context,
			);
		} catch (error) {
			if (!signal.aborted && !isServiceUnavailable(error)) throw error;
			lastError = error;
		}
	}

	ctx.skip(
		`GitHub service unavailable after one retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
	return undefined;
}

describe("repo_query remote clone", () => {
	it("clones biomejs/biome from GitHub into tempspace", async (ctx) => {
		const cwd = makeTempDir("repo-query-remote-clone-");
		tempDirs.push(cwd);

		const tool = makeTool();
		const result = await executeRemote(
			tool,
			"test-remote-clone-1",
			{
				query: "What is the main entry point?",
				repos: ["biomejs/biome"],
			},
			minimalContext(cwd),
			ctx,
		);
		if (!result) return;

		const details = result.details as {
			results: Array<{ status: string; localPath?: string }>;
			tempspacePath: string;
		};
		tempspacesToClean.push(details.tempspacePath);

		expect(details.results[0]?.status).toBe("success");
		expect(details.results[0]?.localPath).toBeDefined();

		const localPath = details.results[0]?.localPath;
		expect(localPath).toBeDefined();

		// localPath must be inside tempspace
		expect(localPath?.startsWith(details.tempspacePath)).toBe(true);

		// Real git repo present
		expect(existsSync(join(localPath ?? "", ".git"))).toBe(true);

		// Shallow clone confirmed
		expect(existsSync(join(localPath ?? "", ".git", "shallow"))).toBe(true);

		// Content sanity check
		expect(existsSync(join(localPath ?? "", "package.json"))).toBe(true);
	}, 30_000);

	it("reuses tempspace on second query for same repo", async (ctx) => {
		const cwd = makeTempDir("repo-query-remote-clone-");
		tempDirs.push(cwd);

		const tool = makeTool();
		const context = minimalContext(cwd);

		// First call — triggers clone
		const result1 = await executeRemote(
			tool,
			"test-remote-clone-2a",
			{ query: "First query", repos: ["biomejs/biome"] },
			context,
			ctx,
		);
		if (!result1) return;

		const details1 = result1.details as {
			results: Array<{ status: string; localPath?: string }>;
			tempspacePath: string;
		};
		tempspacesToClean.push(details1.tempspacePath);

		expect(details1.results[0]?.status).toBe("success");

		// Second call in same process — should reuse via in-memory cache
		const result2 = await executeRemote(
			tool,
			"test-remote-clone-2b",
			{ query: "Second query", repos: ["biomejs/biome"] },
			context,
			ctx,
		);
		if (!result2) return;

		const details2 = result2.details as {
			results: Array<{ status: string; localPath?: string }>;
			tempspacePath: string;
		};

		// Same tempspace reused
		expect(details2.tempspacePath).toBe(details1.tempspacePath);

		// Same local path
		expect(details2.results[0]?.localPath).toBe(
			details1.results[0]?.localPath,
		);

		// Repo still valid (was not re-cloned, just reused)
		const reusedPath = details2.results[0]?.localPath;
		expect(reusedPath).toBeDefined();
		expect(existsSync(join(reusedPath ?? "", ".git"))).toBe(true);
	}, 30_000);
});
