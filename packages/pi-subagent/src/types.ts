import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";

/**
 * One subagent call. Every field except `prompt` and `cwd` is optional;
 * backends decide how each field is honored.
 */
export interface SubagentTask {
	prompt: string;
	cwd: string;
	/** Model for the subagent: a `Model` object or a CLI model string (e.g. `"anthropic/claude-..."`). Backends may inherit a parent default when omitted. */
	model?: Model<any> | string;
	/** Thinking level. Backends may inherit a parent default when omitted. */
	thinkingLevel?: ThinkingLevel;
	/** Tool allowlist, e.g. `["read", "grep", "find", "ls", "bash"]`. An empty array disables all tools; omit the field to use the backend default. */
	tools?: string[];
	/** Tool denylist. Use it to keep the spawning extension's own tools out of the child. */
	excludeTools?: string[];
	/** Instructions appended to the child's system prompt. The process backend delivers it via a temp file and `--append-system-prompt`; the in-process backend appends it through a resource loader. */
	systemPrompt?: string;
	/** Abort signal. Aborting kills the subagent run. */
	signal?: AbortSignal;
	/** Wall-clock limit. A run that outlasts it is aborted and reported as timed out. */
	timeoutMs?: number;
}

/** Token/cost usage accumulated across the subagent's LLM turns. */
export interface SubagentUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
}

/**
 * Events emitted during a subagent run, in order.
 *
 * `text` and `thinking` events carry `kind: "delta"` for streaming
 * increments and `kind: "full"` for a complete final message. A backend may
 * emit both; consumers that accumulate text must deduplicate full events
 * against accumulated deltas (`createSafeAccumulator` implements the
 * policy).
 *
 * `usage` events carry the usage accumulated so far. The `exit` event is
 * always the last event before the stream closes; it reports how the run
 * ended.
 */
export type SubagentEvent =
	| { type: "text"; text: string; kind: "delta" | "full" }
	| { type: "thinking"; text: string; kind: "delta" | "full" }
	| { type: "usage"; usage: SubagentUsage }
	| { type: "stopReason"; stopReason: string }
	| { type: "error"; message: string }
	| {
			type: "exit";
			/** Process exit code. 1 on a spawn error; -1 when the run timed out. */
			code: number;
			/** True when the run was killed by the timeout. */
			timedOut: boolean;
			/** True when the run was aborted through `signal` or `abort()`. */
			aborted: boolean;
			/** True when the run was stopped for exceeding the output byte cap. */
			overflow: boolean;
			/** Collected stderr output. */
			stderr: string;
			/** Set when the child process itself failed to start. */
			spawnError?: string;
	  };

/** The handle returned by a subagent run. */
export interface SubagentSession {
	/** Live events. The stream closes when the run ends. */
	events: ReadableStream<SubagentEvent>;
	/** Usage accumulated across the run. Resolves when usage is final. */
	usage(): Promise<SubagentUsage>;
	/** Abort the run. */
	abort(): Promise<void>;
}

/**
 * The one test seam. A backend runs a subagent task and returns a session.
 * Callers choose the backend per call site: `createProcessBackend()` for
 * hard isolation, `createInProcessBackend()` for no spawn latency.
 */
export interface SubagentBackend {
	run(task: SubagentTask): SubagentSession;
}

/** A `SubagentUsage` with every counter at zero. */
export function zeroUsage(): SubagentUsage {
	return {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		totalTokens: 0,
	};
}

/**
 * Append-only text accumulator shared by `text` delta (incremental) and
 * `text` full events. A "full" event is kept as-is unless it is the same
 * text already accumulated or an extension of it; anything else means the
 * provider rewrote the final message, so it replaces the value instead of
 * appending.
 *
 * The process backend emits raw delta and full events; consumers that
 * accumulate text use this to deduplicate.
 */
export function createSafeAccumulator(): {
	append: (text: string, eventKind?: "delta" | "full") => void;
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
