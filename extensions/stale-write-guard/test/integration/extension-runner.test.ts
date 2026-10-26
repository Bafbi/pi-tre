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

/** A truncated tool result, as pi reports it in `details`. */
function truncatedDetails() {
	return {
		truncation: {
			content: "line 1",
			truncated: true as const,
			truncatedBy: "lines" as const,
			totalLines: 3,
			totalBytes: 21,
			outputLines: 1,
			outputBytes: 7,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 1,
			maxBytes: 50 * 1024,
		},
	};
}

/**
 * Emit `before_agent_start` for a submitted user prompt.
 *
 * Pi 1.2.0 gives the runner a trigger object (`{ messageType, prompt }`)
 * instead of a bare prompt string. This wrapper keeps call sites focused on
 * the values under test.
 */
function emitUserPromptStart(
	runner: ExtensionRunner,
	prompt: string,
	systemPromptOptions: Parameters<ExtensionRunner["emitBeforeAgentStart"]>[1],
) {
	return runner.emitBeforeAgentStart(
		{ messageType: "user", prompt, images: undefined },
		systemPromptOptions,
	);
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

	it("dumps the full-read mtime and the write decision", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const dumpCommand = runner.getCommand("stale-write-guard-dump");
		if (!dumpCommand) throw new Error("Expected dump command");

		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);
		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-dump",
			toolName: "read",
			input: { path: toolPath },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		let output = "";
		const ctx = {
			hasUI: true,
			ui: {
				setEditorText: (text: string) => {
					output = text;
				},
			},
		} as unknown as Parameters<typeof dumpCommand.handler>[1];

		await dumpCommand.handler("", ctx);
		expect(output).toContain(filePath);
		expect(output).toContain("fullReadMtime:");
		expect(output).toContain("decision: ALLOW write");
		expect(output).toContain("reason: full read up to date");

		writeFileSync(filePath, "external\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		await dumpCommand.handler("", ctx);
		expect(output).toContain("decision: BLOCK write");
		expect(output).toContain("reason: file changed after last full read");
	});

	it("allows edit on existing file when no read record exists", async () => {
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

		expect(result).toBeUndefined();
	});

	it("blocks write when file changed externally after last agent write", async () => {
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
			toolCallId: "write-1",
			toolName: "write",
			input: {
				path: toolPath,
				content: "agent change\n",
			},
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("changed after your last full read");
		expect(result?.reason).toContain("content you have not seen");
	});

	it("allows write after a fresh full read of externally changed file", async () => {
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
			toolCallId: "write-2",
			toolName: "write",
			input: {
				path: toolPath,
				content: "agent change\n",
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks write after a partial read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "line 1\nline 2\nline 3\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-part",
			toolName: "read",
			input: { path: toolPath, offset: 1, limit: 1 },
			content: [{ type: "text", text: "line 1" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-part",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a truncated read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "line 1\nline 2\nline 3\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-truncated",
			toolName: "read",
			input: { path: toolPath },
			content: [{ type: "text", text: "line 1" }],
			details: truncatedDetails(),
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-truncated",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("allows write after the agent printed the whole file with bash cat", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello from bash\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-1",
			toolName: "bash",
			input: { command: `cat ${toolPath}` },
			content: [{ type: "text", text: "hello from bash" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-1",
			toolName: "write",
			input: {
				path: toolPath,
				content: "from bash\n",
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks write after a cat behind a cd segment", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		// The shell would read this file inside `sub`, not in the session cwd.
		// The guard must not record the cwd file just because its name matches.
		writeFileSync(filePath, "cwd file\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-cd-cat",
			toolName: "bash",
			input: { command: `cd sub && cat ${toolPath}` },
			content: [{ type: "text", text: "sub file" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-after-cd-cat",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a truncated bash cat", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-cat-truncated",
			toolName: "bash",
			input: { command: `cat ${toolPath}` },
			content: [{ type: "text", text: "hello" }],
			details: truncatedDetails(),
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-cat-truncated",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("records the literal @ operand, not the stripped path", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const atPath = "@note.txt";
		const plainPath = "note.txt";

		writeFileSync(join(cwd, atPath), "at file\n", "utf8");
		writeFileSync(join(cwd, plainPath), "plain file\n", "utf8");
		setMtimeMs(join(cwd, atPath), 1_000_000);
		setMtimeMs(join(cwd, plainPath), 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-at",
			toolName: "bash",
			input: { command: `cat '${atPath}'` },
			content: [{ type: "text", text: "at file" }],
			details: undefined,
			isError: false,
		});

		const plainWrite = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-plain",
			toolName: "write",
			input: { path: plainPath, content: "new\n" },
		});
		expect(plainWrite?.block).toBe(true);

		const atWrite = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-at",
			toolName: "write",
			input: { path: `./${atPath}`, content: "new\n" },
		});
		expect(atWrite).toBeUndefined();
	});

	it("allows a second write after a successful write", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "new.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "first\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "write-first",
			toolName: "write",
			input: { path: toolPath, content: "first\n" },
			content: [{ type: "text", text: "written" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-second",
			toolName: "write",
			input: { path: toolPath, content: "second\n" },
		});

		expect(result).toBeUndefined();
	});

	it("blocks write after an edit invalidates the full read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "before\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "read-before-edit",
			toolName: "read",
			input: { path: toolPath },
			content: [{ type: "text", text: "before" }],
			details: undefined,
			isError: false,
		});

		writeFileSync(filePath, "after\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "edit-after-read",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "before", newText: "after" }],
			},
			content: [{ type: "text", text: "edited" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-after-edit",
			toolName: "write",
			input: { path: toolPath, content: "rewritten\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write when the file changed after the bash cat", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-1",
			toolName: "bash",
			input: { command: `cat ${toolPath}` },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		writeFileSync(filePath, "external change\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-1",
			toolName: "write",
			input: {
				path: toolPath,
				content: "external change\n",
			},
		});

		expect(result?.block).toBe(true);
	});

	it("does not record a full read from a piped bash command", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-1",
			toolName: "bash",
			input: { command: `cat ${toolPath} | head` },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-1",
			toolName: "write",
			input: {
				path: toolPath,
				content: "agent change\n",
			},
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a sed read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-sed",
			toolName: "bash",
			input: { command: `sed -n '1,10p' ${toolPath}` },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-sed",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a head read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-head",
			toolName: "bash",
			input: { command: `head -n 5 ${toolPath}` },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-head",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a grep read", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-grep",
			toolName: "bash",
			input: { command: `grep hello ${toolPath}` },
			content: [{ type: "text", text: "hello" }],
			details: undefined,
			isError: false,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-grep",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
	});

	it("blocks write after a jj or git diff", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		for (const command of ["jj diff", "git diff"]) {
			await runner.emitToolResult({
				type: "tool_result",
				toolCallId: `bash-${command}`,
				toolName: "bash",
				input: { command },
				content: [{ type: "text", text: "diff --git a/note.txt" }],
				details: undefined,
				isError: false,
			});
		}

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-diff",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
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

	it("names the read tool and the edit alternative when write blocks", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-unread",
			toolName: "write",
			input: { path: toolPath, content: "new\n" },
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("No full read");
		expect(result?.reason).toContain("partial read");
		expect(result?.reason).toContain("cat with flags");
		expect(result?.reason).toContain("head/tail/sed/grep/rg");
		expect(result?.reason).toContain("pipe");
		expect(result?.reason).toContain("path after a cd");
		expect(result?.reason).toContain("read tool");
		expect(result?.reason).toContain("no offset/limit");
		expect(result?.reason).toContain("edit");
	});

	it("allows edit after a bash write", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const toolPath = "note.txt";
		const filePath = join(cwd, toolPath);

		writeFileSync(filePath, "hello\n", "utf8");
		setMtimeMs(filePath, 1_000_000);

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "bash-python",
			toolName: "bash",
			input: {
				command: `python3 - <<'EOF'\nopen('${toolPath}', 'w').write('changed\\n')\nEOF`,
			},
			content: [{ type: "text", text: "" }],
			details: undefined,
			isError: false,
		});

		writeFileSync(filePath, "changed\n", "utf8");
		setMtimeMs(filePath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "edit-after-bash",
			toolName: "edit",
			input: {
				path: toolPath,
				edits: [{ oldText: "changed", newText: "agent" }],
			},
		});

		expect(result).toBeUndefined();
	});

	it("allows write after /skill:name injection recorded in before_agent_start", async () => {
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
		await emitUserPromptStart(runner, prompt, {
			cwd,
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-skill",
			toolName: "write",
			input: {
				path: skillPath,
				content: "agent body\n",
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks write when the skill file changed after /skill:name injection", async () => {
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
		await emitUserPromptStart(runner, prompt, {
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
			toolCallId: "write-skill",
			toolName: "write",
			input: {
				path: skillPath,
				content: "agent body\n",
			},
		});

		expect(result?.block).toBe(true);
	});

	it("allows write of a context file whose disk content matches systemPromptOptions", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const agentsPath = join(cwd, "AGENTS.md");
		writeFileSync(agentsPath, "# Agents\n\nrepo rules\n", "utf8");
		setMtimeMs(agentsPath, 1_000_000);

		await emitUserPromptStart(runner, "prompt", {
			cwd,
			contextFiles: [
				{ path: agentsPath, content: "# Agents\n\nrepo rules\n" },
			],
		});

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-agents",
			toolName: "write",
			input: {
				path: agentsPath,
				content: "# Agents\n\nmore rules\n",
			},
		});

		expect(result).toBeUndefined();
	});

	it("blocks write of a context file whose disk content diverged since session start", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const agentsPath = join(cwd, "AGENTS.md");
		writeFileSync(agentsPath, "stale\n", "utf8");
		setMtimeMs(agentsPath, 1_000_000);

		// The system prompt still holds the content loaded at session start.
		await emitUserPromptStart(runner, "prompt", {
			cwd,
			contextFiles: [
				{ path: agentsPath, content: "loaded at session start\n" },
			],
		});

		writeFileSync(agentsPath, "changed externally\n", "utf8");
		setMtimeMs(agentsPath, 2_000_000);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-agents",
			toolName: "write",
			input: {
				path: agentsPath,
				content: "agent content\n",
			},
		});

		expect(result?.block).toBe(true);
	});

	it("allows write for a context file recorded on a custom-message run", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);
		const agentsPath = join(cwd, "AGENTS.md");
		writeFileSync(agentsPath, "# Agents\n\nrepo rules\n", "utf8");
		setMtimeMs(agentsPath, 1_000_000);

		await runner.emitBeforeAgentStart(
			{
				messageType: "custom",
				message: {
					role: "custom",
					customType: "test/custom",
					content: "started by sendMessage",
					display: true,
					timestamp: Date.now(),
				},
			},
			{
				cwd,
				contextFiles: [
					{ path: agentsPath, content: "# Agents\n\nrepo rules\n" },
				],
			},
		);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-agents-custom",
			toolName: "write",
			input: {
				path: agentsPath,
				content: "# Agents\n\nmore rules\n",
			},
		});

		expect(result).toBeUndefined();
	});

	it("does not record a skill block carried by a custom message", async () => {
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

		// A custom run carries `message`, not `prompt`. A skill-shaped block in
		// the message body is not a `/skill:name` expansion, so the guard must
		// not record it as seen.
		const skillBlock = `<skill name="my-skill" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\n${body}\n</skill>`;
		await runner.emitBeforeAgentStart(
			{
				messageType: "custom",
				message: {
					role: "custom",
					customType: "test/custom",
					content: skillBlock,
					display: true,
					timestamp: Date.now(),
				},
			},
			{ cwd },
		);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "write-skill-custom",
			toolName: "write",
			input: {
				path: skillPath,
				content: "agent body\n",
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
			toolCallId: "write-1",
			toolName: "write",
			input: {
				path: toolPath,
				content: "next\n",
			},
		});

		delete process.env.REWRITER_WORKSPACE;
		expect(result).toBeUndefined();
	});
});
