# 01 — Scaffold, jj detection, and inactive no-op

**What to build:** The extension exists as a registered package in the monorepo with the full module scaffold. When a Pi session starts, the extension detects whether jj is available on PATH and whether the current directory is inside a jj repo. In a non-jj repo or when jj is absent, every handler is a transparent pass-through — the extension is completely silent. In a jj repo, the extension acknowledges detection but does nothing further (no workspace creation, no path redirection, no change stamping).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Extension package scaffolded with `package.json`, `tsconfig.json`, module files matching the agreed structure (`session.ts`, `workspace.ts`, `sub-generator.ts`, `metadata.ts`, `path-redirect.ts`, `state.ts`, `index.ts`)
- [ ] Extension registered in monorepo root `package.json` `pi.extensions` array
- [ ] `session_start` handler detects jj availability (binary on PATH + `.jj/` directory at repo root)
- [ ] `session_start` handler detects repo root by walking up from `ctx.cwd`
- [ ] `state.ts` tracks session state (inactive / active / archived) and exposes it to other modules
- [ ] All other event handlers (`before_agent_start`, `agent_settled`, `tool_call`, `input`) are wired as no-ops when state is inactive
- [ ] `/sillajje` command registered with `status` subcommand (reports inactive in non-jj repos)
- [ ] Unit tests for `state.ts` (state transitions, default state)
- [ ] Integration test via ExtensionRunner: loads extension, fires `session_start` in non-jj directory, asserts handlers are registered, asserts commands exist, asserts `status` reports inactive
- [ ] Integration test via ExtensionRunner: loads extension, fires `session_start` in a jj-initialized repo, asserts detection succeeds (state reports active-ready)
