# 01 — Scaffold, jj detection, and inactive no-op

**What to build:** The extension exists as a registered package in the monorepo with the full module scaffold. When a Pi session starts, the extension detects whether jj is available on PATH and whether the current directory is inside a jj repo. In a non-jj repo or when jj is absent, every handler is a transparent pass-through — the extension is completely silent. In a jj repo, the extension acknowledges detection but does nothing further (no workspace creation, no path redirection, no change stamping).

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Extension package scaffolded with `package.json`, `tsconfig.json`, module files matching the agreed structure (`workspace.ts`, `sub-generator.ts`, `metadata.ts`, `path-redirect.ts`, `state.ts`, `index.ts`, plus `config.ts` and `debug-log.ts` — no separate `session.ts` orchestrator; orchestration lives in `index.ts`)
- [x] Extension registered in monorepo root `package.json` `pi.extensions` array
- [x] `session_start` handler detects jj availability (binary on PATH + `.jj/` directory at repo root)
- [x] `session_start` handler detects repo root by walking up from `ctx.cwd`
- [x] `state.ts` tracks session state (inactive / active / archived) and exposes it to other modules
- [x] All other event handlers (`before_agent_start`, `agent_settled`, `tool_call`, `input`) are wired as no-ops when state is inactive
- [x] `/sillajje` command registered with `status` subcommand (reports inactive in non-jj repos)
- [x] Unit tests for `state.ts` (state transitions, default state)
- [x] Integration test via ExtensionRunner: loads extension, fires `session_start` in non-jj directory, asserts handlers are registered, asserts commands exist, asserts `status` reports inactive
- [x] Integration test via ExtensionRunner: loads extension, fires `session_start` in a jj-initialized repo, asserts detection succeeds (state reports active-ready)
