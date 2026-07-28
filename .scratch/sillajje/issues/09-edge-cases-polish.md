# 09 — Edge cases and polish

**What to build:** Error resilience and edge-case handling that makes the extension robust in non-happy-path scenarios. This is the cleanup slice after the main features are stable.

**Blocked by:** None strictly, but benefits from earlier slices being stable first (especially 07 — workspace environment, 04b — elapsed tracking).

**Status:** ready-for-agent

## Tasks

- [ ] **jj binary missing mid-session**: detect on `tool_call` or `agent_end` that `jj` is no longer on PATH, mark session stale, notify user with suggestion
- [ ] **Workspace directory deleted externally**: detect on next handler call (workspace path doesn't exist), mark session stale, notify user with suggestion to `/sillajje unarchive` or start new session
- [ ] **Session ID collision**: if two sessions somehow share an ID, the second should append a suffix to the workspace name and bookmark to avoid overwriting
- [ ] **Sub-generator failure handling**: if the sub-generator (issue 05) crashes or times out, fall back to placeholder subject + `[generation failed]` note, notify user (moved from old issue 07)
- [ ] **Consistent error surfacing**: audit all `try/catch` blocks to ensure errors produce `ctx.ui.notify` calls — no silent failures
- [ ] **Concurrent Pi processes**: document that each session gets its own workspace and jj handles concurrent operations natively (no code change needed, just note it)

### Already verified / done (not in scope)

- Steering does not create a new change → ✅ issue 04 integration tests
- Follow-ups create their own change → ✅ issue 04 integration tests
- Config loaded with defaults → ✅ config.ts
- Session_shutdown cleans unused workspaces → ✅ index.ts

## Tests

- [ ] Unit: workspace existence check returns false after external deletion
- [ ] Unit: SessionState transitions correctly on stale detection
- [ ] Integration: simulate workspace deletion during active session, assert stale notification
- [ ] Integration: simulate jj binary disappearance (mock), assert graceful fallback
