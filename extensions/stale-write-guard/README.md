# stale-write-guard

Pi extension that prevents stale whole-file overwrites.

## Goal

Block `write` when the agent has not seen the file's current version in
full. `edit` is not gated: the edit tool re-reads the file and requires
every `oldText` to match a unique region, so its exact-match check is the
freshness check for the edited region.

This reduces accidental overwrite when files are modified externally.

## Behavior

| Situation | `edit` | `write` |
|---|---|---|
| Existing file, no full read | allow | block |
| Existing file, full read is stale | allow | block |
| Existing file, full read is fresh | allow | allow |
| New file | allow | allow |

An `edit` changes the mtime, so it invalidates any earlier full read. A
later `write` then needs a fresh full read.

### What counts as a full read

- `read` with no `offset`, no `limit`, and no truncation. The read tool
  caps at 2,000 lines or 50 KB; a truncated result is not full.
- `cat` with no pipe, no redirect, no command substitution, no flag,
  and no truncated bash output. The path resolves literally: a leading
  `@` is part of the filename, and `~` is not expanded. Operands starting
  with `~` are skipped, so `cat ~/file` does not count. A
  `cd`/`pushd`/`popd` before it makes later relative paths ambiguous:
  paths after that segment do not count. Use `read` or an absolute path.
- A `/skill:name` block or a session context file whose disk content
  still matches the injected content.
- A successful `write`. The agent authored the whole file.

`sed -n`, `awk`, `head`, `tail`, `grep`, `rg`, `rg -A/-B`, `jj diff`,
`git diff`, and reader-side pipes do not count. They show part of the
file, a transformed view, or a diff. Use `edit` for targeted changes;
`write` needs the whole file.

### Content injected without a read tool call

Two pi paths put file content into context without a `tool_result`:

- `/skill:name` expansion injects the skill file's body into the prompt as
  a `<skill name="..." location="...">` block.
- Session-start context files (`AGENTS.md`, `AGENTS.override.md`,
  `CLAUDE.md`) land in the system prompt.

On `before_agent_start`, the guard records these files as full reads — but
only when the disk file still holds the injected content. A stale context
file records nothing, so a `write` stays blocked. An external edit is never
whitelisted by an old prompt.

Prompt templates (`/template:name`) also expand without a `tool_result`,
but their expansion carries no file path, so the guard records nothing for
them.

### Content seen through bash

On a successful `bash` tool result, the guard parses the command
(`src/bash.ts`) and records a full read for each file printed by a bare
`cat`. The parser is conservative:

- Only a bare `cat` (no flags) qualifies. A flag (`-n`, `-A`, `-s`,
  `--number`) changes the view or adds options, so it does not count.
- Bash operands are resolved literally: a leading `@` stays, and `~` is
  not expanded. Operands starting with `~` are skipped, so `cat ~/file`
  records nothing; use `read` or an absolute path.
- Commands with pipes, redirects, command substitution, variables, or
  backgrounding record nothing: the parser cannot tell what the agent
  actually saw.
- Truncated bash output records nothing.
- A failed command records nothing (the result is an error).

A missing record costs a full read before the next `write`. A wrong record
would whitelist a stale whole-file write, so every ambiguity fails closed.

### Bash writes are outside the guard

The guard sees `write` tool calls. It does not see `python3`, `perl -i`,
`sed -i`, `cat >`, or other bash commands that modify files. Those writes
can bypass the guard. Blocking them would break legitimate bulk edits and
miss the next writer, so the guard does not try. Use a permission layer if
you need to gate shell writes.

## State

The filesystem records when a file changed (mtime), but not whether the
agent has seen the whole current version. So the extension keeps one number
per file: the mtime of the last full read. A full `read`, a full `cat`, an
injected file whose disk content matches, or a successful `write` updates
it. State is in memory and resets on session start.

## Dump command

```text
/stale-write-guard-dump
```

Writes a report into the editor text: every fully read file with its
current mtime, full-read mtime, and the allow/block decision for `write`.

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
- `src/guard.ts` (full-read decision logic)
- `src/path.ts` (path canonicalization)
- `src/bash.ts` (bash `cat` commands that print a whole file)
- `src/injected.ts` (content injected without a read tool call)

## Load order

The guard must load after sillajje (see AGENTS.md). Keep it last in the
`pi.extensions` list in the root `package.json`.
