/**
 * Build the change metadata block for the commit body.
 *
 * Pure function — issue 04 will implement the full metadata block.
 */

export interface InteractionMeta {
	toolNames: string[];
	toolCallCount: number;
	elapsedMs: number;
	thinkingBlocks: number;
	sessionId: string;
}

export function buildMetadata(_meta: InteractionMeta): string {
	return "";
}
