import { join } from "node:path";

import type {
	AgentToolResult,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import {
	type ExplorationResult,
	findingsInstructions,
	MAX_OUTPUT_CHARS,
	truncateSubagentOutput,
} from "./explorer.js";
import type { ParsedRepo } from "./types.js";

/** T3 exposes its orchestrator tools to pi under this prefix. */
export const T3_DELEGATE_TOOL = "mcp__t3-code__delegate_task";

const DELEGATE_TIMEOUT_MS = 300_000;

/** True when T3's delegate tool is registered and callable. */
export function canUseT3Delegate(
	ctx: Pick<ExtensionToolContext, "tools">,
): boolean {
	return ctx.tools.some((tool) => tool.name === T3_DELEGATE_TOOL);
}

export interface T3DelegateOptions {
	tempspace: string;
	repos: ParsedRepo[];
	query: string;
	signal: AbortSignal | undefined;
}

/**
 * Explore the clones through a T3 delegate instead of a child pi process.
 *
 * The delegate is a real T3 thread, so it appears in the UI. It reads the
 * clones by absolute path because its working directory is the T3 project,
 * not the tempspace. T3 does not enforce a read-only toolset for delegates:
 * this asks for read-only behavior and lowers the runtime mode so edits need
 * approval.
 */
export async function runT3Delegate(
	options: T3DelegateOptions,
	ctx: Pick<ExtensionToolContext, "executeTool">,
): Promise<ExplorationResult> {
	const { tempspace, repos, query, signal } = options;
	const clonePaths = repos.map((repo) => ({
		displayName: repo.displayName,
		path: join(tempspace, repo.dirName),
	}));

	type ExecuteToolOutcome = Awaited<
		ReturnType<ExtensionToolContext["executeTool"]>
	>;
	let outcome: ExecuteToolOutcome;
	try {
		outcome = await ctx.executeTool(
			T3_DELEGATE_TOOL,
			{
				task: buildDelegateTask(query, clonePaths),
				title: `repo_query: ${repos
					.map((repo) => repo.displayName)
					.join(", ")
					.slice(0, 80)}`,
				role: "research",
				mode: "wait",
				timeoutMs: DELEGATE_TIMEOUT_MS,
				isolation: "shared",
				// Full access avoids a prompt on every codemode call. T3 has no
				// per-delegate tool allowlist, so the task prompt restricts
				// codemode to the read-only tools. T3 rejects this mode when the
				// parent is lower; the caller falls back to the process backend.
				runtimeMode: "full-access",
			},
			{ ...(signal !== undefined ? { signal } : {}) },
		);
	} catch (err) {
		if (signal?.aborted) {
			return { answer: "", error: "T3 delegate aborted." };
		}
		return {
			answer: "",
			error: `T3 delegate failed: ${errorMessage(err)}`,
		};
	}

	const delegate = delegateResult(outcome.result);
	if (outcome.isError || delegate.isError) {
		return {
			answer: "",
			error: `T3 delegate failed: ${delegate.summary || "unknown error"}`,
		};
	}
	if (delegate.pending) {
		return {
			answer: "",
			error: [
				"The T3 delegate is waiting for an answer or approval.",
				delegate.link ? `Open the thread: ${delegate.link}` : "",
				"The exploration is visible in T3 Code and keeps running.",
			]
				.filter((part) => part.length > 0)
				.join(" "),
		};
	}
	if (delegate.timedOut) {
		return {
			answer: "",
			error: [
				`The T3 delegate did not finish within ${DELEGATE_TIMEOUT_MS / 1000} seconds.`,
				delegate.link ? `Open the thread: ${delegate.link}` : "",
				"The exploration keeps running in T3 Code.",
			]
				.filter((part) => part.length > 0)
				.join(" "),
		};
	}
	if (!delegate.summary) {
		return {
			answer: "",
			error: "The T3 delegate finished without a summary.",
		};
	}

	// The delegate thread already streamed its progress in the UI. Only the
	// final summary reaches the parent tool result.
	return {
		answer: truncateSubagentOutput(delegate.summary),
		complete: delegate.summary.length <= MAX_OUTPUT_CHARS,
	};
}

interface DelegateReading {
	summary: string;
	link: string;
	pending: boolean;
	timedOut: boolean;
	isError: boolean;
}

/**
 * Read the fields T3 returns from `delegate_task`.
 *
 * T3 registers its MCP tools through a bridge, so the tool result is nested:
 * the outer `structuredContent` is the MCP result, and the orchestrator
 * fields sit in its `structuredContent`. Accept the flat shape too, for
 * direct calls and tests.
 */
function delegateResult(result: AgentToolResult<unknown>): DelegateReading {
	const outer = asRecord(result.structuredContent);
	const inner = asRecord(outer?.structuredContent) ?? outer;

	const rawSummary = inner?.summary;
	const summary =
		typeof rawSummary === "string" && rawSummary.trim().length > 0
			? rawSummary
			: textOf(result);
	const link = typeof inner?.link === "string" ? inner.link : "";
	const pendingApproval = inner?.pendingApproval;
	const pending =
		inner?.hasPendingQuestion === true ||
		(typeof pendingApproval === "object" && pendingApproval !== null);
	const timedOut = inner?.waitTimedOut === true;
	const isError = outer?.isError === true || inner?.isError === true;

	return { summary, link, pending, timedOut, isError };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function buildDelegateTask(
	query: string,
	clones: Array<{ displayName: string; path: string }>,
): string {
	const repoLines = clones
		.map((clone) => `- ${clone.displayName}: ${clone.path}`)
		.join("\n");
	return `Answer a question about cloned git repositories.

Repositories:
${repoLines}

Query: ${query}

Rules:
- The paths above are temporary clones. Treat them as read-only.
- Do not edit, write, move, rename, or delete any file.
- Do not run git commands that change state.
- Use the codemode tool for exploration.
- Inside codemode, call only tools.read, tools.grep, tools.find, and tools.ls.
- Do not call tools.bash, tools.edit, tools.write, or tools.repo_query.
- Answer with specific file paths and line numbers.
- State clearly when the code does not answer the query.
- Maximum 800 words.

${findingsInstructions("owner/repo")}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
