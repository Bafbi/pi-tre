Status: ready-for-agent

# Sillajje — Rebase and Fold

## Problem Statement

A Pi user accumulates work in a sillajje session over many interactions. The session's jj changes branch off whatever revision `@-` was at session creation time. Days later, the upstream branch (e.g. `main`) has moved on. The user has no way to bring the upstream into the session without leaving Pi and running raw `jj` commands — breaking flow. They also have no way to collapse the session's many small interaction changes into a single clean commit suitable for landing in the upstream.

## Solution

Two new `/sillajje` subcommands — `rebase` and `fold` — that integrate a session's work with an upstream revision.

- **`/sillajje rebase <rev>`** syncs the session: rebases the session working copy onto `<rev>`, creating a merge commit that brings `<rev>` into the session's ancestry. The user can continue working in the session, now building on top of the updated base.

- **`/sillajje fold <rev>`** collapses all session changes into a single conventional-commit change on `<rev>`, then archives the session as a practical convenience. The session bookmark `sillajje/<session-id>` is left in place as a historical trail (sillage). The new folded change sits at `<rev>+` in the repo — the user is notified and can switch to it in their main checkout.

Both commands accept an optional `--session <id>` flag to target a non-current sillajje session, resolving the session's workspace via `jj workspace list`.

## User Stories

1. As a Pi user, I want to rebase my active sillajje session onto the latest `main`, so that my session's ancestry includes recent upstream changes and I can continue working on a current base.
2. As a Pi user, I want to fold all my session's interaction changes into a single clean conventional-commit on `main`, so that I can land my work without polluting the upstream history with dozens of micro-commits.
3. As a Pi user, I want the folded session to be automatically archived after folding, so that I don't accumulate stale workspaces after integrating work.
4. As a Pi user, I want the session bookmark to survive after folding, so that the original interaction history remains reviewable as sillage.
5. As a Pi user, I want to rebase or fold a session other than the current one by passing `--session <id>`, so that I can integrate sessions I'm not actively working in.
6. As a Pi user, I want a clear error message when I pass an invalid `<rev>`, so that I know what I typed wrong and can correct it.
7. As a Pi user, I want the command to abort with a clear message when the rebase produces file-level conflicts, so that I can resolve them manually before proceeding — rather than discovering conflict markers later during an agent interaction.
8. As a Pi user, I want a clear error message when I try to rebase or fold an archived session, so that I know I need to unarchive it first.
9. As a Pi user, I want the fold subcommand to produce a meaningful conventional-commit subject line via the same sub-generator used by `/sillajje stamp`, so that I get a descriptive commit message without writing one myself.
10. As a Pi user, I want to be notified where the folded commit lives (`<rev>+`), so that I can switch to it in my main checkout.
11. As a developer reviewing sillajje's command handler, I want `rebase` and `fold` to follow the same patterns as existing subcommands — `debug.event` logging, `ctx.ui.notify`, `ctx.hasUI` guard — so that the codebase stays consistent and maintainable.
12. As a Pi user, I want rebase and fold to reject input when the session is inactive (no jj, no repo, no workspace), so that I don't run commands that cannot possibly succeed.
13. As a Pi user targeting a non-current session, I want a clear error message when the session has no jj bookmark (`sillajje/<id>`), so that I know it's not a sillajje session and cannot be operated on.

## Implementation Decisions

### Two new subcommands on `/sillajje`

The existing command handler switch is extended with two cases: `rebase` and `fold` (replacing the originally-planned name "squash").

### Shared preamble

Both subcommands share the same preamble:

- Parse `<rev>` (positional) and `--session <id>` (optional flag) from the args string via a pure helper `parseRebaseFoldArgs(args)` returning `{ rev: string; sessionId?: string }`.
- Resolve workspace path: current session via `state.getWorkspacePath()`, named session via `getWorkspacePathByName()`.
- Determine session state: bookmark exists + workspace exists → active. Bookmark exists + no workspace → archived. No bookmark → not a sillajje session. Abort with appropriate notification for the latter two.
- Run `jj rebase -s @ -o <rev> -o sillajje/<session_id>` in the workspace. The `-o` flag is `--onto`; repeated, it creates a merge commit with `<rev>` and the session bookmark as parents.
- Detect file-level conflicts: after the rebase, run `jj resolve --list`. If the output is non-empty, abort + notify the user that conflicts exist.
- Run `jj workspace update-stale` in the workspace to sync the working copy.

### Rebase subcommand

Stops after the shared preamble. The session working copy `@` is now a merge commit bridging `<rev>` and the session history. The user may continue working in the session. No state transition occurs — the session remains active.

### Fold subcommand

After the shared preamble:

- Create a new empty change on `<rev>`: `jj new <rev> --no-edit`. This change is `<rev>+`.
- Copy all session content into the new change: `jj restore --from sillajje/<session_id> --to <rev>+`.
- Generate a conventional-commit subject line via `generateManualHeader(diff, spawnFn, options)` — the same sub-generator used by `/sillajje stamp`. The diff is obtained from `jj diff -r <rev>+`.
- Describe the new change: `jj describe -m <message>`.
- Archive the session: `cleanupWorkspace(exec, wsName, wsPath)` + `state.setArchived()` + `state.clearWorkspacePath()` + `state.resetInteraction()` (only when targeting the current session). The `sillajje/<session_id>` bookmark is intentionally not deleted — it remains as a historical trail.
- Notify success: the folded commit exists at `<rev>+`. The user chooses what to do next (e.g., switch their main checkout to it).

### Argument parser

A pure helper function, unit-testable in isolation:

```ts
interface RebaseFoldArgs {
  rev: string;
  sessionId?: string;
}

function parseRebaseFoldArgs(args: string): RebaseFoldArgs
```

The parser extracts the first positional token as `<rev>` and an optional `--session <id>` token. Unknown flags or extra tokens are ignored (consistent with the minimal parsing in existing subcommands).

### Session state detection for non-current sessions

Three states, determined from jj:

| Bookmark exists | Workspace exists | State | Action |
|:-:|:-:|---|---|
| No | — | Not a sillajje session | Abort |
| Yes | No | Archived | Abort |
| Yes | Yes | Active | Proceed |

Determined via `getWorkspacePathByName()` (returns `undefined` when no workspace found) and a new `bookmarkExists()` call (already exists in `workspace.ts`).

### Conflict detection

`jj rebase` exits 0 even when it creates file-level merge conflicts. The command must explicitly check: `jj resolve --list` after the rebase. Non-empty output means the working copy has unresolved conflicts → abort + notify with the conflict list so the user knows what files to resolve.

### Error handling pattern

All jj command failures use try-and-catch with the existing pattern: `debug.event` for logging, `ctx.ui.notify` for user-facing messages (guarded by `ctx.hasUI`). No pre-validation of `<rev>` — the rebase will fail with a non-zero exit, and the error is surfaced uniformly.

### Sub-generator seam

The `fold` subcommand uses `generateManualHeader` which respects the existing `_testSpawnFn` test seam. No changes to the sub-generator module are needed.

### New glossary terms

Two terms are added to the domain glossary:

- **Rebase**: sync/update — rebase the session working copy onto a target revision, creating a merge commit that brings the target into the session's ancestry. The session remains active afterward.
- **Fold**: collapse all session changes into a single new commit on a target revision. Produces a conventional-commit message via the sub-generator, then archives the session. The session bookmark is left as sillage.

## Testing Decisions

### What makes a good test

Tests exercise external behavior through the command handler seam — the same pattern as the existing archive integration tests. Tests create a real jj repo, simulate interactions to build session history with stamped changes, invoke the command handler, then assert jj state (bookmarks, changes, workspace structure) and extension state (lifecycle, notifications). Pure helpers are unit-tested with table-driven inputs/outputs.

### Modules tested

- **Unit (vitest)**: `parseRebaseFoldArgs` — table-driven tests for positional `rev`, optional `--session`, edge cases (empty string, missing rev, extra whitespace, repeated flags).
- **Integration (ExtensionRunner)**: The `sillajje` command handler, following the archive test pattern in `test/integration/archive.test.ts`. Tests for:
  - `rebase`: verify merge commit is created with correct parents, workspace is updated, session remains active
  - `fold`: verify a single squashed commit exists on `<rev>` with a conventional-commit subject, session is archived after, workspace directory is gone, bookmark survives
  - Error cases: invalid `<rev>`, archived session, non-sillajje session (`--session` with no bookmark), conflict scenario (requires setting up a conflicting change in the main repo before rebasing)

### Prior art

The archive integration tests (`test/integration/archive.test.ts`) use exactly this pattern: `createRunner` → `session_start` → `simulateInteraction` (to build history) → `cmd.handler("...", ctx)` → assert jj state and extension state. The rebase and fold tests follow the same structure.

## Out of Scope

- Resolving conflicts automatically — the user must resolve them manually
- Merging the folded commit into the user's main checkout — the user is notified and chooses what to do
- Deleting the session bookmark after folding — the bookmark is preserved as sillage
- Batch operations on multiple sessions
- Scheduling or automating rebase (e.g., on session start)
- A `--no-archive` flag on fold — archiving is always bundled for practicality

## Further Notes

- The original working title used "squash" instead of "fold." The term was changed during design to avoid confusion with jj's `jj squash` command (which squashes a descendant into its parent — a different operation).
- The fold operation creates the squashed commit inside the session workspace. Since jj workspaces share the same object store, the new change is visible from the main checkout — it just isn't the working copy there. The user must manually switch to it.
- The `jj rebase -s @ -o <rev> -o sillajje/<session_id>` command uses `-o` (short for `--onto`), which is a valid jj flag. When `-o` is repeated, jj creates a merge commit with multiple parents. This was validated against jj v0.28+.
