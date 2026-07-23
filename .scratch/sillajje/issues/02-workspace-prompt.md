# 02 — Workspace creation and system prompt injection

**What to build:** When a Pi session starts in a jj repo, the extension creates a jj workspace checked out from `trunk()` at the configured path (`~/.pi/sillajje/<repo>/<session-id>/` by default). On every `before_agent_start`, the extension injects the workspace path into the system prompt so the agent knows where to direct file operations. No path redirection or change stamping yet — the agent is aware of the workspace but its tools still operate in the original repo.

**Blocked by:** 01 — Scaffold, jj detection, and inactive no-op

**Status:** ready-for-agent

- [ ] `workspace.ts` module with interface: `create(name, trunkRev, targetPath) → WorkspaceInfo`, `exists(name) → boolean`
- [ ] Workspace directory created at `<workspaces-root>/<repo-slug>/<session-id>/`
- [ ] `jj workspace add` executed with correct name and path, based on `trunk()`
- [ ] `session_start` handler calls workspace creation when state transitions from inactive to active
- [ ] `before_agent_start` handler injects workspace path into system prompt (appended to `event.systemPrompt`)
- [ ] Workspace path uses session ID from `ctx.sessionManager.getSessionId()`
- [ ] Workspace root is configurable via `sillajje.workspaces-root` (default: `~/.pi/sillajje`)
- [ ] `~/.pi/sillajje/` directory created if it doesn't exist
- [ ] Unit tests for `workspace.ts` with mocked jj CLI adapter (mock `execSync`/`spawn` — test that correct commands are constructed, test error paths)
- [ ] Integration test via ExtensionRunner: fires `session_start` in jj repo, asserts workspace directory exists on disk, asserts `jj workspace list` includes the new workspace
- [ ] Integration test via ExtensionRunner: fires `before_agent_start`, asserts system prompt contains workspace path
