import { describe, expect, it } from "vitest";

import { formatMessage } from "../../src/formatter.js";

function userMsg(content: string): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content, timestamp: 0 };
}

function userBlocks(...blocks: Array<{ type: "text"; text: string } | { type: "image" }>): {
	role: "user";
	content: Array<{ type: "text"; text: string } | { type: "image" }>;
	timestamp: number;
} {
	return { role: "user", content: blocks, timestamp: 0 };
}

function assistantBlocks(
	...blocks: Array<
		{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; name: string }
	>
): {
	role: "assistant";
	content: Array<
		{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; name: string }
	>;
	api: string;
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	stopReason: "stop";
	timestamp: number;
} {
	return {
		role: "assistant",
		content: blocks,
		api: "openai",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("formatMessage", () => {
	it("returns user string content as-is", () => {
		const result = formatMessage(userMsg("hello world"));
		expect(result).toBe("hello world");
	});

	it("returns null for empty user string", () => {
		const result = formatMessage(userMsg(""));
		expect(result).toBeNull();
	});

	it("extracts text from user blocks", () => {
		const result = formatMessage(userBlocks({ type: "text", text: "line one" }));
		expect(result).toBe("line one");
	});

	it("joins multiple user text blocks with separator", () => {
		const result = formatMessage(userBlocks({ type: "text", text: "first" }, { type: "text", text: "second" }));
		expect(result).toBe("first\n~~~\nsecond");
	});

	it("renders images as [image] in user blocks", () => {
		const result = formatMessage(userBlocks({ type: "text", text: "look:" }, { type: "image" }));
		expect(result).toBe("look:\n~~~\n[image]");
	});

	it("returns [image] for image-only user message", () => {
		const result = formatMessage(userBlocks({ type: "image" }));
		expect(result).toBe("[image]");
	});

	it("extracts assistant text blocks", () => {
		const result = formatMessage(assistantBlocks({ type: "text", text: "hi" }));
		expect(result).toBe("hi");
	});

	it("drops assistant thinking blocks", () => {
		const result = formatMessage(
			assistantBlocks({ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }),
		);
		expect(result).toBe("hi");
	});

	it("drops assistant toolCall blocks", () => {
		const result = formatMessage(assistantBlocks({ type: "text", text: "ok" }, { type: "toolCall", name: "read" }));
		expect(result).toBe("ok");
	});

	it("joins multiple assistant text blocks with separator", () => {
		const result = formatMessage(assistantBlocks({ type: "text", text: "a" }, { type: "text", text: "b" }));
		expect(result).toBe("a\n~~~\nb");
	});

	it("returns null for assistant with no text blocks", () => {
		const result = formatMessage(assistantBlocks({ type: "thinking", thinking: "..." }));
		expect(result).toBeNull();
	});
});
