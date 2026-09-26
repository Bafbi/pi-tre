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
import type { ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
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

/** The SDK's options bag for `ctx.newSession`. */
type NewSessionOptions = NonNullable<
	Parameters<ExtensionCommandContextActions["newSession"]>[0]
>;

/**
 * The fresh context the host passes to `withSession` after it replaces the
 * session. Derived in two steps so it tracks the SDK.
 */
type ReplacementCtx = Parameters<
	NonNullable<NewSessionOptions["withSession"]>
>[0];

/** The notification kinds the UI context accepts. */
type NotifyType = "info" | "warning" | "error";

/**
 * Bind a `ctx.newSession` against the runner's own session manager. `setup`
 * always runs, so a test can inspect the entry the command wrote. When
 * `onReplacementNotify` is given, the stub also reproduces the real
 * replacement: it invalidates the old runner, then runs `withSession` against
 * a mock replacement context. Touching the captured old `ctx` afterwards
 * throws.
 */
function bindNewSessionStub(
	runner: Awaited<ReturnType<typeof createRunner>>,
	onReplacementNotify?: (msg: string, type: NotifyType) => void,
) {
	let called = false;
	let withSessionCalled = false;
	runner.bindCommandContext({
		waitForIdle: async () => {},
		newSession: async (options) => {
			called = true;
			if (options?.setup) {
				await options.setup(getSessionManager(runner));
			}
			if (onReplacementNotify && options?.withSession) {
				// The host disposes the old session before the replacement runs.
				runner.invalidate();
				withSessionCalled = true;
				const replacement = {
					hasUI: true,
					ui: { notify: onReplacementNotify },
				} as unknown as ReplacementCtx;
				await options.withSession(replacement);
			}
			return { cancelled: false };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	});
	return {
		wasCalled: () => called,
		wasWithSessionCalled: () => withSessionCalled,
	};
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

		const capture = bindNewSessionStub(runner);
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

		const capture = bindNewSessionStub(runner);
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

		const capture = bindNewSessionStub(runner);
		await runSillajje(runner, "new");

		expect(capture.wasCalled()).toBe(true);
		expect(lastSessionBase(getSessionManager(runner).getBranch())).toEqual({
			base: sessionBookmark(sessionId),
			label: "@",
		});
	});

	it("does not touch the stale command ctx after newSession replaces the session", async () => {
		const repo = initRepo();
		const runner = await createRunner(repo);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		jj(["bookmark", "create", sessionBookmark(sessionId), "-r", "@"], repo);

		const replacement: Array<{ msg: string; type: string }> = [];
		const capture = bindNewSessionStub(runner, (msg, type) =>
			replacement.push({ msg, type }),
		);

		// The handler would reject with a stale-ctx error if it read the
		// captured `ctx` after `newSession`.
		await expect(runSillajje(runner, "new")).resolves.toBeUndefined();

		expect(capture.wasWithSessionCalled()).toBe(true);
		expect(
			replacement.some(
				(n) =>
					n.type === "info" &&
					n.msg.includes("starting a new session"),
			),
		).toBe(true);
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

		const capture = bindNewSessionStub(runner);
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

		const capture = bindNewSessionStub(runner);
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

		const capture = bindNewSessionStub(runner);
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

	it("a bare new outside a session prints help", async () => {
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
		await runSillajje(runner, "new");

		expect(capture.wasCalled()).toBe(false);
		expect(
			notifications.some(
				(n) =>
					n.type === "info" && n.msg.includes("usage: /sillajje:new"),
			),
		).toBe(true);
	});
});
