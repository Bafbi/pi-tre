import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTempspaceCache } from "../../src/tempspace.js";
import {
	captureExtension,
	cleanupDirs,
	makeTempDir,
	minimalContext,
} from "../helpers/create-runner.js";

// These tests are hermetic: GitHub API responses come from a mocked fetch,
// and clone/explorer are injected through the extension factory overrides.
// No test here touches the network.

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupDirs(tempDirs);
	clearTempspaceCache();
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
			return new Response(JSON.stringify({ message: "Not Found" }), {
				status: 404,
			});
		}
		if (typeof match === "number") {
			return new Response(JSON.stringify({ message: "Error" }), {
				status: match,
			});
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

async function executeQuery(
	query: string,
	repos: string[],
): Promise<Record<string, unknown>> {
	const cwd = makeTempDir("repo-query-gh-test-");
	tempDirs.push(cwd);

	const { getTool } = captureExtension({
		explorer: async () => ({ answer: "Mock exploration result" }),
		clone: async () => ({ status: "cloned" as const }),
	});
	const tool = getTool();
	if (!tool) throw new Error("repo_query tool not found");

	return tool.execute(
		"test-call",
		{ query, repos },
		undefined,
		undefined,
		minimalContext(cwd),
	) as Promise<Record<string, unknown>>;
}

describe("repo_query GitHub validation (hermetic)", () => {
	it("proceeds with exploration for valid GitHub repo", async () => {
		const gh = mockGitHubApi({
			responses: new Map([
				[
					"https://api.github.com/repos/owner/repo",
					{ archived: false, pushed_at: "2024-01-01T00:00:00Z" },
				],
			]),
		});

		try {
			const result = await executeQuery("What is the main entry point?", [
				"owner/repo",
			]);

			const text = (result.content as Array<{ text: string }>)[0]?.text;
			expect(text).toContain("Mock exploration result");
			const details = result.details as {
				results: Array<{ status: string }>;
				answer?: string;
			};
			expect(details.results[0]?.status).toBe("success");
			expect(details.answer).toBe("Mock exploration result");
		} finally {
			gh.restore();
		}
	});

	it("marks archived repo with warning but still explores", async () => {
		const gh = mockGitHubApi({
			responses: new Map([
				[
					"https://api.github.com/repos/owner/archived",
					{ archived: true, pushed_at: "2020-01-01T00:00:00Z" },
				],
			]),
		});

		try {
			const result = await executeQuery("What is the main entry point?", [
				"owner/archived",
			]);

			const details = result.details as {
				results: Array<{ status: string; warnings: string[] }>;
			};
			expect(details.results[0]?.status).toBe("archived");
			expect(
				details.results[0]?.warnings.some((w) =>
					w.includes("archived"),
				),
			).toBe(true);
		} finally {
			gh.restore();
		}
	});

	it("throws with suggestions when the repo is not found", async () => {
		const gh = mockGitHubApi({
			responses: new Map([
				[
					"https://api.github.com/search/repositories?q=missing%20user%3Aowner&sort=stars&order=desc&per_page=5",
					{
						items: [
							{ full_name: "owner/real-repo" },
							{ full_name: "other/repo" },
						],
					},
				],
			]),
		});

		try {
			// The hard-failure path throws; pi reports the thrown message to the LLM.
			await expect(
				executeQuery("What is the main entry point?", [
					"owner/missing",
				]),
			).rejects.toThrow(/owner\/missing/);

			await expect(
				executeQuery("What is the main entry point?", [
					"owner/missing",
				]),
			).rejects.toThrow(/owner\/real-repo/);
		} finally {
			gh.restore();
		}
	});

	it("returns the mixed answer plus Recommendation when some repos have suggestions", async () => {
		const gh = mockGitHubApi({
			responses: new Map([
				[
					"https://api.github.com/repos/owner/good",
					{ archived: false, pushed_at: "2024-01-01T00:00:00Z" },
				],
				[
					"https://api.github.com/search/repositories?q=missing%20user%3Aowner&sort=stars&order=desc&per_page=5",
					{ items: [{ full_name: "owner/real-repo" }] },
				],
			]),
		});

		try {
			const result = await executeQuery("How does this work?", [
				"owner/good",
				"owner/missing",
			]);

			// Partial failures return normally; the answer text carries the details.
			const text = (result.content as Array<{ text: string }>)[0]?.text;
			expect(text).toContain("Mock exploration result");
			expect(text).toContain("owner/missing");
			expect(text).toContain("owner/real-repo");
			expect(text).toContain("## Recommendation");
			expect(text).toContain(
				"Use `owner/real-repo` instead of `owner/missing`",
			);
		} finally {
			gh.restore();
		}
	});

	it("proceeds with clone when GitHub API fails unexpectedly", async () => {
		const gh = mockGitHubApi({
			responses: new Map([
				["https://api.github.com/repos/owner/repo", 500],
			]),
		});

		try {
			const result = await executeQuery("What is the main entry point?", [
				"owner/repo",
			]);

			const details = result.details as {
				results: Array<{ status: string; warnings: string[] }>;
			};
			expect(
				details.results[0]?.warnings.some((w) =>
					w.includes("GitHub API check failed"),
				),
			).toBe(true);
			expect(details.results[0]?.status).toBe("success");
		} finally {
			gh.restore();
		}
	});
});
