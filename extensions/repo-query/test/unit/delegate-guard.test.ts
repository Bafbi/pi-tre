import { describe, expect, it } from "vitest";

import {
	branchHasDelegateMarker,
	DELEGATE_MARKER_PREFIX,
	delegateToolBlock,
} from "../../src/delegate-guard.js";

const marker = `${DELEGATE_MARKER_PREFIX}test`;

function userMessage(content: unknown) {
	return { type: "message", message: { role: "user", content } };
}

describe("branchHasDelegateMarker", () => {
	it("finds the marker in a text part", () => {
		expect(
			branchHasDelegateMarker([
				userMessage([{ type: "text", text: `Task. ${marker}` }]),
			]),
		).toBe(true);
	});

	it("finds the marker in a string content", () => {
		expect(branchHasDelegateMarker([userMessage(`Task. ${marker}`)])).toBe(
			true,
		);
	});

	it("ignores a marker in an assistant message", () => {
		expect(
			branchHasDelegateMarker([
				{
					type: "message",
					message: { role: "assistant", content: marker },
				},
			]),
		).toBe(false);
	});

	it("returns false without the marker", () => {
		expect(branchHasDelegateMarker([userMessage("Normal task.")])).toBe(
			false,
		);
	});

	it("ignores non-message entries", () => {
		expect(
			branchHasDelegateMarker([
				{ type: "custom", message: { role: "user", content: marker } },
			]),
		).toBe(false);
	});
});

describe("delegateToolBlock", () => {
	it("blocks writes, shells, recursion, and T3 control tools", () => {
		for (const tool of [
			"write",
			"edit",
			"bash",
			"powershell",
			"repo_query",
			"mcp__t3-code__delegate_task",
			"mcp__t3-code__create_threads",
			"mcp__t3-code__schedule_task",
			"mcp__t3-code__request_secret",
		]) {
			expect(delegateToolBlock(tool)).toMatchObject({ block: true });
		}
	});

	it("allows only the read-only tools and codemode", () => {
		for (const tool of [
			"read",
			"grep",
			"find",
			"ls",
			"codemode",
			"tool_search",
		]) {
			expect(delegateToolBlock(tool)).toBeUndefined();
		}
	});
});
