import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTempspaceCache, getTempspacePath } from "../../src/tempspace.js";

let sessionCounter = 0;
function makeSessionFile(): string {
	return join(
		tmpdir(),
		`test-session-${Date.now()}-${sessionCounter++}.json`,
	);
}

function makeCtx(
	opts: {
		sessionFile?: string | null;
		branch?: unknown[];
		entries?: unknown[];
	} = {},
) {
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionFile: () => opts.sessionFile ?? null,
			getLeafId: () => null,
			getBranch: () => opts.branch ?? [],
			getEntries: () => opts.entries ?? [],
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function toolResultEntry(details: Record<string, unknown>) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "repo_query",
			details,
		},
	};
}

beforeEach(() => {
	clearTempspaceCache();
});

afterEach(() => {
	clearTempspaceCache();
});

describe("getTempspacePath", () => {
	it("creates a new tempspace on first call with no session file", async () => {
		const ctx = makeCtx();
		const path = await getTempspacePath(ctx);

		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);
		expect(existsSync(path)).toBe(true);

		// cleanup
		rmSync(path, { recursive: true, force: true });
	});

	it("returns the same path on repeated calls (in-memory cache)", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path1 = await getTempspacePath(ctx);
		const path2 = await getTempspacePath(ctx);

		expect(path1).toBe(path2);
		expect(existsSync(path1)).toBe(true);

		// cleanup
		rmSync(path1, { recursive: true, force: true });
	});

	it("recreates the tempspace directory if it was deleted externally", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path = await getTempspacePath(ctx);
		expect(existsSync(path)).toBe(true);

		// Simulate external cleanup (e.g. /tmp cleared)
		rmSync(path, { recursive: true, force: true });
		expect(existsSync(path)).toBe(false);

		const path2 = await getTempspacePath(ctx);
		expect(path2).toBe(path);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmSync(path2, { recursive: true, force: true });
	});

	it("reuses the tempspace from a previous tool result in the session branch", async () => {
		const existingWs = mkdtempSync(join(tmpdir(), "pi-rq-prev-"));
		mkdirSync(existingWs, { recursive: true });

		const ctx = makeCtx({
			branch: [toolResultEntry({ tempspacePath: existingWs })],
		});
		const path = await getTempspacePath(ctx);

		expect(path).toBe(existingWs);

		// cleanup
		rmSync(existingWs, { recursive: true, force: true });
	});

	it("reuses the tempspace of a session recorded under the old details key", async () => {
		const existingWs = mkdtempSync(join(tmpdir(), "pi-rq-legacy-"));
		mkdirSync(existingWs, { recursive: true });

		const ctx = makeCtx({
			branch: [toolResultEntry({ workspacePath: existingWs })],
		});
		const path = await getTempspacePath(ctx);

		expect(path).toBe(existingWs);

		// cleanup
		rmSync(existingWs, { recursive: true, force: true });
	});

	it("ignores non-repo_query tool results when scanning the session branch", async () => {
		const existingWs = mkdtempSync(join(tmpdir(), "pi-rq-other-"));
		mkdirSync(existingWs, { recursive: true });

		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "other_tool",
					details: { tempspacePath: existingWs },
				},
			},
		];

		const ctx = makeCtx({ branch });
		const path = await getTempspacePath(ctx);

		// Should NOT reuse the other tool's tempspace
		expect(path).not.toBe(existingWs);
		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);

		// cleanup
		rmSync(existingWs, { recursive: true, force: true });
		rmSync(path, { recursive: true, force: true });
	});

	it("ignores session entries that are not messages", async () => {
		const branch = [
			{ type: "thinking_level_change", thinkingLevel: "high" },
		];
		const ctx = makeCtx({ branch });
		const path = await getTempspacePath(ctx);

		expect(path.startsWith(join(tmpdir(), "pi-rq-"))).toBe(true);
		rmSync(path, { recursive: true, force: true });
	});
});

describe("clearTempspaceCache", () => {
	it("resets the in-memory cache so the next call recreates the tempspace", async () => {
		const ctx = makeCtx({ sessionFile: makeSessionFile() });
		const path1 = await getTempspacePath(ctx);
		expect(existsSync(path1)).toBe(true);

		// Delete directory and clear cache
		rmSync(path1, { recursive: true, force: true });
		clearTempspaceCache();

		// Without cache, getTempspacePath recomputes from session file
		const path2 = await getTempspacePath(ctx);
		expect(path2).toBe(path1);
		expect(existsSync(path2)).toBe(true);

		// cleanup
		rmSync(path2, { recursive: true, force: true });
	});
});
