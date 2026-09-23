import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSubagent } from "@pi-tre/sillajje-core";
import { beforeEach, expect, it, vi } from "vitest";
import { setTestPorts } from "../../src/index.js";
import { STAMP_MARKER_TYPE } from "../../src/interaction.js";
import {
	assistantMsg,
	createRunner,
	describeJj,
	getSessionId,
	getSessionManager,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	makeRunnerCwd,
	recordAssistantMessage,
	recordInteraction,
	recordUserMessage,
	sessionBookmark,
	tempDirs,
	wsPath,
} from "./_helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assistant message representing a failed LLM run (e.g. provider timeout). */
function errorMsg(errorText: string) {
	return assistantMsg(errorText, {
		stopReason: "error",
		errorMessage: errorText,
	});
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Stamping must never run a real sub-generator in tests. Install a
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
		recordUserMessage(runner, "Add a login page");
		recordAssistantMessage(
			runner,
			assistantMsg("I created the login page.", {
				toolCalls: [
					{ id: "tc-1", name: "write" },
					{ id: "tc-2", name: "bash" },
				],
			}),
		);
		await runner.emit({ type: "agent_settled" });

		// The bookmark is set on the stamped commit in the repo.
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Add a login page");
		expect(show).toContain("Loop: write, bash | 2 calls");
		// Provenance: interaction source, model, and versions.
		expect(show).toContain("source: interaction");
		expect(show).toMatch(/model: /);
		expect(show).toMatch(/pi: /);
		expect(show).toContain("sillajje/");
		expect(show).toContain("I created the login page.");
		expect(show).toMatch(/\d+\.\ds/);
		// Provenance: the Interaction's session entry range.
		expect(show).toMatch(/interaction: \S+\.\.\S+/);

		// Bookmark should exist.
		const bookmarks = jj(["bookmark", "list"], cwd);
		expect(bookmarks).toContain(sessionBookmark(sessionId));
	}, 10_000);

	it("reconstructs the cursor on session_start so a reload does not re-stamp", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		await simulateInteraction(runner, "First task", "First done.");

		// A reload resets the in-memory state and rebuilds the cursor from the
		// Stamp marker on the branch.
		await runner.emit({ type: "session_start", reason: "reload" });

		await simulateInteraction(runner, "Second task", "Second done.");

		// The second change holds only the second Interaction's transcript.
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Second task");
		expect(show).not.toContain("First task");
	}, 30_000);

	it("recovers a completed but unstamped Interaction after a reload", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		// A completed Interaction whose run never settled.
		await runner.emitInput("Lost task", undefined, "interactive");
		recordInteraction(runner, "Lost task", "Lost done.");

		// A reload rebuilds the cursor before the Interaction.
		await runner.emit({ type: "session_start", reason: "reload" });

		// The next settle stamps the recovered Interaction.
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Lost task");
	}, 30_000);

	it("reconstructs the cursor on session_tree after branch navigation", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		await simulateInteraction(runner, "First task", "First done.");
		await simulateInteraction(runner, "Second task", "Second done.");

		// Navigate back to the first Stamp marker: the branch no longer
		// contains the second Interaction.
		const sessionManager = getSessionManager(runner);
		const firstMarker = sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === STAMP_MARKER_TYPE,
			);
		if (!firstMarker) throw new Error("expected a Stamp marker");
		sessionManager.branch(firstMarker.id);
		await runner.emit({
			type: "session_tree",
			newLeafId: firstMarker.id,
			oldLeafId: null,
		});

		await simulateInteraction(runner, "Third task", "Third done.");

		// The third change holds only the third Interaction's transcript.
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Third task");
		expect(show).not.toContain("Second task");
	}, 30_000);

	it("folds a steering prompt into the current change", async () => {
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

		// One run: the initial prompt, then a steering prompt, then the final
		// response. Both prompts belong to the same Interaction.
		await runner.emitInput("Do the first thing", undefined, "interactive");
		recordUserMessage(runner, "Do the first thing");
		await runner.emitInput(
			"Actually, use TypeScript instead",
			undefined,
			"interactive",
			"steer",
		);
		recordUserMessage(runner, "Actually, use TypeScript instead");
		recordAssistantMessage(runner, assistantMsg("Updated."));
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Do the first thing");
		expect(show).toContain("Actually, use TypeScript instead");
	}, 10_000);

	it("folds a follow-up segment into the current change", async () => {
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

		// One run with a follow-up segment. Both prompts fold into the same
		// Interaction, and the change is sealed once at settle.
		await runner.emitInput("Do something", undefined, "interactive");
		recordUserMessage(runner, "Do something");
		recordAssistantMessage(runner, assistantMsg("Attempt 1"));

		await runner.emitInput("Do more", undefined, "interactive", "followUp");
		recordUserMessage(runner, "Do more");
		recordAssistantMessage(runner, assistantMsg("Do more done."));
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Do something");
		expect(show).toContain("Do more");
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
				`ancestors(${sessionBookmark(sessionId)})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(log).toContain("Add login");
		expect(log).toContain("Add dashboard");
	}, 30_000);

	it("folds a follow-up prompt into the current change", async () => {
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

		await runner.emitInput("First task", undefined, "interactive");
		recordUserMessage(runner, "First task");
		recordAssistantMessage(runner, assistantMsg("First done."));
		await runner.emitInput(
			"Follow-up task",
			undefined,
			"interactive",
			"followUp",
		);
		recordUserMessage(runner, "Follow-up task");
		recordAssistantMessage(runner, assistantMsg("Follow-up done."));
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("First task");
		expect(show).toContain("Follow-up task");
	}, 30_000);

	it("manual /sillajje:stamp -s @ records the diff source in the provenance", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// Work happens in the workspace, then the user stamps -s @ manually.
		writeFileSync(join(workspace, "manual.ts"), "// manual\n");

		const cmd = runner.getCommand("sillajje:stamp");
		expect(cmd).toBeDefined();
		await cmd!.handler("-s @", runner.createCommandContext());

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Meta: source: diff");
		expect(show).toContain(sessionBookmark(sessionId));
		// No interaction sections — the message generated from the diff alone.
		expect(show).not.toContain("Prompt:");
		expect(show).not.toContain("Response:");

		// The manual stamp consumed the pending Interaction: it wrote a Stamp marker.
		const markers = getSessionManager(runner)
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === STAMP_MARKER_TYPE,
			);
		expect(markers).toHaveLength(1);
	}, 15_000);

	it("a target-less /sillajje:stamp shows help and seals nothing", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);
		writeFileSync(join(workspace, "manual.ts"), "// manual\n");
		const headBefore = jj(
			["log", "-r", "@", "--no-graph", "-T", "change_id"],
			workspace,
		);

		const cmd = runner.getCommand("sillajje:stamp");
		expect(cmd).toBeDefined();
		await cmd!.handler("", runner.createCommandContext());

		expect(
			notifications.some(
				(n) =>
					n[1] === "info" && n[0].includes("usage: /sillajje:stamp"),
			),
		).toBe(true);
		// Nothing was sealed.
		expect(
			jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], workspace),
		).toBe(headBefore);
	}, 15_000);

	it("stamp -h shows the same help as a target-less stamp", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		const cmd = runner.getCommand("sillajje:stamp");
		expect(cmd).toBeDefined();
		await cmd!.handler("-h", runner.createCommandContext());

		expect(
			notifications.some(
				(n) =>
					n[1] === "info" && n[0].includes("usage: /sillajje:stamp"),
			),
		).toBe(true);
	}, 15_000);

	// -------------------------------------------------------------------
	// Config-gated body sections
	// -------------------------------------------------------------------

	it("omits the Prompt section when it is not in the body", async () => {
		const cwd = initRepo();

		// Prompt and trace are not in the body.
		writeSillajjeConfig(cwd, {
			actions: { stamp: { body: ["meta", "loop", "response"] } },
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Hide the prompt from the body",
			"The prompt is hidden.",
		);

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).not.toContain("Prompt:");
		// Other sections still present.
		expect(show).toContain("Response:");
		expect(show).toContain("Meta:");
	}, 30_000);

	it("omits the Response section when it is not in the body", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			actions: { stamp: { body: ["meta", "loop", "prompt"] } },
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Hide the response from the body",
			"The response is hidden.",
		);

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).not.toContain("Response:");
		expect(show).toContain("Prompt:");
		expect(show).toContain("Meta:");
	}, 30_000);

	it("keeps the Meta section and omits Loop when Loop is not in the body", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			actions: {
				stamp: { body: ["trace", "meta", "prompt", "response"] },
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

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Meta:");
		expect(show).not.toContain("Loop:");
		expect(show).toContain("Response:");
		expect(show).toContain("Prompt:");
	}, 30_000);

	it("selects the Loop fields from the config", async () => {
		const cwd = initRepo();

		// Drop tools; keep call_count, elapsed, and thinking_blocks.
		writeSillajjeConfig(cwd, {
			actions: {
				stamp: {
					body: ["meta", "loop", "prompt", "response"],
					loop: ["call_count", "elapsed", "thinking_blocks"],
				},
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		// Use a tool so the Loop has tool data to drop.
		await runner.emitInput(
			"Use tools to demonstrate meta toggles",
			undefined,
			"interactive",
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
		recordUserMessage(runner, "Use tools to demonstrate meta toggles");
		recordAssistantMessage(runner, assistantMsg("Used tools."));
		await runner.emit({ type: "agent_settled" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		// Tools are not selected → tool names should not appear.
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

	it("uses prompt as subject when the header mode is user_prompt", async () => {
		const cwd = initRepo();

		writeSillajjeConfig(cwd, {
			actions: {
				stamp: {
					header: { mode: "user_prompt" },
					body: ["meta", "loop", "prompt", "response"],
				},
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
				sessionBookmark(sessionId),
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
		setTestPorts({
			run: async () => {
				throw new Error("sub-generator unavailable");
			},
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Test fallback behavior",
			"Fallback complete.",
		);

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		// Subject should be the prompt fallback (the first line of the prompt).
		// `jj show` starts with the commit header lines, so read the
		// description's first line directly via a log template.
		const firstLine = jj(
			[
				"log",
				"-r",
				sessionBookmark(sessionId),
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

	it("uses mocked sub-generator when setTestPorts is set", async () => {
		const cwd = initRepo();

		// Mock subagent backend that produces canned output on first call
		// (header) and second call (trace). The parallel calls mean we don't
		// know which runs first, so we accept both orders.
		const mockRun = vi
			.fn<RunSubagent>()
			.mockImplementation(({ prompt }) => {
				// Detect which prompt was used based on content.
				if (prompt.includes("Interaction types")) {
					return Promise.resolve({
						text: "act/feat: add mocked login page",
					});
				}
				if (prompt.includes("narrative")) {
					return Promise.resolve({
						text: "The agent created a mocked login page with validation.",
					});
				}
				return Promise.resolve({ text: "fallback" });
			});

		setTestPorts({ run: mockRun });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		await simulateInteraction(
			runner,
			"Mock this interaction",
			"Mock complete.",
		);

		// Reset the seam.
		setTestPorts({ run: undefined });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		// Dual-prefix subject from mock header sub-generator.
		expect(show).toContain("act/feat: add mocked login page");
		// Trace section from mock trace sub-generator.
		expect(show).toContain("Trace:");
		expect(show).toContain(
			"The agent created a mocked login page with validation.",
		);
	}, 30_000);

	it("stamps one change at the true end after an error segment", async () => {
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

		// Segment 1 writes a.ts, then the run ends in a transient error
		// (e.g. provider timeout). Pi retries the same Interaction, so both
		// segments share one settle.
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		recordUserMessage(runner, "Fix the login bug");
		recordAssistantMessage(runner, errorMsg("request timed out"));

		// Segment 2 (the retry continuation) writes b.ts on the same interaction.
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "write",
			input: { path: "b.ts", content: "// b" },
		});
		writeFileSync(join(workspace, "b.ts"), "// b\n");
		recordAssistantMessage(runner, assistantMsg("Fixed the login bug."));

		// The interaction truly ends here.
		await runner.emit({ type: "agent_settled" });

		// The stamp must happen only at the true end: the bookmarked change
		// contains BOTH files and the final response, and the workspace
		// working copy is sealed clean by the final `jj new`.
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("a.ts");
		expect(show).toContain("b.ts");
		expect(show).toContain("Fixed the login bug.");

		const status = jj(["status"], workspace);
		expect(status).not.toContain("a.ts");
		expect(status).not.toContain("b.ts");
	}, 30_000);

	it("stamps a final error interaction as its own change before the next one", async () => {
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

		// Interaction 1 ends in a FINAL error and settles as its own change.
		await runner.emitInput("First task", undefined, "interactive");
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		recordUserMessage(runner, "First task");
		recordAssistantMessage(runner, errorMsg("provider unavailable"));
		await runner.emit({ type: "agent_settled" });

		// Interaction 2 stamps its own change.
		await runner.emitInput("Next task", undefined, "interactive");
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "write",
			input: { path: "b.ts", content: "// b" },
		});
		writeFileSync(join(workspace, "b.ts"), "// b\n");
		recordUserMessage(runner, "Next task");
		recordAssistantMessage(runner, assistantMsg("Next task done."));
		await runner.emit({ type: "agent_settled" });

		// Both interactions were stamped as separate changes.
		const log = jj(
			[
				"log",
				"-r",
				`ancestors(${sessionBookmark(sessionId)})`,
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
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("b.ts");
		expect(show).not.toContain("a.ts");
	}, 30_000);

	it("flushes an unstamped Interaction at session_shutdown", async () => {
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

		// An Interaction is recorded but the run never settles.
		await runner.emitInput("Last task", undefined, "interactive");
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "a.ts", content: "// a" },
		});
		writeFileSync(join(workspace, "a.ts"), "// a\n");
		recordUserMessage(runner, "Last task");
		recordAssistantMessage(runner, errorMsg("provider unavailable"));

		// Session ends — the unstamped Interaction is stamped anyway.
		await runner.emit({ type: "session_shutdown", reason: "quit" });

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Last task");
		expect(show).toContain("a.ts");
		expect(show).toContain("provider unavailable");
	}, 30_000);
});
