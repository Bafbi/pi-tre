import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	createRunner,
	describeJj,
	makeRunnerCwd,
	sessionBookmark,
	tempDirs,
} from "./_helpers.js";

describeJj("sillajje workspace creation and prompt injection", () => {
	it("session_start sets active status pill with workspace path", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);

		const setStatus = vi.fn();
		runner.setUIContext(
			{
				setStatus,
				notify: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		expect(setStatus).toHaveBeenCalled();
		const call = setStatus.mock.calls.find((c) => c[0] === "sillajje");
		expect(call).toBeDefined();
		expect(call![1]).toContain("sillajje: [active]");
		expect(call![1]).toContain(".pi/sillajje");
	});

	it("session_start creates a jj workspace", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const defaultRoot = `${homedir()}/.pi/sillajje`;
		expect(existsSync(defaultRoot)).toBe(true);
	});

	it("workspace is created and appears in jj workspace list", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		// Create an initial commit so @- exists.
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
		execSync("jj new -m 'second'", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const ctx = runner.createContext();
		const sessionId = ctx.sessionManager.getSessionId();
		expect(sessionId).toBeDefined();

		const workspaceList = execSync("jj workspace list", {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		});
		expect(workspaceList).toContain(sessionBookmark(sessionId));
	});

	it("before_agent_start creates the session bookmark for jj log visibility", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = runner.createContext().sessionManager.getSessionId();
		expect(sessionId).toBeDefined();

		// No bookmark yet before any interaction.
		const before = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(before).not.toContain(sessionBookmark(sessionId));

		// The first interaction creates the bookmark on the session working copy.
		await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);

		const after = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(after).toContain(sessionBookmark(sessionId));

		// The bookmark points at the session workspace's working copy (@).
		// Compare change ids (stable under rewrites) via `jj log` templates,
		// which are stable across jj output-format changes.
		const wsChangeId = execSync(
			`jj log -r '${sessionBookmark(sessionId)}@' --no-graph -T change_id`,
			{ cwd, encoding: "utf-8" },
		).trim();
		const bmChangeId = execSync(
			`jj log -r '${sessionBookmark(sessionId)}' --no-graph -T change_id`,
			{ cwd, encoding: "utf-8" },
		).trim();
		expect(bmChangeId).toBe(wsChangeId);
	});

	it("before_agent_start injects workspace path into system prompt", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const basePrompt = "You are a helpful assistant.";
		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			basePrompt,
			{ skills: [], contextFiles: [], cwd: "" },
		);

		expect(result).toBeDefined();
		expect(result?.systemPrompt).toBeDefined();
		expect(result?.systemPrompt).toContain(basePrompt);
		expect(result?.systemPrompt).toContain("## Sillajje Workspace");
		expect(result?.systemPrompt).toContain(`${homedir()}/.pi/sillajje`);
	});

	it("status command reports workspace path after creation", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const cmd = runner.getCommand("sillajje:status");
		expect(cmd).toBeDefined();
		await expect(
			cmd?.handler("", runner.createCommandContext()),
		).resolves.toBeUndefined();
	});

	it("system prompt explains workspace is a clean checkout with missing deps and relative paths", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);

		expect(result?.systemPrompt).toContain("clean checkout");
		expect(result?.systemPrompt).toContain("node_modules");
		expect(result?.systemPrompt).toContain("install");
		expect(result?.systemPrompt).toContain("relative paths");
	});

	it("system prompt reserves VCS commands for the user by default", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);

		expect(result?.systemPrompt).toContain(
			"Ask the user before you run any",
		);
		expect(result?.systemPrompt).toContain("jj or git command");
	});

	it("vcsGuard false omits the VCS instruction from the system prompt", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const configDir = join(cwd, ".pi/configs");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "sillajje.json"),
			JSON.stringify({ vcsGuard: false }),
		);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);

		expect(result?.systemPrompt).toContain("## Sillajje Workspace");
		expect(result?.systemPrompt).not.toContain("jj or git command");
	});
});
