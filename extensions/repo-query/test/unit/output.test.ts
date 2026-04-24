import { describe, expect, it } from "vitest";

import { formatOutput, formatRepoDisplayName } from "../../src/index.js";
import type { RepoResult } from "../../src/types.js";

describe("formatRepoDisplayName", () => {
	it("returns parsed display name and branch for valid identifiers", () => {
		const result = formatRepoDisplayName("owner/repo:main");
		expect(result.display).toBe("owner/repo");
		expect(result.branch).toBe("main");
	});

	it("returns branch null when no branch suffix", () => {
		const result = formatRepoDisplayName("owner/repo");
		expect(result.display).toBe("owner/repo");
		expect(result.branch).toBeNull();
	});

	it("falls back to raw input when parsing fails", () => {
		const result = formatRepoDisplayName(":::invalid:::");
		expect(result.display).toBe(":::invalid:::");
		expect(result.branch).toBeNull();
	});
});

describe("formatOutput", () => {
	it("returns 'No results.' for empty results", () => {
		expect(formatOutput([], "test query")).toBe("No results.");
	});

	it("formats a successful answer", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/repo",
				status: "success",
				warnings: [],
				answer: "The answer is 42.",
			},
		];
		const out = formatOutput(results, "What is the answer?");
		expect(out).toContain("# Answer: What is the answer?");
		expect(out).toContain("The answer is 42.");
	});

	it("formats failures under an Issues section", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/missing",
				status: "not_found",
				warnings: [],
				suggestions: ["owner/real"],
				error: "Repository not found.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).toContain("## Issues");
		expect(out).toContain("owner/missing");
		expect(out).toContain("not_found");
		expect(out).toContain("Repository not found.");
		expect(out).toContain("Did you mean: owner/real?");
	});

	it("combines successes and failures", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/good",
				status: "success",
				warnings: [],
				answer: "It works.",
			},
			{
				identifier: "owner/bad",
				status: "clone_failed",
				warnings: [],
				error: "Network error.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).toContain("# Answer: query");
		expect(out).toContain("It works.");
		expect(out).toContain("## Issues");
		expect(out).toContain("Network error.");
	});

	it("includes warnings from successful repos", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/repo",
				status: "success",
				warnings: ["This repo is large."],
				answer: "Found it.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).toContain("## Warnings");
		expect(out).toContain("This repo is large.");
	});

	it("skips warnings section when no successes have warnings", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/repo",
				status: "success",
				warnings: [],
				answer: "Found it.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).not.toContain("## Warnings");
	});

	it("treats archived repos as successes for output formatting", () => {
		const results: RepoResult[] = [
			{
				identifier: "owner/old",
				status: "archived",
				warnings: ["Archived warning."],
				answer: "Still readable.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).toContain("# Answer: query");
		expect(out).toContain("Still readable.");
	});

	it("handles skipped repos in the Issues section", () => {
		const results: RepoResult[] = [
			{
				identifier: "bad-id",
				status: "skipped",
				warnings: [],
				error: "Cannot parse identifier.",
			},
		];
		const out = formatOutput(results, "query");
		expect(out).toContain("## Issues");
		expect(out).toContain("bad-id");
		expect(out).toContain("skipped");
	});
});
