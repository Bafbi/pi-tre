import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { clearWorkspaceCache } from "../../src/workspace.js";

const tempDirs: string[] = [];

async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolve(
		process.cwd(),
		"extensions/repo-query/src/index.ts",
	);
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		allowModelNetwork: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		sessionManager,
		modelRegistry,
	);
}

afterEach(async () => {
	clearWorkspaceCache();
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** Minimal mock theme that returns text unchanged. */
function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as import("@earendil-works/pi-tui").Theme;
}

/** Build a minimal ToolRenderContext for testing. */
function mockRenderContext(
	overrides?: Partial<ToolRenderContext>,
): ToolRenderContext {
	return {
		args: { query: "", repos: [] },
		toolCallId: "test",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

describe("repo_query rendering", () => {
	it("renderCall produces expected header text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo", "other/repo"] },
		});
		const widget = repoQueryTool.definition.renderCall(
			{ query: "test query", repos: ["owner/repo", "other/repo"] },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");
		expect(text).toContain("repo_query");
		expect(text).toContain("owner/repo");
		expect(text).toContain('"test query"');
	});

	it("renderResult partial view does NOT start with a newline", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo", "other/repo"] },
		});
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
					},
					{
						identifier: "other/repo",
						status: "success",
						warnings: [],
					},
				],
				phase: "exploring" as const,
				thought: "Thinking line 1\nThinking line 2",
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");

		// The regression: partial view used to prepend \n to every line,
		// creating a leading blank line that visually separated the static
		// call header from the dynamic body.
		expect(text.startsWith("\n")).toBe(false);

		// Sanity: it still contains the expected content
		expect(text).toContain("owner/repo");
		expect(text).toContain("other/repo");
		expect(text).toContain("Thinking line 2");
	});

	it("renderResult partial view handles empty thought gracefully", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
		});
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "clone_failed",
						warnings: [],
						error: "fail",
					},
				],
				phase: "cloning" as const,
				thought: undefined,
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("owner/repo");
		expect(text).toContain("clone failed");
	});

	it("renderResult collapsed view does NOT start with a newline", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
		});
		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
						answer: "The answer.",
					},
				],
				phase: "complete" as const,
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("repo_query");
		expect(text).toContain("owner/repo");
	});

	it("renderResult returns same component instance on successive calls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
		});

		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
						answer: "The answer.",
					},
				],
				phase: "complete" as const,
			},
		};

		const first = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		// Simulate framework storing the returned component in lastComponent
		(ctx as { lastComponent: Component | undefined }).lastComponent = first;

		const second = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		expect(second).toBe(first);
	});

	it("renderResult sets startedAt when executionStarted is true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
			executionStarted: true,
			state: {},
		});

		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
						answer: "The answer.",
					},
				],
				phase: "complete" as const,
			},
		};

		repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		expect(typeof (ctx.state as { startedAt?: number }).startedAt).toBe(
			"number",
		);
	});

	it("renderResult sets endedAt when isPartial is false", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
			executionStarted: true,
			state: { startedAt: Date.now() - 3000 },
		});

		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
						answer: "The answer.",
					},
				],
				phase: "complete" as const,
			},
		};

		repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		expect(typeof (ctx.state as { endedAt?: number }).endedAt).toBe(
			"number",
		);
	});

	it("renderResult partial view includes elapsed time", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo", "other/repo"] },
			state: { startedAt: Date.now() - 5000 },
		});

		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
					},
					{
						identifier: "other/repo",
						status: "success",
						warnings: [],
					},
				],
				phase: "exploring" as const,
				thought: "Thinking...",
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");
		expect(text).toContain("Elapsed");

		// Clean up the interval that was started by the partial render
		if (
			(ctx.state as { interval?: ReturnType<typeof setInterval> })
				.interval
		) {
			clearInterval(
				(ctx.state as { interval?: ReturnType<typeof setInterval> })
					.interval,
			);
		}
	});

	it("renderResult final view includes took time", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find(
			(t) => t.definition.name === "repo_query",
		);
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const ctx = mockRenderContext({
			args: { query: "test query", repos: ["owner/repo"] },
			state: { startedAt: Date.now() - 5000, endedAt: Date.now() },
		});

		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{
						identifier: "owner/repo",
						status: "success",
						warnings: [],
						answer: "The answer.",
					},
				],
				phase: "complete" as const,
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);

		const text = widget.render(100).join("\n");
		expect(text).toContain("Took");
	});
});
