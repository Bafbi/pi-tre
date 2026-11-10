import { createHash } from "node:crypto";
import { MAX_FINDINGS as FINDINGS_MAX } from "../../src/findings.js";
import {
	buildSystemPrompt,
	findingsInstructions,
	MAX_FINDINGS,
} from "../../src/prompt.js";
import { parseRepoIdentifier } from "../../src/resolver.js";
import {
	REPO_QUERY_DESCRIPTION,
	REPO_QUERY_PROMPT_GUIDELINES,
	REPO_QUERY_PROMPT_SNIPPET,
} from "../../src/tool-prompt.js";

/**
 * The prompts are measured by a benchmark, so an accidental wording change
 * would silently move the baseline. These hashes pin the exact bytes.
 * Recompute a hash only when the wording change is intended.
 */
const sha256 = (text: string): string =>
	createHash("sha256").update(text, "utf8").digest("hex");

const pLimit = parseRepoIdentifier("sindresorhus/p-limit");
const pQueue = parseRepoIdentifier("sindresorhus/p-queue");

describe("buildSystemPrompt", () => {
	it("pins the single-repo prompt", () => {
		const prompt = buildSystemPrompt(
			[pLimit],
			"Where is clearQueue?",
			true,
		);
		expect(sha256(prompt)).toBe(
			"b1b8336f910d2d48a370a2489748afe5ff351b4990edca3450d88ef094cbc276",
		);
		expect(prompt).toContain('in the root of the "sindresorhus/p-limit"');
		expect(prompt.endsWith("\n\nQuery: Where is clearQueue?")).toBe(true);
	});

	it("pins the multi-repo prompt", () => {
		const prompt = buildSystemPrompt(
			[pLimit, pQueue],
			"Compare queues",
			false,
		);
		expect(sha256(prompt)).toBe(
			"51b1acdeaf12448fbd35f50d01f39e2eec2ca4c5a842701898052dade6c6895b",
		);
		// The multi-repo prompt names the tempspace directory of each clone.
		expect(prompt).toContain(
			"- sindresorhus/p-limit (in ./github_sindresorhus_p-limit)",
		);
		expect(prompt).toContain(
			"- sindresorhus/p-queue (in ./github_sindresorhus_p-queue)",
		);
		// The findings example must name a repo the tool can match: matchRepo
		// compares against a display name, so a placeholder leaves every
		// finding unverified.
		expect(prompt).toContain('"repo":"sindresorhus/p-limit"');
		expect(prompt).not.toContain('"repo":"owner/repo"');
		expect(prompt).toContain(
			'exactly as one of: "sindresorhus/p-limit", "sindresorhus/p-queue".',
		);
	});

	it("falls back when no repository is given", () => {
		expect(buildSystemPrompt([], "x", true)).toBe(
			"You are a senior code exploration agent.",
		);
	});

	it("asks for the findings block before the query", () => {
		const prompt = buildSystemPrompt([pQueue], "Any query", true);
		expect(prompt.indexOf("fenced json block")).toBeLessThan(
			prompt.indexOf("Query: Any query"),
		);
	});
});

describe("findingsInstructions", () => {
	it("pins the findings block", () => {
		const block = findingsInstructions(["sindresorhus/p-limit"]);
		expect(sha256(block)).toBe(
			"fc91c571b15ec6efc0a1f4703cfcbe539c375a88f7fea1f43de1862d3c44022e",
		);
		expect(block).toContain(
			'{"findings":[{"repo":"sindresorhus/p-limit","path":"src/file.ts","line":42,"claim":"one sentence"}]}',
		);
		expect(block).toContain("Include at most 20 findings.");
	});

	it("names every repository when there are several", () => {
		const block = findingsInstructions([
			"sindresorhus/p-limit",
			"sindresorhus/p-queue",
		]);
		expect(block).toContain(
			'exactly as one of: "sindresorhus/p-limit", "sindresorhus/p-queue".',
		);
		// The example must be a name the tool can match, not a placeholder.
		expect(block).not.toContain('"repo":"owner/repo"');
	});

	it("keeps one MAX_FINDINGS value for the prompt and the parser", () => {
		expect(FINDINGS_MAX).toBe(MAX_FINDINGS);
		expect(MAX_FINDINGS).toBe(20);
	});
});

describe("parent tool prompt", () => {
	it("pins the tool description", () => {
		expect(sha256(REPO_QUERY_DESCRIPTION)).toBe(
			"931595555c7f736c0e82a7490fb9651004d34453ab00d30a28e9fc4829f88955",
		);
	});

	it("pins the prompt snippet and guidelines", () => {
		expect(REPO_QUERY_PROMPT_SNIPPET).toBe(
			"Query git repositories by cloning them and exploring with a subagent",
		);
		expect(sha256(JSON.stringify(REPO_QUERY_PROMPT_GUIDELINES))).toBe(
			"949b479c845bf61ecf26842db6e5db2ac123f8e96e6e9809ab060aeaa051dac6",
		);
		expect(REPO_QUERY_PROMPT_GUIDELINES).toHaveLength(5);
	});
});
