import { describe, expect, it } from "vitest";

import {
	formatOutput,
	formatRepoDisplayName,
	truncateOutput,
} from "../../src/output.js";
import type { RepoQueryDetails, RepoResult } from "../../src/types.js";

function details(
	results: RepoResult[],
	extra?: Partial<RepoQueryDetails>,
): RepoQueryDetails {
	return {
		query: "query",
		workspacePath: "/tmp/ws",
		results,
		phase: "complete",
		...extra,
	};
}

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
		expect(formatOutput(details([]))).toBe("No results.");
	});

	it("formats a successful answer", () => {
		const out = formatOutput(
			details(
				[
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
					},
				],
				{ query: "What is the answer?", answer: "The answer is 42." },
			),
		);
		expect(out).toContain("# Answer: What is the answer?");
		expect(out).toContain("The answer is 42.");
	});

	it("formats failures under an Issues section", () => {
		const out = formatOutput(
			details([
				{
					identifier: "owner/missing",
					status: "not_found",
					warnings: [],
					suggestions: ["owner/real"],
					error: "Repository not found.",
				},
			]),
		);
		expect(out).toContain("## Issues");
		expect(out).toContain("owner/missing");
		expect(out).toContain("not_found");
		expect(out).toContain("Repository not found.");
		expect(out).toContain("Did you mean: owner/real?");
	});

	it("combines successes and failures", () => {
		const out = formatOutput(
			details(
				[
					{
						identifier: "owner/good",
						status: "success",
						warnings: [],
					},
					{
						identifier: "owner/bad",
						status: "clone_failed",
						warnings: [],
						error: "Network error.",
					},
				],
				{ answer: "It works." },
			),
		);
		expect(out).toContain("# Answer: query");
		expect(out).toContain("It works.");
		expect(out).toContain("## Issues");
		expect(out).toContain("Network error.");
	});

	it("includes warnings from successful repos", () => {
		const out = formatOutput(
			details(
				[
					{
						identifier: "owner/repo",
						status: "success",
						warnings: ["This repo is large."],
					},
				],
				{ answer: "Found it." },
			),
		);
		expect(out).toContain("## Warnings");
		expect(out).toContain("This repo is large.");
	});

	it("skips warnings section when no successes have warnings", () => {
		const out = formatOutput(
			details(
				[
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
					},
				],
				{ answer: "Found it." },
			),
		);
		expect(out).not.toContain("## Warnings");
	});

	it("treats archived repos as successes for output formatting", () => {
		const out = formatOutput(
			details(
				[
					{
						identifier: "owner/old",
						status: "archived",
						warnings: ["Archived warning."],
					},
				],
				{ answer: "Still readable." },
			),
		);
		expect(out).toContain("# Answer: query");
		expect(out).toContain("Still readable.");
	});

	it("handles skipped repos in the Issues section", () => {
		const out = formatOutput(
			details([
				{
					identifier: "bad-id",
					status: "skipped",
					warnings: [],
					error: "Cannot parse identifier.",
				},
			]),
		);
		expect(out).toContain("## Issues");
		expect(out).toContain("bad-id");
		expect(out).toContain("skipped");
	});

	it("does not print an answer section when the answer is empty", () => {
		const out = formatOutput(
			details([
				{
					identifier: "owner/repo",
					status: "success",
					warnings: [],
				},
			]),
		);
		expect(out).not.toContain("# Answer");
	});

	describe("Recommendation section", () => {
		it("adds Recommendation with retry hint when success + not_found with suggestions", () => {
			const out = formatOutput(
				details(
					[
						{
							identifier: "owner/good",
							status: "success",
							warnings: [],
						},
						{
							identifier: "owner/missing",
							status: "not_found",
							warnings: [],
							suggestions: ["owner/real"],
							error: "Repository not found.",
						},
					],
					{ answer: "Found it." },
				),
			);
			expect(out).toContain("## Recommendation");
			expect(out).toContain("1 of 2 repos could not be found");
			expect(out).toContain(
				"Consider retrying with the suggested names alongside the 1 successful repo(s)",
			);
			expect(out).toContain(
				"Use `owner/real` instead of `owner/missing`",
			);
		});

		it("adds Recommendation when all repos are not_found with suggestions", () => {
			const out = formatOutput(
				details([
					{
						identifier: "owner/a",
						status: "not_found",
						warnings: [],
						suggestions: ["owner/real-a"],
						error: "Not found.",
					},
					{
						identifier: "owner/b",
						status: "not_found",
						warnings: [],
						suggestions: ["owner/real-b"],
						error: "Not found.",
					},
				]),
			);
			expect(out).toContain("## Recommendation");
			expect(out).toContain("2 repo(s) could not be found");
			expect(out).toContain(
				"Consider retrying with the suggested names below",
			);
			expect(out).toContain("Use `owner/real-a` instead of `owner/a`");
			expect(out).toContain("Use `owner/real-b` instead of `owner/b`");
		});

		it("omits Recommendation when failures have no suggestions", () => {
			const out = formatOutput(
				details([
					{
						identifier: "owner/good",
						status: "success",
						warnings: [],
					},
					{
						identifier: "owner/bad",
						status: "clone_failed",
						warnings: [],
						error: "Network error.",
					},
				]),
			);
			expect(out).not.toContain("## Recommendation");
		});

		it("omits Recommendation when there are no failures", () => {
			const out = formatOutput(
				details(
					[
						{
							identifier: "owner/repo",
							status: "success",
							warnings: [],
						},
					],
					{ answer: "All good." },
				),
			);
			expect(out).not.toContain("## Recommendation");
		});
	});
});

describe("truncateOutput", () => {
	it("returns text unchanged when under the limits", () => {
		expect(truncateOutput("small")).toBe("small");
	});

	it("appends a truncation notice when over the line limit", () => {
		// Build text exceeding pi's DEFAULT_MAX_LINES (2000).
		const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const out = truncateOutput(text);
		expect(out).toContain("Output truncated");
		expect(out).toContain("of 2100 lines");
		// The truncated body is still present, without a full-output claim.
		expect(out).toContain("line 0");
		expect(out).not.toContain("Full output");
	});
});
