import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createWebSearchExtension } from "../../src/index.js";

/** Build a mock ExtensionAPI that captures the registered tool. */
export function captureExtension(
	overrides?: Parameters<typeof createWebSearchExtension>[0],
): ToolDefinition {
	let captured: ToolDefinition | undefined;
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: ToolDefinition) => {
			if (definition.name === "search_web") captured = definition;
		},
	} as unknown as ExtensionAPI;
	createWebSearchExtension(overrides)(pi);
	if (!captured)
		throw new Error("the extension registered no search_web tool");
	return captured;
}

/** Minimal tool context covering what the extension reads. */
export function makeContext(
	cwd: string,
	overrides: Partial<ExtensionToolContext> = {},
): ExtensionToolContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		isProjectTrusted: () => true,
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
		},
		tools: [],
		executeTool: async () => {
			throw new Error("executeTool is not available in makeContext");
		},
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionName: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		...overrides,
	} as unknown as ExtensionToolContext;
}

/** A temp dir that the test removes afterwards. */
export function makeTempDir(prefix: string, created: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/** Write the global config layer into a temp config directory. */
export function writeGlobalConfig(configDir: string, config: unknown): void {
	writeFileSync(join(configDir, "web-search.json"), JSON.stringify(config));
}

/** Write the project config layer under a repo root. */
export function writeProjectConfig(repoRoot: string, config: unknown): void {
	const dir = join(repoRoot, ".pi", "configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
}

/** Remove the temp dirs created by a test. */
export function cleanup(created: string[]): void {
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}
