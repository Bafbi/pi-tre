/**
 * Commit body and metadata rendering.
 *
 * Pure functions over the section seam. They never import pi.
 *
 * Each Action owns its provenance section: `buildMeta` renders a stamp's
 * provenance facts and `buildLoop` renders a stamp's interaction
 * observability. `buildCommitBody` assembles the stamp's sections in order.
 */

import type { ProvenanceVersions } from "./action.js";
import { assembleDescription, type Section } from "./body.js";
import {
	FOLD_BODY_SECTIONS,
	type FoldBodySection,
	LOOP_FIELDS,
	type LoopField,
	STAMP_BODY_SECTIONS,
	type StampBodySection,
} from "./config.js";

// Re-exported so consumers keep importing the section vocabulary here.
export type { FoldBodySection, LoopField, StampBodySection };
export { FOLD_BODY_SECTIONS, LOOP_FIELDS, STAMP_BODY_SECTIONS };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a stamp's generated message was produced from. */
export type StampSource = "interaction" | "diff" | "rev";

/** The Interaction's session entry range. */
export interface InteractionRange {
	first: string;
	last: string;
}

/**
 * A stamp's provenance facts — what the message was generated from. They
 * render in the `Meta:` section on every stamp; the interaction fields of a
 * stamp render separately in `Loop:`.
 */
export interface StampProvenance {
	source: StampSource;
	/** Stamped session's key — the trail the change joins. */
	sessionKey?: string | undefined;
	/** Target rev (Rev stamp). */
	rev?: string | undefined;
	/** Interaction's session entry range, when the host records one. */
	interactionRange?: InteractionRange | undefined;
	/** Sub-generator model used for the generated message. */
	model: string;
	/** Sub-generator fallbacks that fired, e.g. `["header"]`. */
	fallbacks: string[];
	env: ProvenanceVersions;
}

/** Interaction observability derived from a host transcript. */
export interface InteractionMeta {
	toolNames: string[];
	toolCallCount: number;
	elapsedMs: number;
	thinkingBlocks: number;
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
	/** Interaction observability. Empty string omits the section. */
	loop: string;
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
// buildMeta
// ---------------------------------------------------------------------------

/**
 * Build a stamp's `Meta:` body — the two lines of provenance, without the
 * label. The assembler renders the label.
 *
 * Line 1: the Source that produced the message, then the sub-generator
 * fallbacks that fired, when any.
 * Line 2: the ids the stamp touched (session key, target rev), then the
 * model and the pi, sillajje, and jj versions. Any field with nothing
 * behind it is omitted.
 *
 * Provenance is the audit record: the section renders whenever `meta` is in
 * the stamp's body list, and no field inside it is individually toggleable.
 */
export function buildMeta(provenance: StampProvenance): string {
	const line1: string[] = [`source: ${provenance.source}`];
	if (provenance.fallbacks.length > 0) {
		line1.push(`fallback: ${provenance.fallbacks.join(",")}`);
	}

	const line2: string[] = [];
	if (provenance.sessionKey !== undefined) {
		line2.push(`sillajje/${provenance.sessionKey}`);
	}
	if (provenance.rev !== undefined) {
		line2.push(`rev: ${provenance.rev}`);
	}
	if (provenance.interactionRange !== undefined) {
		line2.push(
			`interaction: ${provenance.interactionRange.first}..${provenance.interactionRange.last}`,
		);
	}
	line2.push(`model: ${provenance.model}`);
	line2.push(`pi: ${provenance.env.piVersion}`);
	line2.push(`sillajje: ${provenance.env.sillajjeVersion}`);
	if (provenance.env.jjVersion !== undefined) {
		line2.push(`jj: ${provenance.env.jjVersion}`);
	}

	return `${line1.join(" | ")}\n  ${line2.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// buildLoop
// ---------------------------------------------------------------------------

/**
 * Build a stamp's `Loop:` body: the selected interaction fields, joined by
 * ` | `. The label is rendered by the assembler.
 *
 * Returns an empty string without interaction data or without a selected
 * field, so a diff-only stamp omits the section.
 */
export function buildLoop(
	meta: InteractionMeta | undefined,
	fields: readonly LoopField[],
): string {
	if (meta === undefined) return "";

	const parts: string[] = [];
	for (const field of fields) {
		switch (field) {
			case "tools":
				if (meta.toolNames.length > 0) {
					parts.push(meta.toolNames.join(", "));
				}
				break;
			case "call_count":
				parts.push(`${meta.toolCallCount} calls`);
				break;
			case "elapsed":
				parts.push(`${(meta.elapsedMs / 1000).toFixed(1)}s`);
				break;
			case "thinking_blocks":
				parts.push(`${meta.thinkingBlocks} blocks`);
				break;
		}
	}

	return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// smartWrap
// ---------------------------------------------------------------------------

/** Default max line width for smart wrapping. */
const DEFAULT_WRAP_WIDTH = 72;

/** Minimum width to attempt wrapping (avoid pathological tiny lines). */
const MIN_WRAP_WIDTH = 40;

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
			const indentMatch = /^(\s+)/.exec(trimmed);
			const indent = indentMatch?.[1] ?? "";
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
	const indentMatch = /^(\s+)/.exec(line);
	const indent = indentMatch?.[1] ?? "";
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
 * Build the full stamp commit description: subject, then the configured
 * sections in the configured order. Empty sections are omitted.
 *
 * The metadata and loop sections render inline (`Meta: <line1>\n  <line2>`,
 * `Loop: <fields>`). The default order is
 * `[trace, meta, loop, prompt, response]`.
 */
export function buildCommitBody(
	data: CommitBodyData,
	order: readonly StampBodySection[] = STAMP_BODY_SECTIONS,
): string {
	const sections: Record<StampBodySection, Section> = {
		trace: { label: "Trace", body: data.trace },
		meta: { label: "Meta", body: data.metadata, inline: true },
		loop: { label: "Loop", body: data.loop, inline: true },
		prompt: { label: "Prompt", body: data.prompt },
		response: { label: "Response", body: data.response },
	};
	return assembleDescription(
		data.subject,
		order.map((key) => sections[key]),
	);
}

/** The content a fold's body renders: a generated summary and a source ref. */
export interface FoldBodyData {
	subject: string;
	summary: string;
	/** `Ref: <base>..<tip>`, using change ids. */
	ref: string;
}

/**
 * Build a fold's commit description: subject, then the configured sections.
 * The default order is `[summary, ref]`; the `Ref:` line renders inline.
 */
export function buildFoldBody(
	data: FoldBodyData,
	order: readonly FoldBodySection[] = FOLD_BODY_SECTIONS,
): string {
	const sections: Record<FoldBodySection, Section> = {
		summary: { label: "Summary", body: data.summary },
		ref: { label: "Ref", body: data.ref, inline: true },
	};
	return assembleDescription(
		data.subject,
		order.map((key) => sections[key]),
	);
}
