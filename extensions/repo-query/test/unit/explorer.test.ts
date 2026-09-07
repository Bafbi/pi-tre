import { describe, expect, it } from "vitest";

import {
	processSubagentLine,
	type SubagentMessageInfo,
} from "../../src/explorer.js";

describe("processSubagentLine", () => {
	it("extracts text_delta", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello " },
			}),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["hello ", "world"]);
	});

	it("extracts thinking_delta", () => {
		const thoughts: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "step 1",
				},
			}),
			() => {},
			(text) => thoughts.push(text),
		);
		expect(thoughts).toEqual(["step 1"]);
	});

	it("extracts text from message_end", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
				},
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["final answer"]);
	});

	it("handles mixed stream of text_delta followed by message_end without duplicated callback arguments", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello " },
			}),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			}),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
				},
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["Hello ", "world", "Hello world"]);
		expect(new Set(answers).size).toBe(answers.length);
	});

	it("ignores message_end when content is missing", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant" },
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toHaveLength(0);
	});

	it("ignores message_end when content is not an array", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: "not an array" },
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toHaveLength(0);
	});

	it("ignores message_end for non-assistant roles", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "user text" }],
				},
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toHaveLength(0);
	});

	it("skips parts without text type", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "image", url: "http://example.com/img.png" },
						{ type: "text", text: "only this" },
					],
				},
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["only this"]);
	});

	it("ignores invalid JSON lines", () => {
		const answers: string[] = [];
		const thoughts: string[] = [];
		processSubagentLine(
			"not json",
			(text) => answers.push(text),
			(text) => thoughts.push(text),
		);
		expect(answers).toHaveLength(0);
		expect(thoughts).toHaveLength(0);
	});

	it("ignores non-object JSON", () => {
		const answers: string[] = [];
		processSubagentLine(
			"42",
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toHaveLength(0);
	});
});

describe("processSubagentLine usage and stopReason", () => {
	it("fires the assistant-message callback with usage on message_end", () => {
		const messages: SubagentMessageInfo[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						totalTokens: 165,
						cost: { total: 0.01 },
					},
					stopReason: "stop",
				},
			}),
			() => {},
			() => {},
			(info) => messages.push(info),
		);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.usage?.input).toBe(100);
		expect(messages[0]?.usage?.totalTokens).toBe(165);
		expect(messages[0]?.usage?.cost?.total).toBe(0.01);
		expect(messages[0]?.stopReason).toBe("stop");
	});

	it("reports stopReason error with its error message", () => {
		const messages: SubagentMessageInfo[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					stopReason: "error",
					errorMessage: "provider overloaded",
				},
			}),
			() => {},
			() => {},
			(info) => messages.push(info),
		);

		expect(messages[0]?.stopReason).toBe("error");
		expect(messages[0]?.errorMessage).toBe("provider overloaded");
	});

	it("omits the assistant-message callback when message_end has no usage", () => {
		const messages: SubagentMessageInfo[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
				},
			}),
			() => {},
			() => {},
			(info) => messages.push(info),
		);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.usage).toBeUndefined();
		expect(messages[0]?.stopReason).toBeUndefined();
	});

	it("does not fire the assistant-message callback for user messages", () => {
		const messages: SubagentMessageInfo[] = [];
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			}),
			() => {},
			() => {},
			(info) => messages.push(info),
		);

		expect(messages).toHaveLength(0);
	});
});
