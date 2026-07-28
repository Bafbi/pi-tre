# 02 — Workspace creation and system prompt injection

**What to build:** When a Pi session starts in a jj repo, the extension creates a jj workspace checked out from `trunk()` at the configured path (`~/.pi/sillajje/<repo>/<session-id>/` by default). On every `before_agent_start`, the extension injects the workspace path into the system prompt so the agent knows where to direct file operations. No path redirection or change stamping yet — the agent is aware of the workspace but its tools still operate in the original repo.

**Blocked by:** 01 — Scaffold, jj detection, and inactive no-op

**Status:** complete

**Implementation notes:**
- The `create` interface uses `ExecFn` adapter (injected) instead of `trunk()` — uses `@` (current working copy)
- Workspace root is loaded from `config.ts` (`.pi/configs/sillajje.json`) — `workspacesRoot` field, default `~/.pi/sillajje`

- [x] `workspace.ts` module with `create`, `exists`, `forget`, `cleanupWorkspace` + helpers
- [x] Workspace directory created at `<workspaces-root>/<repo-slug>/<session-id>/`
- [x] `jj workspace add` executed with correct name and path, based on `@`
- [x] `session_start` handler calls workspace creation when state transitions from inactive to active
- [x] `before_agent_start` handler injects workspace path into system prompt (appended to `event.systemPrompt`)
- [x] Workspace path uses session ID from `ctx.sessionManager.getSessionId()`
- [x] Workspace root is configurable via config file (`.pi/configs/sillajje.json` `workspacesRoot`), default `~/.pi/sillajje`
- [x] `~/.pi/sillajje/` directory created if it doesn't exist
- [x] Unit tests for `workspace.ts` with mocked `ExecFn` adapter
- [x] Integration test via ExtensionRunner: fires `session_start` in jj repo, asserts workspace directory exists on disk, asserts `jj workspace list` includes the new workspace
- [x] Integration test via ExtensionRunner: fires `before_agent_start`, asserts system prompt contains workspace path
