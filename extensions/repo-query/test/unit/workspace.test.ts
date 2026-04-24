import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearWorkspaceCache, getWorkspacePath } from "../../src/workspace.js";

let sessionCounter = 0;
function makeSessionFile(): string {
	return join(tmpdir(), `test-session-${Date.now()}-${sessionCounter++}.json`);
}

function makeCtx(opts: { sessionFile?: string | null; branch?: unknown[]; entries?: unknown[] } = {}) {
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionFile: () => opts.sessionFile ?? null,
			getLeafId: () => null,
			getBranch: () => opts.branch ?? [],
			getEntries: () => opts.entries ?? [],
		},
	} as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterEach(() => {
	clearWorkspaceCache();
});

describe("getWorkspacePath", () => {
	it("creates a new workspace on first call with no session file", async () => {
		const ctx = makeCtx();
		const path = await getWorkspacePath(ctx);

		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);
		expect(existsSync(path)).toBe(true);

		// cleanup
		rmSync(path, { recursive: true, force: true });
	});

	it("returns the same path on repeated calls (in-memory cache)", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path1 = await getWorkspacePath(ctx);
		const path2 = await getWorkspacePath(ctx);

		expect(path1).toBe(path2);
		expect(existsSync(path1)).toBe(true);

		// cleanup
		rmSync(path1, { recursive: true, force: true });
	});

	it("recreates the workspace directory if it was deleted externally", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path = await getWorkspacePath(ctx);
		expect(existsSync(path)).toBe(true);

		// Simulate external cleanup (e.g. /tmp cleared)
		rmSync(path, { recursive: true, force: true });
		expect(existsSync(path)).toBe(false);

		const path2 = await getWorkspacePath(ctx);
		expect(path2).toBe(path);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmSync(path2, { recursive: true, force: true });
	});

	it("reuses workspace from previous tool result in session branch", async () => {
		const existingWs = mkdtempSync(join(tmpdir(), "pi-rq-prev-"));
		mkdirSync(existingWs, { recursive: true });

		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "repo_query",
					details: { workspacePath: existingWs },
				},
			},
		];

		const ctx = makeCtx({ branch });
		const path = await getWorkspacePath(ctx);

		expect(path).toBe(existingWs);

		// cleanup
		rmSync(existingWs, { recursive: true, force: true });
	});

	it("ignores non-repo_query tool results when scanning session branch", async () => {
		const existingWs = mkdtempSync(join(tmpdir(), "pi-rq-other-"));
		mkdirSync(existingWs, { recursive: true });

		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "other_tool",
					details: { workspacePath: existingWs },
				},
			},
		];

		const ctx = makeCtx({ branch });
		const path = await getWorkspacePath(ctx);

		// Should NOT reuse the other tool's workspace
		expect(path).not.toBe(existingWs);
		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);

		// cleanup
		rmSync(existingWs, { recursive: true, force: true });
		rmSync(path, { recursive: true, force: true });
	});

	it("ignores session entries that are not messages", async () => {
		const branch = [{ type: "thinking_level_change", thinkingLevel: "high" }];
		const ctx = makeCtx({ branch });
		const path = await getWorkspacePath(ctx);

		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);
		rmSync(path, { recursive: true, force: true });
	});
});

describe("clearWorkspaceCache", () => {
	it("resets the in-memory cache so the next call recreates the workspace", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path1 = await getWorkspacePath(ctx);
		expect(existsSync(path1)).toBe(true);

		// Delete directory and clear cache
		rmSync(path1, { recursive: true, force: true });
		clearWorkspaceCache();

		// Without cache, getWorkspacePath recomputes from session file
		const path2 = await getWorkspacePath(ctx);
		expect(path2).toBe(path1);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmSync(path2, { recursive: true, force: true });
	});
});
