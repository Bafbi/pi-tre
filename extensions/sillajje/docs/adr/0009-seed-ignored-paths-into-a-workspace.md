# A session workspace seeds ignored paths from the launching checkout

ADR 0001 keeps every session workspace free of gitignored files, so a session cannot read `.env` or `mise.local.toml` without a manual copy. The project's `seed` list now names ignored paths that the workspace copies in from the checkout that launched the session, at creation and at unarchive. Copying, not symlinking, keeps ADR 0001's isolation: a session never writes into the user's checkout until asked. Seed paths stay invisible to jj, so no Seed enters a stamp, a Fold, or the session's own diff.

## Considered Options

**A `seed` config key with a `/sillajje:seed` command (chosen)** vs exposing the checkout root to `postInit` and letting a shell recipe copy. `postInit` runs only when `ensure` creates a workspace; it never runs on unarchive, and `pi.exec` takes no environment, so a recipe cannot name the source root. A recipe also cannot offer the divergence check that `--push` and `--pull` need.

**Copy (chosen)** vs symlink. A symlink lets an agent edit write through to the user's checkout and breaks ADR 0001's promise that a session leaves the repo untouched until a Fold lands. A symlinked path has no separate workspace copy, so it cannot offer a per-path divergence check.

**Explicit relative paths (chosen)** vs globs vs every ignored path. jj exposes no command that lists ignored paths (`jj file list` has no `--include-ignored`; `jj status` drops them), so glob support would be our own approximation of gitignore semantics, and "every ignored path" would copy `node_modules`, build output, and the pi caches into every workspace.

## Consequences

- A Seed record in the session log carries the source checkout root and each seeded path's hash. The divergence check survives a reload, and an unarchive re-seeds from the checkout the files came from, not from wherever the process was later launched.
- `/sillajje:seed` defaults to `-s @`, like the other session commands. A foreign session pushes to the source root recorded in its marker, which the current process has never seen.
- Seeding runs only when `ensure` reports `created`, never on `reused`. `ensure` runs on every `session_start`, so re-seeding on a reload would clobber the agent's edits to seeded files.
- Archive warns when a seeded path diverges and then proceeds, deleting the workspace. An unpushed edit to a seeded path is lost.
- Serve exposes seeded secrets, because it serves the whole workspace over HTTP on the LAN.
- This amends ADR 0001's "Gitignored files are absent from workspaces" consequence.
