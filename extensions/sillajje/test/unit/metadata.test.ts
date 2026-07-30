import { describe, expect, it } from "vitest";
import {
	buildCommitBody,
	buildMetadata,
	deriveSubject,
	smartWrap,
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

	// -------------------------------------------------------------------
	// Field toggles
	// -------------------------------------------------------------------

	it("omits tools when tools field is false", () => {
		const result = buildMetadata(
			{
				toolNames: ["read", "write", "bash"],
				toolCallCount: 14,
				elapsedMs: 45200,
				thinkingBlocks: 3,
				sessionId: "abc123",
			},
			{ tools: false },
		);

		expect(result).not.toContain("read, write, bash");
		expect(result).toContain("14 calls");
		expect(result).toContain("45.2s");
	});

	it("omits call_count when call_count field is false", () => {
		const result = buildMetadata(
			{
				toolNames: ["bash"],
				toolCallCount: 5,
				elapsedMs: 10000,
				thinkingBlocks: 1,
				sessionId: "s1",
			},
			{ call_count: false },
		);

		expect(result).toContain("bash");
		expect(result).not.toContain("5 calls");
		expect(result).toContain("10.0s");
	});

	it("omits elapsed when elapsed field is false", () => {
		const result = buildMetadata(
			{
				toolNames: ["bash"],
				toolCallCount: 3,
				elapsedMs: 5000,
				thinkingBlocks: 0,
				sessionId: "s1",
			},
			{ elapsed: false },
		);

		expect(result).toContain("bash");
		expect(result).toContain("3 calls");
		expect(result).not.toContain("5.0s");
	});

	it("omits thinking_blocks when thinking_blocks field is false", () => {
		const result = buildMetadata(
			{
				toolNames: ["bash"],
				toolCallCount: 1,
				elapsedMs: 1000,
				thinkingBlocks: 3,
				sessionId: "s1",
			},
			{ thinking_blocks: false },
		);

		expect(result).toContain("bash");
		expect(result).not.toContain("3 blocks");
		expect(result).toContain("sillajje/s1");
	});

	it("omits multiple fields when multiple toggles are off", () => {
		const result = buildMetadata(
			{
				toolNames: ["bash", "read"],
				toolCallCount: 7,
				elapsedMs: 25000,
				thinkingBlocks: 2,
				sessionId: "s1",
			},
			{ tools: false, elapsed: false },
		);

		expect(result).not.toContain("bash, read");
		expect(result).toContain("7 calls");
		expect(result).not.toContain("25.0s");
		expect(result).toContain("2 blocks");
	});
});

// ---------------------------------------------------------------------------
// smartWrap
// ---------------------------------------------------------------------------

describe("smartWrap", () => {
	it("wraps long prose lines at word boundaries", () => {
		const long =
			"The agent was tasked with adding a manual stamp command but first used the domain-modeling skill to thoroughly understand the existing auto-stamping flow.";
		const result = smartWrap(long, 40);
		const lines = result.split("\n");
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toContain("The agent was tasked");
		expect(result).not.toContain("\n ");
	});

	it("preserves paragraph breaks in prose", () => {
		const text = [
			"The agent read the auth middleware and identified the null pointer. It added a null check before the user lookup.",
			"",
			"The fix was applied and tests pass. The agent also updated the related test file to cover the edge case.",
		].join("\n");
		const result = smartWrap(text, 50);
		const paragraphs = result.split("\n\n");
		expect(paragraphs).toHaveLength(2);
		for (const para of paragraphs) {
			for (const line of para.split("\n")) {
				expect(line.length).toBeLessThanOrEqual(50);
			}
		}
	});

	it("wraps numbered list items independently", () => {
		const steps = [
			"1. Read the auth middleware file to understand the authentication flow and identify the root cause of the null pointer exception.",
			"2. Added a null check before the user lookup in the authentication chain to prevent the crash.",
			"3. Ran tests to verify the fix works correctly across all edge cases.",
		].join("\n");
		const result = smartWrap(steps, 40);
		const lines = result.split("\n");
		expect(lines[0]).toMatch(/^1\./);
		expect(lines).toContain("3. Ran tests to verify the fix works");
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});

	it("returns short text unchanged", () => {
		const short = "Short text.";
		expect(smartWrap(short, 72)).toBe(short);
	});

	it("returns empty string unchanged", () => {
		expect(smartWrap("", 72)).toBe("");
	});

	it("enforces minimum width of 40", () => {
		const long = "The agent was tasked with adding a manual stamp command.";
		const result = smartWrap(long, 10);
		// Should have used MIN_WRAP_WIDTH (40) instead of 10
		for (const line of result.split("\n")) {
			expect(line.length).toBeGreaterThan(10);
		}
	});

	it("preserves indentation on continuation lines", () => {
		const indented =
			"    The agent was tasked with adding a manual stamp command but first used the domain-modeling skill.";
		const result = smartWrap(indented, 40);
		const lines = result.split("\n");
		for (const line of lines) {
			// All lines should have at least 4 spaces of indent
			expect(line.startsWith("    ")).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// buildCommitBody
// ---------------------------------------------------------------------------

describe("buildCommitBody", () => {
	it("builds the full body with Trace, Meta, Prompt, Response sections", () => {
		const body = buildCommitBody({
			subject: "feat: add login page",
			prompt: "Add a login page with email and password fields",
			metadata:
				"Meta: write, edit | 5 calls | 12.3s\n  0 blocks | sillajje/s1",
			response: "I created the login page with form validation.",
			trace: "Created the login page with email/password fields and validation.",
		});

		expect(body).toBe(
			[
				"feat: add login page",
				"",
				"Trace:",
				"Created the login page with email/password fields and validation.",
				"",
				"Meta: write, edit | 5 calls | 12.3s",
				"  0 blocks | sillajje/s1",
				"",
				"Prompt:",
				"Add a login page with email and password fields",
				"",
				"Response:",
				"I created the login page with form validation.",
			].join("\n"),
		);
	});

	it("omits Trace section when trace is empty", () => {
		const body = buildCommitBody({
			subject: "fix: bug",
			prompt: "Fix the bug",
			metadata: "Meta: write | 1 calls | 0.5s\n  0 blocks | sillajje/s1",
			response: "Fixed.",
			trace: "",
		});

		expect(body).toBe(
			[
				"fix: bug",
				"",
				"Meta: write | 1 calls | 0.5s",
				"  0 blocks | sillajje/s1",
				"",
				"Prompt:",
				"Fix the bug",
				"",
				"Response:",
				"Fixed.",
			].join("\n"),
		);
		expect(body).not.toContain("Trace:");
		expect(body).not.toContain("undefined");
	});

	it("omits Response section when response is empty", () => {
		const body = buildCommitBody({
			subject: "chore: agent interaction",
			prompt: "hello",
			metadata: "Meta:  | 0 calls | 0.2s\n  0 blocks | sillajje/s1",
			response: "",
			trace: "",
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
			trace: "",
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
			trace: "",
		});

		expect(body).toContain("chore: update");
		expect(body).toContain("Prompt:");
		expect(body).not.toContain("Response:");
		expect(body).not.toContain("undefined");
	});
});
