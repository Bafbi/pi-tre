# Sillajje

Auto-versioning for Pi agent sessions built on jj. Every agent interaction becomes a jj change, leaving a reviewable trail (a *sillage*) of all work done. See [CONTEXT.md](./CONTEXT.md) for the domain vocabulary and [docs/adr/](./docs/adr/) for the design decisions.

## Commands

All commands run as `/sillajje:<subcommand>` from any conversation inside a sillajje repo. The old space form (`/sillajje stamp`) is retired: typing it reports the colon command instead of running.

### `/sillajje:status`

Reports the current session: lifecycle state, workspace path, and session ID.

### `/sillajje:archive`

Archives the current session: keeps the `sillajje/<session-id>` bookmark, deletes the workspace directory. An archived session accepts no prompts until unarchived.

### `/sillajje:unarchive <session-id>`

Recreates the workspace for an archived session.

### `/sillajje:stamp [-r | --rev <rev>] [-s | --session <id>] [-h | --help]`

Seals a change with a generated commit message. Exactly one target is required:

- **`-s @`** — a Session stamp on the current session: describes the workspace working copy, moves `sillajje/<session-id>`, and advances to a fresh empty change. The message comes from the diff alone.
- **`-r <rev>`** — a Rev stamp on any revision jj resolves (change ID, commit prefix, bookmark, `@`): describes that change only. No bookmark moves, no new change, and your session's pending interaction survives.
- **`-s <id>`** — a Session stamp on another live session's working copy, sealed through that session's own workspace. The message comes from the diff alone; the stamped change's metadata names the stamped session, not yours.

A target-less `/sillajje:stamp` and `-h`/`--help` print this usage and take no action. `--rev` and `--session` are mutually exclusive. An unknown `-s` target reports "not a sillajje session"; a bookmark without a workspace reports "archived — unarchive it first".

The seal is transactional: if describe, bookmark, or the fresh change fails mid-seal, the repository ends unchanged. Empty-diff targets report `nothing to stamp` before any mutation.

### `/sillajje:sync [-s | --session <id>] -o | --onto <rev> [-h | --help]`

Brings `<rev>` into a session's ancestry as a merge, keeping the session's own history. `-s` defaults to `@` (this session). The session stays active. A file-level conflict aborts with the file list; a failed `update-stale` after a successful rebase is a warning.

### `/sillajje:fold (-s <id|@> | -r <rev>) -o <rev> [--land] [--archive] [-h | --help]`

Publishes a source range as one clean change placed as a child of `<rev>`, and appends: each fold adds one change, so a pull-request branch grows without a force-push. The source branch survives. `-s` defaults to `@`; `-s` and `-r` are mutually exclusive. `--land` advances the single local bookmark that `--onto` resolves to. `--archive` retires a session source after a successful fold. The body is a generated summary and a `Ref:` line — no `Meta:` and no `Loop:`.

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
| `vcsGuard` | boolean | `true` | Tell the agent to ask before running jj or git commands. |
| `actions.stamp.body` | section list | `["trace","meta","loop","prompt","response"]` | Ordered sections the stamp body renders. |
| `actions.stamp.header.mode` | `"one_line"` or `"user_prompt"` | `"one_line"` | Source of the commit header. |
| `actions.stamp.trace.detail` | `"high"`, `"step"`, or `"decision"` | `"high"` | Detail level of the trace narrative. |
| `actions.stamp.loop` | field list | `["tools","call_count","elapsed","thinking_blocks"]` | Fields the `Loop:` section renders. |
| `actions.fold.body` | section list | `["summary","ref"]` | Ordered sections the fold body renders. |
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
