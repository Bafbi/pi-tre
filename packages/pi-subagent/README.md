# @pi-tre/pi-subagent

One contract for running a headless pi subagent, with a pluggable backend
seam. Consumers in this monorepo: repo-query (process backend), sillajje
(in-process backend).

The package is a plain TypeScript library with no `pi.extensions` entry.
pi-coding-agent and the pi-ai/pi-agent-core types are peer dependencies.

## Contract

```ts
import { runSubagent } from "@pi-tre/pi-subagent";

const session = runSubagent(
	{
		prompt: "Task: audit error handling",
		cwd: repoDir,
		model: "openai/gpt-4o-mini",
		tools: ["read", "grep", "find", "ls", "bash"],
		excludeTools: ["repo_query"],
		timeoutMs: 300_000,
	},
	backend,
);

for await (const event of session.events) {
	// text / thinking / usage / stopReason / error / exit
}
const usage = await session.usage();
await session.abort();
```

`SubagentTask` fields: `prompt` and `cwd` are required. Optional: `model`
(`Model` object or CLI string), `thinkingLevel`, `tools` (allowlist),
`excludeTools` (denylist), `systemPrompt`, `signal`, `timeoutMs`. Backends
decide how each optional field is honored.

A run streams `SubagentEvent`s in order:

- `text` and `thinking` with `kind: "delta"` (increment) or `"full"`
	(complete message). A backend may emit both; accumulate with
	`createSafeAccumulator`, which deduplicates full events against
	accumulated deltas and keeps a rewritten final message.
- `usage`: counters accumulated so far across the subagent's LLM turns:
	`turns`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost`,
	`totalTokens` (`SubagentUsage`; `zeroUsage()` is the empty value).
- `stopReason`: the final assistant stop reason (e.g. `stop`, `toolUse`).
- `error`: an LLM-level failure. Not fatal by itself; `exit` decides.
- `exit`: always the last event; carries `code`, `timedOut`, `aborted`,
	`overflow`, `stderr`, and `spawnError` when the child could not start.

`runSubagent(task)` with no backend uses a shared in-process backend
built once on first use.

## Backends

Backend selection is explicit and per call site. This is the only seam the
package adds; consumer policy (retries, fallbacks, streaming, usage
mapping) stays in the consuming extension.

### `createProcessBackend(options?)`

Runs a child, headless pi process: `pi --mode json -p --no-session`. The
task prompt goes out as the positional user message; `systemPrompt` goes
via a temp file and `--append-system-prompt`. Stdout is parsed line by
line into typed events.

Lifecycle: 300 s default timeout (`DEFAULT_PROCESS_TIMEOUT_MS`), SIGTERM
then SIGKILL after a 5 s grace period (`DEFAULT_KILL_GRACE_MS`), external
`AbortSignal` support with listener cleanup, exit-code semantics, and a
32 MiB output cap (`DEFAULT_MAX_OUTPUT_BYTES`) that surfaces `overflow`.

### `createInProcessBackend(options?)`

Runs the subagent in this process through the pi SDK's `createAgentSession`.
Each call gets a fresh in-memory session, so no history leaks between a
parent and its subagents or between subagents. The backend builds its own
model runtime with auth resolved from the agent directory. No caller-side
runtime wiring. Options: `onModel` and `onThinkingLevel` callbacks inherit
the parent's model and thinking level; `excludeTools` keeps the spawning
extension's own tools out of the child (recursion guard). A task
`systemPrompt` is appended to the child's system prompt through a resource
loader, matching the process backend.

Abort is cooperative; a wall-clock deadline reports `timedOut` when a run
outlasts `timeoutMs`. Model strings resolve through pi's `resolveCliModel`.

## Test seam

Orchestration tests replace the backend with the scripted stub; backend
tests inject their own primitives (spawn override, session factory).

```ts
import { createStubBackend } from "@pi-tre/pi-subagent";

const backend = createStubBackend({ answer: "act: fix login" });
```

The stub streams a complete fake turn: thinking (when configured),
answer, usage, stop reason, then the exit event. No LLM and no
process. A prompt starting with `"FAIL:"` makes the turn fail with a
code-1 exit; the rest of the prompt is the error message. To script your own backend, use `createPushStream()` to build the
event stream.

## Protocol fixture

The process backend owns the JSON-lines coupling to the installed pi
version. `test/fixtures/pi-session.jsonl` records a real session's
protocol lines; the replay test pins the parser to those shapes, and the
metadata file pins the fixture to the pi version that produced it. A pi
version bump fails the version-pin test.

To regenerate after a pi bump:

```bash
mise run //packages/pi-subagent:generate-fixture
```

The task runs the installed `pi` with `PI_TEST_MODEL`, scrubs volatile
values (ids, timestamps, cwd, provider, model), and rewrites the fixture.
Review the diff: shape changes mean the parser may need updating.
