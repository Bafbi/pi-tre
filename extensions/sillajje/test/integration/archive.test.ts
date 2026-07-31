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

async function setupJjRepo(cwd: string): Promise<string> {
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
	return cwd;
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
		const cmd = runner.getCommand("sillajje");
		expect(cmd).toBeDefined();
		await cmd!.handler("archive", runner.createCommandContext());

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
		await runner
			.getCommand("sillajje")!
			.handler("archive", runner.createCommandContext());

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
		await runner
			.getCommand("sillajje")!
			.handler("archive", runner.createCommandContext());

		// before_agent_start should return undefined (no-op).
		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
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
		await runner
			.getCommand("sillajje")!
			.handler("archive", runner.createCommandContext());

		// After archive, before_agent_start no-ops for archived state.
		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
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
		const cmd = runner.getCommand("sillajje")!;
		await cmd.handler("archive", runner.createCommandContext());
		expect(existsSync(path)).toBe(false);

		// The bookmark sillajje/<sessionId> should still exist after archive.
		const bmList = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(bmList).toContain(`sillajje/${sessionId}`);

		// Unarchive.
		await cmd.handler(
			`unarchive ${sessionId}`,
			runner.createCommandContext(),
		);

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

		const cmd = runner.getCommand("sillajje")!;
		// Unarchive with a non-existent session ID — should not throw.
		await expect(
			cmd.handler(
				"unarchive nonexistent-id",
				runner.createCommandContext(),
			),
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
		const cmd = runner.getCommand("sillajje")!;
		await cmd.handler("archive", runner.createCommandContext());
		expect(existsSync(path)).toBe(false);

		// Archived — input blocked.
		const inputResult = await runner.emitInput(
			"second prompt",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "handled" });

		// Unarchive.
		await cmd.handler(
			`unarchive ${sessionId}`,
			runner.createCommandContext(),
		);
		expect(existsSync(path)).toBe(true);

		// Active again — input passes through.
		const inputAfter = await runner.emitInput(
			"third prompt",
			undefined,
			"interactive",
		);
		expect(inputAfter).toEqual({ action: "continue" });
	}, 10_000);
});
