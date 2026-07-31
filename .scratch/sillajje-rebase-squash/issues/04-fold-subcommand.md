# 04 — `/sillajje fold <rev>` subcommand

**What to build:** The `/sillajje fold <rev>` command. The user types `/sillajje fold main` and all of the session's interaction changes are collapsed into a single conventional-commit on the target revision, then the session is archived as a practical convenience. The session bookmark `sillajje/<session-id>` is left as a historical trail.

Additionally support `/sillajje fold <rev> --session <id>` to target a different active session.

**Blocked by:** 03 (rebase subcommand — the shared preamble helper will be extracted from 03's implementation)

**Status:** ready-for-agent

- [ ] Extracts the shared preamble logic from ticket 03's inline code into a private helper used by both `rebase` and `fold` cases
- [ ] `/sillajje fold <rev>` added as a case in the command handler switch
- [ ] Reuses the same argument parsing, workspace resolution, session state detection, and `jj rebase` + conflict-check + `jj workspace update-stale` preamble
- [ ] After shared preamble: runs `jj new <rev> --no-edit` to create an empty change on the target revision (this is `<rev>+`)
- [ ] Runs `jj restore --from sillajje/<session_id> --to <rev>+` to copy all session content into the new change
- [ ] Generates a conventional-commit subject via `generateManualHeader(diff, spawnFn, options)`, using `jj diff -r <rev>+` as the diff
- [ ] Runs `jj describe -m <message>` on the new change
- [ ] Archives the session: `cleanupWorkspace` + `state.setArchived()` + `state.clearWorkspacePath()` + `state.resetInteraction()` (only for current session)
- [ ] The session bookmark `sillajje/<session_id>` is NOT deleted — it survives as sillage
- [ ] Notifies success: the folded commit exists at `<rev>+` — the user chooses what to do next
- [ ] Error handling: same cases as rebase (invalid rev, archived session, non-sillajje session, conflict)
- [ ] All logging via `debug.event`, all user-facing messages guarded by `ctx.hasUI`
- [ ] Integration tests: folded commit exists on `<rev>` with a conventional-commit subject line (via the `_testSpawnFn` seam), session state transitions to archived, workspace directory gone, bookmark survives, invalid rev, archived session, non-sillajje session (`--session` with no bookmark), conflict scenario
- [ ] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)
