import {
	type AgentToolResult,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";

import {
	type RepoQueryRenderState,
	renderCall,
	renderResult,
	type ToolRenderLike,
} from "../../src/render.js";
import type { RepoQueryDetails } from "../../src/types.js";

/** Minimal mock theme that returns text unchanged. */
function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as import("@earendil-works/pi-tui").Theme;
}

/** Build a minimal render context for testing. */
function mockRenderContext(overrides?: {
	state?: RepoQueryRenderState;
	lastComponent?: Component;
}): ToolRenderLike {
	return {
		args: { query: "", repos: [] },
		toolCallId: "test",
		invalidate: () => {},
		lastComponent: overrides?.lastComponent,
		state: overrides?.state ?? {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

function makeResult(
	details: Partial<RepoQueryDetails>,
): AgentToolResult<RepoQueryDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: {
			query: "test query",
			workspacePath: "/tmp/ws",
			results: [],
			phase: "complete",
			...details,
		},
	} as AgentToolResult<RepoQueryDetails>;
}

const okRepo = {
	identifier: "owner/repo",
	status: "success" as const,
	warnings: [],
};

function renderText(
	result: AgentToolResult<RepoQueryDetails>,
	options: { expanded?: boolean; isPartial?: boolean },
	ctx: ToolRenderLike,
): string {
	return renderResult(
		result,
		{
			expanded: options.expanded ?? false,
			isPartial: options.isPartial ?? false,
		},
		mockTheme(),
		ctx,
	)
		.render(200)
		.join("\n");
}

describe("repo_query rendering", () => {
	beforeAll(() => {
		// keyHint reads pi's global theme; initialize it outside the TUI.
		initTheme(undefined, false);
	});

	it("renderCall produces expected header text", () => {
		const widget = renderCall(
			{ query: "test query", repos: ["owner/repo", "other/repo"] },
			mockTheme(),
			mockRenderContext(),
		);

		const text = widget.render(100).join("\n");
		expect(text).toContain("repo_query");
		expect(text).toContain("owner/repo");
		expect(text).toContain('"test query"');
	});

	it("renderResult partial view does NOT start with a newline", () => {
		const result = makeResult({
			results: [
				okRepo,
				{ identifier: "other/repo", status: "success", warnings: [] },
			],
			phase: "exploring",
			thought: "Thinking line 1\nThinking line 2",
		});

		const text = renderText(
			result,
			{ isPartial: true },
			mockRenderContext(),
		);

		// The regression: partial view used to prepend \n to every line,
		// creating a leading blank line that visually separated the static
		// call header from the dynamic body.
		expect(text.startsWith("\n")).toBe(false);

		// Sanity: it still contains the expected content
		expect(text).toContain("owner/repo");
		expect(text).toContain("other/repo");
		expect(text).toContain("Thinking line 2");
	});

	it("renderResult partial view handles empty thought gracefully", () => {
		const result = makeResult({
			results: [
				{
					identifier: "owner/repo",
					status: "clone_failed",
					warnings: [],
					error: "fail",
				},
			],
			phase: "cloning",
			thought: undefined,
		});

		const text = renderText(
			result,
			{ isPartial: true },
			mockRenderContext(),
		);
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("owner/repo");
		expect(text).toContain("clone failed");
	});

	it("renderResult collapsed view does NOT start with a newline and shows the expand hint", () => {
		const result = makeResult({ results: [okRepo], answer: "The answer." });

		const text = renderText(result, {}, mockRenderContext());
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("repo_query");
		expect(text).toContain("owner/repo");
		expect(text).toContain("to expand");
	});

	it("renderResult returns same component instance on successive calls", () => {
		const ctx = mockRenderContext();
		const result = makeResult({ results: [okRepo], answer: "The answer." });

		const first = renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme(),
			ctx,
		);

		// Simulate framework storing the returned component in lastComponent
		ctx.lastComponent = first;

		const second = renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme(),
			ctx,
		);

		expect(second).toBe(first);
	});

	it("renderResult partial view includes elapsed time", () => {
		const ctx = mockRenderContext({
			state: { startedAt: Date.now() - 5000 },
		});
		const result = makeResult({
			results: [okRepo],
			phase: "exploring",
			thought: "Thinking...",
		});

		expect(renderText(result, { isPartial: true }, ctx)).toContain(
			"Elapsed",
		);

		// Clean up the interval that was started by the partial render
		const state = ctx.state as RepoQueryRenderState;
		if (state.interval) clearInterval(state.interval);
	});

	it("renderResult final view includes took time", () => {
		const ctx = mockRenderContext({
			state: { startedAt: Date.now() - 5000, endedAt: Date.now() },
		});
		const result = makeResult({ results: [okRepo], answer: "The answer." });

		expect(renderText(result, {}, ctx)).toContain("Took");
	});

	it("expanded view shows the answer from details and the subagent usage", () => {
		const result = makeResult({
			results: [okRepo],
			answer: "The answer.",
			usage: {
				turns: 3,
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.0123,
				totalTokens: 1500,
			},
		});

		const text = renderText(
			result,
			{ expanded: true },
			mockRenderContext(),
		);
		expect(text).toContain("Answer:");
		expect(text).toContain("The answer.");
		expect(text).toContain("Usage:");
		expect(text).toContain("3 turns");
		expect(text).toContain("1500 tokens");
		expect(text).toContain("$0.0123");
	});
});
