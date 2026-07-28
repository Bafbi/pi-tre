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
 */
export function buildMetadata(meta: InteractionMeta): string {
	const elapsed = (meta.elapsedMs / 1000).toFixed(1);

	return [
		`tools_used: ${meta.toolNames.join(", ")}`,
		`tool_calls: ${meta.toolCallCount}`,
		`elapsed: ${elapsed}s`,
		`thinking_blocks: ${meta.thinkingBlocks}`,
		`workspace: sillajje/${meta.sessionId}`,
		`generated_by: sillajje`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

/**
 * Build the full commit body from subject, prompt, metadata, and response.
 */
export function buildCommitBody(data: CommitBodyData): string {
	const parts: string[] = [data.subject, "", data.prompt];

	if (data.metadata) {
		parts.push("", data.metadata);
	}

	if (data.response) {
		parts.push("", data.response);
	}

	return parts.join("\n");
}
