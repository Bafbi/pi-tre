import { describe, expect, it } from "vitest";

import {
	isReadOnlyDelegateTitle,
	READ_ONLY_DELEGATE_TITLE_PREFIX,
	readOnlyDelegateToolBlock,
} from "../../src/read-only-delegate.js";

describe("isReadOnlyDelegateTitle", () => {
	it("is true when the title starts with the prefix", () => {
		expect(
			isReadOnlyDelegateTitle(
				`${READ_ONLY_DELEGATE_TITLE_PREFIX} repo_query: owner/repo`,
			),
		).toBe(true);
	});

	it("ignores leading whitespace", () => {
		expect(
			isReadOnlyDelegateTitle(
				`  ${READ_ONLY_DELEGATE_TITLE_PREFIX} task`,
			),
		).toBe(true);
	});

	it("is false for a normal title", () => {
		expect(isReadOnlyDelegateTitle("repo_query: owner/repo")).toBe(false);
	});

	it("is false for a missing title", () => {
		expect(isReadOnlyDelegateTitle(undefined)).toBe(false);
		expect(isReadOnlyDelegateTitle(null)).toBe(false);
	});
});

describe("readOnlyDelegateToolBlock", () => {
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
			expect(readOnlyDelegateToolBlock(tool)).toMatchObject({
				block: true,
			});
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
			expect(readOnlyDelegateToolBlock(tool)).toBeUndefined();
		}
	});
});
