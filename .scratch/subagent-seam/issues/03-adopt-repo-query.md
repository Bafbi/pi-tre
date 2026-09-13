# 03: Adopt the seam in repo-query (process backend)

**What to build:** repo-query's exploration orchestration runs over the seam with the process backend: an agent call becomes `runSubagent(task, processBackend)` with live streaming of answer and thinking, the partial-answer-on-abort notice, and subagent usage mapped into the tool result. External behavior — outputs, errors, abort handling, tool results — is identical to today; the inline spawn, parsing, and usage code is deleted.

**Blocked by:** 02 — Process backend.

**Status:** done

- [x] Full repo-query suite stays green with zero assertion changes.
- [x] Live subagent test still runs a real subagent on the process backend and asserts reported usage.
- [x] Aborting an exploration keeps the partial answer with the truncation notice.
- [x] Tool result still carries usage in the `AgentToolResult.usage` shape.

**Deviations:** `test/unit/explorer.test.ts` was deleted — its `processSubagentLine` coverage moved to the package in ticket 02 per the PRD's testing decisions (the `ExplorerProcess`/`SpawnFunction` type names survive as re-exports so `explorer-abort.test.ts` compiles unchanged). `runExplorer` gained one new classification branch for the backend's output-cap overflow (`explorer.ts`), which has no today-equivalent because the old code had no cap. The temp prompt file is now written by the backend without `withFileMutationQueue` — each run gets a unique `mkdtemp` directory, so the queue was guarding nothing.
