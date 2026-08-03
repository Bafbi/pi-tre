import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { expect, it, vi } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

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
		const call = setStatus.mock.calls.find(
			(c: [string, string | undefined]) => c[0] === "sillajje",
		);
		expect(call).toBeDefined();
		expect(call[1]).toContain("sillajje: [active]");
		expect(call[1]).toContain(".pi/sillajje");
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
		expect(workspaceList).toContain(`sillajje-${sessionId}`);
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
		expect(before).not.toContain(`sillajje/${sessionId}`);

		// The first interaction creates the bookmark on the session working copy.
		await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);

		const after = execSync("jj bookmark list", {
			cwd,
			encoding: "utf-8",
		});
		expect(after).toContain(`sillajje/${sessionId}`);

		// The bookmark points at the session workspace's working copy (@).
		// `jj workspace list` and `jj bookmark list` both show the change id
		// as the first id token, so compare change ids (stable under rewrites).
		const wsList = execSync("jj workspace list", {
			cwd,
			encoding: "utf-8",
		});
		const wsLine = wsList
			.split("\n")
			.find((l: string) => l.startsWith(`sillajje-${sessionId}:`));
		if (!wsLine) {
			throw new Error(`workspace sillajje-${sessionId} not found`);
		}
		const wsChangeId = wsLine.split(":")[1].trim().split(" ")[0];
		const bmList = execSync(
			`jj bookmark list --revision sillajje/${sessionId}`,
			{ cwd, encoding: "utf-8" },
		);
		expect(bmList).toContain(wsChangeId);
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
			{ skills: [], contextFiles: [], prompts: [] },
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

		const cmd = runner.getCommand("sillajje");
		expect(cmd).toBeDefined();
		await expect(
			cmd?.handler("status", runner.createCommandContext()),
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
			{ skills: [], contextFiles: [], prompts: [] },
		);

		expect(result?.systemPrompt).toContain("clean checkout");
		expect(result?.systemPrompt).toContain("node_modules");
		expect(result?.systemPrompt).toContain("install");
		expect(result?.systemPrompt).toContain("relative paths");
	});
});
