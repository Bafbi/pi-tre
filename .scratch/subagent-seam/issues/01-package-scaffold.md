# 01: Package scaffold — contract and stub backend

**What to build:** the `@pi-tre/pi-subagent` package, wired into the monorepo (pnpm workspace and the repo's task roots), exposing the consumer contract — `runSubagent(task)` returning a typed session with events, usage, and abort — over a pluggable `SubagentBackend` seam. Ships a scripted stub backend (streams a full fake turn; fails when the prompt starts with `"FAIL:"`). A caller can run a subagent against the stub with no LLM and no process, and the contract is testable end to end.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `packages/*` is a first-class workspace area: lint, typecheck, and test tasks work for the package.
- [x] `runSubagent(task, stubBackend)` yields typed events, usage, and abort.
- [x] Stub streams a complete fake turn and fails on `"FAIL:"` prompts.
- [x] Contract unit tests cover the happy path, usage reporting, and failure.

**Deviations:** the package declares `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as type-only peer deps (for the contract's `Model`/`ThinkingLevel`), not just pi-coding-agent; `runSubagent(task)` with no backend throws a descriptive error until ticket 04 adds the in-process default.
