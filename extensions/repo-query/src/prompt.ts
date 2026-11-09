import type { ParsedRepo } from "./types.js";

/**
 * Prompt text for the exploration subagent.
 *
 * This module has no runtime imports, so a node-run benchmark can load it
 * directly with type stripping. Node resolves `./types.js` only as a type
 * import here; adding a value import would break that.
 */

/** Keep the structured payload small enough to read at a glance. */
export const MAX_FINDINGS = 20;

/**
 * Ask for the machine-readable findings block.
 *
 * The tool parses this block, verifies each path and line against the clone,
 * and returns it as `structuredContent.answer.findings`. A malformed block
 * falls back to the prose answer.
 *
 * `repoHints` holds the display names of the explored repositories. With more
 * than one, the example alone is not enough: the tool matches `repo` against a
 * display name, so a placeholder such as `"owner/repo"` makes every finding
 * unverified. The extra sentence lists the names to use.
 */
export function findingsInstructions(repoHints: string[]): string {
	const fence = "```";
	const hint = repoHints[0] ?? "owner/repo";
	const lines = [
		"End the answer with one fenced json block listing the claims you can attribute to a file:",
		`${fence}json`,
		`{"findings":[{"repo":"${hint}","path":"src/file.ts","line":42,"claim":"one sentence"}]}`,
		fence,
	];
	if (repoHints.length > 1) {
		lines.push(
			`Set "repo" to the display name of the repository the file is in, exactly as one of: ${repoHints.map((name) => `"${name}"`).join(", ")}.`,
		);
	}
	lines.push(
		`Use paths relative to the repository root. Set line to null when the claim spans a file. Include at most ${MAX_FINDINGS} findings. Leave out any claim you cannot attribute to a file.`,
	);
	return lines.join("\n");
}

/**
 * Build the subagent's appended system prompt.
 *
 * A single repository puts the subagent in the repository root. Several
 * repositories put it in the tempspace that holds one directory per clone, so
 * the prompt names each directory.
 */
export function buildSystemPrompt(
	repos: ParsedRepo[],
	query: string,
	isSingle: boolean,
): string {
	if (isSingle) {
		const repo = repos[0];
		if (repo === undefined) {
			return "You are a senior code exploration agent.";
		}
		return `You are a senior code exploration agent. You are in the root of the "${repo.displayName}" repository.

Your task: answer this query using only the code in this repository.

Process:
1. Use \`find\` and \`ls\` to understand repository structure
2. Use \`grep\` to search for relevant terms, patterns, or symbols
3. Use \`read\` with \`offset\` and \`limit\` to read specific file sections
4. Never read entire files larger than 100 lines — read relevant chunks

Output requirements:
- Provide a synthesized answer with specific file paths and line numbers
- If you cannot find the answer, state this clearly
- Maximum 800 words
- Do NOT make assumptions beyond the code you have read

${findingsInstructions([repo.displayName])}

Query: ${query}`;
	}

	const repoList = repos
		.map((r) => `- ${r.displayName} (in ./${r.dirName})`)
		.join("\n");
	return `You are a senior code exploration agent. You are in a tempspace containing multiple repositories:

${repoList}

Your task: answer this query by exploring across all repositories. You may find cross-repo references, shared patterns, or divergent implementations.

Process:
1. Use \`ls\` and \`find\` to understand the tempspace structure
2. Use \`grep\` with paths like \`./repo-name/...\` to search within specific repos
3. Use \`read\` with \`offset\` and \`limit\` to read specific file sections
4. Compare and contrast findings across repositories

Output requirements:
- Provide a synthesized answer with specific file paths and line numbers
- Note cross-repo similarities or differences when relevant
- If you cannot find the answer, state this clearly
- Maximum 1000 words
- Do NOT make assumptions beyond the code you have read

${findingsInstructions(repos.map((r) => r.displayName))}

Query: ${query}`;
}
