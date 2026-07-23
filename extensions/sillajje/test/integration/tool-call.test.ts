import { execSync } from "node:child_process";
import { expect, it } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

describeJj("sillajje tool call redirection", () => {
	it("redirects read path to workspace", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const event = {
			type: "tool_call" as const,
			toolCallId: "read-1",
			toolName: "read" as const,
			input: { path: "src/foo.ts" },
		};
		await runner.emitToolCall(event);

		expect(event.input.path).toContain("/.pi/sillajje/");
		expect(event.input.path).toContain("/src/foo.ts");
		expect(event.input.path).not.toBe("src/foo.ts");
	});

	it("prefixes bash command with cd to workspace", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const event = {
			type: "tool_call" as const,
			toolCallId: "bash-1",
			toolName: "bash" as const,
			input: { command: "npm test" },
		};
		await runner.emitToolCall(event);

		expect(event.input.command).toMatch(
			/^cd .+\.pi\/sillajje.+ && npm test$/,
		);
	});

	it("no-ops for non-file tools like web_search", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const event = {
			type: "tool_call" as const,
			toolCallId: "ws-1",
			toolName: "web_search" as const,
			input: { query: "hello" },
		};
		await runner.emitToolCall(event);

		expect(event.input).toEqual({ query: "hello" });
	});
});
