import { describe, expect, it, vi } from "vitest";

import { validateGitHubRepo } from "../../src/github.js";

const mockReposGet = vi.fn();
const mockSearchRepos = vi.fn();

vi.mock("@octokit/rest", () => ({
	Octokit: vi.fn().mockImplementation(() => ({
		repos: { get: mockReposGet },
		search: { repos: mockSearchRepos },
	})),
}));

describe("validateGitHubRepo", () => {
	it("returns valid for an existing repo", async () => {
		mockReposGet.mockResolvedValue({
			data: { archived: false, pushed_at: "2024-01-01T00:00:00Z" },
		});

		const result = await validateGitHubRepo("facebook", "react");

		expect(result).toEqual({ valid: true, archived: false, warning: undefined });
	});

	it("returns archived warning for archived repos", async () => {
		mockReposGet.mockResolvedValue({
			data: { archived: true, pushed_at: "2020-01-01T00:00:00Z" },
		});

		const result = await validateGitHubRepo("owner", "archived-repo");

		expect(result.valid).toBe(true);
		expect(result.archived).toBe(true);
		expect(result.warning).toContain("archived");
		expect(result.warning).toContain("2020-01-01");
	});

	it("returns suggestions on 404", async () => {
		mockReposGet.mockRejectedValue({ status: 404 });
		mockSearchRepos.mockResolvedValue({
			data: {
				items: [{ full_name: "facebook/react-native" }, { full_name: "preactjs/preact" }],
			},
		});

		const result = await validateGitHubRepo("facebook", "nonexistent");

		expect(result.valid).toBe(false);
		expect(result.suggestions).toEqual(["facebook/react-native", "preactjs/preact"]);
	});

	it("returns empty suggestions when search fails", async () => {
		mockReposGet.mockRejectedValue({ status: 404 });
		mockSearchRepos.mockRejectedValue(new Error("search error"));

		const result = await validateGitHubRepo("owner", "repo");

		expect(result.valid).toBe(false);
		expect(result.suggestions).toEqual([]);
	});

	it("re-throws non-404 errors", async () => {
		mockReposGet.mockRejectedValue(new Error("network error"));

		await expect(validateGitHubRepo("owner", "repo")).rejects.toThrow("network error");
	});
});
