import { describe, expect, it } from "vitest";
import {
	buildCommitBody,
	buildLoop,
	buildMeta,
	deriveSubject,
	type InteractionMeta,
	type LoopField,
	type StampProvenance,
	smartWrap,
} from "../src/index.js";

const prov = (over: Partial<StampProvenance> = {}): StampProvenance => ({
	source: "interaction",
	model: "openai/gpt-4o-mini",
	fallbacks: [],
	env: { piVersion: "test-pi", sillajjeVersion: "test-sillajje" },
	...over,
});

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
// buildMeta — provenance only, no interaction fields
// ---------------------------------------------------------------------------

describe("buildMeta", () => {
	it("renders the source on line 1 and the model and versions on line 2", () => {
		const result = buildMeta(prov());

		expect(result).toBe(
			[
				"source: interaction",
				"  model: openai/gpt-4o-mini | pi: test-pi | sillajje: test-sillajje",
			].join("\n"),
		);
	});

	it("renders the fallbacks beside the source", () => {
		const result = buildMeta(prov({ fallbacks: ["header"] }));

		expect(result).toContain("source: interaction | fallback: header");
	});

	it("omits the fallback field when nothing fell back", () => {
		expect(buildMeta(prov())).not.toContain("fallback");
	});

	it("renders a diff stamp's source and session", () => {
		const result = buildMeta(
			prov({ source: "diff", sessionKey: "test-session" }),
		);

		expect(result).toContain("source: diff");
		expect(result).toContain(
			"  sillajje/test-session | model: openai/gpt-4o-mini",
		);
		expect(result).not.toContain("rev:");
	});

	it("renders a rev stamp's source and rev", () => {
		const result = buildMeta(prov({ source: "rev", rev: "abc123" }));

		expect(result).toBe(
			[
				"source: rev",
				"  rev: abc123 | model: openai/gpt-4o-mini | pi: test-pi | sillajje: test-sillajje",
			].join("\n"),
		);
	});

	it("renders the Interaction's session entry range when the host records one", () => {
		const result = buildMeta(
			prov({
				sessionKey: "test-session",
				interactionRange: { first: "e1", last: "e9" },
			}),
		);

		expect(result).toContain("interaction: e1..e9");
	});

	it("omits the Interaction range when the host records none", () => {
		expect(buildMeta(prov())).not.toContain("interaction:");
	});

	it("appends the jj version when the adapter read one", () => {
		const result = buildMeta(
			prov({
				env: {
					piVersion: "test-pi",
					sillajjeVersion: "test-sillajje",
					jjVersion: "jj 0.44.0",
				},
			}),
		);
		expect(result).toContain(
			"pi: test-pi | sillajje: test-sillajje | jj: jj 0.44.0",
		);
	});

	it("omits the jj version when it is unknown", () => {
		expect(buildMeta(prov())).not.toContain("jj:");
	});

	it("never renders interaction fields", () => {
		expect(buildMeta(prov())).not.toContain("calls");
		expect(buildMeta(prov())).not.toContain("blocks");
	});
});

// ---------------------------------------------------------------------------
// buildLoop — interaction observability only
// ---------------------------------------------------------------------------

describe("buildLoop", () => {
	const meta: InteractionMeta = {
		toolNames: ["read", "write", "bash"],
		toolCallCount: 14,
		elapsedMs: 45200,
		thinkingBlocks: 3,
	};

	it("renders the selected fields in the given order", () => {
		const fields: LoopField[] = ["tools", "call_count", "elapsed"];
		expect(buildLoop(meta, fields)).toBe(
			"read, write, bash | 14 calls | 45.2s",
		);
	});

	it("renders only the selected fields", () => {
		expect(buildLoop(meta, ["thinking_blocks"])).toBe("3 blocks");
	});

	it("handles zero tool calls", () => {
		const empty: InteractionMeta = {
			toolNames: [],
			toolCallCount: 0,
			elapsedMs: 1200,
			thinkingBlocks: 0,
		};
		expect(buildLoop(empty, ["call_count", "elapsed"])).toBe(
			"0 calls | 1.2s",
		);
	});

	it("formats elapsed time with one decimal", () => {
		expect(
			buildLoop({ ...meta, toolCallCount: 1, toolNames: ["bash"] }, [
				"elapsed",
			]),
		).toBe("45.2s");
	});

	it("returns an empty string without interaction data", () => {
		expect(buildLoop(undefined, ["tools"])).toBe("");
	});

	it("returns an empty string with no selected fields", () => {
		expect(buildLoop(meta, [])).toBe("");
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
	it("builds the full body with Trace, Meta, Loop, Prompt, and Response", () => {
		const body = buildCommitBody({
			subject: "feat: add login page",
			prompt: "Add a login page with email and password fields",
			metadata: "source: interaction\n  sillajje/s1 | model: m",
			loop: "write, edit | 5 calls | 12.3s",
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
				"Meta: source: interaction",
				"  sillajje/s1 | model: m",
				"",
				"Loop: write, edit | 5 calls | 12.3s",
				"",
				"Prompt:",
				"Add a login page with email and password fields",
				"",
				"Response:",
				"I created the login page with form validation.",
			].join("\n"),
		);
	});

	it("omits Trace and Loop when both are empty", () => {
		const body = buildCommitBody({
			subject: "fix: bug",
			prompt: "Fix the bug",
			metadata: "source: diff\n  sillajje/s1 | model: m",
			loop: "",
			response: "Fixed.",
			trace: "",
		});

		expect(body).toBe(
			[
				"fix: bug",
				"",
				"Meta: source: diff",
				"  sillajje/s1 | model: m",
				"",
				"Prompt:",
				"Fix the bug",
				"",
				"Response:",
				"Fixed.",
			].join("\n"),
		);
		expect(body).not.toContain("Trace:");
		expect(body).not.toContain("Loop:");
		expect(body).not.toContain("undefined");
	});

	it("omits Response when it is empty", () => {
		const body = buildCommitBody({
			subject: "chore: agent interaction",
			prompt: "hello",
			metadata: "source: diff\n  sillajje/s1 | model: m",
			loop: "",
			response: "",
			trace: "",
		});

		expect(body).toContain("Prompt:");
		expect(body).toContain("hello");
		expect(body).toContain("chore: agent interaction");
		expect(body).not.toContain("Response:");
		expect(body).not.toContain("undefined");
	});

	it("omits Prompt when it is empty", () => {
		const body = buildCommitBody({
			subject: "fix: crash",
			prompt: "",
			metadata: "source: diff\n  sillajje/s1 | model: m",
			loop: "",
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
			loop: "",
			response: "",
			trace: "",
		});

		expect(body).toContain("chore: update");
		expect(body).toContain("Prompt:");
		expect(body).not.toContain("Response:");
		expect(body).not.toContain("undefined");
	});
});
