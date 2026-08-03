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

/** Assert a value is defined and return it (avoids non-null assertions). */
function expectDefined<T>(value: T | undefined): T {
	expect(value).toBeDefined();
	return value as T;
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

/**
 * Commits directly on top of `<rev>` (repo-global): `{ parents, id, desc }`.
 * After a fold these are the preamble's merge commit (empty description,
 * two parents) and the folded commit (single parent, generated subject).
 */
function revPlusCommits(
	rev: string,
	repo: string,
): Array<{ parents: number; id: string; desc: string }> {
	const out = jj(
		[
			"log",
			"-r",
			`${rev}+`,
			"--no-graph",
			"-T",
			'parents.len() ++ "|" ++ change_id.short() ++ "|" ++ description.first_line() ++ "\\n"',
		],
		repo,
	);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [parents, id, desc] = line.split("|");
			return { parents: Number(parents), id, desc: desc ?? "" };
		});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// `simulateInteraction` stamps a change — install the canned sub-generator so
// stamping never spawns a real `pi -p` subprocess. The same mock feeds the
// fold's header generator, producing the subject "test subject".
beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje fold", () => {
	it("folds the current session into a single commit on <rev> and archives it", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);
		await setupJjRepo(cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const path = wsPath(cwd, sessionId);

		// Session work, then a stamped interaction (bookmark sillajje/<id>).
		execSync("echo session-work > session.txt", { cwd: path });
		await simulateInteraction(runner, "Session change", "Done.");

		// Upstream advance on main.
		createUpstream(cwd, "upstream.txt", "upstream-work", "feat: upstream");

		// Fold onto main.
		const cmd = getSillajjeCommand(runner);
		await cmd.handler("fold main", runner.createCommandContext());

		// Folded commit: a single-parent change on main with the mock subject.
		const commits = revPlusCommits("main", cwd);
		const folded = expectDefined(
			commits.find((c) => c.desc === "test subject"),
		);
		expect(folded.parents).toBe(1);

		// The folded tree carries BOTH the session work and the upstream
		// content brought in by the preamble rebase.
		const foldedFiles = jj(["file", "list", "-r", folded.id], cwd);
		expect(foldedFiles).toContain("session.txt");
		expect(foldedFiles).toContain("upstream.txt");

		// Session archived: workspace directory gone, input blocked.
		expect(existsSync(path)).toBe(false);
		const inputResult = await runner.emitInput(
			"more work",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "handled" });

		// The bookmark survives as sillage.
		const bookmarks = jj(["bookmark", "list"], cwd);
		expect(bookmarks).toContain(`sillajje/${sessionId}`);

		// Success notification points at <rev>+.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining(`session ${sessionId} folded`),
			}),
		);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("main+"),
			}),
		);
	}, 15_000);

	it("folds a different active session via --session", async () => {
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

		// Upstream advance.
		createUpstream(cwd, "upstream.txt", "upstream-work", "feat: upstream");

		// Fold the other session onto main.
		const cmd = getSillajjeCommand(runner);
		await cmd.handler(
			`fold main --session ${otherId}`,
			runner.createCommandContext(),
		);

		// The target session's workspace is gone and its work folded.
		expect(existsSync(otherPath)).toBe(false);
		const commits = revPlusCommits("main", cwd);
		const folded = expectDefined(
			commits.find((c) => c.desc === "test subject"),
		);
		const foldedFiles = jj(["file", "list", "-r", folded.id], cwd);
		expect(foldedFiles).toContain("other.txt");

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining(`session ${otherId} folded`),
			}),
		);

		// The current session is untouched — still active.
		expect(existsSync(currentPath)).toBe(true);
		const inputResult = await runner.emitInput(
			"still here",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "continue" });
	}, 15_000);

	it("reports an error for an invalid <rev> and leaves the session active", async () => {
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

		// Point `main` at the initial commit so the no-fold assertion below
		// has a target rev to inspect.
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		const cmd = getSillajjeCommand(runner);
		await cmd.handler(
			"fold nonexistent-rev",
			runner.createCommandContext(),
		);

		// Error notification surfaces jj's failure.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("fold failed"),
			}),
		);

		// Session not archived, nothing folded.
		expect(existsSync(path)).toBe(true);
		expect(revPlusCommits("main", cwd)).toHaveLength(0);
	}, 15_000);

	it("reports an error when folding an archived session", async () => {
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

		// Fold targets the current (archived) session.
		await cmd.handler("fold main", runner.createCommandContext());

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
			"fold main --session nonexistent-session",
			runner.createCommandContext(),
		);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("not a sillajje session"),
			}),
		);
	});

	it("aborts with a conflict warning without folding or archiving", async () => {
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

		// Session edits file.txt; upstream edits it differently.
		execSync("echo session-edit > file.txt", { cwd: path });
		await simulateInteraction(runner, "Session change", "Done.");
		createUpstream(cwd, "file.txt", "upstream-edit", "feat: upstream");

		const cmd = getSillajjeCommand(runner);
		await cmd.handler("fold main", runner.createCommandContext());

		// Conflict warning lists the conflicting file.
		const conflictNotif = notifications.find(
			(n) => n.type === "warning" && n.msg.includes("conflict"),
		);
		expect(conflictNotif).toBeDefined();
		expect(conflictNotif?.msg).toContain("file.txt");

		// No success notification; session NOT archived; nothing folded.
		expect(
			notifications.some(
				(n) => n.type === "info" && n.msg.includes("folded"),
			),
		).toBe(false);
		expect(existsSync(path)).toBe(true);
		expect(
			revPlusCommits("main", cwd).filter(
				(c) => c.desc === "test subject",
			),
		).toHaveLength(0);
	}, 15_000);
});
