/**
 * Tests for `/sillajje:new` — starting a session whose workspace branches
 * from a chosen base instead of `trunk()`.
 *
 * The command and the session it creates share no memory: the command records
 * the base in the new session's log (during `ctx.newSession`'s `setup`), and
 * `session_start` reads it back. The tests cover both halves and the errors.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { setTestPorts } from "../../src/index.js";
import { lastSessionBase, SESSION_BASE_TYPE } from "../../src/session-base.js";
import {
	createRunner,
	describeJj,
	failingJjExec,
	getSessionId,
	getSessionManager,
	initRepo,
	jj,
	runSillajje,
	sessionBookmark,
	wsPath,
} from "./_helpers.js";

/**
 * Bind a `ctx.newSession` that runs `setup` against the runner's own session
 * manager, so a test can inspect the entry the command wrote. Returns whether
 * `newSession` was called and which base it requested.
 */
function bindCapturingNewSession(
	runner: Awaited<ReturnType<typeof createRunner>>,
) {
	let called = false;
	runner.bindCommandContext({
		waitForIdle: async () => {},
		newSession: async (options) => {
			called = true;
			if (options?.setup) {
				await options.setup(getSessionManager(runner));
			}
			return { cancelled: false };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	});
	return { wasCalled: () => called };
}

describeJj("sillajje new session", () => {
	it("branches a new workspace from a base recorded in the session log", async () => {
		const repo = initRepo();
		writeFileSync(join(repo, "base.txt"), "base\n");
		jj(["describe", "-m", "base work"], repo);
		const baseId = jj(
			["log", "-r", "@", "--no-graph", "-T", "commit_id"],
			repo,
		);
		jj(["new"], repo);

		const runner = await createRunner(repo);
		// Write the Base marker before session_start, as `setup` would.
		getSessionManager(runner).appendCustomEntry(SESSION_BASE_TYPE, {
			base: baseId,
			label: "base",
		});
		await runner.emit({ type: "session_start", reason: "new" });

		const sessionId = getSessionId(runner);
		const workspace = wsPath(repo, sessionId);
		// The workspace working copy is a fresh child of the base, so the base's
		// tree — including base.txt — is present.
		expect(existsSync(join(workspace, "base.txt"))).toBe(true);
	});

	it("defaults to trunk() when the session has no Base marker", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		expect(
			lastSessionBase(getSessionManager(runner).getBranch()),
		).toBeUndefined();
	});

	it("records the source session bookmark for -s", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sourceId = getSessionId(runner);
		jj(["bookmark", "create", sessionBookmark(sourceId), "-r", "@"], repo);

		const capture = bindCapturingNewSession(runner);
		await runSillajje(runner, `new -s ${sourceId}`);

		expect(capture.wasCalled()).toBe(true);
		expect(lastSessionBase(getSessionManager(runner).getBranch())).toEqual({
			base: sessionBookmark(sourceId),
			label: sourceId,
		});
	});

	it("resolves -o to an immutable commit id", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const capture = bindCapturingNewSession(runner);
		await runSillajje(runner, "new -o @");

		const workspace = wsPath(repo, getSessionId(runner));
		const expected = jj(
			["log", "-r", "@", "--no-graph", "-T", "commit_id"],
			workspace,
		);
		expect(capture.wasCalled()).toBe(true);
		expect(lastSessionBase(getSessionManager(runner).getBranch())).toEqual({
			base: expected,
			label: "@",
		});
	});

	it("a bare invocation continues from this session's last seal", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		jj(["bookmark", "create", sessionBookmark(sessionId), "-r", "@"], repo);

		const capture = bindCapturingNewSession(runner);
		await runSillajje(runner, "new");

		expect(capture.wasCalled()).toBe(true);
		expect(lastSessionBase(getSessionManager(runner).getBranch())).toEqual({
			base: sessionBookmark(sessionId),
			label: "@",
		});
	});

	it("reports a jj failure while resolving -s instead of throwing", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		jj(["bookmark", "create", sessionBookmark(sessionId), "-r", "@"], repo);

		const notifications: Array<{ msg: string; type: string }> = [];
		runner.setUIContext(
			{
				setStatus: () => {},
				notify: (msg: string, type: string) =>
					notifications.push({ msg, type }),
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		const capture = bindCapturingNewSession(runner);
		setTestPorts({ exec: failingJjExec((args) => args[0] === "bookmark") });
		try {
			await runSillajje(runner, `new -s ${sessionId}`);
		} finally {
			setTestPorts({ exec: undefined });
		}

		expect(capture.wasCalled()).toBe(false);
		expect(
			notifications.some(
				(n) =>
					n.type === "error" &&
					n.msg.includes("cannot resolve session"),
			),
		).toBe(true);
	});

	it("rejects @ with no live session", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		// No session_start: sillajje is inactive and has no workspace.

		const notifications: Array<{ msg: string; type: string }> = [];
		runner.setUIContext(
			{
				setStatus: () => {},
				notify: (msg: string, type: string) =>
					notifications.push({ msg, type }),
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		const capture = bindCapturingNewSession(runner);
		await runSillajje(runner, "new -o @");

		expect(capture.wasCalled()).toBe(false);
		expect(
			notifications.some(
				(n) =>
					n.type === "error" && n.msg.includes("no sillajje session"),
			),
		).toBe(true);
	});

	it("rejects a session with no bookmark", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const notifications: Array<{ msg: string; type: string }> = [];
		runner.setUIContext(
			{
				setStatus: () => {},
				notify: (msg: string, type: string) =>
					notifications.push({ msg, type }),
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		const capture = bindCapturingNewSession(runner);
		await runSillajje(runner, "new -s ghost");

		expect(capture.wasCalled()).toBe(false);
		expect(
			notifications.some(
				(n) =>
					n.type === "error" &&
					n.msg.includes("not a sillajje session"),
			),
		).toBe(true);
	});
});
