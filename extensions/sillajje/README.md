# Sillajje

Auto-versioning for Pi agent sessions built on jj. Every agent interaction becomes a jj change, leaving a reviewable trail (a *sillage*) of all work done. See [CONTEXT.md](./CONTEXT.md) for the domain vocabulary and [docs/adr/](./docs/adr/) for the design decisions.

## Commands

All commands run as `/sillajje <subcommand>` from any conversation inside a sillajje repo.

### `status`

Reports the current session: lifecycle state, workspace path, and session ID.

### `archive`

Archives the current session: keeps the `sillajje/<session-id>` bookmark, deletes the workspace directory. An archived session accepts no prompts until unarchived.

### `unarchive <session-id>`

Recreates the workspace for an archived session.

### `stamp [-r | --rev <rev>] [-s | --session <id>] [-h | --help]`

Seals a change with a generated commit message. Exactly one target is required:

- **`-s @`** — a Session stamp on the current session: describes the workspace working copy, moves `sillajje/<session-id>`, and advances to a fresh empty change. The message comes from the diff alone.
- **`-r <rev>`** — a Rev stamp on any revision jj resolves (change ID, commit prefix, bookmark, `@`): describes that change only. No bookmark moves, no new change, and your session's pending interaction survives.
- **`-s <id>`** — a Session stamp on another live session's working copy, sealed through that session's own workspace. The message comes from the diff alone; the stamped change's metadata names the stamped session, not yours.

A target-less `/sillajje stamp` and `-h`/`--help` print this usage and take no action. `--rev` and `--session` are mutually exclusive. An unknown `-s` target reports "not a sillajje session"; a bookmark without a workspace reports "archived — unarchive it first".

The seal is transactional: if describe, bookmark, or the fresh change fails mid-seal, the repository ends unchanged. Empty-diff targets report `nothing to stamp` before any mutation.

### `rebase <rev> [--session <id>]`

Rebases the session working copy onto `<rev>` with a merge commit that brings the target into the session's ancestry. The session stays active.

### `fold <rev> [--session <id>]`

Collapses all session changes into one conventional-commit change on `<rev>`, then archives the session. The bookmark stays as sillage.

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
| `message.header` | `"one_line"` or `"user_prompt"` | `"one_line"` | Source of the commit header. |
| `message.body.trace.detail` | `"high"`, `"step"`, or `"decision"` | `"high"` | Detail level of the trace narrative. |

The `message.body` and `subGenerator` trees carry more toggles. See `sillajje-config.schema.json` for the full shape.

`SILLAJJE_POST_INIT` overrides `postInit` from either file. Split commands with `;`:

```bash
export SILLAJJE_POST_INIT="mise trust; mise deps"
```

Regenerate the committed schema after changing the config shape:

```bash
mise run //extensions/sillajje:generate-schema
```
