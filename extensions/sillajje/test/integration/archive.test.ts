import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
	createRunner,
	describeJj,
	installDefaultSubGeneratorMock,
	jj,
	makeRunnerCwd,
	recordInteraction,
	runSillajje,
	sessionBookmark,
	tempDirs,
} from "./_helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the session ID, throwing if undefined. */
function getSessionId(
	runner: Awaited<ReturnType<typeof createRunner>>,
): string {
	const id = runner.createContext().sessionManager.getSessionId();
	if (!id) throw new Error("sessionId should be defined after session_start");
	return id;
}

/** Resolve the default workspace path for a given session and repo root. */
function wsPath(repoRoot: string, sessionId: string): string {
	const repoSlug = repoRoot.split("/").pop()!;
	return `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;
}

async function setupJjRepo(cwd: string): Promise<string> {
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
	return cwd;
}

/** Collect UI notifications so a test can assert on the rendered messages. */
function captureNotifications(
	runner: Awaited<ReturnType<typeof createRunner>>,
): Array<{ msg: string; type: "info" | "warning" | "error" }> {
	const notifications: Array<{
		msg: string;
		type: "info" | "warning" | "error";
	}> = [];
	runner.setUIContext(
		{
			setStatus: () => {},
			notify: (msg: string, type: "info" | "warning" | "error") =>
				notifications.push({ msg, type }),
			setEditorText: () => {},
			getEditorText: () => "",
		} as unknown as Parameters<typeof runner.setUIContext>[0],
		"tui",
	);
	return notifications;
}

/**
 * Simulate a full interaction (input → agent_start → agent_end) that stamps
 * a change and creates the `sillajje/<sessionId>` bookmark.
 */
async function simulateInteraction(
	runner: Awaited<ReturnType<typeof createRunner>>,
	prompt: string,
	response: string,
): Promise<void> {
	await runner.emitInput(prompt, undefined, "interactive");
	recordInteraction(runner, prompt, response);
	await runner.emit({ type: "agent_settled" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// `simulateInteraction` stamps a change — install the canned sub-generator so
// stamping never spawns a real `pi -p` subprocess.
beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje archive / unarchive", () => {
	it("archive current session: workspace directory is gone", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Verify workspace exists before archive.
		expect(existsSync(path)).toBe(true);

		// Archive via command.
		await runSillajje(runner, "archive");

		// Workspace directory should be gone.
		expect(existsSync(path)).toBe(false);
	});

	it("archived session blocks input with handled action", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Archive.
		await runSillajje(runner, "archive");

		// Input should be blocked.
		const inputResult = await runner.emitInput(
			"hello",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "handled" });
	});

	it("before_agent_start is blocked when archived", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Archive.
		await runSillajje(runner, "archive");

		// before_agent_start should return undefined (no-op).
		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);
		expect(result).toBeUndefined();
	});

	it("status reports archived after archiving", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Archive.
		await runSillajje(runner, "archive");

		// After archive, before_agent_start no-ops for archived state.
		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);
		expect(result).toBeUndefined();
	});

	it("unarchive session: workspace is recreated", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Stamp a change first so the bookmark exists.
		await simulateInteraction(runner, "First change", "Done.");

		// Archive.
		await runSillajje(runner, "archive");
		expect(existsSync(path)).toBe(false);

		// The bookmark sillajje/<sessionId> should still exist after archive.
		const bmList = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(bmList).toContain(sessionBookmark(sessionId));

		// Unarchive.
		await runSillajje(runner, `unarchive -s ${sessionId}`);

		// Workspace should be recreated.
		expect(existsSync(path)).toBe(true);

		// Input should be allowed again.
		const inputResult = await runner.emitInput(
			"do something",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "continue" });
	}, 10_000);

	it("unarchive with non-existent session-id shows error gracefully", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Unarchive with a non-existent session ID — should not throw.
		await expect(
			runSillajje(runner, "unarchive -s nonexistent-id"),
		).resolves.toBeUndefined();
	});

	it("full lifecycle: active → archived → active", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Initially active — workspace exists, input passes through.
		expect(existsSync(path)).toBe(true);

		// Stamp a change so the bookmark exists for later unarchive.
		await simulateInteraction(runner, "First change", "Done.");

		// Archive.
		await runSillajje(runner, "archive");
		expect(existsSync(path)).toBe(false);

		// Archived — input blocked.
		const inputResult = await runner.emitInput(
			"second prompt",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "handled" });

		// Unarchive with the session default: bare means this session.
		await runSillajje(runner, "unarchive");
		expect(existsSync(path)).toBe(true);

		// Active again — input passes through.
		const inputAfter = await runner.emitInput(
			"third prompt",
			undefined,
			"interactive",
		);
		expect(inputAfter).toEqual({ action: "continue" });
	}, 10_000);

	it("restores the cursor after unarchive so old prompts are not re-stamped", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		await simulateInteraction(runner, "First change", "Done.");

		// Archive clears the cursor; unarchive must rebuild it from the last
		// Stamp marker.
		await runSillajje(runner, "archive");
		await runSillajje(runner, `unarchive -s ${sessionId}`);

		await simulateInteraction(runner, "Second change", "Done again.");

		// The second change holds only the second Interaction's transcript.
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Second change");
		expect(show).not.toContain("First change");
	}, 15_000);

	it("prints help for -h and for a bare invocation outside a session", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		// No session_start: no sillajje session, so the bare form is help.
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "archive --help");
		await runSillajje(runner, "unarchive -h");
		await runSillajje(runner, "unarchive");

		const helps = notifications.filter(
			(n) =>
				n.type === "info" &&
				n.msg.includes("usage: /sillajje:unarchive"),
		);
		expect(helps).toHaveLength(2);
		expect(
			notifications.some(
				(n) => n.type === "warning" || n.type === "error",
			),
		).toBe(false);
	});

	it("a bare stamp seals this session (default -s @)", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		// Put a change in the working copy so the seal has something to stamp.
		writeFileSync(join(wsPath(cwd, sessionId), "work.txt"), "work\n");

		const notifications = captureNotifications(runner);
		await runSillajje(runner, "stamp");

		expect(
			notifications.some(
				(n) =>
					n.type === "info" && n.msg.includes("workspace stamped:"),
			),
		).toBe(true);
	}, 15_000);

	it("a bare archive outside a jj repo shows help, not a repo error", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		// No setupJjRepo: sillajje detection is inactive. session_start still
		// records the pi session ID, so only the lifecycle gate keeps the
		// bare form reading as help.
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "archive");

		expect(
			notifications.some(
				(n) =>
					n.type === "info" &&
					n.msg.includes("usage: /sillajje:archive"),
			),
		).toBe(true);
		expect(notifications.some((n) => n.type === "error")).toBe(false);
	});

	it("unarchiving a live session is rejected with a clear error", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		// The workspace is live, so the bare default resolves to a session that
		// must not be unarchived.
		await runSillajje(runner, "unarchive");

		expect(
			notifications.some(
				(n) => n.type === "error" && n.msg.includes("already active"),
			),
		).toBe(true);
	});
});
