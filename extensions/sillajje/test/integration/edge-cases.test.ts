import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

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

async function setupJjRepo(cwd: string): Promise<void> {
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
}

/** Override the runner UI with one that records notifications. */
function spyNotifications(
	runner: Awaited<ReturnType<typeof createRunner>>,
): string[] {
	const notifications: string[] = [];
	runner.setUIContext(
		{
			setStatus: () => {},
			notify: (msg: string) => notifications.push(msg),
			setEditorText: () => {},
			getEditorText: () => "",
		} as never,
		"tui",
	);
	return notifications;
}

// ---------------------------------------------------------------------------
// Edge cases: stale sessions
// ---------------------------------------------------------------------------

describeJj("sillajje stale session handling", () => {
	it("marks the session stale and blocks tools when the workspace is deleted externally", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		const notifications = spyNotifications(runner);

		// Delete the workspace directory externally (e.g. another process).
		rmSync(path, { recursive: true, force: true });

		// A tool call is blocked — nothing may write to the real repo.
		const toolEvent = {
			type: "tool_call" as const,
			toolCallId: "tc-1",
			toolName: "write" as const,
			input: { path: "new-file.ts", content: "x" },
		};
		const toolResult = await runner.emitToolCall(toolEvent);
		expect(toolResult).toEqual(expect.objectContaining({ block: true }));
		expect(
			notifications.some((n) =>
				n.includes("workspace directory no longer exists"),
			),
		).toBe(true);

		// before_agent_start no-ops — no dead path is injected.
		const beforeAgent = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		expect(beforeAgent).toBeUndefined();

		// agent_end does not stamp — no bookmark is created.
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Done.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		const bookmarks = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(bookmarks).not.toContain(`sillajje/${sessionId}`);
	}, 15_000);

	it("marks the session stale and skips stamping when jj disappears from PATH", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		const notifications = spyNotifications(runner);

		// Simulate jj disappearing mid-session: prepend a failing fake `jj`.
		const fakeBin = mkdtempSync(join(tmpdir(), "sillajje-fakebin-"));
		tempDirs.push(fakeBin);
		writeFileSync(join(fakeBin, "jj"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		const originalPath = process.env.PATH;
		process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
		try {
			await runner.emitInput("Do something", undefined, "interactive");
			await runner.emitBeforeAgentStart(
				"Do something",
				undefined,
				"You are helpful.",
				{ skills: [], contextFiles: [], prompts: [] },
			);
			await runner.emit({ type: "agent_start" });
			await runner.emit({
				type: "agent_end",
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				messages: [assistantMsg("Done.")] as any[],
			});
			await runner.emit({ type: "agent_settled" });

			expect(
				notifications.some((n) =>
					n.includes("jj is no longer on PATH"),
				),
			).toBe(true);
		} finally {
			process.env.PATH = originalPath;
		}

		// No change was stamped — the bookmark must not exist (assert after
		// PATH is restored so the real jj is used).
		const bookmarks = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(bookmarks).not.toContain(`sillajje/${sessionId}`);
	}, 15_000);
});
