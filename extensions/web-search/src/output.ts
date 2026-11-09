import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

import type { ConsoleSearchResult } from "./client.js";
import type { WebSearchDetails } from "./types.js";

/** What one successful search costs the workspace, in USD. */
export const PRICE_USD_PER_SEARCH = 0.01;

/** Characters of a result's snippet kept in the model-facing text. */
const SNIPPET_CHARS = 400;

/** Collapse whitespace and cut a snippet to a bounded length. */
function snippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SNIPPET_CHARS) return flat;
	return `${flat.slice(0, SNIPPET_CHARS)}...`;
}

/** The model-facing text for a completed search. */
export function formatResults(
	query: string,
	results: ConsoleSearchResult[],
): string {
	const price = `USD ${PRICE_USD_PER_SEARCH.toFixed(2)}`;
	const count =
		results.length === 1 ? "1 result" : `${results.length} results`;
	const lines = [
		`# Web search: ${query}`,
		"",
		`${count}. Billed ${price} to the OpenCode workspace balance.`,
	];

	if (results.length === 0) {
		lines.push("", "The Console returned no results for this query.");
		return lines.join("\n");
	}

	results.forEach((result, index) => {
		lines.push("");
		lines.push(`${index + 1}. ${result.title ?? result.url}`);
		lines.push(`   ${result.url}`);
		if (result.content) lines.push(`   ${snippet(result.content)}`);
	});

	lines.push("");
	lines.push(
		"Snippets are excerpts. Cite the URL, and open the page when the claim matters.",
	);
	return lines.join("\n");
}

/** Explain the spend gate and the file that opens it, without inviting a retry. */
export function formatDisabled(paths: {
	global: string;
	project: string;
}): string {
	return [
		"search_web is off, so no search ran and nothing was billed.",
		`Each successful search costs USD ${PRICE_USD_PER_SEARCH.toFixed(2)} from the OpenCode workspace balance, so the tool stays off until it is turned on.`,
		"",
		'To enable it, set "enabled": true in one of these files:',
		`- ${paths.global} (all projects)`,
		`- ${paths.project} (this project only, needs project trust)`,
		"",
		"Do not retry. The answer stays the same until that file changes.",
	].join("\n");
}

/** Explain a missing credential and how to provide one. */
export function formatUnconfigured(provider: string): string {
	return [
		"search_web has no OpenCode credential, so no search ran and nothing was billed.",
		`It reads the key from the pi provider "${provider}", which resolves a stored login or OPENCODE_API_KEY.`,
		"",
		`Sign in with /login ${provider}, or export OPENCODE_API_KEY.`,
		"Do not retry until a credential exists.",
	].join("\n");
}

/** Cut the text to pi's default limits and say what was cut. */
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

/** The model-facing text for a call that did not produce results. */
export function formatFailure(details: WebSearchDetails): string {
	return `# Web search: ${details.query}\n\n${details.error ?? "The search failed."}`;
}
