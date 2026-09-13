# Subagent isolation is per consumer: process backend for repo-query, in-process backend for sillajje

Two extensions spawn headless pi subagents with different needs, so the shared `@pi-tre/pi-subagent` package ships two backends behind one `runSubagent(task, backend)` contract, and each extension picks its backend at the call site. repo-query keeps the process backend (`createProcessBackend`): exploration is long, tool-heavy, and untrusted work, so the child dies hard: SIGTERM-to-SIGKILL escalation, exit-code semantics, a byte cap. A crash cannot take down the parent. sillajje uses the in-process backend (`createInProcessBackend`): its stamping calls are short, tool-free text generations retried up to `maxAttempts`, so paying process-spawn latency on every attempt costs more than the isolation it buys.

## Considered Options

**Hybrid (chosen): backend chosen per call site, never auto-detected.** Each extension decides; no registry, no `globalThis`, no heuristics. The trade-off is documented per consumer instead of buried in the package.

**Process everywhere (rejected):** every subagent call pays spawn latency; sillajje's retries multiply that cost. Also rejected moving repo-query to in-process: exploration needs SIGKILL escalation against hung children and hard isolation from a parent that streams live progress.

**In-process everywhere (rejected):** a hung child turn can only be aborted cooperatively; exploration of unknown repos is exactly the workload where cooperative abort fails.

## Consequences

- The package stays policy-free: retries and fallbacks live in sillajje's `SpawnFn` layer, streaming and usage mapping in repo-query's explorer.
- Only the process backend couples to pi's JSON-lines protocol; the replayed fixture pins that coupling, and `mise check` must run on any pi version bump. The in-process backend couples at compile time through the `AgentSession` types.
- The in-process backend loads installed extensions into the child session, so a spawning extension must pass its own tool names in `excludeTools`.
