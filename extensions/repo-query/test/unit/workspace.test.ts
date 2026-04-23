import { existsSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearWorkspaceCache, getWorkspacePath } from "../../src/workspace.js";

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
		rmdirSync(path);
	});

	it("returns the same path on repeated calls (in-memory cache)", async () => {
		const ctx = makeCtx({ sessionFile: "/tmp/test-session.json" });
		const path1 = await getWorkspacePath(ctx);
		const path2 = await getWorkspacePath(ctx);

		expect(path1).toBe(path2);
		expect(existsSync(path1)).toBe(true);

		// cleanup
		rmdirSync(path1);
	});

	it("recreates the workspace directory if it was deleted externally", async () => {
		const ctx = makeCtx({ sessionFile: "/tmp/test-session.json" });
		const path = await getWorkspacePath(ctx);
		expect(existsSync(path)).toBe(true);

		// Simulate external cleanup (e.g. /tmp cleared)
		rmdirSync(path);
		expect(existsSync(path)).toBe(false);

		const path2 = await getWorkspacePath(ctx);
		expect(path2).toBe(path);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmdirSync(path2);
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
		rmdirSync(existingWs);
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
		rmdirSync(existingWs);
		rmdirSync(path);
	});

	it("ignores session entries that are not messages", async () => {
		const branch = [{ type: "thinking_level_change", thinkingLevel: "high" }];
		const ctx = makeCtx({ branch });
		const path = await getWorkspacePath(ctx);

		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);
		rmdirSync(path);
	});
});

describe("clearWorkspaceCache", () => {
	it("resets the in-memory cache so the next call recreates the workspace", async () => {
		const ctx = makeCtx({ sessionFile: "/tmp/test-session.json" });
		const path1 = await getWorkspacePath(ctx);
		expect(existsSync(path1)).toBe(true);

		// Delete directory and clear cache
		rmdirSync(path1);
		clearWorkspaceCache();

		// Without cache, getWorkspacePath recomputes from session file
		const path2 = await getWorkspacePath(ctx);
		expect(path2).toBe(path1);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmdirSync(path2);
	});
});
