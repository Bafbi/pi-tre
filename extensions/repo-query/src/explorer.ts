import { spawn } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentToolResult, withFileMutationQueue } from "@mariozechner/pi-coding-agent";

import type { ParsedRepo } from "./types.js";

const SUBAGENT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 4000;

interface Message {
	role: string;
	content: Array<{ type: string; text: string }>;
}

interface SubagentOptions {
	workspace: string;
	repos: ParsedRepo[];
	query: string;
	signal: AbortSignal | undefined;
	onUpdate?: (partial: AgentToolResult<{ answer: string }>) => void;
}

interface ExplorationResult {
	answer: string;
	error?: string;
}

/**
 * Spawn a pi subagent to explore the cloned repositories and answer the query.
 *
 * For a single repo, the subagent's cwd is the repo directory.
 * For multiple repos, the subagent's cwd is the workspace parent.
 */
export async function runExplorer(options: SubagentOptions): Promise<ExplorationResult> {
	const { workspace, repos, query, signal, onUpdate } = options;
	const isSingle = repos.length === 1;
	const cwd = isSingle ? join(workspace, repos[0].dirName) : workspace;

	const systemPrompt = buildSystemPrompt(repos, query, isSingle);

	const args = ["--mode", "json", "-p", "--no-session", "--tools", "read,grep,find,ls,bash", "--cwd", cwd];

	// Write system prompt to temp file
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-rq-agent-"));
	const promptFile = join(tmpDir, "system-prompt.md");
	await withFileMutationQueue(promptFile, async () => {
		await writeFile(promptFile, systemPrompt, "utf-8");
	});
	args.push("--append-system-prompt", promptFile);

	args.push(`Task: ${query}`);

	const invocation = getPiInvocation();
	let buffer = "";
	let finalAnswer = "";
	let errorMessage = "";

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, [...invocation.args, ...args], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let wasAborted = false;

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					processSubagentLine(line, (text) => {
						finalAnswer = text;
						onUpdate?.({
							content: [{ type: "text", text: text || "(exploring...)" }],
							details: { answer: text },
						});
					});
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				errorMessage += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					processSubagentLine(buffer, (text) => {
						finalAnswer = text;
					});
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (exitCode !== 0 && !finalAnswer) {
			return {
				answer: "",
				error: `Exploration failed (exit ${exitCode}). ${errorMessage || ""}`.trim(),
			};
		}

		// Truncate if needed
		const answer =
			finalAnswer.length > MAX_OUTPUT_CHARS
				? `${finalAnswer.slice(0, MAX_OUTPUT_CHARS)}...\n[Answer truncated]`
				: finalAnswer;

		return { answer };
	} finally {
		// Cleanup temp prompt file
		try {
			await unlink(promptFile);
			await rmdir(tmpDir);
		} catch {
			/* ignore cleanup errors */
		}
	}
}

function processSubagentLine(line: string, onAnswer: (text: string) => void): void {
	if (!line.trim()) return;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (isMessageEndEvent(event) && event.message) {
		const msg = event.message as Message;
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					onAnswer(part.text);
				}
			}
		}
	}
}

interface MessageEndEvent {
	type: "message_end";
	message?: unknown;
}

function isMessageEndEvent(event: unknown): event is MessageEndEvent {
	return typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "message_end";
}

function getPiInvocation(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtual) {
		try {
			// Use the same pi binary
			return { command: process.execPath, args: [currentScript] };
		} catch {
			/* fall through */
		}
	}

	return { command: "pi", args: [] };
}

function buildSystemPrompt(repos: ParsedRepo[], query: string, isSingle: boolean): string {
	if (isSingle) {
		const repo = repos[0];
		return `You are a senior code exploration agent. You are in the root of the "${repo.displayName}" repository.

Your task: answer this query using only the code in this repository.

Process:
1. Use \`find\` and \`ls\` to understand repository structure
2. Use \`grep\` to search for relevant terms, patterns, or symbols
3. Use \`read\` with \`offset\` and \`limit\` to read specific file sections
4. Never read entire files larger than 100 lines — read relevant chunks

Output requirements:
- Provide a synthesized answer with specific file paths and line numbers
- If you cannot find the answer, state this clearly
- Maximum 800 words
- Do NOT make assumptions beyond the code you have read

Query: ${query}`;
	}

	const repoList = repos.map((r) => `- ${r.displayName} (in ./${r.dirName})`).join("\n");
	return `You are a senior code exploration agent. You are in a workspace containing multiple repositories:

${repoList}

Your task: answer this query by exploring across all repositories. You may find cross-repo references, shared patterns, or divergent implementations.

Process:
1. Use \`ls\` and \`find\` to understand the workspace structure
2. Use \`grep\` with paths like \`./repo-name/...\` to search within specific repos
3. Use \`read\` with \`offset\` and \`limit\` to read specific file sections
4. Compare and contrast findings across repositories

Output requirements:
- Provide a synthesized answer with specific file paths and line numbers
- Note cross-repo similarities or differences when relevant
- If you cannot find the answer, state this clearly
- Maximum 1000 words
- Do NOT make assumptions beyond the code you have read

Query: ${query}`;
}
