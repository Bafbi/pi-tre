import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunner, describeJj, makeRunnerCwd, tempDirs } from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeSillajjeConfig(cwd: string, config: Record<string, unknown>) {
	const dir = join(cwd, ".pi/configs");
	execSync(`mkdir -p '${dir}'`, { stdio: "pipe" });
	writeFileSync(join(dir, "sillajje.json"), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeJj("sillajje post-init commands", () => {
	it("runs post-init commands after workspace creation", async () => {
		const cwd = makeRunnerCwd();
		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });

		// Configure a post-init command that creates a marker file.
		writeSillajjeConfig(cwd, {
			postInit: ["touch .sillajje-post-init-marker"],
		});

		const runner = await createRunner(cwd);
		const notify = vi.fn();
		runner.setUIContext(
			{
				notify,
				setStatus: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		// The workspace directory should contain the marker file.
		const ctx = runner.createContext();
		const sessionId = ctx.sessionManager.getSessionId();
		expect(sessionId).toBeDefined();
		const repoSlug = cwd.split("/").pop()!;
		const wsPath = `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;
		expect(existsSync(join(wsPath, ".sillajje-post-init-marker"))).toBe(
			true,
		);

		// Notifications should include progress and completion.
		expect(notify).toHaveBeenCalledWith(
			"[sillajje] post-init: touch .sillajje-post-init-marker...",
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			"[sillajje] post-init: 1 command(s) completed",
			"info",
		);
	});

	it("runs multiple post-init commands in order", async () => {
		const cwd = makeRunnerCwd();
		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });

		writeSillajjeConfig(cwd, {
			postInit: [
				"echo first > .sillajje-order",
				"echo second >> .sillajje-order",
			],
		});

		const runner = await createRunner(cwd);
		const notify = vi.fn();
		runner.setUIContext(
			{
				notify,
				setStatus: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		const ctx = runner.createContext();
		const sessionId = ctx.sessionManager.getSessionId();
		const repoSlug = cwd.split("/").pop()!;
		const wsPath = `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;

		const output = execSync("cat .sillajje-order", {
			cwd: wsPath,
			encoding: "utf-8",
		});
		expect(output.trim()).toBe("first\nsecond");
	});

	it("continues on post-init command failure and reports errors", async () => {
		const cwd = makeRunnerCwd();
		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });

		// First command succeeds, second fails, third succeeds.
		writeSillajjeConfig(cwd, {
			postInit: [
				"touch .sillajje-marker-a",
				"false",
				"touch .sillajje-marker-c",
			],
		});

		const runner = await createRunner(cwd);
		const notify = vi.fn();
		runner.setUIContext(
			{
				notify,
				setStatus: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		const ctx = runner.createContext();
		const sessionId = ctx.sessionManager.getSessionId();
		const repoSlug = cwd.split("/").pop()!;
		const wsPath = `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;

		// Both markers should exist (commands 1 and 3 ran despite command 2 failure).
		expect(existsSync(join(wsPath, ".sillajje-marker-a"))).toBe(true);
		expect(existsSync(join(wsPath, ".sillajje-marker-c"))).toBe(true);

		// Session is still active — workspace ready notification fired.
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("workspace ready"),
			"info",
		);

		// Error notification fired for the failed command.
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("post-init command failed"),
			"error",
		);

		// Completion notification with warning (not all succeeded).
		expect(notify).toHaveBeenCalledWith(
			"[sillajje] post-init: completed with errors",
			"warning",
		);
	});

	it("no-ops when postInit is empty", async () => {
		const cwd = makeRunnerCwd();
		execSync("jj git init --config signing.backend=none", {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "README.md"), "# Test\n");
		execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });

		writeSillajjeConfig(cwd, { postInit: [] });

		const runner = await createRunner(cwd);
		const notify = vi.fn();
		runner.setUIContext(
			{
				notify,
				setStatus: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		// No post-init related notifications.
		const postInitCalls = notify.mock.calls.filter(
			([msg]: [string]) =>
				typeof msg === "string" && msg.includes("post-init"),
		);
		expect(postInitCalls).toHaveLength(0);

		// Session started normally.
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("workspace ready"),
			"info",
		);
	});
});
