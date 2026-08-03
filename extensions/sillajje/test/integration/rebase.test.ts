import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { beforeEach, expect, it } from "vitest";
import {
	createRunner,
	describeJj,
	installDefaultSubGeneratorMock,
	makeRunnerCwd,
	tempDirs,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run jj in the given repo. Uses shell form because execSync with array args ignores the cwd option. */
function jj(args: string[], cwd: string): string {
	const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`);
	const cmd = ["jj", ...quoted].join(" ");
	return String(
		execSync(cmd, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		}),
	).trim();
}

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
	const parts = repoRoot.split("/");
	const repoSlug = parts[parts.length - 1];
	return `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function setupJjRepo(cwd: string): Promise<void> {
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
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
	await runner.emitBeforeAgentStart(prompt, undefined, "You are helpful.", {
		skills: [],
		contextFiles: [],
		prompts: [],
	});
	await runner.emit({ type: "agent_start" });
	await runner.emit({
		type: "agent_end",
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		messages: [assistantMsg(response)] as any[],
	});
	await runner.emit({ type: "agent_settled" });
}

/** Get the registered sillajje command, throwing if missing. */
function getSillajjeCommand(runner: Awaited<ReturnType<typeof createRunner>>) {
	const cmd = runner.getCommand("sillajje");
	if (!cmd) throw new Error("sillajje command not registered");
	return cmd;
}

/** Replace the runner's no-op UI mock with one that records notifications. */
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
 * Advance the main checkout: modify the working copy, describe it as an
 * upstream commit, and point the `main` bookmark at it.
 */
function createUpstream(
	cwd: string,
	file: string,
	content: string,
	message: string,
): void {
	execSync(`echo ${content} > ${file}`, { cwd });
	jj(["describe", "-m", message], cwd);
	jj(["bookmark", "set", "main", "-r", "@"], cwd);
}

/** Number of parents of the working copy in the given workspace. */
function parentCount(ws: string): number {
	return Number(
		jj(["log", "-r", "@", "--no-graph", "-T", "parents.len()"], ws),
	);
}

/** Change IDs of the working copy's parents in the given workspace. */
function parentIds(ws: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"parents(@)",
			"--no-graph",
			"-T",
			'change_id.short() ++ "\\n"',
		],
		ws,
	)
		.split(/\s+/)
		.filter(Boolean);
}

/** Change ID of a revision in the given workspace. */
function changeId(ws: string, rev: string): string {
	return jj(["log", "-r", rev, "--no-graph", "-T", "change_id.short()"], ws);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// `simulateInteraction` stamps a change — install the canned sub-generator so
// stamping never spawns a real `pi -p` subprocess.
beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje rebase", () => {
	it("rebases the current session onto <rev>, creating a merge commit", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Session work: edit a file in the session workspace, then stamp it.
		execSync("echo session-work > session.txt", { cwd: path });
		await simulateInteraction(runner, "Session change", "Done.");
		const sessionCommit = changeId(path, `sillajje/${sessionId}`);

		// Upstream: advance the main checkout.
		createUpstream(cwd, "upstream.txt", "upstream-work", "feat: upstream");
		const upstreamCommit = changeId(cwd, "main");

		// Rebase onto main.
		const cmd = getSillajjeCommand(runner);
		await cmd.handler("rebase main", runner.createCommandContext());

		// Merge commit: @ has exactly the two expected parents.
		expect(parentCount(path)).toBe(2);
		const parents = parentIds(path);
		expect(parents).toContain(upstreamCommit);
		expect(parents).toContain(sessionCommit);

		// The upstream is now in the session's ancestry.
		const ancestry = jj(
			["log", "-r", `ancestors(@)`, "-T", "change_id.short()"],
			path,
		);
		expect(ancestry).toContain(upstreamCommit);

		// Workspace is synced: update-stale succeeds and session stays active.
		expect(() => jj(["workspace", "update-stale"], path)).not.toThrow();
		expect(existsSync(path)).toBe(true);

		// Success notification.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining(
					`session ${sessionId} rebased onto main`,
				),
			}),
		);

		// Session state NOT modified — input still passes through.
		const inputResult = await runner.emitInput(
			"more work",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "continue" });
	}, 15_000);

	it("rebases a different active session via --session", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const currentPath = wsPath(cwd, sessionId);

		// Create a second sillajje session by hand: workspace + bookmark.
		const otherId = "other-session-1";
		const otherPath = `${cwd}/ws-${otherId}`;
		jj(
			[
				"workspace",
				"add",
				"--name",
				`sillajje-${otherId}`,
				"--revision",
				"@-",
				otherPath,
			],
			cwd,
		);
		execSync("echo other-work > other.txt", { cwd: otherPath });
		jj(["describe", "-m", "act: other"], otherPath);
		jj(["bookmark", "set", `sillajje/${otherId}`, "-r", "@"], otherPath);
		jj(["new"], otherPath);
		const otherCommit = changeId(otherPath, `sillajje/${otherId}`);

		// Upstream advance.
		createUpstream(cwd, "upstream.txt", "upstream-work", "feat: upstream");
		const upstreamCommit = changeId(cwd, "main");

		// Rebase the other session onto main.
		const cmd = getSillajjeCommand(runner);
		await cmd.handler(
			`rebase main --session ${otherId}`,
			runner.createCommandContext(),
		);

		// The target session got the merge commit…
		expect(parentCount(otherPath)).toBe(2);
		const parents = parentIds(otherPath);
		expect(parents).toContain(upstreamCommit);
		expect(parents).toContain(otherCommit);

		// …while the current session is untouched.
		expect(parentCount(currentPath)).toBe(1);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining(
					`session ${otherId} rebased onto main`,
				),
			}),
		);
	}, 15_000);

	it("reports an error for an invalid <rev> and leaves the session unchanged", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		execSync("echo session-work > session.txt", { cwd: path });
		await simulateInteraction(runner, "Session change", "Done.");

		const cmd = getSillajjeCommand(runner);
		await cmd.handler(
			"rebase nonexistent-rev",
			runner.createCommandContext(),
		);

		// Error notification surfaces jj's failure.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("rebase failed"),
			}),
		);

		// Session unchanged: still a single parent, no merge.
		expect(parentCount(path)).toBe(1);
	}, 15_000);

	it("reports an error when rebasing an archived session", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		// Stamp a change so the session bookmark exists, then archive.
		await simulateInteraction(runner, "Session change", "Done.");
		const cmd = getSillajjeCommand(runner);
		await cmd.handler("archive", runner.createCommandContext());

		// Rebase targets the current (archived) session.
		await cmd.handler("rebase main", runner.createCommandContext());

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("archived"),
			}),
		);
	}, 15_000);

	it("reports an error when the session has no sillajje bookmark", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		const cmd = getSillajjeCommand(runner);
		await cmd.handler(
			"rebase main --session nonexistent-session",
			runner.createCommandContext(),
		);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("not a sillajje session"),
			}),
		);
	});

	it("aborts with a conflict warning when the rebase creates file-level conflicts", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		// Base commit carries file.txt so both sides can edit it.
		execSync("echo base > file.txt", { cwd });
		jj(["describe", "-m", "base"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Session edits file.txt (adds it — the session base has no file.txt).
		execSync("echo session-edit > file.txt", { cwd: path });
		await simulateInteraction(runner, "Session change", "Done.");

		// Upstream edits the same file differently.
		createUpstream(cwd, "file.txt", "upstream-edit", "feat: upstream");

		const cmd = getSillajjeCommand(runner);
		await cmd.handler("rebase main", runner.createCommandContext());

		// Conflict warning lists the conflicting file…
		const conflictNotif = notifications.find(
			(n) => n.type === "warning" && n.msg.includes("conflict"),
		);
		expect(conflictNotif).toBeDefined();
		expect(conflictNotif?.msg).toContain("file.txt");

		// …and no success notification is emitted.
		expect(
			notifications.some(
				(n) => n.type === "info" && n.msg.includes("rebased onto"),
			),
		).toBe(false);

		// The merge commit still exists — the user resolves conflicts manually.
		expect(parentCount(path)).toBe(2);
	}, 15_000);
});
