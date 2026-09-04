import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	const dir = mkdtempSync(join(tmpdir(), "stale-write-guard-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

function setMtimeMs(path: string, mtimeMs: number): void {
	const timeSeconds = mtimeMs / 1000;
	utimesSync(path, timeSeconds, timeSeconds);
}

async function createRunner(
	cwd: string,
	extensionPaths?: string[],
): Promise<ExtensionRunner> {
	const paths = extensionPaths ?? [
		resolve(import.meta.dirname, "../../src/index.ts"),
	];
	const loaded = await discoverAndLoadExtensions(paths, cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(paths.length);

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

describe("stale-write-guard extension", () => {
	it("loads from configured path and registers handlers/commands", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		expect(runner.hasHandlers("session_start")).toBe(true);
		const dumpCommand = runner.getCommand("stale-write-guard-dump");
		expect(dumpCommand).toBeDefined();
		expect(dumpCommand?.invocationName).toBe("stale-write-guard-dump");

		if (!dumpCommand)
			throw new Error(
				"Expected stale-write-guard-dump command to be registered",
			);
		await expect(
			dumpCommand.handler("", runner.createCommandContext()),
		).resolves.toBeUndefined();
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

	it("allows edit after /skill:name injection recorded in before_agent_start", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const skillDir = join(cwd, "skills", "my-skill");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		const body = "# My Skill\n\nDo the thing.";
		writeFileSync(
			skillPath,
			`---\nname: my-skill\ndescription: y\n---\n${body}\n`,
			"utf8",
		);
		setMtimeMs(skillPath, 1_000_000);

		// Mirrors pi's _expandSkillCommand block format.
		const prompt = `<skill name="my-skill" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\n${body}\n</skill>\n\nUser: go`;
		await runner.emitBeforeAgentStart(prompt, undefined, "system prompt", {
			cwd,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-skill",
			toolName: "edit",
			input: {
				path: skillPath,
				edits: [{ oldText: "thing", newText: "job" }],
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks edit when the skill file changed after /skill:name injection", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const skillDir = join(cwd, "skills", "my-skill");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(
			skillPath,
			`---\nname: my-skill\ndescription: y\n---\nold body\n`,
			"utf8",
		);
		setMtimeMs(skillPath, 1_000_000);

		const prompt = `<skill name="my-skill" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\nold body\n</skill>`;
		await runner.emitBeforeAgentStart(prompt, undefined, "system prompt", {
			cwd,
		});

		// External change after the agent saw the old version.
		writeFileSync(
			skillPath,
			`---\nname: my-skill\ndescription: y\n---\nnew body\n`,
			"utf8",
		);
		setMtimeMs(skillPath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-skill",
			toolName: "edit",
			input: {
				path: skillPath,
				edits: [{ oldText: "new", newText: "x" }],
			},
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Read it again");
	});

	it("allows edit of a context file whose disk content matches systemPromptOptions", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const agentsPath = join(cwd, "AGENTS.md");
		writeFileSync(agentsPath, "# Agents\n\nrepo rules\n", "utf8");
		setMtimeMs(agentsPath, 1_000_000);

		await runner.emitBeforeAgentStart(
			"prompt",
			undefined,
			"system prompt",
			{
				cwd,
				contextFiles: [
					{ path: agentsPath, content: "# Agents\n\nrepo rules\n" },
				],
			},
		);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-agents",
			toolName: "edit",
			input: {
				path: agentsPath,
				edits: [{ oldText: "rules", newText: "more rules" }],
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks edit of a context file whose disk content diverged since session start", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const agentsPath = join(cwd, "AGENTS.md");
		writeFileSync(agentsPath, "stale\n", "utf8");
		setMtimeMs(agentsPath, 1_000_000);

		// The system prompt still holds the content loaded at session start.
		await runner.emitBeforeAgentStart(
			"prompt",
			undefined,
			"system prompt",
			{
				cwd,
				contextFiles: [
					{ path: agentsPath, content: "loaded at session start\n" },
				],
			},
		);

		writeFileSync(agentsPath, "changed externally\n", "utf8");
		setMtimeMs(agentsPath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-agents",
			toolName: "edit",
			input: {
				path: agentsPath,
				edits: [{ oldText: "changed", newText: "x" }],
			},
		});

		expect(result?.block).toBe(true);
	});

	it("stays consistent when a path-rewriting extension runs before it", async () => {
		// Sillajje-style extension: rewrites relative paths to a workspace root
		// by mutating the shared tool_call input. The guard must load AFTER it.
		const rewriterPath = join(makeRunnerCwd(), "rewriter.ts");
		writeFileSync(
			rewriterPath,
			`export default function (pi) {
				pi.on("tool_call", async (event) => {
					const input = event.input;
					if (typeof input.path === "string" && !input.path.startsWith("/")) {
						input.path = process.env.REWRITER_WORKSPACE + "/" + input.path;
					}
					return undefined;
				});
			};
		`,
			"utf8",
		);

		const cwd = makeRunnerCwd();
		process.env.REWRITER_WORKSPACE = cwd;
		const runner = await createRunner(cwd, [
			rewriterPath,
			resolve(import.meta.dirname, "../../src/index.ts"),
		]);

		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);
		writeFileSync(filePath, "initial\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		// A read rewritten to the workspace path, as the runtime delivers it.
		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: join(cwd, toolPath) },
			content: [{ type: "text", text: "initial" }],
			details: undefined,
			isError: false,
		});

		// The model sends the original relative path; the rewriter rewrites it
		// before the guard's tool_call handler sees it.
		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "initial", newText: "next" }],
			},
		});

		delete process.env.REWRITER_WORKSPACE;
		expect(result).toBeUndefined();
	});
});
