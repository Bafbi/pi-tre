# 04 — `/sillajje fold <rev>` subcommand

**What to build:** The `/sillajje fold <rev>` command. The user types `/sillajje fold main` and all of the session's interaction changes are collapsed into a single conventional-commit on the target revision, then the session is archived as a practical convenience. The session bookmark `sillajje/<session-id>` is left as a historical trail.

Additionally support `/sillajje fold <rev> --session <id>` to target a different active session.

**Blocked by:** 03 (rebase subcommand — the shared preamble helper will be extracted from 03's implementation)

**Status:** resolved

- [x] Extracts the shared preamble logic from ticket 03's inline code into a private helper used by both `rebase` and `fold` cases
- [x] `/sillajje fold <rev>` added as a case in the command handler switch
- [x] Reuses the same argument parsing, workspace resolution, session state detection, and `jj rebase` + conflict-check + `jj workspace update-stale` preamble
- [x] After shared preamble: runs `jj new <rev> --no-edit` to create an empty change on the target revision (this is `<rev>+`)
- [x] Runs `jj restore --from sillajje/<session_id> --to <rev>+` to copy all session content into the new change
- [x] Generates a conventional-commit subject via `generateManualHeader(diff, spawnFn, options)`, using `jj diff -r <rev>+` as the diff
- [x] Runs `jj describe -m <message>` on the new change
- [x] Archives the session: `cleanupWorkspace` + `state.setArchived()` + `state.clearWorkspacePath()` + `state.resetInteraction()` (only for current session)
- [x] The session bookmark `sillajje/<session_id>` is NOT deleted — it survives as sillage
- [x] Notifies success: the folded commit exists at `<rev>+` — the user chooses what to do next
- [x] Error handling: same cases as rebase (invalid rev, archived session, non-sillajje session, conflict)
- [x] All logging via `debug.event`, all user-facing messages guarded by `ctx.hasUI`
- [x] Integration tests: folded commit exists on `<rev>` with a conventional-commit subject line (via the `_testSpawnFn` seam), session state transitions to archived, workspace directory gone, bookmark survives, invalid rev, archived session, non-sillajje session (`--session` with no bookmark), conflict scenario
- [x] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)

## Answer

Implemented as a `fold` case in the command handler switch (`extensions/sillajje/src/index.ts`), reusing the shared preamble **extracted into the private `rebaseFoldPreamble` helper** (ticket 03's inline code was moved into it; the `rebase` case now calls it too — same behavior, verified by the unchanged rebase tests).

The PRD's literal fold steps required three empirical corrections (all verified against jj 0.43, documented in code):

1. **`jj restore --from` source is `@`, not the bookmark.** The session bookmark `sillajje/<id>` points at the last *stamped session change* — its tree lacks the upstream content the preamble rebase brought in. Restoring from the bookmark would produce a folded commit that drops/reverts upstream files (e.g. a session folded onto an advanced `main` would delete main's new files). The correct source is `@` — the merge commit created by the preamble (`jj new <rev> --no-edit` keeps the working copy at that merge, so `@` still resolves to it).
2. **`<rev>+` is ambiguous after the preamble.** The preamble's merge commit is itself a descendant of `<rev>`, so the `<rev>+` revset matches two commits. The folded change id is instead parsed from `jj new <rev> --no-edit` output (`Created new commit <change_id> ...` — jj prints status to **stderr**), and all subsequent steps (`restore --to`, `diff -r`, `describe -r`) reference it by id.
3. **`jj describe` needs `-r`** with `--no-edit` (the working copy isn't the folded change), so the describe targets the folded change id explicitly.

Fold steps: preamble → `jj new <rev> --no-edit` → `jj restore --from @ --to <foldId>` → `jj diff -r <foldId>` → `generateManualHeader` (same seam as `/sillajje stamp`, testable via `_testSpawnFn`) → `jj describe -r <foldId> -m <subject>` → archive (`cleanupWorkspace` + state transitions for the current session only) → notify `commit at <rev>+`. The bookmark survives as sillage; errors after `jj new` (restore/diff/describe failures) leave the empty `<rev>+` change behind — no rollback, surfaced via `fold_error` notify.

Tests: `test/integration/fold.test.ts` — 6 integration tests (fold current session: single-parent commit on `<rev>` with the mock subject, tree carries session + upstream content, session archived, workspace gone, input blocked, bookmark survives; `--session` targeting another active session; invalid rev; archived session; non-sillajje session; conflict scenario without folding/archiving). `mise //extensions/sillajje:check` passes (258 tests, no lint/typecheck issues in changed files).
