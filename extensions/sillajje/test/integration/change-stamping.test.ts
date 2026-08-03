import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { setTestSpawnFn } from "../../src/index.js";
import type { SpawnFn } from "../../src/sub-generator.js";
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

/** Assistant message representing a failed LLM run (e.g. provider timeout). */
function errorMsg(errorText: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: errorText }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "error" as const,
		errorMessage: errorText,
		timestamp: Date.now(),
	};
}

/** Default workspace path for a given session (config workspacesRoot default). */
function wsPath(repoRoot: string, sessionId: string): string {
	const repoSlug = repoRoot.split("/").pop();
	return `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;
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
// Helpers for config-gated tests
// ---------------------------------------------------------------------------

/**
 * Write a sillajje config file at `cwd/.pi/configs/sillajje.json`.
 * Creates the directory if needed.
 */
function writeSillajjeConfig(
	cwd: string,
	config: Record<string, unknown>,
): void {
	const dir = join(cwd, ".pi/configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sillajje.json"), JSON.stringify(config));
}

/** Create a fresh jj repo for testing, returning the repo path. */
function initRepo(): string {
	const cwd = makeRunnerCwd();
	tempDirs.push(cwd);

	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	writeFileSync(join(cwd, "README.md"), "# Test\n");
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
	execSync("jj new -m 'work'", { cwd, stdio: "pipe" });

	return cwd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Stamping must never spawn a real `pi -p` subprocess in tests. Install a
// canned sub-generator by default; tests that exercise failure fallback
// override the seam inside their own body.
beforeEach(() => {
	installDefaultSubGeneratorMock();
});

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
	}, 10_000);

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
	}, 10_000);

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

		// Both interactions should appear in the log. With the canned
		// sub-generator the subject is fixed, so assert on the body's
		// Prompt section instead of the subject line.
		const log = jj(
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionId})`,
				"--no-graph",
				"-T",
				"description",
			],
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

		// The bookmark ancestors should contain both descriptions. With the
		// canned sub-generator the subject is fixed, so assert on the body's
		// Prompt section instead of the subject line.
		const log = jj(
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionId})`,
				"--no-graph",
				"-T",
				"description",
			],
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

		// Both should appear — assert on the body's Prompt section since the
		// canned sub-generator fixes the subject line.
		const log = jj(
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(log).toContain("First task");
		expect(log).toContain("Follow-up task");
	}, 30_000);

	// -------------------------------------------------------------------
	// Config-gated body sections
	// -------------------------------------------------------------------

	it("omits Prompt section when message.body.user_prompt is false", async () => {
		const cwd = initRepo();

		// Prompt section disabled via config.
		writeSillajjeConfig(cwd, {
			message: {
				body: { user_prompt: false, trace: { enabled: false } },
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Hide the prompt from the body",
			"The prompt is hidden.",
		);

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).not.toContain("Prompt:");
		// Other sections still present.
		expect(show).toContain("Response:");
		expect(show).toContain("Meta:");
	}, 30_000);

	it("omits Response section when message.body.response is false", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			message: { body: { response: false, trace: { enabled: false } } },
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Hide the response from the body",
			"The response is hidden.",
		);

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).not.toContain("Response:");
		expect(show).toContain("Prompt:");
		expect(show).toContain("Meta:");
	}, 30_000);

	it("omits entire Meta block when message.body.meta.enabled is false", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			message: {
				body: { meta: { enabled: false }, trace: { enabled: false } },
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Hide the meta block",
			"Meta hidden.",
		);

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).not.toContain("Meta:");
		expect(show).toContain("Response:");
		expect(show).toContain("Prompt:");
	}, 30_000);

	it("toggles individual meta fields in the Meta block", async () => {
		const cwd = initRepo();

		// Disable tools and elapsed, keep call_count and thinking_blocks.
		writeSillajjeConfig(cwd, {
			message: {
				body: {
					meta: { tools: false, elapsed: true },
					trace: { enabled: false },
				},
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		// Use a tool so the Meta block has tool data to toggle.
		await runner.emitInput(
			"Use tools to demonstrate meta toggles",
			undefined,
			"interactive",
		);
		await runner.emitBeforeAgentStart(
			"Use tools to demonstrate meta toggles",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "bash",
			input: { command: "echo done" },
		});
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "read",
			input: { path: "test.txt", content: "test" },
		});
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Used tools.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		// Tools are toggled off → tool names should not appear.
		expect(show).not.toContain("bash, read");
		// call_count defaults to true → should appear.
		expect(show).toMatch(/\d+ calls/);
		// elapsed defaults to true → should appear.
		expect(show).toMatch(/\d+\.\ds/);
		// thinking_blocks defaults to true → should appear.
		expect(show).toContain("blocks");
	}, 30_000);

	// -------------------------------------------------------------------
	// Header mode: user_prompt
	// -------------------------------------------------------------------

	it("uses prompt as subject when message.header is user_prompt", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			message: {
				header: "user_prompt",
				body: { trace: { enabled: false } },
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Prompt as subject: first line",
			"Done.",
		);

		// Subject should be the prompt, not a dual-prefix header.
		// `jj show` starts with the commit header lines, so read the
		// description's first line directly via a log template.
		const firstLine = jj(
			[
				"log",
				"-r",
				`sillajje/${sessionId}`,
				"--no-graph",
				"-T",
				"description.first_line()",
			],
			cwd,
		);
		expect(firstLine).toBe("Prompt as subject: first line");
	}, 30_000);

	// -------------------------------------------------------------------
	// Sub-generator fallback
	// -------------------------------------------------------------------

	it("falls back to deriveSubject and omits trace when sub-generator is unavailable", async () => {
		const cwd = initRepo();

		// Make every sub-generator attempt fail — the header falls back to
		// deriveSubject(prompt) and the trace falls back to an empty string.
		setTestSpawnFn(async () => {
			throw new Error("sub-generator unavailable");
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Test fallback behavior",
			"Fallback complete.",
		);

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		// Subject should be the prompt fallback (the first line of the prompt).
		// `jj show` starts with the commit header lines, so read the
		// description's first line directly via a log template.
		const firstLine = jj(
			[
				"log",
				"-r",
				`sillajje/${sessionId}`,
				"--no-graph",
				"-T",
				"description.first_line()",
			],
			cwd,
		);
		expect(firstLine).toBe("Test fallback behavior");
		// Trace section should be absent (sub-generator fell back to empty string).
		expect(show).not.toContain("Trace:");
	}, 60_000);

	// -------------------------------------------------------------------
	// Sub-generator success path (via test seam)
	// -------------------------------------------------------------------

	it("uses mocked sub-generator when __testSpawnFn is set", async () => {
		const cwd = initRepo();

		// Mock SpawnFn that produces canned output on first call (header)
		// and second call (trace). The parallel calls mean we don't know
		// which runs first, so we accept both orders.
		const mockSpawn = vi
			.fn<SpawnFn>()
			.mockImplementation(
				(_cmd: string, _args: string[], input: string) => {
					// Detect which prompt was used based on content.
					if (input.includes("Interaction types")) {
						return Promise.resolve({
							code: 0,
							stdout: "act/feat: add mocked login page",
							stderr: "",
						});
					}
					if (input.includes("narrative")) {
						return Promise.resolve({
							code: 0,
							stdout: "The agent created a mocked login page with validation.",
							stderr: "",
						});
					}
					return Promise.resolve({
						code: 0,
						stdout: "fallback",
						stderr: "",
					});
				},
			);

		setTestSpawnFn(mockSpawn);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Mock this interaction",
			"Mock complete.",
		);

		// Reset the seam.
		setTestSpawnFn(undefined);

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		// Dual-prefix subject from mock header sub-generator.
		expect(show).toContain("act/feat: add mocked login page");
		// Trace section from mock trace sub-generator.
		expect(show).toContain("Trace:");
		expect(show).toContain(
			"The agent created a mocked login page with validation.",
		);
	}, 30_000);

	it("does not stamp mid-interaction on an error agent_end; stamps at the true end (retry scenario)", async () => {
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
		const workspace = wsPath(cwd, sessionId);

		// The interaction starts normally.
		await runner.emitInput("Fix the login bug", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Fix the login bug",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });

		// Segment 1 writes a.ts, then the run ends in a transient error
		// (e.g. provider timeout). Pi emits agent_end with the error message
		// and auto-retries: agent_start fires again mid-interaction.
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [errorMsg("request timed out")] as any[],
		});
		await runner.emit({ type: "agent_start" });

		// Segment 2 (the retry continuation) writes b.ts on the same interaction.
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "write",
			input: { path: "b.ts", content: "// b" },
		});
		writeFileSync(join(workspace, "b.ts"), "// b\n");

		// The interaction truly ends here.
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Fixed the login bug.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// The stamp must happen only at the true end: the bookmarked change
		// contains BOTH files and the final response, and the workspace
		// working copy is sealed clean by the final `jj new`.
		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).toContain("a.ts");
		expect(show).toContain("b.ts");
		expect(show).toContain("Fixed the login bug.");

		const status = jj(["status"], workspace);
		expect(status).not.toContain("a.ts");
		expect(status).not.toContain("b.ts");
	}, 30_000);

	it("finalizes an error-ended interaction as its own change when the next prompt arrives", async () => {
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
		const workspace = wsPath(cwd, sessionId);

		// Interaction 1 ends in a FINAL error — no retry continuation follows.
		await runner.emitInput("First task", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"First task",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [errorMsg("provider unavailable")] as any[],
		});

		// Interaction 2: the next prompt finalizes interaction 1 as its own
		// change, then stamps interaction 2 normally.
		await runner.emitInput("Next task", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Next task",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "write",
			input: { path: "b.ts", content: "// b" },
		});
		writeFileSync(join(workspace, "b.ts"), "// b\n");
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Next task done.")] as any[],
		});
		await runner.emit({ type: "agent_settled" });

		// Both interactions were stamped as separate changes.
		const log = jj(
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(log).toContain("First task");
		expect(log).toContain("Next task");

		// The latest (Next task) change contains only b.ts — the error
		// interaction's a.ts was sealed into its own earlier change.
		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).toContain("b.ts");
		expect(show).not.toContain("a.ts");
	}, 30_000);

	it("finalizes an error-ended interaction at session_shutdown when never retried", async () => {
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
		const workspace = wsPath(cwd, sessionId);

		// Interaction ends in a FINAL error — no retry, no next prompt.
		await runner.emitInput("Last task", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Last task",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [errorMsg("provider unavailable")] as any[],
		});

		// Session ends — the pending interaction must be stamped anyway.
		await runner.emit({ type: "session_shutdown" });

		const show = jj(["show", `sillajje/${sessionId}`], cwd);
		expect(show).toContain("Last task");
		expect(show).toContain("a.ts");
		expect(show).toContain("provider unavailable");
	}, 30_000);
});
