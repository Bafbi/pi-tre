## Question

Implement the `rebase` and `fold` subcommands in the `/sillajje` command handler (`extensions/sillajje/src/index.ts`), plus integration tests.

*Note: "squash" renamed to "fold" during design grilling — `jj squash` is a different operation and "fold" better describes collapsing session history into a single commit.*

**Shared logic (both commands):**
- Parse `<rev>` (positional) and `--session <id>` (optional flag) from the args string
- Resolve workspace path: current session via `state.getWorkspacePath()`, other sessions via `getWorkspacePathByName()`
- Guard: abort if session is archived, rev is invalid, no workspace found
- Run `jj rebase -s @ -o <rev> -o sillajje/<session_id>` in the workspace
- Detect conflict (non-zero exit) → abort + notify user with stderr
- Run `jj workspace update-stale` in the workspace

**`rebase` subcommand:**
- Stops after the shared rebase + update-stale. Notifies success.

**`fold` subcommand (originally "squash"):**
- After shared rebase: `jj new <rev> --no-edit` to create a new empty change on `<rev>`
- `jj restore --from sillajje/<session_id> --to <rev>+` to squash session content into the new change
- Generate a conventional-commit message via `generateManualHeader(diff, spawnFn, options)` (same sub-generator as `/sillajje stamp`), using `jj diff -r <rev>+` as the diff
- `jj describe -m <message>` on the new change
- Archive the session via the existing archive logic (`cleanupWorkspace` + state transition)
- Notify success

**Integration tests:**
- `rebase`: verify merge commit is created, workspace is updated
- `fold`: verify folded commit exists on `<rev>`, session is archived after
- Error cases: invalid rev, archived session, conflict scenario (via `jj resolve --list`)
- Non-current session: test `--session <id>` targeting a different active session

Use existing patterns: `debug.event` logging, `ctx.ui.notify` for user feedback, `ctx.hasUI` guard.

## Design decisions (from grilling)

- `jj rebase -s @ -o <rev> -o sillajje/<session_id>` — valid jj syntax (`-o` = `--onto`; repeated creates merge commit)
- Conflict detection: `jj resolve --list` after rebase (non-zero exit alone doesn't catch file-level conflicts)
- Session state detection for `--session <id>`: bookmark + workspace = active; bookmark only = archived; no bookmark = not a sillajje session
- Button after fold: notify user (`<rev>+` exists), user chooses what to do
- Bookmark survives fold (left as sillage)
- Argument parser: minimal manual parser, pure helper, unit-testable
- `--session` defaults to current session
- See PRD.md for full spec
