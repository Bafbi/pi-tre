import type { SubagentEvent, SubagentUsage } from "./types.js";

/**
 * The fields both backends read off an assistant message. The process
 * backend builds one from a parsed JSON-lines event; the in-process
 * backend builds one from an `AgentSessionEvent`.
 */
export interface AssistantMessageInfo {
	content: Array<{ type: string; text: string }>;
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
}

/**
 * Map one complete assistant message onto the subagent event stream: emit
 * its text parts, accumulate usage, then report the stop reason or LLM
 * error. Both backends share this so the mapping cannot drift between the
 * process and in-process transports.
 */
export function emitAssistantMessage(
	message: AssistantMessageInfo,
	emit: (event: SubagentEvent) => void,
	usage: SubagentUsage,
): void {
	for (const part of message.content) {
		if (part.type === "text" && typeof part.text === "string") {
			emit({ type: "text", text: part.text, kind: "full" });
		}
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
			message: message.errorMessage || "unknown subagent LLM error",
		});
	} else if (message.stopReason) {
		emit({ type: "stopReason", stopReason: message.stopReason });
	}
}
