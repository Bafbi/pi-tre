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

	it("session_start creates a jj workspace on trunk()", async () => {
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
});
