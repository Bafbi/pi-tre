/**
 * The real subagent backend: `@pi-tre/pi-subagent`'s in-process backend,
 * behind the core's `RunSubagent` port. A pi-only concern that stays in the
 * adapter.
 */

import {
	createInProcessBackend,
	createSafeAccumulator,
	runSubagent,
	type SubagentBackend,
	type SubagentEvent,
} from "@pi-tre/pi-subagent";
import type { RunSubagent } from "@pi-tre/sillajje-core";

/**
 * Create the real `RunSubagent` used for change stamping.
 *
 * The adapter runs the subagent through `@pi-tre/pi-subagent`'s in-process
 * backend: no child process, no spawn latency across retry attempts. A
 * timed-out, aborted, or failed run rejects, so the core's retry wrapper
 * sees one failure channel.
 *
 * `backend` is injectable for tests; production uses the in-process backend,
 * which builds its own model runtime from the agent directory.
 */
export function createRunSubagent(backend?: SubagentBackend): RunSubagent {
	const resolved = backend ?? createInProcessBackend();
	return async ({ prompt, model, timeoutMs }) => {
		const session = runSubagent(
			{
				prompt,
				cwd: process.cwd(),
				model,
				// The generator runs tool-less. An empty allowlist disables all
				// tools, built-in and extension; it is also the recursion guard.
				tools: [],
				timeoutMs,
			},
			resolved,
		);

		const answer = createSafeAccumulator();
		let errorMessage = "";
		let exit: Extract<SubagentEvent, { type: "exit" }> | undefined;

		for await (const event of session.events) {
			switch (event.type) {
				case "text":
					answer.append(event.text, event.kind);
					break;
				case "error":
					errorMessage = event.message;
					break;
				case "exit":
					exit = event;
					break;
				default:
					break;
			}
		}

		if (!exit) {
			throw new Error(
				errorMessage || "subagent ended without an exit event",
			);
		}
		if (exit.timedOut) {
			throw new Error(`timeout: ${timeoutMs}ms`);
		}
		if (exit.aborted) {
			throw new Error(errorMessage || "aborted");
		}
		if (exit.code !== 0 || errorMessage) {
			throw new Error(
				errorMessage ||
					exit.stderr ||
					exit.spawnError ||
					"subagent failed",
			);
		}

		return { text: answer.get() };
	};
}
