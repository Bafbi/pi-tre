/**
 * Answer-text helpers shared by the explorer, the findings parser, and the
 * benchmark.
 *
 * This module has no runtime imports, so a node-run benchmark can load it
 * directly with type stripping. Do not import another module here: bench files
 * load each other with the `.ts` extension, and node does not resolve
 * `./x.js` to `./x.ts`.
 */

/** The explorer's own answer cap, as the parent sees it. */
export const MAX_OUTPUT_CHARS = 8000;

const TRUNCATION_SUFFIX = "...\n[Answer truncated]";

const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)```/gi;

export interface FindingsBlock {
	/** The JSON text inside the fence. */
	json: string;
	/** Index of the fence in the answer. */
	index: number;
	/** Length of the whole fenced block, fence included. */
	length: number;
}

/**
 * Find the last fenced `json` block that looks like a findings payload.
 *
 * The last one wins: a model may show an example before the real block.
 */
export function findFindingsBlock(answer: string): FindingsBlock | null {
	const matches = [...answer.matchAll(FENCED_JSON)];
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		if (match === undefined) continue;
		const json = match[1];
		const index = match.index;
		if (json === undefined || index === undefined) continue;
		if (!json.includes('"findings"') && !json.trimStart().startsWith("[")) {
			continue;
		}
		return { json, index, length: match[0].length };
	}
	return null;
}

/** Remove one findings block and collapse the blank lines it leaves. */
export function stripFindingsBlock(
	answer: string,
	index: number,
	length: number,
): string {
	return `${answer.slice(0, index)}${answer.slice(index + length)}`
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Cap a subagent answer at `MAX_OUTPUT_CHARS` without losing its findings.
 *
 * A long answer is cut to the cap. The findings block is last in the answer, so
 * a plain cut would delete it and throw away the claims the tool already paid
 * for. When a block is present, the prose is cut and the block is kept intact.
 * An answer cut here is incomplete: callers must not report it as complete.
 */
export function truncateSubagentOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;

	const block = findFindingsBlock(text);
	if (block !== null) {
		const blockText = text.slice(block.index, block.index + block.length);
		// Room for some prose after the suffix, or the cut is not worth it.
		const room =
			MAX_OUTPUT_CHARS - blockText.length - TRUNCATION_SUFFIX.length - 2;
		if (room >= 200) {
			const prose = text.slice(0, block.index).trimEnd();
			return `${prose.slice(0, room)}${TRUNCATION_SUFFIX}\n\n${blockText}`;
		}
	}

	return `${text.slice(0, MAX_OUTPUT_CHARS)}${TRUNCATION_SUFFIX}`;
}
