import { describe, expect, it } from "vitest";

import { extractAssistantText } from "../../src/stamp";

// ---------------------------------------------------------------------------
// extractAssistantText — filters assistant message content blocks to text
// and joins them with newlines. Pure function, table-driven tests.
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
	it("joins multiple text blocks with newlines", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "First part" },
				{ type: "text", text: "Second part" },
			],
		};
		expect(extractAssistantText(msg)).toBe("First part\nSecond part");
	});

	it("returns a single text block unchanged", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "Just this." }],
		};
		expect(extractAssistantText(msg)).toBe("Just this.");
	});

	it("returns empty string for non-assistant roles", () => {
		const msg = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
		};
		expect(extractAssistantText(msg)).toBe("");
	});

	it("returns empty string when content is null", () => {
		const msg = { role: "assistant", content: null };
		expect(extractAssistantText(msg)).toBe("");
	});

	it("returns empty string when content is undefined", () => {
		const msg = { role: "assistant" };
		expect(extractAssistantText(msg)).toBe("");
	});

	it("returns empty string when content has no text blocks", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "read", input: {} },
				{ type: "thinking", thinking: "reasoning..." },
			],
		};
		expect(extractAssistantText(msg)).toBe("");
	});

	it("returns empty string for an empty content array", () => {
		const msg = { role: "assistant", content: [] };
		expect(extractAssistantText(msg)).toBe("");
	});

	it("ignores non-text blocks interleaved with text blocks", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "..." },
				{ type: "text", text: "The answer" },
				{ type: "tool_use", id: "t1", name: "bash", input: {} },
				{ type: "text", text: "follows." },
			],
		};
		expect(extractAssistantText(msg)).toBe("The answer\nfollows.");
	});

	it("treats text blocks without a text field as empty strings", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text" }, { type: "text", text: "Real" }],
		};
		expect(extractAssistantText(msg)).toBe("\nReal");
	});
});
