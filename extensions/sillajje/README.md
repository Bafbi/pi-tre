# Sillajje

Auto-versioning for Pi agent sessions built on jj. Every agent interaction becomes a jj change, leaving a reviewable trail (a *sillage*) of all work done. See [CONTEXT.md](./CONTEXT.md) for the domain vocabulary and [docs/adr/](./docs/adr/) for the design decisions.

## Commands

All commands run as `/sillajje:<subcommand>` from any conversation inside a sillajje repo. The old space form (`/sillajje stamp`) is retired: typing it reports the colon command instead of running.

### `/sillajje:status`

Reports the current session: lifecycle state, workspace path, and session ID.

### `/sillajje:archive [-s | --session <id>] [-h | --help]`

Archives a session: keeps the `sillajje/<session-id>` bookmark, deletes the workspace directory. An archived session accepts no prompts until unarchived. `-s` defaults to `@` (this session). A foreign session is rejected.

### `/sillajje:unarchive [-s | --session <id>] [-h | --help]`

Recreates the workspace for an archived session. `-s` defaults to `@` (this session), so a bare `/sillajje:unarchive` restores the session you are in. A foreign session, or one whose workspace is still live, is rejected.

### `/sillajje:seed [-s | --session <id>] [--push | --pull] [--force] [-h | --help]`

Reports the ignored paths a session's workspace copied in from the checkout that launched it, and moves edits in either direction. `-s` defaults to `@` (this session).

- **bare** — lists each seeded path and whether it changed in the workspace, in the checkout, or both.
- **`--push`** — copies workspace edits back to the source checkout.
- **`--pull`** — refreshes the workspace copies from the checkout.
- **`--force`** — overwrites a path that moved on both sides. Requires `--push` or `--pull`.

`--push` and `--pull` are mutually exclusive. Neither ever deletes a file on the other side; a path missing on the destination side is created from the surviving side. A successful move advances the session's Seed record, so the next move is measured against the synced content.

The `seed` list lives in the project config. A path already present in the workspace is skipped, so a tracked file and the agent's edits survive. A seeded path stays invisible to jj: it never enters a stamp or a fold. Serve exposes the whole workspace, so a served session exposes its seeded secrets.

### `/sillajje:new [-o | --onto <rev>] [-s | --onto-session <id>] [-h | --help]`

Starts a new pi session whose workspace branches from a chosen base instead of `trunk()`. The new session has fresh history; the workspace tree carries the continuity.

- **bare** — when a session exists, same as `-s @`: continues from this session's last seal. With no session the parser prints this usage. Use pi's `/new` to start from `trunk()`.
- **`-o <rev>`** — branches from a revision jj resolves. `-o @` uses the current workspace's working copy, so unsealed work seeds the new session.
- **`-s <id>`** — branches from a session's `sillajje/<session-id>` bookmark (the last seal). `-s @` uses this session. An archived session works; a foreign one does not; a conflicted bookmark is rejected.

`-o` and `-s` are mutually exclusive. `-o @` with no live sillajje session reports an error and starts nothing; `-s @` resolves the current session's key and can use its surviving bookmark even after the session is archived. The base is resolved to a commit id when the workspace is created, so moving the source bookmark later does not move the new session.

### `/sillajje:stamp [-r | --rev <rev>] [-s | --session <id>] [-h | --help]`

Seals a change with a generated commit message. Exactly one target is required:

- **`-s @`** — a Session stamp on the current session: describes the workspace working copy, moves `sillajje/<session-id>`, and advances to a fresh empty change. The message comes from the diff alone. A bare `/sillajje:stamp` means `-s @` in a session.
- **`-r <rev>`** — a Rev stamp on any revision jj resolves (change ID, commit prefix, bookmark, `@`): describes that change only. No bookmark moves, no new change, and your session's pending interaction survives.
- **`-s <id>`** — a Session stamp on another live session's working copy, sealed through that session's own workspace. The message comes from the diff alone; the stamped change's metadata names the stamped session, not yours.

A bare `/sillajje:stamp` is `-s @` when a session exists. With no session, and for `-h`/`--help`, it prints this usage and takes no action. `--rev` and `--session` are mutually exclusive. An unknown `-s` target reports "not a sillajje session"; a bookmark without a workspace reports "archived — unarchive it first".

The seal is transactional: if describe, bookmark, or the fresh change fails mid-seal, the repository ends unchanged. Empty-diff targets report `nothing to stamp` before any mutation.

### `/sillajje:sync [-s | --session <id>] -o | --onto <rev> [-h | --help]`

Brings `<rev>` into a session's ancestry as a merge, keeping the session's own history. `-s` defaults to `@` (this session). The session stays active. A file-level conflict aborts with the file list; a failed `update-stale` after a successful rebase is a warning.

### `/sillajje:fold (-s <id|@> | -r <rev>) -o <rev> [--named [<branch>]] [--update [<bookmark>]] [--push] [--archive] [--exclude <path>] [--no-marker] [-h | --help]`

Publishes a source delta as one clean change, and appends: each fold adds one change, so a pull-request branch grows without a force-push. `-o <rev>` names the target the folded change is placed under. A fold records a Folded source marker at `slj/f/<dest>/<source>` when it names a destination (`--named`) or advances one (`--update`), and bases on the tip-most recorded tip that is an ancestor of the source, so a later fold publishes only the work since the last one; when no marker applies it bases on `fork_point(source, target)`. `<dest>` is the named branch or the `--update` bookmark — the two flags are mutually exclusive, and a plain `-o` records no marker. `<source>` is the session key for a session source, or the source bookmark (else the tip's change id) for a rev source. One marker per source, so concurrent sources never share a cursor; the lookup is by ancestry, so a handoff or a renamed source still finds its predecessor's marker. `--named [<branch>]` names the folded change with a bookmark — empty names it `fold-<change id>`. `--update [<bookmark>]` advances the target's single local bookmark, or the given one; a target with several bookmarks and no value is a usage error asking for `--update <bookmark>`. `--push` pushes the advanced bookmark to the remotes that track it, best-effort, before `--archive`. `--archive` retires a session source after a successful fold. `--no-marker` ignores the store and records none. `--exclude <path>` (repeatable) leaves paths out of the published change: each value is a workspace-relative path prefix or glob, such as `.scratch/` or `*.lock`. jj's `prefix-glob` matching applies, so `*.lock` matches only at the workspace root and `**/*.lock` matches at any depth. The excluded paths stay in the source and in the session log, and the Folded source marker still records the source tip, so no later fold from that review branch publishes them either. The fold reports the exclusion, and a delta whose remaining paths are empty is a `no-changes` no-op. `-s` defaults to `@`; `-s` and `-r` are mutually exclusive. The body is a generated summary, a `Ref:` line, and — when paths were excluded — a `Skipped:` line with them; no `Meta:` and no `Loop:`.

## Configuration

Sillajje reads one config file per layer:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/configs/sillajje.json` |
| Project | `<repo-root>/.pi/configs/sillajje.json` |

The project config wins per key. Sillajje reads it only when pi trusts the project, because `postInit` runs shell commands.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `debug` | boolean | `false` | Write debug events to the sillajje log. |
| `workspacesRoot` | string | `~/.pi/sillajje` | Root directory for session workspaces. |
| `subGeneratorModel` | string | `openai/gpt-4o-mini` | Model for the header and trace sub-generators. |
| `postInit` | string[] | `[]` | Shell commands to run after workspace creation. |
| `seed` | string[] | `[]` | Workspace-relative ignored paths copied from the launching checkout at creation and unarchive. |
| `vcsGuard` | boolean | `true` | Tell the agent to ask before running jj or git commands. |
| `actions.stamp.body` | section list | `["trace","meta","loop","prompt","response"]` | Ordered sections the stamp body renders. |
| `actions.stamp.header.mode` | `"one_line"` or `"user_prompt"` | `"one_line"` | Source of the commit header. |
| `actions.stamp.trace.detail` | `"high"`, `"step"`, or `"decision"` | `"high"` | Detail level of the trace narrative. |
| `actions.stamp.loop` | field list | `["tools","call_count","elapsed","thinking_blocks"]` | Fields the `Loop:` section renders. |
| `actions.fold.body` | section list | `["summary","ref","skipped"]` | Ordered sections the fold body renders. |
| `actions.fold.summary.detail` | `"high"`, `"step"`, or `"decision"` | `"high"` | Detail level of the fold summary. |

The `actions` and `subGenerator` trees carry more toggles. See `sillajje-config.schema.json` for the full shape.

`SILLAJJE_POST_INIT` overrides `postInit` from either file. Split commands with `;`:

```bash
export SILLAJJE_POST_INIT="mise trust; mise deps"
```

Regenerate the committed schema after changing the config shape:

```bash
mise run //extensions/sillajje:generate-schema
```
