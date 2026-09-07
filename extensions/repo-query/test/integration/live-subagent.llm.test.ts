import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ensureRepoCloned } from "../../src/clone.js";
import { runExplorer } from "../../src/explorer.js";
import type { ParsedRepo } from "../../src/types.js";
import { testExec } from "../helpers/create-runner.js";

let gitAvailable = false;
try {
	execSync("git --version", { stdio: "ignore" });
	gitAvailable = true;
} catch {
	/* git not available */
}

// Mise provides PI_TEST_MODEL for the default LLM test. Direct Vitest runs
// skip this test when no model is configured. Provider failures skip instead
// of failing the suite.
const model = process.env.PI_TEST_MODEL;
const liveTestsEnabled = Boolean(model);

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe.skipIf(!gitAvailable || !liveTestsEnabled)("live subagent", () => {
	it("explores a local repo and reports subagent usage", async (ctx) => {
		const workspace = mkdtempSync(join(tmpdir(), "repo-query-live-"));
		tempDirs.push(workspace);

		// A tiny local git repo — the clone runs offline and fast.
		const repoDir = join(workspace, "src-repo");
		mkdirSync(repoDir, { recursive: true });
		writeFileSync(
			join(repoDir, "README.md"),
			"# Live test repo\n\nExercises the repo-query subagent end to end.\n",
			"utf8",
		);
		writeFileSync(
			join(repoDir, "greeting.ts"),
			'export function greet(name: string): string {\n\treturn "hello " + name;\n}\n',
			"utf8",
		);
		execSync("git init", { cwd: repoDir, stdio: "ignore" });
		execSync("git add .", { cwd: repoDir, stdio: "ignore" });
		execSync("git -c user.email=t@t -c user.name=t commit -m init", {
			cwd: repoDir,
			stdio: "ignore",
		});

		const repo: ParsedRepo = {
			raw: repoDir,
			host: "generic",
			cloneUrl: repoDir,
			branch: null,
			displayName: "src-repo",
			dirName: "live-repo",
		};
		const clone = await ensureRepoCloned(repo, workspace, undefined, {
			exec: testExec,
		} as unknown as ExtensionAPI);
		expect(clone.status).toBe("cloned");
		expect(existsSync(join(workspace, repo.dirName, "greeting.ts"))).toBe(
			true,
		);

		const exploration = await runExplorer({
			workspace,
			repos: [repo],
			query: "What files does this repository contain, and what does the code in them do? Answer briefly.",
			model,
			signal: undefined,
		});

		// Provider failures (bad model id, auth, quota, outage, LLM error
		// mid-run) are environmental — skip, do not fail red. Anything else
		// — spawn errors, timeouts — is our code breaking and must fail
		// loudly.
		if (exploration.error) {
			const providerFailure =
				exploration.error.startsWith("Subagent LLM error:") ||
				/^Exploration failed \(exit \d+\)/.test(exploration.error);
			if (providerFailure) {
				ctx.skip(`LLM provider failed: ${exploration.error}`);
			}
			expect.fail(`Non-provider exploration error: ${exploration.error}`);
		}

		expect(exploration.answer.trim().length).toBeGreaterThan(0);

		// Issue 07 acceptance: nested LLM usage is reported.
		expect(exploration.usage).toBeDefined();
		expect(exploration.usage?.turns).toBeGreaterThan(0);
		expect(exploration.usage?.input).toBeGreaterThan(0);
		expect(exploration.usage?.totalTokens).toBeGreaterThan(0);
	}, 330_000);
});
