/**
 * Real-jj test harness shared by the integration-style package tests.
 *
 * `useRealJj` points jj at a signing-free temp config; every helper then runs
 * the installed jj through `realExec`, so command tests exercise the real
 * process rather than a fake.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "../src/index.js";

/** Start a jj environment with no signing; call from `beforeAll`. */
export function useRealJj(): void {
	const configPath = join(
		mkdtempSync(join(tmpdir(), "jj-facade-")),
		"config.toml",
	);
	writeFileSync(
		configPath,
		[
			"[user]",
			'name = "Facade Test"',
			'email = "facade@example.com"',
			"[signing]",
			'backend = "none"',
			"",
		].join("\n"),
	);
	process.env.JJ_CONFIG = configPath;
}

/** Remove the temp jj config; call from `afterAll`. */
export function stopRealJj(): void {
	delete process.env.JJ_CONFIG;
}

/** An `ExecFn` that runs the real jj process synchronously. */
export const realExec: ExecFn = async (command, args, options) => {
	const result = spawnSync(command, args, {
		cwd: options?.cwd,
		encoding: "utf-8",
	});
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		killed: false,
	};
};

/** Run jj in `cwd` and return trimmed stdout. */
export function jj(cwd: string, args: string[]): string {
	return String(
		execFileSync("jj", args, { cwd, encoding: "utf-8", stdio: "pipe" }),
	).trim();
}

/** Create a fresh jj repo with a root change and one working-copy change. */
export function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "jj-facade-repo-"));
	execFileSync("jj", ["git", "init", "--quiet"], { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "a.txt"), "hello\n");
	execFileSync("jj", ["describe", "-m", "root"], { cwd: dir, stdio: "pipe" });
	execFileSync("jj", ["new", "-m", "work"], { cwd: dir, stdio: "pipe" });
	return dir;
}
