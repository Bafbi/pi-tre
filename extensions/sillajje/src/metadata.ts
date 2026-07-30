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

/** Default max line width for smart wrapping. */
const DEFAULT_WRAP_WIDTH = 72;

/** Minimum width to attempt wrapping (avoid pathological tiny lines). */
const MIN_WRAP_WIDTH = 40;

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
// smartWrap
// ---------------------------------------------------------------------------

/**
 * Wrap text at word boundaries to a max line width, preserving paragraph
 * and list structure.
 *
 * Heuristic:
 * - Blank lines separate paragraphs.
 * - If a paragraph looks like a numbered list (lines start with ``\d+.``),
 *   wrap each list item independently.
 * - Otherwise, treat the paragraph as prose: join its lines, then reflow
 *   at word boundaries.
 *
 * @param text - The text to wrap.
 * @param maxWidth - Maximum line width (default 72, minimum 40).
 * @returns Wrapped text.
 */
export function smartWrap(text: string, maxWidth = DEFAULT_WRAP_WIDTH): string {
	if (maxWidth < MIN_WRAP_WIDTH) maxWidth = MIN_WRAP_WIDTH;
	if (text.length === 0) return text;

	const paragraphs = text.split(/\n\s*\n/);

	return paragraphs
		.map((para) => {
			let trimmed = para;
			// Trim trailing whitespace only — preserve leading indent.
			// But if the paragraph is all whitespace, skip it.
			if (/^\s*$/.test(para)) return "";
			// Strip trailing whitespace per line.
			trimmed = para.replace(/\s+$/gm, "");

			const lines = trimmed.split("\n");
			const isNumberedList = lines.some((l) => /^\d+\.\s/.test(l.trim()));

			if (isNumberedList) {
				// Wrap each list item independently.
				return lines
					.map((line) => wordWrapLine(line, maxWidth))
					.join("\n");
			}

			// Prose: join all lines in the paragraph, then reflow.
			// Preserve leading whitespace (indent) separately so we don't
			// collapse it during the whitespace normalization.
			const indentMatch = trimmed.match(/^(\s+)/);
			const indent = indentMatch ? indentMatch[1] : "";
			const body = trimmed.slice(indent.length);
			const joined =
				indent + body.replace(/\n/g, " ").replace(/\s+/g, " ");
			return wordWrapLine(joined, maxWidth);
		})
		.join("\n\n");
}

/**
 * Word-wrap a single line at word boundaries.
 * Preserves leading whitespace (indentation) on every wrapped line.
 */
function wordWrapLine(line: string, maxWidth: number): string {
	const indentMatch = line.match(/^(\s+)/);
	const indent = indentMatch ? indentMatch[1] : "";
	const content = line.trimStart();

	if (content.length <= maxWidth) return line;

	const words = content.split(/\s+/);
	if (words.length <= 1) return line;

	const result: string[] = [];
	let currentLine = indent;

	for (const word of words) {
		const candidate =
			currentLine === indent
				? `${indent}${word}`
				: `${currentLine} ${word}`;
		if (candidate.length <= maxWidth) {
			currentLine = candidate;
		} else {
			result.push(currentLine);
			currentLine = `${indent}${word}`;
		}
	}

	if (currentLine.length > 0) {
		result.push(currentLine);
	}

	return result.join("\n");
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
