/**
 * Integration tests for the transactional seal (deferred integration)
 * against real jj, driven through the registered command.
 *
 * A single command is forced to fail per test via the exec wrapper seam;
 * every other step runs against real jj, and the post-failure repository
 * state (jj log, jj op log, bookmarks, working copy) is asserted to be
 * exactly the pre-stamp state.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setTestExecWrapper } from "../../src/index.js";
import type { ExecFn } from "../../src/workspace.js";
import {
	createRunner,
	describeJj,
	getSessionId,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	runSillajje,
	wsPath,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An ExecFn that runs every command against real jj (synchronously) except
 * the ones matching `failMatch`, which exit 1 with the given stderr.
 * Records every jj invocation in `calls`.
 */
function failingJjExec(
	failMatch: (args: string[]) => boolean,
	calls?: Array<{ args: string[]; stderr: string }>,
): ExecFn {
	return (cmd, args, opts) => {
		if (cmd === "jj") calls?.push({ args, stderr: "" });
		if (cmd === "jj" && failMatch(args)) {
			if (calls) calls[calls.length - 1].stderr = "injected failure\n";
			return Promise.resolve({
				code: 1,
				stdout: "",
				stderr: "injected failure\n",
			});
		}
		const r = spawnSync(cmd, args, {
			cwd: opts?.cwd,
			encoding: "utf-8",
		});
		if (calls) calls[calls.length - 1].stderr = r.stderr ?? "";
		return Promise.resolve({
			code: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		});
	};
}

/** The repository state a failed seal must not disturb. */
function repoState(workspace: string): string {
	return [
		jj(["log", "--no-graph", "-T", 'change_id ++ "\\n"'], workspace),
		jj(["bookmark", "list"], workspace),
		jj(["op", "log", "--no-graph", "-T", 'id ++ "\\n"'], workspace),
		jj(["log", "-r", "@", "--no-graph", "-T", "description"], workspace),
	].join("\n---\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeJj("sillajje transactional seal", () => {
	it.each([
		["describe", (args: string[]) => args[0] === "describe"],
		["bookmark set", (args: string[]) => args[0] === "bookmark"],
		[
			"jj new",
			(args: string[]) =>
				args[0] === "new" && args.includes("--no-integrate-operation"),
		],
	])(
		"a forced failure at %s leaves the repository exactly as it was",
		async (_label, failMatch) => {
			const cwd = initRepo();

			const runner = await createRunner(cwd);
			await runner.emit({ type: "session_start", reason: "startup" });
			const sessionId = getSessionId(runner);
			const workspace = wsPath(cwd, sessionId);

			// Work happens in the workspace; snapshot it before capturing the
			// baseline (the stamp's own diff fetch may snapshot, and prep is
			// permitted to persist across a failed stamp).
			writeFileSync(join(workspace, "wip.ts"), "// wip\n");
			jj(["st"], workspace);

			const before = repoState(workspace);

			installDefaultSubGeneratorMock();
			setTestExecWrapper(failingJjExec(failMatch));
			try {
				await runSillajje(runner, "stamp -s @");
			} finally {
				setTestExecWrapper(undefined);
			}

			// Nothing happened: no described change, no moved bookmark, no
			// new change, no visible operation.
			expect(repoState(workspace)).toBe(before);
		},
		20_000,
	);

	it("a failed abandon of the dangling chain warns but still reports failure", async () => {
		const cwd = initRepo();

		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "wip.ts"), "// wip\n");
		jj(["st"], workspace);
		const before = repoState(workspace);

		installDefaultSubGeneratorMock();
		setTestExecWrapper(
			failingJjExec(
				(args) =>
					args[0] === "bookmark" ||
					(args[0] === "op" && args[1] === "abandon"),
			),
		);
		try {
			await runSillajje(runner, "stamp -s @");
		} finally {
			setTestExecWrapper(undefined);
		}

		// The repository is unchanged.
		expect(repoState(workspace)).toBe(before);
		// The failed abandon surfaced as a warning, not a second error.
		expect(
			notifications.some(
				(n) => n[1] === "warning" && n[0].includes("abandon"),
			),
		).toBe(true);
	}, 20_000);

	it("an integrate failure reports the operation id and leaves the chain for manual recovery", async () => {
		const cwd = initRepo();

		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "wip.ts"), "// wip\n");
		jj(["st"], workspace);
		const before = repoState(workspace);

		installDefaultSubGeneratorMock();
		const calls: string[][] = [];
		setTestExecWrapper(
			failingJjExec(
				(args) => args[0] === "op" && args[1] === "integrate",
				calls,
			),
		);
		try {
			await runSillajje(runner, "stamp -s @");
		} finally {
			setTestExecWrapper(undefined);
		}

		// Nothing is visible — unintegrated operations stay invisible.
		expect(repoState(workspace)).toBe(before);

		// The error names the manual recovery: jj op integrate <id>.
		const error = notifications.find((n) => n[1] === "error");
		expect(error).toBeDefined();
		expect(error?.[0]).toContain("jj op integrate");
		const reportedId = error?.[0].match(
			/jj op integrate ([0-9a-f]{12,})/,
		)?.[1];
		expect(reportedId).toBeDefined();

		// The reported id is the id jj printed for the jj-new step — the
		// pin that makes `jj op integrate <id>` the real recovery command —
		// and no abandon ran: the dangling chain IS the recovery path.
		const printedNewId = calls
			.find(
				(c) =>
					c.args[0] === "new" &&
					c.args.includes("--no-integrate-operation"),
			)
			?.stderr.match(/was requested: ([0-9a-f]+)/)?.[1];
		expect(printedNewId).toBeDefined();
		expect(reportedId).toBe(printedNewId);
		expect(
			calls.some((c) => c.args[0] === "op" && c.args[1] === "abandon"),
		).toBe(false);
	}, 20_000);

	it("a foreign operation landing mid-transaction integrates cleanly with the seal", async () => {
		const cwd = initRepo();

		// A second jj workspace standing in for another concurrent session.
		const foreignPath = join(cwd, "ws-foreign");
		execFileSync(
			"jj",
			[
				"workspace",
				"add",
				"--name",
				"foreign",
				"--revision",
				"@-",
				foreignPath,
			],
			{ cwd, stdio: "pipe" },
		);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "wip.ts"), "// wip\n");
		jj(["st"], workspace);

		// The wrapper lands a foreign operation exactly when the stamp is
		// about to integrate — the worst interleaving the transaction faces.
		installDefaultSubGeneratorMock();
		setTestExecWrapper((cmd, args, opts) => {
			if (cmd === "jj" && args[0] === "op" && args[1] === "integrate") {
				writeFileSync(join(foreignPath, "foreign.txt"), "// foreign\n");
				spawnSync("jj", ["new", "-m", "foreign work"], {
					cwd: foreignPath,
					stdio: "pipe",
					encoding: "utf-8",
				});
			}
			const r = spawnSync(cmd, args, {
				cwd: opts?.cwd,
				encoding: "utf-8",
			});
			return Promise.resolve({
				code: r.status ?? 1,
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
			});
		});
		try {
			await runSillajje(runner, "stamp -s @");
		} finally {
			setTestExecWrapper(undefined);
		}

		// The seal landed: the stamped change carries the generated body and
		// the session bookmark moved to it.
		const stamped = jj(
			[
				"log",
				"-r",
				`sillajje/${sessionId}`,
				"--no-graph",
				"-T",
				"description.first_line()",
			],
			workspace,
		);
		expect(stamped).toBe("test subject");

		// The foreign operation survived the integrate — immunity holds.
		const all = jj(
			["log", "-r", "all()", "--no-graph", "-T", "description"],
			workspace,
		);
		expect(all).toContain("foreign work");

		// No divergence: the foreign op added a change, it did not rewrite
		// the stamped one.
		expect(jj(["log", "-r", "divergent()"], workspace)).toBe("");
	}, 20_000);
});
