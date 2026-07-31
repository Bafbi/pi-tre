# 03 — `/sillajje rebase <rev>` subcommand

**What to build:** The `/sillajje rebase <rev>` command. The user types `/sillajje rebase main` and the session working copy is rebased onto the target revision as a merge commit. The session remains active — the user can continue working with the upstream now in the ancestry.

Additionally support `/sillajje rebase <rev> --session <id>` to target a different active session.

**Blocked by:** 02 (argument parser helper)

**Status:** ready-for-agent

- [ ] `/sillajje rebase <rev>` added as a case in the command handler switch
- [ ] Parses args via `parseRebaseFoldArgs` (from ticket 02)
- [ ] Resolves workspace path: current session via `state.getWorkspacePath()`, named session via `getWorkspacePathByName()`
- [ ] Detects session state: no bookmark → "not a sillajje session" abort; bookmark + no workspace → "session is archived" abort; bookmark + workspace → proceed
- [ ] Runs `jj rebase -s @ -o <rev> -o sillajje/<session_id>` in the workspace
- [ ] Runs `jj resolve --list` after rebase to detect file-level conflicts; non-empty output → abort + notify with conflict details
- [ ] Runs `jj workspace update-stale` in the workspace on success
- [ ] Error handling: invalid rev (non-zero exit from rebase), archived session, non-sillajje session — each with appropriate `ctx.ui.notify`
- [ ] All logging via `debug.event`, all user-facing messages guarded by `ctx.hasUI`
- [ ] Session state NOT modified — the session stays active after a successful rebase
- [ ] Integration tests (matching `archive.test.ts` pattern): merge commit created with correct parents, workspace updated, session remains active, invalid rev, archived session, conflict scenario (create conflicting change in main repo before rebasing)
- [ ] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)
