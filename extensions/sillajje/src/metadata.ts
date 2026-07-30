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

/** Optional field toggles for the metadata block. All default to `true`. */
export interface MetadataFieldToggles {
	tools?: boolean;
	call_count?: boolean;
	elapsed?: boolean;
	thinking_blocks?: boolean;
}

export interface CommitBodyData {
	subject: string;
	/**
	 * Trace narrative from the trace sub-generator.
	 * Optional — empty string omits the section.
	 */
	trace: string;
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
 * Returns a compact two-line block.
 *
 * @param meta - Interaction metadata.
 * @param fields - Optional field toggles. When a field is `false`, it is
 *   omitted from the output. Defaults to all enabled.
 */
export function buildMetadata(
	meta: InteractionMeta,
	fields?: MetadataFieldToggles,
): string {
	const f = {
		tools: true,
		call_count: true,
		elapsed: true,
		thinking_blocks: true,
		...fields,
	};

	const fieldStrings: string[] = [];
	if (f.tools) fieldStrings.push(meta.toolNames.join(", "));
	if (f.call_count) fieldStrings.push(`${meta.toolCallCount} calls`);
	if (f.elapsed) fieldStrings.push(`${(meta.elapsedMs / 1000).toFixed(1)}s`);

	const line1 =
		fieldStrings.length > 0 ? `Meta: ${fieldStrings.join(" | ")}` : "Meta:";

	let line2 = "  ";
	if (f.thinking_blocks) {
		line2 += `${meta.thinkingBlocks} blocks | `;
	}
	line2 += `sillajje/${meta.sessionId}`;

	return `${line1}\n${line2}`;
}

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

/**
 * Build the full commit body with labeled sections.
 *
 * Each narrative section (Trace, Prompt, Response) is prefixed with `Label:\n`
 * so the boundary is unambiguous even if the content contains markdown.
 * Metadata is a compact block. Empty sections are omitted.
 *
 * Section order:
 *   subject blank-line Trace blank-line Meta blank-line Prompt blank-line Response
 */
export function buildCommitBody(data: CommitBodyData): string {
	const parts: string[] = [data.subject, ""];

	if (data.trace) {
		parts.push("Trace:", data.trace, "");
	}

	if (data.metadata) {
		parts.push(data.metadata, "");
	}

	if (data.prompt) {
		parts.push("Prompt:", data.prompt, "");
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
