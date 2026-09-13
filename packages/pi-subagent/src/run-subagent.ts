import { createInProcessBackend } from "./in-process-backend.js";
import type {
	SubagentBackend,
	SubagentSession,
	SubagentTask,
} from "./types.js";

// The convenience default is shared across calls. `run()` creates a fresh
// session per call either way, so reuse only saves repeating the runtime
// and auth setup; built lazily on first use.
let defaultBackend: SubagentBackend | undefined;

/**
 * Run a subagent through the given backend.
 *
 * The backend is chosen per call site — pass `createProcessBackend()` for
 * hard isolation or `createInProcessBackend()` for no spawn latency. When
 * omitted, a shared in-process backend is used.
 */
export function runSubagent(
	task: SubagentTask,
	backend?: SubagentBackend,
): SubagentSession {
	if (backend) {
		return backend.run(task);
	}
	defaultBackend ??= createInProcessBackend();
	return defaultBackend.run(task);
}
