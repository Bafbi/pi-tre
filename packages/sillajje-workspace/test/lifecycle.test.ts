import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkspaces,
	directoryExists,
	ownerFrom,
	repoSlug,
} from "../src/index.js";
import { type FakeJjState, fakeJj } from "./helpers.js";

const OWNER = "alice/laptop";
const temps: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	while (temps.length > 0) {
		rmSync(temps.pop() as string, { recursive: true, force: true });
	}
});

function binding(
	state: Partial<FakeJjState>,
	repoRoot: string,
	workspacesRoot: string,
) {
	const fake = fakeJj(state);
	return {
		ws: createWorkspaces(fake.jj, {
			repoRoot,
			workspacesRoot,
			owner: OWNER,
		}),
		state: fake.state,
	};
}

// ---------------------------------------------------------------------------
// Pure resolution
// ---------------------------------------------------------------------------

describe("ownerFrom", () => {
	it("keeps dots and replaces spaces", () => {
		expect(ownerFrom("alice", "my laptop")).toBe("alice/my-laptop");
		expect(ownerFrom("Alice Smith", "My.Host")).toBe("Alice-Smith/My.Host");
	});

	it("falls back to unknown when a half sanitizes to nothing", () => {
		expect(ownerFrom("!!!", "host")).toBe("unknown/host");
	});
});

describe("repoSlug", () => {
	it("is the basename of the repo root", () => {
		expect(repoSlug("/home/me/code/foo")).toBe("foo");
	});
});

describe("pure naming", () => {
	const { ws } = binding({}, "/home/me/code/foo", "/tmp/ws");

	it("qualifies a session id with the owner", () => {
		expect(ws.sessionKey("abc")).toBe("alice/laptop/abc");
	});

	it("names the workspace and bookmark after the session key", () => {
		expect(ws.workspaceName("alice/laptop/abc")).toBe(
			"sillajje/alice/laptop/abc",
		);
		expect(ws.bookmarkName("alice/laptop/abc")).toBe(
			"sillajje/alice/laptop/abc",
		);
	});

	it("strips the owner from the directory path", () => {
		expect(ws.workspacePath("alice/laptop/abc")).toBe("/tmp/ws/foo/abc");
		expect(ws.workspacePath("alice/laptop/abc-2")).toBe(
			"/tmp/ws/foo/abc-2",
		);
	});
});

describe("directoryExists", () => {
	it("tracks the filesystem", () => {
		const dir = tempDir("sillajje-dir-");
		expect(directoryExists(dir)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
		expect(directoryExists(dir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ensure
// ---------------------------------------------------------------------------

describe("ensure", () => {
	it("reports created after forgetting the name and adding the workspace", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding({}, "/home/me/code/foo", wsRoot);

		const result = await ws.ensure("abc");

		expect(result).toEqual({
			ok: true,
			status: "created",
			workspace: {
				sessionKey: "alice/laptop/abc",
				workspaceName: "sillajje/alice/laptop/abc",
				workspacePath: `${wsRoot}/foo/abc`,
			},
		});
		// Forget runs before add, so a phantom registration cannot fail the add.
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
		expect(state.added).toEqual([
			{
				name: "sillajje/alice/laptop/abc",
				revision: "@-",
				path: `${wsRoot}/foo/abc`,
			},
		]);
	});

	it("falls back to @ when @- does not exist", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding(
			{ logError: true },
			"/home/me/code/foo",
			wsRoot,
		);

		await ws.ensure("abc");

		expect(state.added[0]!.revision).toBe("@");
	});

	it("reports reused for a registered workspace whose directory exists", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const path = `${wsRoot}/foo/abc`;
		mkdirSync(path, { recursive: true });
		const { ws, state } = binding(
			{ workspaces: [{ name: "sillajje/alice/laptop/abc", root: path }] },
			"/home/me/code/foo",
			wsRoot,
		);

		const result = await ws.ensure("abc");

		expect(result).toEqual({
			ok: true,
			status: "reused",
			workspace: {
				sessionKey: "alice/laptop/abc",
				workspaceName: "sillajje/alice/laptop/abc",
				workspacePath: path,
			},
		});
		expect(state.added).toEqual([]);
		expect(state.forgotten).toEqual([]);
	});

	it("suffixes past an orphan directory and leaves it in place", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const orphan = `${wsRoot}/foo/abc`;
		mkdirSync(orphan, { recursive: true });
		const { ws, state } = binding({}, "/home/me/code/foo", wsRoot);

		const result = await ws.ensure("abc");

		expect(result).toEqual({
			ok: true,
			status: "created",
			workspace: {
				sessionKey: "alice/laptop/abc-2",
				workspaceName: "sillajje/alice/laptop/abc-2",
				workspacePath: `${wsRoot}/foo/abc-2`,
			},
		});
		expect(existsSync(orphan)).toBe(true);
		expect(state.added[0]!.name).toBe("sillajje/alice/laptop/abc-2");
	});

	it("recreates a registered workspace whose directory is missing", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding(
			{ workspaces: [{ name: "sillajje/alice/laptop/abc", root: "" }] },
			"/home/me/code/foo",
			wsRoot,
		);

		const result = await ws.ensure("abc");

		expect(result.ok).toBe(true);
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
		expect(state.added[0]!.name).toBe("sillajje/alice/laptop/abc");
	});

	it("refuses an archived session instead of rebuilding it", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding(
			{
				bookmarks: [
					{ name: "sillajje/alice/laptop/abc", target: ["x"] },
				],
			},
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.ensure("abc")).resolves.toEqual({
			ok: false,
			reason: "archived",
		});
		expect(state.added).toEqual([]);
		expect(state.forgotten).toEqual([]);
	});

	it("propagates a workspace add failure", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws } = binding(
			{ addError: "no such revision" },
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.ensure("abc")).rejects.toThrow("no such revision");
	});
});

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

describe("lookup", () => {
	it("matches the full workspace name", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws } = binding(
			{
				workspaces: [
					{ name: "sillajje/alice/laptop/abc", root: "/ws/abc" },
					{ name: "sillajje/alice/laptop/abc-2", root: "/ws/abc-2" },
				],
			},
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.lookup("alice/laptop/abc")).resolves.toBe("/ws/abc");
	});

	it("does not let abc-2 satisfy a lookup for abc", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws } = binding(
			{
				workspaces: [
					{ name: "sillajje/alice/laptop/abc-2", root: "/ws/x" },
				],
			},
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.lookup("alice/laptop/abc")).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

describe("archive", () => {
	it("reports removed after forgetting and deleting the directory", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const path = `${wsRoot}/foo/abc`;
		mkdirSync(path, { recursive: true });
		const { ws, state } = binding({}, "/home/me/code/foo", wsRoot);

		await expect(ws.archive("alice/laptop/abc")).resolves.toEqual({
			status: "removed",
		});
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
		expect(existsSync(path)).toBe(false);
	});

	it("forgets and reports already-gone when the directory is absent", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding({}, "/home/me/code/foo", wsRoot);

		await expect(ws.archive("alice/laptop/abc")).resolves.toEqual({
			status: "already-gone",
		});
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
	});

	it("reports failed when forget rejects", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws } = binding(
			{ forgetError: "lock held" },
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.archive("alice/laptop/abc")).resolves.toEqual({
			status: "failed",
			reason: "lock held",
		});
	});

	it("forgets a registration whose root is blank and reports already-gone", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding(
			{ workspaces: [{ name: "sillajje/alice/laptop/abc", root: "" }] },
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.archive("alice/laptop/abc")).resolves.toEqual({
			status: "already-gone",
		});
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
	});

	it.skipIf(process.getuid?.() === 0)(
		"reports failed when directory removal throws",
		async () => {
			const wsRoot = tempDir("sillajje-ws-root-");
			const parent = `${wsRoot}/foo`;
			mkdirSync(`${parent}/abc`, { recursive: true });
			chmodSync(parent, 0o500);
			try {
				const { ws } = binding({}, "/home/me/code/foo", wsRoot);
				const outcome = await ws.archive("alice/laptop/abc");
				expect(outcome.status).toBe("failed");
			} finally {
				chmodSync(parent, 0o700);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// unarchive
// ---------------------------------------------------------------------------

describe("unarchive", () => {
	it("recreates the workspace from the session bookmark", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws, state } = binding({}, "/home/me/code/foo", wsRoot);

		const info = await ws.unarchive("alice/laptop/abc");

		expect(info.workspacePath).toBe(`${wsRoot}/foo/abc`);
		expect(state.forgotten).toEqual(["sillajje/alice/laptop/abc"]);
		expect(state.added).toEqual([
			{
				name: "sillajje/alice/laptop/abc",
				revision: "sillajje/alice/laptop/abc",
				path: `${wsRoot}/foo/abc`,
			},
		]);
	});

	it("propagates a workspace add failure", async () => {
		const wsRoot = tempDir("sillajje-ws-root-");
		const { ws } = binding(
			{ addError: "no such revision" },
			"/home/me/code/foo",
			wsRoot,
		);

		await expect(ws.unarchive("alice/laptop/abc")).rejects.toThrow(
			"no such revision",
		);
	});
});
