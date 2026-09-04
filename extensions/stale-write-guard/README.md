# stale-write-guard

Pi extension that prevents stale file mutations.

## Goal

If a file changed since the agent last read it, block `edit`/`write` and force a fresh `read` first.

This reduces accidental overwrite when files are modified externally.

## Behavior

- **Existing file + no fresh read** -> block mutation
- **Existing file + read is stale** -> block mutation
- **Existing file + read is fresh** -> allow mutation
- **Non-existing file (new write)** -> allow mutation

### Content injected without a read tool call

Two pi paths put file content into context without a `tool_result`, so a
plain read record never exists:

- `/skill:name` expansion injects the skill file's body into the prompt as
  a `<skill name="..." location="...">` block.
- Session-start context files (`AGENTS.md`, `AGENTS.override.md`,
  `CLAUDE.md`) land in the system prompt.

On `before_agent_start`, the guard records these files too — but only when
the disk file still holds the injected content. A stale context file
records nothing and stays blocked, so an external edit is never whitelisted
by an old prompt.

Prompt templates (`/template:name`) also expand without a `tool_result`,
but their expansion carries no file path, so the guard records nothing for
them.

## State

The filesystem records when a file changed (mtime), but not whether the
agent has read that version. So the extension keeps one number per file:
the mtime the agent last saw. A successful `read`, `write`, or `edit`
result updates it. State is in memory and resets on session start.

## Dump command

```text
/stale-write-guard-dump
```

Writes a report into the editor text: every tracked file with its current
mtime, last seen mtime, and the allow/block decision the guard would make
right now.

## Install

### From repo package (when GitHub repo is live)

```bash
pi install git:github.com/Bafbi/pi-tre
```

### One-off from local checkout

```bash
pi -e ./extensions/stale-write-guard/src/index.ts
```

## Dev

From repo root:

```bash
mise run check
mise run test
```

Relevant code:
- `src/index.ts` (event wiring + dump command)
- `src/guard.ts` (stale decision logic)
- `src/path.ts` (path canonicalization)
- `src/injected.ts` (content injected without a read tool call)

## Load order

The guard must load after sillajje (see AGENTS.md). Keep it last in the
`pi.extensions` list in the root `package.json`.
