import { describe, expect, test } from "vitest";

import { parseModelReference } from "../../src/subagent.js";

describe("parseModelReference", () => {
	test("parses provider/model reference", () => {
		const parsed = parseModelReference("anthropic/claude-sonnet-4-5");

		expect(parsed.provider).toBe("anthropic");
		expect(parsed.model).toBe("claude-sonnet-4-5");
	});

	test("keeps bare model reference", () => {
		const parsed = parseModelReference("claude-sonnet-4-5");

		expect(parsed.provider).toBeUndefined();
		expect(parsed.model).toBe("claude-sonnet-4-5");
	});

	test("supports model ids containing additional slashes", () => {
		const parsed = parseModelReference("openrouter/qwen/qwen3-coder");

		expect(parsed.provider).toBe("openrouter");
		expect(parsed.model).toBe("qwen/qwen3-coder");
	});

	test("rejects malformed provider/model", () => {
		expect(() => parseModelReference("anthropic/")).toThrowError(/provider\/model/);
		expect(() => parseModelReference("/claude-sonnet-4-5")).toThrowError(/provider\/model/);
	});
});
