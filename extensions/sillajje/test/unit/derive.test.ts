/**
 * Tests for `deriveInteractionData` — the adapter's pi-shaped transcript seam.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { deriveInteractionData } from "../../src/derive.js";

/** Build a UserMessage fixture. */
function userMsg(text: string, timestamp = 1000): Message {
	return {
		role: "user",
		content: text,
		timestamp,
	} as Message;
}

/** Build an AssistantMessage fixture with text content. */
function assistantMsg(
	text: string,
	opts?: {
		toolCalls?: Array<{
			id: string;
			name: string;
			arguments?: Record<string, unknown>;
		}>;
		thinking?: boolean;
		timestamp?: number;
	},
): Message {
	const content: Array<Record<string, unknown>> = [];
	if (opts?.thinking) {
		content.push({
			type: "thinking",
			thinking: "Let me think about this...",
		});
	}
	if (opts?.toolCalls) {
		for (const tc of opts.toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: tc.arguments ?? {},
			});
		}
	}
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: opts?.timestamp ?? 2000,
	} as unknown as Message;
}

/** Build a UserMessage with content blocks (for multi-block user content). */
function userMsgBlocks(
	blocks: Array<{ type: string; text?: string }>,
	timestamp = 1000,
): Message {
	return {
		role: "user",
		content: blocks,
		timestamp,
	} as Message;
}

describe("deriveInteractionData", () => {
	it("derives prompt from the first user message text", () => {
		const msgs: Message[] = [
			userMsg("Hello, world!"),
			assistantMsg("Hi there!"),
		];

		const data = deriveInteractionData(msgs);
		expect(data).toBeDefined();
		expect(data!.prompt).toBe("Hello, world!");
	});

	it("derives prompt from user message with content blocks", () => {
		const msgs: Message[] = [
			userMsgBlocks([{ type: "text", text: "First line" }]),
			assistantMsg("Response"),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.prompt).toBe("First line");
	});

	it("derives response from the last assistant message text", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("First response", { timestamp: 2000 }),
			assistantMsg("Final response", { timestamp: 3000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.response).toBe("Final response");
	});

	it("counts thinking blocks across all assistant messages", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("First", { thinking: true, timestamp: 2000 }),
			assistantMsg("Second", { thinking: true, timestamp: 3000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.thinkingBlocks).toBe(2);
	});

	it("counts tool calls and collects unique tool names", () => {
		const msgs: Message[] = [
			userMsg("Do something"),
			assistantMsg("Done", {
				toolCalls: [
					{ id: "tc-1", name: "write" },
					{ id: "tc-2", name: "bash" },
					{ id: "tc-3", name: "write" },
				],
			}),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.toolCallCount).toBe(3);
		expect(data!.toolNames).toEqual(
			expect.arrayContaining(["write", "bash"]),
		);
	});

	it("calculates elapsed from first and last message timestamps", () => {
		const msgs: Message[] = [
			userMsg("Query", 1000),
			assistantMsg("Response", { timestamp: 5000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.elapsedMs).toBe(4000);
	});

	it("returns undefined when no user message exists", () => {
		const msgs: Message[] = [assistantMsg("Solo")];
		expect(deriveInteractionData(msgs)).toBeUndefined();
	});

	it("returns undefined when no assistant message exists", () => {
		const msgs: Message[] = [userMsg("Solo")];
		expect(deriveInteractionData(msgs)).toBeUndefined();
	});

	it("correctly counts tools across multiple assistant messages", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("Halfway", {
				toolCalls: [{ id: "tc-1", name: "read" }],
				timestamp: 2000,
			}),
			assistantMsg("Done", {
				toolCalls: [
					{ id: "tc-2", name: "write" },
					{ id: "tc-3", name: "bash" },
				],
				timestamp: 4000,
			}),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.toolCallCount).toBe(3);
		expect(data!.toolNames).toHaveLength(3);
	});
});
