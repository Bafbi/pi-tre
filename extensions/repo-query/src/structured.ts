import { type Static, Type } from "typebox";

import { parseRepoIdentifier } from "./resolver.js";
import type { RepoQueryDetails, RepoQueryStatus, RepoResult } from "./types.js";

/**
 * JSON Schema of the machine-readable tool result.
 *
 * pi hands this shape to code-mode scripts instead of the model-facing text.
 * Keep it in step with `RepoQueryStructured`: `buildStructured` is typed by
 * that interface, so a field added here without a value fails the build.
 */
export const RepoQueryOutputSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("ok"),
			Type.Literal("partial"),
			Type.Literal("failed"),
		]),
		query: Type.String(),
		model: Type.Union([Type.String(), Type.Null()]),
		answer: Type.Union([
			Type.Object({
				text: Type.String(),
				complete: Type.Boolean(),
				findings: Type.Array(
					Type.Object({
						repo: Type.Union([Type.String(), Type.Null()]),
						path: Type.String(),
						line: Type.Union([Type.Number(), Type.Null()]),
						claim: Type.String(),
						verified: Type.Boolean(),
					}),
				),
			}),
			Type.Null(),
		]),
		repos: Type.Array(
			Type.Object({
				identifier: Type.String(),
				displayName: Type.String(),
				branch: Type.Union([Type.String(), Type.Null()]),
				status: Type.Union([
					Type.Literal("success"),
					Type.Literal("not_found"),
					Type.Literal("archived"),
					Type.Literal("clone_failed"),
					Type.Literal("exploration_failed"),
					Type.Literal("skipped"),
				]),
				localPath: Type.Union([Type.String(), Type.Null()]),
				warnings: Type.Array(Type.String()),
				error: Type.Union([Type.String(), Type.Null()]),
				suggestedRepos: Type.Array(Type.String()),
				suggestedBranches: Type.Array(Type.String()),
			}),
		),
		usage: Type.Union([
			Type.Object({
				input: Type.Number(),
				output: Type.Number(),
				totalTokens: Type.Number(),
				cost: Type.Number(),
				costFromProvider: Type.Boolean(),
			}),
			Type.Null(),
		]),
		tempspacePath: Type.String(),
	},
	{ additionalProperties: false },
);

/**
 * The machine-readable result. Derived from the schema so the runtime shape
 * and the TypeScript type cannot drift.
 */
export type RepoQueryStructured = Static<typeof RepoQueryOutputSchema>;

/** Parse the display name and branch for a repo identifier, never throwing. */
function describeIdentifier(identifier: string): {
	displayName: string;
	branch: string | null;
} {
	try {
		const parsed = parseRepoIdentifier(identifier);
		return { displayName: parsed.displayName, branch: parsed.branch };
	} catch {
		return { displayName: identifier, branch: null };
	}
}

function structuredRepo(
	result: RepoResult,
): RepoQueryStructured["repos"][number] {
	const { displayName, branch } = describeIdentifier(result.identifier);
	return {
		identifier: result.identifier,
		displayName,
		branch,
		status: result.status,
		localPath: result.localPath ?? null,
		warnings: [...result.warnings],
		error: result.error ?? null,
		suggestedRepos: [...(result.suggestions ?? [])],
		suggestedBranches: [...(result.suggestedBranches ?? [])],
	};
}

/**
 * Build the structured result from the collected details.
 *
 * `status` describes the whole call:
 * - `failed` when no repository produced an answer, or the exploration failed.
 * - `partial` when at least one repository answered and another failed.
 * - `ok` when every repository answered.
 *
 * An answer counts as incomplete when the explorer aborted early or its text
 * was truncated. The text still carries its own notice.
 */
export function buildStructured(
	details: RepoQueryDetails,
	status: RepoQueryStatus,
	answerComplete = true,
): RepoQueryStructured {
	const answerText = details.answer?.trim() ?? "";
	return {
		status,
		query: details.query,
		model: details.model ?? null,
		answer:
			status !== "failed" && answerText.length > 0
				? {
						text: details.answer ?? "",
						complete: answerComplete,
						findings: (details.findings ?? []).map((finding) => ({
							repo: finding.repo,
							path: finding.path,
							line: finding.line,
							claim: finding.claim,
							verified: finding.verified,
						})),
					}
				: null,
		repos: details.results.map(structuredRepo),
		usage: details.usage
			? {
					input: details.usage.input,
					output: details.usage.output,
					totalTokens: details.usage.totalTokens,
					cost: details.usage.cost,
					costFromProvider: details.usage.costFromProvider === true,
				}
			: null,
		tempspacePath: details.tempspacePath,
	};
}

/**
 * Status for a finished run.
 *
 * `explorationFailed` means the subagent errored, so no answer came back.
 * A run with at least one answer and one failed repository is `partial`.
 */
export function resolveStatus(
	details: RepoQueryDetails,
	explorationFailed: boolean,
): RepoQueryStatus {
	if (explorationFailed) return "failed";
	const successes = details.results.filter(
		(result) => result.status === "success" || result.status === "archived",
	);
	if (successes.length === 0) return "failed";
	if (successes.length === details.results.length) return "ok";
	return "partial";
}
