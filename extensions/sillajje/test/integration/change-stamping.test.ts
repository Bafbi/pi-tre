import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run jj in the given repo. Uses shell form because execSync with array args ignores the cwd option. */
function jj(args: string[], cwd: string): string {
	// Build a shell-safe command string. Wrap args in single quotes, escaping internal quotes.
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

/** Get the session ID, throwing if undefined (it should always be set after session_start). */
function getSessionId(
	runner: Awaited<ReturnType<typeof createRunner>>,
): string {
	const id = runner.createContext().sessionManager.getSessionId();
	if (!id) throw new Error("sessionId should be defined after session_start");
	return id;
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

describeJj("sillajje change stamping", () => {
	it("stamps a jj change on agent_settled after a new interaction", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial commit'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'start work'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);

		// Simulate tool calls.
		await runner.emitInput("Add a login page", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Add a login page",
			undefined,
			"You are a helpful assistant.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "login.ts", content: "export default {}" },
		});
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "bash",
			input: { command: "echo done" },
		});
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("I created the login page.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// The bookmark is set on the stamped commit in the repo.
		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).toContain("Add a login page");
		expect(show).toContain("Meta: write, bash | 2 calls");
		expect(show).toContain("sillajje/");
		expect(show).toContain("I created the login page.");
		expect(show).toMatch(/\d+\.\ds/);

		// Bookmark should exist.
		const bookmarks = jj(["bookmark", "list"], cwd);
		expect(bookmarks).toContain(`sillajje/${sessionId}`);
	});

	it("steering does NOT create a new change", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'work'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);

		// --- First interaction ---
		await simulateInteraction(runner, "Do the first thing", "First done.");

		// Record bookmark position.
		const bmBefore = jj(
			["bookmark", "list", "--revision", `sillajje/${sessionId}`],
			cwd,
		);

		// --- Steering ---
		await runner.emitInput(
			"Actually, use TypeScript instead",
			undefined,
			"interactive",
			"steer",
		);
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Updated.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// Bookmark should NOT have moved.
		const bmAfter = jj(
			["bookmark", "list", "--revision", `sillajje/${sessionId}`],
			cwd,
		);
		expect(bmAfter).toBe(bmBefore);
	});

	it("multiple agent segments accumulate elapsed time", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'work'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);

		// --- Interaction with a followUp: two agent segments ---
		await runner.emitInput("Do something", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);

		// Segment 1
		await runner.emit({ type: "agent_start" });
		await new Promise((r) => setTimeout(r, 10));
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Attempt 1")] as any[],
		});

		// Segment 2 (follow-up)
		await runner.emitInput("Do more", undefined, "interactive", "followUp");
		await runner.emitBeforeAgentStart(
			"Do more",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await new Promise((r) => setTimeout(r, 15));
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Do more done.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// Both interactions should appear in the log.
		const log = jj(
			["log", "-r", `ancestors(sillajje/${sessionId})`, "--no-graph"],
			cwd,
		);
		expect(log).toContain("Do something");
		expect(log).toContain("Do more");

		// The latest stamp should have Meta: line with elapsed
		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).toContain("Meta:");
	}, 30_000);

	it("two consecutive normal interactions produce two separate changes", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'work'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);

		// --- Interaction 1 ---
		await simulateInteraction(runner, "Add login", "Login added.");

		// --- Interaction 2 ---
		await simulateInteraction(runner, "Add dashboard", "Dashboard added.");

		// The bookmark ancestors should contain both descriptions.
		const log = jj(
			["log", "-r", `ancestors(sillajje/${sessionId})`, "--no-graph"],
			cwd,
		);
		expect(log).toContain("Add login");
		expect(log).toContain("Add dashboard");
	}, 30_000);

	it("followUp creates its own change on the next agent_settled", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'work'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);

		// --- First interaction ---
		await simulateInteraction(runner, "First task", "First done.");

		// --- Follow-up (streamingBehavior = "followUp") ---
		await runner.emitInput(
			"Follow-up task",
			undefined,
			"interactive",
			"followUp",
		);
		await runner.emitBeforeAgentStart(
			"Follow-up task",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Follow-up done.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// Both should appear.
		const log = jj(
			["log", "-r", `ancestors(sillajje/${sessionId})`, "--no-graph"],
			cwd,
		);
		expect(log).toContain("First task");
		expect(log).toContain("Follow-up task");
	}, 30_000);
});
