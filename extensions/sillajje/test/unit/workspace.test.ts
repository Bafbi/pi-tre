import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	bookmarkExists,
	cleanupWorkspace,
	createWorkspace,
	type ExecFn,
	getRepoSlug,
	getWorkspacePathByName,
	resolveWorkspacePath,
	unarchiveWorkspace,
	workspaceExists,
	workspaceForget,
	workspaceName,
} from "../../src/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = ""): { code: number; stdout: string; stderr: string } {
	return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "error"): {
	code: number;
	stdout: string;
	stderr: string;
} {
	return { code: 1, stdout: "", stderr };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("getRepoSlug", () => {
	it("returns the basename of the repo root", () => {
		expect(getRepoSlug("/home/user/projects/my-repo")).toBe("my-repo");
		expect(getRepoSlug("/tmp/test")).toBe("test");
	});
});

describe("resolveWorkspacePath", () => {
	it("builds path from workspaces root, repo slug, and session ID", () => {
		expect(
			resolveWorkspacePath("/home/user/repo", "abc123", "/tmp/ws"),
		).toBe("/tmp/ws/repo/abc123");
	});
});

describe("workspaceName", () => {
	it("prefixes the session ID with sillajje-", () => {
		expect(workspaceName("abc123")).toBe("sillajje-abc123");
	});
});

// ---------------------------------------------------------------------------
// createWorkspace
// ---------------------------------------------------------------------------

describe("createWorkspace", () => {
	it("calls jj workspace add with --revision @- when @- exists", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-ws-test-"));
		const wsRoot = join(tmpDir, "workspaces");
		const repo = join(tmpDir, "repo");

		// First call: @- exists, second call: workspace add succeeds
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok());

		const info = await createWorkspace(exec, repo, "abc123", wsRoot);

		expect(info.workspaceName).toBe("sillajje-abc123");
		expect(info.workspacePath).toBe(`${wsRoot}/repo/abc123`);
		expect(existsSync(wsRoot)).toBe(true);

		expect(exec).toHaveBeenCalledTimes(2);
		// First call: check @- exists
		const [logCmd, logArgs, logOpts] = exec.mock.calls[0];
		expect(logCmd).toBe("jj");
		expect(logArgs).toEqual(["log", "-r", "@-"]);
		expect(logOpts).toEqual({ cwd: repo });

		// Second call: workspace add with @-
		const [cmd, args, opts] = exec.mock.calls[1];
		expect(cmd).toBe("jj");
		expect(args[0]).toBe("workspace");
		expect(args[1]).toBe("add");
		expect(args[2]).toBe("--name");
		expect(args[3]).toBe("sillajje-abc123");
		expect(args[4]).toBe("--revision");
		expect(args[5]).toBe("@-");
		expect(args[6]).toBe(`${wsRoot}/repo/abc123`);
		expect(opts).toEqual({ cwd: repo });

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("falls back to --revision @ when @- does not exist", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-ws-test-"));
		const wsRoot = join(tmpDir, "workspaces");
		const repo = join(tmpDir, "repo");

		// First call: @- doesn't exist, second call: workspace add succeeds
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce(fail("revset @- not found"))
			.mockResolvedValueOnce(ok());

		const info = await createWorkspace(exec, repo, "abc123", wsRoot);

		expect(info.workspaceName).toBe("sillajje-abc123");
		expect(info.workspacePath).toBe(`${wsRoot}/repo/abc123`);

		expect(exec).toHaveBeenCalledTimes(2);
		// Second call: workspace add with @ (fallback)
		const [, args] = exec.mock.calls[1];
		expect(args[4]).toBe("--revision");
		expect(args[5]).toBe("@");

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns existing workspace path when directory already exists (idempotent)", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-ws-test-"));
		const wsRoot = join(tmpDir, "workspaces");
		const repo = join(tmpDir, "repo");
		const wsPath = `${wsRoot}/repo/abc123`;

		mkdirSync(wsPath, { recursive: true });

		const exec = vi.fn<ExecFn>();
		const info = await createWorkspace(exec, repo, "abc123", wsRoot);

		expect(info.workspacePath).toBe(wsPath);
		expect(info.workspaceName).toBe("sillajje-abc123");
		expect(exec).not.toHaveBeenCalled();

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("throws when jj workspace add fails", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-ws-test-"));
		const wsRoot = join(tmpDir, "workspaces");
		const repo = join(tmpDir, "repo");

		// First call: @- exists, second call: workspace add fails
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail("no such revision"));

		await expect(
			createWorkspace(exec, repo, "abc123", wsRoot),
		).rejects.toThrow("jj workspace add failed");

		rmSync(tmpDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// workspaceExists
// ---------------------------------------------------------------------------

describe("workspaceExists", () => {
	it("returns true when workspace name appears in jj workspace list", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(
				ok("default: /repo\nsillajje-abc123: /tmp/ws/repo/abc123\n"),
			);

		await expect(workspaceExists(exec, "sillajje-abc123")).resolves.toBe(
			true,
		);
	});

	it("returns false when workspace not in list", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok("default: /repo\n"));

		await expect(workspaceExists(exec, "sillajje-abc123")).resolves.toBe(
			false,
		);
	});

	it("returns false when jj workspace list fails", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(fail("fatal: not a jj repo"));

		await expect(workspaceExists(exec, "sillajje-abc123")).resolves.toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// workspaceForget
// ---------------------------------------------------------------------------

describe("workspaceForget", () => {
	it("calls jj workspace forget with the correct name", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok());

		await workspaceForget(exec, "sillajje-abc123");

		expect(exec).toHaveBeenCalledWith("jj", [
			"workspace",
			"forget",
			"sillajje-abc123",
		]);
	});
});

// ---------------------------------------------------------------------------
// cleanupWorkspace
// ---------------------------------------------------------------------------

describe("cleanupWorkspace", () => {
	it("forgets workspace and deletes directory", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-cleanup-"));
		const wsPath = join(tmpDir, "workspace-dir");
		mkdirSync(wsPath, { recursive: true });

		const exec = vi.fn<ExecFn>().mockResolvedValue(ok());

		await cleanupWorkspace(exec, "sillajje-abc", wsPath);

		// Should have called workspace forget
		expect(exec).toHaveBeenCalledWith("jj", [
			"workspace",
			"forget",
			"sillajje-abc",
		]);

		// Directory should be deleted
		expect(existsSync(wsPath)).toBe(false);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not throw when workspace forget fails", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "sillajje-cleanup-"));
		const wsPath = join(tmpDir, "workspace-dir");
		mkdirSync(wsPath, { recursive: true });

		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(fail("no such workspace"));

		// Should not throw despite exec failure
		await expect(
			cleanupWorkspace(exec, "sillajje-abc", wsPath),
		).resolves.toBeUndefined();

		// Directory should still be deleted
		expect(existsSync(wsPath)).toBe(false);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not throw when directory does not exist", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok());

		await expect(
			cleanupWorkspace(exec, "sillajje-abc", "/tmp/nonexistent-dir"),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getWorkspacePathByName
// ---------------------------------------------------------------------------

describe("getWorkspacePathByName", () => {
	it("returns path when workspace name is found in jj workspace list", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(
				ok("default: /repo\nsillajje-abc123: /tmp/ws/repo/abc123\n"),
			);

		const path = await getWorkspacePathByName(exec, "sillajje-abc123");
		expect(path).toBe("/tmp/ws/repo/abc123");
	});

	it("returns undefined when workspace name not in list", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok("default: /repo\n"));

		await expect(
			getWorkspacePathByName(exec, "sillajje-unknown"),
		).resolves.toBeUndefined();
	});

	it("returns undefined when jj workspace list fails", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(fail("fatal: not a jj repo"));

		await expect(
			getWorkspacePathByName(exec, "sillajje-abc123"),
		).resolves.toBeUndefined();
	});

	it("parses correct line when multiple workspaces exist", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(
				ok(
					"default: /main\nsillajje-aaa: /ws/aaa\nsillajje-bbb: /ws/bbb\n",
				),
			);

		const path = await getWorkspacePathByName(exec, "sillajje-bbb");
		expect(path).toBe("/ws/bbb");
	});
});

// ---------------------------------------------------------------------------
// bookmarkExists
// ---------------------------------------------------------------------------

describe("bookmarkExists", () => {
	it("returns true when bookmark name appears in jj bookmark list", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(ok("sillajje/abc123: xyz123\n"));

		await expect(
			bookmarkExists(exec, "sillajje/abc123", "/repo"),
		).resolves.toBe(true);
	});

	it("returns false when bookmark not in list", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok(""));

		await expect(
			bookmarkExists(exec, "sillajje/abc123", "/repo"),
		).resolves.toBe(false);
	});

	it("returns false when jj bookmark list fails", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(fail("fatal: not a jj repo"));

		await expect(
			bookmarkExists(exec, "sillajje/abc123", "/repo"),
		).resolves.toBe(false);
	});
});

// ---------------------------------------------------------------------------
// unarchiveWorkspace
// ---------------------------------------------------------------------------

describe("unarchiveWorkspace", () => {
	it("calls jj workspace add with correct --revision and path", async () => {
		const exec = vi.fn<ExecFn>().mockResolvedValue(ok());

		const info = await unarchiveWorkspace(
			exec,
			"/home/user/repo",
			"abc123",
			"/tmp/ws",
		);

		expect(info.workspaceName).toBe("sillajje-abc123");
		expect(info.workspacePath).toBe("/tmp/ws/repo/abc123");

		expect(exec).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = exec.mock.calls[0];
		expect(cmd).toBe("jj");
		expect(args[0]).toBe("workspace");
		expect(args[1]).toBe("add");
		expect(args[2]).toBe("--name");
		expect(args[3]).toBe("sillajje-abc123");
		expect(args[4]).toBe("--revision");
		expect(args[5]).toBe("sillajje/abc123");
		expect(args[6]).toBe("/tmp/ws/repo/abc123");
		expect(opts).toEqual({ cwd: "/home/user/repo" });
	});

	it("throws when jj workspace add fails", async () => {
		const exec = vi
			.fn<ExecFn>()
			.mockResolvedValue(fail("no such revision"));

		await expect(
			unarchiveWorkspace(exec, "/home/user/repo", "abc123", "/tmp/ws"),
		).rejects.toThrow("jj workspace add failed");
	});
});
