## Question

Implement the `rebase` and `squash` subcommands in the `/sillajje` command handler (`extensions/sillajje/src/index.ts`), plus integration tests.

**Shared logic (both commands):**
- Parse `<rev>` (positional) and `--session <id>` (optional flag) from the args string
- Resolve workspace path: current session via `state.getWorkspacePath()`, other sessions via `getWorkspacePathByName()`
- Guard: abort if session is archived, rev is invalid, no workspace found
- Run `jj rebase -s @ -o <rev> -o sillajje/<session_id>` in the workspace
- Detect conflict (non-zero exit) → abort + notify user with stderr
- Run `jj workspace update-stale` in the workspace

**`rebase` subcommand:**
- Stops after the shared rebase + update-stale. Notifies success.

**`squash` subcommand:**
- After shared rebase: `jj new <rev> --no-edit` to create a new empty change on `<rev>`
- `jj restore --from sillajje/<session_id> --to <rev>+` to squash session content into the new change
- Generate a conventional-commit message via `generateManualHeader(diff, spawnFn, options)` (same sub-generator as `/sillajje stamp`), using `jj diff -r <rev>+` as the diff
- `jj describe -m <message>` on the new change
- Archive the session via the existing archive logic (`cleanupWorkspace` + state transition)
- Notify success

**Integration tests:**
- `rebase`: verify merge commit is created, workspace is updated
- `squash`: verify squashed commit exists on `<rev>`, session is archived after
- Error cases: invalid rev, archived session, conflict scenario

Use existing patterns: `debug.event` logging, `ctx.ui.notify` for user feedback, `ctx.hasUI` guard.
