import { describe, expect, it } from "vitest";
import {
	buildCommitBody,
	buildMetadata,
	deriveSubject,
} from "../../src/metadata";

// ---------------------------------------------------------------------------
// deriveSubject
// ---------------------------------------------------------------------------

describe("deriveSubject", () => {
	it("uses the first line of the prompt as subject, truncated to 72 chars", () => {
		expect(deriveSubject("Implement a new feature for the dashboard")).toBe(
			"Implement a new feature for the dashboard",
		);
	});

	it("truncates long single-line prompts to 72 chars", () => {
		const long =
			"Implement a comprehensive user authentication system with OAuth2 and SAML support";
		expect(deriveSubject(long)).toBe(
			"Implement a comprehensive user authentication system with OAuth2 and ...",
		);
	});

	it("uses only the first line of multi-line prompts", () => {
		expect(
			deriveSubject(
				"Fix the login bug\n\nWhen users enter invalid credentials, the error message is not shown.",
			),
		).toBe("Fix the login bug");
	});

	it("falls back when prompt is empty", () => {
		expect(deriveSubject("")).toBe("chore: agent interaction");
	});

	it("falls back when prompt is only whitespace", () => {
		expect(deriveSubject("   \n  \n ")).toBe("chore: agent interaction");
	});
});

// ---------------------------------------------------------------------------
// buildMetadata
// ---------------------------------------------------------------------------

describe("buildMetadata", () => {
	it("produces the metadata block with all fields", () => {
		const result = buildMetadata({
			toolNames: ["read", "write", "bash"],
			toolCallCount: 14,
			elapsedMs: 45200,
			thinkingBlocks: 3,
			sessionId: "abc123",
		});

		expect(result).toContain("tools_used: read, write, bash");
		expect(result).toContain("tool_calls: 14");
		expect(result).toContain("elapsed: 45.2s");
		expect(result).toContain("thinking_blocks: 3");
		expect(result).toContain("workspace: sillajje/abc123");
		expect(result).toContain("generated_by: sillajje");
	});

	it("handles zero tool calls", () => {
		const result = buildMetadata({
			toolNames: [],
			toolCallCount: 0,
			elapsedMs: 1200,
			thinkingBlocks: 0,
			sessionId: "sess-1",
		});

		expect(result).toContain("tools_used:");
		expect(result).toContain("tool_calls: 0");
		expect(result).toContain("elapsed: 1.2s");
		expect(result).toContain("thinking_blocks: 0");
	});

	it("formats elapsed time with one decimal", () => {
		const meta = {
			toolNames: ["bash"],
			toolCallCount: 1,
			elapsedMs: 15234,
			thinkingBlocks: 0,
			sessionId: "x",
		};

		expect(buildMetadata(meta)).toContain("elapsed: 15.2s");
	});

	it("formats sub-second elapsed time", () => {
		const meta = {
			toolNames: [],
			toolCallCount: 0,
			elapsedMs: 450,
			thinkingBlocks: 0,
			sessionId: "x",
		};

		expect(buildMetadata(meta)).toContain("elapsed: 0.5s");
	});
});

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

describe("buildCommitBody", () => {
	it("builds the full commit body with all sections", () => {
		const body = buildCommitBody({
			subject: "feat: add login page",
			prompt: "Add a login page with email and password fields",
			metadata: "tools_used: write, edit\ntool_calls: 5\nelapsed: 12.3s",
			response: "I created the login page with form validation.",
		});

		expect(body).toBe(
			[
				"feat: add login page",
				"",
				"Add a login page with email and password fields",
				"",
				"tools_used: write, edit",
				"tool_calls: 5",
				"elapsed: 12.3s",
				"",
				"I created the login page with form validation.",
			].join("\n"),
		);
	});

	it("handles empty response", () => {
		const body = buildCommitBody({
			subject: "chore: agent interaction",
			prompt: "hello",
			metadata: "tools_used:\ntool_calls: 0",
			response: "",
		});

		expect(body).toContain("hello");
		expect(body).toContain("chore: agent interaction");
		expect(body).not.toContain("undefined");
	});
});
