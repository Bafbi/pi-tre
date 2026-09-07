import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	type AgentToolResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import type { ParsedRepo, SubagentUsage } from "./types.js";

const SUBAGENT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_CHARS = 8000;

const ABORT_NOTICE = "[Exploration aborted before completion.]";

function truncateSubagentOutput(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}...\n[Answer truncated]`
		: text;
}

/**
 * Append-only text accumulator shared by text_delta (incremental) and
 * message_end (full) events. A "full" event is kept as-is unless it is the
 * same text already accumulated or an extension of it; anything else means
 * the provider rewrote the final message, so it replaces the value instead
 * of appending.
 */
function createSafeAccumulator(): {
	append: (text: string, eventKind?: string) => void;
	get: () => string;
} {
	let value = "";
	return {
		get: () => value,
		append: (text, eventKind) => {
			if (!text) return;
			if (eventKind === "full") {
				if (value === text) return;
				if (text.startsWith(value) && text.length > value.length) {
					value = text;
					return;
				}
				value = text;
				return;
			}
			value += text;
		},
	};
}

interface Message {
	role: string;
	content: Array<{ type: string; text: string }>;
	usage?: Record<string, unknown>;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

/** Parsed fields from a subagent assistant message at message_end. */
export interface SubagentMessageInfo {
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

export interface SubagentOptions {
	workspace: string;
	repos: ParsedRepo[];
	query: string;
	model?: string;
	signal: AbortSignal | undefined;
	onUpdate?: (
		partial: AgentToolResult<{ answer: string; thought?: string }>,
	) => void;
}

export interface ExplorationResult {
	answer: string;
	error?: string;
	usage?: SubagentUsage;
}

/** Minimal child-process surface runExplorer needs. A subset of ChildProcess. */
export interface ExplorerProcess {
	killed: boolean;
	stdout: { on(event: "data", cb: (data: Buffer) => void): unknown };
	stderr: { on(event: "data", cb: (data: Buffer) => void): unknown };
	on(event: "close", cb: (code: number | null) => void): unknown;
	on(event: "error", cb: (err: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFunction = (
	command: string,
	args: string[],
	opts: { cwd: string },
) => ExplorerProcess;

/**
 * Injection seams for runExplorer.
 * - `run` replaces runExplorer entirely (extension factory test overrides).
 * - `spawn` and `killGraceMs` support unit tests of the kill/abort paths.
 */
export interface ExplorerImpl {
	run?: (options: SubagentOptions) => Promise<ExplorationResult>;
	spawn?: SpawnFunction;
	killGraceMs?: number;
}

/**
 * Spawn a pi subagent to explore the cloned repositories and answer the query.
 *
 * For a single repo, the subagent's cwd is the repo directory.
 * For multiple repos, the subagent's cwd is the workspace parent.
 */
export async function runExplorer(
	options: SubagentOptions,
	impl?: ExplorerImpl,
): Promise<ExplorationResult> {
	if (impl?.run) {
		return impl.run(options);
	}

	const { workspace, repos, query, model, signal, onUpdate } = options;
	const isSingle = repos.length === 1;
	const cwd = isSingle ? join(workspace, repos[0].dirName) : workspace;
	const childSpawn = impl?.spawn ?? defaultSpawn;
	const killGraceMs = impl?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

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
	let errorMessage = "";
	let spawnErrorMessage = "";
	let wasAborted = false;
	let llmErrorMessage = "";
	const usage: SubagentUsage = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		totalTokens: 0,
	};

	const handleAssistantMessage = (info: SubagentMessageInfo): void => {
		usage.turns++;
		if (info.usage) {
			usage.input += info.usage.input ?? 0;
			usage.output += info.usage.output ?? 0;
			usage.cacheRead += info.usage.cacheRead ?? 0;
			usage.cacheWrite += info.usage.cacheWrite ?? 0;
			usage.cost += info.usage.cost?.total ?? 0;
			usage.totalTokens += info.usage.totalTokens ?? 0;
		}
		if (info.stopReason === "error") {
			llmErrorMessage = info.errorMessage || "unknown subagent LLM error";
		}
	};

	// Accumulators shared by the delta and full-text events. See
	// createSafeAccumulator for the dedup rules.
	const answer = createSafeAccumulator();
	const thinking = createSafeAccumulator();

	const handleLine = (line: string, emit: boolean) => {
		processSubagentLine(
			line,
			(text, kind) => {
				answer.append(text, kind);
				if (emit) emitUpdate();
			},
			(text, kind) => {
				thinking.append(text, kind);
				if (emit) emitUpdate();
			},
			handleAssistantMessage,
		);
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: answer.get() || "(exploring...)" }],
			details: { answer: answer.get(), thought: thinking.get() },
		});
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = childSpawn(
				invocation.command,
				[...invocation.args, ...args],
				{ cwd },
			);

			let didExit = false;
			let timeoutFired = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;

			const clearTimers = () => {
				clearTimeout(timeoutId);
				if (graceTimer) clearTimeout(graceTimer);
			};

			// Send SIGTERM, then SIGKILL if the process is still alive after
			// the grace period. Checks the exit flag, not proc.killed — killed
			// is true the moment SIGTERM is sent.
			const killWithEscalation = () => {
				proc.kill("SIGTERM");
				graceTimer = setTimeout(() => {
					if (!didExit) proc.kill("SIGKILL");
				}, killGraceMs);
			};

			const timeoutId = setTimeout(() => {
				timeoutFired = true;
				killWithEscalation();
			}, SUBAGENT_TIMEOUT_MS);

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					handleLine(line, true);
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				errorMessage += data.toString();
			});

			let removeAbortListener = () => {};

			proc.on("close", (code) => {
				didExit = true;
				clearTimers();
				removeAbortListener();
				if (buffer.trim()) {
					handleLine(buffer, false);
				}
				if (timeoutFired) {
					resolve(-1);
				} else {
					resolve(code ?? 0);
				}
			});

			proc.on("error", (err) => {
				didExit = true;
				clearTimers();
				removeAbortListener();
				spawnErrorMessage = err.message;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					clearTimers();
					killWithEscalation();
				};
				if (signal.aborted) {
					killProc();
				} else {
					signal.addEventListener("abort", killProc, { once: true });
					removeAbortListener = () =>
						signal.removeEventListener("abort", killProc);
				}
			}
		});

		if (llmErrorMessage) {
			return {
				answer: "",
				error: `Subagent LLM error: ${llmErrorMessage}`,
				usage,
			};
		}

		if (spawnErrorMessage && !answer.get()) {
			return {
				answer: "",
				error: `Exploration failed: ${spawnErrorMessage}`,
				usage,
			};
		}

		if (wasAborted) {
			if (!answer.get()) {
				return {
					answer: "",
					error: `Exploration aborted. ${errorMessage || ""}`.trim(),
					usage,
				};
			}
			// Keep the partial answer, but make clear it is incomplete.
			return {
				answer: `${truncateSubagentOutput(answer.get())}\n${ABORT_NOTICE}`,
				usage,
			};
		}

		if (exitCode === -1) {
			// timeoutFired — the subagent ignored SIGTERM and SIGKILL.
			return {
				answer: truncateSubagentOutput(answer.get()),
				error: `Subagent timed out after ${SUBAGENT_TIMEOUT_MS} ms`,
				usage,
			};
		}

		if (exitCode !== 0 && !answer.get()) {
			return {
				answer: "",
				error: `Exploration failed (exit ${exitCode}). ${errorMessage || ""}`.trim(),
				usage,
			};
		}

		return { answer: truncateSubagentOutput(answer.get()), usage };
	} catch (err) {
		return {
			answer: truncateSubagentOutput(answer.get()),
			error: `Exploration failed: ${err instanceof Error ? err.message : String(err)}`,
			usage,
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
	onAssistantMessage?: (info: SubagentMessageInfo) => void,
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

	// Final message — capture complete text, usage, and stop reason
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
			if (onAssistantMessage) {
				onAssistantMessage({
					usage: isObject(msg.usage) ? msg.usage : undefined,
					stopReason:
						typeof msg.stopReason === "string"
							? msg.stopReason
							: undefined,
					errorMessage:
						typeof msg.errorMessage === "string"
							? msg.errorMessage
							: undefined,
					model:
						typeof msg.model === "string" ? msg.model : undefined,
				});
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

function defaultSpawn(
	command: string,
	args: string[],
	opts: { cwd: string },
): ExplorerProcess {
	return nodeSpawn(command, args, {
		cwd: opts.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function getPiInvocation(): { command: string; args: string[] } {
	// Under vitest, process.argv[1] is the test runner's entry, not pi.
	// Spawn the pi binary from PATH so LLM-backed tests exercise the real
	// subagent.
	if (process.env.VITEST) {
		return { command: "pi", args: [] };
	}

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
