import { describe, expect, it, vi } from "vitest";
import { createRunner, makeRunnerCwd } from "./_helpers";

describe("sillajje scaffold", () => {
	it("loads from configured path and registers handlers/commands", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		expect(runner.hasHandlers("session_start")).toBe(true);
		expect(runner.hasHandlers("before_agent_start")).toBe(true);
		expect(runner.hasHandlers("agent_settled")).toBe(true);
		expect(runner.hasHandlers("tool_call")).toBe(true);
		expect(runner.hasHandlers("input")).toBe(true);

		const cmd = runner.getCommand("sillajje");
		expect(cmd).toBeDefined();
		expect(cmd?.invocationName).toBe("sillajje");
	});

	it("session_start in non-jj directory clears the status pill", async () => {
		const cwd = makeRunnerCwd();
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

		expect(setStatus).toHaveBeenCalledWith("sillajje", undefined);
	});

	it("before_agent_start pass-through when inactive", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are a helpful assistant.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		expect(result).toBeUndefined();
	});

	it("tool_call and input handlers pass through when inactive", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		await runner.emit({ type: "session_start", reason: "startup" });

		const tcResult = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: "some-file.txt" },
		});
		expect(tcResult).toBeUndefined();

		const inputResult = await runner.emitInput(
			"hello",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "continue" });
	});
});
