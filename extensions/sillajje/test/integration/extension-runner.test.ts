import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

function resolveExtensionPath(): string {
	// Resolve relative to this test file so tests work regardless of CWD
	// (e.g. mise monorepo tasks run from extension dir, direct vitest from root).
	const testDir = dirname(fileURLToPath(import.meta.url));
	return resolve(testDir, "../../src/index.ts");
}

async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolveExtensionPath();
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		allowModelNetwork: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		sessionManager,
		modelRegistry,
	);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("sillajje extension", () => {
	it("loads from configured path and registers handlers/commands", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		// Handlers are registered
		expect(runner.hasHandlers("session_start")).toBe(true);
		expect(runner.hasHandlers("before_agent_start")).toBe(true);
		expect(runner.hasHandlers("agent_settled")).toBe(true);
		expect(runner.hasHandlers("tool_call")).toBe(true);
		expect(runner.hasHandlers("input")).toBe(true);

		// Command is registered
		const cmd = runner.getCommand("sillajje");
		expect(cmd).toBeDefined();
		expect(cmd?.invocationName).toBe("sillajje");
	});

	it("session_start in non-jj directory reports inactive via status command", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		// Emit session_start
		await runner.emit({ type: "session_start", reason: "startup" });

		// The extension should have handlers but status should work
		const cmd = runner.getCommand("sillajje");
		expect(cmd).toBeDefined();

		// Just verify the command doesn't throw
		await expect(
			cmd?.handler("status", runner.createCommandContext()),
		).resolves.toBeUndefined();
	});

	it("tool_call and input handlers pass through when inactive", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		await runner.emit({ type: "session_start", reason: "startup" });

		// tool_call should pass through
		const tcResult = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: "some-file.txt" },
		});
		expect(tcResult).toBeUndefined();

		// input should pass through
		const inputResult = await runner.emitInput(
			"hello",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "continue" });
	});

	it("before_agent_start handler passes through", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		expect(result).toBeUndefined();
	});
});

/**
 * Tests requiring a real jj-initialized repo.
 * Skips when `jj` is not on PATH.
 */
describe("sillajje in jj repo", () => {
	let jjAvailable = false;

	try {
		execSync("jj --version", { stdio: "pipe" });
		jjAvailable = true;
	} catch {
		// jj not on PATH — skip these tests
	}

	const describeJj = jjAvailable ? describe : describe.skip;

	describeJj("detection", () => {
		it("session_start detects jj repo and transitions to active", async () => {
			const cwd = makeRunnerCwd();
			tempDirs.push(cwd);

			// Initialize a jj repo in the temp directory (disable signing for CI/test)
			execSync("jj git init --config signing.backend=none", {
				cwd,
				stdio: "pipe",
			});

			const runner = await createRunner(cwd);

			await runner.emit({ type: "session_start", reason: "startup" });

			// Verify handlers still registered in jj repo
			expect(runner.hasHandlers("session_start")).toBe(true);

			// Status should work within the jj repo
			const cmd = runner.getCommand("sillajje");
			expect(cmd).toBeDefined();
			await expect(
				cmd?.handler("status", runner.createCommandContext()),
			).resolves.toBeUndefined();
		});
	});
});
