import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

import { parseRepoIdentifier, redactCredentials } from "./resolver.js";
import type { RepoQueryDetails, RepoResult } from "./types.js";
import { isFailure, isSuccess } from "./types.js";

export function formatRepoDisplayName(raw: string): {
	display: string;
	branch: string | null;
} {
	try {
		const parsed = parseRepoIdentifier(raw);
		return { display: parsed.displayName, branch: parsed.branch };
	} catch {
		return { display: redactCredentials(raw), branch: null };
	}
}

/**
 * Retry lines for not-found repos with suggestions:
 * `- Use \`owner/real\` instead of \`owner/missing\``
 * Shared by the hard-failure error text and the Recommendation section.
 */
export function formatRetrySuggestions(results: RepoResult[]): string[] {
	const lines: string[] = [];
	for (const r of results) {
		const primary = r.suggestions?.[0];
		if (primary) {
			lines.push(`- Use \`${primary}\` instead of \`${r.identifier}\``);
		}
	}
	return lines;
}

/**
 * Format the final tool output: the answer, per-repo issues, retry
 * recommendations, and warnings. The subagent produces one answer for the
 * whole query, so it is read from `details.answer`.
 */
export function formatOutput(details: RepoQueryDetails): string {
	const { results, query, model, answer } = details;
	const lines: string[] = [];

	const successes = results.filter((r) => isSuccess(r.status));
	const failures = results.filter((r) => isFailure(r.status));
	const notFoundWithSuggestions = failures.filter(
		(r) => r.suggestions && r.suggestions.length > 0,
	);

	if (successes.length > 0 && answer) {
		lines.push(`# Answer: ${query}`);
		if (model) {
			lines.push("");
			lines.push(`**Model:** ${model}`);
		}
		lines.push("");
		lines.push(answer);
	}

	if (failures.length > 0) {
		if (successes.length > 0) lines.push("");
		lines.push("## Issues");
		for (const f of failures) {
			lines.push(`- **${f.identifier}**: ${f.status}`);
			if (f.error) lines.push(`  - ${f.error}`);
			if (f.suggestions && f.suggestions.length > 0) {
				lines.push(`  - Did you mean: ${f.suggestions.join(", ")}?`);
			}
		}
	}

	// Add retry recommendation when some repos have suggestions
	if (notFoundWithSuggestions.length > 0) {
		const succeededCount = successes.length;
		lines.push("");
		lines.push("## Recommendation");
		if (succeededCount > 0) {
			lines.push(
				`${results.length - succeededCount} of ${results.length} repos could not be found. ` +
					`Consider retrying with the suggested names alongside the ${succeededCount} successful repo(s):`,
			);
		} else {
			lines.push(
				`${results.length} repo(s) could not be found. ` +
					`Consider retrying with the suggested names below:`,
			);
		}
		lines.push(...formatRetrySuggestions(results));
	}

	if (successes.some((r) => r.warnings.length > 0)) {
		lines.push("");
		lines.push("## Warnings");
		for (const s of successes) {
			for (const w of s.warnings) {
				lines.push(`- **${s.identifier}**: ${w}`);
			}
		}
	}

	return lines.join("\n") || "No results.";
}

/**
 * Truncate tool output to pi's default limits and, when truncated, tell the
 * LLM what was cut. A subagent answer is regenerated per query — it cannot be
 * recovered from disk — so the notice only reports the cut.
 */
export function truncateOutput(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return text;
	return (
		truncation.content +
		`\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
	);
}
