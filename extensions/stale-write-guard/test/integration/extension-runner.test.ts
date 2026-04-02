import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	AuthStorage,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	discoverAndLoadExtensions,
} from "@mariozechner/pi-coding-agent";

const tempDirs: string[] = [];

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "stale-write-guard-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

function setMtimeMs(path: string, mtimeMs: number): void {
	const timeSeconds = mtimeMs / 1000;
	utimesSync(path, timeSeconds, timeSeconds);
}

async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolve(process.cwd(), "extensions/stale-write-guard/src/index.ts");
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRegistry = ModelRegistry.create(AuthStorage.create(join(cwd, "auth.json")));
	return new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, modelRegistry);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("stale-write-guard extension", () => {
	it("loads from configured path and registers handlers/commands", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		expect(runner.hasHandlers("session_start")).toBe(true);
		const debugCommand = runner.getCommand("stale-write-guard-debug");
		expect(debugCommand).toBeDefined();
		expect(debugCommand?.invocationName).toBe("stale-write-guard-debug");

		if (!debugCommand) throw new Error("Expected stale-write-guard-debug command to be registered");
		await expect(debugCommand.handler("status", runner.createCommandContext())).resolves.toBeUndefined();
		await expect(debugCommand.handler("dump", runner.createCommandContext())).resolves.toBeUndefined();
	});

	it("blocks edit on existing file when no read record exists", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "unread.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_500_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-unread",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "hello", newText: "hi" }],
			},
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Read it again");
	});

	it("blocks edit when file changed externally after last agent edit", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "initial\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "write-1",
			toolName: "write",
			input: { path: toolPath, content: "initial\n" },
			content: [{ type: "text", text: "written" }],
			details: undefined,
			isError: false,
		});

		writeFileSync(filePath, "external change\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "external", newText: "agent" }],
			},
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Read it again");
	});

	it("allows edit after a fresh read of externally changed file", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "initial\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "write-1",
			toolName: "write",
			input: { path: toolPath, content: "initial\n" },
			content: [{ type: "text", text: "written" }],
			details: undefined,
			isError: false,
		});

		writeFileSync(filePath, "external change\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: toolPath },
			content: [{ type: "text", text: "external change" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-2",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "external", newText: "agent" }],
			},
		});

		expect(result).toBeUndefined();
	});

	it("allows write for non-existing files", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-new",
			toolName: "write",
			input: {
				path: "brand-new.txt",
				content: "hello",
			},
		});

		expect(result).toBeUndefined();
	});
});
