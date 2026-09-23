import type { SubagentEvent, SubagentUsage } from "./types.js";

/**
 * The fields both backends read off an assistant message. The process
 * backend builds one from a parsed JSON-lines event; the in-process
 * backend builds one from an `AgentSessionEvent`.
 */
export interface AssistantMessageInfo {
	content: Array<{ type: string; text: string }>;
	usage?:
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
				cost?: { total?: number };
		  }
		| undefined;
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
}

/** True for a protocol content part that carries assistant text. */
function isTextPart(part: unknown): part is { type: string; text: string } {
	return (
		typeof part === "object" &&
		part !== null &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

/**
 * Map one complete assistant message onto the subagent event stream: emit
 * its text, accumulate usage, then report the stop reason or LLM error.
 * Both backends share this so the mapping cannot drift between the process
 * and in-process transports.
 */
export function emitAssistantMessage(
	message: AssistantMessageInfo,
	emit: (event: SubagentEvent) => void,
	usage: SubagentUsage,
): void {
	// `kind: "full"` means the complete message, so join every text part into
	// one event. Emitting a part at a time makes an accumulator treat the
	// second part as a rewrite and drop the first.
	const text = message.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("");
	if (text) {
		emit({ type: "text", text, kind: "full" });
	}
	usage.turns++;
	if (message.usage) {
		usage.input += message.usage.input ?? 0;
		usage.output += message.usage.output ?? 0;
		usage.cacheRead += message.usage.cacheRead ?? 0;
		usage.cacheWrite += message.usage.cacheWrite ?? 0;
		usage.cost += message.usage.cost?.total ?? 0;
		usage.totalTokens += message.usage.totalTokens ?? 0;
	}
	emit({ type: "usage", usage: { ...usage } });
	if (message.stopReason === "error") {
		emit({
			type: "error",
			message: message.errorMessage ?? "unknown subagent LLM error",
		});
	} else if (message.stopReason) {
		emit({ type: "stopReason", stopReason: message.stopReason });
	}
}
