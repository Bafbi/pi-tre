import type {
	AgentToolResult,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	canUseT3Delegate,
	runT3Delegate,
	T3_DELEGATE_TOOL,
} from "../../src/t3-delegate.js";
import type { ParsedRepo } from "../../src/types.js";

const repo: ParsedRepo = {
	raw: "owner/repo",
	host: "github",
	cloneUrl: "https://github.com/owner/repo.git",
	branch: null,
	displayName: "owner/repo",
	dirName: "github_owner_repo",
	owner: "owner",
	repo: "repo",
};

const options = {
	tempspace: "/tmp/pi-rq-test",
	repos: [repo],
	query: "Where is the entry point?",
	signal: undefined,
};

/**
 * Build the shape T3's pi bridge actually returns: the outer
 * `structuredContent` is the MCP result, and the orchestrator fields sit in
 * its own `structuredContent`.
 */
function delegateResult(
	inner: Record<string, unknown> | undefined,
	text = "",
): AgentToolResult<unknown> {
	return {
		content: text.length > 0 ? [{ type: "text", text }] : [],
		details: {},
		...(inner === undefined
			? {}
			: {
					structuredContent: {
						content: [],
						structuredContent: inner,
					},
				}),
	} as unknown as AgentToolResult<unknown>;
}

function fakeContext(outcome: {
	result: AgentToolResult<unknown>;
	isError?: boolean;
}) {
	const executeTool = vi.fn(
		async (
			_name: string,
			_args: Record<string, unknown>,
			_options?: { signal?: AbortSignal },
		) => outcome,
	);
	return {
		executeTool,
		ctx: { executeTool } as unknown as Pick<
			ExtensionToolContext,
			"executeTool"
		>,
	};
}

describe("canUseT3Delegate", () => {
	it("is true when T3 registered the delegate tool", () => {
		expect(
			canUseT3Delegate({
				tools: [{ name: T3_DELEGATE_TOOL }] as never,
			}),
		).toBe(true);
	});

	it("is false when the tool is absent", () => {
		expect(canUseT3Delegate({ tools: [] })).toBe(false);
	});
});

describe("runT3Delegate", () => {
	it("passes the clone paths, a read-only task, and the wait mode", async () => {
		const { executeTool, ctx } = fakeContext({
			result: delegateResult({
				summary: "The entry point is src/index.ts.",
			}),
		});

		const result = await runT3Delegate(options, ctx);

		expect(result.answer).toBe("The entry point is src/index.ts.");
		expect(result.complete).toBe(true);
		expect(executeTool).toHaveBeenCalledTimes(1);
		const [name, args] = executeTool.mock.calls[0] ?? [];
		expect(name).toBe(T3_DELEGATE_TOOL);
		expect(args).toMatchObject({
			role: "research",
			mode: "wait",
			isolation: "shared",
			runtimeMode: "approval-required",
			timeoutMs: 300_000,
		});
		expect(args.task).toContain("/tmp/pi-rq-test/github_owner_repo");
		expect(args.task).toContain("read-only");
		expect(args.task).toContain("Where is the entry point?");
		expect(args.task).toContain("findings");
		expect(args.task).toContain("```json");
	});

	it("reads the error flag from the nested MCP result", async () => {
		const { ctx } = fakeContext({
			result: delegateResult({
				isError: true,
				summary: "nested failure",
			}),
		});

		const result = await runT3Delegate(options, ctx);
		expect(result.answer).toBe("");
		expect(result.error).toContain("nested failure");
	});

	it("falls back to the text content when there is no summary", async () => {
		const { ctx } = fakeContext({
			result: delegateResult(undefined, "Plain text answer."),
		});

		const result = await runT3Delegate(options, ctx);
		expect(result.answer).toBe("Plain text answer.");
	});

	it("reports an error outcome", async () => {
		const { ctx } = fakeContext({
			result: delegateResult({ summary: "delegate crashed" }),
			isError: true,
		});

		const result = await runT3Delegate(options, ctx);
		expect(result.answer).toBe("");
		expect(result.error).toContain("delegate crashed");
	});

	it("reports a delegate that waits on a question or approval", async () => {
		const { ctx } = fakeContext({
			result: delegateResult({
				hasPendingQuestion: true,
				link: "t3-thread://thread/child",
			}),
		});

		const result = await runT3Delegate(options, ctx);
		expect(result.error).toContain("waiting for an answer or approval");
		expect(result.error).toContain("t3-thread://thread/child");
	});

	it("reports a wait timeout without stopping the delegate", async () => {
		const { ctx } = fakeContext({
			result: delegateResult({
				waitTimedOut: true,
				link: "t3-thread://thread/child",
			}),
		});

		const result = await runT3Delegate(options, ctx);
		expect(result.error).toContain("did not finish within 300 seconds");
		expect(result.error).toContain("keeps running");
	});

	it("reports a delegate that finishes without a summary", async () => {
		const { ctx } = fakeContext({ result: delegateResult(undefined) });

		const result = await runT3Delegate(options, ctx);
		expect(result.error).toContain("without a summary");
	});

	it("reports an aborted delegate", async () => {
		const controller = new AbortController();
		const executeTool = vi.fn(async () => {
			controller.abort();
			throw new Error("aborted");
		});
		const ctx = { executeTool } as unknown as Pick<
			ExtensionToolContext,
			"executeTool"
		>;

		const result = await runT3Delegate(
			{ ...options, signal: controller.signal },
			ctx,
		);
		expect(result.error).toBe("T3 delegate aborted.");
	});
});
