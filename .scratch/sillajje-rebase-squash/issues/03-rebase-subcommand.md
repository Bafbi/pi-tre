# 03 — `/sillajje rebase <rev>` subcommand

**What to build:** The `/sillajje rebase <rev>` command. The user types `/sillajje rebase main` and the session working copy is rebased onto the target revision as a merge commit. The session remains active — the user can continue working with the upstream now in the ancestry.

Additionally support `/sillajje rebase <rev> --session <id>` to target a different active session.

**Blocked by:** 02 (argument parser helper)

**Status:** resolved

- [x] `/sillajje rebase <rev>` added as a case in the command handler switch
- [x] Parses args via `parseRebaseFoldArgs` (from ticket 02)
- [x] Resolves workspace path: current session via `state.getWorkspacePath()`, named session via `getWorkspacePathByName()`
- [x] Detects session state: no bookmark → "not a sillajje session" abort; bookmark + no workspace → "session is archived" abort; bookmark + workspace → proceed
- [x] Runs `jj rebase -s @ -o <rev> -o sillajje/<session_id>` in the workspace
- [x] Runs `jj resolve --list` after rebase to detect file-level conflicts; non-empty output → abort + notify with conflict details
- [x] Runs `jj workspace update-stale` in the workspace on success
- [x] Error handling: invalid rev (non-zero exit from rebase), archived session, non-sillajje session — each with appropriate `ctx.ui.notify`
- [x] All logging via `debug.event`, all user-facing messages guarded by `ctx.hasUI`
- [x] Session state NOT modified — the session stays active after a successful rebase
- [x] Integration tests (matching `archive.test.ts` pattern): merge commit created with correct parents, workspace updated, session remains active, invalid rev, archived session, conflict scenario (create conflicting change in main repo before rebasing)
- [x] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)

## Answer

Implemented as a `rebase` case in the command handler switch (`extensions/sillajje/src/index.ts`), following the PRD's shared preamble inline (ticket 04 extracts it into a private helper). `parseRebaseFoldArgs` is fed the args *after* the `rebase` subcommand token — the handler's `args` string includes the subcommand itself (same convention as `archive`/`unarchive`).

Three deviations/corrections surfaced during implementation, all verified empirically against jj 0.43:

1. **Conflict detection is exit-code based, not output-based.** `jj resolve --list` prints `Error: No conflicts found at this revision` to *stderr* and exits 2 when there are no conflicts — so "non-empty output" alone would false-positive on every clean rebase. The implemented signal: exit 0 **and** non-empty stdout = conflicts exist → warning with the conflict paths. Documented in the code.
2. **`getWorkspacePathByName` was broken on jj 0.43.** `jj workspace list` no longer prints workspace paths (default format is `name: change_id commit_id (description)`), so the old `name: <path>` parsing returned garbage. Fixed in `workspace.ts` to render `name:root` explicitly via the `WorkspaceRef` template (`jj workspace list -T 'name ++ ":" ++ root ++ "\n"'`). This fix was required for `--session <id>` support and is covered by the unit tests.
3. **`args` includes the subcommand token.** The parser must see `main --session <id>`, not `rebase main --session <id>` — handled by stripping the first token before calling `parseRebaseFoldArgs`.

Tests: `test/integration/rebase.test.ts` — 6 integration tests (current-session merge with correct parents + session stays active + workspace synced, `--session` targeting a different active session, invalid rev, archived session, non-sillajje session, conflict scenario). Notifications asserted via a capturing UI mock (the shared `createRunner` discards them). `mise //extensions/sillajje:check` passes (252 tests, no lint/typecheck issues in changed files).
