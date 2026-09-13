import { createPushStream } from "./push-stream.js";
import type {
	SubagentBackend,
	SubagentEvent,
	SubagentSession,
	SubagentTask,
	SubagentUsage,
} from "./types.js";
import { zeroUsage } from "./types.js";

export interface StubBackendOptions {
	/** Thinking text streamed before the answer. Default: none. */
	thinking?: string;
	/** Answer text streamed as the fake turn's output. Default: "stub answer". */
	answer?: string;
	/** Partial usage counters merged into the reported usage. */
	usage?: Partial<SubagentUsage>;
	/** Stop reason reported after the answer. Default: "stop". */
	stopReason?: string;
}

/**
 * A fully scripted backend for orchestration tests. It streams a complete
 * fake turn (thinking, answer, usage, stop reason) with no LLM and no
 * process. A prompt starting with `"FAIL:"` makes the turn fail; the rest
 * of the prompt becomes the error message.
 *
 * Orchestration tests in consumer extensions inject this backend in place
 * of a real one, so they run fast and deterministically.
 */
export function createStubBackend(
	options?: StubBackendOptions,
): SubagentBackend {
	const answer = options?.answer ?? "stub answer";
	const stopReason = options?.stopReason ?? "stop";
	const usage: SubagentUsage = {
		...zeroUsage(),
		...options?.usage,
	};

	return {
		run(task: SubagentTask): SubagentSession {
			const push = createPushStream<SubagentEvent>();

			const failPrefix = "FAIL:";
			if (task.prompt.trimStart().startsWith(failPrefix)) {
				const message =
					task.prompt.trimStart().slice(failPrefix.length).trim() ||
					"stub failure";
				push.push({ type: "error", message });
				push.push({
					type: "exit",
					code: 1,
					timedOut: false,
					aborted: false,
					overflow: false,
					stderr: "",
				});
				push.close();
				return {
					events: push.stream,
					usage: () => Promise.resolve(zeroUsage()),
					abort: () => Promise.resolve(),
				};
			}

			if (options?.thinking) {
				push.push({
					type: "thinking",
					text: options.thinking,
					kind: "delta",
				});
			}
			push.push({ type: "text", text: answer, kind: "delta" });
			push.push({ type: "usage", usage });
			push.push({ type: "stopReason", stopReason });
			push.push({
				type: "exit",
				code: 0,
				timedOut: false,
				aborted: false,
				overflow: false,
				stderr: "",
			});
			push.close();

			return {
				events: push.stream,
				usage: () => Promise.resolve(usage),
				abort: () => Promise.resolve(),
			};
		},
	};
}
