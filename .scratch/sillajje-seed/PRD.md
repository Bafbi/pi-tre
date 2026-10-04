# Sillajje Seed — PRD

Status: ready-for-agent

A session Workspace copies the ignored paths a project names in its `seed`
config from the launching checkout, so a session can read `.env`,
`mise.local.toml`, and `.local/` without a manual copy. A `/sillajje:seed`
command lists the seeded paths and moves edits in either direction with a
divergence check.

## Problem Statement

A sillajje Workspace is a clean checkout of the Base tree. jj never
materializes a gitignored file, so a session starts without the local files a
project needs to run: no `.env`, no `mise.local.toml`, no `.local/`. The agent
either works around the missing file or asks the user to copy it in.

The only existing fix is a shell command in `postInit`. It is not enough:

- `postInit` runs only when `ensure` creates a Workspace. It never runs on
  Unarchive, so a restored session again lacks the files.
- The command cannot name the launching checkout. `pi.exec` takes no
  environment and the extension supplies none, so a recipe must hardcode an
  absolute path that differs per clone.
- It has no divergence check. The user copies a file in, the agent edits the
  Workspace copy, and the user must remember to copy it back before Archiving
  deletes the Workspace. Copying back unconditionally can also overwrite a
  change the user made in the checkout while the session ran.

A Seed path stays invisible to jj, so it never lands in a stamp, a Fold, or
`jj diff`. There is no VCS path back; getting a change back is a plain file
copy, which is exactly the operation that needs the divergence check.

## Solution

The project config gains a `seed` list of workspace-relative paths. The
Workspace copies each listed path from the checkout that launched the session,
at creation and at Unarchive. A directory copies recursively. The copy never
overwrites a path already in the Workspace, so a tracked file and the agent's
edits to a seeded file survive.

The session log carries a Seed record: the source checkout root and a hash per
seeded path. The record is what lets a later command decide whether either
side moved.

`/sillajje:seed` reads that record. A bare command lists the seeded paths and
whether each diverged. `--push` copies Workspace edits back to the source
checkout; `--pull` refreshes the Workspace copy from the checkout. Each refuses
a path the other side changed, and `--force` overrides the refusal. Archive
warns, naming the diverged paths, then proceeds.

## User Stories

1. As a pi user, I want to name ignored paths in the project config, so that
   every session Workspace has my `.env` and `mise.local.toml` without a manual
   copy.
2. As a pi user, I want the copy to run when the Workspace is created, so the
   agent can read the files from its first prompt.
3. As a pi user, I want the copy to run on Unarchive, so a restored session has
   the same local files.
4. As a pi user, I want a directory entry to copy recursively, so a `.local/`
   tree comes across whole.
5. As a pi user, I want the copy to skip a path already present in the
   Workspace, so a tracked file is never overwritten.
6. As a pi user, I want a reload or resume not to re-run the copy, so it never
   clobbers an edit the agent made to a seeded file.
7. As a pi user, I want a seed entry that does not exist in the checkout to be
   a no-op, so one list works across clones and machines.
8. As a pi user, I want a bad seed entry reported, so I can fix the config.
9. As a pi user, I want the seed list to work in the global and project config
   layers, so I can carry a personal list and let a repo carry its own.
10. As a pi user, I want an untrusted project's seed list not to be read, so a
    repo I have not trusted cannot direct a copy out of my checkout.
11. As an agent, I want the seeded files present in the Workspace, so I can run
    the project's local setup and tests.
12. As a pi user, I want `/sillajje:seed` to list the seeded paths and whether
    each diverged, so I can see the state before moving anything.
13. As a pi user, I want `--push` to copy my Workspace edits back to the source
    checkout, so work on a local config is not lost.
14. As a pi user, I want `--push` to refuse a path the checkout also changed,
    so I do not silently overwrite the checkout.
15. As a pi user, I want `--pull` to refresh the Workspace copy from the
    checkout, so a config change I made in the checkout reaches a live session.
16. As a pi user, I want `--pull` to refuse a path the agent edited, so a
    refresh does not discard session work.
17. As a pi user, I want `--force` to override a refusal, so I can resolve a
    divergence I have judged.
18. As a pi user, I want a refusal to name the diverged path, so I can decide.
19. As a pi user, I want `/sillajje:seed -s <id>` to target another session,
    like the other subcommands, so I can push from the session I am in.
20. As a pi user, I want a foreign session's `--push` to target the checkout
    recorded in its Seed record, so a resumed session dragged to another clone
    still pushes to the right place.
21. As a pi user, I want Archive to warn, naming the diverged paths, before it
    deletes the Workspace, so I know what an unpushed edit would lose.
22. As a pi user, I want a seeded path deleted in the Workspace to be reported,
    not deleted from the checkout, so a push never destroys a checkout file.
23. As a pi user, I want the seeded files to stay invisible to jj, so they
    never appear in a stamp, a Fold, or `jj diff`.
24. As a pi user, I want the copies, not symlinks, so the agent never writes
    through to my checkout.
25. As a pi user, I want the copy to work when the Source checkout is gone, so
    I can Unarchive a session from another clone; the copy then falls back to
    the current checkout root.
26. As a pi user, I want `/sillajje:seed -h` to print usage, like the other
    commands.
27. As a pi user, I want a bare `/sillajje:seed` with no seed list or no record
    to say so, so I know the feature is not configured for this session.

## Implementation Decisions

**Modules.** The config schema lives in `@pi-tre/sillajje-core` (the config
schema owner). The copy itself is a capability on the `Workspaces` port in
`@pi-tre/sillajje-workspace`, which already owns the Workspace directory. The
Seed record, the config wiring, the Archive warning, and the command live in
the sillajje extension adapter, beside the existing Base marker.

**Config.** A `seed` key: a list of workspace-relative path strings, default
empty. It is a normal config key, so the global layer and the project layer
both carry it (arrays replace, project wins) and the shared loader's trust gate
applies: the project layer is read only when the project is trusted. No new
trust rule.

**The copy.** For each entry, resolve the path under the source checkout, then
copy it under the Workspace. A missing source path is reported and skipped. A
destination path that already exists is skipped: a tracked path is already
materialized in the Workspace, and a seeded file is already copied, so
existence is the guard. There is no `jj file list` call and no new `Jj`
boundary verb. A directory merges; existing files inside it are skipped
individually. The copy never deletes.

**The Seed record.** A custom session-log entry, `sillajje/seed`, written when
a copy runs. It carries the source checkout root and a SHA-256 hash per seeded
file path, taken after the copy. It is read the way the Base marker is read
(`sillajje/base`): scan the branch for the newest entry of the type. No
Workspace-package state.

**When the copy runs.** After `ensure` reports `created`, never on `reused`,
because `ensure` runs on every `session_start` and re-seeding there would
clobber the agent's edits on every resume. Unarchive seeds explicitly after it
rebuilds the Workspace, reading the recorded source root. If the recorded root
is gone, Unarchive falls back to the current checkout root and warns.

**The command.** `/sillajje:seed [-s|--session <id>] [--push|--pull] [--force]
[-h|--help]`. `-s` defaults to `@`. `--push` and `--pull` are mutually
exclusive; `--force` requires one of them. A foreign target resolves the Seed
record from that session's log; `--push` writes to the root recorded there.

**Push and pull.** Both compare the current hash of a path on each side to the
hash in the Seed record.

| | writes | refuses when | `--force` |
|---|---|---|---|
| `--push` | Workspace → source checkout | the source hash also moved since the seed | overwrite the source |
| `--pull` | source checkout → Workspace | the Workspace hash moved since the seed | overwrite the Workspace |

A path missing on the source side is reported and left alone. A path missing
on the destination side is created from the source, so a deleted checkout file
returns on `--push` and a deleted Workspace file returns on `--pull`. No move
ever deletes a file on the other side. A path that moved on neither side is
unchanged. The Outcome names each moved, refused, created, and missing path.

**Archive.** Archive lists the seeded paths whose Workspace hash differs from
the record, warns, and proceeds. It does not push.

**Serve.** Serve is unchanged. Serving a Workspace exposes its seeded secrets,
because it serves the whole Workspace over HTTP; this is a documentation
consequence, not a code change.

## Testing Decisions

Test external behavior only: the files that land on disk, the Seed record in
the session log, the notifications, and the jj state. Do not assert on internal
function calls.

**One seam: the extension integration harness.** Drive a real jj repo through
the existing `createRunner` + `runner.emit({ type: "session_start" })` flow,
with the `seed` list written to the project config file, and invoke
`/sillajje:seed` through `runSillajje`. The harness already creates a real
Workspace directory and runs real jj and real fs, so no new seam is introduced.
The existence guard keeps `jj file list` out of the implementation, so it needs
no second seam.

Cases to cover at that seam:

- A listed ignored file is copied into the Workspace at creation, and its Seed
  record appears in the session log.
- A listed ignored directory is copied recursively, including new files that
  appear inside it later.
- A listed tracked path is not overwritten, and the base-tree content survives.
- A missing source path is a no-op with a report.
- A second `session_start` (reused Workspace) does not re-copy, so an edit to a
  seeded file survives a reload.
- `--push` copies an edited Workspace file to the checkout; it refuses when the
  checkout's copy also moved; `--force` overwrites.
- `--pull` refreshes the Workspace file from the checkout; it refuses when the
  Workspace copy moved; `--force` overwrites.
- A path deleted on one side is reported and not deleted on the other.
- `-s <id>` targets another session, and a foreign session's push writes to its
  recorded source root.
- Archive warns, naming a diverged path, and still deletes the Workspace.
- Unarchive re-copies from the recorded source root, and falls back to the
  current root with a warning when it is gone.
- `-h` prints usage; a bare command with no record says so.
- The seeded file does not appear in `jj status` or `jj diff` for the session.

**Prior art.** `test/integration/workspace.test.ts` (creation, real Workspace
path, `jj workspace list`), `test/integration/post-init.test.ts` (project config
file, notification assertions), `test/integration/archive.test.ts` (Archive and
Unarchive lifecycle), `test/integration/new-session.test.ts` (session-log
marker read across a reload).

**Schema.** Regenerate the committed `sillajje` config schema after the key is
added, through the extension's schema task. The existing config unit tests
cover the loader's defaults and trust gate.

## Out of Scope

- Glob patterns, per-entry excludes, or any gitignore matching. Entries are
  explicit paths.
- A symlink mode. The copy is always a copy.
- Seeding files the agent creates outside the seed list. Only listed paths are
  tracked and moved.
- Pushing automatically on Archive. Archive warns and deletes.
- Changing Serve to exclude seeded paths.
- Seeding on a reused Workspace or on a mid-session reload.
- A command path to add a seed entry ad hoc, outside the config.
- Any cross-machine or cross-clone sync. The record names a filesystem path.

## Further Notes

- The domain term is **Seed**, defined in `extensions/sillajje/CONTEXT.md`,
  kept distinct from the Fold's **Excluded paths**.
- The decision and its rejected alternatives are in
  `extensions/sillajje/docs/adr/0009-seed-ignored-paths-into-a-workspace.md`,
  which amends ADR 0001's "Gitignored files are absent from workspaces"
  consequence.
- The README needs the command section, the config-table row, and the note that
  Serve exposes seeded secrets.
