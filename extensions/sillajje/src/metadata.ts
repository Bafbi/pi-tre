/**
 * Pure functions for building commit bodies and metadata blocks
 * for sillajje change stamping.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractionMeta {
	toolNames: string[];
	toolCallCount: number;
	elapsedMs: number;
	thinkingBlocks: number;
	sessionId: string;
}

export interface CommitBodyData {
	subject: string;
	prompt: string;
	metadata: string;
	response: string;
	/** AI-generated summary from the sub-generator. Optional — empty string omits the section. */
	summary: string;
}

// ---------------------------------------------------------------------------
// deriveSubject
// ---------------------------------------------------------------------------

const MAX_SUBJECT_LEN = 72;
const DEFAULT_SUBJECT = "chore: agent interaction";

/**
 * Derive a human-readable subject line from the user prompt.
 *
 * Uses the first non-empty line, truncated to 72 characters.
 * Falls back to a default when the prompt is empty or whitespace-only.
 */
export function deriveSubject(prompt: string): string {
	const firstLine = prompt.split("\n")[0]?.trim() ?? "";
	if (firstLine.length === 0) return DEFAULT_SUBJECT;
	if (firstLine.length <= MAX_SUBJECT_LEN) return firstLine;
	return `${firstLine.slice(0, MAX_SUBJECT_LEN - 3)}...`;
}

// ---------------------------------------------------------------------------
// buildMetadata
// ---------------------------------------------------------------------------

/**
 * Build the programmatic metadata block for the commit body.
 * Returns a compact two-line block.
 */
export function buildMetadata(meta: InteractionMeta): string {
	const elapsed = (meta.elapsedMs / 1000).toFixed(1);

	return [
		`Meta: ${meta.toolNames.join(", ")} | ${meta.toolCallCount} calls | ${elapsed}s`,
		`  ${meta.thinkingBlocks} blocks | sillajje/${meta.sessionId}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

/**
 * Build the full commit body with labeled sections.
 *
 * Each narrative section (Prompt, Summary, Response) is prefixed with `Label:\n`
 * so the boundary is unambiguous even if the content contains markdown.
 * Metadata is a compact block. Empty sections are omitted.
 *
 * Section order:
 *   subject blank-line Prompt blank-line Meta blank-line Summary blank-line Response
 */
export function buildCommitBody(data: CommitBodyData): string {
	const parts: string[] = [data.subject, ""];

	if (data.prompt) {
		parts.push("Prompt:", data.prompt, "");
	}

	if (data.metadata) {
		parts.push(data.metadata, "");
	}

	if (data.summary) {
		parts.push("Summary:", data.summary, "");
	}

	if (data.response) {
		parts.push("Response:", data.response);
	}

	// Strip trailing blank line if the last section was omitted
	while (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}

	return parts.join("\n");
}
