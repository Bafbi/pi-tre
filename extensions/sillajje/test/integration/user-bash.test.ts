import { execSync } from "node:child_process";
import { expect, it } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

describeJj("sillajje user_bash interception", () => {
	it("active session returns operations from user_bash handler", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitUserBash({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: false,
			cwd,
		});

		expect(result).toBeDefined();
		expect(result?.operations).toBeDefined();
		expect(result?.result).toBeUndefined();
	});

	it("inactive session returns undefined from user_bash handler (pass-through)", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		// No jj init — sillajje stays inactive
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitUserBash({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: false,
			cwd,
		});

		expect(result).toBeUndefined();
	});

	it("user_bash operations redirect cwd to workspace path", async () => {
		const cwd = makeRunnerCwd();
		tempDirs.push(cwd);

		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Get the workspace path from the runner context.
		const ctx = runner.createContext();
		const sessionId = ctx.sessionManager.getSessionId();
		expect(sessionId).toBeDefined();

		// Emit user_bash with a command that checks the effective working directory.
		const result = await runner.emitUserBash({
			type: "user_bash",
			command: "pwd",
			excludeFromContext: false,
			cwd,
		});

		expect(result).toBeDefined();
		expect(result?.operations).toBeDefined();

		// Execute the operations — the cwd passed here should be IGNORED,
		// and the actual execution should happen in the workspace path.
		const operations = result.operations;
		expect(operations).toBeDefined();

		const stdoutChunks: Buffer[] = [];
		const exit = await operations.exec("pwd", "/some/ignored/path", {
			onData: (data: Buffer) => stdoutChunks.push(data),
		});
		expect(exit.exitCode).toBe(0);

		const output = Buffer.concat(stdoutChunks).toString("utf-8").trim();
		// The output should NOT be the ignored path, but rather the workspace path.
		expect(output).not.toBe("/some/ignored/path");
		expect(output).toContain(".pi/sillajje");
	});
});
