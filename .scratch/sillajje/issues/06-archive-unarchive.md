# 06 — Archive and unarchive command

**What to build:** The `/sillajje` command gains `archive` and `unarchive` subcommands alongside the existing `status`. Archiving a session deletes its workspace directory and runs `jj workspace forget`, keeping the bookmark for traceability. Unarchiving recreates the workspace via `jj workspace add` and restores the checkout. An archived session blocks user prompts via the `input` event handler, showing a clear notification. The `status` subcommand reports the full session state: active/archived/inactive, workspace path, and bookmark name.

**Blocked by:** None — can start immediately. All prerequisite event wiring (session_start, tool_call, input) is in place.

**Status:** ready-for-agent

- [ ] `/sillajje status` reports: session state (active/archived/inactive), workspace path, bookmark name, workspace directory existence
- [ ] `/sillajje archive [session-id]` (defaults to current): deletes workspace directory via `rm -rf`, runs `jj workspace forget <name>`
- [ ] `/sillajje unarchive <session-id>`: runs `jj workspace add --name sillajje-<id> --revision sillajje/<id> <path>`, restores system prompt injection and handler state
- [ ] Archiving the current session is allowed — the session enters archived state immediately
- [ ] `input` event handler blocks prompts when state is archived, returns `{ action: "handled" }` with a notification explaining how to unarchive
- [ ] Archive keeps the bookmark `sillajje/<session-id>` — it is never deleted
- [ ] Unarchive validates: bookmark must exist, workspace path must be free (or already a valid workspace)
- [ ] Session state transitions correctly: active → archived, archived → active
- [ ] Unit tests for `workspace.ts` archive/unarchive methods with mocked jj CLI
- [ ] Unit tests for state machine transitions (archive, unarchive, double-archive guard)
- [ ] Integration test via ExtensionRunner: create active session → archive via command → assert workspace directory is gone, assert bookmark still exists, assert prompt is blocked
- [ ] Integration test via ExtensionRunner: unarchive via command → assert workspace directory is recreated, assert system prompt is re-patched, assert prompts are allowed again
- [ ] Integration test via ExtensionRunner: `/sillajje status` returns correct state for active and archived sessions
