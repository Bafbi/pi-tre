# AGENTS.md (local: stale-write-guard)

## Extension purpose
Prevent stale whole-file overwrites in Pi coding sessions.

If a file was modified externally after the agent last saw it in full, the
extension must block `write` until the agent reads the whole current file.
`edit` is deliberately not gated: the edit tool re-reads the file and
requires every `oldText` to match a unique region.

## Design principles
- **Safety first**: protect external user edits from whole-file overwrite.
- **Deterministic behavior**: compare canonical paths + mtimes consistently.
- **Low friction**: only block when risk is real; let `edit` handle targeted changes.
- **Clear feedback**: the blocking reason must name the `read` tool and the `edit` alternative.

## Structure expectations
- `src/index.ts`: extension wiring + event handlers + dump command.
- Small internal modules:
  - `src/path.ts`: path canonicalization
  - `src/guard.ts`: full-read decision logic
  - `src/bash.ts`: bash `cat` commands that print a whole file
  - `src/injected.ts`: content injected without a read tool call
- State is a `Map<string, number>` (canonical path -> mtime of the last
  full read) owned by `src/index.ts`. Do not add fields to it. The write
  decision needs exactly one number per file.

## Load order constraint
The guard must load after any extension that rewrites tool input paths
(sillajje). Pi runs `tool_call` handlers in load order and hands the same
args object to `tool_result`, so the guard only sees final paths when it
runs last. If it runs before sillajje, full reads record workspace mtimes
while writes check repo-checkout mtimes, and every write blocks forever.
Keep `stale-write-guard` last in the `pi.extensions` list in the root
`package.json`. `test/unit/manifest-order.test.ts` pins this.

## Implementation constraints
- Handle symlinks via canonical paths where possible.
- Handle missing files gracefully (new file writes should not fail this guard).
- Use conservative mtime comparisons with tiny timestamp tolerance.
- Record only full-content reads: no `offset`/`limit`, no truncation, no
  `cat` flags, and no partial bash readers or pipelines.
- Resolve bash operands literally. Do not reuse the tool path normalizer:
  the shell does not strip `@` or expand `~`.
- Keep behavior compatible with `/reload` development workflow.
