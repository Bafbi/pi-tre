# 02: Process backend

**What to build:** a backend that runs a child, headless pi process: prompt delivered via the established temp-file mechanism, line-streamed JSON-lines events parsed into typed events (text with full-vs-delta dedup, usage, stop reason, error), timeout with SIGTERM→SIGKILL escalation and a grace period, external abort with listener cleanup, exit-code semantics, and a hard output byte cap. Ported from the explorer lifecycle in repo-query; the pi invocation resolver, including the vitest path, moves in with it.

**Blocked by:** 01 — Package scaffold.

**Status:** done

- [x] Kill/escalation/abort coverage from the current explorer abort suite passes against the extracted backend.
- [x] Event-parsing unit tests pass: text dedup, usage accumulation across turns, stop-reason and error extraction.
- [x] The process spawn is injectable; unit tests run with no real process.
- [x] Timeout escalates SIGTERM→SIGKILL after the grace period; aborting keeps streamed output available to the caller.

**Deviations:** the contract grew by four fields/events to keep consumers' policy intact — `SubagentTask.systemPrompt` (temp file + `--append-system-prompt`, the established mechanism; repo-query keeps building it), `SubagentTask.model` widened to `Model | string` (both extensions hold CLI model strings), `thinking` events (repo-query streams thinking live), and a terminal `exit` event (`code`/`timedOut`/`aborted`/`overflow`/`stderr`/`spawnError`) so error classification stays per extension. `createSafeAccumulator` is exported from the package for consumers that accumulate text. The parser itself is private; tests exercise the backend through the injected spawn, not the parser.
