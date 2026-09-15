import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ reject: false }));

/**
 * Reproduce the Windows rename semantics — a rename onto an existing directory
 * rejects — so the heal-and-retry path is reachable on any host. On Linux a
 * rename onto an empty directory already succeeds, which is why the re-probe
 * after the retry is otherwise dead code here.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (from: string, to: string) => {
			if (renameControl.reject) {
				const error = new Error(
					"EEXIST: file already exists, rename",
				) as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			}
			return actual.rename(from, to);
		},
	};
});

import { ensureRepoCloned } from "../../src/clone.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
	renameControl.reject = false;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const repo = {
	raw: "owner/repo",
	host: "github",
	cloneUrl: "https://github.com/owner/repo.git",
	branch: null,
	displayName: "owner/repo",
	dirName: "repo",
} as ParsedRepo;

const OK_REPLY = { stdout: "", stderr: "", code: 0, killed: false };

// The heal-retry is a Windows concern, but the `rename` mock above reproduces
// the Windows semantics, so the test runs on any host.
describe("publish heal-retry re-probe", () => {
	it("reuses a clone published while the empty target was healed", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-heal-race-"));
		tempDirs.push(tempspace);
		const cloneTarget = join(tempspace, "repo");
		mkdirSync(cloneTarget, { recursive: true });

		renameControl.reject = true;
		let headCalls = 0;
		const pi = {
			exec: async (_cmd: string, args: string[]) => {
				if (args.includes("rev-parse")) {
					headCalls++;
					if (headCalls >= 3) {
						// Another caller published a valid clone during the
						// heal window, after the retry rename failed.
						mkdirSync(join(cloneTarget, ".git"), {
							recursive: true,
						});
						return { ...OK_REPLY, stdout: "abc123\n" };
					}
					return {
						...OK_REPLY,
						stderr: "fatal: not a git repository",
						code: 128,
					};
				}
				if (args[0] === "clone") {
					const dest = args[args.length - 1];
					mkdirSync(join(dest, ".git"), { recursive: true });
					return OK_REPLY;
				}
				return OK_REPLY;
			},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

		const result = await ensureRepoCloned(repo, tempspace, undefined, pi);

		// Without the re-probe this would be an invalidTarget failure.
		expect(result.status).toBe("reused");
		expect(existsSync(join(cloneTarget, ".git"))).toBe(true);
	});
});
