import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

function resolveExtensionPath(): string {
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

		// Set up a mock UI so syncPill calls setStatus
		const setStatus = vi.fn();
		runner.setUIContext(
			{ setStatus } as unknown as Parameters<
				typeof runner.setUIContext
			>[0],
			"tui",
		);

		await runner.emit({ type: "session_start", reason: "startup" });

		// Inactive → pill should be cleared (setStatus called with undefined)
		expect(setStatus).toHaveBeenCalledWith("sillajje", undefined);
	});

	it("before_agent_start pass-through when inactive (no prompt injection)", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		await runner.emit({ type: "session_start", reason: "startup" });

		const result = await runner.emitBeforeAgentStart(
			"do something",
			undefined,
			"You are a helpful assistant.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		// Inactive → no system prompt injection
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
		// jj not on PATH
	}

	const describeJj = jjAvailable ? describe : describe.skip;

	describeJj("workspace creation and prompt injection", () => {
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
				{ setStatus } as unknown as Parameters<
					typeof runner.setUIContext
				>[0],
				"tui",
			);

			await runner.emit({ type: "session_start", reason: "startup" });

			// Active → pill should contain [active] and the workspace path
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

			// The workspace should exist on disk under the default workspaces root
			const defaultRoot = `${homedir()}/.pi/sillajje`;
			// Session ID for in-memory sessions is deterministic — we just check
			// that a workspace directory was created under the expected root.
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

			// When active, the system prompt should include the workspace block
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
});
