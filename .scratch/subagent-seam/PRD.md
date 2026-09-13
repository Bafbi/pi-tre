# Subagent Seam (PRD)

Status: ready-for-agent

## Problem Statement

Two extensions in this repo spawn headless pi subagents with duplicated code
that has started to drift:

- repo-query's `runExplorer` runs a child `pi` process, parses pi's JSON-lines
  protocol by hand, and manages a hardened lifecycle (300s timeout,
  SIGTERM→SIGKILL escalation, abort-listener cleanup, partial-answer-on-abort,
  usage accounting).
- sillajje's `sub-generator.ts` also spawns `pi`, but its lifecycle is cruder:
  plain `kill()` on timeout, no escalation, no abort support, no streaming.

Both maintain separate, hand-rolled copies of the same process plumbing, the
same protocol parsing, and the same usage accumulation. Every fix lands twice
and drifts. There is no shared seam for "run a pi subagent".

## Solution

One workspace package, `@pi-tre/pi-subagent`, exposing a single consumer
contract — `runSubagent(task)` — with a pluggable `SubagentBackend` seam and
two implementations:

- an **in-process backend** built on the pi SDK (`createAgentSession`): typed
  events, model and thinking level inherited from the parent, an
  `excludeTools` recursion guard, a fresh in-memory session, and a watchdog
  timeout for cooperative abort;
- a **process backend** ported verbatim from repo-query's proven child-process
  lifecycle: spawn, timeout, SIGTERM→SIGKILL escalation, abort, exit
  semantics.

repo-query adopts the process backend (hard isolation for long, tool-heavy
exploration). sillajje adopts the in-process backend (no spawn latency across
its retries). Policy stays per extension: retries and fallbacks stay in
sillajje, streaming and usage mapping stay in repo-query.

## User Stories

1. As an extension author in this monorepo, I want one API for running a pi
   subagent, so that I never hand-roll process plumbing or protocol parsing
   again.
2. As an extension author, I want to choose the backend per call site
   explicitly, so that the isolation-vs-latency trade-off is a deliberate
   decision, not a heuristic.
3. As the repo-query maintainer, I want `runExplorer` to keep its exact
   current behavior after adoption, so that exploration results, error
   messages, and abort handling do not change for users.
4. As the repo-query maintainer, I want the 300-second timeout, the
   SIGTERM→SIGKILL escalation with a grace period, and abort-listener cleanup
   preserved, so that hung or aborted exploration stays under control.
5. As the repo-query maintainer, I want the subagent's answer and thinking
   streamed live during exploration, so that the parent tool can render
   progress.
6. As the repo-query maintainer, I want the partial answer kept with a
   `[Exploration aborted before completion.]` notice when a run is aborted, so
   that partial work is not silently discarded.
7. As the repo-query maintainer, I want subagent usage (turns, tokens, cache,
   cost) accumulated and mapped into pi's `AgentToolResult.usage` shape, so
   that the parent tool result reports nested LLM usage.
8. As the sillajje maintainer, I want header and trace generation to stop
   paying process-spawn latency on every retry attempt, so that stamping is
   faster.
9. As the sillajje maintainer, I want the retry wrapper and the fallback
   values with the `fellBack` flag to keep working unchanged, so that a broken
   provider never produces a bad commit subject silently.
10. As the sillajje maintainer, I want a timeout on the subagent call that a
    hung turn cannot ignore, so that escalation still happens via the retry
    path when a generator stalls.
11. As a test author, I want one injectable seam (`SubagentBackend`) with a
    scripted stub, so that orchestration tests run fast, deterministically,
    and without any LLM or process.
12. As a test author, I want the stub backend to fail on demand for
    error-path tests, so that failure handling is exercised without a real
    provider.
13. As a test author, I want the process backend's kill/escalation/abort
    coverage to move with the code, so that the hardened lifecycle stays
    proven after extraction.
14. As an extension author, I want the in-process backend to expose
    `onModel`/`onThinkingLevel` hooks that inherit the parent's model and
    thinking level when provided, so a caller holding a parent session can
    wire inheritance without the backend reaching for it. The repo's
    generators pass a CLI model string instead, so they do not use the
    hooks.
15. As an extension author, I want a tools allowlist and an `excludeTools`
    denylist available on the child session, so that agent calls can be
    constrained to a read-only toolset and cannot recurse into the extension
    that spawned them.
16. As an extension author, I want each in-process child to get a fresh,
    in-memory session, so that no conversation history leaks between the
    parent and its subagents or between subagents.
17. As an extension author, I want the package to be dependency-free apart
    from `node:child_process` (pi-coding-agent as a peer dependency), so that
    adding it does not inflate the check surface.
18. As the monorepo maintainer, I want `packages/*` added to the pnpm
    workspace and mise config roots, so that the new package is built,
    linted, and tested by the same tasks as the extensions.
19. As the monorepo maintainer, I want the protocol coupling to the installed
    pi version to be pinned on the process backend with a replayed-session
    fixture, so that an upstream protocol change fails a test instead of
    producing silent reading errors.
20. As a code reviewer, I want each thing named once, so that the PRD, the
    package README, and the AGENTS.md docs use the same terms
    (`runSubagent`, `SubagentBackend`, backend names).
21. As the sillajje maintainer, I want `SpawnFn` to remain the extension's own
    layer over the package, so that its tests and its seam are untouched by
    the backend swap.
22. As the repo-query maintainer, I want the extension's existing factory
    override seams (`createRepoQueryExtension` overrides) to keep working, so
    that pipeline tests stay green without new harnesses.
23. As an AFK agent implementing this, I want the migration phased so each
    phase leaves the suite green, so that a failure is attributable to the
    phase that introduced it.
24. As a future extension author outside this repo, I want the package
    documented with its contract and backends, so that a third extension can
    adopt it without reading this PRD.

## Implementation Decisions

- **New workspace package** `@pi-tre/pi-subagent` under `packages/`, a plain
  TypeScript library (no `pi.extensions` entry). Consumers are workspace
  dependencies.
- **Monorepo wiring changes**: add `packages/*` to `pnpm-workspace.yaml`.
  Add `packages/*` as a mise `config_roots` entry so task templates (lint,
  typecheck, test, check) apply to it. Update `tsconfig` include if the
  package is not covered by the existing project references.
- **Consumer contract** (from the design document, encoded verbatim):

  ```ts
  export interface SubagentTask {
    prompt: string;
    cwd: string;
    model?: Model;            // in-process: inherited from ctx.model when omitted
    thinkingLevel?: ThinkingLevel;
    tools?: string[];         // allowlist, e.g. ["read","grep","find","ls","bash"]
    excludeTools?: string[];  // recursion guard: the spawning extension's own tools
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  export interface SubagentSession {
    events: ReadableStream<SubagentEvent>;  // text / usage / stopReason / error
    usage(): Promise<SubagentUsage>;
    abort(): Promise<void>;
  }

  export function runSubagent(task: SubagentTask, backend?: SubagentBackend): SubagentSession;
  ```

- **One test seam**: `type SubagentBackend = { run(task): SubagentSession }`.
  Backends are passed explicitly by the caller (process for repo-query,
  in-process for sillajje). No `globalThis` registries; no auto-detection.
  This is the only new seam; existing seams (repo-query factory overrides,
  sillajje `SpawnFn`) are preserved over it.
- **`createProcessBackend()`**: ported from repo-query's `explorer.ts`
  lifecycle — spawn via a resolvable pi invocation (`getPiInvocation`
  including the vitest path), line-streamed stdout, timeout with
  SIGTERM→SIGKILL escalation and a grace period, external
  `AbortSignal` support with listener cleanup, exit-code semantics, and a
  hard output byte cap. The JSON-lines parsing moves into this backend and
  stays pinned to the installed pi protocol shape.
- **`createInProcessBackend(options)`**: wraps `createAgentSession` and
  constructs its own `ModelRuntime` by default (auth resolved from the
  extension agent directory), so no caller-side runtime wiring is needed —
  the runtime is always required, so the backend owns it. An injectable
  runtime override exists for tests. Optional parent-model callback inherits
  the parent's model and thinking level. Defaults: fresh
  `SessionManager.inMemory()`, `sessionStartEvent` for extension startup,
  tools allowlist and `excludeTools` denylist, watchdog timeout that
  reports `timedOut` when a turn hangs past `timeoutMs` (abort is
  cooperative).
- **Backend selection is explicit and per call site** (`D6`): repo-query
  passes the process backend; sillajje uses the in-process backend.
- **Usage shape** in the package: `SubagentUsage { turns, input, output,
  cacheRead, cacheWrite, cost, totalTokens }`. repo-query keeps its mapping
  into `AgentToolResult.usage`; sillajje does not use usage today.
- **What stays per extension**: sillajje's `SpawnFn`, retry wrapper, fallback
  values, and `fellBack` flag (now backed by the in-process backend); the
  timeout semantics change only in that `timedOut` is surfaced explicitly and
  treated by the retry wrapper exactly like the old rejection. repo-query's
  prompt building, live streaming, partial-answer-on-abort policy, answer
  truncation, and usage mapping.
- **Protocol pin**: only the process backend carries the JSON-lines coupling.
  A replayed-session fixture pins the parsed event shapes; the in-process
  backend is version-coupled at compile time through `AgentSession` types.
- **Tool recursion guard**: the spawning extension's own tool names go into
  `excludeTools` (davis7dotsh's `CHILD_EXCLUDED_TOOL_NAMES` pattern), because
  `createAgentSession` loads installed extensions into the child.
- **No shared policy**: retries, fallbacks, streaming policy, and usage
  mapping are not part of the package.

## Testing Decisions

- **A good test exercises external behavior from the consumer's point of
  view**: given a `SubagentTask`, assert on the text, usage, stop reason, and
  abort/timeout semantics — not on internal process or parser state.
- **Seam strategy**: one seam. Orchestration tests in both extensions replace
  the backend with the package's scripted stub; backend tests exercise each
  backend directly with its own injected primitives (spawn override for the
  process backend, a fake or absent model runtime for the in-process
  backend).
- **Modules tested**:
  - `@pi-tre/pi-subagent` contract tests against the scripted stub
    (fully-fake turn; fails on prompts starting with `"FAIL:"`).
  - Process backend: `explorer-abort.test.ts` stays in repo-query and runs
    unchanged against the backend's re-exported types; the package adds
    parallel kill/escalation/abort coverage, plus the event-parsing unit
    tests from `explorer.test.ts`.
  - In-process backend: session-option wiring (allowlist, denylist, fresh
    in-memory session, watchdog `timedOut` reporting) using a stub
    `createAgentSession`; no live LLM in the default suite.
  - sillajje: existing generator tests re-wired through the adapter; retry
    and fallback behavior asserted unchanged.
  - repo-query: existing pipeline tests unchanged and green, proving zero
    behavior change.
- **Prior art**: `explorer-abort.test.ts` (kill/escalation/abort), unit tests
  for `processSubagentLine`, the `create-runner.ts` helpers, the
  `live-subagent.llm.test.ts` usage assertions, and the stub-backend pattern
  from davis7dotsh's subagents extension.
- **Category conventions**: `.llm.test.ts` for real-LLM integration (repo-query
  keeps its live subagent test on the process backend); nothing in the
  package itself calls a real LLM in tests.

## Out of Scope

- A multi-provider registry (claude, codex, and other backends). Both
  extensions are pi-only.
- An async runner, background jobs, or result-file delivery. Subagent calls
  here are bounded tool calls.
- Usage budgets, tool budgets, depth caps, or workflow scripting.
- An agent-definition platform (frontmatter markdown agents, workflows,
  skills). If repo-query wants per-mission agents later, that is a separate
  seam.
- Moving repo-query to the in-process backend. Exploration stays on the
  process backend for hard isolation and SIGKILL escalation.
- Shared retry or fallback logic.
- UI renderers for subagent output (already per extension).
- Rewriting the official pi subagent example.

## Further Notes

- **Design history**: the two-package seam (process shell + protocol parser)
  was the first cut; the capability review of pi's SDK
  (`createAgentSession`, typed events, model/thinking inheritance, tool
  allow/denylists) produced the one-contract, two-backends design. The
  comparison lives in `docs/subagent-seam-proposal.html` (section 11).
- **Isolation decision (D1)**: hybrid — process for repo-query, in-process
  for sillajje. The reasoning is recorded in the proposal's risk section;
  consider promoting it to a root-level ADR (`docs/adr/`) when the package
  lands, since the domain doc convention says system-wide decisions belong
  there.
- **Protocol coupling**: the process backend's event parsing is coupled to
  the installed pi version (0.84.x). The replayed fixture is the upgrade
  tripwire; `mise check` must run on any pi version bump.
- **sillajje behavior note**: the timeout path changes from a plain
  rejection to an explicit `timedOut`; the retry wrapper must treat both as
  identical failures so fallback output never changes.