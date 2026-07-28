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
	it("produces the compact metadata block", () => {
		const result = buildMetadata({
			toolNames: ["read", "write", "bash"],
			toolCallCount: 14,
			elapsedMs: 45200,
			thinkingBlocks: 3,
			sessionId: "abc123",
		});

		expect(result).toContain("Meta: read, write, bash | 14 calls | 45.2s");
		expect(result).toContain("  3 blocks | sillajje/abc123");
	});

	it("handles zero tool calls", () => {
		const result = buildMetadata({
			toolNames: [],
			toolCallCount: 0,
			elapsedMs: 1200,
			thinkingBlocks: 0,
			sessionId: "sess-1",
		});

		expect(result).toContain("Meta:  | 0 calls | 1.2s");
		expect(result).toContain("  0 blocks | sillajje/sess-1");
	});

	it("formats elapsed time with one decimal", () => {
		const meta = {
			toolNames: ["bash"],
			toolCallCount: 1,
			elapsedMs: 15234,
			thinkingBlocks: 0,
			sessionId: "x",
		};

		expect(buildMetadata(meta)).toContain("15.2s");
	});

	it("formats sub-second elapsed time", () => {
		const meta = {
			toolNames: [],
			toolCallCount: 0,
			elapsedMs: 450,
			thinkingBlocks: 0,
			sessionId: "x",
		};

		expect(buildMetadata(meta)).toContain("0.5s");
	});
});

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

describe("buildCommitBody", () => {
	it("builds the full body with Prompt, Meta, Summary, Response sections", () => {
		const body = buildCommitBody({
			subject: "feat: add login page",
			prompt: "Add a login page with email and password fields",
			metadata:
				"Meta: write, edit | 5 calls | 12.3s\n  0 blocks | sillajje/s1",
			response: "I created the login page with form validation.",
			summary:
				"Created the login page with email/password fields and validation.",
		});

		expect(body).toBe(
			[
				"feat: add login page",
				"",
				"Prompt:",
				"Add a login page with email and password fields",
				"",
				"Meta: write, edit | 5 calls | 12.3s",
				"  0 blocks | sillajje/s1",
				"",
				"Summary:",
				"Created the login page with email/password fields and validation.",
				"",
				"Response:",
				"I created the login page with form validation.",
			].join("\n"),
		);
	});

	it("omits Summary section when summary is empty", () => {
		const body = buildCommitBody({
			subject: "fix: bug",
			prompt: "Fix the bug",
			metadata: "Meta: write | 1 calls | 0.5s\n  0 blocks | sillajje/s1",
			response: "Fixed.",
			summary: "",
		});

		expect(body).toBe(
			[
				"fix: bug",
				"",
				"Prompt:",
				"Fix the bug",
				"",
				"Meta: write | 1 calls | 0.5s",
				"  0 blocks | sillajje/s1",
				"",
				"Response:",
				"Fixed.",
			].join("\n"),
		);
		expect(body).not.toContain("undefined");
	});

	it("omits Response section when response is empty", () => {
		const body = buildCommitBody({
			subject: "chore: agent interaction",
			prompt: "hello",
			metadata: "Meta:  | 0 calls | 0.2s\n  0 blocks | sillajje/s1",
			response: "",
			summary: "",
		});

		expect(body).toContain("Prompt:");
		expect(body).toContain("hello");
		expect(body).toContain("chore: agent interaction");
		expect(body).not.toContain("Response:");
		expect(body).not.toContain("undefined");
	});

	it("omits Prompt section when prompt is empty", () => {
		const body = buildCommitBody({
			subject: "fix: crash",
			prompt: "",
			metadata: "Meta: bash | 3 calls | 2.1s\n  0 blocks | sillajje/s1",
			response: "Fixed the crash.",
			summary: "",
		});

		expect(body).toContain("fix: crash");
		expect(body).toContain("Response:");
		expect(body).not.toContain("Prompt:");
	});

	it("handles empty metadata gracefully", () => {
		const body = buildCommitBody({
			subject: "chore: update",
			prompt: "update deps",
			metadata: "",
			response: "",
			summary: "",
		});

		expect(body).toContain("chore: update");
		expect(body).toContain("Prompt:");
		expect(body).not.toContain("Response:");
		expect(body).not.toContain("undefined");
	});
});
