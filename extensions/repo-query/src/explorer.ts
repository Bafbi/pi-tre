import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	createProcessBackend,
	createSafeAccumulator,
	type ProcessSpawnFn,
	runSubagent,
	type SubagentEvent,
	zeroUsage,
} from "@pi-tre/pi-subagent";

import type { ParsedRepo, SubagentUsage } from "./types.js";

const SUBAGENT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 8000;

const ABORT_NOTICE = "[Exploration aborted before completion.]";

/** Read-only toolset the exploration subagent may use. */
const EXPLORER_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** Child-process surface, re-exported under the historical names. */
export type {
	ProcessBackendSpawn as ExplorerProcess,
	ProcessSpawnFn as SpawnFunction,
} from "@pi-tre/pi-subagent";

function truncateSubagentOutput(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}...\n[Answer truncated]`
		: text;
}

export interface SubagentOptions {
	tempspace: string;
	repos: ParsedRepo[];
	query: string;
	model?: string | undefined;
	signal: AbortSignal | undefined;
	onUpdate?:
		| ((
				partial: AgentToolResult<{ answer: string; thought?: string }>,
		  ) => void)
		| undefined;
}

export interface ExplorationResult {
	answer: string;
	error?: string;
	usage?: SubagentUsage;
}

/**
 * Injection seams for runExplorer.
 * - `run` replaces runExplorer entirely (extension factory test overrides).
 * - `spawn` and `killGraceMs` support unit tests of the kill/abort paths.
 */
export interface ExplorerImpl {
	run?: (options: SubagentOptions) => Promise<ExplorationResult>;
	spawn?: ProcessSpawnFn;
	killGraceMs?: number;
}

/**
 * Spawn a pi subagent to explore the cloned repositories and answer the query.
 *
 * For a single repo, the subagent's cwd is the repo directory.
 * For multiple repos, the subagent's cwd is the tempspace parent.
 *
 * The child-process lifecycle (spawn, timeout, SIGTERM→SIGKILL escalation,
 * abort, JSON-lines parsing, usage accumulation) lives in the
 * `@pi-tre/pi-subagent` process backend; this function keeps the
 * exploration policy: prompt building, live streaming, the
 * partial-answer-on-abort notice, answer truncation, and error
 * classification.
 */
export async function runExplorer(
	options: SubagentOptions,
	impl?: ExplorerImpl,
): Promise<ExplorationResult> {
	if (impl?.run) {
		return impl.run(options);
	}

	const { tempspace, repos, query, model, signal, onUpdate } = options;
	const isSingle = repos.length === 1;
	const firstRepo = repos[0];
	const cwd =
		isSingle && firstRepo !== undefined
			? join(tempspace, firstRepo.dirName)
			: tempspace;

	const backend = createProcessBackend({
		spawn: impl?.spawn,
		killGraceMs: impl?.killGraceMs,
	});

	const session = runSubagent(
		{
			prompt: `Task: ${query}`,
			systemPrompt: buildSystemPrompt(repos, query, isSingle),
			cwd,
			model,
			tools: EXPLORER_TOOLS,
			signal,
			timeoutMs: SUBAGENT_TIMEOUT_MS,
		},
		backend,
	);

	// Accumulators shared by the delta and full-text events. See
	// createSafeAccumulator for the dedup rules.
	const answer = createSafeAccumulator();
	const thinking = createSafeAccumulator();

	const usage: SubagentUsage = zeroUsage();
	let llmErrorMessage = "";
	let exit: Extract<SubagentEvent, { type: "exit" }> | undefined;

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: answer.get() || "(exploring...)" }],
			details: { answer: answer.get(), thought: thinking.get() },
		});
	};

	try {
		for await (const event of session.events) {
			switch (event.type) {
				case "text":
					answer.append(event.text, event.kind);
					emitUpdate();
					break;
				case "thinking":
					thinking.append(event.text, event.kind);
					emitUpdate();
					break;
				case "usage":
					Object.assign(usage, event.usage);
					break;
				case "error":
					llmErrorMessage = event.message;
					break;
				case "exit":
					exit = event;
					break;
				case "stopReason":
					break;
			}
		}
	} catch (err) {
		return {
			answer: truncateSubagentOutput(answer.get()),
			error: `Exploration failed: ${err instanceof Error ? err.message : String(err)}`,
			usage,
		};
	}

	if (!exit) {
		return {
			answer: truncateSubagentOutput(answer.get()),
			error: "Exploration failed: subagent ended without an exit event",
			usage,
		};
	}

	if (exit.overflow) {
		return {
			answer: truncateSubagentOutput(answer.get()),
			error: "Exploration failed: subagent output exceeded the byte cap",
			usage,
		};
	}

	if (llmErrorMessage) {
		return {
			answer: "",
			error: `Subagent LLM error: ${llmErrorMessage}`,
			usage,
		};
	}

	if (exit.spawnError && !answer.get()) {
		return {
			answer: "",
			error: `Exploration failed: ${exit.spawnError}`,
			usage,
		};
	}

	if (exit.aborted) {
		if (!answer.get()) {
			return {
				answer: "",
				error: `Exploration aborted. ${exit.stderr || ""}`.trim(),
				usage,
			};
		}
		// Keep the partial answer, but make clear it is incomplete.
		return {
			answer: `${truncateSubagentOutput(answer.get())}\n${ABORT_NOTICE}`,
			usage,
		};
	}

	if (exit.timedOut) {
		// The subagent ignored SIGTERM and SIGKILL.
		return {
			answer: truncateSubagentOutput(answer.get()),
			error: `Subagent timed out after ${SUBAGENT_TIMEOUT_MS} ms`,
			usage,
		};
	}

	if (exit.code !== 0 && !answer.get()) {
		return {
			answer: "",
			error: `Exploration failed (exit ${exit.code}). ${exit.stderr || ""}`.trim(),
			usage,
		};
	}

	return { answer: truncateSubagentOutput(answer.get()), usage };
}

function buildSystemPrompt(
	repos: ParsedRepo[],
	query: string,
	isSingle: boolean,
): string {
	if (isSingle) {
		const repo = repos[0];
		if (repo === undefined) {
			return "You are a senior code exploration agent.";
		}
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
	return `You are a senior code exploration agent. You are in a tempspace containing multiple repositories:

${repoList}

Your task: answer this query by exploring across all repositories. You may find cross-repo references, shared patterns, or divergent implementations.

Process:
1. Use \`ls\` and \`find\` to understand the tempspace structure
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
