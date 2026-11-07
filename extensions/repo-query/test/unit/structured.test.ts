import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
	buildStructured,
	RepoQueryOutputSchema,
	resolveStatus,
} from "../../src/structured.js";
import type { RepoQueryDetails, RepoResult } from "../../src/types.js";

function details(
	results: RepoResult[],
	extra?: Partial<RepoQueryDetails>,
): RepoQueryDetails {
	return {
		query: "How does it work?",
		tempspacePath: "/tmp/pi-rq-test",
		results,
		phase: "complete",
		...extra,
	};
}

const success: RepoResult = {
	identifier: "owner/repo",
	status: "success",
	localPath: "/tmp/pi-rq-test/github_owner_repo",
	warnings: [],
};

describe("resolveStatus", () => {
	it("is failed when the exploration failed", () => {
		expect(resolveStatus(details([success]), true)).toBe("failed");
	});

	it("is failed when no repository answered", () => {
		expect(
			resolveStatus(
				details([
					{
						identifier: "owner/missing",
						status: "not_found",
						warnings: [],
					},
				]),
				false,
			),
		).toBe("failed");
	});

	it("is ok when every repository answered", () => {
		expect(
			resolveStatus(
				details([
					success,
					{
						identifier: "owner/old",
						status: "archived",
						warnings: ["archived"],
					},
				]),
				false,
			),
		).toBe("ok");
	});

	it("is partial when one repository answered and one failed", () => {
		expect(
			resolveStatus(
				details([
					success,
					{
						identifier: "owner/bad",
						status: "clone_failed",
						warnings: [],
						error: "network",
					},
				]),
				false,
			),
		).toBe("partial");
	});
});

describe("buildStructured", () => {
	it("maps every repository field and keeps suggestions machine-readable", () => {
		const structured = buildStructured(
			details(
				[
					success,
					{
						identifier: "owner/missing:dev",
						status: "clone_failed",
						warnings: [],
						error: "branch not found",
						suggestions: ["owner/real"],
						suggestedBranches: ["develop", "dev-main"],
					},
				],
				{
					answer: "The answer.",
					model: "provider/model",
					usage: {
						turns: 2,
						input: 10,
						output: 20,
						cacheRead: 3,
						cacheWrite: 4,
						totalTokens: 37,
						cost: 0.0123,
					},
				},
			),
			"partial",
		);

		expect(structured.status).toBe("partial");
		expect(structured.model).toBe("provider/model");
		expect(structured.answer).toEqual({
			text: "The answer.",
			complete: true,
			findings: [],
		});
		expect(structured.repos[0]).toMatchObject({
			identifier: "owner/repo",
			displayName: "owner/repo",
			branch: null,
			status: "success",
			localPath: "/tmp/pi-rq-test/github_owner_repo",
			suggestedRepos: [],
			suggestedBranches: [],
		});
		expect(structured.repos[1]).toMatchObject({
			displayName: "owner/missing",
			branch: "dev",
			status: "clone_failed",
			error: "branch not found",
			suggestedRepos: ["owner/real"],
			suggestedBranches: ["develop", "dev-main"],
		});
		expect(structured.usage).toEqual({
			input: 10,
			output: 20,
			totalTokens: 37,
			cost: 0.0123,
			costFromProvider: false,
		});
	});

	it("sets answer to null when no text came back", () => {
		const structured = buildStructured(
			details([
				{
					identifier: "owner/missing",
					status: "not_found",
					warnings: [],
				},
			]),
			"failed",
		);
		expect(structured.answer).toBeNull();
		expect(structured.model).toBeNull();
		expect(structured.usage).toBeNull();
	});

	it("drops the answer when the status is failed", () => {
		const structured = buildStructured(
			details([success], { answer: "Unreliable partial text." }),
			"failed",
		);
		expect(structured.answer).toBeNull();
	});

	it("reports a provider-billed usage total as such", () => {
		const structured = buildStructured(
			details([success], {
				usage: {
					turns: 1,
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: 0.01,
					costFromProvider: true,
				},
			}),
			"ok",
		);
		expect(structured.usage?.costFromProvider).toBe(true);
	});

	it("marks a partial answer incomplete", () => {
		const structured = buildStructured(
			details([success], { answer: "cut short" }),
			"ok",
			false,
		);
		expect(structured.answer).toEqual({
			text: "cut short",
			complete: false,
			findings: [],
		});
	});

	it("includes findings in the answer", () => {
		const structured = buildStructured(
			details([success], {
				answer: "The answer.",
				findings: [
					{
						repo: "owner/repo",
						path: "src/a.ts",
						line: 3,
						claim: "A claim.",
						verified: true,
					},
				],
			}),
			"ok",
		);
		expect(structured.answer?.findings).toEqual([
			{
				repo: "owner/repo",
				path: "src/a.ts",
				line: 3,
				claim: "A claim.",
				verified: true,
			},
		]);
		expect(Value.Check(RepoQueryOutputSchema, structured)).toBe(true);
	});

	it("matches the declared output schema", () => {
		const structured = buildStructured(
			details(
				[
					success,
					{
						identifier: "owner/missing",
						status: "not_found",
						warnings: [],
					},
				],
				{ answer: "The answer." },
			),
			"partial",
		);
		expect(Value.Check(RepoQueryOutputSchema, structured)).toBe(true);
	});
});
