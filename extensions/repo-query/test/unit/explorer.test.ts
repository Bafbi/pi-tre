import { describe, expect, it } from "vitest";

import { processSubagentLine } from "../../src/explorer.js";

describe("processSubagentLine", () => {
	it("extracts text_delta", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } }),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["hello ", "world"]);
	});

	it("extracts thinking_delta", () => {
		const thoughts: string[] = [];
		processSubagentLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "step 1" } }),
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
				message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
			}),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toEqual(["final answer"]);
	});

	it("handles mixed stream of text_delta followed by message_end without duplicated callback arguments", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }),
			(text) => answers.push(text),
			() => {},
		);
		processSubagentLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
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
			JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
			(text) => answers.push(text),
			() => {},
		);
		expect(answers).toHaveLength(0);
	});

	it("ignores message_end when content is not an array", () => {
		const answers: string[] = [];
		processSubagentLine(
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: "not an array" } }),
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
				message: { role: "user", content: [{ type: "text", text: "user text" }] },
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
