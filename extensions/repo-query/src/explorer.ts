import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	type AgentToolResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import type { ParsedRepo } from "./types.js";

const SUBAGENT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 8000;

function truncateSubagentOutput(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}...\n[Answer truncated]`
		: text;
}

interface Message {
	role: string;
	content: Array<{ type: string; text: string }>;
}

interface SubagentOptions {
	workspace: string;
	repos: ParsedRepo[];
	query: string;
	model?: string;
	signal: AbortSignal | undefined;
	onUpdate?: (
		partial: AgentToolResult<{ answer: string; thought?: string }>,
	) => void;
}

interface ExplorationResult {
	answer: string;
	error?: string;
}

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

const TEST_REGISTRY_KEY = "__repoQueryExplorerMock";

function getMockExplorer():
	| ((options: SubagentOptions) => Promise<ExplorationResult>)
	| undefined {
	return (globalThis as Record<string, unknown>)[TEST_REGISTRY_KEY] as
		| ((options: SubagentOptions) => Promise<ExplorationResult>)
		| undefined;
}

/** Test-only: inject a mock implementation for runExplorer. */
export function setTestExplorerImpl(
	impl:
		| ((options: SubagentOptions) => Promise<ExplorationResult>)
		| undefined,
): void {
	(globalThis as Record<string, unknown>)[TEST_REGISTRY_KEY] = impl;
}

/**
 * Spawn a pi subagent to explore the cloned repositories and answer the query.
 *
 * For a single repo, the subagent's cwd is the repo directory.
 * For multiple repos, the subagent's cwd is the workspace parent.
 */
export async function runExplorer(
	options: SubagentOptions,
): Promise<ExplorationResult> {
	const mock = getMockExplorer();
	if (mock) {
		return mock(options);
	}

	const { workspace, repos, query, model, signal, onUpdate } = options;
	const isSingle = repos.length === 1;
	const cwd = isSingle ? join(workspace, repos[0].dirName) : workspace;

	const systemPrompt = buildSystemPrompt(repos, query, isSingle);

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		"read,grep,find,ls,bash",
	];

	if (model) {
		args.push("--model", model);
	}

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
	let answerText = "";
	let thinkingText = "";
	let errorMessage = "";
	let wasAborted = false;

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(
				invocation.command,
				[...invocation.args, ...args],
				{
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			// Append text without duplicating when the same full text arrives
			// from both text_delta (incremental or full) and message_end (full).
			const safeAppendText = (text: string, eventKind?: string) => {
				if (!text) return;
				if (eventKind === "full") {
					if (answerText === text) return;
					if (
						text.startsWith(answerText) &&
						text.length > answerText.length
					) {
						answerText = text;
						return;
					}
					// Provider may have rewritten the final message; replace rather than append
					answerText = text;
					return;
				}
				answerText += text;
			};
			const safeAppendThinking = (text: string, eventKind?: string) => {
				if (!text) return;
				if (eventKind === "full") {
					if (thinkingText === text) return;
					if (
						text.startsWith(thinkingText) &&
						text.length > thinkingText.length
					) {
						thinkingText = text;
						return;
					}
					// Provider may have rewritten the final message; replace rather than append
					thinkingText = text;
					return;
				}
				thinkingText += text;
			};
			const emitUpdate = () => {
				onUpdate?.({
					content: [
						{ type: "text", text: answerText || "(exploring...)" },
					],
					details: { answer: answerText, thought: thinkingText },
				});
			};

			let timeoutFired = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;

			const clearTimers = () => {
				clearTimeout(timeoutId);
				if (graceTimer) clearTimeout(graceTimer);
			};

			const timeoutId = setTimeout(() => {
				timeoutFired = true;
				proc.kill("SIGTERM");
				graceTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, SUBAGENT_TIMEOUT_MS);

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					processSubagentLine(
						line,
						(text, kind) => {
							safeAppendText(text, kind);
							emitUpdate();
						},
						(text, kind) => {
							safeAppendThinking(text, kind);
							emitUpdate();
						},
					);
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				errorMessage += data.toString();
			});

			proc.on("close", (code) => {
				clearTimers();
				if (buffer.trim()) {
					processSubagentLine(
						buffer,
						(text, kind) => {
							safeAppendText(text, kind);
						},
						(text, kind) => {
							safeAppendThinking(text, kind);
						},
					);
				}
				if (timeoutFired) {
					reject(
						new TimeoutError(
							`Subagent timed out after ${SUBAGENT_TIMEOUT_MS} ms`,
						),
					);
				} else {
					resolve(code ?? 0);
				}
			});

			proc.on("error", () => {
				clearTimers();
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					clearTimers();
					proc.kill("SIGTERM");
					graceTimer = setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (wasAborted && !answerText) {
			return {
				answer: "",
				error: `Exploration aborted. ${errorMessage || ""}`.trim(),
			};
		}

		if (exitCode !== 0 && !answerText) {
			return {
				answer: "",
				error: `Exploration failed (exit ${exitCode}). ${errorMessage || ""}`.trim(),
			};
		}

		return { answer: truncateSubagentOutput(answerText) };
	} catch (err) {
		if (err instanceof TimeoutError) {
			return {
				answer: truncateSubagentOutput(answerText),
				error: err.message,
			};
		}
		return {
			answer: truncateSubagentOutput(answerText),
			error: `Exploration failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		// Cleanup temp prompt file
		try {
			await rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup errors */
		}
	}
}

/** @internal exported for unit testing */
export function processSubagentLine(
	line: string,
	onAnswer: (text: string, kind?: string) => void,
	onThinking: (thinking: string, kind?: string) => void,
): void {
	if (!line.trim()) return;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (!isObject(event)) return;

	// Accumulate text from message_update events (streaming deltas)
	if (event.type === "message_update" && hasAssistantMessageEvent(event)) {
		const ame = event.assistantMessageEvent as AssistantMessageEvent;
		if (ame.type === "text_delta" && typeof ame.delta === "string") {
			onAnswer(ame.delta);
		} else if (
			ame.type === "thinking_delta" &&
			typeof ame.delta === "string"
		) {
			onThinking(ame.delta);
		}
	}

	// Final message — capture complete text
	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const rawPart of msg.content) {
				const part = rawPart as unknown;
				if (
					isObject(part) &&
					typeof part.type === "string" &&
					part.type === "text" &&
					typeof part.text === "string"
				) {
					onAnswer(part.text, "full");
				}
			}
		}
	}
}

type AssistantMessageEvent = { type: string; delta?: string };

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function hasAssistantMessageEvent(event: Record<string, unknown>): boolean {
	return (
		event.assistantMessageEvent !== undefined &&
		isObject(event.assistantMessageEvent) &&
		typeof (event.assistantMessageEvent as Record<string, unknown>).type ===
			"string"
	);
}

function getPiInvocation(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: [] };
	}

	return { command: "pi", args: [] };
}

function buildSystemPrompt(
	repos: ParsedRepo[],
	query: string,
	isSingle: boolean,
): string {
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

	const repoList = repos
		.map((r) => `- ${r.displayName} (in ./${r.dirName})`)
		.join("\n");
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
