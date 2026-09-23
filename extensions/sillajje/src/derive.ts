/**
 * Derive interaction data from pi's Message[] transcript.
 *
 * The adapter owns this pi-shaped seam. The core's stamp action takes the
 * derived `InteractionData`, never pi's `Message[]`.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { InteractionData } from "@pi-tre/sillajje-core";

// ---------------------------------------------------------------------------
// extractAssistantText
// ---------------------------------------------------------------------------

/**
 * Extract the concatenated text from an AssistantMessage's content blocks.
 * Filters to only `text` blocks and joins with newlines.
 */
export function extractAssistantText(msg: {
	role?: unknown;
	content?: unknown;
}): string {
	if (msg.role !== undefined && msg.role !== "assistant") return "";
	const content = msg.content as
		| Array<{ type: string; text?: string }>
		| null
		| undefined;
	if (!content) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// deriveInteractionData
// ---------------------------------------------------------------------------

/**
 * Derive interaction data from pi's Message[] transcript.
 *
 * - prompt: text from the first UserMessage
 * - response: text from the last AssistantMessage
 * - toolNames: set of unique toolCall names across all assistant messages
 * - toolCallCount: total toolCall blocks
 * - thinkingBlocks: total ThinkingContent blocks
 * - elapsedMs: last message timestamp - first message timestamp
 *
 * Returns `undefined` when there are no user or assistant messages.
 */
export function deriveInteractionData(
	messages: Message[],
): InteractionData | undefined {
	const userMsgs = messages.filter((m) => m.role === "user");
	const assistantMsgs = messages.filter((m) => m.role === "assistant");

	if (userMsgs.length === 0 || assistantMsgs.length === 0) return undefined;

	// Prompt: first user message text
	const firstUser = userMsgs[0];
	if (firstUser === undefined) return undefined;
	let prompt = "";
	if (typeof firstUser.content === "string") {
		prompt = firstUser.content.trim();
	} else {
		prompt = (firstUser.content ?? [])
			.filter((b) => "type" in b && b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n")
			.trim();
	}

	// Response: last assistant message text
	const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
	if (lastAssistant === undefined) return undefined;
	const response = extractAssistantText(lastAssistant);

	// Tool calls and thinking blocks from all assistant messages
	const toolNames = new Set<string>();
	let toolCallCount = 0;
	let thinkingBlocks = 0;

	for (const msg of assistantMsgs) {
		const content = msg.content ?? [];
		for (const block of content) {
			if (block.type === "toolCall") {
				toolCallCount++;
				toolNames.add(block.name);
			} else if (block.type === "thinking") {
				thinkingBlocks++;
			}
		}
	}

	// Elapsed: last message timestamp minus first
	const firstMessage = messages[0];
	const lastMessage = messages[messages.length - 1];
	if (firstMessage === undefined || lastMessage === undefined) {
		return undefined;
	}
	const firstTimestamp = firstMessage.timestamp;
	const lastTimestamp = lastMessage.timestamp;
	const elapsedMs = Math.max(0, lastTimestamp - firstTimestamp);

	return {
		prompt,
		response,
		toolNames: [...toolNames],
		toolCallCount,
		thinkingBlocks,
		elapsedMs,
	};
}
