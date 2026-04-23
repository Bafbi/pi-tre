import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AuthStorage,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { clearWorkspaceCache } from "../../src/workspace.js";

const tempDirs: string[] = [];

async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolve(process.cwd(), "extensions/repo-query/src/index.ts");
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRegistry = ModelRegistry.create(AuthStorage.create(join(cwd, "auth.json")));
	return new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, modelRegistry);
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
	} as unknown as import("@mariozechner/pi-tui").Theme;
}

describe("repo_query rendering", () => {
	it("renderCall produces expected header text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const widget = repoQueryTool.definition.renderCall(
			{ query: "test query", repos: ["owner/repo", "other/repo"] },
			theme,
			undefined,
		);

		expect(widget.text).toContain("repo_query");
		expect(widget.text).toContain("owner/repo");
		expect(widget.text).toContain('"test query"');
	});

	it("renderResult partial view does NOT start with a newline", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [
					{ identifier: "owner/repo", status: "success", warnings: [] },
					{ identifier: "other/repo", status: "success", warnings: [] },
				],
				phase: "exploring" as const,
				thought: "Thinking line 1\nThinking line 2",
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			undefined,
		);

		expect(widget.text).toBeDefined();
		const text = (widget as unknown as { text: string }).text;

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
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [{ identifier: "owner/repo", status: "clone_failed", warnings: [], error: "fail" }],
				phase: "cloning" as const,
				thought: undefined,
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			undefined,
		);

		const text = (widget as unknown as { text: string }).text;
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("owner/repo");
		expect(text).toContain("clone failed");
	});

	it("renderResult collapsed view does NOT start with a newline", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "repo-query-render-test-"));
		tempDirs.push(cwd);

		const runner = await createRunner(cwd);
		const tools = runner.getAllRegisteredTools();
		const repoQueryTool = tools.find((t) => t.definition.name === "repo_query");
		expect(repoQueryTool).toBeDefined();
		if (!repoQueryTool) throw new Error("repo_query tool not found");

		const theme = mockTheme();
		const result = {
			content: [{ type: "text" as const, text: "answer text" }],
			details: {
				query: "test query",
				workspacePath: "/tmp/ws",
				results: [{ identifier: "owner/repo", status: "success", warnings: [], answer: "The answer." }],
				phase: "complete" as const,
			},
		};

		const widget = repoQueryTool.definition.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			undefined,
		);

		const text = (widget as unknown as { text: string }).text;
		expect(text.startsWith("\n")).toBe(false);
		expect(text).toContain("repo_query");
		expect(text).toContain("owner/repo");
	});
});
