import type {
	SubagentBackend,
	SubagentEvent,
	SubagentTask,
} from "@pi-tre/pi-subagent";
import { createPushStream, zeroUsage } from "@pi-tre/pi-subagent";
import {
	generateHeader,
	type HeaderOptions,
	type SubGeneratorContext,
} from "@pi-tre/sillajje-core";
import { describe, expect, it } from "vitest";
import { createRunSubagent } from "../../src/sub-generator.js";

const CTX: SubGeneratorContext = {
	transcript: "User: hello\nAssistant: I did something",
	diff: "",
	previousDescriptions: [],
};

const OPTS: HeaderOptions = {
	model: "openai/gpt-4o-mini",
	maxAttempts: 2,
	timeoutMs: 1_000,
	prompt: "Add a login page",
};

/** Build one `exit` event with the default flags. */
function exitEvent(
	code: number,
	overrides: Partial<Extract<SubagentEvent, { type: "exit" }>> = {},
): SubagentEvent {
	return {
		type: "exit",
		code,
		timedOut: false,
		aborted: false,
		overflow: false,
		stderr: "",
		...overrides,
	};
}

/** Build a backend that streams the events returned by `script`, then closes. */
function scriptedBackend(
	script: (task: SubagentTask) => SubagentEvent[],
): SubagentBackend {
	return {
		run(task) {
			const push = createPushStream<SubagentEvent>();
			for (const event of script(task)) push.push(event);
			push.close();
			return {
				events: push.stream,
				usage: () => Promise.resolve(zeroUsage()),
				abort: () => Promise.resolve(),
			};
		},
	};
}

/** A backend that answers every task with the given text. */
function answeringBackend(answer: string): SubagentBackend {
	return scriptedBackend(() => [
		{ type: "text", text: answer, kind: "delta" },
		{ type: "usage", usage: zeroUsage() },
		{ type: "stopReason", stopReason: "stop" },
		exitEvent(0),
	]);
}

/** A backend whose turn hangs until `timeoutMs`, then reports timedOut. */
function hangingBackend(): SubagentBackend {
	return {
		run(task) {
			const push = createPushStream<SubagentEvent>();
			const timeoutMs = task.timeoutMs ?? 30_000;
			setTimeout(() => {
				push.push(exitEvent(0, { timedOut: true }));
				push.close();
			}, timeoutMs);
			return {
				events: push.stream,
				usage: () => Promise.resolve(zeroUsage()),
				abort: () => Promise.resolve(),
			};
		},
	};
}

/** A backend that fails every turn like a broken provider. */
function failingBackend(): SubagentBackend {
	return scriptedBackend(() => [
		{ type: "error", message: "provider overloaded" },
		exitEvent(1),
	]);
}

describe("createRunSubagent over the pi-subagent seam", () => {
	it("returns the subagent answer as text", async () => {
		const run = createRunSubagent(
			answeringBackend("act/feat: add login form"),
		);

		const result = await run({
			prompt: "prompt",
			model: "m",
			timeoutMs: 1_000,
		});

		expect(result).toEqual({ text: "act/feat: add login form" });
	});

	it("treats an LLM error from the backend as a retryable failure and falls back", async () => {
		const run = createRunSubagent(failingBackend());

		const { text, fellBack } = await generateHeader(CTX, run, {
			...OPTS,
			maxAttempts: 1,
		});

		expect(fellBack).toBe(true);
		expect(text).toBe(OPTS.prompt);
	});

	it("runs the backend tool-less", async () => {
		const seen: SubagentTask[] = [];
		const backend = scriptedBackend((task) => {
			seen.push(task);
			return [
				{ type: "text", text: "answer", kind: "delta" },
				exitEvent(0),
			];
		});
		const run = createRunSubagent(backend);

		await run({ prompt: "prompt", model: "m", timeoutMs: 1_000 });

		expect(seen[0].tools).toEqual([]);
	});

	it("maps a timed-out run to a retryable failure and still falls back", async () => {
		const run = createRunSubagent(hangingBackend());

		const { text, fellBack } = await generateHeader(CTX, run, {
			...OPTS,
			maxAttempts: 2,
			timeoutMs: 20,
		});

		expect(fellBack).toBe(true);
		expect(text).toBe(OPTS.prompt);
	});
});
